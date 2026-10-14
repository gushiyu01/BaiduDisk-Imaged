-- PicMan 数据库结构（MySQL）。全部使用 IF NOT EXISTS，可重复执行。
--
-- 与 schema.sql（SQLite）语义一致，三处必要差异：
--   1. 索引列不能用 TEXT（MySQL 不允许无前缀长度的 TEXT 索引），改用 VARCHAR
--   2. 自增主键用 BIGINT AUTO_INCREMENT
--   3. 时间存 ISO-8601 字符串，用 VARCHAR(40) 而不是 DATETIME —— 代码里带纳秒和 Z 后缀

CREATE TABLE IF NOT EXISTS app_user (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    username      VARCHAR(64)  NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    created_at    VARCHAR(40)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_app_user_username (username)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_config (
    config_key VARCHAR(128) NOT NULL,
    config_val TEXT         NOT NULL,
    updated_at VARCHAR(40)  NOT NULL,
    PRIMARY KEY (config_key)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS file_asset (
    id           BIGINT       NOT NULL AUTO_INCREMENT,
    fs_id        VARCHAR(32)  NULL,
    -- 百度单个文件路径上限约 1000 字节；768 字符 × 4 字节 = 3072 字节，
    -- 正好是 InnoDB DYNAMIC 行格式的索引键上限，再长就无法建唯一索引
    path         VARCHAR(768) NOT NULL,
    name         VARCHAR(255) NOT NULL,
    size         BIGINT       NOT NULL DEFAULT 0,
    kind         VARCHAR(16)  NOT NULL DEFAULT 'OTHER',
    category     INT          NULL,
    width        INT          NULL,
    height       INT          NULL,
    mime         VARCHAR(100) NULL,
    md5          VARCHAR(64)  NULL,
    server_mtime VARCHAR(40)  NULL,
    favorite     TINYINT      NOT NULL DEFAULT 0,
    thumb_source VARCHAR(16)  NOT NULL DEFAULT 'UNKNOWN',
    missing      TINYINT      NOT NULL DEFAULT 0,
    indexed_at   VARCHAR(40)  NOT NULL,
    updated_at   VARCHAR(40)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_file_asset_path (path),
    KEY idx_file_asset_name (name),
    KEY idx_file_asset_kind (kind),
    KEY idx_file_asset_favorite (favorite),
    KEY idx_file_asset_mtime (server_mtime)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tag (
    id         BIGINT      NOT NULL AUTO_INCREMENT,
    name       VARCHAR(64) NOT NULL,
    color      VARCHAR(16) NOT NULL DEFAULT '#409EFF',
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_tag_name (name)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS asset_tag (
    asset_id BIGINT NOT NULL,
    tag_id   BIGINT NOT NULL,
    PRIMARY KEY (asset_id, tag_id),
    KEY idx_asset_tag_tag (tag_id),
    CONSTRAINT fk_asset_tag_asset FOREIGN KEY (asset_id) REFERENCES file_asset (id) ON DELETE CASCADE,
    CONSTRAINT fk_asset_tag_tag FOREIGN KEY (tag_id) REFERENCES tag (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
