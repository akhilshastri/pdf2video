/**
 * Stage 4: narration -> one WAV per scene, then one joined narration track.
 * Owns: per-scene synthesis with cache + sanity checks, and the WAV join (pure Node, no ffmpeg).
 * Fits in: reads Scene from src/schema.ts, calls src/lib/gemini.ts, caches via src/lib/cache.ts.
 * Dependents: src/pipeline/subtitles.ts (timings), src/pipeline/render.ts (joined track), src/cli.ts.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { audioKey, cached } from '../lib/cache.js';
import { synthesizeSpeech } from '../lib/gemini.js';
import { parseWav, pcmDurationSeconds, pcmToWav, type PcmFormat } from '../lib/wav.js';
import type { Scene } from '../schema.js';

/**
 * Version of how narration text is sent to TTS. Bump it whenever that changes; it rides in
 * the key's `ttsModel` field (see keyFor) so old audio is not reused.
 * v2: no style prefix. gemini-3.8-flash-tts read "Read in a calm, clear explainer tone:" aloud
 * (A/B on 2026-10-11: 3.48 s plain vs 7.48 s prefixed for the same sentence).
 */
export const TTS_PROMPT_VERSION = 2;
const STYLE_PREFIX = '';

/** Real speech runs ~0.4 s/word; below 0.3 s/word the reply was truncated or garbage. */
const MIN_SECONDS_PER_WORD = 0.3;
const EXTRA_TRIES = 2;

export interface SceneAudio {
  sceneId: number;
  key: string;
  wavPath: string;
  durationSeconds: number;
}

export interface SynthesizeOptions {
  scenes: Scene[];
  workDir: string;
  voice: string;
  ttsModel: string;
  lang: string;
  force?: boolean;
  onProgress?: (info: { sceneId: number; index: number; total: number; cached: boolean }) => void;
}

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

const keyFor = (s: Scene, o: Pick<SynthesizeOptions, 'voice' | 'ttsModel' | 'lang'>): string =>
  audioKey({ narration: s.narration, voice: o.voice, ttsModel: `${o.ttsModel}#p${TTS_PROMPT_VERSION}`, lang: o.lang });

/** Reads a cached WAV's duration from its sample count. */
const wavDuration = async (path: string): Promise<number> => {
  const wav = parseWav(await readFile(path));
  if (!wav) throw new Error(`${path} is not a valid WAV file. Delete it and re-run.`);
  return pcmDurationSeconds(wav.pcm, wav);
};

/** Asks for speech until the reply passes the length check; QuotaExhaustedError passes through untouched. */
const speakWithChecks = async (scene: Scene, o: SynthesizeOptions): Promise<Buffer> => {
  const minSeconds = wordCount(scene.narration) * MIN_SECONDS_PER_WORD;
  for (let attempt = 1; ; attempt++) {
    const speech = await synthesizeSpeech(STYLE_PREFIX + scene.narration, o.voice, o.ttsModel);
    const seconds = pcmDurationSeconds(speech.pcm, speech);
    if (speech.pcm.length > 0 && seconds >= minSeconds) return pcmToWav(speech.pcm, speech);
    if (attempt > EXTRA_TRIES) {
      throw new Error(
        `Scene ${scene.id}: speech audio is too short (${seconds.toFixed(2)} s for ${wordCount(scene.narration)} words) after ${attempt} attempts.`,
      );
    }
  }
};

/** Sequential on purpose: the free tier allows only a few TTS requests per minute. */
export const synthesizeScenes = async (o: SynthesizeOptions): Promise<SceneAudio[]> => {
  const dir = join(o.workDir, 'audio');
  await mkdir(dir, { recursive: true });
  const out: SceneAudio[] = [];
  for (const [i, scene] of o.scenes.entries()) {
    const key = keyFor(scene, o);
    const wavPath = join(dir, `${key}.wav`);
    const produce = async (p: string) => writeFile(p, await speakWithChecks(scene, o));
    let hit = false;
    if (o.force) await produce(wavPath);
    else hit = await cached(wavPath, produce);
    out.push({ sceneId: scene.id, key, wavPath, durationSeconds: await wavDuration(wavPath) });
    o.onProgress?.({ sceneId: scene.id, index: i + 1, total: o.scenes.length, cached: hit });
  }
  return out;
};

export interface SceneTiming {
  sceneId: number;
  start: number;
  /** End of speech. */
  speechEnd: number;
  /** End of this scene's slot (speech + tail); equals the next scene's start. */
  end: number;
}

export interface JoinedNarration {
  path: string;
  totalSeconds: number;
  timings: SceneTiming[];
}

/** Concatenates scene WAVs into one WAV, each followed by `tailSeconds` of silence. */
export const joinNarration = async (
  audios: SceneAudio[],
  outPath: string,
  tailSeconds = 0.4,
): Promise<JoinedNarration> => {
  if (audios.length === 0) throw new Error('No scene audio to join.');
  let format: PcmFormat | undefined;
  const chunks: Buffer[] = [];
  const timings: SceneTiming[] = [];
  let cursor = 0;
  for (const a of audios) {
    const wav = parseWav(await readFile(a.wavPath));
    if (!wav) throw new Error(`Scene ${a.sceneId}: ${a.wavPath} is not a valid WAV file.`);
    format ??= wav;
    if (wav.sampleRate !== format.sampleRate || wav.channels !== format.channels || wav.bitsPerSample !== format.bitsPerSample) {
      throw new Error(`Scene ${a.sceneId}: audio format differs from the first scene; cannot join.`);
    }
    const frame = format.channels * (format.bitsPerSample / 8);
    const tail = Buffer.alloc(Math.round(tailSeconds * format.sampleRate) * frame);
    const speech = pcmDurationSeconds(wav.pcm, format);
    const slot = speech + pcmDurationSeconds(tail, format);
    timings.push({ sceneId: a.sceneId, start: cursor, speechEnd: cursor + speech, end: cursor + slot });
    cursor += slot;
    chunks.push(wav.pcm, tail);
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, pcmToWav(Buffer.concat(chunks), format!));
  return { path: outPath, totalSeconds: cursor, timings };
};
