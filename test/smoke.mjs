/**
 * smoke.mjs —— 干跑：用假 tools 服务跑 apply()，再对真实图片跑一次分析。
 *
 * 为什么要有它：这个环境里插件"注册成功但工具不出现"踩过太多次，
 * 所以先用假服务验证注册调用本身，再验证算法层。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyzeImage } from '../lib/analyze.mjs';
import { mapToPrompt, renderPrompt, missingSlots } from '../lib/mapping.mjs';
import { findFfmpegDir, decodeImage, probeSize } from '../lib/ffmpeg.mjs';

let bad = 0;
const ok = (c, l, e = '') => {
  if (!c) bad++;
  console.log(`${c ? 'PASS' : 'FAIL'} ${l}${e ? ' — ' + e : ''}`);
};

// ---------- 1) 算法层：造一张合成图（上半亮、下半暗、整体偏红）
{
  const S = 64;
  const data = Buffer.alloc(S * S * 3);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 3;
      const bright = y < S / 2;
      data[i] = bright ? 230 : 45;
      data[i + 1] = bright ? 120 : 20;
      data[i + 2] = bright ? 90 : 15;
    }
  }
  const m = analyzeImage({ width: S, height: S, data }, { width: 1200, height: 900 });
  ok(m.measured === true, '分析结果标记为 measured');
  ok(m.temperature > 0, '偏红 → 色温为正（暖）', String(m.temperature));
  ok(m.contrast > 40, '上下明暗差 → 对比度高', String(m.contrast));
  ok(Math.abs(m.aspect - 1.333) < 0.01, '画幅按原图算（1200×900 → 1.333）', String(m.aspect));
  ok(m.aspectLabel.includes('4:3'), '画幅标签正确', m.aspectLabel);
  ok(m.palette.length > 0 && m.palette[0].hex.startsWith('#'), '配色表非空', m.palette[0]?.hex);

  const map = mapToPrompt(m, {}, 'sd');
  ok(map.positive.length > 0, '正向 prompt 非空');
  ok(map.negative.length > 0, '负向 prompt 非空（sd 目标）');
  ok(map.thresholdsUsed && map.thresholdsUsed.sharpnessHigh === 900, '阈值来自默认配置');

  const flux = mapToPrompt(m, {}, 'flux');
  ok(flux.negative.length === 0 && !!flux.negativeSkipped, 'flux 目标下负向被省略并说明原因');

  const r = renderPrompt(map, { subject: 'a cat', style: 'photorealistic' });
  ok(r.prompt.startsWith('a cat'), '语义槽按顺序拼进正向');
  ok(r.missingSemantic.includes('mood') && r.missingSemantic.includes('camera'), '缺失的语义槽被列出', r.missingSemantic.join(','));
  ok(missingSlots({}).length === 5, '空语义 → 五个槽都算缺');
}

// ---------- 2) 注册层：假 tools 服务干跑 apply()
{
  const registered = [];
  const fakeCtx = {
    get: (k) => (k === 'tools' ? { register: (t) => registered.push(t) } : undefined),
  };
  const { apply } = await import('../lib/index.js');
  let threw = null;
  try {
    apply(fakeCtx, {});
  } catch (e) {
    threw = e.message;
  }
  ok(threw === null, 'apply 不抛错', threw || '');
  ok(registered.length === 1, '注册了 1 个工具', registered.map((t) => t.name).join(','));
  ok(registered[0]?.name === 'reverse_prompt_analyze', '工具名正确');
  ok(typeof registered[0]?.execute === 'function', '工具可执行');
}

// ---------- 3) 真图：用仓库里的一张图跑完整链路（有 ffmpeg 才行）
{
  const ffdir = findFfmpegDir('');
  if (!ffdir) {
    console.log('SKIP 没找到 ffmpeg，跳过真实图片解码');
  } else {
    const candidates = [
      'D:\\ds工作区\\推广\\covers_batch\\claimcheck.png',
      'D:\\ds工作区\\推广\\cover_dsh-media-kit_final.png',
    ];
    const img = candidates.find((p) => fs.existsSync(p));
    if (!img) {
      console.log('SKIP 没找到测试图片');
    } else {
      // 注意：不要用 os.tmpdir()——实测 ffmpeg 写 %TEMP% 会 Permission denied
      const work = 'D:/ds工作区/.prompt-reverse-smoke';
      const dec = decodeImage(ffdir, img, work, 128);
      ok(dec.ok, '真实图片解码成功', dec.error || '');
      if (dec.ok) {
        const m = analyzeImage(dec, probeSize(ffdir, img));
        ok(m.brightness > 0 && m.brightness < 255, '亮度在合理范围', String(m.brightness));
        ok(m.palette.length >= 1, '真实图片有配色', m.palette[0]?.hex);
        console.log(`  实测：亮度 ${m.brightness} 对比 ${m.contrast} 饱和 ${m.saturation} 色温 ${m.temperature} 锐度 ${m.sharpness} 颗粒 ${m.grain}`);
        console.log(`  画幅 ${m.aspectLabel} · 配色 ${m.palette.map((p) => p.hex).join(' ')}`);
      }
    }
  }
}

console.log(bad === 0 ? '\nsmoke 全过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
