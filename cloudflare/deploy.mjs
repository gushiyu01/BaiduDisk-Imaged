#!/usr/bin/env node
/**
 * PicMan → Cloudflare 一键部署。
 *
 * 做这些事（可重复执行，已存在的资源会复用而不是重建）：
 *   1. 校验 Cloudflare 凭证
 *   2. 创建或复用 D1 数据库 / KV 命名空间，把 id 写进 wrangler.toml
 *   3. 初始化 D1 表结构
 *   4. 构建前端（Worker 的静态资源绑定要用）
 *   5. 下发百度凭证为 secret
 *   6. 部署，并打印访问地址
 *
 * 用法：
 *   export CLOUDFLARE_API_TOKEN=xxx
 *   export CLOUDFLARE_ACCOUNT_ID=xxx
 *   node cloudflare/deploy.mjs
 *
 * 百度凭证按此顺序查找，找到就用，都没有则跳过（之后可以手动 `wrangler secret put`）：
 *   1. 进程环境变量 BAIDU_DISK_APP_KEY / BAIDU_DISK_SECRET_KEY / BAIDU_DISK_APP_ID
 *   2. cloudflare/worker/.dev.vars
 *   3. 项目根 .env
 *   4. 用户主目录 .env
 *
 * 国内直连 api.cloudflare.com 会被阻断，需要先设好代理：
 *   export HTTPS_PROXY=http://127.0.0.1:7897
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER_DIR = join(HERE, 'worker')
const FRONTEND_DIR = join(HERE, 'frontend')
const WRANGLER_TOML = join(WORKER_DIR, 'wrangler.toml')

const D1_NAME = 'picman'
const KV_TITLE = 'picman-cache'

const CF_API = 'https://api.cloudflare.com/client/v4'

// ---------------------------------------------------------------- 输出

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}
const ok = (m) => console.log(`  ${c.green('✓')} ${m}`)
const bad = (m) => console.log(`  ${c.red('✗')} ${m}`)
const warn = (m) => console.log(`  ${c.yellow('!')} ${m}`)
const step = (n, m) => console.log(`\n${c.cyan(`[${n}]`)} ${m}`)

function die(message) {
  console.error(`\n${c.red('部署中止：')} ${message}\n`)
  process.exit(1)
}

// ---------------------------------------------------------------- 工具

function parseEnvFile(file) {
  const out = {}
  if (!existsSync(file)) return out
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[m[1]] = v
  }
  return out
}

/**
 * 执行命令。
 * 传整条命令行字符串而不是 (cmd, args)：Windows 上跑 npx / npm 这类 .cmd 必须经 shell，
 * 而 Node 对「shell + args 数组」会报 DEP0190 弃用警告，拼成一条命令串才是它的推荐用法。
 * 参数统一经 quote 处理，避免路径里的空格把命令拆开。
 */
function run(commandLine, opts = {}) {
  const res = spawnSync(commandLine, {
    cwd: opts.cwd ?? WORKER_DIR,
    shell: true,
    encoding: 'utf8',
    input: opts.input,
    stdio: opts.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    env: process.env,
  })
  const stdout = res.stdout ?? ''
  const stderr = res.stderr ?? ''
  if (res.status !== 0 && !opts.allowFailure) {
    console.error(c.dim(stdout.trim().split('\n').slice(-8).join('\n')))
    console.error(c.dim(stderr.trim().split('\n').slice(-8).join('\n')))
    die(`命令失败：${commandLine}`)
  }
  return { status: res.status, stdout, stderr }
}

const quote = (v) => (/\s/.test(v) ? `"${v.replace(/"/g, '')}"` : v)

/** npx wrangler 的封装：走项目本地依赖，保证版本一致 */
const wrangler = (args, opts) => run(['npx', 'wrangler', ...args].map(quote).join(' '), opts)

/** npx wrangler 的封装：走项目本地依赖，保证版本一致 */

async function cf(path, init = {}) {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    die(`Cloudflare API 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  return body
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(c.cyan('\nPicMan · Cloudflare 一键部署'))

  // ---- 1. 凭证 ----
  step(1, '校验凭证')

  const token = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!token) die('缺少 CLOUDFLARE_API_TOKEN 环境变量')
  if (!accountId) die('缺少 CLOUDFLARE_ACCOUNT_ID 环境变量')

  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
    warn('未检测到 HTTPS_PROXY，若在国内直连 api.cloudflare.com 可能超时')
  }

  const accounts = await cf('/accounts')
  if (!accounts.success) {
    die(`Cloudflare 凭证无效：${JSON.stringify(accounts.errors)}`)
  }
  const account = (accounts.result ?? []).find((a) => a.id === accountId)
  if (!account) {
    die(`该 Token 看不到账户 ${accountId}，实际可见：${(accounts.result ?? []).map((a) => a.id).join(', ') || '（无）'}`)
  }
  ok(`账户：${account.name}`)

  // ---- 2. D1 / KV ----
  step(2, '准备 D1 与 KV')

  const d1List = await cf(`/accounts/${accountId}/d1/database`)
  let d1 = (d1List.result ?? []).find((d) => d.name === D1_NAME)
  if (d1) {
    ok(`复用已有 D1：${d1.uuid}`)
  } else {
    const created = await cf(`/accounts/${accountId}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: D1_NAME }),
    })
    if (!created.success) die(`创建 D1 失败：${JSON.stringify(created.errors)}`)
    d1 = created.result
    ok(`已创建 D1：${d1.uuid}`)
  }

  const kvList = await cf(`/accounts/${accountId}/storage/kv/namespaces`)
  let kv = (kvList.result ?? []).find((k) => k.title === KV_TITLE)
  if (kv) {
    ok(`复用已有 KV：${kv.id}`)
  } else {
    const created = await cf(`/accounts/${accountId}/storage/kv/namespaces`, {
      method: 'POST',
      body: JSON.stringify({ title: KV_TITLE }),
    })
    if (!created.success) die(`创建 KV 失败：${JSON.stringify(created.errors)}`)
    kv = created.result
    ok(`已创建 KV：${kv.id}`)
  }

  // 回填 wrangler.toml（幂等：只替换 id 那一行）
  let toml = readFileSync(WRANGLER_TOML, 'utf8')
  const before = toml
  toml = toml.replace(/(\[\[d1_databases\]\][\s\S]*?database_id = ")[^"]*(")/, `$1${d1.uuid}$2`)
  toml = toml.replace(/(\[\[kv_namespaces\]\][\s\S]*?\nid = ")[^"]*(")/, `$1${kv.id}$2`)
  if (toml !== before) {
    writeFileSync(WRANGLER_TOML, toml)
    ok('wrangler.toml 已回填资源 id')
  } else {
    ok('wrangler.toml 资源 id 无变化')
  }

  // ---- 3. 表结构 ----
  step(3, '初始化 D1 表结构')
  const schema = wrangler([
    'd1', 'execute', D1_NAME, '--remote', '--file=./src/db/schema.sql', '--yes',
  ], { allowFailure: true })
  if (schema.status !== 0) {
    die(`建表失败：${(schema.stderr || schema.stdout).trim().split('\n').slice(-5).join(' ')}`)
  }
  ok('表结构已就绪（IF NOT EXISTS，可重复执行）')

  // ---- 4. 前端 ----
  step(4, '构建前端')
  if (!existsSync(join(FRONTEND_DIR, 'node_modules'))) {
    console.log(c.dim('  首次运行，安装前端依赖…'))
    run('npm ci', { cwd: FRONTEND_DIR, allowFailure: true })
    if (!existsSync(join(FRONTEND_DIR, 'node_modules'))) {
      run('npm install', { cwd: FRONTEND_DIR })
    }
  }
  const build = run('npm run build', { cwd: FRONTEND_DIR, allowFailure: true })
  if (build.status !== 0) {
    die(`前端构建失败：${(build.stderr || build.stdout).trim().split('\n').slice(-5).join(' ')}`)
  }
  ok('前端构建完成（frontend/dist）')

  // ---- 5. 百度凭证 ----
  step(5, '下发百度凭证')
  const envFiles = [
    join(WORKER_DIR, '.dev.vars'),
    resolve(HERE, '..', '.env'),
    join(homedir(), '.env'),
  ]
  const merged = Object.assign({}, ...envFiles.map(parseEnvFile))
  const pick = (...names) => {
    for (const n of names) {
      const v = process.env[n] || merged[n]
      if (v && v.trim()) return v.trim()
    }
    return ''
  }
  const appKey = pick('BAIDU_DISK_APP_KEY', 'BAIDU_DISK_AKEY')
  const secretKey = pick('BAIDU_DISK_SECRET_KEY')
  const appId = pick('BAIDU_DISK_APP_ID', 'BAIDU_DISK_APPID')

  const secrets = [
    ['BAIDU_DISK_APP_KEY', appKey],
    ['BAIDU_DISK_SECRET_KEY', secretKey],
    ['BAIDU_DISK_APP_ID', appId],
  ].filter(([, v]) => v)

  if (secrets.length === 0) {
    warn('没找到百度凭证，跳过。之后可执行：npx wrangler secret put BAIDU_DISK_APP_KEY')
  } else {
    for (const [name, value] of secrets) {
      const r = wrangler(['secret', 'put', name], { input: value, allowFailure: true })
      if (r.status !== 0) {
        bad(`${name} 下发失败`)
      } else {
        ok(`${name} 已下发（来源：${process.env[name] ? '环境变量' : 'env 文件'}）`)
      }
    }
  }

  // ---- 6. 部署 ----
  step(6, '部署 Worker')
  const deploy = wrangler(['deploy'], { allowFailure: true })
  if (deploy.status !== 0) {
    console.error(c.dim((deploy.stderr || deploy.stdout).trim().split('\n').slice(-10).join('\n')))
    die('部署失败')
  }
  const url = /(https:\/\/[^\s]*\.workers\.dev)/.exec(deploy.stdout)
  ok('部署成功')

  console.log(`\n${c.green('完成')}`)
  if (url) console.log(`  访问地址：${c.cyan(url[1])}`)
  console.log(c.dim('  首次打开会引导创建管理员账号，然后到「百度网盘」页完成 OAuth 授权。'))
  console.log(c.dim('  绑定自定义域名：控制台 → Workers & Pages → picman → Settings → Domains & Routes'))
  console.log('')
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)))
