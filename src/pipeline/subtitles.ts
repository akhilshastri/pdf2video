/**
 * Subtitles: narration text + per-scene timings -> one ASS file (burned in) or SRT (soft fallback).
 *
 * Cues only cover speech (start..speechEnd of each scene); the silent tail has no subtitle.
 * Timings come from joinNarration in src/pipeline/tts.ts. Consumed by the render/mux step.
 * We wrap lines ourselves (WrapStyle 2) so line breaks are balanced and never exceed MAX_LINE.
 */
import type { Scene } from '../schema.js';
import type { SceneTiming } from './tts.js';

export const MAX_LINE = 42;
const MAX_LINES = 2;
const MIN_CUE_SECONDS = 0.8;

export interface Cue {
  start: number;
  end: number;
  /** Lines of plain text (no ASS escaping), at most MAX_LINES. */
  lines: string[];
}

export interface SubtitleOptions {
  scenes: Pick<Scene, 'id' | 'narration'>[];
  timings: SceneTiming[];
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
}

const splitSentences = (text: string): string[] =>
  text.match(/[^.!?…。！？]+(?:[.!?…。！？]+["')\]”’]*)?\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];

/** Words, with any word longer than a line hard-split so nothing can overflow. */
const toWords = (text: string): string[] =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => w.match(new RegExp(`.{1,${MAX_LINE}}`, 'gu')) ?? []);

/** Greedy wrap into lines of at most MAX_LINE chars. */
const wrapGreedy = (words: string[]): string[] => {
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > MAX_LINE) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
};

/** One or two lines, split at the word boundary that makes the longer line shortest. */
const balance = (words: string[]): string[] => {
  const whole = words.join(' ');
  if (whole.length <= MAX_LINE) return [whole];
  let best: string[] | undefined;
  let bestMax = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const m = Math.max(a.length, b.length);
    if (m <= MAX_LINE && m < bestMax) {
      best = [a, b];
      bestMax = m;
    }
  }
  // Callers pass words from at most two greedy lines, so a valid split always exists.
  return best ?? wrapGreedy(words);
};

/** Splits narration into cue texts, each at most MAX_LINES lines of MAX_LINE chars. */
export const splitIntoCueLines = (narration: string): string[][] => {
  const cues: string[][] = [];
  for (const sentence of splitSentences(narration.replace(/\s+/g, ' ').trim())) {
    const lines = wrapGreedy(toWords(sentence));
    for (let i = 0; i < lines.length; i += MAX_LINES) {
      cues.push(balance(toWords(lines.slice(i, i + MAX_LINES).join(' '))));
    }
  }
  return cues;
};

/** Cues for one scene, contiguous from `start` to `end` (seconds), shared by character count. */
export const buildSceneCues = (narration: string, start: number, end: number): Cue[] => {
  const texts = splitIntoCueLines(narration);
  if (texts.length === 0 || end <= start) return [];
  const span = end - start;
  const weights = texts.map((l) => l.join(' ').length);
  const total = weights.reduce((a, b) => a + b, 0);
  const n = texts.length;
  // Floor of MIN_CUE_SECONDS per cue when it fits; otherwise everything shares equally.
  const floor = n * MIN_CUE_SECONDS <= span ? MIN_CUE_SECONDS : 0;
  const extra = span - n * floor;
  const cues: Cue[] = [];
  let t = start;
  texts.forEach((lines, i) => {
    const next = i === n - 1 ? end : t + floor + (extra * (floor ? weights[i]! / total : 1 / n));
    cues.push({ start: t, end: next, lines });
    t = next;
  });
  return cues;
};

export const buildCues = (
  scenes: Pick<Scene, 'id' | 'narration'>[],
  timings: SceneTiming[],
): Cue[] =>
  timings.flatMap((tm) => {
    const scene = scenes.find((s) => s.id === tm.sceneId);
    return scene ? buildSceneCues(scene.narration, tm.start, tm.speechEnd) : [];
  });

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** H:MM:SS.cc. Rounds the boundary itself, so a shared boundary formats identically on both cues. */
export const formatAssTime = (seconds: number): string => {
  const cs = Math.round(seconds * 100);
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
};

/** HH:MM:SS,mmm */
export const formatSrtTime = (seconds: number): string => {
  const ms = Math.round(seconds * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

/** ASS has no backslash escape, so swap it for a lookalike; braces would open override tags. */
export const escapeAss = (line: string): string =>
  line.replace(/\\/g, '⧵').replace(/\{/g, '\\{').replace(/\}/g, '\\}');

export const buildAss = (o: SubtitleOptions): string => {
  const font = o.fontName ?? 'Arial';
  const size = o.fontSize ?? Math.round(o.height / 22);
  const margin = Math.round(o.height / 18);
  // BorderStyle 3 = box; libass paints it with OutlineColour. Alpha &H14 (~92% opaque) keeps white
  // text readable on a white PDF page, and is opaque enough that where the two lines' boxes
  // overlap no darker band shows (at &H99 the overlap was visible and the box read light grey).
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${size},&H00FFFFFF,&H00FFFFFF,&H14000000,&H14000000,0,0,0,0,100,100,0,0,3,${Math.max(2, Math.round(size / 8))},0,2,${margin},${margin},${margin},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = buildCues(o.scenes, o.timings).map(
    (c) =>
      `Dialogue: 0,${formatAssTime(c.start)},${formatAssTime(c.end)},Default,,0,0,0,,${c.lines.map(escapeAss).join('\\N')}`,
  );
  return [...header, ...events, ''].join('\n');
};

export const buildSrt = (o: Pick<SubtitleOptions, 'scenes' | 'timings'>): string =>
  buildCues(o.scenes, o.timings)
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.lines.join('\n')}\n`)
    .join('\n');
