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
下载  GET   {baseUrl}/videos/{jobId}/content
```

`frame_images` 传 data URL 可用(首帧图无需先传 COS);多模态参考用 `input_references`。探测脚本 `probe-i2v.mjs`,产物落 `art/generated-art/probe-i2v/`(已 gitignore)。

**模型盘点(存在性 oracle 免费扫描)**:只有 `kwaivgi/kling-v3.0-pro` 与 `kwaivgi/kling-v3.0-std` 两个,其余(sora/veo/hailuo/seedance/wan/runway/luma/pixverse/vidu)全部不存在。免费识别法:发畸形体,不存在的模型报 "Model xxx does not exist",存在的报参数校验错——注意区分信号在 error.message,错误码是笼统的 400。

**kling-v3.0-pro 实测数据**(首帧:gemini 1K 卡通猫,提示词:固定镜头微待机循环):

| 项 | 值 |
|---|---|
| 分辨率/帧率/时长 | 1948×1064("720p"档,非严格 1280×720)/ 24fps / 5.04s |
| 体积/成本 | 4.42MB(H.264)/ **$0.84/条** |
| 耗时 | ~4.8 分钟(pending 全程) |
| 角色一致性 | **优**:零变形零漂移,描边/配色/鱼帽全保住 |
| 运动服从 | **优**:眨眼+摇尾+嘴部微动,幅度小而柔,无镜头乱动、无幻觉元素 |
| 循环衔接 | **差**:首尾帧 PSNR 22.8dB(首帧睁眼/末帧闭眼)——提示词写"seamless loop"不被服从 |

**工作流约束(land gen.mjs 时执行)**:

1. 视频一律 COS 版本化上传,不进包(2MB 红线装不下);模拟器预览走 preview/serve.mjs。
2. 4.42MB/5s 直发偏大:ffmpeg CRF 23-26 转码可到 ~2MB 无损观感;去音轨。本机 ffmpeg 8.1 已就绪(doctor 检查)。
3. 循环靠筛选不靠提示词:一次出 2-3 候选,自动算首尾帧 PSNR(>30dB 可循环),不达标就交叉淡化(xfade)或标"只播一次"。
4. 成本纪律:5s/720p 起步迭代($0.84/条),定稿才升档;首帧用 art/ 定稿图,提示词只写运动。
5. 叠加型动画(角色浮在界面上)不可用视频(无 alpha):全屏场景视频直接铺,或固定容器内循环播放;真要透明叠加退回 L2/L3。
6. 质检四看:角色变形/漂移、循环首尾衔接、幻觉元素、运动幅度服从——抽帧目检(f_first/f_mid/f_last)进 manifest 留痕。

## 后续(roadmap)

- [ ] `anim/gen.mjs`:三步异步协议封装(创建→轮询→下载)+ 多候选 + ffmpeg 转码/循环检测 + COS 上传,模式对齐 art/gen.mjs(dry-run/manifest/成本报告)
- [ ] L3 lottie-miniprogram 播放器接入(按需,有 AE 产线再产资产)
