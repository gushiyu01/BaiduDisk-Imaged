package com.zcode.picman.repository;

import com.zcode.picman.domain.TagRow;
import com.zcode.picman.support.DbDialect;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Repository
public class TagRepository {

    private static final RowMapper<TagRow> MAPPER = (rs, i) -> new TagRow(
            rs.getLong("id"), rs.getString("name"), rs.getString("color"), rs.getLong("cnt"));

    private final JdbcTemplate jdbc;
    private final DbDialect dialect;

    public TagRepository(JdbcTemplate jdbc, DbDialect dialect) {
        this.jdbc = jdbc;
        this.dialect = dialect;
    }

    public List<TagRow> findAllWithCount() {
        return jdbc.query("""
                SELECT t.id, t.name, t.color, COUNT(it.asset_id) AS cnt
                FROM tag t
                LEFT JOIN asset_tag it ON it.tag_id = t.id
                GROUP BY t.id, t.name, t.color
                ORDER BY %s
                """.formatted(dialect.nameOrder("t.name", true)), MAPPER);
    }

    public Optional<TagRow> findById(long id) {
        List<TagRow> rows = jdbc.query("""
                SELECT t.id, t.name, t.color,
                       (SELECT COUNT(*) FROM asset_tag it WHERE it.tag_id = t.id) AS cnt
                FROM tag t WHERE t.id = ?
                """, MAPPER, id);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public Optional<TagRow> findByName(String name) {
        List<TagRow> rows = jdbc.query("""
                SELECT t.id, t.name, t.color,
                       (SELECT COUNT(*) FROM asset_tag it WHERE it.tag_id = t.id) AS cnt
                FROM tag t WHERE %s
                """.formatted(dialect.caseInsensitiveEquals("t.name")), MAPPER, name);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public long insert(String name, String color) {
        KeyHolder kh = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(
                    "INSERT INTO tag (name, color, created_at) VALUES (?, ?, ?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, name);
            ps.setString(2, color);
            ps.setString(3, Instant.now().toString());
            return ps;
        }, kh);
        Number key = kh.getKey();
        return key == null ? -1 : key.longValue();
    }

    public void update(long id, String name, String color) {
        jdbc.update("UPDATE tag SET name = ?, color = ? WHERE id = ?", name, color, id);
    }

    public void delete(long id) {
        jdbc.update("DELETE FROM tag WHERE id = ?", id);
    }

    // ------------------------------------------------------------------ 关联

    /** 图片 → 标签，按图片 id 分组。用于列表页一次性把标签查出来，避免 N+1。 */
    public Map<Long, List<TagRow>> tagsForAssets(Collection<Long> assetIds) {
        Map<Long, List<TagRow>> result = new HashMap<>();
        if (assetIds == null || assetIds.isEmpty()) {
            return result;
        }
        String placeholders = String.join(",", java.util.Collections.nCopies(assetIds.size(), "?"));
        jdbc.query("""
                SELECT it.asset_id, t.id, t.name, t.color, 0 AS cnt
                FROM asset_tag it JOIN tag t ON t.id = it.tag_id
                WHERE it.asset_id IN (%s)
                ORDER BY %s
                """.formatted(placeholders, dialect.nameOrder("t.name", true)),
                rs -> {
                    long assetId = rs.getLong("asset_id");
                    result.computeIfAbsent(assetId, k -> new ArrayList<>())
                          .add(new TagRow(rs.getLong("id"), rs.getString("name"), rs.getString("color"), 0));
                },
                assetIds.toArray());
        return result;
    }

    /** 覆盖式设置某张图片的标签集合 */
    public void setAssetTags(long assetId, List<Long> tagIds) {
        jdbc.update("DELETE FROM asset_tag WHERE asset_id = ?", assetId);
        if (tagIds == null || tagIds.isEmpty()) {
            return;
        }
        // 去重，避免主键冲突
        List<Long> unique = tagIds.stream().distinct().toList();
        jdbc.batchUpdate(dialect.insertAssetTagIgnoreSql(),
                unique, unique.size(),
                (ps, tagId) -> {
                    ps.setLong(1, assetId);
                    ps.setLong(2, tagId);
                });
    }
}
