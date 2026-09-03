# art — 小程序美术资产生图流水线

从提示词到可直接入库的资产:关键词优化 → 并发生图 → TinyPNG 压缩 → 防缓存落地 → manifest 留痕 → 体积红线。所有约束都在配置与脚本里,换项目只改一份 `art.config.json`。

## 快速上手

```bash
cp art.config.example.json <项目根>/art.config.json   # 改 style / 模型 / 输出目录
node <本仓库>/art/gen.mjs -c <项目根>/art.config.json -p prompts.txt --dry-run   # 先看最终提示词
node <本仓库>/art/gen.mjs -c <项目根>/art.config.json -p prompts.txt
```

prompts.txt 每行一条,`name|提示词` 命名(同名文件自动升 `_v2`),`#` 注释。

| 参数 | 说明 |
|---|---|
| `--out 目录` | 输出位置(默认 config `output.inPackage`) |
| `--count N` | 每条提示词出 N 张,并行 |
| `--ratio / --size` | 比例(1:1\|2:3\|3:2)与尺寸(2K),仅 gpt 系模型生效 |
| `--ref 图1,图2` | 参考图图生图,保角色/风格一致(≤2 张、单张 ≤2MB、jpg/png/webp) |
| `--dry-run` | 只打印最终提示词,不调接口不花钱 |

## 工作流规则(按序执行)

1. **关键词优化先行**:最终提示词 = `style` 锚点 + 默认背景(`prompt.background`)+ 单条提示词 + `boosters` 增强词,自动去重;末尾拼 `bans` 禁则。提示词里自己写了"背景"则不再追加默认背景——背景只在提示词一处出现,不打架。
2. **背景色为抠图服务**:要透明底素材时,背景选**主体色板里没有的颜色**(主体含白色就别用白底,含粉色就别用品红底),并写明"纯色平涂,无渐变无阴影";然后走 `matting/` 抠图,不指望模型直出透明 PNG。banner/弹窗底图等"背景属于设计"的资产优先**整图直用**不走抠图(见下方「提示词技巧与整图直用」)。
3. **模型优先 `openai/gpt-5.4-image-2`**,失败自动换 config 里下一个;gpt 系自动带 `image_config`(比例/尺寸)。2K 单张约 2 分钟,批量靠并发(默认 3)消化。
4. **压缩只用 TinyPNG,每张只压一次**:无本地预压、无二次压缩、不降色板不降质量;收益 <2% 保留原图;单张超 `maxKB` 只在运行末尾统一提醒,由人工决定缩尺寸/裁留白/走 COS,严禁压质量换体积。
5. **防缓存**:同路径换图文件名自动升 `_v2`/`_v3`;引用该图的代码要同步改到新文件名。
6. **改图后的重编译纪律**:替换图片 → 更新引用 → 微信开发者工具清缓存并重新编译;若正在编译,等它结束再触发,不要另开一个工具实例。
7. **模拟器预览走本地不经 COS**:`node <本仓库>/preview/serve.mjs --dir <资产目录> --path <子路径>`,构建时注入 `TARO_ASSET_BASE_URL`(正式)+ `TARO_ASSET_DEV_BASE_URL`(本机地址,仅模拟器生效);重建时这两个指向保持不变,正式包不受影响。
8. **发版资产用 `cos/` 按版本上传**:路径带版本号 + immutable 缓存,从结构上避开 CDN/客户端缓存。
9. **生成图一律视为源图**:未经压缩、登记 manifest、人工目检,不得直接进包;每张图涉及视觉呈现的改动,须人工验收后才算完成。
10. **每次生图看报告**:运行结束输出每张图的提示词/模型/花费/尺寸/耗时与超限提醒,manifest.json 累计留痕可追溯。

## 配置速查(art.config.json)

| 字段 | 作用 |
|---|---|
| `style` | 全局风格锚点(不含背景,背景归 `prompt.background`) |
| `prompt.background / boosters / bans / optimizeModel` | 默认背景 / 增强词 / 禁则 / 可选 LLM 关键词改写(填模型 ID 开启) |
| `typography.uiFont` | UI 设计稿字体约束(仅 `--ui` 拼入提示词);代码侧字体字号唯一事实源在 `theme/` 模块 |
| `api.baseUrl / keyEnv / models / concurrency` | 接口地址 / 密钥变量名 / 模型优先级 / 并发数 |
| `imageConfig.aspect_ratio / image_size` | 出图比例与尺寸(gpt 系) |
| `compress.tinypngKeyEnv / maxKB` | 压缩 key 变量名 / 单张体积线 |
| `output.inPackage / cos / maxTotalMB` | 包内输出目录 / COS 子路径约定 / 资产目录红线 |

## 环境变量

| 变量 | 用途 |
|---|---|
| 生图 key(变量名由 `api.keyEnv` 指定) | 生图接口鉴权 |
| `TINYPNG_API_KEY`(`_2`..`_5` 备用自动轮换) | 压缩;401/429 自动切下一个;未配置时跳过压缩并在报告里说明 |
| `BEN2_WEIGHTS` / `SAM2_CHECKPOINT` / `PYTHON_MATTING` | matting 模块的权重路径与 python 解释器 |
| LLM 关键词改写复用生图同一把 key | 无需额外配置 |

密钥与路径统一放仓库根 `.env`(已 gitignore,绝不提交),所有工具自动加载,进程环境变量优先;换环境时复制/重填 `.env` 后跑 `node doctor.mjs` 体检。

## 生图模型参考

| 模型 | 定位 |
|---|---|
| `openai/gpt-5.4-image-2` | **首选**:支持比例/尺寸参数与参考图,风格服从性好,成本约为 Gemini 系 3 倍 |
| `google/gemini-3.1-flash-image-preview` | fallback,性价比高,插画风 |
| `google/gemini-3-pro-image-preview` | fallback,写实风,可能一次返回多张(脚本已去重) |

统一走 `{baseUrl}/chat/completions`,`modalities: ["image","text"]`,图片在 `message.images[]` 为 base64 data URL;参考图以 `content: [{type:'text'},{type:'image_url'}]` 数组传入。成本以接口返回 `usage.cost` 为准,每次运行结束自动汇总。

## UI 设计稿工作流

用户要求"重新设计某界面"时,**先出图再写代码**:

```bash
node <本仓库>/art/gen.mjs -c <项目根>/art.config.json \
  --ui "界面内容: 顶部问候语+头像, 分类筛选chips, 测试卡片流(封面+标题+人数), 底部tabbar"
```

- 一次生成 **5 张不同排版方向**(卡片流/双列网格/沉浸式大图/分区列表/混合布局),全部展示给用户挑选
- 界面内容要描述具体:有哪些区块、数据、按钮、图标
- 风格由 `style` 锚点保证与项目一致;排版是主要探索变量
- 字体由 `typography.uiFont` 约束(默认"全界面统一一种圆润无衬线中文字体")保证 5 张稿方向一致;设计稿里的字只做排版参考,真实字体以 `theme/` token 为准,文案要短(≤5 个词才稳)
- 自动适配手机竖屏 2:3;自动放宽"禁文字"禁则(界面稿需要文案)、跳过默认背景(避免与界面自身背景及光影特效要求打架)
- 可加 `--ref` 参考现有界面截图保持产品感;动效/光效直接写进界面描述(如"入口卡片呼吸光效")

## 抠图(matting/)

```bash
# BEN2:全自动(无需提示),置信度引导 alpha 抠图,MIT。**首选**;权重 BEN2_WEIGHTS 环境变量指向 .safetensors/.pth
python matting/solid_bg_matting.py <图> <输出目录> --method ben2 --ben2-weights <BEN2_Base.safetensors路径>
# SAM2:点+box 提示的语义分割,适合 BEN2 失误时的兜底与交互修图;权重 SAM2_CHECKPOINT
python matting/solid_bg_matting.py <图> <输出目录> --method sam2 --sam2-ckpt <sam2.1_hiera_small.pt路径>
# 色键:零依赖最快,但要求背景色全图唯一(主体内出现背景近色必翻车),仅用于快速粗抠
python matting/solid_bg_matting.py <图> <输出目录> --method chroma
# 泛洪去背(实验,不替代默认链路):纯 numpy+PIL 零 cv2 零权重,边框连通+容差,封闭描边卡通素材适用
python matting/floodfill_matting.py <图> <输出目录> [--tol 42]
```

三种方法实测(卡通素材,2048px,2026-09):**BEN2 全自动且简单图(白底/品红底)与复杂图(长毛+镂空篮+气球细线+多主体)均完美**——镂空纹理、细线、毛边全保留;SAM2 在多主体构图下自动提示会失效(需逐对象交互提点),仅适合单主体兜底;色键法会把镂空洞里的背景留成不透明白块。**结论:默认 BEN2,SAM2 兜底,色键粗筛。** 换新环境先跑 `node doctor.mjs` 查抠图依赖是否齐全,缺什么经确认再装。

泛洪实验(2026-09,`floodfill_matting.py`):白底图(内部白胸/白爪/白鱼全保住)与 gpt 直出的低对比假棋盘格图均干净移除;渐变/花纹背景正确触发低占比警告并拒绝瞎抠。定位:无 cv2/torch 环境的兜底与 BEN2 结果的快速对照,默认链路不变。

## 透明底直出探测(probe-transparent.mjs,2026-09)

"提示词能不能直接出透明 PNG 省掉抠图"——**不能,四条路线实测全堵**:

| 路线 | 结果 |
|---|---|
| gpt-5.4-image-2 + `image_config.background=transparent` | 中转端点 400,只收 auto/opaque,参数路线不通 |
| gpt-5.4-image-2 纯提示词 | 返回 PNG 但无 alpha(colorType=2 RGB),且把"透明"画成像素级假棋盘格,提示词明写"严禁棋盘格"也拦不住 |
| gemini-3.1-flash 纯提示词 | 返回 JPEG,天生无 alpha |
| gemini-3-pro 纯提示词 | 同上 |

结论:透明素材只走「纯色平涂底 + matting」或「白底图直接放白色容器」;`prompt.background` 规则不变。副产品:`image_size 1K` 可用($0.227/张,约 2K $0.47 的一半),探测类实验建议 1K。重跑:`node art/probe-transparent.mjs -c <项目根>/art.config.json`,结果落 `<项目根>/art/generated-art/probe-transparent/`(含 probe-manifest.json,不走 TinyPNG 保持原始返回)。

## 提示词技巧与整图直用(2026-09)

要点吸收自 gpt-image-2 提示词实践集(apiyi 2026-04 汇总),按本流水线消化:

- **五段式结构,主体前置**:场景 → 主体 → 细节 → 光影镜头 → 约束;主体放在前 30% 的词里权重最高。我们的提示词是 style 锚点打头(保风格一致),单主体资产图可实验"主体前置"顺序,做成 probe 用数据再定。
- **画面要带文字时**:目标文字用引号包住并加 verbatim 约束,如 `标题文字 "SUMMER" verbatim, 不多字不换字`;单图 ≤5 个词准确率才稳(实测 70%→95%+)。长文案一律代码叠字,不指望生图。
- **构图写镜头词**:图标/道具加 "3/4 front view"、"straight-on, centered";等距类加 "45° top-down isometric";不写镜头词默认 35mm 自然光。
- **正向约束优于负面禁则**:参考写法是 "plain background, no additional elements" 这类正向描述,而非罗列负面词。我们的 `bans` 是负面写法,gpt 系对自然语言禁则服从一般,可做对照实验,有效就保留。
- **低分辨率迭代 + 多候选探索**:探索期用 `--size 1K`($0.227/张)+ `--count 4`(单价约低 18%),定稿才 2K 单张。
- **角色一致性**:`--ref` 参考图优先;写文字版时用五元组(发型+标志性特征+服装+体型+配色)逐字固定,跨提示词不改动。
- **参考图修图写法**:改 X 保 Y —— `Change: 表情为大笑. Preserve: 服装、姿势、配色、背景 exactly the same`。
- **扔掉冗词**:"8K / masterpiece / ultra detailed" 这类词浪费语义空间,不要加进 boosters。
- **seed 复现**:同 seed + 同提示词可复现构图;中转端点是否透传 seed 待 probe 验证。

### 整图直用(免抠图)策略

"可直接用、不扣底色"分两层,结论不同:

1. **真透明底:不可行**(probe-transparent 四路实测已判死,提示词层无解)——贴纸/浮层角色仍走 matting。
2. **整图直接用:可行,优先用**。banner、弹窗底图、活动头图、卡片配图这类"背景属于设计"的资产,让背景直接成为最终背景,零抠图。提示词约束模板:

   ```
   背景为 #FFF6EC 全图均匀平涂, 无渐变无暗角无边缘阴影, 主体完整居中, 四周留出安全区不被裁切, 整张图直接用作卡片背景
   ```

   - 圆角/描边交给 CSS `border-radius`,不指望模型画圆角;
   - 白底图直接放白色容器仍是零成本兜底;
   - "背景色选主体色板外的颜色"只在**要抠图**时需要,整图直用不受限;
   - 直用不豁免验收:仍走「生成图=源图」流程(压缩/manifest/人工目检)。
