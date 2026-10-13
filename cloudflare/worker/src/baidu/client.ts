import type { Env } from '../env'
import { ERRNO } from '../support/errno'
import { BaiduPanException } from '../support/errors'
import { assertAllowedDlink } from './dlink-guard'
import {
  bestThumbUrl,
  type CreateResponse,
  type FileManagerResponse,
  type FileMeta,
  type FileMetasResponse,
  type FsEntry,
  type ListResponse,
  type PrecreateResponse,
  type QuotaResponse,
  type SliceResponse,
  type UinfoResponse,
} from './dto'
import { BaiduTokenStore } from './token-store'

const API_FILE = 'https://pan.baidu.com/rest/2.0/xpan/file'
const API_MULTIMEDIA = 'https://pan.baidu.com/rest/2.0/xpan/multimedia'
const API_NAS = 'https://pan.baidu.com/rest/2.0/xpan/nas'
const API_QUOTA = 'https://pan.baidu.com/api/quota'
/** 上传域名。官方要求通过「获取上传域名」接口动态取得，实测这个可以直接用 */
const UPLOAD_HOST = 'https://d.pcs.baidu.com'

/**
 * 固定使用这个 UA。百度对第三方应用的 dlink 和缩略图做防盗链，
 * UA 不含 pan.baidu.com 会直接 403（errno 31326）。
 */
const USER_AGENT = 'pan.baidu.com'

/** 普通用户分片固定 4MB；超过档位上限会报 31364 */
const SLICE_SIZE = 4 * 1024 * 1024
const METAS_BATCH = 100
const LIST_PAGE = 1000
/** 递归列目录的硬上限，防止异常数据导致无限翻页 */
const LIST_MAX_ENTRIES = 50_000

function check(errno: number, errmsg: string | undefined, action: string): void {
  if (errno !== ERRNO.OK) {
    throw BaiduPanException.of(errno, errmsg, action)
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) q.set(k, String(v))
  }
  return q.toString()
}

function withToken(url: string, token: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text()
  if (!text.trim()) {
    throw new BaiduPanException(ERRNO.NOT_FOUND, `${what} 返回空响应（HTTP ${res.status}）`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new BaiduPanException(ERRNO.NOT_FOUND, `${what} 返回非 JSON：${text.slice(0, 200)}`)
  }
}

export interface RemoteStream {
  status: number
  contentType: string | null
  contentLength: number
  contentRange: string | null
  body: ReadableStream<Uint8Array> | null
}

/**
 * 百度网盘开放平台的统一封装。业务层不应该出现任何 HTTP、URL 拼接或 errno 判断。
 */
export class BaiduPanClient {
  private readonly tokens: BaiduTokenStore

  constructor(env: Env) {
    this.tokens = new BaiduTokenStore(env)
  }

  get tokenStore(): BaiduTokenStore {
    return this.tokens
  }

  // ------------------------------------------------------------------ 账号

  async uinfo(): Promise<UinfoResponse> {
    return this.withAuthRetry(async (token) => {
      const r = await readJson<UinfoResponse>(
        await fetch(`${API_NAS}?${query({ method: 'uinfo', access_token: token })}`, {
          headers: { 'User-Agent': USER_AGENT },
        }),
        '查询账号信息',
      )
      check(r.errno, r.errmsg, '查询账号信息')
      return r
    })
  }

  async quota(): Promise<QuotaResponse> {
    return this.withAuthRetry(async (token) => {
      const r = await readJson<QuotaResponse>(
        await fetch(
          `${API_QUOTA}?${query({ access_token: token, checkfree: 1, checkexpire: 1 })}`,
          { headers: { 'User-Agent': USER_AGENT } },
        ),
        '查询容量',
      )
      check(r.errno, r.errmsg, '查询容量')
      return r
    })
  }

  // ------------------------------------------------------------------ 目录

  /** 列一层目录，自动翻页取全 */
  async listAll(dir: string): Promise<FsEntry[]> {
    const all: FsEntry[] = []
    let start = 0
    for (;;) {
      const s = start
      const page = await this.withAuthRetry(async (token) => {
        const r = await readJson<ListResponse>(
          await fetch(
            `${API_FILE}?${query({
              method: 'list',
              access_token: token,
              dir,
              order: 'name',
              start: s,
              limit: LIST_PAGE,
              web: 1,
            })}`,
            { headers: { 'User-Agent': USER_AGENT } },
          ),
          `列出目录 ${dir}`,
        )
        check(r.errno, r.errmsg, `列出目录 ${dir}`)
        return r
      })

      const batch = page.list ?? []
      all.push(...batch)
      if (batch.length < LIST_PAGE || all.length >= LIST_MAX_ENTRIES) break
      start += LIST_PAGE
    }
    return all
  }

  /**
   * 递归列出目录下所有条目（含子目录本身）。
   * 用 BFS 逐层展开，比 search 接口更可预测，也不会被索引延迟影响。
   */
  async listRecursive(rootDir: string): Promise<FsEntry[]> {
    const result: FsEntry[] = []
    const dirs: string[] = [rootDir]
    while (dirs.length > 0) {
      const dir = dirs.shift() as string
      let children: FsEntry[]
      try {
        children = await this.listAll(dir)
      } catch (err) {
        if (err instanceof BaiduPanException && err.isNotFound) continue
        throw err
      }
      for (const child of children) {
        result.push(child)
        if (child.isdir === 1) dirs.push(child.path)
        if (result.length >= LIST_MAX_ENTRIES) return result
      }
    }
    return result
  }

  async mkdir(path: string): Promise<void> {
    await this.withAuthRetry(async (token) => {
      const r = await readJson<CreateResponse>(
        await fetch(`${API_FILE}?${query({ method: 'create', access_token: token })}`, {
          method: 'POST',
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ path, isdir: '1', size: '0', rtype: '0' }),
        }),
        `创建目录 ${path}`,
      )
      // 已存在不算失败，调用方通常只关心「目录可用」
      if (r.errno === ERRNO.ALREADY_EXISTS) return
      check(r.errno, r.errmsg, `创建目录 ${path}`)
    })
  }

  // ------------------------------------------------------------------ 元数据

  /** 按 fsid 批量查元数据。dlink / thumb / extra 决定百度是否返回下载地址、缩略图、图片宽高 */
  async fileMetas(
    fsIds: number[],
    opts: { dlink?: boolean; thumb?: boolean; extra?: boolean } = {},
  ): Promise<FileMeta[]> {
    const out: FileMeta[] = []
    for (let i = 0; i < fsIds.length; i += METAS_BATCH) {
      const batch = fsIds.slice(i, i + METAS_BATCH)
      const r = await this.withAuthRetry(async (token) => {
        const resp = await readJson<FileMetasResponse>(
          await fetch(
            `${API_MULTIMEDIA}?${query({
              method: 'filemetas',
              access_token: token,
              fsids: JSON.stringify(batch),
              dlink: opts.dlink ? 1 : 0,
              thumb: opts.thumb ? 1 : 0,
              extra: opts.extra ? 1 : 0,
            })}`,
            { headers: { 'User-Agent': USER_AGENT } },
          ),
          '查询文件元数据',
        )
        check(resp.errno, resp.errmsg, '查询文件元数据')
        return resp
      })
      out.push(...(r.list ?? []))
    }
    return out
  }

  async fileMeta(fsId: number): Promise<FileMeta | null> {
    const list = await this.fileMetas([fsId], { dlink: true, thumb: true, extra: true })
    return list[0] ?? null
  }

  /**
   * 按路径查元数据。用于刚上传完、还没写进本地索引的文件。
   *
   * 刻意不用官方的 method=meta 接口 —— 它没在实测范围内，返回结构不确定。
   * 走已验证的「列父目录 + filemetas」组合，慢一点但结果确定。
   */
  async metaByPath(
    path: string,
    opts: { dlink?: boolean; thumb?: boolean } = {},
  ): Promise<FileMeta | null> {
    const slash = path.lastIndexOf('/')
    const parent = slash <= 0 ? '/' : path.slice(0, slash)
    for (const entry of await this.listAll(parent)) {
      if (entry.isdir === 1 || entry.path !== path) continue
      if (entry.fs_id === undefined) return null
      const metas = await this.fileMetas([entry.fs_id], {
        dlink: opts.dlink ?? false,
        thumb: opts.thumb ?? false,
        extra: true,
      })
      return metas[0] ?? null
    }
    return null
  }

  // ------------------------------------------------------------------ 上传

  /**
   * 完整上传一个文件。流程：precreate → 逐片 superfile2 → create。
   * 分片必须串行上传，百度官方明确不支持并行分片。
   *
   * **blockMd5 由调用方传入，Worker 不自己算。** 原因见 routes/api.ts 的 uploadOne：
   * Free 套餐的 CPU 预算算不动 4MB 的 MD5，而浏览器可以。
   * 这不会造成作弊 —— superfile2 返回的分片真实 MD5 会和这里的值比对。
   */
  async upload(
    remotePath: string,
    file: Blob,
    size: number,
    overwrite: boolean,
    blockMd5: string[],
  ): Promise<CreateResponse> {
    if (size <= 0) {
      throw new BaiduPanException(ERRNO.BAD_PATH, `不允许上传空文件：${remotePath}`)
    }
    if (blockMd5.length === 0) {
      throw new BaiduPanException(ERRNO.SLICE_MISMATCH, `缺少分片 MD5：${remotePath}`)
    }
    const expectedBlocks = Math.max(1, Math.ceil(size / SLICE_SIZE))
    if (blockMd5.length !== expectedBlocks) {
      throw new BaiduPanException(
        ERRNO.SLICE_MISMATCH,
        `分片数与文件大小不符：${size} 字节应为 ${expectedBlocks} 片，收到 ${blockMd5.length} 片`,
      )
    }
    const rtype = overwrite ? '3' : '0'

    // 1) 预上传
    const pre = await this.withAuthRetry(async (token) => {
      const r = await readJson<PrecreateResponse>(
        await fetch(`${API_FILE}?${query({ method: 'precreate', access_token: token })}`, {
          method: 'POST',
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            path: remotePath,
            size: String(size),
            isdir: '0',
            block_list: JSON.stringify(blockMd5),
            autoinit: '1',
            rtype,
          }),
        }),
        `预上传 ${remotePath}`,
      )
      check(r.errno, r.errmsg, `预上传 ${remotePath}`)
      return r
    })

    if (!pre.uploadid) {
      throw new BaiduPanException(ERRNO.BAD_PATH, `预上传未返回 uploadid：${remotePath}`)
    }

    // 2) 判断要传哪些分片。
    //    实测 return_type=1 + block_list=[0] 表示「需要上传第 0 片」，不是秒传，
    //    所以只以 block_list 为准；只有 return_type=2 才是云端已有内容。
    let need = pre.block_list ?? []
    if (need.length === 0 && pre.return_type !== 2) {
      need = blockMd5.map((_, i) => i)
    }

    for (const seq of need) {
      if (seq < 0 || seq >= blockMd5.length) {
        throw new BaiduPanException(ERRNO.BAD_PATH, `百度要求上传的分片序号越界：${seq}`)
      }
      await this.uploadSlice(remotePath, pre.uploadid, seq, file, size, blockMd5[seq])
    }

    // 3) 创建文件，拿 fs_id
    return this.withAuthRetry(async (token) => {
      const r = await readJson<CreateResponse>(
        await fetch(`${API_FILE}?${query({ method: 'create', access_token: token })}`, {
          method: 'POST',
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            path: remotePath,
            size: String(size),
            isdir: '0',
            block_list: JSON.stringify(blockMd5),
            uploadid: pre.uploadid as string,
            rtype,
          }),
        }),
        `创建文件 ${remotePath}`,
      )
      check(r.errno, r.errmsg, `创建文件 ${remotePath}`)
      return r
    })
  }

  private async uploadSlice(
    remotePath: string,
    uploadId: string,
    seq: number,
    file: Blob,
    totalSize: number,
    expectedMd5: string,
  ): Promise<void> {
    const from = seq * SLICE_SIZE
    const to = Math.min(from + SLICE_SIZE, totalSize)
    const chunk = file.slice(from, to)

    const token = await this.tokens.accessToken()
    const url = `${UPLOAD_HOST}/rest/2.0/pcs/superfile2?${query({
      method: 'upload',
      access_token: token,
      type: 'tmpfile',
      path: remotePath,
      uploadid: uploadId,
      partseq: seq,
    })}`

    const form = new FormData()
    form.append('file', chunk, remotePath.slice(remotePath.lastIndexOf('/') + 1))

    const resp = await readJson<SliceResponse>(
      await fetch(url, { method: 'POST', headers: { 'User-Agent': USER_AGENT }, body: form }),
      `上传第 ${seq} 片`,
    )

    // 成功响应没有 errno，只有 md5 和 request_id，所以不能用 errno===0 判断
    const okSlice = (resp.errno === undefined || resp.errno === ERRNO.OK) && !!resp.md5
    if (!okSlice) {
      const errno = resp.errno ?? ERRNO.SLICE_MISMATCH
      throw new BaiduPanException(
        errno,
        `上传分片 ${seq} 失败：${resp.errmsg ?? `错误码 ${errno}`}`,
      )
    }
    if (resp.md5 && resp.md5.toLowerCase() !== expectedMd5.toLowerCase()) {
      throw new BaiduPanException(
        ERRNO.SLICE_MISMATCH,
        `分片 ${seq} 校验不一致：本地 ${expectedMd5}，云端 ${resp.md5}`,
      )
    }
  }

  // ------------------------------------------------------------------ 文件管理

  /** 删除文件或目录。目录会被递归删除。 */
  async remove(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    const r = await this.withAuthRetry(async (token) =>
      readJson<FileManagerResponse>(
        await fetch(
          `${API_FILE}?${query({ method: 'filemanager', access_token: token, opera: 'delete' })}`,
          {
            method: 'POST',
            headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ async: '0', filelist: JSON.stringify(paths) }),
          },
        ),
        '删除',
      ),
    )

    if (r.errno === ERRNO.OK) return
    if (r.errno === ERRNO.PARTIAL_FAILURE && r.info) {
      // -9 视为已经不存在，不算错误
      const hardFailures = r.info
        .filter((i) => i.errno !== ERRNO.OK && i.errno !== ERRNO.NOT_FOUND)
        .map((i) => `${i.path}(errno=${i.errno})`)
      if (hardFailures.length === 0) return
      throw new BaiduPanException(ERRNO.PARTIAL_FAILURE, `部分文件删除失败：${hardFailures.join(', ')}`)
    }
    check(r.errno, r.errmsg, '删除')
  }

  /**
   * 重命名。
   * 实测重命名会让百度重新分配 fs_id，调用方不能用旧 fs_id 继续引用这个文件。
   */
  async rename(path: string, newName: string): Promise<void> {
    const r = await this.withAuthRetry(async (token) =>
      readJson<FileManagerResponse>(
        await fetch(
          `${API_FILE}?${query({ method: 'filemanager', access_token: token, opera: 'rename' })}`,
          {
            method: 'POST',
            headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              async: '0',
              filelist: JSON.stringify([{ path, newname: newName, ondup: 'fail' }]),
            }),
          },
        ),
        `重命名 ${path}`,
      ),
    )
    check(r.errno, r.errmsg, `重命名 ${path}`)
  }

  // ------------------------------------------------------------------ 下载

  /**
   * 打开原文件下载流。rangeHeader 形如 "bytes=0-1023"，可为 null。
   *
   * 手动跟随重定向而不是用 fetch 的 redirect:follow —— 每一跳都要过 SSRF 白名单，
   * 只校验第一跳会被 302 绕到内网地址。同时手动跟随才能保留 Range 头。
   */
  async openDlink(dlink: string, rangeHeader?: string | null): Promise<RemoteStream> {
    const token = await this.tokens.accessToken()
    return this.follow(withToken(dlink, token), rangeHeader ?? null, 0)
  }

  private async follow(url: string, rangeHeader: string | null, depth: number): Promise<RemoteStream> {
    if (depth > 5) {
      throw new BaiduPanException(ERRNO.BAD_SIGNATURE, '下载地址重定向次数过多')
    }
    assertAllowedDlink(url, '下载地址')

    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: '*/*' }
    if (rangeHeader) headers.Range = rangeHeader

    const res = await fetch(url, { headers, redirect: 'manual' })

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('Location')
      if (!location) {
        throw new BaiduPanException(ERRNO.BAD_SIGNATURE, `下载地址返回 ${res.status} 但没有 Location 头`)
      }
      // 相对跳转要按当前 URL 解析
      const next = new URL(location, url).toString()
      await res.body?.cancel()
      return this.follow(next, rangeHeader, depth + 1)
    }

    if (res.status >= 400) {
      const body = await res.text().catch(() => '')
      throw new BaiduPanException(
        ERRNO.NOT_FOUND,
        `下载失败：HTTP ${res.status}${body ? ' ' + body.slice(0, 200) : ''}`,
      )
    }

    const len = Number.parseInt(res.headers.get('Content-Length') ?? '', 10)
    return {
      status: res.status,
      contentType: res.headers.get('Content-Type'),
      contentLength: Number.isFinite(len) ? len : -1,
      contentRange: res.headers.get('Content-Range'),
      body: res.body,
    }
  }

  /** 取回官方缩略图。url 来自 filemetas 的 thumbs，同样需要 access_token 和 UA。 */
  async fetchThumb(thumbUrl: string, maxBytes = 8 * 1024 * 1024): Promise<Uint8Array> {
    const token = await this.tokens.accessToken()
    const url = withToken(thumbUrl, token)
    assertAllowedDlink(url, '缩略图地址')

    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) {
      throw new BaiduPanException(ERRNO.HOTLINK_BLOCKED, `取缩略图失败：HTTP ${res.status}`)
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length > maxBytes) {
      throw new BaiduPanException(ERRNO.HOTLINK_BLOCKED, `缩略图超过 ${maxBytes} 字节上限`)
    }
    return buf
  }

  // ------------------------------------------------------------------ 内部工具

  /**
   * 统一鉴权重试：出错且判断是令牌失效时，强制刷新一次再重试。
   * 刷新失败会抛出 errno=-6 的异常，上层据此提示用户重新授权。
   */
  private async withAuthRetry<T>(action: (token: string) => Promise<T>): Promise<T> {
    const token = await this.tokens.accessToken()
    try {
      return await action(token)
    } catch (err) {
      if (!(err instanceof BaiduPanException) || !err.isAuthFailure) throw err
      const fresh = await this.tokens.refresh().then(() => this.tokens.accessToken())
      return action(fresh)
    }
  }
}

export { bestThumbUrl }
