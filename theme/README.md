# theme — 字体字号 token

全项目字体、字号的**唯一事实源**:一份 `typography.json` → 生成 `typography.scss`(SCSS 变量 + CSS 自定义属性 + `.t-*` 工具类三合一)。目标项目复制配置模板,工具统一升级。

## 约束

1. **默认全站一个字体**:中文默认系统字体栈(零加载成本、零失败风险)。中文整包字体动辄几 MB,不适合小程序——要品牌字体必须子集化后传 COS,经 `wx.loadFontFace` 加载,失败回退系统栈;数字/价格类用只含数字的专用字体是体积可控的折中。
2. **字号按文字类型配置**:每个类型是 字号+行高+字重 成组的一枚语义 token(display/title/body/caption/button…),组件样式里**禁止写裸 `font-size` / `font-family`**,只允许引用生成物。数字类型带 `tabular-nums`(等宽数字,计数跳动不抖)。
3. **生图侧联动**:`art.config.json` 的 `typography.uiFont` 控制设计稿字体方向(见 art/README);设计稿里的字只做排版参考,真实字体以本模块 token 为准,长文案必须代码叠字,不指望生图烧字。

## 用法

```bash
cp theme/typography.example.json <项目根>/typography.json        # 按项目改字号表
node <本仓库>/theme/build-typography.mjs -c <项目根>/typography.json \
     -o <项目>/src/styles/typography.scss
```

生成物三种引用方式(可混用):`font-size: $t-title-size;`、`font-size: var(--t-title-size);`、`<Text className="t-title">`。改 `typography.json` 后重新生成,生成物不入库(入项目的构建产物随项目约定)。

新增文字类型:直接在 `types` 里加键,变量/自定义属性/工具类三处自动同步。
