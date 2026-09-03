#!/usr/bin/env node
/**
 * anim/probe-i2v.mjs —— 中转站图生视频(I2V)能力探测(实验脚本,不进常规流水线)
 *
 * 视频不在 chat/completions 上(/models 与该通道均无视频模型),走独立的异步三步接口:
 *   创建  POST   {baseUrl}/videos          model/prompt/frame_images(first_frame)/resolution
 *   轮询  GET    {baseUrl}/videos/{jobId}  completed / failed / 其它=处理中(建议 3-5s 一次)
 *   下载  GET    {baseUrl}/videos/{jobId}/content
 *
 * 步骤与费用:
 *   ① --models-only:对 /videos 接口做模型名存在性探测(畸形体 oracle,全免费)
 *   ② 默认:用 --ref 首帧图实测一次 I2V(720p 一条,按条计费)
 *
 * 结果落 art/generated-art/probe-i2v/(probe-manifest.json + 首帧/视频副本),已 gitignore。
 * 结论人工目检视频质量后写进 anim/README.md。
 *
 * 用法:
 *   node anim/probe-i2v.mjs -c art.config.json --models-only
 *   node anim/probe-i2v.mjs -c art.config.json --ref 首帧.png [--model kwaivgi/kling-v3.0-pro] [--resolution 720p]
 * 密钥只从环境变量/.env 读(config 指定变量名),禁止写入任何文件。
 */

import fs from 'node:fs'
import path from 'node:path'

// 仓库根 .env 自动加载(已 gitignore);进程环境变量优先
try {
  for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
} catch { /* 无 .env 时跳过 */ }

const VERSION = '0.2.0'
const REF_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
const DEFAULT_MODEL = 'kwaivgi/kling-v3.0-pro' // 中转站视频接口文档示例模型

// 运动提示词模板:图管长相,词管动作——只描述运动,不复述外观,防止模型重绘角色
const MOTION_PROMPT = [
  '以首帧图为起点让画面动起来:镜头固定不动,角色轻微呼吸起伏、细微的待机动作,整体动作幅度小而柔和。',
  '画面无缝循环,首尾帧一致。不要镜头切换、不要镜头运动、不要元素变形、不要新增或删除元素。',
  'Subtle idle animation, fixed camera, seamless loop, first and last frames match.',
].join('')

const argv = process.argv.slice(2)
const opts = { config: 'art.config.json', model: DEFAULT_MODEL, resolution: '720p' }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '-c') opts.config = argv[++i]
  else if (a === '--models-only') opts.modelsOnly = true
  else if (a === '--ref') opts.ref = argv[++i]
  else if (a === '--model') opts.model = argv[++i]
  else if (a === '--resolution') opts.resolution = argv[++i]
  else if (a === '-h' || a === '--help') opts.help = true
}
if (opts.help) {
  console.log('用法: node anim/probe-i2v.mjs -c art.config.json [--models-only] [--ref 首帧.png] [--model kwaivgi/kling-v3.0-pro] [--resolution 720p]')
  process.exit(0)
}
function die(msg) { console.error(`[probe-i2v] 错误: ${msg}`); process.exit(1) }

const cfgPath = path.resolve(opts.config)
if (!fs.existsSync(cfgPath)) die(`配置不存在: ${cfgPath}`)
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const key = process.env[cfg.api.keyEnv || 'CODEX_API_KEY']
if (!key) die(`环境变量 ${cfg.api.keyEnv || 'CODEX_API_KEY'} 未设置`)
const base = cfg.api.baseUrl.replace(/\/+$/, '')
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
const outDir = path.resolve(path.dirname(cfgPath), 'art', 'generated-art', 'probe-i2v')
fs.mkdirSync(outDir, { recursive: true })
const manifestPath = path.join(outDir, 'probe-manifest.json')
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { version: VERSION }
manifest.version = VERSION

function saveManifest() { fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)) }

// ---------- ① 模型名存在性探测(免费 oracle) ----------
// 畸形体(messages 传字符串):模型不存在 → "Model xxx does not exist";存在 → 参数校验错(发生在计费前)
// 注意:/videos 的错误码是笼统的 "400",区分信号在 error.message 文本里
async function modelExists(model) {
  const res = await fetch(`${base}/videos`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ model, messages: 'malformed-on-purpose' }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  const unknown = res.status === 404 || /does not exist|model_not_found|Unknown model|不支持|不存在/i.test(text)
  return { model, status: res.status, code: text.slice(0, 200), exists: !unknown }
}

if (opts.modelsOnly) {
  console.log(`[probe-i2v] /videos 接口模型名存在性探测(畸形体 oracle,免费)`)
  const candidates = [
    DEFAULT_MODEL,
    'kwaivgi/kling-v3.0-std', 'kwaivgi/kling-v3.0-master', 'kwaivgi/kling-v2.1-master', 'kwaivgi/kling-v1.6-pro',
    'minimax/hailuo-02', 'minimax/video-01', 'openai/sora-2', 'google/veo-3',
    'bytedance/seedance-1-pro', 'bytedance/seedance-1-lite', 'alibaba/wan2.2-i2v',
    'runway/gen4-turbo', 'luma/ray-2', 'pixverse/pixverse-v4', 'vidu/vidu-q1',
  ]
  const rows = []
  for (const c of candidates) rows.push(await modelExists(c))
  for (const r of rows) console.log(`  ${r.exists ? '✓ 存在' : '✗ 无'} ${r.model} -> ${r.status} ${r.code.slice(0, 80)}`)
  manifest.step = 'models-existence'
  manifest.models = rows
  saveManifest()
  console.log(`\n[probe-i2v] manifest: ${manifestPath}`)
  process.exit(0)
}

// ---------- ② I2V 实测:创建 → 轮询 → 下载 ----------
if (!opts.ref) die('需要 --ref 首帧图(可先 art/gen.mjs 生成);不想花钱就只跑 --models-only')
const refPath = path.resolve(opts.ref)
if (!fs.existsSync(refPath)) die(`首帧图不存在: ${refPath}`)
const refMime = REF_MIME[path.extname(refPath).toLowerCase()]
if (!refMime) die('首帧图只支持 jpg/png/webp')
const refDataUrl = `data:${refMime};base64,${fs.readFileSync(refPath).toString('base64')}`
fs.copyFileSync(refPath, path.join(outDir, `firstframe${path.extname(refPath).toLowerCase()}`))

const rec = { model: opts.model, resolution: opts.resolution, prompt: MOTION_PROMPT, firstFrame: path.basename(refPath), at: new Date().toISOString() }
console.log(`[probe-i2v] I2V 实测: ${opts.model} @ ${opts.resolution}(一条计费,异步三步)`)

try {
  // 创建
  const createRes = await fetch(`${base}/videos`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      model: opts.model,
      prompt: MOTION_PROMPT,
      frame_images: [{ type: 'image_url', image_url: { url: refDataUrl }, frame_type: 'first_frame' }],
      resolution: opts.resolution,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const createText = await createRes.text()
  if (!createRes.ok) throw new Error(`创建失败 HTTP ${createRes.status}: ${createText.slice(0, 400)}`)
  let created
  try { created = JSON.parse(createText) } catch { throw new Error(`创建响应非 JSON: ${createText.slice(0, 200)}`) }
  rec.createResponse = created
  const jobId = created.id ?? created.jobId ?? created.job_id ?? created.task_id ?? created.taskId ?? created.data?.id
  if (!jobId) throw new Error(`创建响应里没找到任务 ID,字段: [${Object.keys(created).join(', ')}]`)
  rec.jobId = jobId
  console.log(`  创建成功 jobId=${jobId},轮询中(3-5s 一次,视频生成通常 1-5 分钟)…`)

  // 轮询
  const POLL_MS = 4000
  const TIMEOUT_MS = 15 * 60_000
  const t0 = Date.now()
  let status = null
  let last = null
  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const pollRes = await fetch(`${base}/videos/${jobId}`, { headers: auth, signal: AbortSignal.timeout(30_000) })
    if (!pollRes.ok) throw new Error(`轮询失败 HTTP ${pollRes.status}: ${(await pollRes.text()).slice(0, 300)}`)
    last = await pollRes.json()
    status = last.status ?? last.state ?? last.data?.status
    process.stdout.write(`  [${Math.round((Date.now() - t0) / 1000)}s] ${status}\n`)
    if (status === 'completed' || status === 'failed') break
  }
  rec.pollResponse = last
  rec.cost = last?.usage?.cost ?? last?.data?.usage?.cost ?? last?.cost ?? 0
  if (status !== 'completed') throw new Error(`任务未完成: ${status ?? '超时(15 分钟)'} ${last?.error ? JSON.stringify(last.error).slice(0, 300) : ''}`)

  // 下载
  const dlRes = await fetch(`${base}/videos/${jobId}/content`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(300_000) })
  if (!dlRes.ok) throw new Error(`下载失败 HTTP ${dlRes.status}: ${(await dlRes.text()).slice(0, 300)}`)
  const buf = Buffer.from(await dlRes.arrayBuffer())
  rec.contentType = dlRes.headers.get('content-type')
  const file = `${opts.model.replace(/[^\w.-]+/g, '_')}_${opts.resolution}.mp4`
  fs.writeFileSync(path.join(outDir, file), buf)
  rec.file = file
  rec.bytes = buf.length
  rec.elapsedSec = Math.round((Date.now() - t0) / 1000)
  console.log(`  ✓ ${file} ${(buf.length / 1024 / 1024).toFixed(2)}MB type=${rec.contentType} $${(+rec.cost).toFixed(4)} ${rec.elapsedSec}s`)
  console.log('  人工目检要点:角色是否变形/漂移、循环首尾是否衔接、有无幻觉元素、提示词运动幅度是否服从')
} catch (e) {
  rec.error = e.message
  rec.elapsedSec = rec.elapsedSec ?? Math.round((Date.now() - (rec._t0 ?? Date.now())) / 1000)
  console.error(`  ✗ ${e.message.slice(0, 400)}`)
}
manifest.step = 'i2v'
manifest.i2v = rec
saveManifest()
console.log(`\n[probe-i2v] manifest: ${manifestPath}`)
if (rec.error) process.exit(3)
