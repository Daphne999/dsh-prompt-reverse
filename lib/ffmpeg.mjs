/**
 * ffmpeg.mjs —— 找 ffmpeg、把图片解成小尺寸原始像素。
 *
 * 为什么用 ffmpeg 而不是图像库：这个插件不想引 sharp/jimp 这类原生或巨型依赖，
 * 而 ffmpeg 在本机通常已经有了（media-kit 也是这样）。
 * 注意：这个环境里子进程的 stdout 拿不到（stdio 必须 ignore），
 * 所以让 ffmpeg **把 rawvideo 写进文件**，我们再去读文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const EXE = process.platform === 'win32' ? '.exe' : '';

const KNOWN = [
  'D:\\ds工作区\\tools\\ffmpeg-master-latest-win64-gpl\\bin',
  'C:\\ffmpeg\\bin',
];

/** 找 ffmpeg 所在目录：配置 → 环境变量 → 已知目录 → PATH（返回 '' 表示靠 PATH） */
export function findFfmpegDir(configured) {
  if (configured && fs.existsSync(path.join(configured, 'ffmpeg' + EXE))) return configured;
  const env = process.env.FFMPEG_DIR;
  if (env && fs.existsSync(path.join(env, 'ffmpeg' + EXE))) return env;
  for (const dir of KNOWN) {
    if (fs.existsSync(path.join(dir, 'ffmpeg' + EXE))) return dir;
  }
  return '';
}

export function runFfmpeg(dir, args, timeoutMs = 120000) {
  const exe = dir ? path.join(dir, 'ffmpeg' + EXE) : 'ffmpeg';
  const r = spawnSync(exe, args, { stdio: 'ignore', windowsHide: true, timeout: timeoutMs });
  return { ok: r.status === 0, status: r.status };
}

/**
 * 把任意图片解码成 size×size 的 RGB24 原始像素。
 * 返回 { ok, width, height, data(Buffer), error }
 */
export function decodeImage(dir, file, workDir, size = 192) {
  fs.mkdirSync(workDir, { recursive: true });
  const out = path.join(workDir, `raw-${Date.now()}.rgb`);
  const r = runFfmpeg(
    dir,
    ['-y', '-i', file, '-vf', `scale=${size}:${size}:flags=area`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', out],
    90000,
  );
  if (!r.ok || !fs.existsSync(out)) {
    return { ok: false, error: `ffmpeg 解码失败（status=${r.status}）` };
  }
  const data = fs.readFileSync(out);
  try {
    fs.unlinkSync(out);
  } catch {}
  if (data.length < size * size * 3) {
    return { ok: false, error: `解码数据不足（${data.length} 字节）` };
  }
  return { ok: true, width: size, height: size, data };
}

/** 顺带取原始像素尺寸（画幅比例要按原图算，不能按缩放后的算） */
export function probeSize(dir, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = spawnSync(
    dir ? path.join(dir, 'ffprobe' + EXE) : 'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  if (r.error || typeof r.stdout !== 'string') return null;
  const m = r.stdout.trim().match(/^(\d+),(\d+)/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}
