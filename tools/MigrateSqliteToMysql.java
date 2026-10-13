import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * 把 PicMan 的 SQLite 数据搬到 MySQL。
 *
 * <p>为什么需要它：标签和收藏是纯本地数据，网盘上没有对应物，
 * 光靠「新库 + 重新同步索引」是搬不过去的，必须真的复制表数据。
 *
 * <p>用法（Windows 用 ; 分隔 classpath）：
 * <pre>
 * java -cp "sqlite-jdbc.jar;mysql-connector-j.jar" tools/MigrateSqliteToMysql.java \
 *      &lt;sqlite.db&gt; &lt;mysql-url&gt; [user] [password] [--force]
 * </pre>
 *
 * <p>目标库必须先建好表（用 schema-mysql.sql，或先用 mysql 配置档启动一次应用）。
 * 默认拒绝写入非空的目标库，确认要覆盖时加 {@code --force}。
 *
 * <p>自增 id 会原样保留，否则 asset_tag 的外键会全部错位。
 * system_config 也一并搬过去，这样百度授权令牌和会话密钥都还在，不用重新授权。
 */
public class MigrateSqliteToMysql {

    private static final String[] BUSINESS_TABLES = {"asset_tag", "file_asset", "tag", "app_user", "system_config"};

    public static void main(String[] args) {
        List<String> positional = new ArrayList<>();
        boolean force = false;
        for (String a : args) {
            if ("--force".equals(a)) {
                force = true;
            } else {
                positional.add(a);
            }
        }
        if (positional.size() < 2) {
            System.err.println("""
                    用法: java -cp "<sqlite-jdbc.jar><分隔符><mysql-connector-j.jar>" tools/MigrateSqliteToMysql.java \\
                              <sqlite.db 路径> <mysql JDBC URL> [用户名] [密码] [--force]
                    例:   java -cp "d:/repository/org/xerial/sqlite-jdbc/3.46.1.3/sqlite-jdbc-3.46.1.3.jar;\\
                    d:/repository/com/mysql/mysql-connector-j/8.3.0/mysql-connector-j-8.3.0.jar" \\
                              tools/MigrateSqliteToMysql.java ./backend/data/picman.db \\
                              "jdbc:mysql://127.0.0.1:3306/picman?useUnicode=true&characterEncoding=utf8" root 你的密码
                    """);
            System.exit(2);
        }

        String sqlitePath = positional.get(0);
        String mysqlUrl = positional.get(1);
        String mysqlUser = positional.size() > 2 ? positional.get(2) : "root";
        String mysqlPassword = positional.size() > 3 ? positional.get(3) : "";

        try {
            Class.forName("org.sqlite.JDBC");
            Class.forName("com.mysql.cj.jdbc.Driver");
        } catch (ClassNotFoundException e) {
            die("缺少 JDBC 驱动：" + e.getMessage() + "（检查 classpath）");
            return;
        }

        try (Connection src = DriverManager.getConnection("jdbc:sqlite:" + sqlitePath);
             Connection dst = DriverManager.getConnection(mysqlUrl, mysqlUser, mysqlPassword)) {

            System.out.println("源   ：SQLite " + sqlitePath);
            System.out.println("目标 ：" + mysqlUrl);
            System.out.println();

            requireSchema(dst);
            guardNonEmpty(dst, force);

            Counts before = counts(src);
            System.out.println("源库数据：" + before);
            System.out.println();

            if (force) {
                System.out.println("--force 已指定，先清空目标表…");
                truncate(dst);
            }

            dst.setAutoCommit(false);
            try (Statement s = dst.createStatement()) {
                s.execute("SET FOREIGN_KEY_CHECKS = 0");
            }

            int users = copyUsers(src, dst);
            int config = copyConfig(src, dst);
            int tags = copyTags(src, dst);
            int images = copyImages(src, dst);
            int links = copyImageTags(src, dst);

            try (Statement s = dst.createStatement()) {
                s.execute("SET FOREIGN_KEY_CHECKS = 1");
            }
            dst.commit();
            dst.setAutoCommit(true);

            Counts after = counts(dst);
            System.out.println("已迁移：用户 " + users + "，配置 " + config + "，标签 " + tags
                    + "，图片 " + images + "，标签关联 " + links);
            System.out.println();
            System.out.println("目标库数据：" + after);

            verify(before, after);
            System.out.println();
            System.out.println("迁移完成。缓存目录可以清掉，缩略图会按需重新生成（不会重新上传网盘）。");

        } catch (Exception e) {
            die(e.getMessage());
            e.printStackTrace();
        }
    }

    // ------------------------------------------------------------------ 前置检查

    /** 目标库没有表时给出可执行的修复提示，而不是抛一个看不懂的 SQL 异常 */
    private static void requireSchema(Connection dst) throws Exception {
        for (String table : BUSINESS_TABLES) {
            try (ResultSet rs = dst.getMetaData().getTables(dst.getCatalog(), null, table, null)) {
                if (!rs.next()) {
                    die("目标库缺少表 `" + table + "`。请先用 schema-mysql.sql 建表，"
                            + "或先用 mysql 配置档启动一次应用让程序自动建表。");
                }
            }
        }
    }

    private static void guardNonEmpty(Connection dst, boolean force) throws Exception {
        if (force) {
            return;
        }
        long assets = scalar(dst, "SELECT COUNT(*) FROM file_asset");
        long users = scalar(dst, "SELECT COUNT(*) FROM app_user");
        if (assets > 0 || users > 0) {
            die("目标库已有数据（文件 %d 条，用户 %d 条）。确认要覆盖请加 --force。"
                    .formatted(assets, users));
        }
    }

    private static void truncate(Connection dst) throws Exception {
        try (Statement s = dst.createStatement()) {
            s.execute("SET FOREIGN_KEY_CHECKS = 0");
            for (String t : BUSINESS_TABLES) {
                s.execute("TRUNCATE TABLE " + t);
            }
            s.execute("SET FOREIGN_KEY_CHECKS = 1");
        }
    }

    // ------------------------------------------------------------------ 逐表复制

    private static int copyUsers(Connection src, Connection dst) throws Exception {
        return copy(src, dst,
                "SELECT id, username, password_hash, created_at FROM app_user ORDER BY id",
                "INSERT INTO app_user (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
                4);
    }

    private static int copyConfig(Connection src, Connection dst) throws Exception {
        return copy(src, dst,
                "SELECT config_key, config_val, updated_at FROM system_config ORDER BY config_key",
                "INSERT INTO system_config (config_key, config_val, updated_at) VALUES (?, ?, ?)",
                3);
    }

    private static int copyTags(Connection src, Connection dst) throws Exception {
        return copy(src, dst,
                "SELECT id, name, color, created_at FROM tag ORDER BY id",
                "INSERT INTO tag (id, name, color, created_at) VALUES (?, ?, ?, ?)",
                4);
    }

    private static int copyImages(Connection src, Connection dst) throws Exception {
        return copy(src, dst, """
                SELECT id, fs_id, path, name, size, kind, category, width, height, mime, md5,
                       server_mtime, favorite, thumb_source, missing, indexed_at, updated_at
                FROM file_asset ORDER BY id
                """, """
                INSERT INTO file_asset
                    (id, fs_id, path, name, size, kind, category, width, height, mime, md5,
                     server_mtime, favorite, thumb_source, missing, indexed_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, 17);
    }

    private static int copyImageTags(Connection src, Connection dst) throws Exception {
        return copy(src, dst,
                "SELECT asset_id, tag_id FROM asset_tag ORDER BY asset_id, tag_id",
                "INSERT INTO asset_tag (asset_id, tag_id) VALUES (?, ?)",
                2);
    }

    /** SQLite 和 MySQL 的列类型都能通过 getObject/setObject 原样传递，列数一致即可 */
    private static int copy(Connection src, Connection dst, String selectSql, String insertSql, int columns)
            throws Exception {
        int n = 0;
        try (Statement read = src.createStatement();
             ResultSet rs = read.executeQuery(selectSql);
             PreparedStatement write = dst.prepareStatement(insertSql)) {
            while (rs.next()) {
                for (int i = 1; i <= columns; i++) {
                    Object v = rs.getObject(i);
                    // SQLite 的 INTEGER 布尔位在 MySQL 里是 TINYINT，交给驱动自己转换
                    write.setObject(i, v);
                }
                write.addBatch();
                n++;
            }
            write.executeBatch();
        }
        return n;
    }

    // ------------------------------------------------------------------ 校验

    private record Counts(long users, long config, long tags, long images, long links) {
        @Override
        public String toString() {
            return "用户 %d，配置 %d，标签 %d，图片 %d，标签关联 %d"
                    .formatted(users, config, tags, images, links);
        }
    }

    private static Counts counts(Connection c) throws Exception {
        return new Counts(
                scalar(c, "SELECT COUNT(*) FROM app_user"),
                scalar(c, "SELECT COUNT(*) FROM system_config"),
                scalar(c, "SELECT COUNT(*) FROM tag"),
                scalar(c, "SELECT COUNT(*) FROM file_asset"),
                scalar(c, "SELECT COUNT(*) FROM asset_tag"));
    }

    private static void verify(Counts before, Counts after) {
        List<String> mismatches = new ArrayList<>();
        if (before.users() != after.users()) mismatches.add("用户");
        if (before.tags() != after.tags()) mismatches.add("标签");
        if (before.images() != after.images()) mismatches.add("图片");
        if (before.links() != after.links()) mismatches.add("标签关联");
        // system_config 会多出 jwt_secret 之类的运行时键，条数允许增加，只禁止减少
        if (after.config() < before.config()) mismatches.add("配置");

        if (mismatches.isEmpty()) {
            System.out.println("✔ 行数校验通过");
        } else {
            System.out.println("✘ 行数不一致：" + String.join("、", mismatches) + "（请检查上面的源/目标计数）");
            System.exit(1);
        }
    }

    private static long scalar(Connection c, String sql) throws Exception {
        try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
            return rs.next() ? rs.getLong(1) : -1;
        }
    }

    private static void die(String message) {
        System.err.println();
        System.err.println("[迁移失败] " + message);
        System.err.println("[时间] " + Instant.now());
        System.exit(1);
    }
}
