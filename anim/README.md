# anim — 动画制作工作流

小程序动画分四层,**越靠上越优先**——代码动效零成本零延迟,覆盖绝大多数场景;AI 视频贵且慢,只给"品牌时刻"。核心原则:**图管长相,词管动作**(首帧用 art/ 定稿图保角色一致,提示词只描述运动不复述外观)。

## 四层选型

| 层 | 载体 | 定位 | 状态 |
|---|---|---|---|
| L1 | CSS 动效预设 `presets.scss` | 按钮反馈、入场、骨架屏、呼吸光效等 90% UI 动效 | **已入库** |
| L2 | Canvas 粒子引擎 `particles.mjs` | 礼花/飘心/金币雨/落雪/气泡等高频氛围特效 | **已入库** |
| L3 | Lottie(lottie-miniprogram) | 复杂开屏/奖励动画,需要 AE 产线产 JSON | 按需,未接入 |
| L4 | AI 图生视频 | 开屏、活动主视觉、角色待机动画(走 COS 不进包) | 协议已实测,`gen.mjs` 待建 |

选型速查:按钮/卡片反馈 → L1;点赞/礼花/氛围 → L2;复杂插画动画(奖励弹窗、开屏)→ L3 或 L1+L2 拼装;角色待机/主视觉 → L4;全屏活动背景 → L4 循环视频或 L2 粒子(更轻)。

## L1 CSS 动效预设(presets.scss)

全局样式 `@import '<本仓库>/anim/presets.scss';`,元素加类名即用。只动 transform/opacity(合成器友好 60fps),严禁动布局属性。预设:`anim-breathe` 呼吸、`anim-float` 浮动、`anim-skeleton` 骨架屏、`anim-spin` 旋转、`anim-pop` 弹出、`anim-fade-up` 淡入上移、`anim-slide-in` 右滑入、`anim-shake` 摇晃、`anim-press` 按压(配 hover-class)、`anim-shine` 扫光。

## L2 Canvas 粒子引擎(particles.mjs)

零依赖单文件,小程序/Taro/H5 通用,拷走即用。预设:`confetti` 礼花、`heart` 点赞飘心、`coin` 金币雨、`spark` 星光、`snow` 落雪、`bubble` 气泡;`burst()` 一次性(放完自停)、`ambient()` 持续(`stop()` 停);对象池回收,maxParticles 上限,自定义预设传对象即可。

```js
wx.createSelectorQuery().select('#fx').fields({ node: true, size: true }).exec(([res]) => {
  const fx = new ParticleSystem(res.node, res.width, res.height)
  fx.burst({ preset: 'confetti' })
  fx.ambient({ preset: 'snow' })
})
```

生命周期纪律:页面 onHide → `fx.pause()`(防后台空转耗电),onShow → `fx.resume()`,卸载 → `fx.destroy()`。回归:`node anim/particles.test.mjs`(stub canvas 冒烟,零依赖)。

## L4 图生视频(协议实测 2026-09)

**接口:独立异步三步,不在 chat/completions 上**(`/models` 列表里也没有视频模型,列表本身不全——生图模型同样不在其中):

```
创建  POST  {baseUrl}/videos            model/prompt/frame_images[first_frame]/resolution
轮询  GET   {baseUrl}/videos/{jobId}    completed / failed / 其它=处理中(4s 一次)
下载  GET   {baseUrl}/videos/{jobId}/content   (completed 响应带 unsigned_urls 直链与 usage.cost)
```

`frame_images` 传 data URL 可用(首帧图无需先传 COS);多模态参考用 `input_references`。探测脚本 `probe-i2v.mjs`,产物落 `art/generated-art/probe-i2v/`(已 gitignore)。

**模型盘点(存在性 oracle 免费扫描)**:只有 `kwaivgi/kling-v3.0-pro` 与 `kwaivgi/kling-v3.0-std` 两个,其余(sora/veo/hailuo/seedance/wan/runway/luma/pixverse/vidu)全部不存在。免费识别法:发畸形体,不存在的模型报 "Model xxx does not exist",存在的报参数校验错——注意区分信号在 error.message,错误码是笼统的 400。

### 生产工具 anim/gen.mjs

```bash
cp anim/anim.config.example.json anim.config.json        # 按项目改模型/候选/拆帧参数
node <本仓库>/anim/gen.mjs -c anim.config.json -p anims.txt --dry-run   # 先看提示词不花钱
node <本仓库>/anim/gen.mjs -c anim.config.json -p anims.txt \
     [--candidates 2] [--loop pingpong|raw|off] [--frames] [--alpha]
```

anims.txt 每行 `name|首帧图路径|运动提示词`。流程:创建→轮询→下载(多候选按首尾帧 PSNR 挑最优,模型 fallback)→ 循环处理 → x264 转码瘦身(去音轨+faststart,实测 4.42MB→1.5MB)→ 可选拆帧/雪碧图 → manifest+成本报告。产物:成品 mp4(防缓存升 _v2)+ 母带(默认保留,`--no-keep-master` 清)+ `--frames` 时雪碧图/透明雪碧图/播放配置 json。

**循环处理实测(重要)**:提示词写 seamless loop **不被服从**(两次实测首尾帧 PSNR 22.8/17.9dB,末帧总是停在闭眼)。交叉淡化 xfade 实测**无效**(21.5dB,已弃);**pingpong 正反循环完胜**(40.3/40.7dB,待机类动作倒放自然,代价时长翻倍)。默认策略 `loop=pingpong`:母带 PSNR≥30dB 直接用,<30dB 自动转正反循环;产物逐条标「可循环/已转正反循环/建议只播一次」。

**e2e 实测(2026-09,kling-v3.0-pro)**:$0.84/条,~3-5 分钟;母带 4.59MB→成品 1.50MB(10s 正反循环,40.7dB);拆帧 121 帧 @12fps/360px → 11×11 雪碧图,chroma 逐帧抠像干净(描边/细毛全保留)。

### 视频 vs 拆帧(帧动画)怎么选

**不是都用视频。视频当母带,拆帧是派生**,按播放场景选:

| 场景 | 用 | 原因 |
|---|---|---|
| 全屏/大区域/背景氛围、卡片内循环 | 视频(video 组件 + COS) | H.264 帧间压缩,运动满帧体积小;10s 循环仅 1.5MB |
| 角色动效浮在 UI 上、透明叠加、多实例 | 拆帧雪碧图(--frames --alpha) | video 是原生组件层级最高且无 alpha;雪碧图与普通组件同层、可透明、可多开 |
| 按钮/卡片/加载等 UI 反馈 | L1 CSS / L2 粒子 | 根本不需要 AI,零成本零延迟 |

拆帧的代价是体积随帧数线性涨(实测 121 帧/360px/12fps 雪碧图约 5MB):控制住 短时长(1-3s)+ 低帧率(8-12fps)+ 小尺寸(≤300px),超了就走 COS;透明雪碧图暂未接 TinyPNG,大图手工压。播放:按 `_sprite.json`(cols/rows/fps/count)用 canvas drawImage 翻页或 CSS steps 偏移背景。

**工作流约束**:

1. 视频与雪碧图大文件一律 COS 版本化上传,不进包(2MB 红线);模拟器预览走 preview/serve.mjs。
2. 成本纪律:5s/720p 起步($0.84/条),循环需求用 `--candidates 2-3` 让 PSNR 挑最优;首帧用 art/ 定稿图,提示词只写运动。
3. 叠加型动画(角色浮在界面上)不可用视频(无 alpha):走拆帧透明雪碧图,或 L2/L3。
4. 质检四看:角色变形/漂移、循环首尾衔接(PSNR 已自动打分)、幻觉元素、运动幅度服从——人工目检抽查,manifest 留痕。

## 后续(roadmap)

- [ ] 雪碧图/视频产物接入 cos/ 自动上传(当前手动)
- [ ] L3 lottie-miniprogram 播放器接入(按需,有 AE 产线再产资产)
