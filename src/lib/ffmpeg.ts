/**
 * Thin wrapper around the ffmpeg binary shipped by `ffmpeg-static` (plan D7).
 * Always spawns with an argument array, never through a shell (plan "Rendering notes").
 * ffmpeg-static has no ffprobe, so durations are read from `ffmpeg -i` output.
 * Dependents: src/pipeline/render.ts.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import type { Writable } from 'node:stream';

// Loaded via require: the package's typings don't resolve its default export under this tsconfig.
const ffmpegPath = createRequire(import.meta.url)('ffmpeg-static') as string | null;

export class FfmpegError extends Error {}

const binary = (): string => {
  if (!ffmpegPath) throw new FfmpegError('ffmpeg-static has no ffmpeg binary for this platform.');
  return ffmpegPath;
};

interface Result {
  code: number | null;
  stderr: string;
}

/** Writes chunks to ffmpeg's stdin with backpressure, then closes it. EPIPE (ffmpeg died) is left to the exit code. */
const feed = async (stdin: Writable, chunks: AsyncIterable<Uint8Array>): Promise<void> => {
  stdin.on('error', () => {});
  for await (const chunk of chunks) {
    if (!stdin.write(chunk)) await once(stdin, 'drain').catch(() => {});
  }
  stdin.end();
};

const run = (args: string[], cwd?: string, frames?: AsyncIterable<Uint8Array>): Promise<Result> =>
  new Promise((resolve, reject) => {
    const child = spawn(binary(), args, { cwd, windowsHide: true, stdio: [frames ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    if (frames) void feed(child.stdin!, frames).catch(reject);
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => {
      // Keep only the tail; ffmpeg can be chatty and we only report the last lines.
      stderr = (stderr + d.toString()).slice(-16_000);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });

/** Runs ffmpeg quietly with overwrite; `stdin` streams raw frames to `-i -`. Throws FfmpegError with the last ~20 stderr lines on failure. */
export const runFfmpeg = async (args: string[], opts: { cwd?: string; loglevel?: string; stdin?: AsyncIterable<Uint8Array> } = {}): Promise<string> => {
  const { code, stderr } = await run(['-hide_banner', '-loglevel', opts.loglevel ?? 'error', '-y', ...args], opts.cwd, opts.stdin);
  if (code === 0) return stderr;
  const tail = stderr.trim().split(/\r?\n/).slice(-20).join('\n');
  throw new FfmpegError(`ffmpeg failed (exit ${code}):\n${tail}`);
};

/** Duration in seconds, parsed from the "Duration:" line of `ffmpeg -i` (which exits 1 by design). */
export const mediaDuration = async (path: string): Promise<number> => {
  const { stderr } = await run(['-hide_banner', '-i', path]);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) throw new FfmpegError(`Could not read the duration of ${path}.`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
};
