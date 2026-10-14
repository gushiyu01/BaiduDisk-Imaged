package com.zcode.picman.support;

import java.util.Locale;
import java.util.Set;

/**
 * 文件大类推导。
 * <p>
 * 百度 {@code list}/{@code filemetas} 返回的 {@code category} 只有 7 个粗粒度值
 * （1 视频 / 2 音频 / 3 图片 / 4 文档 / 5 应用 / 6 其他 / 7 种子），
 * 实测大量文件会被归到「6 其他」，所以以扩展名为准、category 只作兜底。
 */
public final class FileKinds {

    public static final String IMAGE = "IMAGE";
    public static final String VIDEO = "VIDEO";
    public static final String AUDIO = "AUDIO";
    public static final String DOC = "DOC";
    public static final String OTHER = "OTHER";

    /** 前端筛选器用的全集，顺序即展示顺序 */
    public static final Set<String> ALL = Set.of(IMAGE, VIDEO, AUDIO, DOC, OTHER);

    private static final Set<String> VIDEO_EXTS = Set.of(
            "mp4", "mov", "avi", "mkv", "wmv", "flv", "webm", "m4v", "mpg", "mpeg",
            "3gp", "ts", "rmvb", "rm", "vob", "m2ts", "f4v");

    private static final Set<String> AUDIO_EXTS = Set.of(
            "mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "ape", "opus", "aiff", "mid", "midi");

    private static final Set<String> DOC_EXTS = Set.of(
            "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "markdown",
            "csv", "tsv", "json", "xml", "yaml", "yml", "html", "htm", "rtf",
            "epub", "mobi", "azw3", "odt", "ods", "odp", "pages", "numbers", "key");

    private FileKinds() {
    }

    /**
     * 推导文件大类。扩展名优先，识别不出来再看百度给的 category。
     *
     * @param category 百度原始分类码，可为 null
     * @param filename 文件名，可带路径
     */
    public static String of(Integer category, String filename) {
        String ext = MimeTypes.extensionOf(filename).toLowerCase(Locale.ROOT);
        if (!ext.isEmpty()) {
            if (MimeTypes.isImageExtension(ext)) return IMAGE;
            if (VIDEO_EXTS.contains(ext)) return VIDEO;
            if (AUDIO_EXTS.contains(ext)) return AUDIO;
            if (DOC_EXTS.contains(ext)) return DOC;
        }
        if (category != null) {
            return switch (category) {
                case 1 -> VIDEO;
                case 2 -> AUDIO;
                case 3 -> IMAGE;
                case 4 -> DOC;
                // 5 应用 / 6 其他 / 7 种子都归到 OTHER，前端按扩展名给出更细的图标
                default -> OTHER;
            };
        }
        return OTHER;
    }

    /** 只有图片和视频值得去取百度缩略图；文档和压缩包取不到，前端直接显示类型图标 */
    public static boolean hasThumbnail(String kind) {
        return IMAGE.equals(kind) || VIDEO.equals(kind);
    }

    public static boolean isValid(String kind) {
        return kind != null && ALL.contains(kind);
    }
}
