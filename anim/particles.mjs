/**
 * anim/particles.mjs —— 零依赖 canvas 2d 粒子引擎(L2 储备层)
 *
 * 定位:点赞飘心、礼花、金币雨、落雪、星光、气泡这类高频氛围特效。
 * 不用 Lottie(要 AE 产线)不用序列帧(体积大):代码生成的粒子可随机、
 * 可交互触发,单文件 KB 级,小程序/Taro/H5 通用,拷走即用。
 *
 * 用法(微信小程序 canvas 2d):
 *   wxml:  <canvas type="2d" id="fx" class="fx" />
 *   js:    import { ParticleSystem } from '<本仓库>/anim/particles.mjs'
 *          wx.createSelectorQuery().select('#fx').fields({ node: true, size: true }).exec(([res]) => {
 *            const fx = new ParticleSystem(res.node, res.width, res.height)
 *            fx.burst({ preset: 'confetti' })          // 礼花:一次性,放完自停
 *            fx.burst({ preset: 'heart', x: 0.3, y: 0.8 }) // 点赞:从点击处(比例坐标)冒心
 *            fx.ambient({ preset: 'snow' })            // 落雪:持续氛围,stop() 停
 *          })
 *   生命周期:页面 onHide → fx.pause()(防后台空转耗电),onShow → fx.resume(),卸载 → fx.destroy()
 *
 * 坐标:x/y 用 0-1 的画布比例;角度 0°=右、90°=下、270°=上(canvas y 向下)。
 * 同一实例同一时刻跑一种模式(burst 或 ambient);要叠加就多开一个 canvas 实例。
 * 自定义预设:burst({ preset: { ...PRESETS.heart, colors: ['#f00'] } }) 传对象即可。
 */

const TAU = Math.PI * 2
const RAD = Math.PI / 180
const rand = (a, b) => a + Math.random() * (b - a)
const pick = (arr) => arr[(Math.random() * arr.length) | 0]

// ---------- 预设 ----------
// 通用字段:shapes/colors/speed/angle/gravity/drag/size/life/rotSpeed/flutter/flip/sway/fadeIn/fadeOut
// burst=一次性配置(count 起点 比例坐标 jitter 起点半径);ambient=持续配置(emitPerSec 每秒出生数, region 比例出生区)
export const PRESETS = {
  confetti: {
    desc: '礼花纸屑:中下部向上喷发,重力下落,翻转飘落',
    shapes: ['rect'], colors: ['#FF8C42', '#4A90D9', '#FFD166', '#EF476F', '#06D6A0'],
    speed: [280, 640], angle: [245, 295], gravity: 900, drag: 0.9,
    size: [6, 11], life: [1.2, 2.2], rotSpeed: [-540, 540], flutter: true, fadeOut: 0.35,
    burst: { count: 90, x: 0.5, y: 0.6, jitter: 0.03 },
  },
  heart: {
    desc: '点赞飘心:从底部点击处冒心,轻微上飘左右摇摆',
    shapes: ['heart'], colors: ['#FF5C8A', '#FF7FA5', '#FFA3BF'],
    speed: [160, 300], angle: [255, 285], gravity: -40, drag: 0.4,
    size: [14, 26], life: [1.4, 2], sway: [14, 26], fadeOut: 0.4,
    burst: { count: 7, x: 0.5, y: 0.85, jitter: 0.01 },
  },
  coin: {
    desc: '金币雨:向上抛洒金币,翻转下落',
    shapes: ['coin'], colors: ['#FFC53D', '#FFE08A'],
    speed: [260, 460], angle: [235, 305], gravity: 1100, drag: 0.25,
    size: [12, 18], life: [1, 1.6], flip: true, fadeOut: 0.3,
    burst: { count: 26, x: 0.5, y: 0.35, jitter: 0.04 },
  },
  spark: {
    desc: '星光爆闪:中心四散小星星,短促闪灭',
    shapes: ['star'], colors: ['#FFE066', '#FFD166', '#FFFFFF'],
    speed: [120, 320], angle: [0, 360], gravity: 260, drag: 0.2,
    size: [8, 16], life: [0.6, 1.1], rotSpeed: [-220, 220], fadeOut: 0.45,
    burst: { count: 16, x: 0.5, y: 0.5, jitter: 0.02 },
  },
  snow: {
    desc: '落雪:全宽顶部持续飘落,左右摇曳',
    shapes: ['circle'], colors: ['#FFFFFF', '#E8F1FF'],
    speed: [40, 90], angle: [80, 100], gravity: 0, drag: 0,
    size: [2, 5], life: [6, 10], sway: [10, 30], fadeIn: 0.5, fadeOut: 1,
    ambient: { emitPerSec: 12, region: { x: [0, 1], y: [-0.05, -0.05] } },
  },
  bubble: {
    desc: '气泡:底部持续上浮的半透明泡泡',
    shapes: ['circle'], colors: ['rgba(255,255,255,0.4)'],
    speed: [30, 70], angle: [260, 280], gravity: -15, drag: 0.1,
    size: [4, 11], life: [4, 8], sway: [8, 18], fadeOut: 0.6, stroke: true,
    ambient: { emitPerSec: 5, region: { x: [0, 1], y: [1.02, 1.02] } },
  },
}

// ---------- 引擎 ----------
export class ParticleSystem {
  /**
   * @param canvas  canvas 2d 节点(小程序)或 <canvas>(H5)
   * @param cssWidth/cssHeight  CSS 像素尺寸(小程序 fields({size}) 取到的宽高;内部按 DPR 放大画布)
   * @param opts { preset?: 名称|对象, maxParticles?: 默认 300 }
   */
  constructor(canvas, cssWidth, cssHeight, opts = {}) {
    if (!canvas || !canvas.getContext) throw new Error('[particles] 需要 canvas 2d 节点(type="2d")')
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.w = cssWidth
    this.h = cssHeight
    this.maxParticles = opts.maxParticles ?? 300
    const dpr = (typeof wx !== 'undefined' && wx.getWindowInfo && wx.getWindowInfo().pixelRatio)
      || (typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 2)
    canvas.width = Math.max(1, Math.round(cssWidth * dpr))
    canvas.height = Math.max(1, Math.round(cssHeight * dpr))
    this.ctx.scale(dpr, dpr)

    this._defaultPreset = this._resolve(opts.preset ?? 'confetti')
    this.cfg = this._defaultPreset
    this.live = []
    this._pool = [] // 死亡粒子回收复用,避免频繁 GC
    this._mode = null // 'burst' | 'ambient'
    this._rafId = null
    this._last = 0
    this._emitAcc = 0
    this._paused = false
    this._frame = this._frame.bind(this)
    this._raf = canvas.requestAnimationFrame ? canvas.requestAnimationFrame.bind(canvas)
      : typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(globalThis)
      : (cb) => setTimeout(() => cb(Date.now()), 16)
    this._unraf = canvas.cancelAnimationFrame ? canvas.cancelAnimationFrame.bind(canvas)
      : typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame.bind(globalThis)
      : clearTimeout
  }

  _resolve(p) {
    const cfg = typeof p === 'string' ? PRESETS[p] : p
    if (!cfg || !Array.isArray(cfg.shapes) || !Array.isArray(cfg.colors)) {
      throw new Error(`[particles] 未知预设: ${String(p)}(可用: ${Object.keys(PRESETS).join('/')},或传对象)`)
    }
    return cfg
  }

  /** 一次性爆发(礼花/点赞/金币)。o: { preset?, x?, y?, count? },x/y 为比例坐标 */
  burst(o = {}) {
    const p = o.preset ? this._resolve(o.preset) : this._defaultPreset
    const b = p.burst ?? {}
    const ox = ((o.x ?? b.x ?? 0.5)) * this.w
    const oy = ((o.y ?? b.y ?? 0.5)) * this.h
    const jitter = (b.jitter ?? 0.02) * this.w
    const n = Math.min(o.count ?? b.count ?? 30, this.maxParticles - this.live.length)
    for (let i = 0; i < n; i++) {
      const pt = this._newParticle(p)
      pt.x = ox + rand(-jitter, jitter)
      pt.y = oy + rand(-jitter, jitter)
      this.live.push(pt)
    }
    this._mode = this._mode ?? 'burst'
    this._ensureRunning()
  }

  /** 持续氛围(落雪/气泡),stop() 停止。o: { preset? } */
  ambient(o = {}) {
    const p = o.preset ? this._resolve(o.preset) : this._defaultPreset
    if (!p.ambient) throw new Error(`[particles] 预设没有 ambient 配置: ${p.desc}`)
    this.cfg = p
    this._mode = 'ambient'
    this._ensureRunning()
  }

  /** 页面 onHide 时调用,冻结画面防后台空转 */
  pause() {
    if (this._rafId != null) { this._unraf(this._rafId); this._rafId = null }
    this._paused = true
  }

  /** 页面 onShow 时调用,从冻结处继续 */
  resume() {
    if (!this._paused || !this._mode) return
    this._paused = false
    this._last = 0
    this._rafId = this._raf(this._frame)
  }

  /** 停止并清空画布(ambient 必须显式停;burst 放完自停) */
  stop() {
    this._paused = false
    if (this._rafId != null) { this._unraf(this._rafId); this._rafId = null }
    this._mode = null
    this._last = 0
    this._emitAcc = 0
    this.ctx.clearRect(0, 0, this.w, this.h)
    while (this.live.length) this._pool.push(this.live.pop())
  }

  /** 页面卸载时调用 */
  destroy() { this.stop(); this.canvas = null; this.ctx = null }

  // ---------- 内部 ----------
  _ensureRunning() {
    if (this._rafId == null && !this._paused) {
      this._last = 0
      this._rafId = this._raf(this._frame)
    }
  }

  _newParticle(p) {
    const pt = this._pool.pop() ?? {}
    const ang = rand(p.angle[0], p.angle[1]) * RAD
    const spd = rand(p.speed[0], p.speed[1])
    pt.vx = Math.cos(ang) * spd
    pt.vy = Math.sin(ang) * spd
    pt.gravity = p.gravity ?? 0
    pt.drag = p.drag ?? 0
    pt.size = rand(p.size[0], p.size[1])
    pt.rot = rand(0, TAU)
    pt.vrot = p.rotSpeed ? rand(p.rotSpeed[0], p.rotSpeed[1]) * RAD : 0
    pt.phase = rand(0, TAU)
    pt.flutterFreq = p.flutter ? rand(6, 10) : 0
    pt.spin = p.flip ? rand(4, 9) : 0
    pt.swayAmp = p.sway ? rand(p.sway[0], p.sway[1]) : 0
    pt.swayFreq = p.sway ? rand(1.2, 2.2) : 0
    pt.age = 0
    pt.maxLife = rand(p.life[0], p.life[1])
    pt.color = pick(p.colors)
    pt.shape = pick(p.shapes)
    pt.stroke = !!p.stroke
    pt.fadeIn = p.fadeIn ?? 0
    pt.fadeOut = p.fadeOut ?? 0
    return pt
  }

  _step(dt) {
    const live = this.live
    for (let i = live.length - 1; i >= 0; i--) {
      const pt = live[i]
      pt.age += dt
      if (pt.age >= pt.maxLife) { // 满寿命:换尾法回收,不搬运数组
        live[i] = live[live.length - 1]
        live.pop()
        this._pool.push(pt)
        continue
      }
      const dr = Math.exp(-pt.drag * dt)
      pt.vx *= dr
      pt.vy = pt.vy * dr + pt.gravity * dt
      pt.x += pt.vx * dt + (pt.swayAmp ? Math.sin(pt.age * pt.swayFreq + pt.phase) * pt.swayAmp * dt : 0)
      pt.y += pt.vy * dt
      pt.rot += pt.vrot * dt
    }
  }

  _draw() {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.w, this.h)
    for (const pt of this.live) {
      let a = 1
      if (pt.fadeIn > 0) a = Math.min(a, pt.age / pt.fadeIn)
      if (pt.fadeOut > 0) a = Math.min(a, (pt.maxLife - pt.age) / pt.fadeOut)
      ctx.globalAlpha = Math.max(0, Math.min(1, a))
      ctx.fillStyle = pt.color
      ctx.strokeStyle = pt.color
      this['_draw_' + pt.shape](ctx, pt)
    }
    ctx.globalAlpha = 1
  }

  _draw_rect(ctx, pt) { // 礼花纸屑:纵向长条 + flutter 模拟翻面
    ctx.save()
    ctx.translate(pt.x, pt.y)
    ctx.rotate(pt.rot)
    if (pt.flutterFreq) ctx.scale(1, 0.35 + 0.65 * Math.abs(Math.sin(pt.age * pt.flutterFreq + pt.phase)))
    ctx.fillRect(-pt.size / 2, -pt.size * 0.7, pt.size, pt.size * 1.4)
    ctx.restore()
  }

  _draw_circle(ctx, pt) {
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, pt.size / 2, 0, TAU)
    pt.stroke ? ctx.stroke() : ctx.fill()
  }

  _draw_heart(ctx, pt) {
    const s = pt.size
    ctx.save()
    ctx.translate(pt.x, pt.y)
    ctx.rotate(Math.sin(pt.age * 2 + pt.phase) * 0.15)
    ctx.beginPath()
    ctx.moveTo(0, s * 0.35)
    ctx.bezierCurveTo(-s * 0.55, -0.05 * s, -s * 0.28, -s * 0.45, 0, -s * 0.15)
    ctx.bezierCurveTo(s * 0.28, -s * 0.45, s * 0.55, -0.05 * s, 0, s * 0.35)
    ctx.fill()
    ctx.restore()
  }

  _draw_star(ctx, pt) {
    const r = pt.size / 2
    ctx.save()
    ctx.translate(pt.x, pt.y)
    ctx.rotate(pt.rot)
    ctx.beginPath()
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? r : r * 0.45
      const a = (Math.PI / 5) * i - Math.PI / 2
      const x = Math.cos(a) * rad
      const y = Math.sin(a) * rad
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  _draw_coin(ctx, pt) { // 金币:scaleX 翻转模拟旋转
    const r = pt.size / 2
    ctx.save()
    ctx.translate(pt.x, pt.y)
    ctx.scale(Math.max(0.08, Math.abs(Math.cos(pt.age * pt.spin + pt.phase))), 1)
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, TAU)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.beginPath()
    ctx.arc(0, 0, r * 0.62, 0, TAU)
    ctx.fill()
    ctx.restore()
  }

  _frame(t) {
    if (this._paused || !this.ctx) return
    if (!this._last) this._last = t
    const dt = Math.min((t - this._last) / 1000, 0.05)
    this._last = t
    if (this._mode === 'ambient' && this.cfg.ambient) {
      this._emitAcc += this.cfg.ambient.emitPerSec * dt
      while (this._emitAcc >= 1 && this.live.length < this.maxParticles) {
        this._emitAcc -= 1
        const r = this.cfg.ambient.region
        const pt = this._newParticle(this.cfg)
        pt.x = rand(r.x[0], r.x[1]) * this.w
        pt.y = rand(r.y[0], r.y[1]) * this.h
        this.live.push(pt)
      }
    }
    this._step(dt)
    this._draw()
    if (this._mode === 'burst' && this.live.length === 0) { // 礼花放完自停
      this.stop()
      return
    }
    this._rafId = this._raf(this._frame)
  }
}
