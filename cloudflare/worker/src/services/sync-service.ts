import type { Env } from '../env'
import { baseDir } from '../env'
import type { AssetUpsert, Repo } from '../db/repo'
import type { BaiduPanClient } from '../baidu/client'
import { LIST_MAX_ENTRIES } from '../baidu/client'
import type { FileMeta, FsEntry } from '../baidu/dto'
import { entryName } from '../baidu/dto'
import { ApiException, BaiduPanException } from '../support/errors'
import { extensionOf, kindOf } from '../support/kinds'
import { mimeFromFilename } from '../support/mime'

/** filemetas 单次上限 100 */
const META_BATCH = 100

/**
 * 每次调用最多写入多少个文件。
 *
 * Free 套餐每次 Worker 调用只有 50 次 D1 查询，而这笔预算还要和鉴权、扫描、
 * 缺失标记一起分（D1 调用同时计入每请求 50 个 subrequest 的额度）。
 * 这里保守取 30：宁可多跑几轮，也不能中途撞限额 —— 那样会留下写了一半的索引，
 * 而且报错后用户看到的是「同步失败」，剩下的文件一条都没进去。
 * 处理不完的部分由调用方带 offset 继续调用，见 SyncResult.nextOffset。
 *
 * 这个值是在「batch 里每条语句也算一次查询」的最坏口径下取的。若实测确认
 * batch 只计一次，可以放大它，协议不用改。
 */
const UPSERTS_PER_CALL = 30

export interface SyncResult {
  scanned: number
  added: number
  updated: number
  removed: number
  failed: number
  elapsedMs: number
  /** 本次调用实际写入索引的文件数 */
  processed: number
  /** 还有没处理完的文件时给出下一轮要传的 offset；全部处理完为 null */
  nextOffset: number | null
}

/**
 * 把网盘目录下的所有文件同步进本地索引。
 * 只做「网盘 → 索引」这一个方向；收藏和标签是纯本地数据，同步过程绝不覆盖。
 *
 * 一次调用只处理 UPSERTS_PER_CALL 个文件，返回 nextOffset 让调用方接着调 ——
 * 这是为了绕开 Free 套餐「每次 Worker 调用 50 次 D1 查询」的硬限制。
 */
export async function sync(
  env: Env,
  repo: Repo,
  baidu: BaiduPanClient,
  dirOverride?: string | null,
  offset = 0,
): Promise<SyncResult> {
  const started = Date.now()
  const dir = dirOverride?.trim() ? dirOverride.trim() : baseDir(env)

  // 目录不存在时先建出来，否则第一次同步必然报 -9
  await baidu.mkdir(dir)

  const scan = await baidu.listRecursive(dir)
  // 扫描不完整就绝不动「缺失标记」：它靠「本轮扫到的路径集合」判断谁已从网盘消失，
  // 拿一份残缺的集合去比对，等于把没扫到的文件全部标成已删除
  if (scan.truncated) {
    throw new ApiException(
      500,
      'SCAN_TOO_LARGE',
      `目录条目超过 ${LIST_MAX_ENTRIES} 条上限，这次扫描不完整，已中止同步以免把没扫到的文件误标为已删除`,
    )
  }
  const files = scan.entries.filter((e) => e.isdir !== 1)

  // 只处理本轮这一段。同一棵树的列表顺序是稳定的，所以按 offset 切片可以续接
  const start = Math.min(Math.max(0, offset), files.length)
  const slice = files.slice(start, start + UPSERTS_PER_CALL)
  const nextOffset = start + slice.length < files.length ? start + slice.length : null

  // 宽高和缩略图只有 filemetas 给，按批补齐；只查本轮要写的那些，省往返
  const metaByPath = new Map<string, FileMeta>()
  let failed = 0
  const fsIds = slice.map((f) => f.fs_id).filter((id): id is number => typeof id === 'number')
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
  let added = 0
  let updated = 0
  for (const entry of slice) {
    if (existing.has(entry.path)) updated++
    else added++
  }

  await repo.upsertAssets(slice.map((entry) => toUpsert(entry, metaByPath)))

  // 缺失标记只在最后一轮做：只有到那时，本轮扫描才确实覆盖了整棵树
  let removed = 0
  if (nextOffset === null) {
    const remotePaths = new Set(files.map((f) => f.path))
    const gone = [...existing].filter((p) => !remotePaths.has(p))
    if (gone.length > 0) await repo.setMissingByPaths(gone, true)
    removed = gone.length
  }

  return {
    scanned: files.length,
    added,
    updated,
    removed,
    failed,
    elapsedMs: Date.now() - started,
    processed: slice.length,
    nextOffset,
  }
}

function toUpsert(entry: FsEntry, metaByPath: Map<string, FileMeta>): AssetUpsert {
  const meta = metaByPath.get(entry.path)
  const name = entryName(entry)
  const category = meta?.category ?? entry.category ?? null
  return {
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
  }
}
