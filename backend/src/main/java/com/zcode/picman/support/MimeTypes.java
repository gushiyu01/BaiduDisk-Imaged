package com.zcode.picman.support;

import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 文件扩展名 → MIME 类型。
 * <p>
 * 不依赖 Files.probeContentType：它在不同系统上行为不一致，
 * 而 MIME 直接决定浏览器是内联显示还是下载，必须稳定。
 */
public final class MimeTypes {

    public static final String OCTET_STREAM = "application/octet-stream";

    private static final Map<String, String> BY_EXT = Map.ofEntries(
            // 图片
            Map.entry("jpg", "image/jpeg"),
            Map.entry("jpeg", "image/jpeg"),
            Map.entry("jpe", "image/jpeg"),
            Map.entry("png", "image/png"),
            Map.entry("gif", "image/gif"),
            Map.entry("webp", "image/webp"),
            Map.entry("bmp", "image/bmp"),
            Map.entry("tif", "image/tiff"),
            Map.entry("tiff", "image/tiff"),
            Map.entry("heic", "image/heic"),
            Map.entry("heif", "image/heif"),
            Map.entry("avif", "image/avif"),
            Map.entry("svg", "image/svg+xml"),
            Map.entry("ico", "image/x-icon"),
            // 视频
            Map.entry("mp4", "video/mp4"),
            Map.entry("m4v", "video/mp4"),
            Map.entry("mov", "video/quicktime"),
            Map.entry("avi", "video/x-msvideo"),
            Map.entry("mkv", "video/x-matroska"),
            Map.entry("webm", "video/webm"),
            Map.entry("wmv", "video/x-ms-wmv"),
            Map.entry("flv", "video/x-flv"),
            Map.entry("mpg", "video/mpeg"),
            Map.entry("mpeg", "video/mpeg"),
            Map.entry("3gp", "video/3gpp"),
            Map.entry("ts", "video/mp2t"),
            Map.entry("rmvb", "application/vnd.rn-realmedia-vbr"),
            // 音频
            Map.entry("mp3", "audio/mpeg"),
            Map.entry("wav", "audio/wav"),
            Map.entry("flac", "audio/flac"),
            Map.entry("aac", "audio/aac"),
            Map.entry("ogg", "audio/ogg"),
            Map.entry("m4a", "audio/mp4"),
            Map.entry("wma", "audio/x-ms-wma"),
            Map.entry("opus", "audio/opus"),
            // 文档
            Map.entry("pdf", "application/pdf"),
            Map.entry("txt", "text/plain"),
            Map.entry("md", "text/markdown"),
            Map.entry("markdown", "text/markdown"),
            Map.entry("csv", "text/csv"),
            Map.entry("tsv", "text/tab-separated-values"),
            Map.entry("json", "application/json"),
            Map.entry("xml", "application/xml"),
            Map.entry("yaml", "application/yaml"),
            Map.entry("yml", "application/yaml"),
            Map.entry("html", "text/html"),
            Map.entry("htm", "text/html"),
            Map.entry("rtf", "application/rtf"),
            Map.entry("doc", "application/msword"),
            Map.entry("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            Map.entry("xls", "application/vnd.ms-excel"),
            Map.entry("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            Map.entry("ppt", "application/vnd.ms-powerpoint"),
            Map.entry("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            Map.entry("epub", "application/epub+zip"),
            // 压缩包
            Map.entry("zip", "application/zip"),
            Map.entry("rar", "application/vnd.rar"),
            Map.entry("7z", "application/x-7z-compressed"),
            Map.entry("tar", "application/x-tar"),
            Map.entry("gz", "application/gzip"));

    /** 可以进图库的扩展名 */
    private static final Set<String> IMAGE_EXTS = Set.of(
            "jpg", "jpeg", "jpe", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif");

    private MimeTypes() {
    }

    public static String fromFilename(String filename) {
        return BY_EXT.getOrDefault(extensionOf(filename), OCTET_STREAM);
    }

    public static String extensionOf(String filename) {
        if (filename == null) {
            return "";
        }
        // 只取最后一段，避免 "a.b/c" 这种带目录的输入算错
        int slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
        String base = slash >= 0 ? filename.substring(slash + 1) : filename;
        int dot = base.lastIndexOf('.');
        if (dot < 0 || dot == base.length() - 1) {
            return "";
        }
        return base.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    public static boolean isImageExtension(String ext) {
        return IMAGE_EXTS.contains(ext.toLowerCase(Locale.ROOT));
    }

    public static boolean isImageFilename(String filename) {
        return isImageExtension(extensionOf(filename));
    }

    /** 百度返回的 category：1 视频 / 2 音频 / 3 图片 / 4 文档 / 5 应用 / 6 其他 / 7 种子 */
    public static boolean isImageCategory(Integer category) {
        return category != null && category == 3;
    }
}
