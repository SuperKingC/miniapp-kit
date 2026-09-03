#!/usr/bin/env node
/**
 * miniart-kit —— 小程序美术资产生图流水线
 *
 * 流程:提示词组装(风格锚定) → 调 chat/completions 生图 → 多图去重命名
 *       → TinyPNG 压缩(降分辨率→压质量) → 防缓存升文件名 → manifest 留痕 → 主包体积红线检查
 *
 * 用法:
 *   node gen.mjs --config path/to/art.config.json --prompts prompts.txt
 *   node gen.mjs -c art.config.json -p prompts.txt --out override/dir
 *
 * prompts.txt 格式:每行一条,支持 `name|prompt` 前缀命名;# 开头为注释。
 *   icon-home|主页入口图标,圆形,猫爪元素
 * 密钥:只从环境变量读取(config.api.keyEnv 指定变量名),绝不写入配置文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';

// ---------- CLI ----------
function parseArgs(argv) {
  const args = { config: 'art.config.json', prompts: 'prompts.txt' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--config') args.config = argv[++i];
    else if (a === '-p' || a === '--prompts') args.prompts = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function die(msg) {
  console.error(`[miniart] 错误: ${msg}`);
  process.exit(1);
}

// ---------- 配置加载与校验 ----------
function loadConfig(p) {
  if (!fs.existsSync(p)) die(`配置文件不存在: ${p}`);
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const k of ['style', 'api', 'compress', 'output']) {
    if (!(k in cfg)) die(`配置缺少必填字段: ${k}`);
  }
  if (!Array.isArray(cfg.api.models) || cfg.api.models.length === 0) {
    die('api.models 至少配置一个模型');
  }
  return cfg;
}

function loadPrompts(p) {
  if (!fs.existsSync(p)) die(`提示词文件不存在: ${p}`);
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const items = [];
  const seen = new Set();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let name = null;
    let text = line;
    const m = line.match(/^([\w-]+)\s*\|\s*(.+)$/);
    if (m) { name = m.group1 ?? m[1]; text = m[2]; }
    if (!name) name = slugify(text);
    if (seen.has(name)) die(`提示词名称重复: ${name}`);
    seen.add(name);
    items.push({ name, text });
  }
  if (items.length === 0) die('提示词文件为空');
  return items;
}

function slugify(s) {
  const cjk = s.match(/[\u4e00-\u9fa5]{2,4}/g);
  const ascii = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return (ascii || (cjk ? cjk.slice(0, 2).join('-') : 'img')).slice(0, 40);
}

// ---------- 生图 ----------
const IMAGE_MODELS_HINT = /(image|banana|seedream|cogview|flux)/i;

async function generateImage(cfg, prompt, model) {
  const keyEnv = cfg.api.keyEnv || 'CODEX_API_KEY';
  const key = process.env[keyEnv];
  if (!key) die(`环境变量 ${keyEnv} 未设置,无法调用生图接口`);

  const base = cfg.api.baseUrl.replace(/\/+$/, '');
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    modalities: ['image', 'text'],
  };
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`返回非 JSON: ${text.slice(0, 200)}`); }
  if (data.error) throw new Error(`接口错误: ${JSON.stringify(data.error).slice(0, 300)}`);

  const msg = data.choices?.[0]?.message || {};
  const images = Array.isArray(msg.images) ? msg.images : [];
  const out = [];
  const seenDataUrl = new Set();
  for (const im of images) {
    const url = im?.image_url?.url || '';
    const m = url.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!m) continue;
    // 同一响应里重复的 base64 只保留一张(gemini-3-pro 实测会一次吐多张相同图)
    if (seenDataUrl.has(m[2])) continue;
    seenDataUrl.add(m[2]);
    out.push({ ext: m[1] === 'jpeg' ? 'jpg' : m[1], buf: Buffer.from(m[2], 'base64') });
  }
  return {
    images: out,
    content: (msg.content || '').trim(),
    cost: data.usage?.cost ?? 0,
    imageTokens: data.usage?.completion_tokens_details?.image_tokens ?? 0,
  };
}

// ---------- TinyPNG 压缩 ----------
async function tinifyFromBuffer(key, buf) {
  const res = await fetch('https://api.tinify.com/shrink', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${key}`).toString('base64')}`,
      'Content-Type': 'application/octet-stream',
    },
    body: buf,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`TinyPNG HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  const loc = j?.output?.url;
  if (!loc) throw new Error(`TinyPNG 返回异常: ${JSON.stringify(j).slice(0, 200)}`);
  const dl = await fetch(loc);
  return Buffer.from(await dl.arrayBuffer());
}

/** 降分辨率(纯 Node 无依赖,PNG/JPEG 均按最大边缩放到 maxSide) */
async function downscale(buf, maxSide) {
  if (!maxSide) return buf;
  const dim = readPngOrJpegSize(buf);
  if (!dim) return buf;
  const long = Math.max(dim.w, dim.h);
  if (long <= maxSide) return buf;
  const ratio = maxSide / long;
  return await sharpDownscale(buf, Math.round(dim.w * ratio), Math.round(dim.h * ratio));
}

// 最小化 PNG/JPEG 尺寸读取(避免为读尺寸引入依赖)
function readPngOrJpegSize(buf) {
  // PNG
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: 扫 SOF0/2
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
  }
  return null;
}

// sharp 为可选依赖:未安装时跳过降分辨率,只做 TinyPNG(其 resize 也能兜底)
async function sharpDownscale(buf, w, h) {
  try {
    const mod = await import('sharp');
    const sharp = mod.default ?? mod;
    return await sharp(buf).resize(w, h).png().toBuffer();
  } catch {
    console.warn('[miniart] 未安装 sharp,跳过降分辨率(TinyPNG resize 会兜底)');
    return buf;
  }
}

// ---------- 防缓存文件名 ----------
function bumpFilename(dir, base, ext) {
  // 换同路径图片必须升文件名:foo.png → foo_v2.png → foo_v3.png …
  let name = `${base}.${ext}`;
  let n = 1;
  while (fs.existsSync(path.join(dir, name))) {
    n += 1;
    name = `${base}_v${n}.${ext}`;
  }
  return name;
}

// ---------- 主包体积红线 ----------
function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) total += fs.statSync(p).size;
  }
  return total;
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node gen.mjs -c art.config.json -p prompts.txt [--out dir] [--dry-run]');
    process.exit(0);
  }
  const cfg = loadConfig(args.config);
  const prompts = loadPrompts(args.prompts);

  const outDir = path.resolve(args.out || cfg.output.inPackage || 'generated');
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { version: VERSION, items: [] };

  const tinyKey = process.env[cfg.compress.tinypngKeyEnv || 'TINYPNG_API_KEY'];
  if (!tinyKey) {
    console.warn('[miniart] 警告: 未设置 TinyPNG key,图片将只降分辨率不压缩(TINYPNG_API_KEY)');
  }
  const maxKB = cfg.compress.maxKB ?? 180;
  const redLineMB = cfg.compress.packageRedLineMB ?? 2;

  console.log(`[miniart] ${prompts.length} 条提示词 | 模型: ${cfg.api.models.join(', ')}`);
  if (args.dryRun) {
    for (const p of prompts) {
      console.log(`\n[dry-run] name=${p.name}\n  最终提示词: ${composePrompt(cfg, p.text)}`);
    }
    process.exit(0);
  }

  for (const p of prompts) {
    const finalPrompt = composePrompt(cfg, p.text);
    console.log(`\n[生图] ${p.name}: ${finalPrompt}`);
    let ok = false;
    for (const model of cfg.api.models) {
      try {
        const t0 = Date.now();
        const r = await generateImage(cfg, finalPrompt, model);
        if (r.images.length === 0) {
          console.warn(`  [${model}] 未返回图片, content: ${r.content.slice(0, 80)} → 换下一个模型`);
          continue;
        }
        for (let idx = 0; idx < r.images.length; idx++) {
          const img = r.images[idx];
          const buf = await downscaleToTargets(img.buf, cfg, p.name, idx);
          const final = await compressAndSave(buf, cfg, outDir, p.name, idx, tinyKey, maxKB);
          manifest.items.push({
            name: idx === 0 ? p.name : `${p.name}_${idx + 1}`,
            prompt: finalPrompt,
            model,
            cost: r.cost / r.images.length,
            width: final.width, height: final.height,
            file: final.file, bytes: final.bytes,
            at: new Date().toISOString(),
          });
          console.log(`  [${model}] ${final.file} ${final.width}x${final.height} ${(final.bytes / 1024).toFixed(0)}KB`);
        }
        ok = true;
        break;
      } catch (e) {
        console.warn(`  [${model}] 失败: ${e.message} → 换下一个模型`);
      }
    }
    if (!ok) console.error(`  ✗ ${p.name} 所有模型均失败,跳过(可修提示词后重跑)`);
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n[manifest] 已写入 ${manifestPath}(共 ${manifest.items.length} 条)`);

  const size = dirSize(outDir);
  const limit = redLineMB * 1024 * 1024;
  console.log(`[红线] ${outDir} 当前 ${(size / 1024 / 1024).toFixed(2)}MB / 上限 ${redLineMB}MB ${size > limit ? '❌ 超红线!' : '✅'}`);
  if (size > limit) process.exit(2);
}

function composePrompt(cfg, text) {
  const noText = ' 画面中不得出现任何文字、字母、数字';
  return `${cfg.style}, ${text}.${noText}`;
}

function downscaleToTargets(buf, cfg, name, idx) {
  const targets = cfg.compress.resize || {};
  const rule = targets[name] ?? targets[`${name.split('-')[0]}-*`] ?? targets['*'] ?? null;
  if (!rule) return Promise.resolve(buf);
  return downscale(buf, rule);
}

async function compressAndSave(buf, cfg, outDir, baseName, idx, tinyKey, maxKB) {
  let finalBuf = buf;
  let ext = cfg.compress.format === 'jpeg' ? 'jpg' : 'png';
  if (tinyKey) {
    let compressed = await tinifyFromBuffer(tinyKey, buf);
    if (compressed.length > maxKB * 1024) {
      // 二次压:再送 TinyPNG 一轮(它对 PNG8/JPEG 自动选格式)
      compressed = await tinifyFromBuffer(tinyKey, compressed);
    }
    finalBuf = compressed;
    if (compressed.length > maxKB * 1024) {
      console.warn(`  ⚠ 压缩后仍 ${Math.round(compressed.length / 1024)}KB > ${maxKB}KB,保留但请人工检查`);
    }
  }
  const file = bumpFilename(outDir, baseName, ext);
  fs.writeFileSync(path.join(outDir, file), finalBuf);
  const dim = readPngOrJpegSize(finalBuf) || { w: 0, h: 0 };
  return { file, bytes: finalBuf.length, width: dim.w, height: dim.h };
}

main().catch((e) => { die(e.stack || e.message); });
