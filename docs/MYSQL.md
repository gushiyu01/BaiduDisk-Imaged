# 从 SQLite 迁移到 MySQL

项目默认用 SQLite（零运维、单文件、够个人用）。如果你要把数据放到已有的 MySQL 上，
这里是从「代码改动」到「数据搬迁」的完整说明。

**结论先说：这不是换一个建表脚本就能解决的事。** 数据访问层里有 6 处 SQLite 专有语法，
MySQL 直接执行会报语法错误，所以代码本身也做了改造。

---

## 一、怎么切过去

### Docker Compose

```bash
# .env 里加上
PICMAN_DB_MODE=mysql
PICMAN_MYSQL_HOST=mysql          # 用 compose 内置的 mysql 服务时就是这个值
PICMAN_MYSQL_PORT=3306
PICMAN_MYSQL_DB=picman
PICMAN_MYSQL_USER=picman
PICMAN_MYSQL_PASSWORD=换成你自己的强密码
```

```bash
docker compose --profile mysql up -d --build
```

### 手动部署

```bash
SPRING_PROFILES_ACTIVE=mysql \
PICMAN_MYSQL_HOST=127.0.0.1 PICMAN_MYSQL_PORT=3306 \
PICMAN_MYSQL_DB=picman PICMAN_MYSQL_USER=root PICMAN_MYSQL_PASSWORD=你的密码 \
java -jar picman.jar
```

或直接传启动参数：`java -jar picman.jar --spring.profiles.active=mysql`。

建表是自动的：`schema-mysql.sql` 每次启动都会执行，全部是 `CREATE TABLE IF NOT EXISTS`，可重复跑。

### 目标库要求

- MySQL 5.7 / 8.0 均可，字符集 **必须 utf8mb4**（标签和文件名会有中文与 emoji）
- 库要么预先建好（`CREATE DATABASE picman DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci`），
  要么给应用账号建库权限
- 不需要 `ONLY_FULL_GROUP_BY` 特殊设置，SQL 是按默认严格模式写的

---

## 二、代码改了哪 6 处

都集中在 [`DbDialect`](../backend/src/main/java/com/zcode/picman/support/DbDialect.java)，
仓储层只调用方法，不再出现任何方言关键字。

| 位置 | SQLite | MySQL | 为什么必须分叉 |
| --- | --- | --- | --- |
| 写系统配置 | `ON CONFLICT(k) DO UPDATE SET v=excluded.v` | `ON DUPLICATE KEY UPDATE v=VALUES(v)` | UPSERT 语法完全不同 |
| 写图片索引 | 同上，`excluded.x` / `COALESCE(excluded.x, 表.x)` | `VALUES(x)` / `COALESCE(VALUES(x), x)` | 同上 |
| 写标签关联 | `INSERT OR IGNORE INTO` | `INSERT IGNORE INTO` | 忽略冲突的写法不同 |
| 按名称排序 | `ORDER BY name COLLATE NOCASE` | `ORDER BY name` | MySQL 的 utf8mb4_unicode_ci 本身就不区分大小写，**再写 COLLATE NOCASE 是语法错误** |
| 标签按名查重 | `WHERE name = ? COLLATE NOCASE` | `WHERE name = ?` | 同上 |
| 路径前缀匹配 | `WHERE path LIKE ? ESCAPE '\'` | `WHERE path LIKE ?` | SQLite 没有默认转义符必须显式声明；MySQL 反斜杠本身就是转义符，再声明会导致转义被二次解释 |

方言在启动时通过 JDBC 连接的 URL 自动识别，不需要配置项。

---

## 三、建表语句的必要差异

`schema-mysql.sql` 与 `schema.sql` 语义一致，但有三处**不能照搬**：

| 差异 | SQLite | MySQL | 说明 |
| --- | --- | --- | --- |
| 索引列类型 | `TEXT` | `VARCHAR` | MySQL 不允许在无前缀长度的 `TEXT` 列上建索引/唯一约束，会直接报 `BLOB/TEXT column used in key specification without a key length` |
| 主键 | `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT AUTO_INCREMENT PRIMARY KEY` | |
| 布尔位 | `INTEGER` | `TINYINT` | |
| 时间字段 | `TEXT` | `VARCHAR(40)` | 应用存的是 ISO-8601 字符串，带纳秒和 `Z` 后缀，`DATETIME` 装不下 |

**`file_asset.path` 用 `VARCHAR(768)`**：768 字符 × 4 字节 = 3072 字节，正好是 InnoDB
DYNAMIC 行格式的单列索引键上限。百度路径上限约 1000 字节，正常够用；
如果你确认要有更长的路径，得改成哈希列 + 唯一索引，而不能再加大这个字段。

---

## 四、数据搬迁

**标签和收藏是纯本地数据，网盘上没有对应物，重新同步索引搬不过来**，必须复制表。

### 方案 A：不在乎历史标签收藏 → 最省事

```bash
# 直接用 mysql 配置档启动，然后到「百度网盘」页点「同步索引」
```
索引会从网盘重建。收藏和标签会丢失。

### 方案 B：完整搬迁（推荐）

```bash
java -cp "<sqlite-jdbc.jar><分隔符><mysql-connector-j.jar>" \
     tools/MigrateSqliteToMysql.java \
     <sqlite.db 路径> <mysql JDBC URL> [用户名] [密码] [--force]
```

Windows 下 classpath 分隔符是 `;`，Linux/macOS 是 `:`。实际例子：

```bash
java -cp "d:/repository/org/xerial/sqlite-jdbc/3.46.1.3/sqlite-jdbc-3.46.1.3.jar;d:/repository/com/mysql/mysql-connector-j/8.3.0/mysql-connector-j-8.3.0.jar" \
     tools/MigrateSqliteToMysql.java \
     ./backend/data/picman.db \
     "jdbc:mysql://127.0.0.1:3306/picman?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai" \
     root 你的密码
```

工具会做这些事：

- 先检查目标库有没有建表，没建就提示你怎么办，不会抛一个看不懂的 SQL 异常
- **拒绝写入非空的目标库**，确认要覆盖才加 `--force`（会先 TRUNCATE 业务表）
- 原样保留自增 `id`（否则 `asset_tag` 的外键会全部错位）
- 连 `system_config` 一起搬，所以**百度授权令牌和会话签名密钥都还在，不用重新授权**
- 搬完做行数校验，不一致会以非零退出码结束

迁移完成后缩略图缓存可以直接删掉，会按需重新生成（不会重新上传网盘）。
旧缓存文件名带 image id 和文件 md5，所以即使不删也不会串图。

---

## 五、实测结论（2026-10-13）

在 **MySQL 8.0.30**（默认 `ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES` 严格模式）上逐项跑过：

| 项 | 结果 |
| --- | --- |
| `schema-mysql.sql` 建表（含全部索引与外键） | ✅ 可重复执行 |
| 首次启动自动建表 + 写会话密钥（UPSERT） | ✅ |
| 首次启动设置管理员 / 登录 | ✅ |
| 上传（`ON DUPLICATE KEY UPDATE`）/ 同名自动编号 | ✅ |
| 标签增删改、重复打标签（`INSERT IGNORE` 幂等） | ✅ |
| 标签大小写不敏感查重（`Sunset` 后建 `sunset` → 409） | ✅ |
| 按名称排序（方言 `nameOrder`，不带 COLLATE） | ✅ |
| 收藏、按标签/收藏筛选、`GROUP BY` 计数 | ✅ |
| 重命名（`fs_id` 不变、标签与收藏保留） | ✅ |
| 同步索引（`LIKE` 前缀匹配 + 全量 UPSERT） | ✅ |
| 三种删除模式 | ✅ |
| 缩略图（官方图）/ 原图（md5 逐字节一致）/ Range 206 | ✅ |
| 百度深度体检 8 项（上传→缩略图→下载→重命名→删除） | ✅ |
| 迁移工具：SQLite → MySQL 行数校验 | ✅ |
| 迁移后用 MySQL 启动：管理员密码可登录、令牌仍有效、图片与缩略图正常 | ✅ |

**没测到的**：MySQL 5.7（只测了 8.0.30）、`NO_BACKSLASH_ESCAPES` 模式下 `LIKE` 转义行为、
高并发写入、以及从 MySQL 迁回 SQLite。

---

## 六、SQLite 与 MySQL 的行为差异

不是 bug，但迁移后可能察觉到：

| 行为 | SQLite | MySQL |
| --- | --- | --- |
| `path = ?` 比较 | 区分大小写 | **不区分**（utf8mb4_unicode_ci） |
| `LIKE` 比较 | 仅 ASCII 不区分大小写 | 不区分大小写（中文也按排序规则） |
| 并发写 | 单写者，靠 `busy_timeout` 排队 | 真正的并发写 |
| 超出列长度 | 不限制 | 严格模式下**报错**而不是截断 |

最后一条值得注意：如果历史数据里有超过 768 字的路径，迁移时会在 MySQL 侧报错。
工具会带着具体的 SQL 异常退出，不会静默丢数据。

---

## 七、想迁回 SQLite？

没有现成工具。`schema.sql` 一直保留着，可以照方案 B 的思路反向写一个——
两边列名完全一致，把 `source`/`target` 对调、UPsert 换成 SQLite 语法即可。
