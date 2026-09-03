# miniapp-kit — 小程序通用工具箱

跨项目复用的小程序开发工具集。每个子目录一个独立工具,互不依赖,按需取用;项目里只放配置,工具统一升级。

## 模块

| 模块 | 用途 | 文档 |
|---|---|---|
| `art/` | 美术资产生图流水线:关键词优化 → 并发生图 → TinyPNG 压缩 → 防缓存命名 → manifest 留痕 → 体积红线 | [art/README.md](art/README.md) |
| `matting/` | 纯色背景抠图(色键 / SAM2±ViTMatte),生图后出透明底素材 | 脚本 docstring |
| `anim/` | 动画四层:L1 CSS 动效预设 / L2 canvas 粒子引擎 / L3 Lottie(按需)/ L4 图生视频流水线 gen.mjs(创建→轮询→下载,pingpong 循环,可拆帧雪碧图) | [anim/README.md](anim/README.md) |
| `theme/` | 字体字号 token:typography.json 单一事实源 → 生成 typography.scss,默认系统字体栈,字号按文字类型配置 | [theme/README.md](theme/README.md) |
| `preview/` | 本机静态服务,模拟器本地预览待上传 COS 的资产,不经外网 | 脚本 docstring |
| `cos/` | COS 资产 SHA 版本化上传(immutable 缓存,默认 dry-run) | 脚本 docstring |

## 通用约定

1. 密钥一律走环境变量,任何文件不落 key 值。
2. 配置模板(`*.example.json`)入库,项目实际配置(含中转地址)不入库。
3. 模块改动必须跑一遍各自的端到端验证再提交,提交信息用中文。
4. 每个 CLI 默认行为安全:能 dry-run 的先 dry-run,能不覆盖的不覆盖。
5. **界面重设计**:用户说"重新设计某界面"时,先用 `art/gen.mjs --ui "界面内容描述"` 出 5 张不同排版方向的设计稿给用户挑,再动手写代码(细则见 art/README)。
6. **新环境先体检**:`node doctor.mjs` 列出缺失依赖(key/权重/python 环境等),是否下载安装征得用户同意,绝不自动装。

## Roadmap

- [ ] 动画产物接入 `cos/` 自动上传(当前视频/雪碧图手动传)
- [ ] `lint/` — 代码规范检查(含 WXSS 裸 font-size/font-family 检查)
- [ ] `size/` — 包体检测
