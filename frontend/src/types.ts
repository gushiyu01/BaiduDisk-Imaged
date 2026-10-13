/**
 * 与 docs/API.md 一一对应的 DTO 定义。
 * 任何字段都以契约为准，前端不臆造字段。
 */

/** 通用错误响应体：{"error":"<CODE>","message":"<中文提示>"} */
export interface ApiErrorBody {
  error: string
  message: string
}

/* ------------------------------------------------------------------ */
/* 1. 初始化与认证                                                      */
/* ------------------------------------------------------------------ */

/** GET /api/setup/status */
export interface SetupStatus {
  initialized: boolean
}

/** POST /api/setup/init 请求体 */
export interface SetupInitRequest {
  username: string
  /** 至少 8 位 */
  password: string
}

/** POST /api/setup/init 响应 / POST /api/auth/login 响应 / GET /api/auth/me 响应 */
export interface AuthUser {
  username: string
}

export type SetupInitResponse = AuthUser

/** POST /api/auth/login 请求体 */
export interface LoginRequest {
  username: string
  password: string
}

/* ------------------------------------------------------------------ */
/* 2. 百度网盘授权                                                      */
/* ------------------------------------------------------------------ */

/** GET /api/baidu/status、POST /api/baidu/token、POST /api/baidu/refresh 响应 */
export interface BaiduStatus {
  /** 后端是否配置了 AppKey/SecretKey */
  configured: boolean
  /** 是否已拿到可用令牌 */
  authorized: boolean
  /** ISO-8601，可能为空 */
  expiresAt: string | null
  scope: string | null
  accountName: string | null
  uk: string | null
  baseDir: string | null
}

/** GET /api/baidu/authorize-url */
export interface AuthorizeUrlResponse {
  url: string
}

/** POST /api/baidu/token 请求体 */
export interface BaiduTokenRequest {
  code: string
}

export type DiagnoseStatus = 'PASS' | 'FAIL' | 'SKIP'

/** POST /api/baidu/diagnose 中的单项检查 */
export interface DiagnoseCheck {
  key: string
  name: string
  status: DiagnoseStatus
  /** 真实观测值或真实错误信息 */
  detail: string
  elapsedMs: number
}

/** POST /api/baidu/diagnose 响应 */
export interface DiagnoseResult {
  checks: DiagnoseCheck[]
  summary: string
}

/** GET /api/baidu/browse 中的目录项 */
export interface BrowseEntry {
  path: string
  name: string
  isdir: boolean
  size: number
}

/** GET /api/baidu/browse?dir=/ 响应 */
export interface BrowseResult {
  dir: string
  entries: BrowseEntry[]
}

/* ------------------------------------------------------------------ */
/* 3. 图片                                                             */
/* ------------------------------------------------------------------ */

/** 缩略图来源 */
export type ThumbSource = 'BAIDU' | 'LOCAL' | 'NONE'

/**
 * 文件大类。图片只是其中一种，图库 = 文件库的一个筛选视图。
 * 由后端按扩展名优先、百度 category 兜底推导。
 */
export type AssetKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOC' | 'OTHER'

/** 类型筛选器的中文标签 */
export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  IMAGE: '图片',
  VIDEO: '视频',
  AUDIO: '音频',
  DOC: '文档',
  OTHER: '其他'
}

/** 标签 */
export interface TagDto {
  id: number
  name: string
  color: string
  /** 关联文件数量 */
  count: number
}

/** 文件 DTO（图库里的图片也是它，kind 为 IMAGE） */
export interface AssetDto {
  id: number
  fsId: string
  name: string
  path: string
  size: number
  kind: AssetKind
  /** 百度原始分类码：1 视频 / 2 音频 / 3 图片 / 4 文档 / 5 应用 / 6 其他 / 7 种子 */
  category: number | null
  /** 仅图片有；百度不保证返回，拿不到时为 null */
  width: number | null
  height: number | null
  mime: string
  /** 小写扩展名，不含点；无扩展名为空串 */
  ext: string
  md5: string | null
  /** ISO-8601 */
  serverMtime: string | null
  favorite: boolean
  tags: TagDto[]
  thumbSource: ThumbSource
  /** 是否值得请求 /thumb。文档、压缩包等类型为 false，前端应显示类型图标 */
  thumbnailable: boolean
  /** 网盘上已找不到该文件（只在「只删网盘」后为 true） */
  missing: boolean
  /** ISO-8601 */
  indexedAt: string
}

/** 排序方式，/api/files 与 /api/images 通用 */
export type AssetSort =
  | 'time_desc'
  | 'time_asc'
  | 'name_asc'
  | 'name_desc'
  | 'size_desc'
  | 'size_asc'

/** GET /api/files 查询参数 */
export interface AssetListQuery {
  /** 从 1 开始，默认 1 */
  page?: number
  /** 默认 24，最大 100 */
  size?: number
  /** 文件名模糊搜索 */
  q?: string
  /** 标签 id，可重复 */
  tag?: number[]
  favorite?: boolean
  /** 不传即全部类型 */
  kind?: AssetKind
  sort?: AssetSort
}

/** GET /api/files/kind-stats 中的单项 */
export interface KindStat {
  kind: AssetKind
  label: string
  count: number
}

/** GET /api/files/kind-stats 响应 */
export interface KindStatsResult {
  kinds: KindStat[]
  total: number
}

/** GET /api/files 响应 */
export interface AssetListResult {
  total: number
  page: number
  size: number
  items: AssetDto[]
}

/** 上传响应中单个失败项 */
export interface UploadFailure {
  name: string
  reason: string
}

/** 上传响应 */
export interface UploadResult {
  uploaded: AssetDto[]
  failed: UploadFailure[]
}

/** PATCH /api/files/{id} 请求体 */
export interface RenameAssetRequest {
  name: string
}

/** PATCH /api/files/{id}/favorite 请求体 */
export interface FavoriteRequest {
  favorite: boolean
}

/** POST /api/files/{id}/tags 请求体（全量覆盖） */
export interface SetAssetTagsRequest {
  tagIds: number[]
}

/** DELETE /api/files/{id}?mode=... */
export type DeleteMode = 'index' | 'remote' | 'both'

/** DELETE /api/files/{id} 响应 */
export interface DeleteAssetResult {
  deleted: DeleteMode
  remoteDeleted: boolean
  indexDeleted: boolean
}

/** POST /api/images/sync 请求体（可选） */
export interface SyncRequest {
  dir?: string
}

/** POST /api/images/sync 响应 */
export interface SyncResult {
  scanned: number
  added: number
  updated: number
  removed: number
  failed: number
  elapsedMs: number
}

/* ------------------------------------------------------------------ */
/* 4. 标签                                                             */
/* ------------------------------------------------------------------ */

/** POST /api/tags 请求体 */
export interface CreateTagRequest {
  name: string
  color: string
}

/** PATCH /api/tags/{id} 请求体 */
export interface UpdateTagRequest {
  name?: string
  color?: string
}

/* ------------------------------------------------------------------ */
/* 5. 系统                                                             */
/* ------------------------------------------------------------------ */

/** GET /api/system/info */
export interface SystemInfo {
  version: string
  baseDir: string
  cacheDir: string
  cacheSizeBytes: number
  dbPath: string
  /** 全部文件数 */
  assetCount: number
  /** 其中图片数，等同 kindCounts.IMAGE */
  imageCount: number
  kindCounts: Record<string, number>
  tagCount: number
}
