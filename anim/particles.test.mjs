#!/usr/bin/env node
/**
 * anim/particles.test.mjs —— 粒子引擎逻辑冒烟测试(零依赖,stub canvas 不做真实渲染)
 * 覆盖:全部预设 burst 放完自停、ambient 持续发射且 stop() 清空、对象池回收、
 *       maxParticles 上限、pause/resume 冻结语义。node anim/particles.test.mjs
 */

import { ParticleSystem, PRESETS } from './particles.mjs'

let failed = 0
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`) } else { failed++; console.error(`  ✗ ${msg}`) }
}

// stub:ctx 用 Proxy 吞掉所有方法调用与属性写入;raf 由测试手动泵帧,虚拟时间推进
const ctxStub = new Proxy({}, {
  get: (t, p) => (p in t ? t[p] : () => undefined),
  set: (t, p, v) => { t[p] = v; return true },
})
let rafCb = null
function makeCanvas() {
  rafCb = null
  return {
    width: 0, height: 0,
    getContext: () => ctxStub,
    requestAnimationFrame(cb) { rafCb = cb; return 1 },
    cancelAnimationFrame() { rafCb = null },
  }
}
const DT = 16.7 // ms/帧
function pump(frames) {
  for (let i = 0; i < frames; i++) {
    const cb = rafCb
    rafCb = null
    if (!cb) return false // 引擎已自停
    pump.t += DT
    cb(pump.t)
  }
  return true // 仍在跑
}
pump.t = 0

console.log('═══ particles 冒烟测试 ═══\n')

// 1) 全部预设 burst:放完必须自停
for (const name of Object.keys(PRESETS).filter((k) => PRESETS[k].burst)) {
  const fx = new ParticleSystem(makeCanvas(), 300, 500, { preset: name })
  fx.burst()
  assert(fx.live.length > 0, `${name}: burst 出生 ${fx.live.length} 个粒子`)
  const stillRunning = pump(1200) // 最多模拟 20s
  assert(!stillRunning && fx.live.length === 0 && rafCb === null, `${name}: 放完自停且画布清空`)
  fx.destroy()
}

// 2) ambient:持续发射,stop() 清空
{
  const fx = new ParticleSystem(makeCanvas(), 300, 500, { preset: 'snow' })
  fx.ambient()
  pump(120) // ~2s
  assert(fx.live.length > 0, `snow: ambient 持续发射(${fx.live.length} 个在场)`)
  fx.stop()
  assert(fx.live.length === 0 && rafCb === null, 'snow: stop() 清空并停帧')
  fx.destroy()
}

// 3) burst 后接 ambient:模式切换后不再误自停
{
  const fx = new ParticleSystem(makeCanvas(), 300, 500)
  fx.burst({ preset: 'spark' })
  fx.ambient({ preset: 'bubble' })
  pump(600) // spark 粒子寿命 ~1s,若仍按 burst 判定早该停;ambient 应继续
  assert(fx.live.length > 0 && rafCb !== null, 'burst→ambient: 切换后持续运行')
  fx.destroy()
}

// 4) maxParticles 上限
{
  const fx = new ParticleSystem(makeCanvas(), 300, 500, { preset: 'confetti', maxParticles: 40 })
  fx.burst({ count: 200 })
  assert(fx.live.length <= 40, `confetti: 上限生效(${fx.live.length}/40)`)
  fx.destroy()
}

// 5) pause/resume:冻结时画面状态不变,resume 继续
{
  const fx = new ParticleSystem(makeCanvas(), 300, 500, { preset: 'confetti' })
  fx.burst()
  pump(30)
  const n = fx.live.length
  fx.pause()
  pump(60)
  assert(fx.live.length === n && rafCb === null, 'pause: 冻结(不再排帧、粒子不动)')
  fx.resume()
  assert(rafCb !== null, 'resume: 恢复排帧')
  fx.destroy()
}

// 6) 非法预设报错
{
  let threw = false
  try { new ParticleSystem(makeCanvas(), 100, 100, { preset: 'nope' }) } catch { threw = true }
  assert(threw, '未知预设抛错')
}

console.log(`\n结论:${failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`}`)
process.exit(failed ? 1 : 0)
