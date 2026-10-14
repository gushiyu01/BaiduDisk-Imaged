import { baseDir, sessionHours, type Env } from '../env'
import { BaiduPanClient } from '../baidu/client'
import { Repo } from '../db/repo'
import { hashPassword, verifyPassword } from '../auth/password'
import { loadOrCreateJwtSecret, signJwt, verifyJwt } from '../auth/jwt'
import { ApiException, BaiduPanException } from '../support/errors'
import {
  apiError,
  contentDisposition,
  guard,
  json,
  noContent,
  readCookie,
  readJson,
  sessionCookie,
} from '../support/http'
import { ALL_KINDS, KIND_LABELS, extensionOf, isImageFilename, kindOf } from '../support/kinds'
import { mimeFromFilename } from '../support/mime'
import { clearThumbCache, getThumbnail } from '../services/thumb-service'
import { sync } from '../services/sync-service'
import {
  DeleteMode,
  buildQuery,
  fileNameOf,
  kindFromRemote,
  parentOf,
  parseDeleteMode,
  sanitizeFilename,
  tagDto,
  toAssetDto,
} from '../services/asset-service'

const COOKIE = 'picman_token'
const MIN_PASSWORD_LENGTH = 8
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/
const MAX_NAME_ATTEMPTS = 20

function repo(env: Env): Repo {
  return new Repo(env.DB)
}

function baidu(env: Env): BaiduPanClient {
  return new BaiduPanClient(env)
}

async function jwtSecret(env: Env): Promise<string> {
  return loadOrCreateJwtSecret(repo(env))
}

/** 会话有效则返回用户名，否则 null */
async function currentUser(env: Env, req: Request): Promise<string | null> {
  const token = readCookie(req, COOKIE)
  if (!token) return null
  const payload = await verifyJwt(token, await jwtSecret(env))
  return payload?.sub ?? null
}

async function requireUser(env: Env, req: Request): Promise<string> {
  const user = await currentUser(env, req)
  if (!user) throw ApiException.unauthorized('未登录或登录已过期')
  return user
}

/** 上传时客户端必须提供分片 MD5，见 upload 分支的说明 */
function parseBlockMd5(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{32}$/i.test(x))
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ 路由

export async function handleApi(req: Request, env: Env): Promise<Response> {
  return guard(async () => {
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method.toUpperCase()
    const db = repo(env)
    const client = baidu(env)

    // ---------------- 初始化与认证 ----------------

    if (path === '/api/setup/status' && method === 'GET') {
      return json({ initialized: (await db.userCount()) > 0 })
    }

    if (path === '/api/setup/init' && method === 'POST') {
      const body = await readJson<{ username?: string; password?: string }>(req)
      const username = (body.username ?? '').trim()
      const password = body.password ?? ''
      if (!USERNAME_RE.test(username)) {
        throw ApiException.badRequest('用户名需为 3-32 位的字母、数字、下划线、点或短横线')
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw ApiException.badRequest(`密码至少 ${MIN_PASSWORD_LENGTH} 位`)
      }
      if (/^\d+$/.test(password)) {
        throw ApiException.badRequest('密码不能是纯数字')
      }
      // 用条件插入而不是「先 count 再 insert」：后者两个并发请求会同时看到 0，
      // 然后各插一个管理员 —— 这是公开接口，首次部署时确实可能被并发抢注
      const created = await db.insertFirstUser(username, await hashPassword(password))
      if (!created) {
        return apiError('CONFLICT', '系统已完成初始化，不能再创建管理员', 409)
      }
      return json({ username })
    }

    if (path === '/api/auth/login' && method === 'POST') {
      if ((await db.userCount()) === 0) {
        return apiError('NOT_INITIALIZED', '系统尚未初始化，请先创建管理员账号', 409)
      }
      const body = await readJson<{ username?: string; password?: string }>(req)
      const username = (body.username ?? '').trim()
      const user = await db.findUser(username)
      // 用户不存在与密码错误返回同样的信息，不泄漏账号是否存在
      const ok = user ? await verifyPassword(body.password ?? '', user.password_hash) : false
      if (!user || !ok) {
        return apiError('BAD_CREDENTIALS', '用户名或密码错误', 401)
      }
      const ttl = sessionHours(env) * 3600
      const token = await signJwt(user.username, await jwtSecret(env), ttl)
      const secure = url.protocol === 'https:'
      return json({ username: user.username }, 200, {
        'Set-Cookie': sessionCookie(token, ttl, secure),
      })
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      // 必须真的把 Cookie 清掉。只返回 204 的话前端的登录态虽然清了，
      // 浏览器的 Cookie 还在 —— 刷新页面时 /api/auth/me 照样通过，
      // 等于「退出后仍保持登录」。Secure 要跟着当前协议走，否则 HTTPS 下清不掉。
      const secure = url.protocol === 'https:'
      return new Response(null, {
        status: 204,
        headers: { 'Set-Cookie': sessionCookie('', 0, secure) },
      })
    }

    if (path === '/api/auth/me' && method === 'GET') {
      return json({ username: await requireUser(env, req) })
    }

    if (path === '/api/auth/password' && method === 'POST') {
      const username = await requireUser(env, req)
      const body = await readJson<{ oldPassword?: string; newPassword?: string }>(req)
      const user = await db.findUser(username)
      if (!user || !(await verifyPassword(body.oldPassword ?? '', user.password_hash))) {
        return apiError('BAD_CREDENTIALS', '原密码不正确', 401)
      }
      const next = body.newPassword ?? ''
      if (next.length < MIN_PASSWORD_LENGTH) {
        throw ApiException.badRequest(`新密码至少 ${MIN_PASSWORD_LENGTH} 位`)
      }
      if (/^\d+$/.test(next)) {
        throw ApiException.badRequest('新密码不能是纯数字')
      }
      // 只算一次。PBKDF2 是重操作，之前这里调了两次 —— 既浪费 CPU，
      // 又因为两次的盐不同而算出两个不同的哈希，其中一个被写进了配置表当垃圾数据
      const hash = await hashPassword(next)
      await env.DB.prepare('UPDATE app_user SET password_hash = ? WHERE username = ?')
        .bind(hash, username)
        .run()
      return noContent()
    }

    // 从这里开始都要登录
    await requireUser(env, req)

    // ---------------- 百度授权 ----------------

    if (path === '/api/baidu/status' && method === 'GET') {
      return json(await baiduStatus(env, client))
    }

    if (path === '/api/baidu/authorize-url' && method === 'GET') {
      return json({ url: await client.tokenStore.authorizeUrl() })
    }

    if (path === '/api/baidu/token' && method === 'POST') {
      const body = await readJson<{ code?: string }>(req)
      await client.tokenStore.exchangeCode(body.code ?? '')
      return json(await baiduStatus(env, client))
    }

    if (path === '/api/baidu/refresh' && method === 'POST') {
      await client.tokenStore.refresh()
      return json(await baiduStatus(env, client))
    }

    if (path === '/api/baidu/disconnect' && method === 'POST') {
      await client.tokenStore.clear()
      return noContent()
    }

    /**
     * 从自建部署迁移过来时用：把旧部署的 refresh_token 交给本部署。
     *
     * 百度的 refresh_token 是一次性的，用掉之后旧部署那份就作废了 ——
     * 所以这是「搬家」而不是「复制」，老部署之后需要重新授权。
     */
    if (path === '/api/baidu/import-refresh-token' && method === 'POST') {
      const body = await readJson<{ refreshToken?: string }>(req)
      await client.tokenStore.importRefreshToken(body.refreshToken ?? '')
      return json(await baiduStatus(env, client))
    }

    if (path === '/api/baidu/quota' && method === 'GET') {
      const q = await client.quota()
      return json({ total: q.total ?? 0, used: q.used ?? 0, free: q.free ?? 0 })
    }

    if (path === '/api/baidu/browse' && method === 'GET') {
      const dir = url.searchParams.get('dir') ?? '/'
      const entries = await client.listAll(dir)
      return json({
        dir,
        entries: entries.map((e) => ({
          path: e.path,
          name: e.server_filename ?? e.path,
          isdir: e.isdir === 1,
          size: e.size ?? 0,
        })),
      })
    }

    if (path === '/api/baidu/diagnose' && method === 'POST') {
      return json(await diagnose(env, db, client))
    }

    // ---------------- 文件 ----------------

    const isFiles = path.startsWith('/api/files')
    const isImages = path.startsWith('/api/images')

    if ((isFiles || isImages) && method === 'GET') {
      const rest = path.replace(/^\/api\/(files|images)/, '')

      if (rest === '' ) {
        const page = await listAssets(db, url, isImages)
        return json(page)
      }
      if (rest === '/kind-stats' && isFiles) {
        const counts = await db.countsByKind()
        const total = Object.values(counts).reduce((a, b) => a + b, 0)
        return json({
          total,
          kinds: ALL_KINDS.map((k) => ({ kind: k, label: KIND_LABELS[k], count: counts[k] ?? 0 })),
        })
      }

      const m = /^\/(\d+)(\/thumb|\/raw)?$/.exec(rest)
      if (m) {
        const id = Number.parseInt(m[1], 10)
        const row = await db.findById(id)
        if (!row) throw ApiException.notFound(`文件不存在（id=${id}）`)

        if (!m[2]) {
          const tags = await db.tagsForAssets([id])
          return json(toAssetDto(row, tags[id] ?? []))
        }

        if (m[2] === '/thumb') {
          if (!kindOf(row.category, row.name)) throw ApiException.notFound('文件不存在')
          const kind = kindFromRemote(row.category, row.name)
          if (kind !== 'IMAGE' && kind !== 'VIDEO') {
            return apiError('NO_THUMBNAIL', `「${KIND_LABELS[kind]}」类型没有缩略图，请使用类型图标`, 415)
          }
          const result = await getThumbnail(env, db, client, row)
          return new Response(result.data as unknown as BodyInit, {
            headers: {
              'Content-Type': result.contentType,
              'Content-Length': String(result.data.length),
              'X-Thumb-Source': result.source,
              'Cache-Control': 'private, max-age=86400',
            },
          })
        }

        // /raw
        const range = req.headers.get('Range')
        const stream = await client.openDlink(await requireDlink(client, row), range)
        const headers: Record<string, string> = {
          'Content-Type': stream.contentType ?? mimeFromFilename(row.name, extensionOf(row.name)),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=300',
        }
        if (stream.contentLength >= 0) headers['Content-Length'] = String(stream.contentLength)
        if (stream.contentRange) headers['Content-Range'] = stream.contentRange
        if (url.searchParams.get('download') === 'true' || url.searchParams.get('download') === '1') {
          headers['Content-Disposition'] = contentDisposition(row.name)
        }
        return new Response(stream.body, { status: stream.status, headers })
      }
    }

    if ((isFiles || isImages) && method === 'POST' && path.endsWith('/upload')) {
      const imageOnly = isImages
      const form = await req.formData()
      const file = form.get('file')
      if (!(file instanceof File)) {
        throw ApiException.badRequest('缺少上传文件（字段名 file）')
      }
      const uploaded = await uploadOne(env, db, client, file, imageOnly, form.get('blockMd5'))
      return json({ uploaded: [uploaded], failed: [] })
    }

    if ((isFiles || isImages) && method === 'POST' && path.endsWith('/sync')) {
      const body = await readJson<{ dir?: string }>(req)
      return json(await sync(env, db, client, body.dir ?? null))
    }

    if ((isFiles || isImages)) {
      const m = /^\/(\d+)(\/favorite|\/tags)?$/.exec(path.replace(/^\/api\/(files|images)/, ''))
      if (m) {
        const id = Number.parseInt(m[1], 10)
        const row = await db.findById(id)
        if (!row) throw ApiException.notFound(`文件不存在（id=${id}）`)

        if (!m[2] && method === 'PATCH') {
          const body = await readJson<{ name?: string }>(req)
          const updated = await renameAsset(db, client, id, row.path, row.name, row.fs_id, row.category, body.name ?? '')
          return json(updated)
        }

        if (m[2] === '/favorite' && method === 'PATCH') {
          const body = await readJson<{ favorite?: boolean }>(req)
          await db.setFavorite(id, !!body.favorite)
          const fresh = await db.findById(id)
          const tags = await db.tagsForAssets([id])
          return json(toAssetDto(fresh as NonNullable<typeof fresh>, tags[id] ?? []))
        }

        if (m[2] === '/tags' && method === 'POST') {
          const body = await readJson<{ tagIds?: number[] }>(req)
          const tagIds = body.tagIds ?? []
          for (const tid of tagIds) {
            if (!(await db.findTagById(tid))) {
              throw ApiException.badRequest(`标签不存在：id=${tid}`)
            }
          }
          await db.setAssetTags(id, tagIds)
          const fresh = await db.findById(id)
          const tags = await db.tagsForAssets([id])
          return json(toAssetDto(fresh as NonNullable<typeof fresh>, tags[id] ?? []))
        }

        if (!m[2] && method === 'DELETE') {
          const mode = parseDeleteMode(url.searchParams.get('mode'))
          let remoteDeleted = false
          let indexDeleted = false

          if (mode === DeleteMode.REMOTE || mode === DeleteMode.BOTH) {
            try {
              await client.remove([row.path])
              remoteDeleted = true
            } catch (err) {
              if (!(err instanceof BaiduPanException) || !err.isNotFound) throw err
              remoteDeleted = true
            }
          }
          if (mode === DeleteMode.BOTH) {
            await db.deleteById(id)
            indexDeleted = true
          } else if (mode === DeleteMode.REMOTE) {
            await db.setMissing(id, true)
          } else {
            await db.deleteById(id)
            indexDeleted = true
          }
          return json({ deleted: mode, remoteDeleted, indexDeleted })
        }
      }
    }

    // ---------------- 标签 ----------------

    if (path === '/api/tags' && method === 'GET') {
      return json((await db.listTags()).map(tagDto))
    }

    if (path === '/api/tags' && method === 'POST') {
      const body = await readJson<{ name?: string; color?: string }>(req)
      const name = (body.name ?? '').trim()
      if (!name) throw ApiException.badRequest('标签名不能为空')
      if (name.length > 32) throw ApiException.badRequest('标签名不能超过 32 个字符')
      if (await db.findTagByName(name)) {
        return apiError('CONFLICT', `标签已存在：${name}`, 409)
      }
      const color = normalizeColor(body.color)
      const id = await db.insertTag(name, color)
      const created = await db.findTagById(id)
      return json(tagDto(created as NonNullable<typeof created>), 201)
    }

    const tagMatch = /^\/api\/tags\/(\d+)$/.exec(path)
    if (tagMatch) {
      const id = Number.parseInt(tagMatch[1], 10)
      const existing = await db.findTagById(id)
      if (!existing) throw ApiException.notFound(`标签不存在（id=${id}）`)

      if (method === 'PATCH') {
        const body = await readJson<{ name?: string; color?: string }>(req)
        const name = body.name?.trim() || existing.name
        const other = await db.findTagByName(name)
        if (other && other.id !== id) return apiError('CONFLICT', `已有同名标签：${name}`, 409)
        await db.updateTag(id, name, body.color?.trim() ? normalizeColor(body.color) : existing.color)
        const fresh = await db.findTagById(id)
        return json(tagDto(fresh as NonNullable<typeof fresh>))
      }
      if (method === 'DELETE') {
        await db.deleteTag(id)
        return noContent()
      }
    }

    // ---------------- 系统 ----------------

    if (path === '/api/system/info' && method === 'GET') {
      const counts = await db.countsByKind()
      const kinds: Record<string, number> = {}
      for (const k of ALL_KINDS) kinds[k] = counts[k] ?? 0
      return json({
        version: '1.0.0-cf',
        runtime: 'cloudflare-workers',
        baseDir: baseDir(env),
        assetCount: await db.countAssets(),
        imageCount: kinds.IMAGE,
        kindCounts: kinds,
        tagCount: (await db.listTags()).length,
      })
    }

    if (path === '/api/system/cache/clear' && method === 'POST') {
      await clearThumbCache(env)
      return noContent()
    }

    return apiError('NOT_FOUND', `接口不存在：${method} ${path}`, 404)
  })
}

// ------------------------------------------------------------------ 辅助

function normalizeColor(color: string | undefined): string {
  const c = (color ?? '').trim()
  if (!c) return '#409EFF'
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) {
    throw ApiException.badRequest(`颜色需为 #RRGGBB 格式，收到：${c}`)
  }
  return c.toUpperCase()
}

async function listAssets(db: Repo, url: URL, imagesOnly: boolean) {
  const query = buildQuery(url, imagesOnly ? 'IMAGE' : undefined)
  const rows = await db.search(query)
  const total = await db.countSearch(query)
  const tagMap = await db.tagsForAssets(rows.map((r) => r.id))
  return {
    total,
    page: query.page,
    size: query.size,
    items: rows.map((r) => toAssetDto(r, tagMap[r.id] ?? [])),
  }
}

/** 取下载地址；fs_id 失效时按路径重查 */
async function requireDlink(client: BaiduPanClient, row: { fs_id: string | null; path: string }): Promise<string> {
  let meta = row.fs_id ? await client.fileMeta(Number.parseInt(row.fs_id, 10)).catch(() => null) : null
  if (!meta) meta = await client.metaByPath(row.path, { dlink: true })
  if (!meta?.dlink) {
    throw new BaiduPanException(-9, `网盘上找不到该文件：${row.path}`)
  }
  return meta.dlink
}

async function renameAsset(
  db: Repo,
  client: BaiduPanClient,
  id: number,
  oldPath: string,
  oldName: string,
  fsId: string | null,
  category: number | null,
  rawName: string,
) {
  const name = sanitizeFilename(rawName)
  if (!name) throw ApiException.badRequest('文件名不能为空')
  if (name === oldName) {
    const tags = await db.tagsForAssets([id])
    return toAssetDto((await db.findById(id)) as NonNullable<Awaited<ReturnType<typeof db.findById>>>, tags[id] ?? [])
  }

  const newPath = `${parentOf(oldPath)}/${name}`
  if (await db.findByPath(newPath)) {
    return apiError('CONFLICT', `索引里已存在同名文件：${name}`, 409)
  }

  await client.rename(oldPath, name)

  // 实测重命名会让百度重新分配 fs_id，不能沿用旧值；顺便重算类型，
  // 改了扩展名就等于换了文件类型
  const meta = await client.metaByPath(newPath, {})
  const nextFsId = meta?.fs_id !== undefined ? String(meta.fs_id) : fsId
  await db.updateFsIdAndPath(id, nextFsId, newPath, name)
  await db.updateKindAndMime(id, kindOf(category, name), mimeFromFilename(name, extensionOf(name)))

  const fresh = await db.findById(id)
  const tags = await db.tagsForAssets([id])
  return toAssetDto(fresh as NonNullable<typeof fresh>, tags[id] ?? [])
}

/**
 * 上传单个文件。
 *
 * **这里和 Java 版有本质差别**：分片 MD5 由客户端计算后通过 blockMd5 字段传入。
 * 原因是 Cloudflare Free 套餐每请求 CPU 预算很小（实测纯 JS 算 4MB 的 MD5
 * 大约三次里失败一次），而百度要求普通用户必须按 4MB 切片并提交每片 MD5。
 * 浏览器没有这个限制，交给它算又快又稳。
 *
 * 这不会导致客户端作弊：superfile2 会返回分片的真实 MD5，下面会拿它和
 * 客户端声明的值比对，对不上直接报错，所以伪造 MD5 只会让上传失败。
 */
async function uploadOne(
  env: Env,
  db: Repo,
  client: BaiduPanClient,
  file: File,
  imageOnly: boolean,
  rawBlockMd5: unknown,
) {
  const originalName = file.name
  if (!originalName) throw ApiException.badRequest('上传文件缺少文件名')
  if (file.size === 0) throw ApiException.badRequest(`文件内容为空：${originalName}`)
  if (imageOnly && !isImageFilename(originalName)) {
    throw ApiException.badRequest(
      `图库只接受图片文件，收到：${originalName}。要传其他类型请用「文件库」页的上传入口。`,
    )
  }

  const safeName = sanitizeFilename(originalName)
  if (!safeName) throw ApiException.badRequest(`文件名不合法：${originalName}`)

  const blockMd5 = parseBlockMd5(typeof rawBlockMd5 === 'string' ? rawBlockMd5 : null)
  if (blockMd5.length === 0) {
    throw ApiException.badRequest(
      '缺少 blockMd5：分片 MD5 需由客户端计算后随表单提交（字段名 blockMd5，JSON 数组）',
    )
  }

  const dir = baseDir(env)
  await client.mkdir(dir)

  let candidate = safeName
  let remotePath = `${dir}/${candidate}`
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    try {
      const created = await client.upload(remotePath, file, file.size, false, blockMd5)
      return await indexUploaded(db, client, remotePath, created)
    } catch (err) {
      const isConflict =
        err instanceof BaiduPanException &&
        (err.errno === -8 || err.errno === -7)
      if (!isConflict) throw err
      candidate = numberedName(safeName, attempt + 1)
      remotePath = `${dir}/${candidate}`
    }
  }
  return apiError('CONFLICT', `同名文件过多，无法为「${safeName}」找到可用名称`, 409)
}

function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? `${name}(${n})` : `${name.slice(0, dot)}(${n})${name.slice(dot)}`
}

async function indexUploaded(
  db: Repo,
  client: BaiduPanClient,
  remotePath: string,
  created: { fs_id?: number; size?: number; md5?: string; category?: number; mtime?: number },
) {
  const name = fileNameOf(remotePath)
  const category = created.category ?? null
  const kind = kindFromRemote(category, name)
  const serverMtime = created.mtime ? new Date(created.mtime * 1000).toISOString() : new Date().toISOString()

  await db.upsertAsset({
    fsId: created.fs_id === undefined ? null : String(created.fs_id),
    path: remotePath,
    name,
    size: created.size ?? 0,
    kind,
    category,
    width: null,
    height: null,
    mime: mimeFromFilename(name, extensionOf(name)),
    md5: created.md5 ?? null,
    serverMtime,
    thumbSource: 'UNKNOWN',
  })

  const row = await db.findByPath(remotePath)
  if (!row) throw new Error(`上传后写入索引失败：${remotePath}`)
  const tags = await db.tagsForAssets([row.id])
  void client
  return toAssetDto(row, tags[row.id] ?? [])
}

/** 只读体检。不写盘，所以不会像 Java 版那样有深度模式。 */
async function diagnose(env: Env, db: Repo, client: BaiduPanClient) {
  const checks: Array<{ key: string; name: string; status: string; detail: string; elapsedMs: number }> = []

  async function run(key: string, name: string, fn: () => Promise<string>) {
    const t0 = Date.now()
    try {
      const detail = await fn()
      checks.push({ key, name, status: 'PASS', detail, elapsedMs: Date.now() - t0 })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      checks.push({ key, name, status: 'FAIL', detail, elapsedMs: Date.now() - t0 })
    }
  }

  await run('token', '访问令牌', async () => {
    const st = await client.tokenStore.status()
    if (!st.authorized) throw new Error('尚未授权，请先完成百度网盘 OAuth 授权')
    await client.tokenStore.accessToken()
    return `有效，scope=${st.scope}，有效期至 ${st.expiresAt ? new Date(st.expiresAt).toISOString() : '未知'}`
  })

  await run('account', '账号信息', async () => {
    const u = await client.uinfo()
    return `已授权账号 ${u.baidu_name ?? '?'}（${u.netdisk_name ?? '?'}），uk=${u.uk ?? '?'}，VIP 等级 ${u.vip_type ?? '?'}`
  })

  await run('list', '列目录', async () => {
    const dir = baseDir(env)
    const entries = await client.listAll(dir)
    const dirs = entries.filter((e) => e.isdir === 1).length
    const imgs = entries.filter((e) => e.category === 3).length
    return `${dir} 共 ${entries.length} 项（子目录 ${dirs} 个，图片 ${imgs} 张）`
  })

  const sample = await db.search({ page: 1, size: 1, sort: 'time_desc' })
  const row = sample[0]
  if (!row) {
    checks.push({ key: 'thumb', name: '官方缩略图', status: 'SKIP', detail: '索引里还没有文件，先同步一次索引', elapsedMs: 0 })
    checks.push({ key: 'download', name: '原文件下载', status: 'SKIP', detail: '索引里还没有文件', elapsedMs: 0 })
  } else {
    await run('thumb', '官方缩略图', async () => {
      const r = await getThumbnail(env, db, client, row)
      return `取到 ${r.data.length} 字节，来源 ${r.source}，Content-Type=${r.contentType}`
    })
    await run('download', '原文件下载', async () => {
      const stream = await client.openDlink(await requireDlink(client, row), 'bytes=0-1023')
      const buf = new Uint8Array(await new Response(stream.body).arrayBuffer())
      return `HTTP ${stream.status}，读取 ${buf.length} 字节，Content-Type=${stream.contentType ?? '未知'}`
    })
  }

  checks.push({
    key: 'upload',
    name: '上传',
    status: 'SKIP',
    detail: '需要客户端提供分片 MD5，无法在只读体检里自测（见 README「上传为什么改成客户端算 MD5」）',
    elapsedMs: 0,
  })

  const pass = checks.filter((c) => c.status === 'PASS').length
  const fail = checks.filter((c) => c.status === 'FAIL').length
  const skip = checks.filter((c) => c.status === 'SKIP').length
  return { checks, summary: `${pass} 项通过，${fail} 项失败，${skip} 项跳过` }
}

/**
 * 组装完整的百度授权状态。
 *
 * 前端会用返回值**整体替换** status 对象，所以改变授权状态的接口
 * （/token、/refresh、/import-refresh-token）也必须返回这个完整结构，
 * 不能只回 TokenStatus —— 否则界面上「后端凭证配置 / 百度账号 / uk / 基础目录」
 * 会一起变成空，看起来像是凭证丢了。
 */
async function baiduStatus(env: Env, client: BaiduPanClient) {
  const status = await client.tokenStore.status()
  let accountName: string | null = null
  let uk: string | null = null
  if (status.authorized) {
    try {
      const info = await client.uinfo()
      accountName = info.netdisk_name || info.baidu_name || null
      uk = info.uk === undefined ? null : String(info.uk)
    } catch {
      // 账号名只是展示，取不到不能让整个状态接口失败
    }
  }
  return {
    configured: !!(env.BAIDU_DISK_APP_KEY?.trim() && env.BAIDU_DISK_SECRET_KEY?.trim()),
    authorized: status.authorized,
    expiresAt: status.expiresAt ? new Date(status.expiresAt).toISOString() : null,
    scope: status.scope,
    accountName,
    uk,
    baseDir: baseDir(env),
  }
}
