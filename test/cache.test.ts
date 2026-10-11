import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  audioKey,
  cached,
  clipKey,
  hashOf,
  readScenesState,
  scenesKey,
  workDirFor,
  writeGeneratedScenes,
} from '../src/lib/cache.js';
import type { Scenes } from '../src/schema.js';

const scenes: Scenes = { title: 'T', language: 'en', scenes: [{ id: 1, page: 1, narration: 'One.' }] };
const opts = { voice: 'v', ttsModel: 'm', lang: 'en' };

describe('keys', () => {
  it('hashOf ignores object key order and frames parts', () => {
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
    expect(hashOf('a', 'bc')).not.toBe(hashOf('ab', 'c'));
  });
  it('edited narration gives a new audio key', () => {
    const a = audioKey({ narration: 'One.', ...opts });
    expect(audioKey({ narration: 'One!', ...opts })).not.toBe(a);
    expect(audioKey({ narration: 'One.', ...opts })).toBe(a);
  });
  it('inserting a scene keeps the other scenes keys', () => {
    const keysOf = (ns: string[]) => ns.map((narration) => audioKey({ narration, ...opts }));
    const before = keysOf(['A', 'B']);
    const after = keysOf(['A', 'NEW', 'B']);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
  });
  it('clip key changes with focus, page, render version', () => {
    const p = { audioKey: 'k', page: 1, size: '1920x1080', renderVersion: 1 };
    const k = clipKey(p);
    expect(clipKey({ ...p, focus: { x: 0, y: 0, w: 1, h: 1 } })).not.toBe(k);
    expect(clipKey({ ...p, page: 2 })).not.toBe(k);
    expect(clipKey({ ...p, renderVersion: 2 })).not.toBe(k);
    expect(clipKey({ ...p })).toBe(k);
  });
  it('scenesKey and workDirFor', () => {
    const p = { pdfHash: 'h', model: 'm', length: 90, lang: 'en', promptVersion: 1 };
    expect(scenesKey({ ...p, length: 60 })).not.toBe(scenesKey(p));
    expect(workDirFor('abc')).toBe(join('.pdf2video', 'abc'));
  });
});

describe('scenes.json protection', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'p2v-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('missing -> fresh -> stale', async () => {
    expect(await readScenesState(dir, 'k1')).toBe('missing');
    await writeGeneratedScenes(dir, scenes, 'k1');
    expect(await readScenesState(dir, 'k1')).toBe('fresh');
    expect(await readScenesState(dir, 'k2')).toBe('stale');
  });
  it('detects a user edit, even if the key also changed', async () => {
    await writeGeneratedScenes(dir, scenes, 'k1');
    const file = join(dir, 'scenes.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('One.', 'Edited.'));
    expect(await readScenesState(dir, 'k1')).toBe('user-edited');
    expect(await readScenesState(dir, 'k2')).toBe('user-edited');
  });
  it('treats scenes.json without meta as user-edited', async () => {
    await writeFile(join(dir, 'scenes.json'), '{}');
    expect(await readScenesState(dir, 'k')).toBe('user-edited');
  });
});

describe('cached', () => {
  it('produces once, then hits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p2v-'));
    try {
      const path = join(dir, 'sub', 'a.txt');
      const produce = vi.fn(async (p: string) => writeFile(p, 'x'));
      expect(await cached(path, produce)).toBe(false);
      expect(await cached(path, produce)).toBe(true);
      expect(produce).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
