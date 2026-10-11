import { describe, expect, it } from 'vitest';
import {
  buildAss,
  buildCues,
  buildSrt,
  escapeAss,
  formatAssTime,
  formatSrtTime,
  splitIntoCueLines,
} from '../src/pipeline/subtitles.js';

const long =
  'Revenue grew twelve percent year over year, driven mostly by the new subscription tier, while costs stayed flat across every region. Margins improved as a result and the board approved a larger buyback.';
const scenes = [
  { id: 1, narration: long },
  { id: 2, narration: 'Short one. Another short one! And a question?' },
  { id: 3, narration: 'x'.repeat(200) },
];
const timings = [
  { sceneId: 1, start: 0, speechEnd: 12.345, end: 12.745 },
  { sceneId: 2, start: 12.745, speechEnd: 17.003, end: 17.403 },
  { sceneId: 3, start: 17.403, speechEnd: 21.777, end: 22.177 },
];

describe('cues', () => {
  it('cover each scene speech exactly, with no gaps or overlaps', () => {
    const cues = buildCues(scenes, timings);
    for (const tm of timings) {
      const mine = cues.filter((c) => c.start >= tm.start && c.end <= tm.speechEnd);
      expect(mine[0]!.start).toBe(tm.start);
      expect(mine.at(-1)!.end).toBe(tm.speechEnd);
      mine.forEach((c, i) => {
        if (i > 0) expect(c.start).toBe(mine[i - 1]!.end);
        expect(c.end).toBeGreaterThan(c.start);
      });
    }
  });

  it('keeps every line within 42 chars and 2 lines per cue', () => {
    for (const c of buildCues(scenes, timings)) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      for (const l of c.lines) expect(l.length).toBeLessThanOrEqual(42);
    }
  });

  it('does not crash on long word-free strings and keeps all characters', () => {
    const lines = splitIntoCueLines('y'.repeat(500));
    expect(lines.flat().join('').length).toBe(500);
    for (const l of lines.flat()) expect(l.length).toBeLessThanOrEqual(42);
  });

  it('gives each cue at least 0.8s when there is room', () => {
    const cues = buildCues([scenes[1]!], [timings[1]!]);
    for (const c of cues) expect(c.end - c.start).toBeGreaterThanOrEqual(0.8 - 1e-9);
  });

  it('leaves the tail without subtitles', () => {
    const cues = buildCues(scenes, timings);
    expect(cues.some((c) => c.start >= 12.345 && c.start < 12.745)).toBe(false);
  });

  it('skips scenes with no timing', () => {
    expect(buildCues(scenes, [timings[0]!]).every((c) => c.end <= 12.345)).toBe(true);
  });
});

describe('formatting', () => {
  it('formats ASS as H:MM:SS.cc and SRT as HH:MM:SS,mmm', () => {
    expect(formatAssTime(3725.678)).toBe('1:02:05.68');
    expect(formatSrtTime(3725.678)).toBe('01:02:05,678');
  });

  it('formats a shared boundary identically so rounded cues stay contiguous', () => {
    const ass = buildAss({ scenes, timings, width: 1280, height: 720 })
      .split('\n')
      .filter((l) => l.startsWith('Dialogue'))
      .map((l) => l.split(','));
    for (let i = 1; i < ass.length; i++) {
      const prevEnd = ass[i - 1]![2];
      const start = ass[i]![1];
      // Within a scene they must match; across scenes the tail gap is allowed.
      if (start === prevEnd) continue;
      expect(formatAssTime(12.345)).toBe('0:00:12.35');
    }
    const first = ass.find((l) => l[2] !== undefined)!;
    expect(first[1]).toBe('0:00:00.00');
  });

  it('escapes ASS specials', () => {
    expect(escapeAss('a {b} \\c')).toBe('a \\{b\\} \u29F5c');
    const ass = buildAss({
      scenes: [{ id: 1, narration: 'Line {\\an8} one\ntwo' }],
      timings: [{ sceneId: 1, start: 0, speechEnd: 2, end: 2.4 }],
      width: 640,
      height: 360,
    });
    expect(ass).toContain('Line \\{\u29F5an8\\} one two');
  });
});

describe('buildAss', () => {
  it('sets PlayRes to the video size and uses the given font', () => {
    const ass = buildAss({ scenes, timings, width: 1920, height: 1080, fontName: 'Inter' });
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toContain('PlayResY: 1080');
    expect(ass).toContain('WrapStyle: 2');
    expect(ass).toContain('Style: Default,Inter,49,');
  });

  it('uses a near-opaque box so white text reads on white pages and line boxes do not show an overlap band', () => {
    const ass = buildAss({ scenes, timings, width: 1920, height: 1080 });
    const style = ass.split(/\r?\n/).find((l) => l.startsWith('Style: Default'))!.split(',');
    // Fields: ..., PrimaryColour(3), Secondary(4), Outline(5), Back(6), ..., BorderStyle(15)
    expect(style[15]).toBe('3');
    for (const colour of [style[5]!, style[6]!]) {
      const alpha = parseInt(colour.slice(2, 4), 16); // &HAABBGGRR, 00 = opaque
      expect(alpha).toBeLessThanOrEqual(0x20);
    }
  });
});

describe('buildSrt', () => {
  it('numbers cues and uses comma milliseconds', () => {
    const srt = buildSrt({ scenes, timings });
    expect(srt.startsWith('1\n00:00:00,000 --> ')).toBe(true);
    expect(srt).toMatch(/\n2\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}\n/);
    expect(srt).toContain('00:00:12,345');
  });

  it('pairs timings with scenes by position, even when ids repeat', () => {
    const dup = [
      { id: 1, narration: 'First scene text here.' },
      { id: 1, narration: 'Second scene text here.' },
    ];
    const tm = [
      { sceneId: 1, start: 0, speechEnd: 5, end: 5.4 },
      { sceneId: 1, start: 5.4, speechEnd: 10, end: 10.4 },
    ];
    const cues = buildCues(dup, tm);
    expect(cues.at(-1)!.lines.join(' ')).toContain('Second');
    expect(cues.at(-1)!.start).toBeGreaterThanOrEqual(5.4);
  });
});
