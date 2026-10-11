import { describe, expect, it } from 'vitest';
import { Scenes, checkScenesAgainstPdf, scenesJsonSchema } from '../src/schema.js';

const base = (scene: object) => ({
  title: 'T',
  language: 'en',
  scenes: [{ id: 1, page: 1, narration: 'Hello.', ...scene }],
});

describe('Scenes schema', () => {
  it('accepts a valid scene with and without focus', () => {
    expect(Scenes.safeParse(base({})).success).toBe(true);
    expect(Scenes.safeParse(base({ focus: { x: 0.1, y: 0.2, w: 0.8, h: 0.4 } })).success).toBe(true);
  });
  it('rejects duplicate scene ids with a clear message', () => {
    const r = Scenes.safeParse({
      title: 'T',
      language: 'en',
      scenes: [
        { id: 1, page: 1, narration: 'A.' },
        { id: 1, page: 1, narration: 'B.' },
      ],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('duplicate scene id 1');
  });
  it('rejects page 0', () => expect(Scenes.safeParse(base({ page: 0 })).success).toBe(false));
  it('rejects focus outside 0-1', () => {
    expect(Scenes.safeParse(base({ focus: { x: -0.1, y: 0, w: 0.5, h: 0.5 } })).success).toBe(false);
    expect(Scenes.safeParse(base({ focus: { x: 0, y: 0, w: 1.5, h: 0.5 } })).success).toBe(false);
  });
  it('rejects empty narration', () => {
    expect(Scenes.safeParse(base({ narration: '' })).success).toBe(false);
    expect(Scenes.safeParse(base({ narration: '   ' })).success).toBe(false);
  });
  it('exposes a JSON schema', () => expect(scenesJsonSchema).toHaveProperty('properties.scenes'));
});

describe('checkScenesAgainstPdf', () => {
  it('clamps pages and warns', () => {
    const input = Scenes.parse({
      ...base({}),
      scenes: [
        { id: 1, page: 99, narration: 'a' },
        { id: 2, page: 2, narration: 'b' },
      ],
    });
    const { scenes, warnings } = checkScenesAgainstPdf(input, 5);
    expect(scenes.scenes.map((s) => s.page)).toEqual([5, 2]);
    expect(warnings).toHaveLength(1);
    expect(input.scenes[0]!.page).toBe(99); // input not mutated
  });
  it('drops focus that runs past the page and warns', () => {
    const input = Scenes.parse(base({ focus: { x: 0.5, y: 0, w: 0.6, h: 0.5 } }));
    const { scenes, warnings } = checkScenesAgainstPdf(input, 3);
    expect(scenes.scenes[0]).not.toHaveProperty('focus');
    expect(warnings).toHaveLength(1);
  });
  it('keeps a valid focus without warnings', () => {
    const input = Scenes.parse(base({ focus: { x: 0.1, y: 0.2, w: 0.9, h: 0.8 } }));
    const { scenes, warnings } = checkScenesAgainstPdf(input, 3);
    expect(scenes.scenes[0]!.focus).toBeDefined();
    expect(warnings).toEqual([]);
  });
});
