package com.zcode.picman.domain;

/**
 * file_asset 表的一行。
 *
 * @param kind        大类 IMAGE / VIDEO / AUDIO / DOC / OTHER，见 FileKinds
 * @param category    百度原始分类码，保留下来备查，不参与业务判断
 * @param thumbSource BAIDU / LOCAL / NONE / UNKNOWN
 */
public record AssetRow(
        long id,
        String fsId,
        String path,
        String name,
        long size,
        String kind,
        Integer category,
        Integer width,
        Integer height,
        String mime,
        String md5,
        String serverMtime,
        boolean favorite,
        String thumbSource,
        boolean missing,
        String indexedAt,
        String updatedAt
) {
}
