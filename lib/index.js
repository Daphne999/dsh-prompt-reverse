/**
 * index.js —— dsh-prompt-reverse 的单镜头分析器（MVP）。
 *
 * 分工：
 *   · **风格槽**由插件自己算（配色/对比/色温/锐度/颗粒/曝光/画幅），全部来自像素，不猜；
 *   · **语义槽**（主体/动作/情绪/镜头/风格）这插件**不内置任何模型**，由调用方把它自己
 *     看到的填进 semantic 参数；
 *   · 缺哪个语义槽就**明说缺哪个**，绝不编造；
 *   · 负向 prompt 从"原图缺什么"推导，中性区间两边都不写。
 *
 * 视频分镜表 = 先把视频切成帧，再对每一帧循环调用本工具（不在 MVP 里）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findFfmpegDir, decodeImage, probeSize } from './ffmpeg.mjs';
import { analyzeImage } from './analyze.mjs';
import { mapToPrompt, renderPrompt, missingSlots } from './mapping.mjs';

export const name = 'dsh-prompt-reverse';
export const inject = ['tools'];

const text = (s) => [{ type: 'text', text: s }];

/** 输出 schema 里声明了类型的属性不能是 null，所以空值一律整个省略 */
const out = (report, extra = {}) => {
  const clean = {};
  for (const [k, v] of Object.entries(extra)) {
    if (v !== null && v !== undefined) clean[k] = v;
  }
  clean.report = report;
  return clean;
};

export function apply(ctx, config = {}) {
  const tools = ctx.get('tools');
  if (!tools) {
    throw new Error('dsh-prompt-reverse 需要 tools 服务，但没拿到（检查 inject）');
  }

  const workDir = config.workDir || path.join(os.homedir(), '.dsh', 'prompt-reverse', 'work');

  tools.register({
    name: 'reverse_prompt_analyze',
    description:
      'Reverse-engineer a prompt from an image. The plugin measures the STYLE slots itself (palette, contrast, colour temperature, sharpness, grain, exposure, aspect) and asks YOU to fill the SEMANTIC slots (subject / action / mood / camera / style) from what you actually see - it contains no model and never invents those. Missing semantic slots are reported as missing. Emits a positive prompt, a negative prompt derived from measured deviations (SD-family only), and suggested parameters. | 反推图片提示词：风格槽由插件按像素测，语义槽由你自己的视觉填；缺什么就报缺什么，不编。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the image.' },
        semantic: {
          type: 'object',
          description: 'What you see (fill only what you are sure about; leave the rest out).',
          properties: {
            subject: { type: 'string' },
            action: { type: 'string' },
            mood: { type: 'string' },
            camera: { type: 'string' },
            style: { type: 'string' },
          },
          additionalProperties: false,
        },
        target: { type: 'string', description: "Target generator family: 'sd' (uses negative prompts), 'flux' (ignores them), 'generic'. Defaults to sd." },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          report: { type: 'string' },
          prompt: { type: 'string' },
          negative: { type: 'string' },
          missingSemantic: { type: 'array', items: { type: 'string' } },
          metrics: { type: 'object' },
        },
        required: ['ok', 'report'],
        additionalProperties: true,
      },
      render: (_a, v) => text(v?.report ?? ''),
    },
    async execute(args) {
      const file = String(args?.path || '').trim();
      if (!file || !fs.existsSync(file)) return out(`找不到图片：${file}`, { ok: false });

      const ffdir = findFfmpegDir(config.ffmpegDir);
      const img = decodeImage(ffdir, file, workDir, 192);
      if (!img.ok) return out(`解码失败：${img.error}（需要本机有 ffmpeg，可在配置里填 ffmpegDir）`, { ok: false });

      const original = probeSize(ffdir, file);
      const metrics = analyzeImage(img, original);
      const map = mapToPrompt(metrics, config.thresholds, String(args?.target || 'sd').toLowerCase());

      // 语义槽：只接受已知字段，且清掉空串
      const rawSem = args?.semantic && typeof args.semantic === 'object' ? args.semantic : {};
      const semantic = {};
      for (const k of ['subject', 'action', 'mood', 'camera', 'style']) {
        const v = rawSem[k];
        if (typeof v === 'string' && v.trim()) semantic[k] = v.trim();
      }
      const missing = missingSlots(semantic);
      const rendered = renderPrompt(map, semantic);

      const lines = [
        `**Prompt**`,
        rendered.prompt,
        '',
        map.negative ? ['**负向**', map.negative, ''].join('\n') : '',
        map.negativeSkipped ? `负向已省略：${map.negativeSkipped}` : '',
        missing.length ? `**语义槽未填**：${missing.join(' / ')}（插件不编，想补就把你看到的传进 semantic）` : '语义槽已齐全',
        map.neutralNotes.length ? `中性区间：${map.neutralNotes.join('；')}` : '',
        '',
        '**测出来的风格值**（不是猜的）',
        `配色 ${metrics.palette.map((p) => p.hex).join(' / ')}`,
        `亮度 ${metrics.brightness} · 对比 ${metrics.contrast} · 饱和 ${metrics.saturation} · 色温 ${metrics.temperature}`,
        `锐度 ${metrics.sharpness} · 颗粒 ${metrics.grain} · 画幅 ${metrics.aspectLabel}`,
      ].filter(Boolean);

      return out(lines.join('\n'), {
        ok: true,
        prompt: rendered.prompt,
        negative: rendered.negative,
        missingSemantic: missing,
        metrics,
      });
    },
  });
}
