# PicMan · 百度网盘私人图床（Cloudflare Workers 版）

**把百度网盘变成你自己的图床**：注册一个百度网盘开放平台开发者应用，网页上上传的图片就存在**你自己的网盘**里，
不会流到任何第三方服务器；配一套完整的网页图库，浏览、搜索、打标签、收藏、重命名、删除都在网页上完成。

思路参考 **Telegraph-Image** / **Cloudflare 图床** 这类项目 —— 后端全部跑在 Cloudflare 上（Workers + D1 + KV），
不用买服务器、不用备案，**Free 套餐就能跑**。区别只在存储：不用 R2、不用第三方图床，落到你自己的百度网盘。

> Cloudflare Workers · Vue 3 · 单管理员 · MIT

<!-- 截图位：截好后放到 cloudflare/screenshots/ 并取消注释，图片的展示效果对推广很重要
![图库](screenshots/gallery.png)
![文件管理](screenshots/files.png)
-->

---

## 它是什么

一句话：**一个网页版图库，存储后端是你的百度网盘。**

| | |
| --- | --- |
| 存储 | 你自己的百度网盘（`/apps/picman` 目录），容量看你网盘 |
| 元数据 | Cloudflare D1（SQLite）：标签、收藏、索引、账号 |
| 后端 | Cloudflare Workers，全球边缘运行，不用服务器 |
| 前端 | Vue 3 + Element Plus，图库 / 文件 / 标签 / 网盘 四个页面 |

数据边界分得很清楚：**原图永远只在你的网盘里**，Cloudflare 侧只有元数据和几 KB 的缩略图缓存。
哪天不想用了，断开授权，网盘里的文件原封不动。

## 网页上能做什么

- **图库**：网格 / 瀑布流两种视图，灯箱预览（滚轮 / 双击缩放、拖拽、键盘翻页、上一张下一张），按文件名搜索，按时间 / 名称 / 大小排序，按标签筛选，只看收藏
- **文件管理**：表格视图，按类型（图片 / 视频 / 音频 / 文档 / 其他）筛选并显示数量，下载、收藏、重命名、编辑标签、删除
  —— 删除可选「只删索引 / 只删网盘文件 / 两边都删」，默认只删索引，不会悄无声息地删掉网盘里的原文件
- **上传**：图库页拖拽 / 多选传图片，文件页可传任意类型的文件；上传完自动写进网盘并刷新列表
  （切片 MD5 在浏览器算好再提交，原因见下文）
- **在线播放**：视频、音频直接用 `/raw` 流式播放（支持 Range，可拖动进度条），不必先下载
- **标签**：新建 / 改名 / 换色 / 删除，删除标签不会连累图片
- **百度网盘页**：授权状态（百度账号、令牌有效期、基础目录）、OAuth 授权 / 重新授权 / 断开授权、指定目录同步索引、接口体检（逐项实测百度接口通不通）
- **安全**：首启动引导创建管理员（无内置默认口令）、PBKDF2 存密码、HttpOnly 会话 Cookie、改密码；
  AppKey / SecretKey / 百度令牌只存在于 Worker 侧的 Secret 和 Durable Object 里，浏览器拿不到
- 响应式布局，手机上也能正常用

## 你的数据存在哪

| 数据 | 存在哪 | 说明 |
| --- | --- | --- |
| 原图 / 视频 / 文件 | **你的百度网盘** `/apps/picman` | 上传即写入网盘（网盘里显示为「我的应用数据 / picman」），本项目不往别处复制 |
| 标签 / 收藏 / 索引 / 管理员账号 | Cloudflare D1 | 只有元数据；这份丢了，重新「同步索引」即可从网盘恢复 |
| 缩略图缓存 | Cloudflare KV | 几 KB 的缓存，可随时清空，网盘文件变了自动失效 |
| AppKey / SecretKey / 百度令牌 | Worker Secret / Durable Object | 前端和浏览器接触不到 |

## 和 Telegraph-Image 这类 Cloudflare 图床比

| | Telegraph-Image / 常见 CF 图床 | PicMan（本项目） |
| --- | --- | --- |
| 图片存哪 | Telegraph / R2 / 第三方图床 | **你自己的百度网盘** |
| 容量 | 看对方规则，或按量付费 | 你的网盘套餐说了算 |
| 失效风险 | 对方改规则、下线、被清图，全得跟着搬 | 项目不维护了，图也还在网盘里 |
| 使用方式 | 上传换链接为主 | 完整图库：浏览、搜索、标签、收藏、批量管理 |
| 适合谁 | 想公开分享图片 | 想把自己网盘里的图片 / 视频管起来，网页上随时看 |

本项目**没有**公开外链分享：所有页面和文件访问都需要登录，定位是「私人图床 / 私人图库」，
不做游客访问、不做热链托管。

## 架构

```
浏览器 ──► Cloudflare Worker「picman」（同源托管前端，无 CORS）
              ├── /api/*          业务路由
              ├── D1              元数据（就是 SQLite）
              ├── KV              缩略图缓存
              └── Durable Object  百度令牌的唯一持有者（refresh_token 一次性，必须串行刷新）
                       │
                       └──► 百度网盘开放平台（OAuth 授权 + 上传 / 下载 / 列目录 / 删除）
```

几个绕不开的设计取舍（都有实测依据，来龙去脉见 [`README-TECH.md`](README-TECH.md)）：

- **MD5 放在浏览器算**：百度要求上传按 4MB 切片并提交每片 MD5，而 Workers Free 套餐算 4MB 的 MD5 会随机撞 CPU 限制（实测约 1/3 请求 1102 报错）。浏览器算完随表单提交，服务端只转发，且用百度返回的真实 MD5 复核，伪造只会让上传失败。
- **令牌必须进 Durable Object**：百度的 `refresh_token` 用一次就作废，Workers 多 isolate 并发刷新会互相作废、导致授权彻底丢失。全局单实例的 DO 把令牌读写收敛掉，再加 Promise 合并挡住并发刷新。
- **缩略图用 KV 不用 R2**：优先取百度官方缩略图，没有就退回原图让浏览器缩放，顺手缓存在 KV 里。

## 快速开始

### 你只需要亲自办 ①②，剩下交给 AI Agent

只有「注册百度开发者应用」和「申请 Cloudflare Token」需要你本人操作；
部署本身（建资源、建表、构建前端、下发密钥、上线）全部由脚本完成 —— 把下面那段话复制给你的 AI Agent 就行。

#### ① 注册百度网盘开放平台开发者，创建应用（一次性）

图片最终写进**这个账号的网盘**，所以直接用你平时存图的百度账号：

1. 登录[百度网盘开放平台](https://pan.baidu.com/union) → 「申请接入」，同意开发者协议，按提示完成**实名认证**
   （个人开发者：身份证号 + 手机号 / 邮箱，官方称可立即完成；个人账号可创建 1 个应用）
2. 打开[控制台](https://pan.baidu.com/union/console/applist) → 「创建应用」：
   - **应用用途选「个人使用」**：免审核、创建后直接上线，限 10 个授权用户（本项目就是单管理员自用，够）
   - **应用名称建议就填 `picman`**：这个名字会成为网盘里的 `/apps/picman` 目录（网盘里显示为「我的应用数据 / picman」），
     正好和后端默认的 `BAIDU_BASE_DIR` 对上；想用别的名字，就把 `cloudflare/worker/wrangler.toml` 里的 `BAIDU_BASE_DIR` 一起改掉
   - 应用类型选「软件」；应用名称 0~12 字、描述按页面要求写够即可
3. 创建完进「应用详情页」，复制 **AppID、AppKey、SecretKey** 三个值（页面上还有第四个 SignKey，本项目用不到），后面写进 `.env`
4. **不用配置回调地址**：本项目授权统一用 `redirect_uri=oob`（百度授权页直接把授权码显示出来，你复制粘贴回来），
   这是百度官方文档示例本身采用的方式，也就不依赖任何公网回调

> 接入的就是百度官方开放平台，和你挂 AList 用的是同一套「注册应用 → OAuth 授权 → 读写自己网盘的 `/apps` 目录」。
> 留意官方对**未通过「上线审核」**的应用有试用口径（文档里给的是 10 次/小时、最多 10 个授权用户），
> 「个人使用」应用是否套用这个频率限制文档没有写死；自用若遇到 `20012`（访问超限）一类的报错，去开放平台控制台申请提额即可。

#### ② 申请一个 Cloudflare API Token（一次性，约 2 分钟）

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com) → 右上角头像 → **My Profile** → **API Tokens** → **Create Token**
2. 用 **Edit Cloudflare Workers** 模板，再把权限补齐：`Workers Scripts: Edit`、`D1: Edit`、`Workers KV Storage: Edit`（部署脚本要创建 / 复用 D1 和 KV）
3. 创建后复制 Token（只显示这一次）；**Account ID** 在控制台域名列表右侧栏或者 Workers 概览页可以复制

#### ③ 把凭证写进 `.env`，让本地 AI Agent 执行部署

在项目根目录（`mobile/`）建一个 `.env`（已在 `.gitignore` 里，不会进仓库）：

```bash
CLOUDFLARE_API_TOKEN=你的Token
CLOUDFLARE_ACCOUNT_ID=你的AccountID
BAIDU_DISK_APP_ID=你的AppID
BAIDU_DISK_APP_KEY=你的AppKey
BAIDU_DISK_SECRET_KEY=你的SecretKey
```

然后把这个仓库（或压缩包）交给你本地的 AI Agent（ZCode / Claude Code / Cursor / Codex 都行），粘贴这段话：

```
帮我部署这个仓库里的 PicMan（Cloudflare Workers 版，代码在 cloudflare/ 目录）。

凭证已经写在项目根目录的 .env 里：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、
BAIDU_DISK_APP_ID、BAIDU_DISK_APP_KEY、BAIDU_DISK_SECRET_KEY。

请按下面执行：
1. 把 .env 里的变量导出为环境变量（deploy 脚本只从进程环境变量读 Cloudflare 凭证）；
2. 如果在国内，直连 api.cloudflare.com 会被阻断，需要先 export HTTPS_PROXY=http://127.0.0.1:7890
   （端口以我本机代理为准，可以问我）；
3. 执行 npm --prefix cloudflare/worker install；
4. 执行 node cloudflare/deploy.mjs —— 它会一次跑完：创建/复用 D1 和 KV → 建表 → 构建前端 →
   下发百度凭证为 secret → 部署 Worker，最后打印访问地址；
5. 把访问地址告诉我。中途报错就对照 cloudflare/README-TECH.md 的「部署」一节排查后重试。
```

<details>
<summary>不想用 Agent，手动跑（就是上面那几条命令）</summary>

```bash
git clone https://github.com/gushiyu01/BaiduDisk-Imaged.git && cd BaiduDisk-Imaged
npm --prefix cloudflare/worker install

export CLOUDFLARE_API_TOKEN=你的Token
export CLOUDFLARE_ACCOUNT_ID=你的账户ID
export BAIDU_DISK_APP_ID=你的AppID
export BAIDU_DISK_APP_KEY=你的AppKey
export BAIDU_DISK_SECRET_KEY=你的SecretKey
export HTTPS_PROXY=http://127.0.0.1:7890      # 国内直连 api.cloudflare.com 会被阻断

node cloudflare/deploy.mjs
```

脚本可重复执行：已存在的 D1 / KV 会复用不会重建。分步部署（不用脚本）见
[`README-TECH.md`](README-TECH.md#手动分步)。
</details>

### 部署完的三步

1. 打开脚本打印的 `https://picman.<你的子域名>.workers.dev`，按引导创建管理员账号（没有内置默认口令）
2. 进「百度网盘」页 → 「开始授权」→ 在新窗口完成百度授权后，把页面显示的**授权码**粘贴回来 → 授权成功
3. 同页点「同步索引」，把网盘里已有的文件收进图库（一次最多处理一批，前端会自动续接；文件多就多等一会儿）

> **国内访问提醒**：`*.workers.dev` 在国内直连被阻断，想在国内直接打开，需要绑一个走 Cloudflare 且线路可用的自有域名
> （控制台 → Workers & Pages → picman → Settings → Domains & Routes → Add custom domain）。
> 或者改用本仓库里的 [`self-hosted/`](../self-hosted/README.md) 版，跑在自己的机器 / VPS 上。

## 常见问题

**图片能生成外链分享给别人吗？**
暂时不能，所有图片和页面都要求登录。这既是产品定位（私人图库），也是合规边界：百度开放平台的《使用规范》明确禁止
把个人网盘账号用于面向公众的图床、建站一类的产品行为，公开分享型用法请另找别家。自己多设备查看，登录同一套账号即可。

**网盘里早就有一堆图，要重新上传吗？**
不用。「同步索引」会把网盘目录（默认 `/apps/picman`，可指定）里已有的文件扫描进图库，原文件不动。

**超过 100MB 的大文件怎么办？**
网页上传单文件上限约 100MB（Cloudflare 请求体限制）。大视频可以先用百度网盘客户端丢进 `/apps/picman`，
再点「同步索引」，之后在网页里就能直接播放 / 下载。

**Free 套餐够用吗？**
个人自用够：D1 500MB 元数据、KV 免费额度每天 1000 次写（打满后缩略图变慢，但功能不受影响）、
Workers 每天 10 万请求。图库特别大或访问量高再考虑升级（$5/月更宽裕）。

**这是不是「白嫖百度网盘」？会不会有风险？**
走的是百度官方开放平台的正规授权：自己注册的应用、自己点 OAuth 授权、只读写自己网盘里的应用目录，
和个人自用 AList 是同类用法。但有三点要说清楚：

1. 平台的《使用规范》禁止把个人网盘账号用于**面向公众**的图床 / 建站等产品行为，也禁止多人共享一套开发者凭证
   —— 本项目默认就是「单管理员、无公开外链、无游客访问」的自用形态，请保持这个用法
2. 官方对未通过「上线审核」的应用有频率与用户数的试用口径（见上文①的说明），撞到限额（`20012` / `20011`）去控制台申请提额
3. 条款、限流、风控都由百度定义且可能变化，本项目不对账号安全做任何承诺，请自行评估、正常强度使用

**密钥安全吗？**
AppKey / SecretKey 以 Cloudflare secret 下发；百度的访问令牌只存在 Durable Object 里，浏览器拿不到；
登录用 HttpOnly Cookie；原始文件下载做了类型白名单和防嗅探（HTML / SVG 一律不内联）。
仓库里不含任何真实密钥（自查过，只有 `.example`）。

**有 API 吗？能接自己的前端吗？**
有。前后端完全分离，接口契约在 [`docs/API.md`](../docs/API.md)，两套后端（Cloudflare / 自建）路径与报文完全一致。

**为什么上传非要浏览器算 MD5？**
百度要求上传按 4MB 切片、每片都要 MD5，而 Cloudflare Workers Free 套餐算 4MB 的 MD5 会随机撞 CPU 限制。
搬到浏览器算就没有这个限制，服务端还会用百度返回的真实 MD5 复核，安全上没有让步。

**授权会过期吗？需要多久重新授权一次？**
百度的 access_token 30 天有效、refresh_token 一次一换，Worker 会自动续期（放在 Durable Object 里串行处理，
避免并发刷新把授权弄丢，见上文架构），一般不需要你手动重新授权。除非你在百度账号里主动撤销了这个应用。

## 已知限制（先说清楚）

- **单用户**：只有一个管理员账号，没有注册 / 多用户 / 权限体系
- **没有公开外链**：图片和页面都要登录，不做游客访问和热链托管
- **网页上传单文件 ≤ 100MB**（Cloudflare 请求体限制），更大的文件「先用网盘客户端放进去，再同步索引」
- **缩略图依赖百度官方缩略图**，官方没有的就用原图兜底（自建版能本地生成，这版不能）
- **同步索引是分批的**：一次最多扫 30 个文件，前端自动续接，上千个文件要跑一会儿
- **Free 套餐有日额度**（见 FAQ），重度使用建议上 $5/月

完整清单和每个限制的实测依据见 [`README-TECH.md`](README-TECH.md#已知限制)。

## 同仓库的另一个版本：`self-hosted/`

同一套功能、同一个前端，另有 **Spring Boot 3 + SQLite/MySQL + Docker** 的自建版：
不想依赖 Cloudflare / 想跑在境内服务器（无需绑域名走 CF）、想用 MySQL 的话选它。

| | `cloudflare/`（本目录） | `self-hosted/` |
| --- | --- | --- |
| 部署 | `node deploy.mjs`，Free 套餐可跑 | `docker compose up -d` |
| 成本 | 0 元起 | 一台机器 / VPS |
| 数据库 | D1 | SQLite 或 MySQL |
| 缩略图 | 百度官方缩略图 + 原图兜底 | 本地 ImageIO 生成 |
| 国内访问 | workers.dev 被阻断，需自有域名 | 直接访问 |

两边**数据互不相通**，各自独立授权（百度 `refresh_token` 是一次性的，从一边「搬家」到另一边见
[`README-TECH.md`](README-TECH.md#与自建版的接口差异)）。总览见[仓库根 README](../README.md)。

## 目录结构

```
mobile/
├── cloudflare/             ← 本目录
│   ├── deploy.mjs            一键部署脚本
│   ├── worker/               Cloudflare Worker（TypeScript，API + 静态托管）
│   ├── frontend/             Vue 3 前端（与 self-hosted 共用同一份代码的两份拷贝）
│   └── README-TECH.md        技术档案：架构取舍、实测踩坑、部署分步、已知限制
├── self-hosted/            Spring Boot 3 自建版
├── tools/                  命令行工具（百度接口验证、前端同步检查等）
└── docs/                   接口契约（API.md）
```

## 参考与致谢

- [Telegraph-Image](https://github.com/cf-pages/Telegraph-Image)：Cloudflare Workers 图床的经典实现，「纯边缘、无服务器」的思路就是照它来的
- [百度网盘开放平台](https://pan.baidu.com/union)：存储能力与 OAuth 授权
- Cloudflare Workers / D1 / KV / Durable Objects
- Vue 3 + Element Plus
- 感谢 [linux.do](https://linux.do) 社区

## 反馈与交流

在 [linux.do](https://linux.do) 帖子里回帖，或到仓库提 Issue / PR 都可以。
如果这个项目对你有用，欢迎点个 Star；部署过程中卡在哪一步，也欢迎把报错贴出来。
（部署脚本对常见坑（代理、凭证找不到、D1/KV 限额）都有提示，配合 Agent 一般能自己走完。）

## 许可

[MIT](../LICENSE)
