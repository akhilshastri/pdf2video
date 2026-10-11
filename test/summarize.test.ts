import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/gemini.js', () => ({ generateJson: vi.fn() }));

import { generateJson } from '../src/lib/gemini.js';
import { buildPrompt, summarize } from '../src/pipeline/summarize.js';

const mock = vi.mocked(generateJson);
const valid = (page = 1) => ({
  title: 'T',
  language: 'en',
  scenes: [{ id: 1, page, narration: 'One short sentence.' }],
});
const opts = { pdfBytes: new Uint8Array([1, 2, 3]), pageCount: 4, lengthSeconds: 90, lang: 'en' };

beforeEach(() => mock.mockReset());

describe('summarize', () => {
  it('returns scenes for a valid reply', async () => {
    mock.mockResolvedValueOnce(valid());
    const r = await summarize(opts);
    expect(r.scenes.scenes).toHaveLength(1);
    expect(r.warnings).toEqual([]);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('retries once with the error summary, then succeeds', async () => {
    mock.mockResolvedValueOnce({ title: 'T' }).mockResolvedValueOnce(valid());
    const r = await summarize(opts);
    expect(r.scenes.scenes).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1]![1]).toContain('previous reply was rejected');
  });

  it('fails after two invalid replies', async () => {
    mock.mockResolvedValue({ nope: true });
    await expect(summarize(opts)).rejects.toThrow(/even after a retry/);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('clamps an out-of-range page with a warning', async () => {
    mock.mockResolvedValueOnce(valid(9));
    const r = await summarize(opts);
    expect(r.scenes.scenes[0]!.page).toBe(4);
    expect(r.warnings.join(' ')).toMatch(/page 9/);
  });

  it('warns when narration is far over the word budget', async () => {
    const long = { ...valid(), scenes: [{ id: 1, page: 1, narration: 'word '.repeat(400) }] };
    mock.mockResolvedValueOnce(long);
    const r = await summarize(opts);
    expect(r.warnings.join(' ')).toMatch(/over the ~225 word budget/);
  });

  it('rejects PDFs over 14 MB', async () => {
    await expect(summarize({ ...opts, pdfBytes: new Uint8Array(15 * 1024 * 1024) })).rejects.toThrow(/14 MB/);
  });
});

describe('buildPrompt', () => {
  it('contains the budget numbers and page count, with no placeholders left', () => {
    const p = buildPrompt({ pageCount: 4, lengthSeconds: 90, lang: 'en' });
    expect(p).toContain('225 words'); // 90 * 2.5
    expect(p).toContain('at most 8 scenes'); // round(90 / 11)
    expect(p).toContain('4 pages');
    expect(p).not.toMatch(/\{\{/);
  });
});
