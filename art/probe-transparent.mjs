#!/usr/bin/env node
/**
 * art/probe-transparent.mjs —— 透明底直出能力探测(实验脚本,不进常规流水线)
 *
 * 回答一个问题:能否让中转站直接返回带 alpha 通道的透明底 PNG,省掉抠图?
 * 四条路线各出一张图验证:
 *   gpt-param    openai/gpt-5.4-image-2 + image_config 透传 background/output_format
 *                (官方 images API 参数,验证中转站是否透传未知字段)
 *   gpt-prompt   openai/gpt-5.4-image-2 纯提示词要透明底(对照:参数不通时提示词是否够)
 *   flash-prompt google/gemini-3.1-flash-image-preview 纯提示词(最便宜)
 *   pro-prompt   google/gemini-3-pro-image-preview 纯提示词
 *
 * 判定链:返回 data URI 的 mime 是否 png → PNG 是否有 alpha 通道 → 四角 alpha 是否为 0。
 * 结果落 probe-manifest.json;不压缩不走 TinyPNG(保持原始返回,便于判断通道是否幸存)。
 *
 * 用法: node art/probe-transparent.mjs -c art.config.json [--only gpt-param,flash-prompt]
 * 密钥只从环境变量读(config 指定变量名),禁止写入任何文件。
 */

import fs from 'node:fs'
import path from 'node:path'

const VERSION = '0.1.0'

const argv = process.argv.slice(2)
const opts = { config: 'art.config.json' }
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-c') opts.config = argv[++i]
  else if (argv[i] === '--only') opts.only = String(argv[++i]).split(',').filter(Boolean)
  else if (argv[i] === '-h' || argv[i] === '--help') opts.help = true
}
if (opts.help) {
  console.log('用法: node art/probe-transparent.mjs -c art.config.json [--only gpt-param,gpt-prompt,flash-prompt,pro-prompt]')
  process.exit(0)
}

function die(msg) { console.error(`[probe] 错误: ${msg}`); process.exit(1) }

const cfgPath = path.resolve(opts.config)
if (!fs.existsSync(cfgPath)) die(`配置不存在: ${cfgPath}`)
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const key = process.env[cfg.api.keyEnv || 'CODEX_API_KEY']
if (!key) die(`环境变量 ${cfg.api.keyEnv || 'CODEX_API_KEY'} 未设置`)

// 固定同一主体,四条路线结果可直接对比
const SUBJECT = '一只戴黄色鱼形帽子的蓝色卡通小猫, 完整坐姿, 画面居中, 轮廓描边2px'
const TRANSPARENT_TAIL = '背景完全透明, 图片必须输出为带 alpha 透明通道的 PNG 格式, 主体轮廓之外没有任何背景色, 严禁白色背景、严禁棋盘格方格纹理、严禁把透明画成灰色格子, transparent background with a real alpha channel, PNG with transparency'
const bans = '画面中禁止:文字、字母、数字、水印、logo'
const fullPrompt = `可爱手绘卡通风, 圆润软萌造型, 色彩温暖明快, ${SUBJECT}. ${TRANSPARENT_TAIL}. ${bans}`

const PROBES = [
  { id: 'gpt-param', model: 'openai/gpt-5.4-image-2', route: 'image_config.background=transparent + output_format=png', imageConfig: { aspect_ratio: '1:1', image_size: '1K', background: 'transparent', output_format: 'png' } },
  { id: 'gpt-prompt', model: 'openai/gpt-5.4-image-2', route: '纯提示词', imageConfig: { aspect_ratio: '1:1', image_size: '1K' } },
  { id: 'flash-prompt', model: 'google/gemini-3.1-flash-image-preview', route: '纯提示词', imageConfig: null },
  { id: 'pro-prompt', model: 'google/gemini-3-pro-image-preview', route: '纯提示词', imageConfig: null },
]
const probes = opts.only ? PROBES.filter((p) => opts.only.includes(p.id)) : PROBES
if (probes.length === 0) die(`--only 未匹配任何探针: ${opts.only.join(', ')}`)

const outDir = path.resolve(path.dirname(cfgPath), 'art', 'generated-art', 'probe-transparent')
fs.mkdirSync(outDir, { recursive: true })

function pngHasAlpha(buf) {
  // PNG: IHDR 色彩类型第 25 字节,bit0=有 alpha;另查 tRNS 色块存在性
  if (buf.length < 26 || buf.readUInt32BE(0) !== 0x89504e47) return null
  const colorType = buf[25]
  let hasTrns = false
  for (let i = 8; i < buf.length - 8;) {
    const len = buf.readUInt32BE(i)
    const type = buf.toString('ascii', i + 4, i + 8)
    if (type === 'tRNS') { hasTrns = true; break }
    if (type === 'IDAT') break
    i += 12 + len
  }
  return { colorType, alphaInIhdr: (colorType & 0b100) !== 0 || colorType === 3, hasTrns }
}

function pngSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue }
      const m = buf[i + 1]
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return { w: 0, h: 0 }
}

async function runProbe(p) {
  const t0 = Date.now()
  const body = { model: p.model, messages: [{ role: 'user', content: fullPrompt }], modalities: ['image', 'text'] }
  if (p.imageConfig) body.image_config = p.imageConfig
  const rec = { id: p.id, model: p.model, route: p.route, prompt: fullPrompt, imageConfig: p.imageConfig, at: new Date().toISOString() }
  try {
    const res = await fetch(`${cfg.api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    })
    rec.httpStatus = res.status
    const data = await res.json().catch(() => ({}))
    if (data.error) throw new Error(`接口错误: ${JSON.stringify(data.error).slice(0, 400)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`)
    const msg = data.choices?.[0]?.message ?? {}
    const uris = [...new Set((msg.images ?? []).map((im) => im?.image_url?.url).filter((u) => typeof u === 'string' && /^data:image\/\w+;base64,/.test(u)))]
    if (uris.length === 0) throw new Error(`未返回图片, 文本: ${(msg.content ?? '').slice(0, 120)}`)
    const m = uris[0].match(/^data:image\/(\w+);base64,(.+)$/s)
    const buf = Buffer.from(m[2], 'base64')
    rec.returnedMime = `image/${m[1]}`
    rec.bytes = buf.length
    rec.width = pngSize(buf).w
    rec.height = pngSize(buf).h
    rec.cost = data.usage?.cost ?? 0
    rec.alphaProbe = pngHasAlpha(buf)
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
    const file = `${p.id}.${ext}`
    fs.writeFileSync(path.join(outDir, file), buf)
    rec.file = file
    rec.elapsedSec = Math.round((Date.now() - t0) / 1000)
    console.log(`  ✓ ${p.id} [${p.model}] ${file} ${rec.width}x${rec.height} ${(buf.length / 1024).toFixed(0)}KB mime=${rec.returnedMime} alpha=${JSON.stringify(rec.alphaProbe)} ${rec.elapsedSec}s`)
  } catch (e) {
    rec.error = e.message
    rec.elapsedSec = Math.round((Date.now() - t0) / 1000)
    console.error(`  ✗ ${p.id} [${p.model}] ${e.message} (${rec.elapsedSec}s)`)
  }
  return rec
}

console.log(`[probe] 透明底直出探测 ${probes.length} 条路线 → ${outDir}`)
const results = await Promise.all(probes.map(runProbe))

// 判定:mime 是 png 且 IHDR/tRNS 显示有 alpha 才算通道幸存;四角像素是否透明交给配套 python 校验
const manifestPath = path.join(outDir, 'probe-manifest.json')
fs.writeFileSync(manifestPath, JSON.stringify({ version: VERSION, items: results }, null, 2), 'utf8')
console.log('\n═══ 探测结论(通道层) ═══')
for (const r of results) {
  if (r.error) { console.log(`${r.id}: 失败 — ${r.error.slice(0, 160)}`); continue }
  const alphaOk = r.returnedMime === 'image/png' && r.alphaProbe && (r.alphaProbe.alphaInIhdr || r.alphaProbe.hasTrns)
  console.log(`${r.id}: mime=${r.returnedMime} | alpha通道=${alphaOk ? '有 ✅' : '无/不确定 ❌'} | $${(+r.cost).toFixed(4)} | ${r.file}`)
}
console.log(`\n[probe] 像素级校验(四角 alpha/透明占比/棋盘格)用 matting 侧 python 脚本复核,manifest: ${manifestPath}`)
