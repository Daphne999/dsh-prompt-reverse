/**
 * analyze.mjs —— 只用算法测「风格槽」。不看语义（谁在画面里、什么情绪），那部分交给调用方的视觉。
 *
 * 每个指标都写清"测的是什么、怎么算、为什么这么算"，因为后面要拿这些数字做标定。
 */

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * @param {{width:number,height:number,data:Buffer}} img  RGB24 像素
 * @param {{width:number,height:number}|null} original   原图像素尺寸（画幅按它算）
 */
export function analyzeImage(img, original) {
  const { width, height, data } = img;
  const total = width * height;

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumL = 0;
  let sumL2 = 0;
  let sumS = 0;
  let sumV = 0;
  let clippedHigh = 0;
  let clippedLow = 0;

  // 调色板：把 RGB 各通道量化到 6 级（6^3=216 个桶），统计后取前 5 名
  const buckets = new Map();

  const L = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    sumR += r;
    sumG += g;
    sumB += b;

    const y = luma(r, g, b);
    L[i] = y;
    sumL += y;
    sumL2 += y * y;

    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    sumV += mx;
    sumS += mx === 0 ? 0 : (mx - mn) / mx;

    if (mx >= 250) clippedHigh++;
    if (mx <= 6) clippedLow++;

    const key = ((r >> 5) << 9) | ((g >> 5) << 6) | (b >> 5);
    const cur = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    cur.n++;
    cur.r += r;
    cur.g += g;
    cur.b += b;
    buckets.set(key, cur);
  }

  const meanL = sumL / total;
  const variance = Math.max(0, sumL2 / total - meanL * meanL);
  const contrast = Math.sqrt(variance); // 亮度标准差，0-255 尺度

  // 锐度：拉普拉斯算子响应的方差（在灰度图上，跳过边缘一圈）
  let lapSum = 0;
  let lapSum2 = 0;
  let lapN = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - width] - L[i + width];
      lapSum += v;
      lapSum2 += v * v;
      lapN++;
    }
  }
  const lapMean = lapSum / Math.max(1, lapN);
  const sharpness = Math.max(0, lapSum2 / Math.max(1, lapN) - lapMean * lapMean);

  // 颗粒感：高频能量 = 拉普拉斯响应的平均绝对值，用亮度均值归一化（避免"亮图显得颗粒大"）
  let hf = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const i = y * width + x;
      hf += Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - width] - L[i + width]);
    }
  }
  const hfSamples = Math.ceil((height - 2) / 2) * Math.ceil((width - 2) / 2);
  const grain = hf / Math.max(1, hfSamples) / Math.max(1, meanL);

  const palette = [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((c) => ({
      hex: '#' + [c.r, c.g, c.b].map((v) => Math.round(v / c.n).toString(16).padStart(2, '0')).join(''),
      share: Number((c.n / total).toFixed(3)),
    }));

  const aspect = original ? Number((original.width / original.height).toFixed(3)) : Number((width / height).toFixed(3));

  return {
    // 亮度和曝光
    brightness: Number(meanL.toFixed(1)), // 0-255
    clippedHighRatio: Number((clippedHigh / total).toFixed(4)),
    clippedLowRatio: Number((clippedLow / total).toFixed(4)),
    // 反差与色彩
    contrast: Number(contrast.toFixed(1)),
    saturation: Number((sumS / total).toFixed(3)),
    temperature: Number(((sumR - sumB) / total).toFixed(1)), // >0 偏暖，<0 偏冷
    // 质感
    sharpness: Number(sharpness.toFixed(1)),
    grain: Number(grain.toFixed(4)),
    // 构图
    aspect,
    aspectLabel: aspectLabel(aspect),
    // 配色
    palette,
    // 说明"这些是测出来的，不是编的"
    measured: true,
  };
}

function aspectLabel(a) {
  const near = (v, t = 0.06) => Math.abs(a - v) <= t;
  if (near(1)) return '1:1 方形';
  if (near(4 / 3)) return '4:3 横向';
  if (near(3 / 4)) return '3:4 竖向';
  if (near(16 / 9)) return '16:9 宽屏';
  if (near(9 / 16)) return '9:16 竖屏';
  if (a > 1) return `横向 ${a.toFixed(2)}:1`;
  return `竖向 1:${(1 / a).toFixed(2)}`;
}
