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
2. **背景色为抠图服务**:要透明底素材时,背景选**主体色板里没有的颜色**(主体含白色就别用白底,含粉色就别用品红底),并写明"纯色平涂,无渐变无阴影";然后走 `matting/` 抠图,不指望模型直出透明 PNG。
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
| `api.baseUrl / keyEnv / models / concurrency` | 接口地址 / 密钥变量名 / 模型优先级 / 并发数 |
| `imageConfig.aspect_ratio / image_size` | 出图比例与尺寸(gpt 系) |
| `compress.tinypngKeyEnv / maxKB` | 压缩 key 变量名 / 单张体积线 |
| `output.inPackage / cos / maxTotalMB` | 包内输出目录 / COS 子路径约定 / 资产目录红线 |

## 环境变量

| 变量 | 用途 |
|---|---|
| 生图 key(变量名由 `api.keyEnv` 指定) | 生图接口鉴权 |
| `TINYPNG_API_KEY`(`_2`..`_5` 备用自动轮换) | 压缩;401/429 自动切下一个;未配置时跳过压缩并在报告里说明 |
| LLM 关键词改写复用生图同一把 key | 无需额外配置 |

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
- 自动适配手机竖屏 2:3;自动放宽"禁文字"禁则(界面稿需要文案)、跳过默认背景(避免与界面自身背景及光影特效要求打架)
- 可加 `--ref` 参考现有界面截图保持产品感;动效/光效直接写进界面描述(如"入口卡片呼吸光效")

## 抠图(matting/)

```bash
# 任意装了 cv2 的 python:色键法(快、确定性,要求背景色全图唯一)
python matting/solid_bg_matting.py <图> <输出目录> --method chroma
# 需 torch+sam2+transformers 的环境(有权重):SAM2 语义分割,背景色无关,实测对白底/彩底、主体含背景近色都稳
python matting/solid_bg_matting.py <图> <输出目录> --method sam2 --sam2-ckpt <权重路径> [--vitmatte]
```

实测结论(卡通素材,2048px):**SAM2(中心+底部点提示 + box 约束)是首选**,白底/品红底均完整保住主体内的背景近色区域(白胸、白爪、眼高光);色键法依赖"背景色全图唯一",主体内部出现背景近色(如粉色嘴腔用品红底)会被误抠。ViTMatte 精修对 trimap 构造敏感,卡通素材上默认不用。
