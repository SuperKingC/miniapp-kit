# art — 小程序美术资产生图流水线(miniapp-kit 模块)

跨小程序项目复用的生图工作流:关键词优化 → 并发生图 → TinyPNG 压缩 → 防缓存命名 → manifest 留痕 → 主包体积红线。约束全部落在配置和脚本里,换项目只改一份 `art.config.json`。

## 核心规则(带血泪教训,不许绕过)

1. **关键词优化先行**:每条提示词自动拼接 `style` 风格锚点 + `prompt.boosters` 增强词 + `bans` 禁则(去重);`prompt.optimizeModel` 填文本模型 ID 可让 LLM 先改写关键词(默认关)。
2. **模型优先 `openai/gpt-5.4-image-2`**,失败自动 fallback 到 Gemini 系;gpt 系自动携带 `image_config: { aspect_ratio, image_size }` 控比例与尺寸。
3. **并发生图**:多条提示词并发跑(默认 3,`api.concurrency` 调),省等待时间。
4. **压缩只走 TinyPNG,禁止本地预压**:单次压缩保色彩保清晰度;收益 <2% 保留原图;超 `maxKB` 只告警,**不做二次压缩/降色板/降质量**——禁止以色彩换空间(压色会导致色阶断裂,用户可感知)。
5. **生成图一律视为 source-only**:未经压缩、登记 manifest、人工目检,不得直接进包。
6. **透明底素材不指望模型直出**:提示词要求纯白背景,后续用去底管线(sam2/ViTMatte 类)抠图。
7. **防缓存**:同路径换图自动升 `_v2`/`_v3`;发版级资产走 `cos/` 模块 SHA 版本化路径(immutable 缓存)。
8. **两道人工关口**:生图后必须逐张预览(模型会自由发挥);视觉改动须用户验收后才能合 main。

## 用法

```bash
cp art/art.config.example.json <项目根>/art.config.json   # 改 style / 模型 / 输出目录
# TinyPNG key 设为环境变量 TINYPNG_API_KEY(备用 key: TINYPNG_API_KEY_2..5 自动轮换)
node <miniapp-kit路径>/art/gen.mjs -c <项目根>/art.config.json -p prompts.txt
```

| 参数 | 说明 |
|---|---|
| `-c` / `-p` | 配置 / 提示词文件 |
| `--out` | 输出目录(默认取 config `output.inPackage`) |
| `--count N` | 每条提示词出 N 张(并行) |
| `--ratio` / `--size` | 覆盖比例(1:1\|2:3\|3:2)与尺寸(2K),仅 gpt 系生效 |
| `--ref a.png,b.png` | 参考图图生图(≤2 张、单张 ≤2MB、jpg/png/webp) |
| `--dry-run` | 只打印优化后的最终提示词,不调接口不花钱 |

prompts.txt:每行一条,`name|提示词` 命名(同名文件存在自动升 `_v2`),`#` 注释。

## 环境变量

| 变量 | 用途 |
|---|---|
| `CODEX_API_KEY`(或 config `api.keyEnv`) | 生图接口鉴权 |
| `TINYPNG_API_KEY`(+`_2`..`_5` 备用) | 压缩;401/429 自动轮换;未配置时跳过压缩并警告 |

## 已验证生图模型(中转站实测 2026-09)

| 模型 | 单张成本 | 风格 | 备注 |
|---|---|---|---|
| `openai/gpt-5.4-image-2` | ~$0.22(2K 约 $0.47) | 扁平贴纸/插画 | **首选**;支持 image_config 与参考图;2K 单张约 2.3 分钟 |
| `google/gemini-3.1-flash-image-preview` | ~$0.07 | 暖插画 | fallback |
| `google/gemini-3-pro-image-preview` | ~$0.07 | 写实 | 一次可能返回多张,脚本已去重 |
| `google/gemini-2.5-flash-image` | ~$0.07 | 写实渲染 | 旧备选 |

统一走 `{baseUrl}/chat/completions`,`modalities: ["image","text"]`,图片在 `message.images[]` 为 base64 data URL;参考图以 `content: [{type:'text'},{type:'image_url'}]` 数组传入。

## 与项目 AGENTS.md 的映射

- 单图 ≤180KB、PNG8/JPEG、禁 WebP → `compress.maxKB` + TinyPNG(格式不变)
- 换同路径图片必须升文件名 → `bumpFilename`
- 主包 <2MB → `output.maxTotalMB` 红线,超限 exit 2
- 测试内容不进主包、走 COS 热更 → 生成产物配合 `cos/upload-cos.mjs` 按 SHA 版本化上传
