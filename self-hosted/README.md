# PicMan · 自建版（Spring Boot + Vue）

自托管的图片管理器：图片存在你自己的百度网盘里，元数据（标签、收藏、索引）存在本地 SQLite。
后端代理百度网盘开放平台的全部调用，浏览器和前端**永远接触不到** AppKey、SecretKey 和访问令牌。

```
┌──────────────┐   同源 /api    ┌─────────────────┐   HTTPS   ┌──────────────┐
│  浏览器      │ ─────────────► │ Spring Boot 3   │ ────────► │ 百度网盘      │
│ Vue3 + TS    │ ◄───────────── │ SQLite + 缓存   │ ◄──────── │ 开放平台 API  │
└──────────────┘   缩略图/原图  └─────────────────┘           └──────────────┘
                                  ▲ 唯一持有令牌的地方
```

---

## 一、快速开始（Docker Compose）

```bash
git clone <本仓库> picman && cd picman
cp .env.example .env
# 编辑 .env，至少填入百度网盘开放平台的三个凭证
docker compose up -d --build
```

打开 `http://<主机IP>:8088`：

1. 首次访问会跳到**初始化页**，由你设置管理员用户名和密码（没有内置默认口令）。
2. 登录后进入「**百度网盘**」页 → 点「开始授权」→ 浏览器打开百度授权页 → 点「授权」→
   把页面上显示的**授权码**复制回来填入 → 提交。
3. 点「**同步索引**」，把网盘 `/apps/picman` 下的图片导入图库。

数据（SQLite 数据库 + 缩略图缓存）保存在 Docker volume `picman-data`，容器重建不会丢。

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `BAIDU_DISK_APP_ID` | ✅ | — | 开放平台应用详情页的 AppID |
| `BAIDU_DISK_APP_KEY` | ✅ | — | AppKey（OAuth 的 `client_id`） |
| `BAIDU_DISK_SECRET_KEY` | ✅ | — | SecretKey |
| `PICMAN_DB_MODE` | | `sqlite` | `sqlite` 或 `mysql`，见下方「换成 MySQL」 |
| `PICMAN_MYSQL_HOST` | | `127.0.0.1` | 仅 `mysql` 模式 |
| `PICMAN_MYSQL_PORT` | | `3306` | 仅 `mysql` 模式 |
| `PICMAN_MYSQL_DB` | | `picman` | 仅 `mysql` 模式 |
| `PICMAN_MYSQL_USER` | | `root` | 仅 `mysql` 模式 |
| `PICMAN_MYSQL_PASSWORD` | | 空 | 仅 `mysql` 模式 |
| `BAIDU_BASE_DIR` | | `/apps/picman` | 图库在网盘上的根目录 |
| `PICMAN_HTTP_PORT` | | `8088` | 前端对外端口 |
| `PICMAN_JWT_SECRET` | | 自动生成 | 会话签名密钥；留空则首启动随机生成并存入数据库 |
| `PICMAN_SESSION_HOURS` | | `168` | 登录有效期（小时） |
| `PICMAN_COOKIE_SECURE` | | `false` | 走 HTTPS 时设为 `true` |
| `PICMAN_THUMB_SIZE` | | `400` | 缩略图最长边（像素） |
| `PICMAN_DLINK_ALLOWLIST` | | `baidupcs.com,baidu.com,…` | 允许直连的下载主机后缀（SSRF 防护） |
| `BAIDU_SLICE_SIZE` | | `4194304` | 上传分片大小；普通用户必须 4MB |

> 只需要 `BAIDU_DISK_SIGN_KEY` 的场景本项目用不到，可以不配。

### 换成 MySQL（可选）

默认用 SQLite。要换成 MySQL：

```bash
# 新部署
PICMAN_DB_MODE=mysql docker compose --profile mysql up -d --build
```

**已有数据不要直接切库** —— 标签和收藏是纯本地数据，网盘上没有对应物，重新同步索引搬不过来。
完整的数据迁移步骤、建表语句的必要差异、以及 SQLite/MySQL 的行为差异见
[`../docs/MYSQL.md`](../docs/MYSQL.md)。项目里有 `../tools/MigrateSqliteToMysql.java` 负责搬迁，
它连授权令牌一起搬，迁完不用重新授权。

---

## 二、本地开发

需要 JDK 17、Maven 3.9+、Node 20+。

```bash
# 后端（默认 http://localhost:8080，数据落在 backend/data/）
cd backend
export BAIDU_DISK_APP_KEY=xxx BAIDU_DISK_SECRET_KEY=yyy BAIDU_DISK_APP_ID=zzz
mvn spring-boot:run

# 前端（http://localhost:5173，/api 已代理到 8080）
cd frontend
npm install
npm run dev
```

前端也可以只构建静态产物：`npm run build`，产物在 `frontend/dist`。

---

## 三、目录结构
```
self-hosted/
├── backend/                     Spring Boot 3.3 / JDK 17
│   ├── src/main/java/com/zcode/picman/
│   │   ├── baidu/               ★ 百度网盘开放平台的唯一封装层
│   │   │   ├── BaiduPanClient     所有百度调用的入口，业务代码不碰 HTTP
│   │   │   ├── BaiduHttp          传输层：超时、UA、重定向、SSRF 校验
│   │   │   ├── BaiduTokenStore    令牌存取与自动刷新（串行化）
│   │   │   ├── DlinkGuard         下载地址主机白名单
│   │   │   ├── BaiduErrno         错误码常量与中文释义
│   │   │   └── BaiduDtos          响应对象（按实测结构，非照抄文档）
│   │   ├── config/             配置、安全、存储路径、老库升级
│   │   ├── domain/             查询条件与表行对象
│   │   ├── repository/         JdbcTemplate 数据访问
│   │   ├── security/           会话令牌与 Cookie 过滤器
│   │   ├── service/            认证 / 文件 / 缩略图 / 同步 / 标签 / 诊断
│   │   ├── support/            DbDialect（SQLite/MySQL 方言）、FileKinds、MIME、异常
│   │   └── web/                REST 控制器与全局异常处理
│   └── src/main/resources/
│       ├── application.yml         公共配置
│       ├── application-sqlite.yml  SQLite 配置档（默认）
│       ├── application-mysql.yml   MySQL 配置档
│       ├── schema.sql              SQLite 建表
│       └── schema-mysql.sql        MySQL 建表
├── frontend/                    Vue 3 + TS + Vite + Element Plus
│   └── src/
│       ├── api/                client / auth / baidu / images / files / tags / system
│       ├── views/              GalleryView（图库）/ FilesView（文件库）/ Tags / Baidu / 登录 / 初始化
│       ├── components/         AssetGrid + AssetTile（网格/瀑布流，两页共用）/ 灯箱 / 媒体播放器 / 上传 / 各类对话框
│       ├── utils/              格式化 / 类型样式 / 视图模式持久化
│       └── stores/             Pinia：auth / images / tags
├── docker-compose.yml
└── .env.example
```

仓库里与 Cloudflare 版共用的部分（在上一层）：

```
mobile/
├── tools/baidu-pan.mjs               命令行验证工具（见第六节）
├── tools/MigrateSqliteToMysql.java   SQLite → MySQL 数据搬迁工具
├── docs/API.md                       前后端接口契约
└── docs/MYSQL.md                     MySQL 迁移说明（必读，别直接切库）
```

---

## 四、功能

- **认证**：首次启动由使用者设定管理员密码；HttpOnly + SameSite=Lax Cookie 承载会话，前端 JS 读不到令牌。
- **图库**：响应式缩略图网格、文件名搜索、6 种排序、标签筛选、只看收藏、分页。
- **文件库**：**图片只是其中一种类型**，同一套索引和接口管理网盘目录下的全部文件。
  搜索、6 种排序、类型筛选（图片 / 视频 / 音频 / 文档 / 其他，带数量角标）、标签、收藏、下载。
  非图片类型（文档、压缩包等）显示类型图标，不会去请求百度拿不到的缩略图。
- **三种视图可切换**（选择记在浏览器里，刷新后保持）：
  - **表格** —— 文件库默认。列最全（类型 / 大小 / 尺寸 / 修改时间 / 标签），适合管理。
  - **网格** —— 等高方格，整齐、扫视快。
  - **瀑布流** —— 按文件真实宽高比排布，图片和视频混在一起时观感更好。
    图库提供「网格 / 瀑布流」两种。

  > 瀑布流用 CSS 多列实现，卡片高度由自身宽高比决定（图片没下载完占位高度就是对的，不会加载后跳一下）。
  > 代价是阅读顺序按列自上而下，和表格视图从左到右不同，这一点在页面上也有提示。
- **上传**：多文件、拖拽；图库入口只收图片并会提示去哪传其他类型，文件库入口收任意文件。
  同名自动加序号而不是覆盖；单个文件失败不影响其他文件，失败原因逐个回显。
- **预览**：点击图片打开原图，支持滚轮缩放、拖动平移、适应窗口 / 100%、上一张下一张（按钮 + ← →）、Esc 关闭。
- **在线播放**：视频与音频都支持，但**用了两套不同的呈现方式**——
  视频是沉浸式全屏（满屏画面 + 渐变遮罩控件，鼠标静止 3 秒自动隐藏，`F` 进浏览器全屏），
  音频是**底部迷你播放条**（不遮页面，可以边听边继续浏览文件库）。
  两者都支持拖动进度条、上一个 / 下一个、← → / 空格 / Esc 快捷键。
  播放走 `Accept-Ranges` 流式传输，**不会先把整个文件下载完**。

  > 音频没有沿用视频那套全屏遮罩：一个纯音频文件占满整屏、把界面全挡住，屏幕上却只有一个播放条，不成比例。
  > 底部迷你条既能播放又不打断浏览，是更合适的形态。
- **管理**：重命名（自动清理百度不接受的字符，改扩展名会重算类型）、收藏、标签增删改。
- **删除**：严格区分三种语义 —— `index` 只删本地索引、`remote` 只删网盘文件（索引保留并标记「已丢失」）、`both` 两边都删。
- **同步**：递归扫描网盘目录，把**所有文件**幂等写入索引；收藏与标签是纯本地数据，同步过程绝不覆盖。
- **接口体检**：逐项真实调用百度接口并回报结果，见下节。

### 文件类型是怎么判定的

百度 `filemetas`/`list` 返回的 `category` 只有 7 个粗粒度值（1 视频 / 2 音频 / 3 图片 / 4 文档 / 5 应用 / 6 其他 / 7 种子），
实测大量文件会被归到「6 其他」。所以以**扩展名优先、category 兜底**的方式推导出
`IMAGE` / `VIDEO` / `AUDIO` / `DOC` / `OTHER` 五个大类，判定逻辑集中在 `FileKinds`。

---

## 五、已验证的百度网盘能力（2026-10-13 实测）

所有结论都来自真实调用，不是照抄文档。诊断页的「接口体检」可以在你自己的账号上复现这些结果。

| 能力 | 结论 | 备注 |
| --- | --- | --- |
| OAuth 授权码换令牌 | ✅ | `scope=basic netdisk`，access_token 30 天 |
| refresh_token 刷新 | ✅ | **一次性**，用掉即作废，必须立刻覆盖保存 |
| 列目录 `list` | ✅ | 支持分页，可列任意目录 |
| 上传 `precreate`→`superfile2`→`create` | ✅ | 分片必须串行 |
| 官方缩略图 `thumb=1` | ✅ | 返回 `icon` / `url1`~`url4` 五档，JPEG |
| 原图下载 dlink | ✅ | 下载字节与上传文件**逐字节一致** |
| Range 断点下载 | ✅ | 返回 206 |
| 重命名 `filemanager opera=rename` | ✅ | 实测 `fs_id` **不变** |
| 删除 `filemanager opera=delete` | ✅ | 删除后回读目录确认已消失 |
| 创建目录 `create isdir=1` | ✅ | |
| 按 `category=3` 识别图片 | ✅ | |

### 与官方文档不一致、以及文档没写的坑

这些都是实际踩出来的，写在代码注释里也写在这里：

1. **`precreate` 的 `return_type` 不能当秒传标志。**
   文档只说是「系统内部状态字段」。实测 `return_type=1` + `block_list=[0]` 表示**需要上传第 0 片**，
   不是秒传。可靠做法是只看 `block_list` 是否为空。

2. **`superfile2` 上传成功时响应里没有 `errno` 字段**，只有 `{md5, request_id}`。
   用 `errno === 0` 判断成功会把成功误判成失败。代码里用 `SliceResp.isSuccess()` 处理。

3. **百度返回的 `md5` 不是真实 MD5。**
   实测值形如 `4c84112b5m879873f86ddb5b4aed5edc`，里面有非十六进制字符 `m`。
   不要拿它和本地 MD5 比对做一致性校验，否则永远「不一致」。

4. **`filemetas` 的 `extra=1` 不保证返回宽高。**
   同一个文件第一次查有 `width/height`，之后查就没有。所以后端在生成缩略图时会额外用
   Range 请求读取原图前 64KB 解析头部尺寸并回填数据库。

5. **文档反复强调第三方应用只能访问 `/apps/{应用名}/`，越界报 `20011`；但本应用实测没有这个限制。**
   可以列出网盘根目录下全部目录，也能直接写网盘根目录并成功下载。
   推测与应用的权限档位或审核状态有关。代码里仍默认读写 `/apps/picman`，把「可写全盘」当成额外能力而不是依赖。

6. **dlink 下载必须伪装 `User-Agent: pan.baidu.com`**，URL 末尾还要拼 `&access_token=`，否则命中防盗链报 `31326`。
   dlink 有效期 8 小时，过期报 `31360`，重新查询即可；可能返回 302，需要跟随跳转。

7. **重定向链的每一跳都要做主机校验**，只校验第一跳会被 302 绕到内网地址。

8. **百度给视频生成封面是异步的。** 刚上传完立刻调 `thumb=1` 拿不到 `thumbs`，
   这时本地又没法用 ImageIO 解码 MP4，缩略图接口会返回 502。过一会儿再请求就有了。
   前端因此对缩略图加了加载失败回退——失败就显示类型图标，不会出现裂图。

### 尚未验证的能力

- **大文件分片上传**（> 4MB）。本项目上传的测试图都是单分片，多分片代码路径已实现但未实测。
- **VIP 档位的大分片**（16MB/32MB，报 `31364` 的边界）。
- **HEIC / AVIF 缩略图**：JVM 内置 ImageIO 不解码这两种格式。
  如果百度侧没给官方缩略图，本地生成会失败并如实报错，不会返回占位图。
- **30 天后的令牌过期与重新授权**全流程（只验证了 refresh 成功路径）。
- **并发上传大量文件**的表现。
- **Docker Compose 部署**：本机没有 Docker，`docker-compose.yml` 与两个 Dockerfile 已按标准写就但未在本机实测。
- **MySQL 5.7**：MySQL 支持是在 8.0.30 上实测的，见 [`../docs/MYSQL.md`](../docs/MYSQL.md)。
  另外 `NO_BACKSLASH_ESCAPES` 模式下的 `LIKE` 转义行为、高并发写入未测。

### 一个媒体播放的实际限制（不是代码问题）

**普通账号（VIP 等级 0）播放大会卡顿**，这是百度的第三方应用限速，不是本项目能解决的。

在本机实测同一个账号（uk=185241964，VIP 等级 0），走 `/api/files/{id}/raw` 拉不同大小的文件：

| 文件 | 大小 | 实测吞吐 |
| --- | --- | --- |
| 图片 | 1.4 MB | 788 KB/s |
| 视频 | 52.4 MB | 首段 96 KB/s，之后稳定在 **27~46 KB/s** |
| 音频 | 83.9 MB | **46 KB/s** |

规律是**先给一个快速突发，然后限速到 40 KB/s 上下**。而这个 52.4MB / 101 秒的视频码率需求是
531 KB/s，可用带宽只有它的 1/13 —— 必然持续卡顿，下完整个视频要 20 分钟以上。

结论：**几 MB 内的媒体能顺畅播放，大文件会不停缓冲**。想要流畅播放大文件，只能提升百度账号等级，
或者把文件放到别的地方。播放器本身不做任何额外缓冲策略，因为这属于服务端限速而不是缓冲不足。

---

## 六、接口体检

「百度网盘」页的**接口体检**会把每一项真实跑一遍并展示原始结果：

- 只读体检（默认）：访问令牌、账号信息、列目录。索引里已有图片时还会实际取一次官方缩略图和原图。
- 深度体检（勾选后）：额外真实走一遍 **上传 → 官方缩略图 → 原图下载（与上传字节比对）→ 重命名 → 删除**，
  临时文件自动清理。任一项失败就显示 FAIL 和百度的原始错误文案。

命令行的等价工具是 `../tools/baidu-pan.mjs`（只读验证脚本，不依赖后端）：

```bash
node ../tools/baidu-pan.mjs auth                 # 打印授权链接
node ../tools/baidu-pan.mjs token <授权码>        # 换令牌
node ../tools/baidu-pan.mjs verify               # 上传/缩略图/下载/Range/回读 全流程
node ../tools/baidu-pan.mjs verify --dir /       # 顺便验证越界写入是否被拒
node ../tools/baidu-pan.mjs list /apps           # 列目录
node ../tools/baidu-pan.mjs del "/apps/picman/a.jpg"
```

> Windows / Git Bash 下传以 `/` 开头的网盘路径要加 `MSYS_NO_PATHCONV=1`，
> 否则会被转成 `C:/Program Files/Git/...`。

---

## 七、安全设计

| 关注点 | 做法 |
| --- | --- |
| 密钥不出后端 | AppKey / SecretKey / 令牌只存后端数据库，任何接口都不返回 |
| 前端不接触令牌 | 会话用 HttpOnly Cookie；百度令牌连前端都不存在 |
| 首次启动口令 | 由使用者设定，无内置默认值；密码至少 8 位且不能是纯数字 |
| SSRF | dlink / 缩略图地址必须命中主机后缀白名单，**重定向每一跳都校验** |
| SSRF | 只允许 http/https，主机必须匹配 `*.baidupcs.com` 等白名单后缀 |
| XSS 偷令牌 | 会话令牌 HttpOnly，JS 读不到 |
| CSRF | SameSite=Lax + 无跨站表单登录；跨站 POST 不会携带 Cookie |
| 路径穿越 | 文件名过滤 `\ / : * ? " < > \|`，只取最后一段，长度截断 |
| SQL 注入 | 全部预编译参数；排序字段走白名单枚举 |
| 密钥入库 | `.gitignore` 排除 `.env`、`*.db`、令牌文件 |

---

## 八、常见问题

**从旧版本升级后，数据库会自己改吗？**
会。引入文件库之前索引表叫 `image_asset` 且只存图片，启动时 `SchemaMigrator` 会自动把它
升级成 `file_asset`（补上 `kind`/`category` 两列），关联表 `image_tag` 改名为 `asset_tag`。
**旧表不删除**，只改名为 `image_asset_migrated_<时间戳>`，确认数据无误后你自己删掉即可。
升级只跑一次，中途失败重跑也不会重复插入。升级前建议备份 `picman.db`。

**授权页报 `redirect_uri` 参数错误**
开放平台里配置的授权回调地址不是 `oob`。要么在应用详情页把回调地址改成 `oob`，要么修改
`BaiduTokenStore.authorizeUrl()` 里的 `redirect_uri` 与之一致。

**提示「百度网盘授权已失效」**
refresh_token 一次性，刷新失败即永久作废。到「百度网盘」页重新走一次授权即可。

**图片上传报容量不足（errno -10）**
网盘空间满了。注意实测普通账号的可用容量统计口径与网页端显示可能不一致。

**缩略图一直转圈或报「无法生成缩略图」**
先点「百度网盘」页的**接口体检**看真实原因：常见的是 HEIC/AVIF 这类 JVM 解不了的格式，
且百度侧正好没生成官方缩略图。也可以点「清空缩略图缓存」后重试。

**同一张图在卡片上显示「未知尺寸」**
百度不保证返回宽高，后端首次渲染缩略图时才会回填。刷新一次即可。

**`/apps/picman` 不存在**
同步或上传时会自动创建。也可以手动在网盘网页端建好。

---

## 九、接口契约

前后端接口的完整定义见 [`../docs/API.md`](../docs/API.md)，包含每个接口的请求/响应字段和错误码。

---

## 十、许可

MIT
