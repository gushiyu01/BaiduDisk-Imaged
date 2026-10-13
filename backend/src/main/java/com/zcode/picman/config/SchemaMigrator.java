package com.zcode.picman.config;

import com.zcode.picman.support.DbDialect;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.sql.init.SqlDataSourceScriptDatabaseInitializer;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/**
 * 老库升级：image_asset → file_asset。
 * <p>
 * 引入「文件库」之前，索引表只存图片且叫 image_asset。现在它是所有网盘文件的索引，
 * 多了 kind / category 两列，关联表也从 image_tag 改名为 asset_tag。
 * <p>
 * 三条硬性要求：
 * <ul>
 *   <li><b>不删数据</b>：旧表只改名为 {@code xxx_migrated_时间戳}，确认无误后由使用者自己清理。</li>
 *   <li><b>可重复执行</b>：中途失败重跑不会重复插入，靠「file_asset 已有数据就跳过复制」实现。</li>
 *   <li><b>旧表名必须写死</b>：这是迁移逻辑，找的就是历史名字。写成常量而不是内联字符串，
 *       免得日后整体重命名时被一起改掉 —— 那会让迁移退化成「把自己的新空表归档掉」的空操作，
 *       而且编译器不会报错。</li>
 * </ul>
 *
 * <p>构造函数里注入 {@link SqlDataSourceScriptDatabaseInitializer} 不是为了用它，
 * 而是强制 Spring 先把 schema.sql 跑完再建这个 Bean —— 否则可能在建表之前就来查表存不存在。
 */
@Component
public class SchemaMigrator {

    private static final Logger log = LoggerFactory.getLogger(SchemaMigrator.class);
    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

    /** 历史表名，升级逻辑的依据，不要跟着新命名一起改 */
    private static final String LEGACY_ASSET_TABLE = "image_asset";
    private static final String LEGACY_LINK_TABLE = "image_tag";

    /** 新表名 */
    private static final String ASSET_TABLE = "file_asset";
    private static final String LINK_TABLE = "asset_tag";

    private final JdbcTemplate jdbc;
    private final DbDialect dialect;

    public SchemaMigrator(JdbcTemplate jdbc, DbDialect dialect,
                          SqlDataSourceScriptDatabaseInitializer schemaInitializer) {
        this.jdbc = jdbc;
        this.dialect = dialect;
    }

    @PostConstruct
    public void migrate() {
        if (!tableExists(LEGACY_ASSET_TABLE)) {
            return;
        }

        log.warn("检测到旧版 {} 表，正在升级为 {}（文件库）…", LEGACY_ASSET_TABLE, ASSET_TABLE);
        long legacyRows = count(LEGACY_ASSET_TABLE);
        long newRows = count(ASSET_TABLE);

        if (newRows == 0) {
            copyAssets(legacyRows);
            copyTags();
        } else {
            // 上次跑到一半就挂了：数据已经在 file_asset 里，不要再插一遍
            log.warn("{} 已有 {} 条记录，跳过数据复制，只做旧表归档", ASSET_TABLE, newRows);
        }

        // 先归档关联表再归档主表：关联表有指向主表的外键，
        // 顺序反了在开启外键约束的库上会直接失败
        archiveOldTable(LEGACY_LINK_TABLE);
        archiveOldTable(LEGACY_ASSET_TABLE);

        log.warn("升级完成：迁移 {} 条索引记录。旧表已改名为 *_migrated_*，确认数据无误后可自行删除。",
                legacyRows);
    }

    // ------------------------------------------------------------------ 复制

    private void copyAssets(long legacyRows) {
        int inserted = jdbc.update("""
                INSERT INTO %s
                    (id, fs_id, path, name, size, kind, category, width, height, mime, md5,
                     server_mtime, favorite, thumb_source, missing, indexed_at, updated_at)
                SELECT id, fs_id, path, name, size, 'IMAGE', 3, width, height, mime, md5,
                       server_mtime, favorite, thumb_source, missing, indexed_at, updated_at
                FROM %s
                """.formatted(ASSET_TABLE, LEGACY_ASSET_TABLE));
        log.info("已复制索引 {} / {} 条到 {}（旧表里可能有目录等非图片条目，会被跳过）",
                inserted, legacyRows, ASSET_TABLE);
    }

    private void copyTags() {
        if (!tableExists(LEGACY_LINK_TABLE)) {
            return;
        }
        int inserted = jdbc.update("""
                INSERT INTO %s (asset_id, tag_id)
                SELECT image_id, tag_id FROM %s
                """.formatted(LINK_TABLE, LEGACY_LINK_TABLE));
        log.info("已复制标签关联 {} 条到 {}", inserted, LINK_TABLE);
    }

    // ------------------------------------------------------------------ 归档旧表

    private void archiveOldTable(String table) {
        if (!tableExists(table)) {
            return;
        }
        String archived = "%s_migrated_%s".formatted(table, LocalDateTime.now().format(STAMP));
        jdbc.execute("ALTER TABLE %s RENAME TO %s".formatted(table, archived));
        log.warn("旧表 {} 已归档为 {}", table, archived);
    }

    // ------------------------------------------------------------------ 工具

    private boolean tableExists(String table) {
        String sql = dialect.isMySql()
                ? "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?"
                : "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?";
        Integer n = jdbc.queryForObject(sql, Integer.class, table);
        return n != null && n > 0;
    }

    private long count(String table) {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class);
        return n == null ? 0 : n;
    }
}
