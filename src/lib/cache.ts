/**
 * Content-hash cache helpers. Files are named by a hash of their inputs (never by scene
 * number), so inserting or reordering scenes reuses audio/clips correctly (plan D15).
 * Also guards scenes.json: a file the user edited is never overwritten.
 * Dependents: src/pipeline/*.ts, src/cli.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
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

/** sha256 hex of a file's bytes. */
export const fileHash = async (path: string): Promise<string> =>
  createHash('sha256').update(await readFile(path)).digest('hex');

/** `<name>.tmp-<pid>-<rand><ext>`: keeps the real extension so ffmpeg still picks the right muxer. */
const tempPathFor = (path: string): string => {
  const ext = extname(path);
  return `${path.slice(0, path.length - ext.length)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}${ext}`;
};

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Thrown when the finished temp file could not be moved into place; the temp is kept. */
export class ReplaceError extends Error {}

/**
 * rename() that retries with a growing pause (10, 20, 40 ... ms, ~2 s total, like graceful-fs).
 * On Windows, antivirus scans or a player holding the destination open make rename fail briefly
 * with EPERM/EACCES/EBUSY. Other errors, and the last failure, are thrown as-is.
 */
export const renameWithRetry = async (
  from: string,
  to: string,
  renameFn: typeof rename = rename,
  totalMs = 2000,
): Promise<void> => {
  let waited = 0;
  let pause = 10;
  for (;;) {
    try {
      return await renameFn(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!code || !RETRY_CODES.has(code) || waited >= totalMs) throw e;
      const step = Math.min(pause, totalMs - waited);
      await new Promise((r) => setTimeout(r, step));
      waited += step;
      pause *= 2;
    }
  }
};

/**
 * Runs produce(tempPath), then renames onto `path`. A crash or error mid-way never leaves a
 * half-written file at `path` (which `cached` would later trust); the temp is deleted on error.
 * Exception: if only the final rename keeps failing, the finished temp is kept (a render can
 * be minutes of work) and a ReplaceError says where it is.
 */
export const produceAtomic = async (
  path: string,
  produce: (path: string) => Promise<void>,
  renameFn: typeof rename = rename,
  retryMs = 2000,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tempPathFor(path);
  try {
    await produce(tmp);
  } catch (e) {
    await rm(tmp, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    throw e;
  }
  try {
    await renameWithRetry(tmp, path, renameFn, retryMs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code && RETRY_CODES.has(code)) {
      throw new ReplaceError(
        `Could not replace ${path} (is it open in another program?). The finished file was kept at ${tmp}.`,
      );
    }
    await rm(tmp, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    throw e;
  }
};

export const writeFileAtomic = (path: string, data: string | Uint8Array): Promise<void> =>
  produceAtomic(path, (p) => writeFile(p, data));

/**
 * Writes scenes.json plus scenes.meta.json {key, fileHash, prevFileHash} used to detect later edits.
 * Meta goes first and remembers the previous file's hash: a crash before scenes.json lands leaves
 * the old generated file, which still matches prevFileHash and so reads as stale, not user-edited.
 */
export const writeGeneratedScenes = async (dir: string, scenes: Scenes, key: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
  const text = `${JSON.stringify(scenes, null, 2)}\n`;
  let prevFileHash: string | undefined;
  try {
    prevFileHash = JSON.parse(await readFile(join(dir, META_FILE), 'utf8')).fileHash;
  } catch {
    // no earlier meta
  }
  await writeFileAtomic(join(dir, META_FILE), JSON.stringify({ key, fileHash: hashOf(text), prevFileHash }, null, 2));
  await writeFileAtomic(join(dir, SCENES_FILE), text);
  // scenes.json landed, so the old hash no longer needs excusing. Left in, a user who restores the
  // previous generated file would match prevFileHash and be misread as 'stale' (and overwritten).
  await writeFileAtomic(join(dir, META_FILE), JSON.stringify({ key, fileHash: hashOf(text) }, null, 2));
};

/**
 * missing: no scenes.json. user-edited: file differs from what we wrote (or meta is
 * absent/unreadable, so we can't prove it's ours) - never overwrite. stale: untouched
 * but generated from different inputs. fresh: untouched and matches expectedKey.
 */
export const readScenesState = async (dir: string, expectedKey: string): Promise<ScenesState> => {
  const file = join(dir, SCENES_FILE);
  if (!existsSync(file)) return 'missing';
  let meta: { key?: string; fileHash?: string; prevFileHash?: string };
  try {
    meta = JSON.parse(await readFile(join(dir, META_FILE), 'utf8'));
  } catch {
    return 'user-edited';
  }
  const hash = hashOf(await readFile(file, 'utf8'));
  if (hash !== meta.fileHash && hash === meta.prevFileHash) return 'stale'; // interrupted rewrite
  if (hash !== meta.fileHash) return 'user-edited';
  return meta.key === expectedKey ? 'fresh' : 'stale';
};

/**
 * Runs produce only when path doesn't exist yet (or `force`). produce receives a temp path
 * to write to; it is renamed to `path` only on success. Returns true on a cache hit.
 */
export const cached = async (
  path: string,
  produce: (path: string) => Promise<void>,
  force = false,
): Promise<boolean> => {
  if (!force && existsSync(path)) return true;
  await produceAtomic(path, produce);
  return false;
};
