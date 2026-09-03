# miniapp-kit — 小程序通用工具箱

跨项目复用的小程序开发工具集。每个子目录一个独立工具,互不依赖,按需取用。

## 目录

| 模块 | 用途 | 文档 |
|---|---|---|
| `art/` | 美术资产生图流水线:关键词优化 → 并发生图 → TinyPNG 压缩 → 防缓存命名 → manifest 留痕 → 主包体积红线 | [art/README.md](art/README.md) |
| `cos/` | COS 资产 SHA 版本化上传(immutable 缓存,默认 dry-run) | 脚本内注释 |

## 使用方式

各项目引用本仓库内脚本,配置文件放在项目自己仓库里:

```bash
# 例:在某个小程序项目里生图
node D:/Mine/miniapp-kit/art/gen.mjs -c art.config.json -p prompts.txt
# 发版资产按 SHA 版本化上传 COS(默认 dry-run,--yes 才上传)
node D:/Mine/miniapp-kit/cos/upload-cos.mjs --dir <待传目录> --prefix https://<bucket>.cos.<region>.myqcloud.com/<项目>/
```

## 约定

- 密钥一律走环境变量,任何配置文件不落 key。
- 配置模板(`*.example.json`)入库,项目实际配置不入库。
- 各模块改动后跑一遍其端到端验证(见各模块 README),中文提交。

## Roadmap

- [ ] `anim/` — 动画制作工作流
- [ ] `lint/` — 代码规范检查
- [ ] `size/` — 包体检测
