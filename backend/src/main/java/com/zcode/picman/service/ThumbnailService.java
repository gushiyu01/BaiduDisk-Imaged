package com.zcode.picman.service;

import com.zcode.picman.baidu.BaiduPanClient;
import com.zcode.picman.baidu.BaiduPanException;
import com.zcode.picman.baidu.BaiduDtos.FileMeta;
import com.zcode.picman.config.AppProperties;
import com.zcode.picman.domain.AssetRow;
import com.zcode.picman.repository.AssetRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageReadParam;
import javax.imageio.ImageReader;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageInputStream;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Iterator;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 缩略图获取与缓存。
 * <p>
 * 优先级：百度官方缩略图（filemetas thumb=1）→ 后端下载原图后本地生成。
 * 两条路都走不通时抛出带真实原因的异常，不返回占位图冒充成功。
 * <p>
 * 生成时会按尺寸做子采样解码，避免用 ImageIO 整张读入大图导致 OOM。
 */
@Service
public class ThumbnailService {

    private static final Logger log = LoggerFactory.getLogger(ThumbnailService.class);

    /** 官方缩略图最大接受 8MB，超出说明返回的不是缩略图 */
    private static final int MAX_THUMB_BYTES = 8 * 1024 * 1024;
    /** 用于本地生成缩略图的原图上限，超过就放弃而不是把内存撑爆 */
    private static final long MAX_LOCAL_SOURCE_BYTES = 64L * 1024 * 1024;
    private static final float JPEG_QUALITY = 0.85f;

    private final AppProperties props;
    private final AssetRepository images;
    private final BaiduPanClient baidu;

    private final Path thumbDir;
    /** 同一张图的并发请求只让一个去生成，其余等结果 */
    private final ConcurrentHashMap<Long, Object> locks = new ConcurrentHashMap<>();

    public ThumbnailService(AppProperties props, AssetRepository images, BaiduPanClient baidu) {
        this.props = props;
        this.images = images;
        this.baidu = baidu;
        this.thumbDir = Path.of(props.cacheDir()).toAbsolutePath().resolve("thumbs");
    }

    public record ThumbResult(byte[] data, String source, String contentType) {
    }

    public ThumbResult getThumbnail(AssetRow image) {
        Path cached = cacheFile(image);
        if (Files.exists(cached)) {
            byte[] data = readQuietly(cached);
            if (data != null) {
                return new ThumbResult(data, image.thumbSource(), detectContentType(data));
            }
        }

        Object lock = locks.computeIfAbsent(image.id(), k -> new Object());
        try {
            synchronized (lock) {
                // 二次检查：等锁期间可能已被别的线程生成好
                if (Files.exists(cached)) {
                    byte[] data = readQuietly(cached);
                    if (data != null) {
                        return new ThumbResult(data, image.thumbSource(), detectContentType(data));
                    }
                }
                return generate(image, cached);
            }
        } finally {
            locks.remove(image.id(), lock);
        }
    }

    private ThumbResult generate(AssetRow image, Path cached) {
        FileMeta meta = resolveMeta(image);

        // 1) 官方缩略图
        String thumbUrl = meta == null ? null : meta.bestThumbUrl();
        if (thumbUrl != null) {
            try {
                byte[] data = baidu.fetchThumb(thumbUrl, MAX_THUMB_BYTES);
                if (data.length > 0) {
                    write(cached, data);
                    images.updateThumbSource(image.id(), "BAIDU");
                    // 百度不保证返回宽高，缩略图又是缩放过的，所以单独探测一次原图头部
                    if (image.width() == null && meta.dlink() != null) {
                        int[] dims = probeRemoteDimensions(meta.dlink());
                        if (dims != null) {
                            images.updateDimensions(image.id(), dims[0], dims[1]);
                        }
                    }
                    log.debug("图片 {} 使用百度官方缩略图（{} 字节）", image.id(), data.length);
                    return new ThumbResult(data, "BAIDU", detectContentType(data));
                }
                log.warn("图片 {} 的官方缩略图为空，回退到本地生成", image.id());
            } catch (BaiduPanException e) {
                log.warn("图片 {} 官方缩略图获取失败，回退到本地生成：{}", image.id(), e.getMessage());
            }
        }

        // 2) 下载原图本地生成
        if (meta == null || meta.dlink() == null || meta.dlink().isBlank()) {
            images.updateThumbSource(image.id(), "NONE");
            throw new BaiduPanException(
                    "无法获取缩略图：百度未返回缩略图，也拿不到下载地址（文件可能已被移动或删除）", null);
        }
        Long size = meta.size() == null ? image.size() : meta.size();
        if (size != null && size > MAX_LOCAL_SOURCE_BYTES) {
            images.updateThumbSource(image.id(), "NONE");
            throw new BaiduPanException(
                    "无法生成缩略图：原图 %.1fMB 超过本地生成上限 %dMB，且百度未提供官方缩略图"
                            .formatted(size / 1048576.0, MAX_LOCAL_SOURCE_BYTES / 1024 / 1024), null);
        }

        byte[] original = downloadOriginal(meta.dlink());
        Rendered rendered;
        try {
            rendered = renderThumbnail(original, props.thumbSize());
        } catch (BaiduPanException e) {
            images.updateThumbSource(image.id(), "NONE");
            throw e;
        }
        write(cached, rendered.data());
        images.updateThumbSource(image.id(), "LOCAL");
        // 本地生成时本来就要解码原图，顺手把真实尺寸记下来
        if (image.width() == null) {
            images.updateDimensions(image.id(), rendered.sourceWidth(), rendered.sourceHeight());
        }
        log.debug("图片 {} 本地生成缩略图（原图 {} 字节 → 缩略图 {} 字节，尺寸 {}x{}）",
                image.id(), original.length, rendered.data().length,
                rendered.sourceWidth(), rendered.sourceHeight());
        return new ThumbResult(rendered.data(), "LOCAL", "image/jpeg");
    }

    /**
     * 只取原图前 64KB 解出宽高，不下载整张图。
     * <p>
     * 用 Range 请求是因为大图动辄几十 MB，为了显示一个尺寸把整张图拉下来不值得。
     * JPEG/PNG/GIF/WebP 的头部都在这个范围内。
     */
    private int[] probeRemoteDimensions(String dlink) {
        final int probeBytes = 64 * 1024;
        try (var stream = baidu.openDlink(dlink, "bytes=0-" + (probeBytes - 1))) {
            byte[] head = stream.body().readNBytes(probeBytes);
            if (head.length == 0) {
                return null;
            }
            try (ImageInputStream iis = ImageIO.createImageInputStream(new ByteArrayInputStream(head))) {
                if (iis == null) {
                    return null;
                }
                Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
                if (!readers.hasNext()) {
                    return null;
                }
                ImageReader reader = readers.next();
                try {
                    reader.setInput(iis, true, true);
                    return new int[]{reader.getWidth(0), reader.getHeight(0)};
                } finally {
                    reader.dispose();
                }
            }
        } catch (Exception e) {
            log.debug("探测原图尺寸失败：{}", e.getMessage());
            return null;
        }
    }

    private record Rendered(byte[] data, int sourceWidth, int sourceHeight) {
    }

    /** fs_id 可能因为重命名而失效，所以失败时按路径再查一次 */
    private FileMeta resolveMeta(AssetRow image) {
        if (image.fsId() != null && !image.fsId().isBlank()) {
            try {
                FileMeta meta = baidu.fileMeta(Long.parseLong(image.fsId()));
                if (meta != null && meta.fsId() != null) {
                    return meta;
                }
            } catch (NumberFormatException ignored) {
                // 落到按路径查
            } catch (BaiduPanException e) {
                log.debug("按 fs_id 查元数据失败，改用路径：{}", e.getMessage());
            }
        }
        return baidu.metaByPath(image.path(), true, true);
    }

    private byte[] downloadOriginal(String dlink) {
        try (var stream = baidu.openDlink(dlink, null)) {
            return stream.body().readNBytes((int) MAX_LOCAL_SOURCE_BYTES);
        } catch (IOException e) {
            throw new BaiduPanException("下载原图失败：" + e.getMessage(), e);
        }
    }

    /**
     * 生成缩略图。
     * <p>
     * 关键点是先只读图片头拿到原始宽高，据此设置子采样率，
     * 让 ImageIO 只解码到目标尺寸附近，而不是把整张原图展开到内存里。
     */
    private Rendered renderThumbnail(byte[] original, int maxEdge) {
        try (ImageInputStream iis = ImageIO.createImageInputStream(new ByteArrayInputStream(original))) {
            if (iis == null) {
                throw new BaiduPanException("无法读取该图片内容", null);
            }
            Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
            if (!readers.hasNext()) {
                throw new BaiduPanException(
                        "JVM 内置解码器不支持该图片格式，无法生成缩略图（HEIC/AVIF 等格式需百度侧提供缩略图）", null);
            }
            ImageReader reader = readers.next();
            try {
                reader.setInput(iis, true, true);
                int width = reader.getWidth(0);
                int height = reader.getHeight(0);

                int smallerEdge = Math.min(width, height);
                // 目标解码尺寸取目标边长的 2 倍，兼顾质量与内存
                int subsample = Math.max(1, smallerEdge / (maxEdge * 2));

                ImageReadParam param = reader.getDefaultReadParam();
                if (subsample > 1) {
                    param.setSourceSubsampling(subsample, subsample, 0, 0);
                }
                BufferedImage source = reader.read(0, param);
                if (source == null) {
                    throw new BaiduPanException("解码图片失败", null);
                }
                // 返回的是原图真实尺寸，不是缩略图尺寸
                return new Rendered(encodeJpeg(scaleToFit(source, maxEdge)), width, height);
            } finally {
                reader.dispose();
            }
        } catch (IOException e) {
            throw new BaiduPanException("生成缩略图失败：" + e.getMessage(), e);
        }
    }

    private BufferedImage scaleToFit(BufferedImage src, int maxEdge) {
        int w = src.getWidth();
        int h = src.getHeight();
        double factor = Math.min(1.0, (double) maxEdge / Math.max(w, h));
        int tw = Math.max(1, (int) Math.round(w * factor));
        int th = Math.max(1, (int) Math.round(h * factor));

        // 统一铺白底：JPEG 不支持透明通道，带 alpha 的 PNG 直接转会在透明区出现黑块
        BufferedImage dst = new BufferedImage(tw, th, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = dst.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setColor(Color.WHITE);
            g.fillRect(0, 0, tw, th);
            g.drawImage(src, 0, 0, tw, th, null);
        } finally {
            g.dispose();
        }
        return dst;
    }

    private byte[] encodeJpeg(BufferedImage image) {
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpeg");
        if (!writers.hasNext()) {
            throw new BaiduPanException("JVM 不支持 JPEG 编码，无法生成缩略图", null);
        }
        ImageWriter writer = writers.next();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(out)) {
            writer.setOutput(ios);
            ImageWriteParam param = writer.getDefaultWriteParam();
            if (param.canWriteCompressed()) {
                param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
                param.setCompressionQuality(JPEG_QUALITY);
            }
            writer.write(null, new IIOImage(image, null, null), param);
            ios.flush();
        } catch (IOException e) {
            throw new BaiduPanException("编码缩略图失败：" + e.getMessage(), e);
        } finally {
            writer.dispose();
        }
        return out.toByteArray();
    }

    // ------------------------------------------------------------------ 缓存文件

    private Path cacheFile(AssetRow image) {
        // 版本号取 md5 或修改时间，网盘上的文件变了缓存自然失效
        String version = image.md5() != null && !image.md5().isBlank()
                ? image.md5()
                : String.valueOf(image.serverMtime());
        String safeVersion = version.replaceAll("[^A-Za-z0-9]", "");
        return thumbDir.resolve("%d-%s.jpg".formatted(image.id(), safeVersion));
    }

    private void write(Path target, byte[] data) {
        try {
            Files.createDirectories(target.getParent());
            Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
            Files.write(tmp, data);
            // 原子替换，避免并发读到写了一半的文件
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            log.warn("写入缩略图缓存失败 {}：{}", target, e.getMessage());
        }
    }

    private static byte[] readQuietly(Path p) {
        try {
            return Files.readAllBytes(p);
        } catch (IOException e) {
            return null;
        }
    }

    /** 按魔数判断类型，不信文件名也不信上游 Content-Type */
    static String detectContentType(byte[] data) {
        if (data == null || data.length < 4) {
            return "application/octet-stream";
        }
        if ((data[0] & 0xFF) == 0xFF && (data[1] & 0xFF) == 0xD8) {
            return "image/jpeg";
        }
        if ((data[0] & 0xFF) == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G') {
            return "image/png";
        }
        if (data[0] == 'G' && data[1] == 'I' && data[2] == 'F') {
            return "image/gif";
        }
        if (data.length >= 12 && data[0] == 'R' && data[1] == 'I' && data[2] == 'F' && data[3] == 'F'
                && data[8] == 'W' && data[9] == 'E' && data[10] == 'B' && data[11] == 'P') {
            return "image/webp";
        }
        if (data[0] == 'B' && data[1] == 'M') {
            return "image/bmp";
        }
        return "application/octet-stream";
    }

    /** 清空本地缩略图缓存，返回删除的文件数 */
    public int clearCache() {
        if (!Files.isDirectory(thumbDir)) {
            return 0;
        }
        int removed = 0;
        try (var files = Files.list(thumbDir)) {
            for (Path p : files.toList()) {
                try {
                    Files.deleteIfExists(p);
                    removed++;
                } catch (IOException e) {
                    log.warn("删除缓存文件失败 {}：{}", p, e.getMessage());
                }
            }
        } catch (IOException e) {
            log.warn("遍历缓存目录失败：{}", e.getMessage());
        }
        return removed;
    }

    public long cacheSizeBytes() {
        if (!Files.isDirectory(thumbDir)) {
            return 0L;
        }
        try (var files = Files.list(thumbDir)) {
            return files.mapToLong(p -> {
                try {
                    return Files.size(p);
                } catch (IOException e) {
                    return 0L;
                }
            }).sum();
        } catch (IOException e) {
            return 0L;
        }
    }
}
