#!/usr/bin/env node
/**
 * miniapp-kit/art —— 小程序美术资产生图流水线 v0.2
 *
 * 流程:关键词优化(风格锚定+增强词+禁则,可选 LLM 改写) → 并发生图(多模型 fallback,
 *       支持 --ref 参考图图生图、--ratio/--size 控图) → TinyPNG 压缩(多 key 轮换,
 *       单次压缩保色彩,不做本地预压) → 防缓存升文件名 → manifest 留痕 → 主包体积红线
 *
 * 用法:
 *   node art/gen.mjs -c art.config.json -p prompts.txt [--out dir] [--count N]
 *        [--ratio 1:1|2:3|3:2] [--size 2K] [--ref 图1,图2] [--dry-run]
 *
 * prompts.txt:每行一条,`name|提示词` 命名,# 注释。
 * 密钥只从环境变量读(config 指定变量名),禁止写入任何文件。
 */

import fs from 'node:fs'
import path from 'node:path'

// 仓库根 .env 自动加载(已 gitignore,密钥落盘但不提交);进程环境变量优先
try {
  for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
} catch { /* 无 .env 时跳过 */ }

const VERSION = '0.2.0'
const REF_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
const MAX_REF_BYTES = 2 * 1024 * 1024 // 参考图单张 ≤2MB
const MAX_REFS = 2

// ---------- CLI ----------
const argv = process.argv.slice(2)
const opts = { config: 'art.config.json', prompts: 'prompts.txt', count: 1 }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '-c') opts.config = argv[++i]
  else if (a === '-p') opts.prompts = argv[++i]
  else if (a === '--out') opts.out = argv[++i]
  else if (a === '--count') opts.count = Math.max(1, +argv[++i] || 1)
  else if (a === '--ratio') opts.ratio = argv[++i]
  else if (a === '--size') opts.size = argv[++i]
  else if (a === '--ref') opts.refs = String(argv[++i]).split(',').filter(Boolean)
  else if (a === '--ui') opts.ui = argv[++i]
  else if (a === '--dry-run') opts.dryRun = true
  else if (a === '-h' || a === '--help') opts.help = true
}
if (opts.help) {
  console.log('用法: node art/gen.mjs -c art.config.json -p prompts.txt [--out dir] [--count N] [--ratio 1:1|2:3|3:2] [--size 2K] [--ref 图1,图2] [--ui "界面描述"] [--dry-run]')
  process.exit(0)
}

// UI 设计稿模式:用户说"重新设计某界面"时,一次出 5 张不同排版方向的设计稿供挑选
const UI_LAYOUTS = [
  '卡片流布局, 圆角卡片纵向排布, 层次分明',
  '双列网格布局, 宫格卡片错落有致',
  '沉浸式大图布局, 大幅视觉区配悬浮元素',
  '分区列表布局, 顶部标签页导航加分区内容',
  '混合布局, 顶部轮播加宫格加浮动操作按钮',
]

function die(msg) { console.error(`[art] 错误: ${msg}`); process.exit(1) }

// ---------- 配置 ----------
const cfgPath = path.resolve(opts.config)
if (!fs.existsSync(cfgPath)) die(`配置不存在: ${cfgPath}(模板见 art/art.config.example.json)`)
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
for (const k of ['style', 'api', 'compress', 'output']) if (!(k in cfg)) die(`配置缺少必填字段: ${k}`)
if (!Array.isArray(cfg.api.models) || cfg.api.models.length === 0) die('api.models 至少配置一个模型')
const maxKB = cfg.compress.maxKB ?? 180
const maxTotalMB = cfg.output.maxTotalMB ?? 2
const concurrency = Math.max(1, cfg.api.concurrency ?? 3)
const imageConfig = {
  aspect_ratio: opts.ratio || cfg.imageConfig?.aspect_ratio || '1:1',
  image_size: opts.size || cfg.imageConfig?.image_size || '2K',
}
// UI 设计稿是手机竖屏形态,覆盖 config 的正方形默认(显式 --ratio 仍最高)
if (opts.ui && !opts.ratio) imageConfig.aspect_ratio = '2:3'
// gpt 系生图模型才发 image_config(Pet10 生产验证);gemini 系未验证,不发以防 400
const supportsImageConfig = (model) => /^openai\//.test(model) && /image/.test(model)

// ---------- 参考图 ----------
function loadRefs() {
  const paths = opts.refs || []
  if (paths.length > MAX_REFS) die(`参考图最多 ${MAX_REFS} 张`)
  return paths.map((p) => {
    const full = path.resolve(p)
    const buf = fs.readFileSync(full)
    if (buf.length > MAX_REF_BYTES) die(`参考图超限(≤2MB): ${p}`)
    const mime = REF_MIME[path.extname(full).toLowerCase()]
    if (!mime) die(`参考图只支持 jpg/png/webp: ${p}`)
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }
  })
}

// ---------- 关键词优化 ----------
function composePrompt(cfg, text) {
  const boosters = cfg.prompt?.boosters ?? []
  // UI 设计稿需要界面文案,自动放宽"文字"类禁则(水印/logo 禁则保留)
  const bans = (cfg.prompt?.bans ?? ['画面中出现任何文字、字母、数字', '水印', 'logo'])
    .filter((b) => !(opts.ui && /文字|字母|数字/.test(b)))
  // 背景单独配置(抠图友好:选主体色板里没有的颜色);提示词里自己写了"背景"则不追加,避免两处打架;
  // UI 设计稿自带完整界面视图,不追加默认背景(其"无阴影"还会与光影特效要求冲突)
  const background = opts.ui || /背景/.test(text) ? '' : (cfg.prompt?.background ?? '')
  const seen = new Set()
  const parts = [cfg.style, background, text, ...boosters].flatMap((s) => String(s).split(/[,,.]\s*/)).filter(Boolean)
  const deduped = parts.filter((s) => { const k = s.trim(); if (seen.has(k)) return false; seen.add(k); return true })
  return `${deduped.join(', ')}.${bans.length ? ` 画面中禁止:${bans.join('、')}` : ''}`
}

async function optimizeWithLLM(cfg, text) {
  const model = cfg.prompt?.optimizeModel
  if (!model) return text
  const res = await fetch(`${cfg.api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env[cfg.api.keyEnv]}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是生图提示词优化器:把输入改写成一段细节丰富的中文生图提示词。不得改变主体与意图,可补充构图、光影、材质细节。只输出改写后的提示词,不要解释。' },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const data = await res.json().catch(() => ({}))
  const out = data?.choices?.[0]?.message?.content?.trim()
  if (!out) { console.warn('[art] 关键词 LLM 优化失败,用原始提示词'); return text }
  return out
}

// ---------- 生图 ----------
async function generateImage(cfg, model, fullPrompt, refs) {
  const key = process.env[cfg.api.keyEnv || 'CODEX_API_KEY']
  if (!key) die(`环境变量 ${cfg.api.keyEnv || 'CODEX_API_KEY'} 未设置`)
  const content = refs.length === 0
    ? fullPrompt
    : [{ type: 'text', text: fullPrompt }, ...refs]
  const body = { model, messages: [{ role: 'user', content }], modalities: ['image', 'text'] }
  if (supportsImageConfig(model)) body.image_config = { aspect_ratio: imageConfig.aspect_ratio, image_size: imageConfig.image_size }
  const res = await fetch(`${cfg.api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })
  const data = await res.json().catch(() => ({}))
  if (data.error) throw new Error(`接口错误: ${JSON.stringify(data.error).slice(0, 300)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`)
  const msg = data.choices?.[0]?.message ?? {}
  const images = [...new Set((msg.images ?? [])
    .map((im) => im?.image_url?.url)
    .filter((u) => typeof u === 'string' && /^data:image\/\w+;base64,/.test(u)))]
  return {
    images: images.map((u) => {
      const m = u.match(/^data:image\/(\w+);base64,(.+)$/s)
      return { ext: m[1] === 'jpeg' ? 'jpg' : m[1], buf: Buffer.from(m[2], 'base64') }
    }),
    text: (msg.content ?? '').trim(),
    cost: data.usage?.cost ?? 0,
  }
}

// ---------- TinyPNG(多 key 轮换,单次压缩保色彩) ----------
function tinifyKeys(cfg) {
  const primary = cfg.compress.tinypngKeyEnv || 'TINYPNG_API_KEY'
  return [primary, `${primary}_2`, `${primary}_3`, `${primary}_4`, `${primary}_5`]
    .map((n) => process.env[n]?.trim()).filter(Boolean)
}

async function tinifyCompress(buf, keys, dead, stats) {
  if (keys.length === 0) return { buf, compressed: false, note: '未配置 TinyPNG key,跳过压缩' }
  for (const key of keys) {
    if (dead.has(key)) continue
    const auth = `Basic ${Buffer.from(`api:${key}`).toString('base64')}`
    const post = await fetch('https://api.tinify.com/shrink', {
      method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/octet-stream' },
      body: buf, signal: AbortSignal.timeout(120_000),
    })
    if (post.status === 401 || post.status === 429) { dead.add(key); continue } // 无效/配额尽 → 轮换
    if (!post.ok) throw new Error(`TinyPNG HTTP ${post.status}: ${(await post.text()).slice(0, 200)}`)
    const count = post.headers.get('compression-count')
    if (count) stats.compressionCount = +count
    const { output } = await post.json()
    const out = Buffer.from(await (await fetch(output.url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(120_000) })).arrayBuffer())
    if (out.length >= buf.length * 0.98) return { buf, compressed: false, note: '压缩收益<2%,保留原图' }
    return { buf: out, compressed: true, note: '' }
  }
  throw new Error('TinyPNG 所有 key 均不可用')
}

// ---------- 落地 ----------
function bumpFilename(dir, base, ext) {
  // 换同路径图片必须升文件名防缓存:foo.png → foo_v2.png → …
  let name = `${base}.${ext}`, n = 1
  while (fs.existsSync(path.join(dir, name))) { n += 1; name = `${base}_v${n}.${ext}` }
  return name
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

function dirSize(dir) {
  let t = 0
  if (!fs.existsSync(dir)) return 0
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isFile()) t += fs.statSync(p).size
  }
  return t
}

// ---------- 主流程 ----------
async function main() {
  let items
  if (opts.ui) {
    // UI 设计稿模式:5 个排版方向 × 同一界面内容,风格由 style 锚点保证一致。
    // 字体约束:全图统一一种字体(生图只能控方向,控不了字体文件;真实字体以 theme/ token 为准)
    const uiFont = cfg.typography?.uiFont ?? '全界面统一使用同一种圆润无衬线中文字体, 字号层级清晰'
    items = UI_LAYOUTS.map((hint, i) => ({
      name: `ui-${i + 1}`,
      text: `移动端App界面设计稿, 完整界面视图。界面内容: ${opts.ui}。排版方向: ${hint}。${uiFont}。图标与插画资源丰富, 动效与光影特效点缀, 精致高级质感`,
    }))
  } else {
    const promptsFile = path.resolve(opts.prompts)
    if (!fs.existsSync(promptsFile)) die(`提示词文件不存在: ${promptsFile}`)
    items = []
    const seen = new Set()
    for (const raw of fs.readFileSync(promptsFile, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const m = line.match(/^([\w-]+)\s*\|\s*(.+)$/)
      const name = m ? m[1] : line.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'img'
      if (seen.has(name)) die(`提示词名称重复: ${name}`)
      seen.add(name)
      items.push({ name, text: m ? m[2] : line })
    }
  }
  if (items.length === 0) die('提示词为空')

  const outDir = path.resolve(opts.out || cfg.output.inPackage || 'generated')
  fs.mkdirSync(outDir, { recursive: true })
  const manifestPath = path.join(outDir, 'manifest.json')
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { version: VERSION, items: [] }

  // 并发单元:每条提示词 × count
  const units = []
  for (const p of items) for (let k = 0; k < opts.count; k++) units.push({ ...p, seq: units.length })

  console.log(`[art] ${items.length} 条提示词 × ${opts.count} = ${units.length} 张 | 并发 ${concurrency} | 模型: ${cfg.api.models.join(', ')} | ${imageConfig.aspect_ratio}/${imageConfig.image_size}${refsNote(opts)}`)

  // 关键词优化:可选 LLM 改写(串行,失败回退原文),再统一组装
  for (const u of units) {
    if (cfg.prompt?.optimizeModel && !opts.dryRun) u.text = await optimizeWithLLM(cfg, u.text)
    u.finalPrompt = composePrompt(cfg, u.text)
  }
  if (opts.dryRun) {
    for (const u of units) console.log(`\n[dry-run] ${u.name}: ${u.finalPrompt}`)
    process.exit(0)
  }

  const refs = loadRefs()
  const keys = tinifyKeys(cfg)
  const dead = new Set()
  const stats = { totalCost: 0, compressionCount: null, failed: 0, report: [] }

  async function worker(queue) {
    while (queue.length) {
      const u = queue.shift()
      const t0 = Date.now()
      try {
        let r = null
        for (const model of cfg.api.models) {
          try {
            r = await generateImage(cfg, model, u.finalPrompt, refs)
            if (r.images.length === 0) { console.warn(`  [${u.name}] [${model}] 未返回图片(${r.text.slice(0, 60)})→ 换模型`); continue }
            u.model = model; break
          } catch (e) { console.warn(`  [${u.name}] [${model}] ${e.message} → 换模型`) }
        }
        if (!r || r.images.length === 0) { stats.failed++; console.error(`  ✗ ${u.name} 全部模型失败`); continue }
        for (let idx = 0; idx < r.images.length; idx++) {
          const img = r.images[idx]
          const c = await tinifyCompress(img.buf, keys, dead, stats)
          const file = bumpFilename(outDir, u.name, img.ext)
          fs.writeFileSync(path.join(outDir, file), c.buf)
          const dim = pngSize(c.buf)
          manifest.items.push({
            name: r.images.length === 1 ? u.name : `${u.name}_${idx + 1}`,
            prompt: u.finalPrompt, model: u.model, cost: +(r.cost / r.images.length).toFixed(4),
            width: dim.w, height: dim.h, bytes: c.buf.length,
            compressed: c.compressed, ref: refs.length > 0,
            ratio: imageConfig.aspect_ratio, size: imageConfig.image_size,
            elapsedSec: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString(),
          })
          stats.totalCost += r.cost / r.images.length
          const over = c.buf.length > maxKB * 1024
          stats.report.push({ file, model: u.model, cost: r.cost / r.images.length, w: dim.w, h: dim.h, bytes: c.buf.length, elapsed: Math.round((Date.now() - t0) / 1000), prompt: u.finalPrompt, over, compressed: c.compressed, note: c.note })
          console.log(`  ✓ ${u.name} ← [${u.model}] ${file} ${dim.w}x${dim.h} ${(c.buf.length / 1024).toFixed(0)}KB ${Math.round((Date.now() - t0) / 1000)}s`)
        }
      } catch (e) {
        stats.failed++
        console.error(`  ✗ ${u.name}: ${e.message}`)
      }
    }
  }
  const queue = [...units]
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker(queue)))

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  // 生成报告:每张图提示词/模型/花费一目了然,可直接转发
  console.log('\n═══ 生成报告 ═══')
  for (const it of stats.report) {
    console.log(`${it.file} | ${it.model} | $${it.cost.toFixed(4)} | ${it.w}x${it.h} ${(it.bytes / 1024).toFixed(0)}KB | ${it.elapsed}s${it.compressed ? '' : ` | ${it.note}`}`)
    console.log(`  提示词: ${it.prompt}`)
  }
  const overs = stats.report.filter((it) => it.over)
  if (overs.length) {
    console.log(`\n[提醒] ${overs.length} 张超过 ${maxKB}KB(压缩一次后仍超): ${overs.map((o) => o.file).join(', ')}`)
    console.log('  未做二次压缩/降质(保色彩保清晰度)。若包体不够,由人工决策:缩小显示尺寸 / 裁切留白 / 走 COS 下发,不要压质量。')
  }
  console.log(`\n[成本] 本次 $${stats.totalCost.toFixed(3)}${stats.compressionCount !== null ? ` | TinyPNG 本月已用 ${stats.compressionCount} 张` : ''}`)
  const size = dirSize(outDir)
  const over = size > maxTotalMB * 1024 * 1024
  console.log(`[红线] ${outDir} ${(size / 1048576).toFixed(2)}MB / ${maxTotalMB}MB ${over ? '❌ 超限' : '✅'}`)
  if (stats.failed > 0) process.exit(3)
  if (over) process.exit(2)
}

function refsNote(opts) {
  return opts.refs ? ` | 参考图 ${opts.refs.length} 张` : ''
}

main().catch((e) => die(e.stack || e.message))
