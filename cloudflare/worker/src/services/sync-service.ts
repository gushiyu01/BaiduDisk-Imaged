import type { Env, } from '../env'
import { baseDir } from '../env'
import type { Repo } from '../db/repo'
import type { BaiduPanClient } from '../baidu/client'
import type { FileMeta, FsEntry } from '../baidu/dto'
import { entryName } from '../baidu/dto'
import { BaiduPanException } from '../support/errors'
import { kindOf } from '../support/kinds'
import { mimeFromFilename } from '../support/mime'
import { extensionOf } from '../support/kinds'

/** filemetas 单次上限 100 */
const META_BATCH = 100

export interface SyncResult {
  scanned: number
  added: number
  updated: number
  removed: number
  failed: number
  elapsedMs: number
}

/**
 * 把网盘目录下的所有文件同步进本地索引。
 * 只做「网盘 → 索引」这一个方向；收藏和标签是纯本地数据，同步过程绝不覆盖。
 */
export async function sync(
  env: Env,
  repo: Repo,
  baidu: BaiduPanClient,
  dirOverride?: string | null,
): Promise<SyncResult> {
  const started = Date.now()
  const dir = dirOverride?.trim() ? dirOverride.trim() : baseDir(env)

  // 目录不存在时先建出来，否则第一次同步必然报 -9
  await baidu.mkdir(dir)

  const all = await baidu.listRecursive(dir)
  const files = all.filter((e) => e.isdir !== 1)

  // 宽高和缩略图只有 filemetas 给，按批补齐
  const metaByPath = new Map<string, FileMeta>()
  let failed = 0
  const fsIds = files.map((f) => f.fs_id).filter((id): id is number => typeof id === 'number')
  for (let i = 0; i < fsIds.length; i += META_BATCH) {
    const batch = fsIds.slice(i, i + META_BATCH)
    try {
      for (const meta of await baidu.fileMetas(batch, { thumb: true, extra: true })) {
        if (meta.path) metaByPath.set(meta.path, meta)
      }
    } catch (err) {
      // 单批失败不中断整体同步，但要如实计入 failed
      failed += batch.length
      if (!(err instanceof BaiduPanException)) throw err
    }
  }

  const existing = new Set(await repo.findPathsUnder(dir))
  const remotePaths = new Set<string>()
  let added = 0
  let updated = 0

  for (const entry of files) {
    remotePaths.add(entry.path)
    if (existing.has(entry.path)) updated++
    else added++
  }

  // 逐条写入。D1 的 batch 有语句数上限，按 50 一批提交
  const WRITE_BATCH = 50
  for (let i = 0; i < files.length; i += WRITE_BATCH) {
    await upsertEntries(repo, files.slice(i, i + WRITE_BATCH), metaByPath)
  }

  // 索引里有、网盘上没有的，标记为已丢失而不是直接删记录
  const gone = [...existing].filter((p) => !remotePaths.has(p))
  if (gone.length > 0) {
    await repo.setMissingByPaths(gone, true)
  }

  return {
    scanned: files.length,
    added,
    updated,
    removed: gone.length,
    failed,
    elapsedMs: Date.now() - started,
  }
}

async function upsertEntries(
  repo: Repo,
  entries: FsEntry[],
  metaByPath: Map<string, FileMeta>,
): Promise<void> {
  for (const entry of entries) {
    const meta = metaByPath.get(entry.path)
    const name = entryName(entry)
    const category = meta?.category ?? entry.category ?? null
    await repo.upsertAsset({
      fsId: entry.fs_id === undefined ? null : String(entry.fs_id),
      path: entry.path,
      name,
      size: entry.size ?? 0,
      kind: kindOf(category, name),
      category,
      width: meta?.width ?? entry.width ?? null,
      height: meta?.height ?? entry.height ?? null,
      mime: mimeFromFilename(name, extensionOf(name)),
      md5: entry.md5 ?? null,
      serverMtime: entry.server_mtime ? new Date(entry.server_mtime * 1000).toISOString() : null,
      thumbSource: meta && meta.thumbs && Object.keys(meta.thumbs).length > 0 ? 'BAIDU' : 'UNKNOWN',
    })
  }
}
