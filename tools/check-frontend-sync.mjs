#!/usr/bin/env node
/**
 * 前端同步检查。
 *
 * self-hosted/frontend 与 cloudflare/frontend 是同一份代码的两份拷贝 ——
 * 这样做是为了让两个目录都能独立部署，代价是可能改了一份忘另一份。
 * 这个脚本就是用来发现这种漂移的。
 *
 * 用法：
 *   node tools/check-frontend-sync.mjs        只检查，不一致时以非零码退出
 *   node tools/check-frontend-sync.mjs --fix  把 self-hosted 的版本同步到 cloudflare
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const A = join(ROOT, 'self-hosted', 'frontend')
const B = join(ROOT, 'cloudflare', 'frontend')

// 构建产物和依赖不参与比较
const IGNORE = new Set(['node_modules', 'dist', '.vite', '.DS_Store'])

const fix = process.argv.includes('--fix')

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`

function walk(dir, base = dir) {
  const out = new Map()
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (IGNORE.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      for (const [k, v] of walk(full, base)) out.set(k, v)
    } else {
      out.set(relative(base, full).replace(/\\/g, '/'), full)
    }
  }
  return out
}

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

if (!existsSync(A) || !existsSync(B)) {
  console.error(red('找不到前端目录，确认在仓库根目录下运行'))
  process.exit(2)
}

const filesA = walk(A)
const filesB = walk(B)
const names = [...new Set([...filesA.keys(), ...filesB.keys()])].sort()

const onlyA = []
const onlyB = []
const differ = []

for (const name of names) {
  const a = filesA.get(name)
  const b = filesB.get(name)
  if (a && !b) onlyA.push(name)
  else if (!a && b) onlyB.push(name)
  else if (hash(a) !== hash(b)) differ.push(name)
}

console.log(`\n比较 ${A}\n     ${B}\n`)
console.log(`  self-hosted 独有 : ${onlyA.length}`)
console.log(`  cloudflare  独有 : ${onlyB.length}`)
console.log(`  内容不同         : ${differ.length}`)

const problems = [...onlyA, ...onlyB, ...differ]
if (problems.length === 0) {
  console.log(`\n${green('✓ 两份前端完全一致')}（共 ${names.length} 个文件）\n`)
  process.exit(0)
}

for (const f of onlyA) console.log(`    ${yellow('仅 self-hosted')}  ${f}`)
for (const f of onlyB) console.log(`    ${yellow('仅 cloudflare ')}  ${f}`)
for (const f of differ) console.log(`    ${red('内容不同      ')}  ${f}`)

if (!fix) {
  console.log(`\n${yellow('两份前端已漂移')}。确认以 self-hosted 为准后用 --fix 同步，或手工处理。\n`)
  process.exit(1)
}

// --fix：以 self-hosted 为准覆盖 cloudflare
console.log(`\n以 self-hosted 为准同步到 cloudflare…`)
for (const name of [...onlyA, ...differ]) {
  const src = filesA.get(name)
  const dst = join(B, name)
  mkdirSync(dirname(dst), { recursive: true })
  writeFileSync(dst, readFileSync(src))
  console.log(`    ${green('已同步')}  ${name}`)
}
for (const name of onlyB) {
  console.log(`    ${yellow('跳过')}    ${name}（cloudflare 独有，需要人工判断）`)
}
console.log('')
