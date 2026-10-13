package com.zcode.picman.web;

import com.zcode.picman.domain.AssetQuery;
import com.zcode.picman.repository.AssetRepository;
import com.zcode.picman.service.AssetService;
import com.zcode.picman.service.SyncService;
import com.zcode.picman.service.ThumbnailService;
import com.zcode.picman.support.FileKinds;
import com.zcode.picman.web.dto.Dtos.AssetDto;
import com.zcode.picman.web.dto.Dtos.KindStatsResponse;
import com.zcode.picman.web.dto.Dtos.PageResponse;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.OutputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 文件库与图库的统一入口。
 * <p>
 * 图片只是 {@code kind='IMAGE'} 的一种文件，所以两套路径共用同一批处理器：
 * <ul>
 *   <li>{@code /api/files/**} —— 文件库，不限类型</li>
 *   <li>{@code /api/images/**} —— 图库，等价于把 kind 固定成 IMAGE，行为与之前完全一致</li>
 * </ul>
 * 这样图库前端不用改，文件库也不用复制一套逻辑。
 */
@RestController
@RequestMapping("/api")
public class AssetController {

    private static final Logger log = LoggerFactory.getLogger(AssetController.class);

    private static final int MAX_PAGE_SIZE = 100;

    private final AssetService assets;
    private final AssetRepository assetRepository;
    private final ThumbnailService thumbnails;
    private final SyncService sync;

    public AssetController(AssetService assets, AssetRepository assetRepository,
                           ThumbnailService thumbnails, SyncService sync) {
        this.assets = assets;
        this.assetRepository = assetRepository;
        this.thumbnails = thumbnails;
        this.sync = sync;
    }

    public record RenameRequest(@NotBlank(message = "文件名不能为空") String name) {
    }

    public record FavoriteRequest(boolean favorite) {
    }

    public record TagRequest(List<Long> tagIds) {
    }

    public record UploadResponse(List<AssetDto> uploaded, List<Map<String, String>> failed) {
    }

    public record SyncRequest(String dir) {
    }

    // ------------------------------------------------------------------ 列表

    /** 文件库：可传 kind 过滤，不传就是全部类型 */
    @GetMapping("/files")
    public PageResponse listFiles(
            @RequestParam(name = "q", required = false) String q,
            @RequestParam(name = "tag", required = false) List<Long> tag,
            @RequestParam(name = "favorite", required = false) Boolean favorite,
            @RequestParam(name = "kind", required = false) String kind,
            @RequestParam(name = "sort", defaultValue = "time_desc") String sort,
            @RequestParam(name = "page", defaultValue = "1") int page,
            @RequestParam(name = "size", defaultValue = "24") int size) {
        return assets.list(query(q, tag, favorite, kind, sort, page, size));
    }

    /** 图库：kind 固定为 IMAGE */
    @GetMapping("/images")
    public PageResponse listImages(
            @RequestParam(name = "q", required = false) String q,
            @RequestParam(name = "tag", required = false) List<Long> tag,
            @RequestParam(name = "favorite", required = false) Boolean favorite,
            @RequestParam(name = "sort", defaultValue = "time_desc") String sort,
            @RequestParam(name = "page", defaultValue = "1") int page,
            @RequestParam(name = "size", defaultValue = "24") int size) {
        return assets.list(query(q, tag, favorite, FileKinds.IMAGE, sort, page, size));
    }

    private AssetQuery query(String q, List<Long> tag, Boolean favorite, String kind,
                             String sort, int page, int size) {
        int safePage = Math.max(1, page);
        int safeSize = Math.min(Math.max(1, size), MAX_PAGE_SIZE);
        // kind 来自请求参数，必须校验：它会进 SQL，虽然走的是绑定参数，但不合法的值没有意义
        String safeKind = (kind == null || kind.isBlank()) ? null : kind.trim().toUpperCase();
        if (safeKind != null && !FileKinds.isValid(safeKind)) {
            throw new IllegalArgumentException(
                    "未知的文件类型：%s（可选 %s）".formatted(kind, String.join(" / ", FileKinds.ALL)));
        }
        return new AssetQuery(q, tag, favorite, safeKind, sort, safePage, safeSize);
    }

    /** 各类型文件数量，给筛选栏显示角标 */
    @GetMapping("/files/kind-stats")
    public KindStatsResponse kindStats() {
        return KindStatsResponse.from(assetRepository.countsByKind());
    }

    // ------------------------------------------------------------------ 单条

    @GetMapping({"/files/{id}", "/images/{id}"})
    public AssetDto get(@PathVariable long id) {
        return assets.get(id);
    }

    // ------------------------------------------------------------------ 字节流

    /** 缩略图。只有图片和视频值得取，其他类型由前端显示类型图标。 */
    @GetMapping({"/files/{id}/thumb", "/images/{id}/thumb"})
    public void thumb(@PathVariable long id, HttpServletResponse response) throws IOException {
        var row = assets.requireRow(id);
        if (!FileKinds.hasThumbnail(row.kind())) {
            throw new com.zcode.picman.support.ApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE,
                    "NO_THUMBNAIL", "「%s」类型没有缩略图，请使用类型图标".formatted(row.kind()));
        }
        ThumbnailService.ThumbResult result = thumbnails.getThumbnail(row);

        response.setStatus(HttpStatus.OK.value());
        response.setContentType(result.contentType());
        response.setContentLengthLong(result.data().length);
        response.setHeader("X-Thumb-Source", result.source());
        response.setHeader("Cache-Control", "private, max-age=86400");
        try (OutputStream out = response.getOutputStream()) {
            out.write(result.data());
        }
    }

    /**
     * 原文件。后端代理百度 dlink，支持 Range 断点续传。
     *
     * @param download 传 1 时带上 Content-Disposition，让浏览器存盘而不是尝试内联打开
     */
    @GetMapping({"/files/{id}/raw", "/images/{id}/raw"})
    public void raw(@PathVariable long id,
                    @RequestHeader(name = "Range", required = false) String range,
                    @RequestParam(name = "download", defaultValue = "false") boolean download,
                    HttpServletResponse response) throws IOException {
        var row = assets.requireRow(id);
        try (var stream = assets.openRaw(id, range)) {
            response.setStatus(stream.status());
            response.setContentType(stream.contentType());
            if (stream.contentLength() >= 0) {
                response.setContentLengthLong(stream.contentLength());
            }
            if (stream.contentRange() != null && !stream.contentRange().isBlank()) {
                response.setHeader("Content-Range", stream.contentRange());
            }
            response.setHeader("Accept-Ranges", "bytes");
            response.setHeader("Cache-Control", "private, max-age=300");
            if (download) {
                response.setHeader("Content-Disposition", contentDisposition(row.name()));
            }
            try (OutputStream out = response.getOutputStream()) {
                stream.body().transferTo(out);
            } catch (IOException e) {
                // 用户拖动进度条或关页面会导致连接中断，这不是错误
                log.debug("文件传输中断（id={}）：{}", id, e.getMessage());
            }
        }
    }

    /**
     * 文件名可能含中文，必须按 RFC 5987 用 filename* 传 UTF-8，
     * 同时留一个 ASCII 兜底名给老浏览器。
     */
    private static String contentDisposition(String filename) {
        String ascii = filename.replaceAll("[^\\x20-\\x7E]", "_").replace("\"", "'");
        if (ascii.isBlank()) {
            ascii = "download";
        }
        String encoded = URLEncoder.encode(filename, StandardCharsets.UTF_8).replace("+", "%20");
        return "attachment; filename=\"%s\"; filename*=UTF-8''%s".formatted(ascii, encoded);
    }

    // ------------------------------------------------------------------ 写入

    /** 文件库上传：任意类型 */
    @PostMapping("/files/upload")
    public UploadResponse uploadFiles(@RequestParam("file") MultipartFile[] files) {
        return doUpload(files, false);
    }

    /** 图库上传：只收图片，非图片会被逐个拒绝并说明去哪传 */
    @PostMapping("/images/upload")
    public UploadResponse uploadImages(@RequestParam("file") MultipartFile[] files) {
        return doUpload(files, true);
    }

    private UploadResponse doUpload(MultipartFile[] files, boolean imageOnly) {
        List<AssetDto> uploaded = new ArrayList<>();
        List<Map<String, String>> failed = new ArrayList<>();

        for (MultipartFile file : files) {
            String name = file.getOriginalFilename();
            try {
                uploaded.add(assets.upload(file, imageOnly));
            } catch (Exception e) {
                // 一个文件失败不影响其他文件，失败原因原样返回给前端
                log.warn("上传失败 {}：{}", name, e.getMessage());
                failed.add(Map.of(
                        "name", name == null ? "(未命名)" : name,
                        "reason", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
            }
        }
        return new UploadResponse(uploaded, failed);
    }

    @PatchMapping({"/files/{id}", "/images/{id}"})
    public AssetDto rename(@PathVariable long id, @Valid @RequestBody RenameRequest request) {
        return assets.rename(id, request.name());
    }

    @PatchMapping({"/files/{id}/favorite", "/images/{id}/favorite"})
    public AssetDto favorite(@PathVariable long id, @RequestBody FavoriteRequest request) {
        return assets.setFavorite(id, request.favorite());
    }

    @PostMapping({"/files/{id}/tags", "/images/{id}/tags"})
    public AssetDto setTags(@PathVariable long id, @RequestBody TagRequest request) {
        return assets.setTags(id, request.tagIds());
    }

    /** mode: index（只删索引，默认）/ remote（只删网盘）/ both（都删） */
    @DeleteMapping({"/files/{id}", "/images/{id}"})
    public Map<String, Object> delete(@PathVariable long id,
                                      @RequestParam(name = "mode", defaultValue = "index") String mode) {
        return assets.delete(id, AssetService.DeleteMode.parse(mode));
    }

    @PostMapping({"/files/sync", "/images/sync"})
    public SyncService.SyncResult sync(@RequestBody(required = false) SyncRequest request) {
        return sync.sync(request == null ? null : request.dir());
    }
}
