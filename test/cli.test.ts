import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

// Only affects this process (the spawned-tsx tests below are separate processes).
vi.mock('../src/lib/gemini.js', () => ({
  generateJson: vi.fn(async () => ({
    title: 'Sample',
    language: 'en',
    scenes: [
      { id: 1, page: 1, narration: 'Hello there friend.' },
      { id: 2, page: 1, narration: 'Goodbye for now.' },
    ],
  })),
  // 1.0 s of 24 kHz mono s16 silence; long enough to pass the 3-words check in tts.ts.
  synthesizeSpeech: vi.fn(async () => ({ pcm: Buffer.alloc(48_000), sampleRate: 24000, channels: 1, bitsPerSample: 16 })),
}));

import { mediaDuration } from '../src/lib/ffmpeg.js';
import { askOrCancel, parseSize, program } from '../src/cli.js';

// VITEST is removed: src/cli.ts does not self-run when it is set (see its header).
const run = (args: string[], base: NodeJS.ProcessEnv = process.env) => {
  const env = { ...base };
  delete env.VITEST;
  return spawnSync('npx', ['tsx', 'src/cli.ts', ...args], { encoding: 'utf8', env, shell: true, timeout: 60_000 });
};

describe('cli', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf2video-cli-'));
  const workDir = join(dir, 'work');

  it('--help works', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--no-review');
  });

  it('missing GOOGLE_AI: exit 1, names the variable, no stack', () => {
    const env = { ...process.env };
    delete env.GOOGLE_AI;
    const r = run(['test/fixtures/sample.pdf', '--yes', '--no-review', '--work-dir', workDir], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('GOOGLE_AI');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('non-PDF file: clean error', () => {
    const file = join(dir, 'x.pdf');
    writeFileSync(file, 'hello');
    const r = run(['plan', file, '--yes', '--work-dir', workDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not a PDF');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});

describe('parseSize', () => {
  it('accepts WxH with even numbers', () => expect(parseSize('1280x720')).toEqual({ width: 1280, height: 720 }));
  it.each(['1280', '1281x720', '0x0', 'axb'])('rejects %s', (bad) => expect(() => parseSize(bad)).toThrow(/--size/));
});

describe('cli early validation', () => {
  it('bad --size fails before any Gemini call', async () => {
    const { generateJson } = await import('../src/lib/gemini.js');
    vi.mocked(generateJson).mockClear();
    const dir = mkdtempSync(join(tmpdir(), 'pdf2video-size-'));
    await expect(
      program.parseAsync(['test/fixtures/sample.pdf', '--yes', '--no-review', '--size', '1281x720', '--work-dir', dir], { from: 'user' }),
    ).rejects.toThrow(/--size/);
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('bad --size: exit 1, clean message, no stack', () => {
    const r = run(['test/fixtures/sample.pdf', '--yes', '--size', '1281x720']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--size');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('review pause: EOF rejects with "Review cancelled" and exit code 1', async () => {
    const input = new PassThrough();
    const rl = createInterface({ input, output: new PassThrough() });
    const pending = askOrCancel(rl, 'go? ');
    input.end();
    await expect(pending).rejects.toMatchObject({ message: expect.stringContaining('Review cancelled'), exitCode: 1 });
  });

  it('review pause: Ctrl+C rejects with exit code 130', async () => {
    const input = new PassThrough();
    const rl = createInterface({ input, output: new PassThrough() });
    const pending = askOrCancel(rl, 'go? ');
    rl.emit('SIGINT');
    await expect(pending).rejects.toMatchObject({ message: expect.stringContaining('Review cancelled'), exitCode: 130 });
    rl.close();
  });

  it('review pause: Enter resolves', async () => {
    const input = new PassThrough();
    const rl = createInterface({ input, output: new PassThrough() });
    const pending = askOrCancel(rl, 'go? ');
    input.write('\n');
    await expect(pending).resolves.toBeUndefined();
    rl.close();
  });
});

describe('cli end to end (Gemini mocked)', () => {
  it('default command makes an MP4 whose length matches the narration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdf2video-e2e-'));
    const out = join(dir, 'out.mp4');
    await program.parseAsync(
      ['test/fixtures/sample.pdf', '--no-review', '--yes', '--size', '320x180', '--work-dir', join(dir, 'work'), '-o', out],
      { from: 'user' },
    );
    expect(existsSync(out)).toBe(true);
    // 2 scenes x (1.0 s speech + 0.4 s tail); -shortest trims to the narration track.
    expect(await mediaDuration(out)).toBeCloseTo(2.8, 0);
  }, 30_000);
});
