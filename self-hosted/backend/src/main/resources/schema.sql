-- PicMan 数据库结构（SQLite）。全部使用 IF NOT EXISTS，可重复执行。
--
-- file_asset 是「网盘上的一个文件」的索引，图片只是其中 kind='IMAGE' 的一种。
-- 早期版本这张表叫 image_asset 且只索引图片，升级由 SchemaMigrator 负责搬迁。

CREATE TABLE IF NOT EXISTS app_user (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS system_config (
    config_key TEXT PRIMARY KEY,
    config_val TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_asset (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fs_id        TEXT,
    path         TEXT    NOT NULL UNIQUE,
    name         TEXT    NOT NULL,
    size         INTEGER NOT NULL DEFAULT 0,
    -- 大类：IMAGE / VIDEO / AUDIO / DOC / OTHER，由百度 category 结合扩展名推导
    kind         TEXT    NOT NULL DEFAULT 'OTHER',
    -- 百度原始分类码：1 视频 / 2 音频 / 3 图片 / 4 文档 / 5 应用 / 6 其他 / 7 种子
    category     INTEGER,
    width        INTEGER,
    height       INTEGER,
    mime         TEXT,
    md5          TEXT,
    server_mtime TEXT,
    -- 以下为纯本地数据，同步时绝不覆盖
    favorite     INTEGER NOT NULL DEFAULT 0,
    thumb_source TEXT    NOT NULL DEFAULT 'UNKNOWN',
    -- 网盘文件已消失（被外部删除）时置 1，仅删索引不删此记录
    missing      INTEGER NOT NULL DEFAULT 0,
    indexed_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_asset_name     ON file_asset(name);
CREATE INDEX IF NOT EXISTS idx_file_asset_kind     ON file_asset(kind);
CREATE INDEX IF NOT EXISTS idx_file_asset_favorite ON file_asset(favorite);
CREATE INDEX IF NOT EXISTS idx_file_asset_mtime    ON file_asset(server_mtime);

CREATE TABLE IF NOT EXISTS tag (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT '#409EFF',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_tag (
    asset_id INTEGER NOT NULL REFERENCES file_asset(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    PRIMARY KEY (asset_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_asset_tag_tag ON asset_tag(tag_id);
