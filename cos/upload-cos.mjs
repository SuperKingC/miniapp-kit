#!/usr/bin/env node
/**
 * miniapp-kit/cos —— COS 资产版本化上传(配合 art/ 生图产物或任意静态目录)
 *
 * 路径规则:<prefix>/<version>/<相对路径>;version 默认取目录所在 git 仓库的短 SHA。
 * 版本化路径 + immutable 缓存头 = 发版即全量新 URL,从结构上规避 CDN/微信客户端缓存。
 *
 * 用法:
 *   node cos/upload-cos.mjs --dir <待传目录> [--prefix <COS基础URL或路径>] [--version <sha>] [--yes]
 * 环境变量:COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION
 * 默认 dry-run 只打印上传计划;--yes 才真正上传。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const args = { concurrency: 4 }
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--dir') args.dir = process.argv[++i]
  else if (a === '--prefix') args.prefix = process.argv[++i]
  else if (a === '--version') args.version = process.argv[++i]
  else if (a === '--concurrency') args.concurrency = Math.max(1, +process.argv[++i] || 4)
  else if (a === '--yes') args.yes = true
  else if (a === '-h' || a === '--help') args.help = true
}
if (args.help) {
  console.log('用法: node cos/upload-cos.mjs --dir <目录> [--prefix <URL>] [--version <sha>] [--concurrency 4] [--yes]')
  process.exit(0)
}

function die(msg) { console.error(`[cos] 错误: ${msg}`); process.exit(1) }

const distRoot = path.resolve(args.dir || '')
if (!args.dir || !fs.existsSync(distRoot)) die(`--dir 目录不存在: ${args.dir || '(未指定)'}`)

// version 默认 = 该目录所在 git 仓库的短 SHA
let version = args.version
if (!version) {
  try {
    version = execSync('git rev-parse --short HEAD', { cwd: distRoot, encoding: 'utf8' }).trim()
  } catch { die('目录不在 git 仓库内,请用 --version 指定版本(如提交 SHA)') }
}
if (!/^[\w.-]+$/.test(version) || version.includes('/')) die(`非法 version: ${version}`)

let prefix = ''
if (args.prefix) {
  try { prefix = new URL(args.prefix).pathname.split('/').filter(Boolean).join('/') }
  catch { prefix = args.prefix.split('/').filter(Boolean).join('/') }
}

const CONTENT_TYPES = new Map([
  ['.gif', 'image/gif'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'], ['.txt', 'text/plain; charset=utf-8'],
])

function collect(dir, base = '') {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (fs.statSync(full).isDirectory()) out.push(...collect(full, rel))
    else out.push({ filePath: full, rel, size: fs.statSync(full).size, key: [prefix, version, rel].filter(Boolean).join('/') })
  }
  return out
}

const entries = collect(distRoot)
if (entries.length === 0) die('目录里没有文件')
const totalKB = entries.reduce((s, e) => s + e.size, 0) / 1024
console.log(`[cos] ${entries.length} 个文件,共 ${totalKB.toFixed(0)}KB → <bucket>/${prefix ? prefix + '/' : ''}${version}/`)
for (const e of entries.slice(0, 20)) console.log(`  ${e.key} (${(e.size / 1024).toFixed(0)}KB)`)
if (entries.length > 20) console.log(`  … 共 ${entries.length} 个`)

if (!args.yes) {
  console.log('[cos] dry-run 完成;加 --yes 执行上传(需环境变量 COS_SECRET_ID/COS_SECRET_KEY/COS_BUCKET/COS_REGION)')
  process.exit(0)
}

for (const name of ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION']) {
  if (!process.env[name]?.trim()) die(`缺少环境变量 ${name}`)
}

let COS
try { COS = (await import('cos-nodejs-sdk-v5')).default } catch { die('缺少依赖:在仓库根 npm i(含 cos-nodejs-sdk-v5 可选依赖)') }
const client = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY })

function putObject(e) {
  return new Promise((resolve, reject) => {
    client.putObject({
      Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: e.key,
      Body: fs.createReadStream(e.filePath), ContentLength: e.size,
      ContentType: CONTENT_TYPES.get(path.extname(e.filePath).toLowerCase()) || 'application/octet-stream',
      ContentDisposition: 'inline', CacheControl: 'public, max-age=31536000, immutable',
    }, (err) => (err ? reject(err) : resolve()))
  })
}

let next = 0
async function worker() {
  while (next < entries.length) {
    const e = entries[next++]
    await putObject(e)
    console.log(`  ↑ ${e.key}`)
  }
}
await Promise.all(Array.from({ length: Math.min(args.concurrency, entries.length) }, worker))
console.log(`[cos] 上传完成:${entries.length} 个文件,版本 ${version}`)
