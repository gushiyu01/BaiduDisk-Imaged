package com.zcode.picman.web.dto;

import com.zcode.picman.domain.AssetRow;
import com.zcode.picman.domain.TagRow;
import com.zcode.picman.support.FileKinds;

import java.util.List;
import java.util.Map;

/** 前端契约见 docs/API.md */
public final class Dtos {

    private Dtos() {
    }

    public record TagDto(long id, String name, String color, Long count) {
        public static TagDto of(TagRow row) {
            return new TagDto(row.id(), row.name(), row.color(),
                    row.count() == 0 ? null : row.count());
        }
    }

    public record AssetDto(
            long id,
            String fsId,
            String name,
            String path,
            long size,
            String kind,
            Integer category,
            Integer width,
            Integer height,
            String mime,
            String ext,
            String serverMtime,
            boolean favorite,
            List<TagDto> tags,
            String thumbSource,
            /** 是否值得去请求 /thumb。文档和压缩包百度不给缩略图，前端直接显示类型图标 */
            boolean thumbnailable,
            boolean missing,
            String indexedAt
    ) {
        public static AssetDto of(AssetRow row, List<TagDto> tags) {
            String ext = com.zcode.picman.support.MimeTypes.extensionOf(row.name());
            return new AssetDto(
                    row.id(), row.fsId(), row.name(), row.path(), row.size(),
                    row.kind(), row.category(), row.width(), row.height(),
                    row.mime(), ext, row.serverMtime(),
                    row.favorite(), tags == null ? List.of() : tags, row.thumbSource(),
                    FileKinds.hasThumbnail(row.kind()),
                    row.missing(), row.indexedAt());
        }
    }

    public record PageResponse(List<AssetDto> items, long total, int page, int size) {
    }

    /** 文件库的类型筛选器：类型 + 数量 */
    public record KindStat(String kind, String label, long count) {
    }

    public record KindStatsResponse(List<KindStat> kinds, long total) {

        private static final Map<String, String> LABELS = Map.of(
                FileKinds.IMAGE, "图片",
                FileKinds.VIDEO, "视频",
                FileKinds.AUDIO, "音频",
                FileKinds.DOC, "文档",
                FileKinds.OTHER, "其他");

        /** 顺序固定，前端筛选栏不会因为数据变化而跳动 */
        private static final List<String> ORDER =
                List.of(FileKinds.IMAGE, FileKinds.VIDEO, FileKinds.AUDIO, FileKinds.DOC, FileKinds.OTHER);

        public static KindStatsResponse from(Map<String, Long> counts) {
            long total = counts.values().stream().mapToLong(Long::longValue).sum();
            List<KindStat> stats = ORDER.stream()
                    .map(k -> new KindStat(k, LABELS.get(k), counts.getOrDefault(k, 0L)))
                    .toList();
            return new KindStatsResponse(stats, total);
        }
    }
}
