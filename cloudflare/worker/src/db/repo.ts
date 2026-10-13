import type { AssetKind } from '../support/kinds'
import { extensionOf } from '../support/kinds'

export interface AssetRow {
  id: number
  fs_id: string | null
  path: string
  name: string
  size: number
  kind: string
  category: number | null
  width: number | null
  height: number | null
  mime: string | null
  md5: string | null
  server_mtime: string | null
  favorite: number
  thumb_source: string
  missing: number
  indexed_at: string
  updated_at: string
}

export interface TagRow {
  id: number
  name: string
  color: string
  cnt?: number
}

export interface AssetQuery {
  q?: string | null
  tagIds?: number[]
  favorite?: boolean
  kind?: AssetKind | null
  sort?: string
  page: number
  size: number
}

/** 排序白名单。绝不能把用户传的字符串直接拼进 ORDER BY。 */
function orderBy(sort: string | undefined): string {
  switch (sort) {
    case 'time_asc': return 'server_mtime ASC, id ASC'
    case 'name_asc': return 'name COLLATE NOCASE ASC'
    case 'name_desc': return 'name COLLATE NOCASE DESC'
    case 'size_desc': return 'size DESC, id DESC'
    case 'size_asc': return 'size ASC, id ASC'
    default: return 'server_mtime DESC, id DESC'
  }
}

function now(): string {
  return new Date().toISOString()
}

export class Repo {
  constructor(private readonly db: D1Database) {}

  // ------------------------------------------------------------------ 用户

  async userCount(): Promise<number> {
    const r = await this.db.prepare('SELECT COUNT(*) AS n FROM app_user').first<{ n: number }>()
    return r?.n ?? 0
  }

  async findUser(username: string): Promise<{ id: number; username: string; password_hash: string } | null> {
    return this.db
      .prepare('SELECT id, username, password_hash FROM app_user WHERE username = ?')
      .bind(username)
      .first()
  }

  async insertUser(username: string, passwordHash: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO app_user (username, password_hash, created_at) VALUES (?, ?, ?)')
      .bind(username, passwordHash, now())
      .run()
  }

  // ------------------------------------------------------------------ 配置

  async getConfig(key: string): Promise<string | null> {
    const r = await this.db
      .prepare('SELECT config_val FROM system_config WHERE config_key = ?')
      .bind(key)
      .first<{ config_val: string }>()
    return r?.config_val ?? null
  }

  async putConfig(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO system_config (config_key, config_val, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(config_key) DO UPDATE SET config_val = excluded.config_val, updated_at = excluded.updated_at`,
      )
      .bind(key, value, now())
      .run()
  }

  // ------------------------------------------------------------------ 文件检索

  private buildWhere(query: AssetQuery): { sql: string; args: unknown[] } {
    let sql = ' WHERE 1 = 1'
    const args: unknown[] = []

    if (query.q && query.q.trim()) {
      sql += ' AND (LOWER(name) LIKE ? OR LOWER(path) LIKE ?)'
      const like = `%${query.q.trim().toLowerCase()}%`
      args.push(like, like)
    }
    if (query.kind) {
      sql += ' AND kind = ?'
      args.push(query.kind)
    }
    if (query.favorite) {
      sql += ' AND favorite = 1'
    }
    if (query.tagIds && query.tagIds.length > 0) {
      const ph = query.tagIds.map(() => '?').join(',')
      sql += ` AND id IN (SELECT asset_id FROM asset_tag WHERE tag_id IN (${ph}))`
      args.push(...query.tagIds)
    }
    return { sql, args }
  }

  async search(query: AssetQuery): Promise<AssetRow[]> {
    const where = this.buildWhere(query)
    const offset = Math.max(0, (query.page - 1) * query.size)
    const r = await this.db
      .prepare(
        `SELECT * FROM file_asset${where.sql} ORDER BY ${orderBy(query.sort)} LIMIT ? OFFSET ?`,
      )
      .bind(...where.args, query.size, offset)
      .all<AssetRow>()
    return r.results ?? []
  }

  async countSearch(query: AssetQuery): Promise<number> {
    const where = this.buildWhere(query)
    const r = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM file_asset${where.sql}`)
      .bind(...where.args)
      .first<{ n: number }>()
    return r?.n ?? 0
  }

  async countsByKind(): Promise<Record<string, number>> {
    const r = await this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM file_asset WHERE missing = 0 GROUP BY kind')
      .all<{ kind: string; n: number }>()
    const out: Record<string, number> = {}
    for (const row of r.results ?? []) out[row.kind] = row.n
    return out
  }

  async countAssets(): Promise<number> {
    const r = await this.db
      .prepare('SELECT COUNT(*) AS n FROM file_asset WHERE missing = 0')
      .first<{ n: number }>()
    return r?.n ?? 0
  }

  async findById(id: number): Promise<AssetRow | null> {
    return this.db.prepare('SELECT * FROM file_asset WHERE id = ?').bind(id).first<AssetRow>()
  }

  async findByPath(path: string): Promise<AssetRow | null> {
    return this.db.prepare('SELECT * FROM file_asset WHERE path = ?').bind(path).first<AssetRow>()
  }

  // ------------------------------------------------------------------ 文件写入

  /**
   * 按 path 幂等写入。已存在时只更新网盘侧字段，
   * favorite / 标签这些本地数据必须保留。
   * 宽高用 COALESCE 保留旧值：百度经常不返回尺寸，不能因为这次查不到就抹掉已探测到的值。
   */
  async upsertAsset(a: {
    fsId: string | null
    path: string
    name: string
    size: number
    kind: string
    category: number | null
    width: number | null
    height: number | null
    mime: string
    md5: string | null
    serverMtime: string | null
    thumbSource: string
  }): Promise<void> {
    const ts = now()
    await this.db
      .prepare(
        `INSERT INTO file_asset
           (fs_id, path, name, size, kind, category, width, height, mime, md5, server_mtime,
            favorite, thumb_source, missing, indexed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           fs_id = excluded.fs_id,
           name = excluded.name,
           size = excluded.size,
           kind = excluded.kind,
           category = excluded.category,
           width = COALESCE(excluded.width, file_asset.width),
           height = COALESCE(excluded.height, file_asset.height),
           mime = excluded.mime,
           md5 = excluded.md5,
           server_mtime = excluded.server_mtime,
           thumb_source = excluded.thumb_source,
           missing = 0,
           updated_at = excluded.updated_at`,
      )
      .bind(
        a.fsId, a.path, a.name, a.size, a.kind, a.category, a.width, a.height, a.mime, a.md5,
        a.serverMtime, a.thumbSource, ts, ts,
      )
      .run()
  }

  async updateFsIdAndPath(id: number, fsId: string | null, path: string, name: string): Promise<void> {
    await this.db
      .prepare('UPDATE file_asset SET fs_id = ?, path = ?, name = ?, updated_at = ? WHERE id = ?')
      .bind(fsId, path, name, now(), id)
      .run()
  }

  /** 改名可能换掉扩展名，等于换了文件类型，kind 和 mime 要跟着重算 */
  async updateKindAndMime(id: number, kind: string, mime: string): Promise<void> {
    await this.db
      .prepare('UPDATE file_asset SET kind = ?, mime = ?, updated_at = ? WHERE id = ?')
      .bind(kind, mime, now(), id)
      .run()
  }

  async updateThumbSource(id: number, source: string): Promise<void> {
    await this.db
      .prepare('UPDATE file_asset SET thumb_source = ?, updated_at = ? WHERE id = ?')
      .bind(source, now(), id)
      .run()
  }

  async updateDimensions(id: number, width: number, height: number): Promise<void> {
    if (!width || !height || width <= 0 || height <= 0) return
    await this.db
      .prepare('UPDATE file_asset SET width = ?, height = ?, updated_at = ? WHERE id = ?')
      .bind(width, height, now(), id)
      .run()
  }

  async setFavorite(id: number, favorite: boolean): Promise<void> {
    await this.db
      .prepare('UPDATE file_asset SET favorite = ?, updated_at = ? WHERE id = ?')
      .bind(favorite ? 1 : 0, now(), id)
      .run()
  }

  async setMissing(id: number, missing: boolean): Promise<void> {
    await this.db
      .prepare('UPDATE file_asset SET missing = ?, updated_at = ? WHERE id = ?')
      .bind(missing ? 1 : 0, now(), id)
      .run()
  }

  async deleteById(id: number): Promise<void> {
    await this.db.prepare('DELETE FROM file_asset WHERE id = ?').bind(id).run()
  }

  /**
   * 某个网盘目录下已有的全部路径，同步时用来算「已经不在网盘上的」。
   * LIKE 的转义：SQLite 没有默认转义符，必须显式 ESCAPE。
   */
  async findPathsUnder(baseDir: string): Promise<string[]> {
    const prefix = `${baseDir.endsWith('/') ? baseDir : `${baseDir}/`}%`
    const r = await this.db
      .prepare("SELECT path FROM file_asset WHERE path LIKE ? ESCAPE '\\'")
      .bind(prefix)
      .all<{ path: string }>()
    return (r.results ?? []).map((x) => x.path)
  }

  /** 批量标记「网盘上已经不在了」，分批以免 SQL 过长 */
  async setMissingByPaths(paths: string[], missing: boolean): Promise<void> {
    const BATCH = 50
    for (let i = 0; i < paths.length; i += BATCH) {
      const batch = paths.slice(i, i + BATCH)
      const ph = batch.map(() => '?').join(',')
      await this.db
        .prepare(`UPDATE file_asset SET missing = ?, updated_at = ? WHERE path IN (${ph})`)
        .bind(missing ? 1 : 0, now(), ...batch)
        .run()
    }
  }

  // ------------------------------------------------------------------ 标签

  async listTags(): Promise<TagRow[]> {
    const r = await this.db
      .prepare(
        `SELECT t.id, t.name, t.color, COUNT(at.asset_id) AS cnt
         FROM tag t LEFT JOIN asset_tag at ON at.tag_id = t.id
         GROUP BY t.id, t.name, t.color
         ORDER BY t.name COLLATE NOCASE`,
      )
      .all<TagRow>()
    return r.results ?? []
  }

  async findTagById(id: number): Promise<TagRow | null> {
    return this.db
      .prepare(
        `SELECT t.id, t.name, t.color,
                (SELECT COUNT(*) FROM asset_tag at WHERE at.tag_id = t.id) AS cnt
         FROM tag t WHERE t.id = ?`,
      )
      .bind(id)
      .first<TagRow>()
  }

  async findTagByName(name: string): Promise<TagRow | null> {
    return this.db
      .prepare(
        `SELECT t.id, t.name, t.color,
                (SELECT COUNT(*) FROM asset_tag at WHERE at.tag_id = t.id) AS cnt
         FROM tag t WHERE t.name = ? COLLATE NOCASE`,
      )
      .bind(name)
      .first<TagRow>()
  }

  async insertTag(name: string, color: string): Promise<number> {
    const r = await this.db
      .prepare('INSERT INTO tag (name, color, created_at) VALUES (?, ?, ?)')
      .bind(name, color, now())
      .run()
    return Number(r.meta.last_row_id ?? 0)
  }

  async updateTag(id: number, name: string, color: string): Promise<void> {
    await this.db.prepare('UPDATE tag SET name = ?, color = ? WHERE id = ?').bind(name, color, id).run()
  }

  async deleteTag(id: number): Promise<void> {
    await this.db.prepare('DELETE FROM tag WHERE id = ?').bind(id).run()
  }

  /** 一次性把一批文件的标签查出来，避免 N+1 */
  async tagsForAssets(assetIds: number[]): Promise<Record<number, TagRow[]>> {
    const out: Record<number, TagRow[]> = {}
    if (assetIds.length === 0) return out
    const ph = assetIds.map(() => '?').join(',')
    const r = await this.db
      .prepare(
        `SELECT at.asset_id, t.id, t.name, t.color
         FROM asset_tag at JOIN tag t ON t.id = at.tag_id
         WHERE at.asset_id IN (${ph})
         ORDER BY t.name COLLATE NOCASE`,
      )
      .bind(...assetIds)
      .all<TagRow & { asset_id: number }>()
    for (const row of r.results ?? []) {
      ;(out[row.asset_id] ??= []).push({ id: row.id, name: row.name, color: row.color })
    }
    return out
  }

  /** 覆盖式设置某个文件的标签集合 */
  async setAssetTags(assetId: number, tagIds: number[]): Promise<void> {
    await this.db.prepare('DELETE FROM asset_tag WHERE asset_id = ?').bind(assetId).run()
    const unique = [...new Set(tagIds)]
    if (unique.length === 0) return
    await this.db.batch(
      unique.map((tagId) =>
        this.db
          .prepare('INSERT OR IGNORE INTO asset_tag (asset_id, tag_id) VALUES (?, ?)')
          .bind(assetId, tagId),
      ),
    )
  }
}

export function assetExt(name: string): string {
  return extensionOf(name)
}
