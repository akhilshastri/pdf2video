/**
 * Stage 2: PDF -> Scenes via Gemini.
 * Owns the prompt template (prompts/summarize.md) fill-in, the word/scene budgets, zod validation
 * with one repair retry, and the page-count check. Gemini access goes through src/lib/gemini.ts.
 * Dependents: src/cli.ts. Cache key input: PROMPT_VERSION (src/lib/cache.ts scenesKey).
 * Never log PDF text or narration.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateJson } from '../lib/gemini.js';
import { Scenes, checkScenesAgainstPdf, scenesJsonSchema } from '../schema.js';

/** Bump when prompts/summarize.md or the budgets change, so cached scenes.json is regenerated. */
export const PROMPT_VERSION = '1';

/** Inline upload limit: base64 grows the file ~33%, and the request limit is 20 MB. */
const MAX_INLINE_BYTES = 14 * 1024 * 1024;
const WORDS_PER_SECOND = 2.5;
const SECONDS_PER_SCENE = 11; // keeps TTS request count low (free-tier quota)
const OVER_BUDGET_FACTOR = 1.3;

export interface SummarizeOptions {
  pdfBytes: Uint8Array;
  pageCount: number;
  lengthSeconds: number;
  lang: string;
  model?: string;
}

export interface SummarizeResult {
  scenes: Scenes;
  warnings: string[];
}

export const wordBudget = (lengthSeconds: number): number => Math.round(lengthSeconds * WORDS_PER_SECOND);
export const maxScenes = (lengthSeconds: number): number =>
  Math.max(1, Math.round(lengthSeconds / SECONDS_PER_SCENE));

const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** Source layout: src/pipeline/ (../../prompts). Bundled by tsup into dist/: ../prompts. */
const loadTemplate = (): string => {
  for (const rel of ['../../prompts/summarize.md', '../prompts/summarize.md']) {
    try {
      return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    } catch {
      // try the next location
    }
  }
  throw new Error('Could not find prompts/summarize.md next to the program files.');
};

export const buildPrompt = (o: Pick<SummarizeOptions, 'pageCount' | 'lengthSeconds' | 'lang'>): string => {
  const values: Record<string, string> = {
    LANG: o.lang,
    WORD_BUDGET: String(wordBudget(o.lengthSeconds)),
    LENGTH_SECONDS: String(o.lengthSeconds),
    MAX_SCENES: String(maxScenes(o.lengthSeconds)),
    PAGE_COUNT: String(o.pageCount),
  };
  return loadTemplate().replace(/\{\{(\w+)\}\}/g, (m, key: string) => values[key] ?? m);
};

const describeIssues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string =>
  error.issues
    .slice(0, 10)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');

export const summarize = async (opts: SummarizeOptions): Promise<SummarizeResult> => {
  if (opts.pdfBytes.byteLength > MAX_INLINE_BYTES) {
    // TODO: Files API upload (needs support in src/lib/gemini.ts).
    throw new Error('PDF over 14 MB not supported yet.');
  }
  const prompt = buildPrompt(opts);
  const pdf = { bytes: opts.pdfBytes };

  let reply = await generateJson(pdf, prompt, scenesJsonSchema, opts.model);
  let parsed = Scenes.safeParse(reply);
  if (!parsed.success) {
    const problems = describeIssues(parsed.error);
    reply = await generateJson(
      pdf,
      `${prompt}\n\nYour previous reply was rejected. Fix these problems and answer again with the full JSON:\n${problems}`,
      scenesJsonSchema,
      opts.model,
    );
    parsed = Scenes.safeParse(reply);
    if (!parsed.success) {
      throw new Error(`Gemini returned scenes that do not match the expected format, even after a retry: ${describeIssues(parsed.error)}`);
    }
  }

  const { scenes, warnings } = checkScenesAgainstPdf(parsed.data, opts.pageCount);
  const budget = wordBudget(opts.lengthSeconds);
  const words = scenes.scenes.reduce((n, s) => n + countWords(s.narration), 0);
  if (words > budget * OVER_BUDGET_FACTOR) {
    warnings.push(`Narration is ${words} words, over the ~${budget} word budget for ${opts.lengthSeconds}s; the video will run long.`);
  }
  return { scenes, warnings };
};
