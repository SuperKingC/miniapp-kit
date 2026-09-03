# miniapp-kit — 小程序通用工具箱

跨项目复用的小程序开发工具集。每个子目录一个独立工具,互不依赖,按需取用。

## 目录

| 模块 | 用途 | 文档 |
|---|---|---|
| `art/` | 美术资产生图流水线:风格锚定生图 → TinyPNG 压缩 → 防缓存命名 → manifest 留痕 → 主包体积红线 | [art/README.md](art/README.md) |

## 使用方式

各项目引用本仓库内脚本,配置文件放在项目自己仓库里:

```bash
# 例:在某个小程序项目里生图
node D:/Mine/miniapp-kit/art/gen.mjs -c art.config.json -p prompts.txt
```

## 约定

- 密钥一律走环境变量,任何配置文件不落 key。
- 配置模板(`*.example.json`)入库,项目实际配置不入库。
- 各模块改动后跑一遍其端到端验证(见各模块 README),中文提交。
