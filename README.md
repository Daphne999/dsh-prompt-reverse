# dsh-prompt-reverse

> 从一张图反推提示词——**风格槽用算的，语义槽用看的，缺什么就说缺什么。**

## 它和别人的区别（先说清楚，别装）

市场里已经有两个反推类插件：`taxue-dsh-artisan` 和 `dsh-prompt-workshop`。它们的做法是把图丢给多模态模型，让模型"看着写"一段 prompt。**那样写出来的东西无法验证**——你没法知道哪一句是图里真有的、哪一句是模型脑补的。

这个插件把 prompt 拆成两类槽位，分开处理：

| 槽位 | 谁来填 | 依据 |
|---|---|---|
| **风格槽**：配色 / 对比度 / 色温 / 饱和度 / 锐度 / 颗粒 / 曝光 / 画幅 | **插件自己算** | 像素。每个数字都能复算 |
| **语义槽**：主体 / 动作 / 情绪 / 镜头 / 风格 | **你自己的视觉** | 通过 `semantic` 参数传进来 |

**插件内部不接任何模型。** 它不会替你猜"这是一只猫"——那是你的视觉该干的事。

## 三个刻意的设计

**① 缺的语义槽就报缺，不编造。**

没传 `semantic` 时，输出里会明确写「语义槽未填：subject / action / mood…」。宁可给一个只能确定风格的 prompt，也不给一个看起来完整、其实一半是编的 prompt。

**② 负向 prompt 从"偏差"推导，不用模型感觉。**

规则是：**原图有什么 → 进正向；原图缺什么 → 进负向；落在中性区间 → 两边都不写。**

所以它不会对一张本来就模糊的图写 `blurry` 到负向里（那是"原图有什么"），而是把 `soft focus` 写进正向、把 `over-sharpened` 写进负向。

**③ 负向只对 SD 系有效，且会明确标出来。**

FLUX 一类模型基本忽略 negative prompt。传 `target: "flux"` 时，插件会把负向省略并说明原因，而不是假装它有用。

## 用它

```js
reverse_prompt_analyze({
  path: 'D:/pics/foo.jpg',
  semantic: {
    subject: 'a woman in a red coat standing on wet asphalt',
    action: 'looking away from camera',
    mood: 'melancholic, cold',
    camera: '85mm, shallow depth of field',
    style: 'cinematic still'
  },
  target: 'sd'   // 'sd' | 'flux' | 'generic'
})
```

输出：`prompt`、`negative`、`missingSemantic`、`metrics`（全部测出来的原始数值）。

## 阈值怎么标定（当前全是估计值）

`cordis.patch.yml` 里的每个阈值都注明了**「初始估计值，待标定」**。原因很实在：锐度的绝对值跟分辨率、画面内容强相关，凭感觉拍的数不能当作定论。

标定方法：攒一批真实图片，把 `metrics` 里的 `sharpness / grain / contrast / saturation / brightness / temperature` 分布打出来，按分位数（比如 25% / 75%）重新定阈值。在那之前，**这些阈值只保证"同一张图每次结果一致"，不保证"分档符合人类直觉"**。

## 它不做什么

- 不做视频分镜表（那是下一步：切帧 + 对每帧循环调用本工具）
- 不内置模型、不上传图片
- 不保证"按这个 prompt 生成就能复现原图"——**这需要闭环验证，目前没做**。README 里不会写"可复现"这三个字，除非真做过对比

## 依赖

本机需要 ffmpeg（用它把图片解成原始像素，避免引入 sharp/jimp 这类依赖）。查找顺序：配置 `ffmpegDir` → 环境变量 `FFMPEG_DIR` → 已知目录 → PATH。

**注意**：工作目录默认 `~/.dsh/prompt-reverse/work`，**不要指向系统临时目录**——实测 ffmpeg 写 `%TEMP%` 会 `Permission denied`。

## 已知限制

- 分析在 192×192 缩略图上做（足够算配色/对比/颗粒；细节锐度会偏低，所以锐度阈值偏保守）
- 色温用的是 R−B 均值差，不是真正的白平衡求解；对大面积单色画面会偏
- 语义槽完全依赖调用方诚实——插件无法验证你填的对不对
