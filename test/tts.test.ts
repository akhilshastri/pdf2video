import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaExhaustedError } from '../src/lib/gemini.js';
import { parseWav } from '../src/lib/wav.js';
import { joinNarration, synthesizeScenes } from '../src/pipeline/tts.js';
import type { Scene } from '../src/schema.js';

vi.mock('../src/lib/gemini.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/gemini.js')>()),
  synthesizeSpeech: vi.fn(),
}));
const { synthesizeSpeech } = await import('../src/lib/gemini.js');
const speak = vi.mocked(synthesizeSpeech);

const RATE = 1000; // tiny rate keeps buffers small
const reply = (seconds: number) => ({
  pcm: Buffer.alloc(Math.round(seconds * RATE) * 2, 1),
  sampleRate: RATE,
  channels: 1,
  bitsPerSample: 16,
});
const scene = (id: number, narration: string): Scene => ({ id, page: 1, narration });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tts-'));
  speak.mockReset();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const opts = (scenes: Scene[], extra = {}) => ({
  scenes, workDir: dir, voice: 'Kore', ttsModel: 'm', lang: 'en', ...extra,
});

describe('synthesizeScenes', () => {
  it('writes wavs with duration from sample count, then hits the cache with zero calls', async () => {
    speak.mockResolvedValue(reply(2));
    const scenes = [scene(1, 'one two three'), scene(2, 'four five six')];
    const first = await synthesizeScenes(opts(scenes));
    expect(first.map((a) => a.durationSeconds)).toEqual([2, 2]);
    expect(speak).toHaveBeenCalledTimes(2);
    speak.mockClear();
    const second = await synthesizeScenes(opts(scenes));
    expect(speak).not.toHaveBeenCalled();
    expect(second.map((a) => a.key)).toEqual(first.map((a) => a.key));
  });

  it('calls again for changed narration only, and for force', async () => {
    speak.mockResolvedValue(reply(2));
    await synthesizeScenes(opts([scene(1, 'one two three'), scene(2, 'four five six')]));
    speak.mockClear();
    await synthesizeScenes(opts([scene(1, 'one two three'), scene(2, 'four five seven')]));
    expect(speak).toHaveBeenCalledTimes(1);
    speak.mockClear();
    await synthesizeScenes(opts([scene(1, 'one two three')], { force: true }));
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('retries too-short audio up to 2 more times', async () => {
    speak.mockResolvedValueOnce(reply(0.1)).mockResolvedValueOnce(reply(0)).mockResolvedValue(reply(2));
    const [a] = await synthesizeScenes(opts([scene(7, 'one two three four five')]));
    expect(speak).toHaveBeenCalledTimes(3);
    expect(a?.durationSeconds).toBe(2);
  });

  it('fails naming the scene after 3 short replies', async () => {
    speak.mockResolvedValue(reply(0.1));
    await expect(synthesizeScenes(opts([scene(9, 'one two three four five')]))).rejects.toThrow(/Scene 9/);
    expect(speak).toHaveBeenCalledTimes(3);
  });

  it('lets QuotaExhaustedError through and keeps earlier scenes on disk', async () => {
    speak.mockResolvedValueOnce(reply(2)).mockRejectedValueOnce(new QuotaExhaustedError('PerDay'));
    const scenes = [scene(1, 'one two three'), scene(2, 'four five six')];
    await expect(synthesizeScenes(opts(scenes))).rejects.toBeInstanceOf(QuotaExhaustedError);
    speak.mockClear();
    speak.mockResolvedValue(reply(2));
    await synthesizeScenes(opts(scenes));
    expect(speak).toHaveBeenCalledTimes(1); // only scene 2 is redone
  });
});

describe('joinNarration', () => {
  it('pads each scene with the tail and reports timings', async () => {
    speak.mockResolvedValueOnce(reply(2)).mockResolvedValueOnce(reply(3));
    const audios = await synthesizeScenes(opts([scene(1, 'one two three'), scene(2, 'four five six')]));
    const out = join(dir, 'narration.wav');
    const joined = await joinNarration(audios, out, 0.4);
    expect(joined.totalSeconds).toBeCloseTo(2 + 3 + 2 * 0.4, 6);
    expect(joined.timings[0]).toMatchObject({ sceneId: 1, start: 0 });
    expect(joined.timings[0]!.speechEnd).toBeCloseTo(2, 6);
    expect(joined.timings[0]!.end).toBeCloseTo(2.4, 6);
    expect(joined.timings[1]!.start).toBeCloseTo(2.4, 6);
    expect(joined.timings[1]!.end).toBeCloseTo(5.8, 6);
    const wav = parseWav(await readFile(out))!;
    expect(wav.pcm.length / (RATE * 2)).toBeCloseTo(5.8, 6);
  });

  it('rejects mixed formats', async () => {
    speak.mockResolvedValueOnce(reply(2)).mockResolvedValueOnce({ ...reply(2), sampleRate: 2000 });
    const audios = await synthesizeScenes(opts([scene(1, 'one two three'), scene(2, 'four five six')]));
    await expect(joinNarration(audios, join(dir, 'n.wav'))).rejects.toThrow(/format/);
  });
});
