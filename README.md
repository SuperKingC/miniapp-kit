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

## 接入其他项目(消费方)

本仓库定位为通用套件:**任何项目接入都不改这里的代码**,项目差异全部走配置文件/env/CLI 参数。

### 安装与升级(按 tag 锁版本)

```bash
npm install github:SuperKingC/miniapp-kit#v0.1.0          # 首次接入,锁在 tag 上
npm install github:SuperKingC/miniapp-kit#semver:^0.1.0   # 或写进 package.json 跟 semver
npm update miniapp-kit                                    # 本仓库发新版后,一条命令同步
```

lockfile 会精确锁到 commit,可回滚。本仓库不发 registry,GitHub tag 即发版。

### CLI:npx 直跑

配置文件放接入方仓库自己的路径(用 `-c` 传入),产物一律输出到接入方自己的目录(`-o` 或配置指定):

```bash
npx miniapp-kit-doctor                                   # 新环境先体检
npx miniapp-kit-gen  -c art.config.json -p prompts.txt   # 生图流水线
npx miniapp-kit-anim -c anim.config.json                 # 图生视频流水线
npx miniapp-kit-cos                                      # COS 上传,默认 dry-run
npx miniapp-kit-theme -c typography.json                 # typography.json → typography.scss
npx miniapp-kit-preview                                  # 本机预览服务
```

### 运行时模块(anim/、theme/)

源文件随包分发,装完后在 `node_modules/miniapp-kit/` 下。有 SCSS 编译链的项目可直接从包路径 `@import`(`presets.scss`、生成的 `typography.scss`);纯原生 WXSS 项目吃不了 SCSS,交付形态(转换命令或预编译产物)待第一个接入项目确定后在此补记。`anim/particles.mjs` 是 ESM,原生小程序的消费方式同理待定。

### 接入铁律

1. 接入方仓库里 `node_modules/miniapp-kit/` 一律**只读**:发现要改的功能,回本仓库改、发新版,再在接入方 `npm update`。本地手改包内容会在下次安装时被冲掉,也堵死升级路。
2. 密钥、项目配置、生成产物永不进本仓库:接入方各自的 `.env`、`art.config.json`、`anim.config.json` 放在自己仓库并 gitignore,产物走 `-o` 或配置指向自己目录。
3. 本仓库发版约定:每批功能合入即打 `vX.Y.Z` tag 推 GitHub;0.x 阶段 minor 升级可能含 breaking,接入方升级后跑一遍 `miniapp-kit-doctor` 与受影响模块的端到端验证。

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
