#!/usr/bin/env node
/**
 * miniapp-kit/theme —— 字体字号 token:JSON 单一事实源 → typography.scss
 *
 * 解决的问题:小程序 UI 里字体、字号散落在各处样式里,没有约束。
 * 约定:全项目默认用同一个字体(系统字体栈兜底);字号不写裸值,
 *       按"文字类型"(标题/正文/按钮/数字…)配置成语义 token,每个 token
 *       是 字号+行高+字重 成组的一枚,附 CSS 自定义属性与 .t-* 工具类。
 *
 * 用法:
 *   cp theme/typography.example.json <项目根>/typography.json   # 按项目改字号表
 *   node <本仓库>/theme/build-typography.mjs -c <项目根>/typography.json \
 *        [-o <项目>/src/styles/typography.scss]
 *   # -o 缺省时输出到配置文件同目录 typography.scss
 *
 * 生成物三种引用方式(任选,混用亦可):
 *   SCSS 变量        font-size: $t-title-size;
 *   CSS 自定义属性   font-size: var(--t-title-size);   (挂 page 根,小程序/H5 生效)
 *   工具类           <Text className="t-title">
 *
 * 密钥无关,纯本地转换,无网络无副作用(只写 -o 指定的那一个文件)。
 */

import fs from 'node:fs'
import path from 'node:path'

const VERSION = '1.0.0'

// ---------- CLI ----------
const argv = process.argv.slice(2)
const opts = {}
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-c') opts.config = argv[++i]
  else if (argv[i] === '-o') opts.out = argv[++i]
  else if (argv[i] === '-h' || argv[i] === '--help') opts.help = true
}
if (opts.help || !opts.config) {
  console.log('用法: node theme/build-typography.mjs -c <项目>/typography.json [-o 输出.scss]')
  process.exit(opts.help ? 0 : 1)
}
function die(msg) { console.error(`[theme] 错误: ${msg}`); process.exit(1) }

// ---------- 读取与校验 ----------
const cfgPath = path.resolve(opts.config)
if (!fs.existsSync(cfgPath)) die(`配置不存在: ${cfgPath}(模板见 theme/typography.example.json)`)
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const strip = (o) => { for (const k of Object.keys(o ?? {})) if (k === '$comment') delete o[k] }
strip(cfg); strip(cfg.fontFamily); strip(cfg.types)

if (!cfg.fontFamily?.default) die('fontFamily.default 必填(全站默认字体,建议系统字体栈)')
const types = cfg.types ?? {}
const names = Object.keys(types)
if (names.length === 0) die('types 至少配置一个文字类型(参考 typography.example.json)')
for (const name of names) {
  const t = types[name] ?? {}
  if (!(t.fontSize > 0) || t.fontSize > 200) die(`types.${name}.fontSize 需为 1-200 的 rpx 数值`)
  if (!(t.lineHeight > 0)) die(`types.${name}.lineHeight 必填(建议 1.0-2.0)`)
  const fam = t.family
  // 字体族允许留空(生成时回退 default),但引用的键必须存在
  if (fam && fam !== 'default' && !(fam in cfg.fontFamily)) die(`types.${name}.family="${fam}" 在 fontFamily 里未配置`)
}
const outPath = path.resolve(opts.out || path.join(path.dirname(cfgPath), 'typography.scss'))

// ---------- 生成 ----------
const rpx = (n) => `${n}rpx`
const famLine = (t) => {
  if (t.family === 'number') return '$t-font-number'
  if (t.family === 'brand') return '$t-font-brand'
  return '$t-font'
}
const varOf = (name, suffix) => `--t-${name}-${suffix}`

const scssVars = []
const cssVars = []
const classes = []
for (const name of names) {
  const t = types[name]
  const num = t.numeric ? `  font-variant-numeric: tabular-nums;` : ''
  scssVars.push(`$t-${name}-size: ${rpx(t.fontSize)}; $t-${name}-lh: ${t.lineHeight}; $t-${name}-weight: ${t.weight ?? 400};${t.desc ? ` // ${t.desc}` : ''}`)
  cssVars.push(`  ${varOf(name, 'size')}: ${rpx(t.fontSize)};\n  ${varOf(name, 'lh')}: ${t.lineHeight};\n  ${varOf(name, 'weight')}: ${t.weight ?? 400};`)
  classes.push([
    `// ${t.desc || name}`,
    `.t-${name} {`,
    `  font-size: $t-${name}-size;`,
    `  line-height: $t-${name}-lh;`,
    `  font-weight: $t-${name}-weight;`,
    ...(t.family && t.family !== 'default' ? [`  font-family: ${famLine(t)};`] : []),
    ...(num ? [num] : []),
    `}`,
  ].join('\n'))
}

const numberFont = cfg.fontFamily.number || cfg.fontFamily.default
const brandFont = cfg.fontFamily.brand || cfg.fontFamily.default

const scss = `/**
 * typography.scss —— 由 miniapp-kit theme/build-typography.mjs ${VERSION} 自动生成,勿手改
 * 源: ${cfgPath}
 * 生成时间: ${new Date().toISOString()}
 * 唯一事实源是 typography.json,改配置后重新生成。
 * 规则:组件样式里禁止写裸 font-size / font-family,引用下面的变量 / var(--t-*) / .t-* 类。
 */

// ---------- 字体族 ----------
$t-font: ${cfg.fontFamily.default};
// 数字场景(价格/倒计时)专用;未配置则与默认一致
$t-font-number: ${numberFont};
// 品牌字体:中文字体必须子集化后传 COS,项目侧 wx.loadFontFace 加载,失败回退 $t-font
$t-font-brand: ${brandFont};

// ---------- 字号 token(字号+行高+字重成组) ----------
${scssVars.join('\n')}

// ---------- CSS 自定义属性(挂 page 根) ----------
page {
  --t-font: ${cfg.fontFamily.default};
${cssVars.join('\n')}
}

// ---------- 工具类(与 token 同名) ----------
${classes.join('\n\n')}
`

fs.writeFileSync(outPath, scss, 'utf8')
console.log(`[theme] ${names.length} 个文字类型 → ${outPath}`)
console.log(`[theme] 类型: ${names.join(', ')}`)
console.log(`[theme] 引用方式: SCSS 变量 / var(--t-*) / .t-* 类;组件里禁止裸 font-size、font-family`)
