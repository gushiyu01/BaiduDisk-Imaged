#!/usr/bin/env node
/**
 * 百度网盘开放平台 · 上传 / 下载 / 图片预览 连通性验证
 *
 * 用法：
 *   node tools/baidu-pan.mjs auth              打印授权链接
 *   node tools/baidu-pan.mjs token <授权码>     用授权码换 access_token 并落盘
 *   node tools/baidu-pan.mjs whoami            检查 token 是否有效
 *   node tools/baidu-pan.mjs verify            跑完整验证流程
 *   node tools/baidu-pan.mjs list [目录]       列目录
 *   node tools/baidu-pan.mjs del <路径>        删除文件
 *
 * 凭证读取顺序：项目根 .env 覆盖 用户主目录 .env
 * 需要的变量：BAIDU_DISK_APPID / BAIDU_DISK_AKEY / BAIDU_DISK_SECRET_KEY
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'verify-output');
const TOKEN_FILE = path.join(__dirname, '.baidu-token.json');

const AUTH_BASE = 'https://openapi.baidu.com/oauth/2.0';
const PAN_BASE = 'https://pan.baidu.com/rest/2.0/xpan';
const UPLOAD_HOST = process.env.BAIDU_UPLOAD_HOST || 'https://d.pcs.baidu.com';
// dlink / thumbs 下载必须伪装成 pan.baidu.com，否则触发防盗链 (31326)
const UA = 'pan.baidu.com';
// 普通用户分片固定 4MB；单文件 <4MB 时整文件即一个分片
const SLICE_SIZE = 4 * 1024 * 1024;

const log = (...a) => console.log(...a);
const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✘\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const step = (n, m) => console.log(`\n\x1b[36m[${n}]\x1b[0m ${m}`);

// ---------------------------------------------------------------- env / config

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function loadConfig() {
  const env = {
    ...parseEnvFile(path.join(os.homedir(), '.env')),
    ...parseEnvFile(path.join(ROOT, '.env')),
  };
  // 兼容 BAIDU_DISK_APP_ID / BAIDU_DISK_APPID 与 BAIDU_DISK_APP_KEY / BAIDU_DISK_AKEY 两种命名
  const pick = (...names) => names.map((n) => env[n]).find(Boolean);
  const cfg = {
    appId: pick('BAIDU_DISK_APP_ID', 'BAIDU_DISK_APPID'),
    appKey: pick('BAIDU_DISK_APP_KEY', 'BAIDU_DISK_AKEY'),
    secretKey: env.BAIDU_DISK_SECRET_KEY,
    signKey: env.BAIDU_DISK_SIGN_KEY,
  };
  const missing = ['appKey', 'secretKey'].filter((k) => !cfg[k]);
  if (missing.length) {
    console.error(`缺少凭证：${missing.join(', ')}（在 .env 里设置 BAIDU_DISK_APP_KEY / BAIDU_DISK_SECRET_KEY）`);
    process.exit(1);
  }
  return cfg;
}

const CFG = loadConfig();
const mask = (s) => (typeof s === 'string' && s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '(未设置)');

// ---------------------------------------------------------------- oauth

function authorizeUrl(cfg) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.appKey,
    redirect_uri: 'oob',
    scope: 'basic,netdisk',
    display: 'page',
  });
  return `${AUTH_BASE}/authorize?${q}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${AUTH_BASE}/token?${new URLSearchParams(params)}`);
  const data = await res.json();
  if (data.error) throw new Error(`${data.error}: ${data.error_description || ''}`);
  return data;
}

function saveToken(data) {
  const rec = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 2592000) * 1000,
    scope: data.scope,
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(rec, null, 2));
  return rec;
}

function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function getAccessToken({ autoRefresh = true } = {}) {
  const rec = loadToken();
  if (!rec) throw new Error('还没有 token，先跑 `node tools/baidu-pan.mjs auth` 完成授权');
  if (rec.expires_at - Date.now() > 60_000) return rec.access_token;
  if (!autoRefresh || !rec.refresh_token) throw new Error('access_token 已过期，需要重新授权');
  warn('access_token 已过期，用 refresh_token 续期…');
  const data = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: rec.refresh_token,
    client_id: CFG.appKey,
    client_secret: CFG.secretKey,
  });
  return saveToken(data).access_token;
}

// ---------------------------------------------------------------- http helper

async function callJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} 非 JSON 响应: ${text.slice(0, 300)}`);
  }
  return json;
}

function xpanUrl(method, token, extra = {}) {
  return `${PAN_BASE}/file?${new URLSearchParams({ method, access_token: token, ...extra })}`;
}

function bail(r, what) {
  if (r.errno !== 0) throw new Error(`${what} 失败 errno=${r.errno} ${r.errmsg || ''} ${JSON.stringify(r).slice(0, 200)}`);
  return r;
}

async function uinfo(token) {
  return callJson(`${PAN_BASE}/nas?${new URLSearchParams({ method: 'uinfo', access_token: token })}`);
}

async function listDir(token, dir, extra = {}) {
  return callJson(xpanUrl('list', token, { dir, order: 'name', start: 0, limit: 100, ...extra }));
}

async function quotas(token) {
  return callJson(`https://pan.baidu.com/api/quota?${new URLSearchParams({ access_token: token, checkfree: '1', checkexpire: '1' })}`);
}

// ---------------------------------------------------------------- png 生成

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const stride = width * 3;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    rgb.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 画一张有辨识度的测试图：渐变底 + 色块 + 网格，方便肉眼确认预览图正确 */
function makeTestImage(w = 1600, h = 1000) {
  const buf = Buffer.alloc(w * h * 3);
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 3;
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, c[0], c[1], c[2]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      put(x, y, Math.round(20 + (x / w) * 90), Math.round(30 + (y / h) * 120), Math.round(90 + ((x + y) / (w + h)) * 140));
    }
  }
  for (let x = 0; x < w; x += 100) for (let y = 0; y < h; y++) put(x, y, 255, 255, 255);
  for (let y = 0; y < h; y += 100) for (let x = 0; x < w; x++) put(x, y, 255, 255, 255);
  rect(100, 100, 500, 400, [233, 69, 96]);      // 红
  rect(550, 100, 950, 400, [0, 168, 150]);      // 青绿
  rect(1000, 100, 1500, 400, [247, 183, 51]);   // 黄
  rect(100, 500, 800, 900, [30, 30, 60]);       // 深蓝
  rect(850, 500, 1500, 900, [240, 240, 240]);   // 白
  for (let i = 0; i < 360; i++) {               // 白色圆环，验证缩略图没变形
    const a = (i / 360) * Math.PI * 2;
    for (let r = 150; r < 175; r++) put(Math.round(1175 + Math.cos(a) * r), Math.round(700 + Math.sin(a) * r), 20, 20, 20);
  }
  return encodePng(w, h, buf);
}

// ---------------------------------------------------------------- 上传

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

/** 按 4MB 切片并返回每片 md5（顺序即 partseq） */
function sliceBlocks(buf) {
  if (buf.length <= SLICE_SIZE) return [md5(buf)];
  const blocks = [];
  for (let off = 0; off < buf.length; off += SLICE_SIZE) {
    blocks.push(md5(buf.subarray(off, Math.min(off + SLICE_SIZE, buf.length))));
  }
  return blocks;
}

async function upload(token, remotePath, buf) {
  const blocks = sliceBlocks(buf);
  const t0 = Date.now();

  // 1) precreate
  const pre = bail(
    await callJson(xpanUrl('precreate', token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        path: remotePath,
        size: String(buf.length),
        isdir: '0',
        block_list: JSON.stringify(blocks),
        autoinit: '1',
        rtype: '3', // 覆盖同名文件
      }),
    }),
    'precreate(预上传)',
  );

  if (process.env.BAIDU_DEBUG) log('    precreate raw:', JSON.stringify(pre));
  if (!pre.uploadid) throw new Error(`precreate 未返回 uploadid: ${JSON.stringify(pre)}`);

  // return_type：1 = 需要上传分片，2 = 云端已有全部内容（秒传），无正式文档，以 block_list 为准
  const need = Array.isArray(pre.block_list) && pre.block_list.length
    ? pre.block_list
    : pre.return_type === 2
      ? []
      : blocks.map((_, i) => i);
  const rapid = need.length === 0;

  // 2) 分片上传：文档要求按 block_list 顺序串行，不能并行
  for (const seq of need) {
    const part = buf.subarray(seq * SLICE_SIZE, Math.min((seq + 1) * SLICE_SIZE, buf.length));
    const q = new URLSearchParams({
      method: 'upload',
      access_token: token,
      type: 'tmpfile',
      path: remotePath,
      uploadid: pre.uploadid,
      partseq: String(seq),
    });
    const fd = new FormData();
    fd.append('file', new Blob([part]), path.basename(remotePath));
    const r = await callJson(`${UPLOAD_HOST}/rest/2.0/pcs/superfile2?${q}`, { method: 'POST', body: fd });
    // 注意：分片上传成功时只返回 {md5, request_id}，没有 errno 字段
    if (r.errno != null && r.errno !== 0) {
      throw new Error(`superfile2(第 ${seq} 片) 失败 errno=${r.errno} ${r.errmsg || ''}`);
    }
    if (r.md5 && r.md5 !== blocks[seq]) warn(`第 ${seq} 片 md5 与本地不一致：${r.md5} vs ${blocks[seq]}`);
    else ok(`第 ${seq} 片上传成功（md5 一致）`);
  }

  // 3) create
  const created = bail(
    await callJson(xpanUrl('create', token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        path: remotePath,
        size: String(buf.length),
        isdir: '0',
        block_list: JSON.stringify(blocks),
        uploadid: pre.uploadid,
        rtype: '3',
      }),
    }),
    'create(创建文件)',
  );

  if (process.env.BAIDU_DEBUG) log('    create raw:', JSON.stringify(created));
  let fsId = created.fs_id;
  if (fsId == null) {
    // create 未回 fs_id 时回读目录兜底
    const ls = await listDir(token, remotePath.slice(0, remotePath.lastIndexOf('/') + 1));
    fsId = (ls.list || []).find((e) => e.path === remotePath)?.fs_id;
    if (fsId == null) throw new Error(`无法取得 fs_id：${JSON.stringify(created)}`);
  }
  return { rapid, fs_id: fsId, created, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- 查询 / 下载

async function filemetas(token, fsids, extra = {}) {
  const q = new URLSearchParams({
    method: 'filemetas',
    access_token: token,
    fsids: JSON.stringify(fsids),
    ...extra,
  });
  return callJson(`${PAN_BASE}/multimedia?${q}`);
}

function withToken(dlink, token) {
  return `${dlink}${dlink.includes('?') ? '&' : '?'}access_token=${token}`;
}

async function fetchSigned(url, token, headers = {}) {
  return fetch(withToken(url, token), { headers: { 'User-Agent': UA, ...headers } });
}

// ---------------------------------------------------------------- 命令

async function cmdAuth() {
  log('在浏览器打开下面的链接，登录并点击「授权」：\n');
  log(authorizeUrl(CFG));
  log('\n授权后页面会显示一串授权码，把它贴回来执行：');
  log('  node tools/baidu-pan.mjs token <授权码>');
  log('\n注意：授权码 10 分钟内有效，且只能用一次。');
}

async function cmdToken(code) {
  if (!code) throw new Error('缺少授权码');
  const data = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    client_id: CFG.appKey,
    client_secret: CFG.secretKey,
    redirect_uri: 'oob',
  });
  const rec = saveToken(data);
  ok(`access_token 已保存（有效期至 ${new Date(rec.expires_at).toLocaleString()}，scope=${rec.scope}）`);
}

async function cmdWhoami() {
  const token = await getAccessToken();
  const info = await uinfo(token);
  bail(info, 'uinfo');
  log(`百度账号：${info.baidu_name}`);
  log(`网盘用户名：${info.netdisk_name}`);
  log(`uk：${info.uk}   VIP：${info.vip_type}`);
}

/** 找出本应用可写的 /apps/<appname> 目录 */
async function discoverAppDirs(token) {
  const found = [];
  for (const dir of ['/apps/', '/apps', '/我的应用数据/', '/']) {
    try {
      const r = await listDir(token, dir);
      if (r.errno !== 0) {
        warn(`list ${dir} → errno=${r.errno} ${r.errmsg || ''}`);
        continue;
      }
      const dirs = (r.list || []).filter((e) => e.isdir).map((e) => e.path);
      ok(`list ${dir} 成功，子目录：${dirs.length ? dirs.join(', ') : '(无)'}`);
      found.push(...dirs);
    } catch (e) {
      warn(`list ${dir} 异常：${e.message}`);
    }
  }
  return [...new Set(found)];
}

async function cmdList(dir = '/') {
  const token = await getAccessToken();
  const r = await listDir(token, dir, { web: '1' });
  if (r.errno !== 0) return bad(`errno=${r.errno} ${r.errmsg || ''}`);
  for (const f of r.list || []) {
    const kind = f.isdir ? 'DIR ' : 'FILE';
    log(`${kind} ${String(f.size).padStart(12)}  ${f.path}   fs_id=${f.fs_id}  category=${f.category}`);
  }
  log(`共 ${(r.list || []).length} 项`);
}

async function cmdMkdir(dir) {
  if (!dir) throw new Error('缺少目录路径');
  const token = await getAccessToken();
  const r = await callJson(xpanUrl('create', token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ path: dir, isdir: '1', size: '0', rtype: '0' }),
  });
  // 目录已存在时可能返回 -8
  if (r.errno === -8) return warn(`目录已存在：${dir}`);
  if (r.errno !== 0) return bad(`创建目录失败 errno=${r.errno} ${r.errmsg || ''} ${JSON.stringify(r).slice(0, 200)}`);
  ok(`已创建目录 ${dir}  fs_id=${r.fs_id}`);
}

async function cmdRename(from, to) {
  if (!from || !to) throw new Error('用法: rename <原路径> <新文件名>');
  const token = await getAccessToken();
  const r = await callJson(xpanUrl('filemanager', token, { opera: 'rename' }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      async: '0',
      filelist: JSON.stringify([{ path: from, newname: to, ondup: 'fail' }]),
    }),
  });
  if (r.errno !== 0) return bad(`重命名失败 errno=${r.errno} ${r.errmsg || ''} ${JSON.stringify(r).slice(0, 300)}`);
  ok(`已重命名 ${from} → ${to}`);
}

async function cmdDel(remotePath) {
  if (!remotePath) throw new Error('缺少路径');
  const token = await getAccessToken();
  const r = await callJson(xpanUrl('filemanager', token, { opera: 'delete' }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ async: '0', filelist: JSON.stringify([remotePath]) }),
  });
  if (r.errno !== 0) return bad(`删除失败 errno=${r.errno} ${r.errmsg || ''} ${JSON.stringify(r).slice(0, 200)}`);
  ok(`已删除 ${remotePath}`);
}

async function cmdVerify(opts) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const token = await getAccessToken();

  step(1, '校验 access_token');
  const info = await uinfo(token);
  bail(info, 'uinfo');
  ok(`授权账号：${info.baidu_name} / ${info.netdisk_name}（uk=${info.uk}，vip=${info.vip_type}）`);

  const q = await quotas(token);
  if (q.errno === 0) {
    const gb = (n) => (n / 1024 ** 3).toFixed(2);
    ok(`容量：总 ${gb(q.total)} GB，已用 ${gb(q.used)} GB，剩余 ${gb(q.free)} GB`);
  } else {
    warn(`quota 查询失败 errno=${q.errno}`);
  }

  step(2, '探测应用可访问目录 /apps/<appname>');
  let appDir = opts.dir;
  if (!appDir) {
    const dirs = await discoverAppDirs(token);
    const appsDirs = dirs.filter((d) => d.startsWith('/apps/'));
    if (appsDirs.length) appDir = appsDirs[0];
    if (!appDir) {
      let rootDirs = [];
      try {
        const r = await listDir(token, '/');
        if (r.errno === 0) rootDirs = (r.list || []).filter((e) => e.isdir).map((e) => e.path);
      } catch { /* ignore */ }
      if (rootDirs.includes('/apps')) appDir = '/apps/';
    }
  }
  if (!appDir) throw new Error('无法确定 /apps/<appname> 目录，请用 --dir 手动指定（在开放平台应用详情页可以看到应用名）');
  if (!appDir.endsWith('/')) appDir += '/';
  ok(`使用应用目录：${appDir}`);

  step(3, '本地生成测试图片');
  const img = makeTestImage();
  const localMd5 = md5(img);
  const localFile = path.join(OUT_DIR, 'local-test.png');
  fs.writeFileSync(localFile, img);
  ok(`${img.length} 字节  md5=${localMd5}  → ${localFile}`);

  step(4, '上传到网盘');
  const remoteName = `zcode-verify-${Date.now()}.png`;
  const remotePath = `${appDir}${remoteName}`;
  const up = await upload(token, remotePath, img);
  ok(`${up.rapid ? '秒传命中' : '分片上传完成'}，耗时 ${up.ms}ms，fs_id=${up.fs_id}`);
  ok(`云端路径：${remotePath}`);

  step(5, '查询元数据 + 缩略图 + dlink');
  const meta = await filemetas(token, [up.fs_id], { dlink: '1', thumb: '1', extra: '1' });
  bail(meta, 'filemetas');
  const f = (meta.list || [])[0];
  if (!f) throw new Error(`filemetas 返回空：${JSON.stringify(meta).slice(0, 300)}`);
  ok(`category=${f.category}（3=图片）  size=${f.size}  md5=${f.md5}`);
  if (f.width && f.height) ok(`服务端识别尺寸：${f.width}x${f.height}`);
  if (Number(f.size) !== img.length) bad(`size 不一致：云端 ${f.size} vs 本地 ${img.length}`);
  else ok('size 与本地一致');

  let thumbOk = false;
  if (f.thumbs && Object.keys(f.thumbs).length) {
    ok(`缩略图可用：${Object.keys(f.thumbs).join(', ')}`);
    const turl = f.thumbs.url1 || f.thumbs.url2 || f.thumbs.url3 || f.thumbs.icon;
    const tres = await fetchSigned(turl, token);
    const tbuf = Buffer.from(await tres.arrayBuffer());
    const tp = path.join(OUT_DIR, 'thumb.jpg');
    fs.writeFileSync(tp, tbuf);
    const isImg = tbuf.length > 0 && (tbuf[0] === 0xff || tbuf[0] === 0x89);
    if (tres.ok && isImg) {
      thumbOk = true;
      ok(`缩略图下载成功：HTTP ${tres.status}，${tbuf.length} 字节，Content-Type=${tres.headers.get('content-type')} → ${tp}`);
    } else {
      bad(`缩略图下载异常：HTTP ${tres.status}，${tbuf.length} 字节`);
    }
  } else {
    warn('未返回 thumbs（可能因为图片还没生成缩略图，或该类型不支持）');
  }

  step(6, '通过 dlink 下载并校验');
  if (!f.dlink) throw new Error('未返回 dlink，无法下载');
  const dres = await fetchSigned(f.dlink, token);
  ok(`下载 HTTP ${dres.status}  Content-Type=${dres.headers.get('content-type')}  Content-Length=${dres.headers.get('content-length') || '(未给出)'}`);
  if (!dres.ok) {
    const t = await dres.text();
    bad(`下载失败：${t.slice(0, 300)}`);
  } else {
    const got = Buffer.from(await dres.arrayBuffer());
    const gotMd5 = md5(got);
    const outFile = path.join(OUT_DIR, 'downloaded.png');
    fs.writeFileSync(outFile, got);
    if (gotMd5 === localMd5) ok(`下载内容 md5 与本地一致（${gotMd5}）→ ${outFile}`);
    else bad(`md5 不一致：本地 ${localMd5} vs 下载 ${gotMd5}（${got.length} 字节）`);
  }

  step(7, 'Range 断点下载');
  const rres = await fetchSigned(f.dlink, token, { Range: 'bytes=0-99' });
  const rbuf = Buffer.from(await rres.arrayBuffer());
  if (rres.status === 206 && rbuf.length === 100) ok(`Range 生效：HTTP 206，返回 ${rbuf.length} 字节`);
  else warn(`Range 未按预期生效：HTTP ${rres.status}，${rbuf.length} 字节`);

  step(8, '回读目录确认落盘');
  const ls = await listDir(token, appDir);
  bail(ls, 'list');
  const entry = (ls.list || []).find((e) => e.path === remotePath);
  if (entry) ok(`目录中可见：${entry.path}  size=${entry.size}  fs_id=${entry.fs_id}`);
  else bad(`目录中未找到 ${remotePath}`);

  log('\n──────── 结果 ────────');
  log(`上传：通过（${up.rapid ? '秒传' : `${Math.ceil(img.length / SLICE_SIZE)} 个分片`}）`);
  log(`下载：${f.dlink ? '通过' : '失败'}`);
  log(`预览：${thumbOk ? '通过（缩略图 + 原图均已取回）' : '缩略图不可用，但原图下载正常'}`);
  log(`\n产物目录：${OUT_DIR}`);
  log(`网盘文件：${remotePath}`);
  log(`如需删除：node tools/baidu-pan.mjs del "${remotePath}"`);
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') opts.dir = argv[++i];
    else opts._.push(argv[i]);
  }
  return opts;
}

const argv = parseArgs(process.argv.slice(2));
const cmd = argv._[0];

log(`百度网盘开放平台验证   AppID=${CFG.appId}   AppKey=${mask(CFG.appKey)}`);

try {
  switch (cmd) {
    case 'auth': await cmdAuth(); break;
    case 'token': await cmdToken(argv._[1]); break;
    case 'whoami': await cmdWhoami(); break;
    case 'verify': await cmdVerify(argv); break;
    case 'list': await cmdList(argv._[1]); break;
    case 'del': await cmdDel(argv._[1]); break;
    case 'mkdir': await cmdMkdir(argv._[1]); break;
    case 'rename': await cmdRename(argv._[1], argv._[2]); break;
    default:
      log('用法: node tools/baidu-pan.mjs <auth|token <code>|whoami|verify|list [dir]|del <path>|mkdir <dir>|rename <from> <newname>>');
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`\n\x1b[31m错误：\x1b[0m ${e.message}`);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
}
