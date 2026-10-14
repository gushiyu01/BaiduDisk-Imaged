package com.zcode.picman.domain;

import com.zcode.picman.support.DbDialect;

import java.util.List;

/**
 * 文件库检索条件。tagIds 之间是「或」关系——同时选多个标签时显示命中任一标签的文件。
 *
 * @param kind 大类筛选，null 表示不限；图库就是把 kind 固定成 IMAGE
 */
public record AssetQuery(
        String q,
        List<Long> tagIds,
        Boolean favorite,
        String kind,
        String sort,
        int page,
        int size
) {

    /**
     * 排序白名单。绝不能把用户传的字符串直接拼进 ORDER BY。
     * <p>
     * 按名称排序要交给方言处理：SQLite 必须显式 COLLATE NOCASE 才不区分大小写，
     * MySQL 用了 _ci 排序规则则不能再加这个子句。
     */
    public String orderByClause(DbDialect dialect) {
        String s = sort == null ? "time_desc" : sort;
        return switch (s) {
            case "time_asc" -> "i.server_mtime ASC, i.id ASC";
            case "name_asc" -> dialect.nameOrder("i.name", true);
            case "name_desc" -> dialect.nameOrder("i.name", false);
            case "size_desc" -> "i.size DESC, i.id DESC";
            case "size_asc" -> "i.size ASC, i.id ASC";
            default -> "i.server_mtime DESC, i.id DESC";
        };
    }

    /** 图库视图的快捷构造：只查图片 */
    public static AssetQuery forImages(String q, List<Long> tagIds, Boolean favorite, String sort,
                                       int page, int size) {
        return new AssetQuery(q, tagIds, favorite, com.zcode.picman.support.FileKinds.IMAGE, sort, page, size);
    }

    public int offset() {
        return Math.max(0, (page - 1) * size);
    }
}
