package com.zcode.picman.support;

import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.SQLException;

/**
 * 数据库方言。
 * <p>
 * SQLite 与 MySQL 的差异不止建表语句，数据访问层里也有几处不兼容的写法，
 * 全部收在这个类里，仓库层只调用方法拿 SQL 片段，不再写死任何方言关键字：
 * <ul>
 *   <li>UPSERT：SQLite 是 {@code ON CONFLICT ... DO UPDATE SET x = excluded.x}，
 *       MySQL 是 {@code ON DUPLICATE KEY UPDATE x = VALUES(x)}</li>
 *   <li>插入忽略冲突：SQLite 是 {@code INSERT OR IGNORE}，MySQL 是 {@code INSERT IGNORE}</li>
 *   <li>大小写不敏感排序：SQLite 要显式 {@code COLLATE NOCASE}，
 *       MySQL 的 utf8mb4_unicode_ci 默认就不区分大小写，加 COLLATE NOCASE 反而是语法错误</li>
 *   <li>LIKE 转义：SQLite 没有默认转义符，必须写 {@code ESCAPE '\'}；
 *       MySQL 的反斜杠本身就是默认转义符，再写 ESCAPE 会导致转义符被二次解释</li>
 * </ul>
 */
@Component
public class DbDialect {

    public enum Kind {
        SQLITE, MYSQL
    }

    private final Kind kind;

    public DbDialect(DataSource dataSource) {
        this.kind = detect(dataSource);
    }

    private static Kind detect(DataSource dataSource) {
        try (Connection connection = dataSource.getConnection()) {
            String url = connection.getMetaData().getURL();
            return url != null && url.startsWith("jdbc:mysql") ? Kind.MYSQL : Kind.SQLITE;
        } catch (SQLException e) {
            throw new IllegalStateException("无法识别数据库类型：" + e.getMessage(), e);
        }
    }

    public Kind kind() {
        return kind;
    }

    public boolean isMySql() {
        return kind == Kind.MYSQL;
    }

    // ------------------------------------------------------------------ UPSERT

    /** 写系统配置，按 config_key 覆盖 */
    public String upsertConfigSql() {
        return isMySql()
                ? """
                  INSERT INTO system_config (config_key, config_val, updated_at)
                  VALUES (?, ?, ?)
                  ON DUPLICATE KEY UPDATE config_val = VALUES(config_val),
                                          updated_at = VALUES(updated_at)
                  """
                : """
                  INSERT INTO system_config (config_key, config_val, updated_at)
                  VALUES (?, ?, ?)
                  ON CONFLICT(config_key) DO UPDATE SET config_val = excluded.config_val,
                                                        updated_at = excluded.updated_at
                  """;
    }

    /**
     * 按 path 幂等写入文件索引。
     * <p>
     * 宽高用 COALESCE 保留旧值：百度经常不返回尺寸，不能因为这次查不到就把已探测到的值抹掉。
     * MySQL 里 {@code VALUES(width)} 指「本次想插入的值」，裸 {@code width} 指「已存在的值」。
     */
    public String upsertAssetSql() {
        String conflictClause = isMySql()
                ? """
                  ON DUPLICATE KEY UPDATE
                      fs_id        = VALUES(fs_id),
                      name         = VALUES(name),
                      size         = VALUES(size),
                      kind         = VALUES(kind),
                      category     = VALUES(category),
                      width        = COALESCE(VALUES(width), width),
                      height       = COALESCE(VALUES(height), height),
                      mime         = VALUES(mime),
                      md5          = VALUES(md5),
                      server_mtime = VALUES(server_mtime),
                      thumb_source = VALUES(thumb_source),
                      missing      = 0,
                      updated_at   = VALUES(updated_at)
                  """
                : """
                  ON CONFLICT(path) DO UPDATE SET
                      fs_id        = excluded.fs_id,
                      name         = excluded.name,
                      size         = excluded.size,
                      kind         = excluded.kind,
                      category     = excluded.category,
                      width        = COALESCE(excluded.width, file_asset.width),
                      height       = COALESCE(excluded.height, file_asset.height),
                      mime         = excluded.mime,
                      md5          = excluded.md5,
                      server_mtime = excluded.server_mtime,
                      thumb_source = excluded.thumb_source,
                      missing      = 0,
                      updated_at   = excluded.updated_at
                  """;

        return """
               INSERT INTO file_asset
                   (fs_id, path, name, size, kind, category, width, height, mime, md5, server_mtime,
                    favorite, thumb_source, missing, indexed_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)
               """ + conflictClause;
    }

    // ------------------------------------------------------------------ 其他片段

    /** 插入标签关联，重复即忽略 */
    public String insertAssetTagIgnoreSql() {
        return isMySql()
                ? "INSERT IGNORE INTO asset_tag (asset_id, tag_id) VALUES (?, ?)"
                : "INSERT OR IGNORE INTO asset_tag (asset_id, tag_id) VALUES (?, ?)";
    }

    /** 按名称排序 */
    public String nameOrder(String column, boolean ascending) {
        String direction = ascending ? "ASC" : "DESC";
        return isMySql()
                ? "%s %s".formatted(column, direction)
                : "%s COLLATE NOCASE %s".formatted(column, direction);
    }

    /**
     * 标签名按大小写不敏感比较。
     * <p>
     * MySQL 的 utf8mb4_unicode_ci 天然不区分大小写，SQLite 需要显式 COLLATE NOCASE。
     */
    public String caseInsensitiveEquals(String column) {
        return isMySql() ? column + " = ?" : column + " = ? COLLATE NOCASE";
    }

    /** LIKE 前缀匹配。转义符处理见类注释。 */
    public String likeStartsWith(String column) {
        return isMySql() ? column + " LIKE ?" : column + " LIKE ? ESCAPE '\\'";
    }
}
