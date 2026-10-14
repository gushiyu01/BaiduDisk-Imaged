# PicMan on Cloudflare Workers

把 PicMan 用 Cloudflare 全家桶重新实现的一版，参考 Telegraph-Image 那种「纯边缘、无服务器」的路子。
和自建版（`self-hosted/`）功能对应，但**是独立部署、独立数据库**，两者不共享数据。

线上地址：`https://picman.gushiyu-picman.workers.dev`（自定义域名可随时在控制台绑）

本目录包含 Worker 代码（`worker/`）、前端（`frontend/`）和一键部署脚本（`deploy.mjs`）。
`frontend/` 与 `self-hosted/frontend/` 是同一份代码的两份拷贝，改完记得用
`node tools/check-frontend-sync.mjs` 检查两份是否一致。

---

## 架构

```
浏览器 ──► Cloudflare Worker「picman」
              ├── /api/*        业务路由
              └── 其余路径       静态资源绑定 → 前端构建产物（同源，无 CORS）
                     │
                     ├── D1            数据库（就是 SQLite，schema 与自建版一致）
                     ├── KV            缩略图缓存
                     └── Durable Object 百度令牌的唯一持有者
                              │
                              └──► 百度网盘开放平台
```

| 组件 | 用途 | 为什么这么选 |
| --- | --- | --- |
| **Workers** | API + 托管前端 | 一次部署、同源、不用单独开 Pages |
| **D1** | 元数据 | 本身就是 SQLite，`schema.sql` 几乎原样复用 |
| **KV** | 缩略图缓存 | 缩略图几 KB，KV 足够；R2 需要单独在控制台开通 |
| **Durable Object** | 百度令牌 | **必需**，见下 |
| **Web Crypto** | PBKDF2 + HMAC-SHA256 | Workers 没有 BCrypt，用平台原生的 |

### 为什么令牌非要放进 Durable Object

百度的 `refresh_token` 是**一次性**的，用掉就作废，而刷新失败会让它永久失效、用户必须重新授权。

Workers 是全球多 isolate 并发、没有共享锁。两个 isolate 同时刷新 → 后一个用已作废的 token →
授权彻底丢失。Durable Object 全局单实例，把令牌读写收敛进去从根上避免这个问题。

**还有一个更隐蔽的坑**：DO 虽然是单线程的，但 `await fetch(...)` 会让出控制权，
所以并发请求依然可能同时走到刷新分支。`token-object.ts` 里额外用了一个 Promise 合并，
保证同一时刻只有一个真正的刷新请求在飞。

---

## 实测出来的三个硬约束

这些不是猜的，是在这个账户（**Free 套餐**）上真实部署探针测出来的。
探针代码保留在 git 历史里，方法可以复现。

### 1. Free 套餐的 CPU 预算算不动 4MB 的 MD5

| 操作 | 实测结果 |
| --- | --- |
| 空请求 | 100% 成功 |
| 纯 JS 计算 **≤3MB** 的 MD5 | 36/36 成功 |
| 纯 JS 计算 **4MB** 的 MD5 | **约 1/3 请求返回 1102（CPU 超限）** |
| 一次请求烧 CPU 循环 1 亿次 | 成功 |
| 一次请求烧 CPU 循环 1.5 亿次 | 1102 超限 |

而百度要求普通用户**必须按 4MB 切片**并提交每片 MD5 —— 也就是说服务端算 MD5 这条路在
Free 套餐上根本不可靠。

**解法：把 MD5 移到浏览器。** 浏览器没有 CPU 限制，算 100MB 也就一秒左右。
客户端算好 `blockMd5`（JSON 数组）随表单提交，Worker 只负责转发给百度。

这不会导致作弊：百度 `superfile2` 会返回分片的**真实 MD5**，Worker 拿它和客户端声明的值比对，
对不上直接报错。所以伪造 MD5 只会让上传失败，不会产生损坏的文件。

> 试过用 WASM（`hash-wasm`）在 Worker 里算 MD5：**在 Node 里正常，在 Workers 里直接挂死**
> （连 0.1MB 的数据都 60 秒不返回）。所以只能走客户端。
> 想要服务端算，出路是升 Workers Paid（CPU 上限从「秒级突发」变成 30 秒）。

### 2. 没有 R2，缩略图用 KV

R2 需要先在控制台手动开通（API 报 `Please enable R2 through the Cloudflare Dashboard`）。
KV 完全够用：单值上限 25MB，缩略图才几 KB。缓存键带 md5/修改时间做版本号，网盘文件变了自动失效。

### 3. Worker 里没有图片处理能力

自建版用 ImageIO 本地生成缩略图，Worker 里没有等价物（Cloudflare Images 需要可公网抓取的源，
而百度 dlink 有防盗链要求 UA 必须是 `pan.baidu.com`，抓不到）。所以：

- **优先用百度官方缩略图**（`filemetas` 带 `thumb=1`）—— 绝大多数图片都有
- 官方图不可用时，**把原图当缩略图返回**让浏览器自己缩放；超过 10MB 的会拒绝并说明原因
- 与自建版的差异：自建版能对任意图片本地生成缩略图，这里做不到

---

## 与自建版的接口差异

只有两处，都是为了绕开上面的 CPU 限制：

| 接口 | 自建版 | Cloudflare 版 |
| --- | --- | --- |
| `POST /api/files/upload` | 一次可传多个文件 | **一次一个文件**（多文件在前端循环），这样进度和失败原因能精确到单个文件 |
| 上传表单字段 | 只有 `file` | 多了 **`blockMd5`**（JSON 数组，客户端算好的分片 MD5） |

其余接口路径、请求体、响应体与 `docs/API.md` **完全一致**，所以前端基本不用改（只有上传那两处适配）。

新增一个迁移接口：

```
POST /api/baidu/import-refresh-token   { "refreshToken": "122.xxx" }
```

从自建版搬家过来时用。**注意百度的 refresh_token 是一次性的，用掉之后旧部署那份就作废了** ——
这是「搬家」而不是「复制」。

---

## 部署

### 一条命令（推荐）

```bash
git clone <本仓库> && cd mobile
npm --prefix cloudflare/worker install

export CLOUDFLARE_API_TOKEN=你的Token      # 需要 D1 / Workers / KV 权限
export CLOUDFLARE_ACCOUNT_ID=你的账户ID
export HTTPS_PROXY=http://127.0.0.1:7897   # 国内必须，直连 api.cloudflare.com 会被阻断

node cloudflare/deploy.mjs
```

脚本会把整条链路跑完，而且**可重复执行**（已存在的资源复用，不会重建）：

1. 校验凭证，看不到指定账户会直接报错并列出实际可见的账户
2. 创建 D1 `picman` 与 KV `picman-cache`（已存在则复用），把 id 回填进 `wrangler.toml`
3. 初始化 D1 表结构
4. 构建前端（Worker 的静态资源绑定要用）
5. 从 `.dev.vars` → 项目 `.env` → 用户主目录 `.env` 里找百度凭证并下发为 secret
6. 部署并打印访问地址

百度凭证没找到时会跳过并提示，之后可以手动补：

```bash
cd cloudflare/worker
npx wrangler secret put BAIDU_DISK_APP_KEY
npx wrangler secret put BAIDU_DISK_SECRET_KEY
```

### 手动分步

<details>
<summary>不想用脚本的话，展开看原始步骤</summary>

```bash
cd cloudflare/worker
npm install

export CLOUDFLARE_API_TOKEN=你的Token
export CLOUDFLARE_ACCOUNT_ID=你的账户ID

# 建资源，把返回的 id 填进 wrangler.toml
npx wrangler d1 create picman
npx wrangler kv namespace create CACHE

# 建表
npx wrangler d1 execute picman --remote --file=./src/db/schema.sql

# 下发百度凭证（不要写进 wrangler.toml）
npx wrangler secret put BAIDU_DISK_APP_KEY
npx wrangler secret put BAIDU_DISK_SECRET_KEY

# 构建前端 + 部署
# 前端在 cloudflare/frontend（与 self-hosted/frontend 是同一份代码的两份拷贝）
cd ../frontend && npm ci && npm run build && cd ../worker
npx wrangler deploy
```

</details>

### 部署之后

1. 打开 `https://picman.<你的子域名>.workers.dev`，按引导创建管理员账号（没有内置默认口令）
2. 到「百度网盘」页点「开始授权」，走一遍 OAuth
3. 点「同步索引」把网盘里的文件导入

**绑自定义域名**：控制台 → Workers & Pages → picman → Settings → Domains & Routes → Add custom domain。
绑之前要先把域名托管到 Cloudflare 并加好 DNS 记录，否则域名不解析。

> **国内访问提醒**：`*.workers.dev` 在国内直连会被阻断（TCP 连不上，走代理才通）。
> 想让它在国内能直接打开，得绑一个走 Cloudflare 且线路可用的自有域名。

### 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填百度凭证，这个文件已 gitignore
npm run db:init:local
npm run dev
```

---

## 环境变量与密钥

| 名字 | 类型 | 说明 |
| --- | --- | --- |
| `BAIDU_DISK_APP_KEY` | **secret** | 百度开放平台 AppKey |
| `BAIDU_DISK_SECRET_KEY` | **secret** | 百度开放平台 SecretKey |
| `BAIDU_DISK_APP_ID` | secret（可选） | AppID，仅记录用 |
| `BAIDU_BASE_DIR` | vars | 图库在网盘上的根目录，默认 `/apps/picman` |
| `PICMAN_SESSION_HOURS` | vars | 登录有效期，默认 168 小时 |
| `picman.jwt_secret` | D1 | 会话签名密钥，**首次启动自动生成**，不用手工准备 |

会话签名密钥不放在环境变量里，而是首启动随机生成写进 D1 的 `system_config`，
这样部署时少一个 secret，重启也不会让已登录用户掉线。

---

## 安全边界

- 百度令牌只存在 Durable Object 里，前端拿不到；会话用 HttpOnly + SameSite=Lax Cookie
- **原文件下载（`/raw`）不让浏览器按上游类型渲染**：Content-Type 只按扩展名表推断并禁用嗅探，
  只有图片（不含 SVG）/视频/音频/PDF 允许内联，其余一律 `Content-Disposition: attachment`。
  否则网盘里一个 HTML 文件被打开时，它的脚本就在本应用的同源下执行，
  拿着用户的会话可以调用全部管理接口。代价是 txt/md/json 这类文本文件会变成下载
- dlink / 缩略图地址走**主机白名单**校验，且**重定向每一跳都校验**，防 SSRF
- 登录用 PBKDF2-SHA256（10 万次迭代）+ 定长比较
- 用户不存在与密码错误返回同样的提示，不泄漏账号是否存在
- 所有密钥走 `wrangler secret`，`.dev.vars` 已 gitignore，仓库里没有任何真实密钥

## 已知限制

- **Free 套餐**：D1 上限 500MB、KV 每天 1000 次写、Workers 每天 10 万请求。
  图库很大或访问量高时需要升级套餐。
- **每次 Worker 调用只有 50 次 D1 查询**（D1/KV 调用同时计入每请求 50 个 subrequest 的额度），
  所以同步索引是分批的：一次最多 30 个文件，前端自动带 `offset` 续接。
  上千个文件需要几十次请求，网速正常时约一分钟。这个上限是按「batch 内每条语句也算一次查询」
  的最坏口径取的，宁可多跑几轮也不中途撞限额 —— 已确认账号上 batch 的计数口径后可以放大
- **KV 写缓存失败不影响功能**：缩略图已经取到就照常返回，只是下次还要实时取。
  每日 1000 次写的额度打满后，图库会变慢但不会打不开
- **上传单文件上限 100MB**（Cloudflare 请求体限制，Free/Pro 档）。
  超过需要分多次传（前端可以按 4MB 分片走多请求，目前没实现）。
- **没有本地缩略图生成**，见上文。
- **体检（diagnose）是只读的**，不含上传自测 —— 因为上传需要客户端提供 MD5，
  服务端无法自测。这一项在体检结果里如实标 SKIP。
- 与自建版**不共享数据库**：标签、收藏、索引都是各自独立的。
