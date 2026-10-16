# PicMan · 百度网盘个人图片/文件管理

把百度网盘当图床用的自托管管理器：文件存在你自己的网盘里，元数据（标签、收藏、索引）存在本地。
后端代理百度开放平台的全部调用，**浏览器和前端接触不到任何 AppKey、SecretKey 和访问令牌**。

仓库里有**两套独立实现**，功能对等，二选一部署：

```
mobile/
├── self-hosted/     Spring Boot 3 + Vue，自己找台机器/Docker 跑
├── cloudflare/      Cloudflare Workers + D1 + KV，纯边缘，不用服务器
├── tools/           命令行工具（百度接口验证、SQLite→MySQL 迁移、前端同步检查）
└── docs/            前后端接口契约、MySQL 迁移说明
```

## 选哪个

| | `self-hosted/` | `cloudflare/` |
| --- | --- | --- |
| 后端 | Spring Boot 3 / JDK 17 | Cloudflare Workers（TypeScript） |
| 数据库 | SQLite 或 MySQL | D1（本身就是 SQLite） |
| 缩略图缓存 | 本地文件系统 | KV |
| 上传算 MD5 | 服务端 | **浏览器**（Free 套餐 CPU 算不动 4MB 的 MD5） |
| 本地生成缩略图 | 支持（ImageIO） | 不支持（官方缩略图 + 原图兜底） |
| 部署 | `docker compose up -d` | `node cloudflare/deploy.mjs` |
| 成本 | 一台机器 | Free 套餐可跑，$5/月更宽裕 |

两边**不共享数据库**，各自独立部署、独立授权。想从一套搬到另一套，用
`POST /api/baidu/import-refresh-token`（注意百度 refresh_token 一次性，搬家意味着旧的那份作废）。

## 快速开始

**自建版**

```bash
cd self-hosted
cp .env.example .env      # 填百度开放平台的 AppID / AppKey / SecretKey
#   凭证在 https://pan.baidu.com/union/console/applist → 应用列表 → 应用详情 → 应用凭证
docker compose up -d --build
# 打开 http://localhost:8088 → 创建管理员 → 「百度网盘」页完成授权 → 同步索引
```

**Cloudflare 版**

```bash
npm --prefix cloudflare/worker install
export CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx
export HTTPS_PROXY=http://127.0.0.1:7897   # 国内必须，直连会被阻断
node cloudflare/deploy.mjs
```

详细步骤见各自的 README： [`self-hosted/README.md`](self-hosted/README.md) ·
[`cloudflare/README.md`](cloudflare/README.md)（Cloudflare 版的技术档案：
[`cloudflare/README-TECH.md`](cloudflare/README-TECH.md)）

## 两套共用的东西

- **接口契约**：[`docs/API.md`](docs/API.md)。两套后端实现的路径、请求体、响应体完全一致，
  只有上传多了个可选的 `blockMd5` 字段（自建版有它会直接用，没有就自己算）。
- **前端**：`self-hosted/frontend/` 与 `cloudflare/frontend/` 是**同一份代码的两份拷贝**，
  这样每个目录都能独立部署。改了一份记得同步另一份：

  ```bash
  node tools/check-frontend-sync.mjs        # 检查两份是否一致
  node tools/check-frontend-sync.mjs --fix  # 把 self-hosted 的改动同步到 cloudflare
  ```

- **验证工具**：[`tools/baidu-pan.mjs`](tools/baidu-pan.mjs) 可以不依赖后端直接验证百度接口
  （授权、上传、缩略图、下载、Range、列目录、重命名、删除）。

## 实测记录

两套实现的能力验证、与百度官方文档不符之处、以及尚未验证的清单，分别写在各自的 README 里。
其中几个比较关键的坑（`precreate` 的 `return_type` 语义、`superfile2` 成功响应没有 `errno`、
百度返回的 `md5` 不是真实 MD5、`extra=1` 不保证返回宽高、Cloudflare Free 套餐算不动 4MB 的 MD5）
都在对应 README 里说明了来龙去脉。

## 许可

[MIT](LICENSE)
