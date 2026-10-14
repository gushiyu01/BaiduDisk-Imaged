package com.zcode.picman.repository;

import com.zcode.picman.domain.AssetQuery;
import com.zcode.picman.domain.AssetRow;
import com.zcode.picman.support.DbDialect;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Repository
public class AssetRepository {

    private static final RowMapper<AssetRow> MAPPER = (rs, i) -> new AssetRow(
            rs.getLong("id"),
            rs.getString("fs_id"),
            rs.getString("path"),
            rs.getString("name"),
            rs.getLong("size"),
            rs.getString("kind"),
            (Integer) rs.getObject("category"),
            (Integer) rs.getObject("width"),
            (Integer) rs.getObject("height"),
            rs.getString("mime"),
            rs.getString("md5"),
            rs.getString("server_mtime"),
            rs.getInt("favorite") == 1,
            rs.getString("thumb_source"),
            rs.getInt("missing") == 1,
            rs.getString("indexed_at"),
            rs.getString("updated_at"));

    private final JdbcTemplate jdbc;
    private final DbDialect dialect;

    public AssetRepository(JdbcTemplate jdbc, DbDialect dialect) {
        this.jdbc = jdbc;
        this.dialect = dialect;
    }

    // ------------------------------------------------------------------ 计数

    public long count() {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM file_asset WHERE missing = 0", Long.class);
        return n == null ? 0 : n;
    }

    public long countByKind(String kind) {
        Long n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM file_asset WHERE missing = 0 AND kind = ?", Long.class, kind);
        return n == null ? 0 : n;
    }

    /** 各类型数量，给文件库的类型筛选标签显示角标 */
    public Map<String, Long> countsByKind() {
        Map<String, Long> out = new LinkedHashMap<>();
        jdbc.query("SELECT kind, COUNT(*) AS cnt FROM file_asset WHERE missing = 0 GROUP BY kind",
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> out.put(rs.getString("kind"), rs.getLong("cnt")));
        return out;
    }

    // ------------------------------------------------------------------ 单条

    public Optional<AssetRow> findById(long id) {
        List<AssetRow> rows = jdbc.query("SELECT * FROM file_asset WHERE id = ?", MAPPER, id);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public Optional<AssetRow> findByPath(String path) {
        List<AssetRow> rows = jdbc.query("SELECT * FROM file_asset WHERE path = ?", MAPPER, path);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    // ------------------------------------------------------------------ 检索

    private record Where(String sql, List<Object> args) {
    }

    private Where buildWhere(AssetQuery query) {
        StringBuilder sql = new StringBuilder(" WHERE 1 = 1");
        List<Object> args = new ArrayList<>();

        if (query.q() != null && !query.q().isBlank()) {
            String like = "%" + query.q().trim().toLowerCase() + "%";
            sql.append(" AND (LOWER(i.name) LIKE ? OR LOWER(i.path) LIKE ?)");
            args.add(like);
            args.add(like);
        }
        if (query.kind() != null && !query.kind().isBlank()) {
            sql.append(" AND i.kind = ?");
            args.add(query.kind());
        }
        if (Boolean.TRUE.equals(query.favorite())) {
            sql.append(" AND i.favorite = 1");
        }
        if (query.tagIds() != null && !query.tagIds().isEmpty()) {
            String ph = String.join(",", Collections.nCopies(query.tagIds().size(), "?"));
            sql.append(" AND i.id IN (SELECT asset_id FROM asset_tag WHERE tag_id IN (").append(ph).append("))");
            args.addAll(query.tagIds());
        }
        return new Where(sql.toString(), args);
    }

    public List<AssetRow> search(AssetQuery query) {
        Where where = buildWhere(query);
        List<Object> args = new ArrayList<>(where.args());
        args.add(query.size());
        args.add(query.offset());
        return jdbc.query("""
                SELECT i.* FROM file_asset i
                %s
                ORDER BY %s
                LIMIT ? OFFSET ?
                """.formatted(where.sql(), query.orderByClause(dialect)), MAPPER, args.toArray());
    }

    public long countSearch(AssetQuery query) {
        Where where = buildWhere(query);
        Long n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM file_asset i" + where.sql(), Long.class, where.args().toArray());
        return n == null ? 0 : n;
    }

    // ------------------------------------------------------------------ 写入

    /**
     * 按 path 幂等写入。已存在时只更新网盘侧字段，
     * favorite / 标签这些本地数据必须保留。
     */
    public void upsertFromRemote(String fsId, String path, String name, long size,
                                 String kind, Integer category,
                                 Integer width, Integer height, String mime, String md5,
                                 String serverMtime, String thumbSource) {
        String now = Instant.now().toString();
        jdbc.update(dialect.upsertAssetSql(),
                fsId, path, name, size, kind, category, width, height, mime, md5, serverMtime,
                thumbSource, now, now);
    }

    public void updateFsIdAndPath(long id, String fsId, String path, String name) {
        jdbc.update("""
                UPDATE file_asset SET fs_id = ?, path = ?, name = ?, updated_at = ?
                WHERE id = ?
                """, fsId, path, name, Instant.now().toString(), id);
    }

    /** 改名可能换掉扩展名，等于换了文件类型，kind 和 mime 要跟着重算 */
    public void updateKindAndMime(long id, String kind, String mime) {
        jdbc.update("UPDATE file_asset SET kind = ?, mime = ?, updated_at = ? WHERE id = ?",
                kind, mime, Instant.now().toString(), id);
    }

    public void updateThumbSource(long id, String thumbSource) {
        jdbc.update("UPDATE file_asset SET thumb_source = ?, updated_at = ? WHERE id = ?",
                thumbSource, Instant.now().toString(), id);
    }

    /**
     * 补写宽高。
     * <p>
     * 百度 filemetas 的 extra=1 不保证返回 width/height（实测同一个文件时有时无），
     * 所以拿不到时由服务端自己解码图片头补上。
     */
    public void updateDimensions(long id, Integer width, Integer height) {
        if (width == null || height == null || width <= 0 || height <= 0) {
            return;
        }
        jdbc.update("UPDATE file_asset SET width = ?, height = ?, updated_at = ? WHERE id = ?",
                width, height, Instant.now().toString(), id);
    }

    public void setFavorite(long id, boolean favorite) {
        jdbc.update("UPDATE file_asset SET favorite = ?, updated_at = ? WHERE id = ?",
                favorite ? 1 : 0, Instant.now().toString(), id);
    }

    public void setMissing(long id, boolean missing) {
        jdbc.update("UPDATE file_asset SET missing = ?, updated_at = ? WHERE id = ?",
                missing ? 1 : 0, Instant.now().toString(), id);
    }

    /** 同步时按路径批量标记「网盘上已经不在了」。不改动 favorite 和标签。 */
    public int setMissingByPath(List<String> paths, boolean missing) {
        if (paths == null || paths.isEmpty()) {
            return 0;
        }
        String ph = String.join(",", Collections.nCopies(paths.size(), "?"));
        Object[] args = new Object[paths.size() + 2];
        args[0] = missing ? 1 : 0;
        args[1] = Instant.now().toString();
        for (int i = 0; i < paths.size(); i++) {
            args[i + 2] = paths.get(i);
        }
        return jdbc.update(
                "UPDATE file_asset SET missing = ?, updated_at = ? WHERE path IN (" + ph + ")", args);
    }

    public void deleteById(long id) {
        jdbc.update("DELETE FROM file_asset WHERE id = ?", id);
    }

    public int deleteByPaths(List<String> paths) {
        if (paths == null || paths.isEmpty()) {
            return 0;
        }
        String ph = String.join(",", Collections.nCopies(paths.size(), "?"));
        return jdbc.update("DELETE FROM file_asset WHERE path IN (" + ph + ")", paths.toArray());
    }

    /** 某个网盘目录下已有的全部路径，同步时用来算「已经不在网盘上的」 */
    public List<String> findPathsUnder(String baseDir) {
        String prefix = baseDir.endsWith("/") ? baseDir : baseDir + "/";
        return jdbc.queryForList(
                "SELECT path FROM file_asset WHERE " + dialect.likeStartsWith("path"),
                String.class, escapeLike(prefix) + "%");
    }

    private static String escapeLike(String s) {
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }
}
