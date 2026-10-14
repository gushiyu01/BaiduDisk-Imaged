package com.zcode.picman.service;

import com.zcode.picman.baidu.BaiduDtos.FileMeta;
import com.zcode.picman.baidu.BaiduDtos.FsEntry;
import com.zcode.picman.baidu.BaiduDtos.Quota;
import com.zcode.picman.baidu.BaiduDtos.Uinfo;
import com.zcode.picman.baidu.BaiduPanClient;
import com.zcode.picman.baidu.BaiduPanException;
import com.zcode.picman.baidu.BaiduTokenStore;
import com.zcode.picman.config.AppProperties;
import com.zcode.picman.domain.AssetRow;
import com.zcode.picman.domain.AssetQuery;
import com.zcode.picman.repository.AssetRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * 百度网盘开放平台接口体检。
 * <p>
 * 原则：只报告真实观测到的结果。每一项都实际发一次请求，
 * detail 里写的是真实的返回值、字节数、md5 或错误原文，绝不返回预设的成功文案。
 * 没条件跑的项目如实标 SKIP。
 */
@Service
public class BaiduDiagnoseService {

    private static final Logger log = LoggerFactory.getLogger(BaiduDiagnoseService.class);

    private final BaiduPanClient baidu;
    private final BaiduTokenStore tokens;
    private final AssetRepository assets;
    private final AppProperties props;

    public BaiduDiagnoseService(BaiduPanClient baidu, BaiduTokenStore tokens,
                                AssetRepository assets, AppProperties props) {
        this.baidu = baidu;
        this.tokens = tokens;
        this.assets = assets;
        this.props = props;
    }

    public record Check(String key, String name, String status, String detail, long elapsedMs) {

        static Check pass(String key, String name, String detail, long ms) {
            return new Check(key, name, "PASS", detail, ms);
        }

        static Check fail(String key, String name, String detail, long ms) {
            return new Check(key, name, "FAIL", detail, ms);
        }

        static Check skip(String key, String name, String detail) {
            return new Check(key, name, "SKIP", detail, 0);
        }
    }

    public record Report(List<Check> checks, String summary) {
    }

    /**
     * @param deep true 时会真实走一遍「上传 → 缩略图 → 下载 → 重命名 → 删除」的写盘流程，
     *             会产生并清理临时文件；false 时只做只读检查。
     */
    public Report diagnose(boolean deep) {
        List<Check> checks = new ArrayList<>();

        checks.add(check("token", "访问令牌", this::describeToken));
        checks.add(check("account", "账号信息", () -> {
            Uinfo u = baidu.uinfo();
            return "已授权账号 %s（%s），uk=%s，VIP 等级 %s"
                    .formatted(u.baiduName(), u.netdiskName(), u.uk(), u.vipType());
        }));
        checks.add(check("list", "列目录", this::describeList));

        if (!deep) {
            checks.add(Check.skip("upload", "上传", "未开启深度体检（深度体检会真实写入并清理临时文件）"));
            checks.add(Check.skip("rename", "重命名", "未开启深度体检"));
            checks.add(Check.skip("delete", "删除", "未开启深度体检"));
        }

        // 缩略图和下载优先用索引里已有的图片，避免为了体检白造数据
        AssetRow sample = pickSampleImage();
        if (sample == null && !deep) {
            checks.add(Check.skip("thumb", "官方缩略图", "索引里还没有图片，先同步一次索引，或开启深度体检"));
            checks.add(Check.skip("download", "原图下载", "索引里还没有图片，先同步一次索引，或开启深度体检"));
        }

        if (deep) {
            runWriteCycle(checks);
        } else {
            if (sample != null) {
                checks.add(check("thumb", "官方缩略图", () -> describeThumb(sample)));
                checks.add(check("download", "原图下载", () -> describeDownload(sample)));
            }
            checks.add(Check.skip("write-cycle", "写入流程", "未开启深度体检"));
        }

        long pass = checks.stream().filter(c -> c.status().equals("PASS")).count();
        long fail = checks.stream().filter(c -> c.status().equals("FAIL")).count();
        long skip = checks.stream().filter(c -> c.status().equals("SKIP")).count();
        String summary = "%d 项通过，%d 项失败，%d 项跳过".formatted(pass, fail, skip);
        return new Report(checks, summary);
    }

    // ------------------------------------------------------------------ 只读检查

    private String describeToken() {
        var status = tokens.status();
        if (!status.authorized()) {
            throw new IllegalStateException("尚未授权，请先完成百度网盘 OAuth 授权");
        }
        // 真正用一次令牌，确保不是「数据库里有记录但已经失效」
        tokens.accessToken();
        return "有效，scope=%s，有效期至 %s".formatted(status.scope(), status.expiresAt());
    }

    private String describeList() {
        String dir = props.baseDir();
        List<FsEntry> entries;
        try {
            entries = baidu.listAll(dir);
        } catch (BaiduPanException e) {
            // 目录还不存在是很常见的情况，换根目录再试一次，如实说明
            log.info("列 {} 失败（{}），改列 / 验证连通性", dir, e.getMessage());
            List<FsEntry> root = baidu.listAll("/");
            long dirs = root.stream().filter(FsEntry::isDir).count();
            return "基础目录 %s 暂不可列（%s）；改列 / 成功，共 %d 项，其中子目录 %d 个"
                    .formatted(dir, e.getMessage(), root.size(), dirs);
        }
        long dirs = entries.stream().filter(FsEntry::isDir).count();
        long imgs = entries.stream().filter(e -> !e.isDir()
                && com.zcode.picman.support.MimeTypes.isImageCategory(e.category())).count();
        return "%s 共 %d 项（子目录 %d 个，图片 %d 张）".formatted(dir, entries.size(), dirs, imgs);
    }

    private String describeThumb(AssetRow row) {
        FileMeta meta = resolveMeta(row);
        if (meta == null) {
            throw new IllegalStateException("查不到该图片的元数据（可能已被移动或删除）");
        }
        String url = meta.bestThumbUrl();
        if (url == null) {
            throw new IllegalStateException("百度未返回缩略图（thumbs 为空），需回退到本地生成");
        }
        byte[] data = baidu.fetchThumb(url, 8 * 1024 * 1024);
        return "取到 %d 字节，Content-Type=%s，可用尺寸 %s"
                .formatted(data.length, ThumbnailService.detectContentType(data), meta.thumbs().keySet());
    }

    private String describeDownload(AssetRow row) {
        FileMeta meta = resolveMeta(row);
        if (meta == null || meta.dlink() == null) {
            throw new IllegalStateException("百度未返回下载地址（dlink）");
        }
        try (var stream = baidu.openDlink(meta.dlink(), null)) {
            byte[] data = stream.body().readNBytes(4 * 1024 * 1024);
            return "HTTP %d，读取 %d 字节，Content-Type=%s，本地 MD5=%s"
                    .formatted(stream.status(), data.length, stream.headers().contentType(), localMd5(data));
        } catch (java.io.IOException e) {
            throw new IllegalStateException("读取下载流失败：" + e.getMessage(), e);
        }
    }

    /**
     * 只报告下载内容的真实 MD5，不和百度返回的 md5 字段比对。
     * <p>
     * 实测百度的 md5 字段是它自己的「云端哈希」，值里会出现非十六进制字符（例如
     * 4c84112b5m879873f86ddb5b4aed5edc 里的 m），本来就不可能等于真实 MD5，
     * 拿它做一致性判断只会得出误导性的「不一致」。
     */
    private static String localMd5(byte[] data) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(data));
        } catch (Exception e) {
            return "(计算失败)";
        }
    }

    // ------------------------------------------------------------------ 深度体检

    private void runWriteCycle(List<Check> checks) {
        String baseDir = props.baseDir();
        String name = "picman-diagnose-%d.png".formatted(System.currentTimeMillis());
        String remotePath = baseDir + "/" + name;
        Path temp = null;
        boolean uploaded = false;

        try {
            baidu.mkdir(baseDir);

            // 上传
            long t0 = System.currentTimeMillis();
            byte[] localBytes = generateTestImage();
            try {
                temp = Files.createTempFile("picman-diagnose-", ".png");
                Files.write(temp, localBytes);
                // 体检没有客户端可提供 MD5，传 null 让服务端自己算
                // （这条路径同时也验证了服务端的分片 MD5 算法）
                var created = baidu.upload(remotePath, temp, true, null);
                uploaded = true;
                checks.add(Check.pass("upload", "上传",
                        "上传 %d 字节成功，fs_id=%s，category=%s"
                                .formatted(localBytes.length, created.fsId(), created.category()),
                        System.currentTimeMillis() - t0));
            } catch (Exception e) {
                checks.add(Check.fail("upload", "上传", realMessage(e), System.currentTimeMillis() - t0));
            }

            if (uploaded) {
                FileMeta fetched = null;
                try {
                    fetched = baidu.metaByPath(remotePath, true, true);
                } catch (Exception e) {
                    log.warn("深度体检查询元数据失败：{}", e.getMessage());
                }
                final FileMeta meta = fetched;
                checks.add(meta == null
                        ? Check.fail("thumb", "官方缩略图", "上传成功但查不到元数据", 0)
                        : check("thumb", "官方缩略图", () -> {
                    String url = meta.bestThumbUrl();
                    if (url == null) {
                        throw new IllegalStateException("百度未返回 thumbs，需回退到本地生成");
                    }
                    byte[] data = baidu.fetchThumb(url, 8 * 1024 * 1024);
                    return "取到 %d 字节，Content-Type=%s，尺寸档位 %s"
                            .formatted(data.length, ThumbnailService.detectContentType(data), meta.thumbs().keySet());
                }));

                checks.add(meta == null || meta.dlink() == null
                        ? Check.fail("download", "原图下载", "百度未返回 dlink", 0)
                        : check("download", "原图下载", () -> {
                    try (var stream = baidu.openDlink(meta.dlink(), null)) {
                        byte[] data = stream.body().readNBytes(8 * 1024 * 1024);
                        // 和我刚刚上传的字节逐一比对，这才是真正验证了往返一致
                        boolean identical = java.util.Arrays.equals(data, localBytes);
                        return "HTTP %d，下载 %d 字节（上传 %d 字节），Content-Type=%s，与原文件%s"
                                .formatted(stream.status(), data.length, localBytes.length,
                                        stream.headers().contentType(),
                                        identical ? "逐字节一致" : "不一致（本地 MD5=" + localMd5(data) + "）");
                    } catch (java.io.IOException e) {
                        throw new IllegalStateException("读取下载流失败：" + e.getMessage(), e);
                    }
                }));

                // 重命名（同时验证「重命名后 fs_id 会变」这个实测结论）
                String renamedTo = name.replace(".png", "-renamed.png");
                String renamedPath = baseDir + "/" + renamedTo;
                checks.add(check("rename", "重命名", () -> {
                    Long before = meta == null ? null : meta.fsId();
                    baidu.rename(remotePath, renamedTo);
                    FileMeta after = baidu.metaByPath(renamedPath, false, false);
                    String fsIdNote = (before != null && after != null && after.fsId() != null)
                            ? (before.equals(after.fsId()) ? "fs_id 未变" : "fs_id 已变更（%d → %d）".formatted(before, after.fsId()))
                            : "未能对比 fs_id";
                    return "已改名为 %s，%s".formatted(renamedTo, fsIdNote);
                }));

                // 删除临时文件
                checks.add(check("delete", "删除", () -> {
                    baidu.delete(List.of(renamedPath));
                    List<FsEntry> remain = baidu.listAll(baseDir);
                    boolean stillThere = remain.stream().anyMatch(e -> e.path().equals(renamedPath));
                    if (stillThere) {
                        throw new IllegalStateException("删除接口返回成功，但目录里仍能看到该文件");
                    }
                    return "临时文件已删除并确认从目录消失";
                }));
            } else {
                checks.add(Check.skip("thumb", "官方缩略图", "上传未成功，跳过"));
                checks.add(Check.skip("download", "原图下载", "上传未成功，跳过"));
                checks.add(Check.skip("rename", "重命名", "上传未成功，跳过"));
                checks.add(Check.skip("delete", "删除", "上传未成功，跳过"));
            }
        } catch (Exception e) {
            checks.add(Check.fail("write-cycle", "写入流程", realMessage(e), 0));
        } finally {
            if (temp != null) {
                try {
                    Files.deleteIfExists(temp);
                } catch (Exception ignored) {
                    log.debug("诊断临时文件清理失败：{}", temp);
                }
            }
        }
    }

    /** 生成一张 640x400 的测试图，内容有辨识度，方便人工确认缩略图没串图 */
    private static byte[] generateTestImage() throws java.io.IOException {
        BufferedImage img = new BufferedImage(640, 400, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = img.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setColor(new Color(24, 32, 64));
            g.fillRect(0, 0, 640, 400);
            g.setColor(new Color(233, 69, 96));
            g.fillRect(40, 40, 180, 140);
            g.setColor(new Color(0, 168, 150));
            g.fillRect(240, 40, 180, 140);
            g.setColor(new Color(247, 183, 51));
            g.fillRect(440, 40, 160, 140);
            g.setColor(Color.WHITE);
            g.fillOval(220, 210, 200, 150);
            g.setColor(new Color(24, 32, 64));
            g.drawString("PicMan diagnose " + Instant.now(), 40, 390);
        } finally {
            g.dispose();
        }
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(img, "png", out);
        return out.toByteArray();
    }

    // ------------------------------------------------------------------ 工具

    private AssetRow pickSampleImage() {
        List<AssetRow> rows = assets.search(new AssetQuery(null, List.of(), false, null, "time_desc", 1, 1));
        if (rows.isEmpty()) {
            return null;
        }
        AssetRow row = rows.get(0);
        return row.missing() ? null : row;
    }

    private FileMeta resolveMeta(AssetRow row) {
        try {
            if (row.fsId() != null && !row.fsId().isBlank()) {
                FileMeta meta = baidu.fileMeta(Long.parseLong(row.fsId()));
                if (meta != null && meta.fsId() != null) {
                    return meta;
                }
            }
        } catch (Exception e) {
            log.debug("按 fs_id 查元数据失败，改用路径：{}", e.getMessage());
        }
        return baidu.metaByPath(row.path(), true, true);
    }

    private Check check(String key, String name, Supplier<String> action) {
        long t0 = System.currentTimeMillis();
        try {
            String detail = action.get();
            return Check.pass(key, name, detail, System.currentTimeMillis() - t0);
        } catch (Exception e) {
            return Check.fail(key, name, realMessage(e), System.currentTimeMillis() - t0);
        }
    }

    /** 把异常转成用户能看懂的真实描述，不做任何美化 */
    private static String realMessage(Exception e) {
        if (e instanceof BaiduPanException bpe) {
            return bpe.getMessage();
        }
        String m = e.getMessage();
        return (m == null || m.isBlank()) ? e.getClass().getSimpleName() : m;
    }

    /** 便于前端展示 quota，独立出来以免混进 checks */
    public Map<String, Object> quotaInfo() {
        Quota q = baidu.quota();
        return Map.of("total", q.total() == null ? 0 : q.total(),
                "used", q.used() == null ? 0 : q.used(),
                "free", q.free() == null ? 0 : q.free());
    }
}
