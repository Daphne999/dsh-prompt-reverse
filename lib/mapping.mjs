/**
 * mapping.mjs —— 把测出来的数字翻译成 prompt / 负向 prompt。
 *
 * 核心规则（用户 2026-11-08 拍板）：
 *   **原图有什么 → 进正向；原图缺什么 → 进负向。**
 *   负向的作用是"排除与目标相反的特征"，所以只有当原图明确站在某一侧时才写；
 *   **落在中性区间就两边都不写**——不硬归类，跟"不编造"是同一条原则。
 *
 * 每个阈值都是初始估计值，待标定（见 cordis.patch.yml 注释）。
 */

const DEFAULTS = {
  sharpnessHigh: 900,
  sharpnessLow: 180,
  grainHigh: 0.055,
  grainLow: 0.018,
  contrastHigh: 62,
  contrastLow: 28,
  satHigh: 0.52,
  satLow: 0.18,
  brightnessHigh: 165,
  brightnessLow: 78,
  tempWarm: 14,
  tempCool: -14,
};

/**
 * @param {object} m     analyzeImage 的结果
 * @param {object} cfg   阈值配置（缺项用默认）
 * @param {string} target 'sd' | 'flux' | 'generic'（负向只对 SD 系有效）
 */
export function mapToPrompt(m, cfg = {}, target = 'sd') {
  const t = { ...DEFAULTS, ...(cfg || {}) };
  const positive = [];
  const negative = [];
  const notes = [];

  // 锐度
  if (m.sharpness >= t.sharpnessHigh) {
    positive.push('sharp focus', 'crisp details');
    negative.push('blurry', 'soft focus');
  } else if (m.sharpness <= t.sharpnessLow) {
    positive.push('soft focus', 'shallow depth of field');
    negative.push('over-sharpened', 'harsh edges');
  } else {
    notes.push(`锐度 ${m.sharpness} 在中性区间（${t.sharpnessLow}-${t.sharpnessHigh}），两边都不写`);
  }

  // 颗粒 / 质感
  if (m.grain >= t.grainHigh) {
    positive.push('film grain', 'grainy texture');
    negative.push('clean', 'digital smooth');
  } else if (m.grain <= t.grainLow) {
    positive.push('clean', 'smooth surfaces');
    negative.push('noise', 'dirty grain');
  } else {
    notes.push(`颗粒 ${m.grain} 中性，两边都不写`);
  }

  // 对比度
  if (m.contrast >= t.contrastHigh) {
    positive.push('high contrast', 'dramatic lighting');
    negative.push('flat', 'washed out');
  } else if (m.contrast <= t.contrastLow) {
    positive.push('low contrast', 'flat lighting');
    negative.push('harsh contrast', 'crushed blacks');
  } else {
    notes.push(`对比度 ${m.contrast} 中性`);
  }

  // 色温
  if (m.temperature >= t.tempWarm) {
    positive.push('warm color temperature');
    negative.push('cool blue cast');
  } else if (m.temperature <= t.tempCool) {
    positive.push('cool color temperature', 'teal tones');
    negative.push('warm orange cast');
  } else {
    notes.push(`色温 ${m.temperature} 中性`);
  }

  // 饱和度
  if (m.saturation >= t.satHigh) {
    positive.push('vivid, saturated colors');
    negative.push('desaturated', 'muted');
  } else if (m.saturation <= t.satLow) {
    positive.push('muted, desaturated palette');
    negative.push('over-saturated', 'neon');
  } else {
    notes.push(`饱和度 ${m.saturation} 中性`);
  }

  // 曝光
  if (m.brightness >= t.brightnessHigh) {
    positive.push('bright, airy, high key');
    negative.push('underexposed', 'crushed shadows');
  } else if (m.brightness <= t.brightnessLow) {
    positive.push('low key, dark, moody');
    negative.push('overexposed', 'blown highlights');
  } else {
    notes.push(`曝光 ${m.brightness} 中性`);
  }

  // 配色：只写进正向（这是"原图有什么"）
  if (m.palette?.length) {
    positive.push(`palette ${m.palette.slice(0, 3).map((p) => p.hex).join(' / ')}`);
  }

  // 画幅
  if (m.aspect) positive.push(`aspect ratio ${m.aspect}`);

  const dedupe = (arr) => [...new Set(arr)];
  const negSupported = target === 'sd' || target === 'generic' || target === 'sd3';

  return {
    target,
    positive: dedupe(positive),
    // 负向只对 SD 系有效；FLUX 一类基本忽略，仍然输出但标注
    negative: negSupported ? dedupe(negative) : [],
    negativeSkipped: negSupported ? null : `target=${target} 基本不使用 negative prompt，已省略（若要给 SD 系用，把 target 设为 sd）`,
    neutralNotes: notes,
    params: suggestParams(m, target),
    thresholdsUsed: t,
  };
}

/** 建议参数：只给有依据的（采样步数/CFG 这类没有原图依据，就不编） */
function suggestParams(m, target) {
  const params = { aspect_ratio: m.aspect };
  if (target === 'sd') params.cfg_scale_note = '配色对比偏高时可略降 CFG（7 → 6）';
  return params;
}

/** 拼成可直接粘贴的一句话 */
export function renderPrompt(map, semantic) {
  const sem = semantic || {};
  const parts = [];
  const s = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const subject = s(sem.subject);
  const action = s(sem.action);
  const mood = s(sem.mood);
  const camera = s(sem.camera);
  const style = s(sem.style);

  if (subject) parts.push(subject);
  if (action) parts.push(action);
  parts.push(...map.positive);
  if (camera) parts.push(camera);
  if (mood) parts.push(mood);
  if (style) parts.push(style);

  const prompt = parts.filter(Boolean).join(', ');
  const negative = map.negative.join(', ');
  return { prompt, negative, missingSemantic: missingSlots(sem) };
}

/** 语义槽缺哪几个（缺了就明说，不编） */
export function missingSlots(sem) {
  const need = ['subject', 'action', 'mood', 'camera', 'style'];
  const missing = need.filter((k) => !(typeof sem?.[k] === 'string' && sem[k].trim()));
  return missing;
}
