/**
 * Command-line entry: `pdf2video plan|voice|render <pdf>` and the default `pdf2video <pdf>`
 * (plan -> review pause -> voice -> render). Owns option parsing, the first-run privacy notice,
 * the review pause and top-level error printing. The stages themselves live in src/pipeline/*.
 * The work dir is always kept: it is the cache that makes re-runs free (no --keep option).
 * Exports `program` so test/cli.test.ts can run it in-process; it only self-runs outside vitest.
 * Never prints the API key or PDF text; stack traces only with PDF2VIDEO_DEBUG=1.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_LENGTH_SECONDS,
  DEFAULT_SIZE,
  DEFAULT_VOICE,
  summaryModel,
  ttsModel as defaultTtsModel,
} from './config.js';

import { readScenesState, scenesKey, workDirFor, writeGeneratedScenes } from './lib/cache.js';
import { readPdf } from './pipeline/pdfinfo.js';
import { renderVideo } from './pipeline/render.js';
import { PROMPT_VERSION, summarize } from './pipeline/summarize.js';
import { type JoinedNarration, joinNarration, synthesizeScenes } from './pipeline/tts.js';
import { Scenes, checkScenesAgainstPdf } from './schema.js';

interface Options {
  voice: string;
  lang: string;
  length: string;
  model?: string;
  ttsModel?: string;
  force?: boolean;
  yes?: boolean;
  review: boolean;
  workDir: string;
  out?: string;
  size: string;
}

/** Error whose message is shown as-is (bad input, missing scenes.json). */
class UserError extends Error {}

/** The user ended the review pause (Ctrl+C or closed stdin). Carries the process exit code. */
class CancelledError extends UserError {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

const NOTICE = 'Note: the PDF is sent to Google Gemini for summarising and speech.';

/** One line to stderr before the first API call, unless --yes or the marker file exists. */
const showNoticeOnce = async (o: Options): Promise<void> => {
  if (o.yes) return;
  const marker = join(o.workDir, '.notice-shown');
  if (existsSync(marker)) return;
  process.stderr.write(`${NOTICE}\n`);
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, '');
};

const lengthOf = (o: Options): number => {
  const n = Number(o.length);
  if (!Number.isFinite(n) || n <= 0) throw new UserError(`--length must be a positive number of seconds, got "${o.length}".`);
  return n;
};

type Size = { width: number; height: number };

/** "1280x720" -> {1280, 720}. Both numbers must be positive and even (yuv420p needs even sizes). */
export const parseSize = (text: string): Size => {
  const m = /^(\d+)x(\d+)$/i.exec(text.trim());
  const width = Number(m?.[1]);
  const height = Number(m?.[2]);
  if (!m || width <= 0 || height <= 0 || width % 2 || height % 2) {
    throw new UserError(`--size must look like 1280x720 with even numbers, got "${text}".`);
  }
  return { width, height };
};

interface Context {
  workDir: string;
  scenesPath: string;
  pageCount: number;
  key: string;
  pdf: Awaited<ReturnType<typeof readPdf>>;
}

const openPdf = async (file: string, o: Options): Promise<Context> => {
  const pdf = await readPdf(file);
  const workDir = resolve(workDirFor(pdf.hash, o.workDir));
  const key = scenesKey({
    pdfHash: pdf.hash,
    model: o.model ?? summaryModel(),
    length: lengthOf(o),
    lang: o.lang,
    promptVersion: PROMPT_VERSION,
  });
  return { workDir, scenesPath: join(workDir, 'scenes.json'), pageCount: pdf.pageCount, key, pdf };
};

const plan = async (file: string, o: Options): Promise<Context> => {
  const ctx = await openPdf(file, o);
  const state = await readScenesState(ctx.workDir, ctx.key);
  if (state === 'fresh') {
    console.log(`scenes.json is up to date: ${ctx.scenesPath}`);
  } else if (state === 'user-edited' && !o.force) {
    console.warn(`scenes.json has your edits, keeping it (use --force to regenerate): ${ctx.scenesPath}`);
  } else {
    await showNoticeOnce(o);
    console.log(`Summarising ${ctx.pageCount} page(s)...`);
    const { scenes, warnings } = await summarize({
      pdfBytes: ctx.pdf.bytes,
      pageCount: ctx.pageCount,
      lengthSeconds: lengthOf(o),
      lang: o.lang,
      model: o.model,
    });
    await writeGeneratedScenes(ctx.workDir, scenes, ctx.key);
    for (const w of warnings) console.warn(`Warning: ${w}`);
    console.log(`Wrote ${scenes.scenes.length} scene(s): ${ctx.scenesPath}`);
  }
  return ctx;
};

/** Reads and validates scenes.json. Throws UserError with a readable message. */
const loadScenes = async (ctx: Context): Promise<{ scenes: Scenes; warnings: string[] }> => {
  let text: string;
  try {
    text = await readFile(ctx.scenesPath, 'utf8');
  } catch {
    throw new UserError(`No scenes.json at ${ctx.scenesPath}. Run "pdf2video plan <pdf>" first.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new UserError(`scenes.json is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = Scenes.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
    throw new UserError(`scenes.json is invalid: ${issues.join('; ')}`);
  }
  return checkScenesAgainstPdf(parsed.data, ctx.pageCount);
};

/**
 * Asks one question. Resolves with the answer, or rejects with CancelledError on Ctrl+C (exit 130)
 * or when stdin closes (EOF, exit 1). Needed because a pending rl.question() never settles when
 * the input ends; the process would just run out of work and exit 0 without rendering.
 */
export const askOrCancel = (rl: ReturnType<typeof createInterface>, prompt: string): Promise<void> =>
  new Promise<void>((resolveAsk, reject) => {
    const eof = new CancelledError('Review cancelled (input closed before Enter).', 1);
    const sigint = new CancelledError('Review cancelled (Ctrl+C).', 130);
    // Named handlers so they can be removed: reviewPause calls this in a loop on one rl.
    const cleanup = () => {
      rl.off('close', onClose);
      rl.off('SIGINT', onSigint);
    };
    const fail = (e: CancelledError) => (cleanup(), reject(e));
    const onClose = () => fail(eof);
    const onSigint = () => fail(sigint);
    rl.once('close', onClose);
    rl.once('SIGINT', onSigint);
    rl.question(prompt).then(
      () => (cleanup(), resolveAsk()),
      () => fail(eof),
    );
  });

/** Waits for Enter; repeats while scenes.json is invalid. */
const reviewPause = async (ctx: Context): Promise<void> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      await askOrCancel(rl, `Review or edit ${ctx.scenesPath}, then press Enter to continue... `);
      try {
        await loadScenes(ctx);
        return;
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        console.error(e.message);
      }
    }
  } finally {
    rl.close();
  }
};

const voice = async (ctx: Context, o: Options): Promise<JoinedNarration> => {
  const { scenes, warnings } = await loadScenes(ctx);
  for (const w of warnings) console.warn(`Warning: ${w}`);
  await showNoticeOnce(o);
  const audios = await synthesizeScenes({
    scenes: scenes.scenes,
    workDir: ctx.workDir,
    voice: o.voice,
    ttsModel: o.ttsModel ?? defaultTtsModel(),
    lang: o.lang,
    force: o.force,
    onProgress: ({ index, total, cached }) =>
      console.log(`Speech ${index}/${total}${cached ? ' (cached)' : ''}`),
  });
  const out = join(ctx.workDir, 'narration.wav');
  const joined = await joinNarration(audios, out);
  await writeFile(join(ctx.workDir, 'timings.json'), `${JSON.stringify(joined, null, 2)}\n`);
  console.log(`Narration: ${out} (${joined.totalSeconds.toFixed(1)} s)`);
  return joined;
};

/** Voice (cached) + video. Needs scenes.json; writes the MP4 and prints its path, length and subtitle mode. */
const render = async (ctx: Context, file: string, o: Options, size: Size): Promise<void> => {
  const narration = await voice(ctx, o);
  const { scenes } = await loadScenes(ctx);
  const outPath = resolve(o.out ?? `${basename(file).replace(/\.pdf$/i, '')}.mp4`);
  const result = await renderVideo({
    scenes,
    timings: narration.timings,
    narrationPath: narration.path,
    pdfBytes: ctx.pdf.bytes,
    pdfHash: ctx.pdf.hash,
    workDir: ctx.workDir,
    outPath,
    size,
    force: o.force,
    onProgress: (msg) => console.log(msg),
  });
  const how = result.subtitles === 'burned' ? 'subtitles burned in' : 'soft subtitles (.srt next to the video)';
  console.log(`Video: ${result.outPath} (${result.durationSeconds.toFixed(1)} s, ${how})`);
};

const withOptions = (cmd: Command): Command =>
  cmd
    .option('--voice <name>', 'Gemini prebuilt voice', DEFAULT_VOICE)
    .option('--lang <code>', 'narration language', DEFAULT_LANGUAGE)
    .option('--length <seconds>', 'target video length', String(DEFAULT_LENGTH_SECONDS))
    .option('--model <id>', 'Gemini model for summarising')
    .option('--tts-model <id>', 'Gemini model for speech')
    .option('--force', 'ignore cache and regenerate')
    .option('--yes', 'do not show the privacy notice')
    .option('--work-dir <dir>', 'cache folder (always kept; it is the cache)', '.pdf2video');

const withVideoOptions = (cmd: Command): Command =>
  withOptions(cmd)
    .option('-o, --out <file>', 'output video (default: <pdf name>.mp4 in the current folder)')
    .option('--size <WxH>', 'video size, even numbers', DEFAULT_SIZE);

const program = new Command('pdf2video').description('Turn a PDF into a short narrated summary video');

withVideoOptions(program)
  .argument('<pdf>', 'input PDF')
  .option('--no-review', 'do not pause on scenes.json')
  .action(async (file: string, o: Options) => {
    const size = parseSize(o.size); // before any PDF read or API call
    const ctx = await plan(file, o);
    if (o.review && process.stdin.isTTY) await reviewPause(ctx);
    await render(ctx, file, o, size);
  });

withOptions(program.command('plan').description('Summarise the PDF into scenes.json'))
  .argument('<pdf>', 'input PDF')
  .action(async (file: string, _o: Options, cmd: Command) => {
    await plan(file, cmd.optsWithGlobals());
  });

withOptions(program.command('voice').description('Synthesise narration from scenes.json'))
  .argument('<pdf>', 'input PDF')
  .action(async (file: string, _o: Options, cmd: Command) => {
    const o = cmd.optsWithGlobals<Options>();
    await voice(await openPdf(file, o), o);
  });

withVideoOptions(program.command('render').description('Voice (cached) and render the video from scenes.json'))
  .argument('<pdf>', 'input PDF')
  .action(async (file: string, _o: Options, cmd: Command) => {
    const o = cmd.optsWithGlobals<Options>();
    const size = parseSize(o.size); // before any PDF read or API call
    await render(await openPdf(file, o), file, o, size);
  });

/** Known errors print their message only; anything else is a bug, so say so. */
const fail = (e: unknown): never => {
  if (e instanceof CancelledError) {
    console.error(`
${e.message}`);
    process.exit(e.exitCode);
  }
  if (process.env.PDF2VIDEO_DEBUG === '1') console.error(e);
  else if (e instanceof Error) console.error(`Error: ${e.message}`);
  else console.error('Error: unexpected failure (set PDF2VIDEO_DEBUG=1 for details).');
  process.exit(1);
};

export { program };

if (!process.env.VITEST) program.parseAsync().catch(fail);
