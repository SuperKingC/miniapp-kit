# art — 小程序美术资产生图流水线(miniapp-kit 模块)

一套可跨所有小程序项目复用的生图工作流:风格锚定 → 生图 → TinyPNG 压缩 → 防缓存命名 → manifest 留痕 → 主包体积红线。约束全部落在配置和脚本里,换项目只改一份 `art.config.json`。

## 设计原则

1. **风格一致性靠锚点**:每条提示词前自动拼接 `style`,全项目视觉统一;换风格只改配置一行。
2. **密钥永不进文件**:config 只存环境变量名(`keyEnv`),key 从环境读。
3. **防缓存**:同路径换图自动升 `_v2`/`_v3` 文件名。
4. **留痕**:每张图在 `manifest.json` 记录 prompt/模型/成本/尺寸,可追溯可重出。
5. **红线前置**:主包资产目录超限(默认 2MB)直接退出非 0,CI 可卡。

## 新项目接入(3 步)

```bash
cp art.config.example.json <项目根>/art.config.json   # 改 style / 模型 / 输出目录
# TinyPNG key 设为环境变量 TINYPNG_API_KEY(脚本只认环境变量)
node <miniapp-kit路径>/art/gen.mjs -c <项目根>/art.config.json -p prompts.txt
```

## 提示词文件格式 prompts.txt

```
# 每行一条;name|prompt 前缀命名(名称同时用于 resize 规则匹配);# 注释
icon-home|主页入口图标, 圆形, 猫爪元素
banner-share|分享封面, 横版, 两只猫握手
```

## 环境变量

| 变量 | 用途 |
|---|---|
| `CODEX_API_KEY`(或 config 里 `api.keyEnv` 指定) | 生图接口鉴权 |
| `TINYPNG_API_KEY` | TinyPNG 压缩;未设置时跳过压缩只降分辨率并警告 |

## 工作流里的人工关口(必做,不可自动化)

1. **生图后必须预览**:模型会自由发挥(实测提示词遵循度不稳定),用 Read/图片查看器逐张验收,不符就改提示词重跑。
2. **视觉改动须用户验收后才能合 main / 部署**(与各项目 AGENTS.md 对齐)。

## 与项目 AGENTS.md 的映射

- 单图 ≤180KB、PNG8/JPEG、禁 WebP → `compress.maxKB/format`
- 运行时图片先降分辨率再压质量 → `compress.resize` + TinyPNG
- 换同路径图片必须升文件名 → `bumpFilename`
- 测试内容不进主包、走 COS 热更 → `output.cos` 字段约定,上传环节后续接入

## 已验证可用的生图模型(中转站实测 2026-09)

- `google/gemini-3.1-flash-image-preview`(~$0.07/张,插画风)
- `google/gemini-3-pro-image-preview`(~$0.07/张,写实风,可能一次返回多张,脚本已去重)
- `openai/gpt-5.4-image-2`(~$0.22/张,扁平贴纸风)
- `google/gemini-2.5-flash-image`

统一走 `{baseUrl}/chat/completions`,`modalities: ["image","text"]`,图片在 `message.images[]` 为 base64 data URL。
