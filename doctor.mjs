#!/usr/bin/env node
/**
 * miniapp-kit/doctor —— 环境体检(只报告,绝不自动下载/安装)
 *
 * 换新环境或换机器时先跑一遍,缺失项列成清单与用户确认后再装。
 * 用法: node doctor.mjs
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ok = []
const missing = [] // { item, how } —— 安装方式仅供确认后参考,脚本不执行

function check(name, pass, detail = '', how = '') {
  ;(pass ? ok : missing).push({ name, detail, how })
}

// 1. Node 版本(fetch/AbortSignal.timeout 需要 ≥18)
const nodeVer = +process.version.slice(1).split('.')[0]
check('Node ≥ 18', nodeVer >= 18, `当前 ${process.version}`, '升级 Node.js(官网或 nvm)')

// 2. 密钥环境变量
const codex = process.env.CODEX_API_KEY?.trim()
check('生图 key(CODEX_API_KEY)', !!codex, codex ? `已配置(${codex.length} 字符)` : '缺失', '设为系统环境变量,不写入任何文件')
const tinyKeys = ['TINYPNG_API_KEY', 'TINYPNG_API_KEY_2', 'TINYPNG_API_KEY_3', 'TINYPNG_API_KEY_4', 'TINYPNG_API_KEY_5']
  .map((n) => process.env[n]?.trim()).filter(Boolean)
check('TinyPNG key(至少 1 个)', tinyKeys.length > 0,
  tinyKeys.length ? `已配置 ${tinyKeys.length} 个` : '缺失(压缩会跳过,仅提醒不压缩)',
  'tinypng.com/developers 免费申请,设 TINYPNG_API_KEY(备用 _2.._5)')

// 3. 项目配置
check('art.config.json(当前目录)', fs.existsSync('art.config.json'), 'gen.mjs -c 需要它', '复制 art/art.config.example.json 后按项目修改')

// 4. 可选 npm 依赖(cos 上传用)
let cosOk = false
try { await import('cos-nodejs-sdk-v5'); cosOk = true } catch { }
check('cos-nodejs-sdk-v5(cos 模块用)', cosOk, cosOk ? '已安装' : '未安装', '在本仓库 npm install(可选依赖)')

// 5. 抠图环境:色键(任意 cv2)与 SAM2 管线(torch+sam2+transformers)
function pyProbe(code) {
  const candidates = [process.env.PYTHON_MATTING, 'python', 'python3'].filter(Boolean)
  for (const py of candidates) {
    try {
      execSync(`${py} -c "${code}"`, { stdio: 'pipe', timeout: 60_000 })
      return { pass: true, py }
    } catch { /* 下一个 */ }
  }
  return { pass: false }
}
const cv2Probe = pyProbe('import cv2')
check('色键抠图(cv2)', cv2Probe.pass, cv2Probe.pass ? `可用(${cv2Probe.py})` : '未找到 cv2', 'pip install opencv-python numpy pillow')
const sam2Code = 'import torch, sam2, transformers, cv2; assert torch.cuda.is_available()'
const sam2Probe = pyProbe(sam2Code)
check('SAM2 抠图管线(torch+CUDA+sam2+transformers)', sam2Probe.pass,
  sam2Probe.pass ? `可用(${sam2Probe.py})` : '未找到可用环境',
  '建 python3.10-3.11 venv:装 torch(带 CUDA)+sam2+transformers+opencv-python;装完设 PYTHON_MATTING 指向其 python')
const ckpt = process.env.SAM2_CHECKPOINT?.trim()
check('SAM2 权重(SAM2_CHECKPOINT)', !!ckpt && fs.existsSync(ckpt), ckpt ? (fs.existsSync(ckpt) ? ckpt : `路径不存在: ${ckpt}`) : '未设置', '下载 sam2.1_hiera_small.pt 后设 SAM2_CHECKPOINT 环境变量')
const hfCache = path.join(os.homedir(), '.cache', 'huggingface', 'hub')
const vitmatteCached = fs.existsSync(hfCache) && fs.readdirSync(hfCache).some((d) => d.includes('vitmatte'))
check('ViTMatte 模型缓存(可选,精修用)', vitmatteCached, vitmatteCached ? '已缓存' : '未缓存(不用 --vitmatte 则不影响)', '首次跑 --vitmatte 时自动从 HuggingFace 下载,需网络')
const ben2 = process.env.BEN2_WEIGHTS?.trim()
check('BEN2 权重(BEN2_WEIGHTS,抠图首选)', !!ben2 && fs.existsSync(ben2), ben2 ? (fs.existsSync(ben2) ? ben2 : `路径不存在: ${ben2}`) : '未设置(ben2 抠图法不可用)', '下载 BEN2_Base.safetensors(HuggingFace PramaLLC/BEN2,约380MB)后设 BEN2_WEIGHTS')

// 汇总
console.log('═══ miniapp-kit 环境体检 ═══\n')
for (const { name, detail } of ok) console.log(`  ✅ ${name}${detail ? ` —— ${detail}` : ''}`)
if (missing.length) {
  console.log('')
  for (const { name, detail, how } of missing) {
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`)
    if (how) console.log(`     安装方式(确认后再执行): ${how}`)
  }
}
console.log(`\n结论:${ok.length} 项就绪,${missing.length} 项缺失。缺失项是否下载/安装,请与用户确认;本脚本不会自动安装任何东西。`)
process.exit(missing.length ? 1 : 0)
