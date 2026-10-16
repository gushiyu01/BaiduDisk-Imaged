# PicMan · 前端 API 契约

前后端分离约定。所有接口前缀 `/api`，返回 JSON（二进制接口除外）。认证用 **HttpOnly Cookie**，前端不需要也不能接触任何百度网盘令牌。

## 通用约定

- 未认证时业务接口返回 `401`，响应体 `{"error":"UNAUTHORIZED","message":"未登录"}`。
- 业务异常统一返回 `{"error":"<CODE>","message":"<中文提示>"}`，HTTP 状态码见各接口。
- 时间统一用 ISO-8601 字符串（`2026-10-13T11:22:33Z`）。
- 分页参数 `page` 从 **1** 开始。

---

## 1. 初始化与认证

### `GET /api/setup/status` （免登录）

```json
{ "initialized": true }
```

`initialized=false` 表示还没有管理员账号，前端应跳转到初始化页。

### `POST /api/setup/init` （免登录，仅首次可用）

请求：`{ "username": "admin", "password": "至少8位" }`
响应 `200`：`{ "username": "admin" }`
错误 `409`：已初始化。

### `POST /api/auth/login` （免登录）

请求：`{ "username": "admin", "password": "..." }`
响应 `200`：`{ "username": "admin" }`，同时下发 `Set-Cookie: picman_token=...; HttpOnly; SameSite=Lax; Path=/`
错误 `401`：`{"error":"BAD_CREDENTIALS","message":"用户名或密码错误"}`

### `POST /api/auth/logout`

响应 `204`，清除 Cookie。

### `GET /api/auth/me`

响应 `200`：`{ "username": "admin" }`
错误 `401`。

---

## 2. 百度网盘授权

### `GET /api/baidu/status`

```json
{
  "configured": true,
  "authorized": true,
  "expiresAt": "2026-11-12T03:02:46Z",
  "scope": "basic netdisk",
  "accountName": "我没有资源",
  "uk": "185241964",
  "baseDir": "/apps/picman"
}
```

`configured=false` → 后端没配 AppKey/SecretKey，前端提示改环境变量。
`authorized=false` → 需要走 OAuth。

### `GET /api/baidu/authorize-url`

```json
{ "url": "https://openapi.baidu.com/oauth/2.0/authorize?..." }
```

前端 `window.open` 打开。授权完成后百度会显示一串授权码，用户复制回来，调用下面的接口。

### `POST /api/baidu/token`

请求：`{ "code": "a2a966e4..." }`
响应 `200`：同 `/api/baidu/status`
错误 `400`：`{"error":"OAUTH_FAILED","message":"invalid_grant: ..."}`

### `POST /api/baidu/refresh`

手动刷新令牌。响应同 `/api/baidu/status`。

### `POST /api/baidu/disconnect`

清除本地令牌。响应 `204`。

### `POST /api/baidu/diagnose`

对百度网盘开放平台逐项体检，返回真实结果（**不做任何伪造**）。

```json
{
  "checks": [
    { "key": "token",        "name": "访问令牌",     "status": "PASS", "detail": "有效期至 2026-11-12", "elapsedMs": 120 },
    { "key": "list",         "name": "列目录",       "status": "PASS", "detail": "/apps 下 2 个子目录", "elapsedMs": 240 },
    { "key": "thumb",        "name": "官方缩略图",   "status": "PASS", "detail": "url1~url4 + icon，JPEG", "elapsedMs": 310 },
    { "key": "download",     "name": "原图下载",     "status": "PASS", "detail": "md5 校验一致", "elapsedMs": 520 },
    { "key": "upload",       "name": "上传",         "status": "SKIP", "detail": "未开启（诊断默认不写盘）", "elapsedMs": 0 },
    { "key": "rename",       "name": "重命名",       "status": "PASS", "detail": "", "elapsedMs": 180 },
    { "key": "delete",       "name": "删除",         "status": "PASS", "detail": "", "elapsedMs": 150 }
  ],
  "summary": "5 项通过，0 项失败，1 项跳过"
}
```

`status` 取值：`PASS` / `FAIL` / `SKIP`。`detail` 必须写真实观测值或真实错误信息。

### `GET /api/baidu/browse?dir=/`

列出网盘目录，用于选择基础目录。

```json
{ "dir": "/", "entries": [ { "path": "/apps", "name": "apps", "isdir": true, "size": 0 } ] }
```

---

## 3. 文件与图片

**图片只是 `kind=IMAGE` 的一种文件**，所以两套路径由同一批处理器提供：

- `/api/files/**` —— 文件库，不限类型
- `/api/images/**` —— 图库，等价于把 `kind` 固定成 `IMAGE`，字段与行为与只有图片时完全一致，老前端不用改

除「列表」和「上传」外，其余路径两者完全等价，下面统称 `/api/files`。

`AssetDto`：

```json
{
  "id": 12,
  "fsId": "706030681623028",
  "name": "DSC_0001.jpg",
  "path": "/apps/picman/DSC_0001.jpg",
  "size": 138220,
  "kind": "IMAGE",
  "category": 3,
  "width": 1600,
  "height": 1000,
  "mime": "image/jpeg",
  "ext": "jpg",
  "md5": "df2c559c4da7544cc3469333f94e9e3c",
  "serverMtime": "2026-10-13T10:24:02Z",
  "favorite": false,
  "tags": [ { "id": 3, "name": "风景", "color": "#409EFF" } ],
  "thumbSource": "BAIDU",
  "thumbnailable": true,
  "missing": false,
  "indexedAt": "2026-10-13T11:00:00Z"
}
```

| 字段 | 说明 |
| --- | --- |
| `kind` | `IMAGE` / `VIDEO` / `AUDIO` / `DOC` / `OTHER`。后端按扩展名优先、百度 `category` 兜底推导 |
| `category` | 百度原始分类码，保留备查，不参与业务判断 |
| `width` / `height` | **仅图片有**，且百度不保证返回，拿不到时为 `null` |
| `ext` | 小写扩展名，不含点；无扩展名为空串 |
| `thumbSource` | `BAIDU`（官方缩略图）/ `LOCAL`（后端生成）/ `NONE`（都不可用） |
| `thumbnailable` | 是否值得请求 `/thumb`。文档、压缩包等为 `false`，前端应显示类型图标而不是发请求 |
| `missing` | 网盘上已找不到该文件（只在「只删网盘」的删除模式下为 `true`） |

### `GET /api/files`

查询参数：`page`(默认1) `size`(默认24，最大100) `q`(文件名模糊) `tag`(标签id，可重复) `favorite`(true/false) `kind`(`IMAGE`/`VIDEO`/`AUDIO`/`DOC`/`OTHER`，不传即全部) `sort`(`time_desc`|`time_asc`|`name_asc`|`name_desc`|`size_desc`|`size_asc`)

```json
{ "total": 128, "page": 1, "size": 24, "items": [ AssetDto ] }
```

`kind` 传了非法值 → `400`。

### `GET /api/files/kind-stats`

给类型筛选栏用的角标数据。顺序固定为 图片 / 视频 / 音频 / 文档 / 其他。

```json
{
  "total": 128,
  "kinds": [
    { "kind": "IMAGE", "label": "图片", "count": 96 },
    { "kind": "VIDEO", "label": "视频", "count": 12 },
    { "kind": "AUDIO", "label": "音频", "count": 0 },
    { "kind": "DOC",   "label": "文档", "count": 18 },
    { "kind": "OTHER", "label": "其他", "count": 2 }
  ]
}
```

### `GET /api/files/{id}`

单个 `AssetDto`。404 → `{"error":"NOT_FOUND","message":"文件不存在"}`

### `GET /api/files/{id}/thumb`

返回缩略图二进制。后端优先代理百度官方缩略图，不可用时按需生成并缓存。
响应头带 `Content-Type`、`Cache-Control: private, max-age=86400`、`X-Thumb-Source: BAIDU|LOCAL`。
对 `thumbnailable=false` 的类型返回 `415` → `{"error":"NO_THUMBNAIL","message":"「DOC」类型没有缩略图，请使用类型图标"}`

### `GET /api/files/{id}/raw`

返回原文件二进制，后端代理。透传 `Range`，支持断点与拖动。
加 `?download=1` 会带上 `Content-Disposition: attachment`（文件名按 RFC 5987 用 UTF-8 编码），让浏览器存盘而不是内联打开。

**视频/音频直接把本接口当 `<video>` / `<audio>` 的 `src` 用即可**，不要先用 `fetch` 转成 blob——
blob 会强制先把整个文件下载完，进度条就没法拖了。浏览器会自动对本接口发 `Range` 请求分片拉取。
响应带 `Accept-Ranges: bytes`，实测首段 / 中间段 / 尾段都返回正确的 `206` 与 `Content-Range`。

错误 `503` → `{"error":"TOKEN_EXPIRED","message":"百度网盘授权已失效，请重新授权"}`
错误 `502` → `{"error":"UPSTREAM_FAILED","message":"..."}`

> 拿不到响应体的问题：`<video>` / `<audio>` 的 `error` 事件读不到响应体，
> 所以播放器在出错时会额外发一个 `Range: bytes=0-1023` 的请求去读上面这段 JSON，
> 正常情况只会返回 206 而不是错误，代价很小。

### `POST /api/files/upload` / `POST /api/images/upload`

`multipart/form-data`。字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `file` | 是 | 文件本体。**Cloudflare 版一次只能传一个**（多文件请在前端循环）；自建版可重复传多个 |
| `blockMd5` | 否 | 客户端算好的分片 MD5，JSON 数组，顺序即 partseq。见下 |

`/api/files/upload` 接受任意类型；`/api/images/upload` 只接受图片，非图片会被逐个拒绝并提示去哪传。

**关于 `blockMd5`**：百度要求普通用户按 4MB 切片并提交每片 MD5。
自建版服务端可以自己算，不传这个字段也完全正常；
**Cloudflare 版必须由客户端提供** —— Free 套餐的 CPU 预算算不动 4MB 的 MD5
（实测约三分之一请求超限）。前端为了同时兼容两者会统一带上，两个版本结果一致。

传了不合法的值会被忽略并回退到服务端计算；片数与文件大小不符会返回 `31363`。
伪造 MD5 不会产生损坏的文件 —— `superfile2` 会返回分片的真实 MD5，服务端会比对，对不上直接失败。

响应 `200`：`{ "uploaded": [ AssetDto ], "failed": [ { "name":"a.jpg", "reason":"..." } ] }`
错误 `503`（未授权）、`507`（网盘容量不足，百度 errno -10）。

### `PATCH /api/files/{id}`

请求：`{ "name": "新名字.md" }`
响应 `200`：更新后的 `AssetDto`

改了扩展名会重算 `kind` 和 `mime`（例如 `.txt` 改成 `.png` 后 `kind` 变成 `IMAGE`）。
错误 `409` 同名冲突、`400` 非法文件名（含 `/ \ : * ? " < > |`）。

### `PATCH /api/files/{id}/favorite`

请求：`{ "favorite": true }` → 响应 `200`：`AssetDto`

### `DELETE /api/files/{id}?mode=index|remote|both`

- `index`（默认）：只删本地索引，网盘文件保留
- `remote`：只删网盘文件，保留索引并置 `missing=true`
- `both`：两边都删

响应 `200`：`{ "deleted": "both", "remoteDeleted": true, "indexDeleted": true }`

### `POST /api/files/{id}/tags`

请求：`{ "tagIds": [1,2] }` → 全量覆盖该文件的标签。响应 `200`：`AssetDto`

### `POST /api/files/sync`

同步网盘索引。**会索引基础目录下的所有文件，不再只索引图片。** 请求可选：`{ "dir": "/apps/picman" }`

```json
{ "scanned": 128, "added": 5, "updated": 3, "removed": 0, "failed": 0, "elapsedMs": 2140 }
```

**同步可能是分批的。** 响应里可能带 `processed` 与 `nextOffset` 两个字段：

```json
{ "scanned": 128, "added": 5, "updated": 3, "removed": 0, "failed": 0, "elapsedMs": 980,
  "processed": 30, "nextOffset": 30 }
```

`nextOffset` 为 `null`、或响应里没有这两个字段，都表示同步已完整跑完；否则要把
`nextOffset` 作为请求体的 `offset` 再调一次，直到它变成 `null`。分批时每次调用都会
重新扫描目录，`added` / `updated` / `removed` / `failed` 是本次调用的增量，累加才是
整次同步的结果；`removed`（缺失标记）只在最后一轮返回。前端已按这个协议自动续接，
手写调用时才需要注意。

---

## 4. 标签

### `GET /api/tags`

```json
[ { "id": 1, "name": "风景", "color": "#409EFF", "count": 12 } ]
```

### `POST /api/tags`

请求：`{ "name": "风景", "color": "#409EFF" }` → 响应 `201`：`{ "id":1,"name":"风景","color":"#409EFF","count":0 }`
错误 `409`：同名标签已存在。

### `PATCH /api/tags/{id}`

请求：`{ "name": "...", "color": "..." }` → 响应 `200`。

### `DELETE /api/tags/{id}`

响应 `204`，同时解除与图片的关联。

---

## 5. 系统

### `GET /api/system/info`

```json
{
  "version": "1.0.0",
  "baseDir": "/apps/picman",
  "cacheDir": "/data/cache",
  "cacheSizeBytes": 10485760,
  "dbPath": "/data/picman.db",
  "assetCount": 128,
  "imageCount": 96,
  "kindCounts": { "IMAGE": 96, "VIDEO": 12, "AUDIO": 0, "DOC": 18, "OTHER": 2 },
  "tagCount": 7
}
```

`assetCount` 是全部文件数；`imageCount` 保留是为了兼容旧前端，等于 `kindCounts.IMAGE`。
`kindCounts` 里每种类型都存在，没有的补 0，前端不用做「键不存在」判断。

### `POST /api/system/cache/clear`

清空本地缩略图缓存。响应 `204`。
