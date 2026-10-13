package com.zcode.picman.service;

import com.zcode.picman.baidu.BaiduDtos.CreateResp;
import com.zcode.picman.baidu.BaiduDtos.FileMeta;
import com.zcode.picman.baidu.BaiduDtos.FsEntry;
import com.zcode.picman.baidu.BaiduHttp;
import com.zcode.picman.baidu.BaiduPanClient;
import com.zcode.picman.baidu.BaiduPanException;
import com.zcode.picman.config.AppProperties;
import com.zcode.picman.domain.AssetQuery;
import com.zcode.picman.domain.AssetRow;
import com.zcode.picman.domain.TagRow;
import com.zcode.picman.repository.AssetRepository;
import com.zcode.picman.repository.TagRepository;
import com.zcode.picman.support.ApiException;
import com.zcode.picman.support.FileKinds;
import com.zcode.picman.support.MimeTypes;
import com.zcode.picman.web.dto.Dtos.AssetDto;
import com.zcode.picman.web.dto.Dtos.PageResponse;
import com.zcode.picman.web.dto.Dtos.TagDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * 网盘文件索引的业务逻辑。图片只是 kind='IMAGE' 的一种，图库和文件库共用这一套。
 */
@Service
public class AssetService {

    private static final Logger log = LoggerFactory.getLogger(AssetService.class);

    /** 百度路径里不允许出现的字符，实测报错文案：「命名中包含?|"><:*等特殊字符」 */
    private static final String ILLEGAL_PATH_CHARS = "[\\\\/:*?\"<>|]";
    private static final int MAX_NAME_LENGTH = 180;
    /** 文件名冲突时最多重试这么多次 */
    private static final int MAX_NAME_ATTEMPTS = 20;

    private final AppProperties props;
    private final AssetRepository assets;
    private final TagRepository tags;
    private final BaiduPanClient baidu;

    public AssetService(AppProperties props, AssetRepository assets, TagRepository tags, BaiduPanClient baidu) {
        this.props = props;
        this.assets = assets;
        this.tags = tags;
        this.baidu = baidu;
    }

    // ------------------------------------------------------------------ 查询

    public PageResponse list(AssetQuery query) {
        List<AssetRow> rows = assets.search(query);
        long total = assets.countSearch(query);

        Map<Long, List<TagRow>> tagMap = tags.tagsForAssets(rows.stream().map(AssetRow::id).toList());
        List<AssetDto> items = rows.stream()
                .map(r -> AssetDto.of(r, toTagDtos(tagMap.getOrDefault(r.id(), List.of()))))
                .toList();
        return new PageResponse(items, total, query.page(), query.size());
    }

    public AssetDto get(long id) {
        return toDto(requireAsset(id));
    }

    /** 供缩略图服务等需要原始行的场景使用 */
    public AssetRow requireRow(long id) {
        return requireAsset(id);
    }

    private AssetRow requireAsset(long id) {
        return assets.findById(id).orElseThrow(() -> ApiException.notFound("文件不存在（id=" + id + "）"));
    }

    private AssetDto toDto(AssetRow row) {
        List<TagRow> ts = tags.tagsForAssets(List.of(row.id())).getOrDefault(row.id(), List.of());
        return AssetDto.of(row, toTagDtos(ts));
    }

    private static List<TagDto> toTagDtos(List<TagRow> rows) {
        return rows.stream().map(TagDto::of).toList();
    }

    // ------------------------------------------------------------------ 上传

    /**
     * 上传一个文件。返回落库后的记录。
     * <p>
     * 先把 multipart 落到临时文件再上传：大文件不能整个读进堆内存，
     * 而且分片上传需要对同一个文件做两遍扫描（一遍算 md5，一遍传分片）。
     *
     * @param imageOnly true 时只接受图片（图库的上传入口用），false 时任意文件都能传
     */
    public AssetDto upload(MultipartFile file, boolean imageOnly) {
        String originalName = file.getOriginalFilename();
        if (originalName == null || originalName.isBlank()) {
            throw ApiException.badRequest("上传文件缺少文件名");
        }
        if (file.isEmpty()) {
            throw ApiException.badRequest("文件内容为空：" + originalName);
        }
        if (imageOnly && !MimeTypes.isImageFilename(originalName)) {
            throw ApiException.badRequest("图库只接受图片文件，收到：%s。要传其他类型请用「文件库」页的上传入口。"
                    .formatted(originalName));
        }

        String safeName = sanitizeFilename(originalName);
        if (safeName.isBlank()) {
            throw ApiException.badRequest("文件名不合法：" + originalName);
        }

        Path temp = null;
        try {
            String ext = MimeTypes.extensionOf(safeName);
            temp = Files.createTempFile("picman-upload-", ext.isEmpty() ? "" : "." + ext);
            try (InputStream in = file.getInputStream()) {
                Files.copy(in, temp, StandardCopyOption.REPLACE_EXISTING);
            }

            String baseDir = props.baseDir();
            baidu.mkdir(baseDir);

            UploadOutcome outcome = uploadWithUniqueName(baseDir, safeName, temp);
            return indexUploaded(outcome);

        } catch (IOException e) {
            throw new ApiException(org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR", "保存上传文件失败：" + e.getMessage());
        } finally {
            if (temp != null) {
                try {
                    Files.deleteIfExists(temp);
                } catch (IOException e) {
                    log.debug("临时文件清理失败：{}", temp);
                }
            }
        }
    }

    private record UploadOutcome(CreateResp created, String remotePath) {
    }

    /** 同名时自动加序号，而不是覆盖用户已有文件 */
    private UploadOutcome uploadWithUniqueName(String baseDir, String safeName, Path temp) {
        String candidate = safeName;
        for (int attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
            String remotePath = baseDir + "/" + candidate;
            try {
                CreateResp created = baidu.upload(remotePath, temp, false);
                return new UploadOutcome(created, remotePath);
            } catch (BaiduPanException e) {
                if (!isNameConflict(e)) {
                    throw e;
                }
                candidate = numberedName(safeName, attempt + 1);
                log.debug("目标名称已存在，改用 {}", candidate);
            }
        }
        throw ApiException.conflict("同名文件过多，无法为「%s」找到可用名称".formatted(safeName));
    }

    private static boolean isNameConflict(BaiduPanException e) {
        return e.getErrno() == com.zcode.picman.baidu.BaiduErrno.ALREADY_EXISTS
                || e.getErrno() == com.zcode.picman.baidu.BaiduErrno.BAD_PATH;
    }

    private static String numberedName(String name, int n) {
        int dot = name.lastIndexOf('.');
        if (dot <= 0) {
            return "%s(%d)".formatted(name, n);
        }
        return "%s(%d)%s".formatted(name.substring(0, dot), n, name.substring(dot));
    }

    private AssetDto indexUploaded(UploadOutcome outcome) {
        String remotePath = outcome.remotePath();
        String name = fileNameOf(remotePath);
        CreateResp created = outcome.created();

        // list/filemetas 都不返回 server_mtime，只有 create 的 mtime 可用，按秒转成 ISO
        String serverMtime = created != null && created.mtime() != null
                ? Instant.ofEpochSecond(created.mtime()).toString()
                : Instant.now().toString();

        Long size = created != null && created.size() != null ? created.size() : null;
        String md5 = created != null ? created.md5() : null;
        String fsId = created != null && created.fsId() != null ? String.valueOf(created.fsId()) : null;
        Integer category = created == null ? null : created.category();
        String kind = FileKinds.of(category, name);
        String mime = MimeTypes.fromFilename(name);

        assets.upsertFromRemote(fsId, remotePath, name, size == null ? 0L : size,
                kind, category, null, null, mime, md5, serverMtime, "UNKNOWN");

        long id = assets.findByPath(remotePath)
                .orElseThrow(() -> new IllegalStateException("上传后写入索引失败：" + remotePath))
                .id();

        // 补充宽高等只有 filemetas 才给的字段。非图片文件拿不到宽高，失败也无所谓
        try {
            FileMeta meta = baidu.metaByPath(remotePath, false, true);
            if (meta != null) {
                assets.upsertFromRemote(
                        meta.fsId() == null ? fsId : String.valueOf(meta.fsId()),
                        remotePath, name, meta.size() == null ? 0L : meta.size(),
                        kind,
                        meta.category() == null ? category : meta.category(),
                        meta.width(), meta.height(), mime,
                        meta.md5() == null ? md5 : meta.md5(), serverMtime,
                        meta.bestThumbUrl() != null ? "BAIDU" : "UNKNOWN");
            }
        } catch (BaiduPanException e) {
            log.warn("上传后补充元数据失败（{}）：{}", remotePath, e.getMessage());
        }
        return get(id);
    }

    // ------------------------------------------------------------------ 重命名

    @Transactional
    public AssetDto rename(long id, String newName) {
        AssetRow row = requireAsset(id);
        String safe = sanitizeFilename(newName);
        if (safe.isBlank()) {
            throw ApiException.badRequest("文件名不能为空");
        }
        if (safe.equals(row.name())) {
            return toDto(row);
        }

        String parent = parentOf(row.path());
        String newPath = parent + "/" + safe;

        if (assets.findByPath(newPath).isPresent()) {
            throw ApiException.conflict("索引里已存在同名文件：" + safe);
        }

        baidu.rename(row.path(), safe);

        // 实测重命名会让百度重新分配 fs_id，不能沿用旧值；顺便重算类型，
        // 改了扩展名就等于换了文件类型（比如 .txt 改成 .md）
        FileMeta meta = baidu.metaByPath(newPath, false, false);
        String newFsId = meta != null && meta.fsId() != null ? String.valueOf(meta.fsId()) : row.fsId();
        assets.updateFsIdAndPath(row.id(), newFsId, newPath, safe);
        assets.updateKindAndMime(row.id(), FileKinds.of(row.category(), safe), MimeTypes.fromFilename(safe));

        log.info("已重命名：{} → {}", row.path(), newPath);
        return get(id);
    }

    // ------------------------------------------------------------------ 收藏与标签

    public AssetDto setFavorite(long id, boolean favorite) {
        requireAsset(id);
        assets.setFavorite(id, favorite);
        return get(id);
    }

    public AssetDto setTags(long id, List<Long> tagIds) {
        requireAsset(id);
        if (tagIds != null) {
            for (Long tagId : tagIds) {
                if (tags.findById(tagId).isEmpty()) {
                    throw ApiException.badRequest("标签不存在：id=" + tagId);
                }
            }
        }
        tags.setAssetTags(id, tagIds);
        return get(id);
    }

    // ------------------------------------------------------------------ 删除

    public enum DeleteMode {
        /** 只删本地索引，网盘文件保留 */
        INDEX,
        /** 只删网盘文件，索引保留并标记为已丢失 */
        REMOTE,
        /** 两边都删 */
        BOTH;

        public static DeleteMode parse(String raw) {
            if (raw == null || raw.isBlank()) {
                return INDEX;
            }
            return switch (raw.trim().toLowerCase()) {
                case "remote" -> REMOTE;
                case "both" -> BOTH;
                case "index" -> INDEX;
                default -> throw ApiException.badRequest(
                        "未知的删除模式：%s（可选 index / remote / both）".formatted(raw));
            };
        }
    }

    public Map<String, Object> delete(long id, DeleteMode mode) {
        AssetRow row = requireAsset(id);
        boolean remoteDeleted = false;
        boolean indexDeleted = false;

        if (mode == DeleteMode.REMOTE || mode == DeleteMode.BOTH) {
            try {
                baidu.delete(List.of(row.path()));
                remoteDeleted = true;
            } catch (BaiduPanException e) {
                if (!e.isNotFound()) {
                    throw e;
                }
                // 网盘上本来就没有，视为已删除
                remoteDeleted = true;
                log.info("网盘上未找到 {}，按已删除处理", row.path());
            }
        }

        if (mode == DeleteMode.BOTH) {
            assets.deleteById(id);
            indexDeleted = true;
        } else if (mode == DeleteMode.REMOTE) {
            // 保留索引但标记丢失，用户还能看到曾经有过这个文件
            assets.setMissing(id, true);
        } else {
            assets.deleteById(id);
            indexDeleted = true;
        }

        log.info("删除文件 id={} path={} mode={} remote={} index={}", id, row.path(), mode, remoteDeleted, indexDeleted);
        return Map.of(
                "deleted", mode.name().toLowerCase(),
                "remoteDeleted", remoteDeleted,
                "indexDeleted", indexDeleted);
    }

    // ------------------------------------------------------------------ 原图流

    /** 原文件流。调用方负责关闭 body。 */
    public record RawStream(InputStream body, String contentType, long contentLength,
                            String contentRange, int status) implements AutoCloseable {
        @Override
        public void close() {
            try {
                body.close();
            } catch (IOException ignored) {
                // 关闭失败无需处理
            }
        }
    }

    /**
     * 打开原文件下载流。
     * <p>
     * dlink 有 8 小时有效期，客户端拿到的地址可能在传输过程中过期（errno 31360/31362），
     * 这里重新取一次链接再重试一遍，而不是把错误直接抛给浏览器。
     */
    public RawStream openRaw(long id, String rangeHeader) {
        AssetRow row = requireAsset(id);

        BaiduPanException last = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            FileMeta meta = attempt == 0 ? requireMeta(row) : tryMeta(row);
            if (meta == null) {
                throw new BaiduPanException(
                        com.zcode.picman.baidu.BaiduErrno.NOT_FOUND,
                        "网盘上找不到该文件：%s".formatted(row.path()));
            }
            String dlink = meta.dlink();
            if (dlink == null || dlink.isBlank()) {
                throw new BaiduPanException(
                        "百度未返回下载地址，文件可能已被移动或删除：%s".formatted(row.path()), null);
            }
            try {
                BaiduHttp.RemoteStream stream = baidu.openDlink(dlink, rangeHeader);
                String contentType = stream.headers().contentType();
                if (contentType == null || contentType.isBlank() || contentType.startsWith("application/json")) {
                    // 上游有时用 200 返回 JSON 错误体，用扩展名兜底
                    contentType = MimeTypes.fromFilename(row.name());
                }
                return new RawStream(stream.body(), contentType,
                        stream.headers().contentLength(), stream.headers().contentRange(), stream.status());
            } catch (BaiduPanException e) {
                if (!e.isDlinkStale()) {
                    throw e;
                }
                last = e;
                log.info("下载链接已过期，重新获取后重试（文件 {}）", id);
            }
        }
        throw last == null ? new BaiduPanException("下载失败", null) : last;
    }

    private FileMeta requireMeta(AssetRow row) {
        FileMeta meta = tryMeta(row);
        if (meta == null) {
            throw new BaiduPanException(
                    com.zcode.picman.baidu.BaiduErrno.NOT_FOUND,
                    "网盘上找不到该文件：%s".formatted(row.path()));
        }
        return meta;
    }

    private FileMeta tryMeta(AssetRow row) {
        try {
            if (row.fsId() != null && !row.fsId().isBlank()) {
                FileMeta meta = baidu.fileMeta(Long.parseLong(row.fsId()));
                if (meta != null && meta.fsId() != null) {
                    return meta;
                }
            }
        } catch (NumberFormatException | BaiduPanException e) {
            log.debug("按 fs_id 查元数据失败，改用路径：{}", e.getMessage());
        }
        return baidu.metaByPath(row.path(), true, false);
    }

    // ------------------------------------------------------------------ 工具

    /** 清理掉百度路径不接受的字符，并截断过长的名字 */
    public static String sanitizeFilename(String name) {
        if (name == null) {
            return "";
        }
        // 浏览器可能带上目录部分，只取最后一段
        String base = name.replace('\\', '/');
        int slash = base.lastIndexOf('/');
        if (slash >= 0) {
            base = base.substring(slash + 1);
        }
        String cleaned = base.replaceAll(ILLEGAL_PATH_CHARS, "_").trim();
        // 去掉首尾的点和空格：Windows 与百度都不友好
        cleaned = cleaned.replaceAll("^[.\\s]+", "").replaceAll("[.\\s]+$", "");
        if (cleaned.length() > MAX_NAME_LENGTH) {
            String ext = MimeTypes.extensionOf(cleaned);
            String stem = cleaned.substring(0, cleaned.length() - (ext.isEmpty() ? 0 : ext.length() + 1));
            int keep = Math.max(1, MAX_NAME_LENGTH - (ext.isEmpty() ? 0 : ext.length() + 1));
            cleaned = stem.substring(0, Math.min(stem.length(), keep)) + (ext.isEmpty() ? "" : "." + ext);
        }
        return cleaned;
    }

    static String parentOf(String path) {
        int slash = path.lastIndexOf('/');
        return slash <= 0 ? "/" : path.substring(0, slash);
    }

    static String fileNameOf(String path) {
        int slash = path.lastIndexOf('/');
        return slash < 0 ? path : path.substring(slash + 1);
    }

    /** 供同步使用：把一批网盘条目写进索引 */
    @Transactional
    void upsertEntries(List<FsEntry> entries, Map<String, FileMeta> metaByPath) {
        for (FsEntry entry : entries) {
            FileMeta meta = metaByPath.get(entry.path());
            String name = entry.name();
            Integer category = meta != null && meta.category() != null ? meta.category() : entry.category();
            assets.upsertFromRemote(
                    entry.fsId() == null ? null : String.valueOf(entry.fsId()),
                    entry.path(),
                    name,
                    entry.size() == null ? 0L : entry.size(),
                    FileKinds.of(category, name),
                    category,
                    meta == null ? entry.width() : meta.width(),
                    meta == null ? entry.height() : meta.height(),
                    MimeTypes.fromFilename(name),
                    entry.md5(),
                    entry.serverMtime() == null ? null : Instant.ofEpochSecond(entry.serverMtime()).toString(),
                    meta != null && meta.bestThumbUrl() != null ? "BAIDU" : "UNKNOWN");
        }
    }

    /** 文件库基础目录（网盘路径） */
    public String baseDir() {
        return props.baseDir();
    }
}
