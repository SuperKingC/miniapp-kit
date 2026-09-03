#!/usr/bin/env node
/**
 * miniapp-kit/preview —— 本机静态服务,模拟 COS 预览待上传资产
 *
 * 配合小程序项目里的"开发基址"机制使用(如 Taro 项目的 TARO_ASSET_DEV_BASE_URL):
 * 模拟器走本机地址直接读本地资产目录,不从 COS 下载;真机/正式包仍走正式 COS 域名。
 * 关键:该变量只在开发构建注入,正式构建不设置即完全禁用——构建指向不会被本服务改变。
 *
 * 用法:
 *   node preview/serve.mjs --dir <资产目录> [--port 8787] [--path /ptking-web/<version>]
 * 目录结构应与将来上传到 COS 的相对路径一致(即 COS 上 <prefix>/ 下面的部分)。
 * 启动后按输出提示设 TARO_ASSET_DEV_BASE_URL 重新构建即可。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const args = { port: 8787 }
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--dir') args.dir = process.argv[++i]
  else if (a === '--port') args.port = +process.argv[++i] || 8787
  else if (a === '--path') args.path = process.argv[++i]
  else if (a === '-h' || a === '--help') args.help = true
}
if (args.help) {
  console.log('用法: node preview/serve.mjs --dir <资产目录> [--port 8787] [--path /url前缀]')
  process.exit(0)
}
function die(msg) { console.error(`[preview] 错误: ${msg}`); process.exit(1) }

const root = path.resolve(args.dir || '')
if (!fs.existsSync(root)) die(`目录不存在: ${root}`)
// URL 前缀(可选):资产在 COS 上挂在子路径下时,本地服务也挂同样的子路径,保证 URL 结构一致。
// 写法建议不带前导斜杠(--path ptking-web/v1),避免 Git Bash 的 MSYS 路径转换把 /x 当盘符路径
const base = (args.path || '')
  .replace(/\\/g, '/')
  .replace(/^([A-Za-z]:)?\/+(Program Files\/Git\/)?/, '') // 还原 MSYS 路径转换误伤
  .replace(/^\/+|\/+$/g, '')

const MIME = new Map([
  ['.gif', 'image/gif'], ['.html', 'text/html; charset=utf-8'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'],
  ['.json', 'application/json; charset=utf-8'], ['.m4v', 'video/mp4'], ['.mp4', 'video/mp4'],
  ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'], ['.txt', 'text/plain; charset=utf-8'],
])

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    let rel = urlPath
    if (base) {
      if (urlPath === `/${base}` || urlPath === `/${base}/`) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('preview ok'); return }
      if (!urlPath.startsWith(`/${base}/`)) { res.writeHead(404).end(); return }
      rel = urlPath.slice(base.length + 2)
    }
    rel = rel.replace(/^\/+/, '') // 关键:去掉前导斜杠,否则 Windows 上 path.resolve 会落到盘符根(D:\x)而越界 404
    const full = path.resolve(root, rel)
    const insideRoot = full.startsWith(path.resolve(root) + path.sep)
    if (!insideRoot || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return
    }
    res.writeHead(200, {
      'Content-Type': MIME.get(path.extname(full).toLowerCase()) || 'application/octet-stream',
      'Cache-Control': 'no-store', // 预览服务禁缓存:改图即见,避免模拟器读旧图
    })
    fs.createReadStream(full).pipe(res)
  } catch (e) { res.writeHead(500); res.end(String(e.message)) }
})

server.listen(args.port, '127.0.0.1', () => {
  const basePart = base ? `/${base}` : ''
  console.log(`[preview] http://127.0.0.1:${args.port}${basePart || '/'} ← ${root}`)
  console.log(`[preview] 预览构建注入(以项目实际变量名为准,如 Taro 项目):`)
  console.log(`  TARO_ASSET_BASE_URL=https://<正式COS>/ptking-web/<版本>   # 正式构建用,保持原值不动`)
  console.log(`  TARO_ASSET_DEV_BASE_URL=http://127.0.0.1:${args.port}${basePart}  # 仅开发构建注入,模拟器走本地`)
  console.log('[preview] 改完资产无需重启本服务,重新编译小程序即可看到新图')
})
