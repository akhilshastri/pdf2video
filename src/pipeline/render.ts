/**
 * Stage 5-6: PDF page PNGs + joined narration + subtitles -> one MP4.
 *
 * Per page: a 2x-size 16:9 "stage" PNG (page fitted over a blurred, darkened copy of itself).
 * Per scene: a silent clip (plan D14) pushing slowly from the whole stage toward the focus box,
 * cached by clipKey. Clips are joined with the concat demuxer (-c copy), then one final pass
 * muxes the single narration track and burns the ASS subtitles.
 *
 * Smooth zoom: ffmpeg's zoompan/crop snap to whole source pixels, which showed up as stalls
 * (every ~3rd frame identical) in a measured edge-tracking test. So each frame is drawn with
 * canvas drawImage using a fractional source rect (smoothstep eased) and piped to ffmpeg as raw RGBA.
 *
 * Dependents: src/cli.ts. Uses extract.ts (pages), subtitles.ts, tts.ts (timings), lib/cache.ts.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { cached, clipKey, fileHash, hashOf, produceAtomic } from '../lib/cache.js';
import { mediaDuration, runFfmpeg } from '../lib/ffmpeg.js';
import type { Focus, Scenes } from '../schema.js';
import { extractPages } from './extract.js';
import { buildAss, buildSrt } from './subtitles.js';
import type { SceneTiming } from './tts.js';

/** Bump when clip pixels would change (stage look, motion, encoder settings). */
export const RENDER_VERSION = 4;

export const FONT_FAMILY = 'Noto Sans';
const MIN_ZOOM_WIDTH = 0.35; // crop never narrower than 35% of the stage
const DEFAULT_ZOOM = 1.06;
const PAGE_MARGIN = 0.92; // page occupies at most this fraction of the stage when fitted

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Page rect fitted (contain) inside the stage, centred. */
export const fitRect = (pageW: number, pageH: number, stageW: number, stageH: number): Rect => {
  const s = Math.min((stageW * PAGE_MARGIN) / pageW, (stageH * PAGE_MARGIN) / pageH);
  const w = pageW * s;
  const h = pageH * s;
  return { x: (stageW - w) / 2, y: (stageH - h) / 2, w, h };
};

/**
 * Crop box (stage pixels) a clip ends on. Focus fractions map through the fitted page rect;
 * the box is grown to the stage aspect around its centre, at least MIN_ZOOM_WIDTH wide, then
 * shifted (not squeezed) back inside the stage. No focus = a gentle centred zoom.
 */
export const targetCrop = (stageW: number, stageH: number, page: Rect, focus?: Focus): Rect => {
  const aspect = stageW / stageH;
  let w: number;
  let cx: number;
  let cy: number;
  if (focus) {
    const fw = focus.w * page.w;
    const fh = focus.h * page.h;
    w = Math.max(fw, fh * aspect, stageW * MIN_ZOOM_WIDTH);
    cx = page.x + (focus.x + focus.w / 2) * page.w;
    cy = page.y + (focus.y + focus.h / 2) * page.h;
  } else {
    w = stageW / DEFAULT_ZOOM;
    cx = stageW / 2;
    cy = stageH / 2;
  }
  w = Math.min(w, stageW);
  const h = w / aspect;
  const x = Math.min(Math.max(cx - w / 2, 0), stageW - w);
  const y = Math.min(Math.max(cy - h / 2, 0), stageH - h);
  return { x, y, w, h };
};

/** Frames per scene as differences of rounded boundaries, so rounding never accumulates. */
export const frameCounts = (timings: Pick<SceneTiming, 'start' | 'end'>[], fps: number): number[] =>
  timings.map((t) => Math.round(t.end * fps) - Math.round(t.start * fps));

/** Smoothstep ease-in-out, 0..1 -> 0..1. */
const ease = (p: number): number => p * p * (3 - 2 * p);

/** Crop box for frame `i` of `frames`: the full stage easing toward `target`. Fractional on purpose. */
export const cropAtFrame = (i: number, frames: number, stageW: number, stageH: number, target: Rect): Rect => {
  const e = ease(frames > 1 ? i / (frames - 1) : 1);
  return {
    x: target.x * e,
    y: target.y * e,
    w: stageW + (target.w - stageW) * e,
    h: stageH + (target.h - stageH) * e,
  };
};

/** Yields raw RGBA frames of the push-in; one canvas is reused for every frame. */
async function* clipFrames(stagePng: string, target: Rect, frames: number, stageW: number, stageH: number, outW: number, outH: number) {
  const img = await loadImage(stagePng);
  const canvas = createCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  for (let i = 0; i < frames; i++) {
    const c = cropAtFrame(i, frames, stageW, stageH, target);
    ctx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, outW, outH);
    yield canvas.data();
  }
}

/** Draws the page contained over a blurred, darkened, cover-scaled copy of itself. */
const composeStage = async (pagePng: string, stageW: number, stageH: number, outPath: string): Promise<Rect> => {
  const img = await loadImage(pagePng);
  const canvas = createCanvas(stageW, stageH);
  const ctx = canvas.getContext('2d');

  // Blur by downscaling to ~1/24 and drawing back up with smoothing: cheap and deterministic
  // (ctx.filter blur is not relied on).
  const small = createCanvas(Math.round(stageW / 24), Math.round(stageH / 24));
  const sctx = small.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  const cover = Math.max(small.width / img.width, small.height / img.height);
  const cw = img.width * cover;
  const ch = img.height * cover;
  sctx.drawImage(img, (small.width - cw) / 2, (small.height - ch) / 2, cw, ch);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, stageW, stageH);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0, stageW, stageH);

  const r = fitRect(img.width, img.height, stageW, stageH);
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = stageH / 60;
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
  await writeFile(outPath, canvas.toBuffer('image/png'));
  return r;
};

/** assets/ sits two levels up from src/pipeline/ and one level up from dist/. */
const findAssets = (): string => {
  for (const rel of ['../../assets', '../assets']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, 'fonts'))) return dir;
  }
  throw new Error('Could not find the assets/ folder next to the program files.');
};

export interface RenderOptions {
  scenes: Scenes;
  timings: SceneTiming[];
  narrationPath: string;
  pdfBytes: Uint8Array;
  pdfHash: string;
  workDir: string;
  outPath: string;
  size: { width: number; height: number };
  fps?: number;
  force?: boolean;
  onProgress?: (msg: string) => void;
}

export interface RenderResult {
  outPath: string;
  durationSeconds: number;
  subtitles: 'burned' | 'soft';
}

export const renderVideo = async (o: RenderOptions): Promise<RenderResult> => {
  const { scenes, timings, workDir, size, fps = 30, force = false } = o;
  const log = o.onProgress ?? (() => {});
  const workAbs = resolve(workDir);
  const stageW = size.width * 2;
  const stageH = size.height * 2;
  const sizeKey = `${size.width}x${size.height}`;

  const needed = [...new Set(scenes.scenes.map((s) => s.page))].sort((a, b) => a - b);
  log(`Rendering ${needed.length} page(s)`);
  const pages = await extractPages({ pdfBytes: o.pdfBytes, pdfHash: o.pdfHash, workDir: workAbs, pages: needed, force });

  // Stages: one per page. Keyed by the page PNG's content, so a new raster (font fix, RASTER_VERSION
  // bump) never reuses an old stage; clips below include the stage key for the same reason.
  const stages = new Map<number, { path: string; rect: Rect; key: string }>();
  for (const n of needed) {
    const png = pages.get(n)!;
    const key = hashOf('stage', await fileHash(png), sizeKey, RENDER_VERSION).slice(0, 16);
    const path = join(workAbs, 'stages', `${key}.png`);
    let rect: Rect | undefined;
    const hit = await cached(path, async (p) => { rect = await composeStage(png, stageW, stageH, p); }, force);
    if (hit) {
      const img = await loadImage(png);
      rect = fitRect(img.width, img.height, stageW, stageH);
    }
    stages.set(n, { path, rect: rect!, key });
  }

  // Clips: silent, one per scene, cached.
  const frames = frameCounts(timings, fps);
  const clipPaths: string[] = [];
  for (const [i, scene] of scenes.scenes.entries()) {
    const stage = stages.get(scene.page)!;
    const key = clipKey({
      // Audio is muxed later, so the clip depends on its length (frames), not the audio file.
      audioKey: `frames:${frames[i]}:fps:${fps}`,
      page: scene.page,
      focus: scene.focus,
      size: `${sizeKey}:${stage.key}`,
      renderVersion: RENDER_VERSION,
    });
    const clip = join(workAbs, 'clips', `${key}.mp4`);
    const crop = targetCrop(stageW, stageH, stage.rect, scene.focus);
    const hit = await cached(clip, async (p) => {
      log(`Scene ${i + 1}/${scenes.scenes.length}: rendering`);
      await runFfmpeg(
        [
          '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${size.width}x${size.height}`, '-r', String(fps), '-i', '-',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-an', p,
        ],
        { stdin: clipFrames(stage.path, crop, frames[i]!, stageW, stageH, size.width, size.height) },
      );
    }, force);
    if (hit) log(`Scene ${i + 1}/${scenes.scenes.length}: cached`);
    clipPaths.push(clip);
  }

  // Concat with relative paths + cwd keeps Windows drive letters out of ffmpeg's parsers.
  await writeFile(
    join(workAbs, 'concat.txt'),
    clipPaths.map((p) => `file 'clips/${p.split(/[\\/]/).pop()}'`).join('\n') + '\n',
  );
  await produceAtomic(join(workAbs, 'silent.mp4'), (tmp) =>
    runFfmpeg(['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', tmp], { cwd: workAbs }).then(() => {}),
  );

  // Subtitles + fonts (fontsdir must be relative too).
  const fontsDir = join(workAbs, 'fonts');
  mkdirSync(fontsDir, { recursive: true });
  const srcFonts = join(findAssets(), 'fonts');
  for (const f of readdirSync(srcFonts).filter((f) => /\.(ttf|otf)$/i.test(f))) {
    copyFileSync(join(srcFonts, f), join(fontsDir, f));
  }
  const subOpts = { scenes: scenes.scenes, timings, width: size.width, height: size.height };
  await writeFile(join(workAbs, 'subs.ass'), buildAss({ ...subOpts, fontName: FONT_FAMILY }));

  // Final pass. The output path may be absolute; only filter inputs must stay relative.
  const out = resolve(o.outPath);
  mkdirSync(dirname(out), { recursive: true });
  const common = [
    '-i', 'silent.mp4', '-i', resolve(o.narrationPath),
    '-map', '0:v', '-map', '1:a',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest',
  ];
  let subtitles = 'burned' as RenderResult['subtitles']; // cast: assigned inside the closure below
  log('Muxing audio and burning subtitles');
  await produceAtomic(out, async (tmp) => {
    try {
      await runFfmpeg(
        [...common, '-vf', 'subtitles=subs.ass:fontsdir=fonts', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', tmp],
        { cwd: workAbs },
      );
    } catch (e) {
      log(`Subtitle burn-in failed, writing a soft .srt instead (${(e as Error).message.split('\n')[0]})`);
      subtitles = 'soft';
      await runFfmpeg([...common, '-c:v', 'copy', tmp], { cwd: workAbs });
    }
  });
  if (subtitles === 'soft') await writeFile(out.replace(/\.[^.\\/]+$/, '') + '.srt', buildSrt(subOpts));
  return { outPath: out, durationSeconds: await mediaDuration(out), subtitles };
};
