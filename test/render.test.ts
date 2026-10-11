import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mediaDuration } from '../src/lib/ffmpeg.js';
import { pcmToWav } from '../src/lib/wav.js';
import { cropAtFrame, fitRect, frameCounts, renderVideo, targetCrop } from '../src/pipeline/render.js';

const work = mkdtempSync(join(tmpdir(), 'p2v-render-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const W = 3840;
const H = 2160;
const page = fitRect(612, 792, W, H); // portrait letter page

describe('fitRect', () => {
  it('centres a portrait page, limited by height', () => {
    expect(page.h).toBeLessThan(H);
    expect(page.x + page.w / 2).toBeCloseTo(W / 2);
    expect(page.y + page.h / 2).toBeCloseTo(H / 2);
    expect(page.w / page.h).toBeCloseTo(612 / 792);
  });
});

describe('targetCrop', () => {
  it('always has the stage aspect and stays inside the stage', () => {
    for (const focus of [
      { x: 0, y: 0, w: 0.1, h: 0.1 },
      { x: 0.9, y: 0.9, w: 0.1, h: 0.1 },
      { x: 0.2, y: 0.3, w: 0.6, h: 0.2 },
      { x: 0, y: 0, w: 1, h: 1 },
    ]) {
      const c = targetCrop(W, H, page, focus);
      expect(c.w / c.h).toBeCloseTo(W / H);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(W + 1e-6);
      expect(c.y + c.h).toBeLessThanOrEqual(H + 1e-6);
    }
  });

  it('never zooms tighter than 35% of the stage width', () => {
    expect(targetCrop(W, H, page, { x: 0.4, y: 0.4, w: 0.01, h: 0.01 }).w).toBeCloseTo(W * 0.35);
  });

  it('centres on the focus box when there is room', () => {
    const c = targetCrop(W, H, page, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
    expect(c.x + c.w / 2).toBeCloseTo(page.x + 0.5 * page.w);
    expect(c.y + c.h / 2).toBeCloseTo(page.y + 0.5 * page.h);
  });

  it('grows a wide, short box to 16:9 by width', () => {
    const c = targetCrop(W, H, page, { x: 0, y: 0.4, w: 1, h: 0.05 });
    expect(c.w).toBeCloseTo(page.w);
  });

  it('without focus is a gentle centred zoom', () => {
    const c = targetCrop(W, H, page);
    expect(c.w).toBeCloseTo(W / 1.06);
    expect(c.x + c.w / 2).toBeCloseTo(W / 2);
  });
});

describe('frameCounts', () => {
  it('sums to the rounded total, so rounding never drifts', () => {
    const edges = [0, 13.2, 28.08, 40.88, 51.333, 60.007];
    const timings = edges.slice(1).map((end, i) => ({ start: edges[i]!, end }));
    const counts = frameCounts(timings, 30);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(Math.round(60.007 * 30));
    expect(counts.every((n) => n > 0)).toBe(true);
  });
});

describe('cropAtFrame', () => {
  const target = targetCrop(W, H, page, { x: 0.1, y: 0.1, w: 0.3, h: 0.2 });
  it('starts on the full stage and ends on the target', () => {
    expect(cropAtFrame(0, 30, W, H, { ...target })).toEqual({ x: 0, y: 0, w: W, h: H });
    const end = cropAtFrame(29, 30, W, H, target);
    expect(end.w).toBeCloseTo(target.w);
    expect(end.x).toBeCloseTo(target.x);
  });
  it('shrinks monotonically with ease-in-out (slow at both ends)', () => {
    const w = Array.from({ length: 30 }, (_, i) => cropAtFrame(i, 30, W, H, target).w);
    expect(w.every((v, i) => i === 0 || v <= w[i - 1]!)).toBe(true);
    expect(w[0]! - w[1]!).toBeLessThan(w[14]! - w[15]!);
  });
  it('handles a one-frame clip', () => {
    expect(cropAtFrame(0, 1, W, H, target).w).toBeCloseTo(target.w);
  });
});

describe('renderVideo (tiny real render)', () => {
  it('writes an mp4 of the narration length with burned subtitles, and reuses clips', async () => {
    const rate = 24000;
    const pcm = Buffer.alloc(rate * 2); // 1 s of silence, 16-bit mono
    const wav = join(work, 'n.wav');
    writeFileSync(wav, pcmToWav(pcm, { sampleRate: rate, channels: 1, bitsPerSample: 16 }));
    const opts = {
      scenes: { title: 't', language: 'en', scenes: [{ id: 1, page: 1, narration: 'Hello there.', focus: { x: 0.1, y: 0.1, w: 0.5, h: 0.3 } }] },
      timings: [{ sceneId: 1, start: 0, speechEnd: 0.8, end: 1 }],
      narrationPath: wav,
      pdfBytes: new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'sample.pdf'))),
      pdfHash: 'testhash',
      workDir: join(work, 'w'),
      outPath: join(work, 'out.mp4'),
      size: { width: 320, height: 180 },
    };
    const r = await renderVideo(opts);
    expect(r.subtitles).toBe('burned');
    expect(Math.abs(r.durationSeconds - 1)).toBeLessThan(0.1);
    expect(existsSync(r.outPath)).toBe(true);
    const clips = readdirSync(join(work, 'w', 'clips'));
    const msgs: string[] = [];
    await renderVideo({ ...opts, onProgress: (m) => msgs.push(m) });
    expect(msgs.some((m) => m.includes('cached'))).toBe(true);
    expect(readdirSync(join(work, 'w', 'clips'))).toEqual(clips);
    expect(await mediaDuration(r.outPath)).toBeCloseTo(r.durationSeconds, 1);
  }, 30_000);
});
