/**
 * Content-hash cache helpers. Files are named by a hash of their inputs (never by scene
 * number), so inserting or reordering scenes reuses audio/clips correctly (plan D15).
 * Also guards scenes.json: a file the user edited is never overwritten.
 * Dependents: src/pipeline/*.ts, src/cli.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Focus, Scenes } from '../schema.js';

/** JSON with object keys sorted, so key order never changes a hash. */
const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const body = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** sha256 hex of the parts. Parts are framed as an array, so ('a','bc') != ('ab','c'). */
export const hashOf = (...parts: unknown[]): string =>
  createHash('sha256').update(stableStringify(parts)).digest('hex');

export const audioKey = (p: { narration: string; voice: string; ttsModel: string; lang: string }): string =>
  hashOf('audio', p);

export const clipKey = (p: {
  audioKey: string;
  page: number;
  focus?: Focus;
  size: string;
  renderVersion: number | string;
}): string => hashOf('clip', p);

export const scenesKey = (p: {
  pdfHash: string;
  model: string;
  length: number;
  lang: string;
  promptVersion: number | string;
}): string => hashOf('scenes', p);

export const workDirFor = (pdfHash: string, root = '.pdf2video'): string => join(root, pdfHash);

const SCENES_FILE = 'scenes.json';
const META_FILE = 'scenes.meta.json';

export type ScenesState = 'missing' | 'fresh' | 'stale' | 'user-edited';

/** Writes scenes.json plus scenes.meta.json {key, fileHash} used to detect later edits. */
export const writeGeneratedScenes = async (dir: string, scenes: Scenes, key: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
  const text = `${JSON.stringify(scenes, null, 2)}\n`;
  await writeFile(join(dir, SCENES_FILE), text);
  await writeFile(join(dir, META_FILE), JSON.stringify({ key, fileHash: hashOf(text) }, null, 2));
};

/**
 * missing: no scenes.json. user-edited: file differs from what we wrote (or meta is
 * absent/unreadable, so we can't prove it's ours) - never overwrite. stale: untouched
 * but generated from different inputs. fresh: untouched and matches expectedKey.
 */
export const readScenesState = async (dir: string, expectedKey: string): Promise<ScenesState> => {
  const file = join(dir, SCENES_FILE);
  if (!existsSync(file)) return 'missing';
  let meta: { key?: string; fileHash?: string };
  try {
    meta = JSON.parse(await readFile(join(dir, META_FILE), 'utf8'));
  } catch {
    return 'user-edited';
  }
  if (hashOf(await readFile(file, 'utf8')) !== meta.fileHash) return 'user-edited';
  return meta.key === expectedKey ? 'fresh' : 'stale';
};

/** Runs produce(path) only when path doesn't exist yet. Returns true on a cache hit. */
export const cached = async (path: string, produce: (path: string) => Promise<void>): Promise<boolean> => {
  if (existsSync(path)) return true;
  await mkdir(dirname(path), { recursive: true });
  await produce(path);
  return false;
};
