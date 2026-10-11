/**
 * Gemini access for the whole project. This is the ONLY file that imports @google/genai.
 * Owns: API key lookup (GOOGLE_AI), JSON-schema structured output, TTS, and retry with
 * exponential backoff + jitter on 429/5xx.
 * Dependents: src/pipeline/summarize.ts, src/pipeline/tts.ts, scripts/smoke.ts.
 * Never log the key or PDF text.
 */
import { GoogleGenAI } from '@google/genai';
import { API_KEY_ENV, summaryModel, ttsModel } from '../config.js';
import { parseWav, type PcmFormat } from './wav.js';

export class MissingApiKeyError extends Error {
  constructor() {
    super(`The ${API_KEY_ENV} environment variable is not set. Set it to your Gemini API key.`);
    this.name = 'MissingApiKeyError';
  }
}

export class GeminiRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GeminiRequestError';
  }
}

/** Daily quota is used up; retrying now is pointless. Callers should tell the user to resume later. */
export class QuotaExhaustedError extends Error {
  constructor(detail: string) {
    super(`Gemini daily quota exhausted. Progress is cached; re-run later to resume. Details: ${detail}`);
    this.name = 'QuotaExhaustedError';
  }
}

/** Thrown inside a retried call when TTS returns no audio; carries a 5xx status so withRetry retries it. */
class NoAudioError extends Error {
  readonly status = 503;
  constructor() {
    super('Gemini returned no audio.');
  }
}

export interface PdfPart {
  bytes: Uint8Array;
}

export interface SpeechResult extends PcmFormat {
  pcm: Buffer;
}

const MAX_TRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;

let client: GoogleGenAI | undefined;

// Lazy so that --help and unit tests work without a key.
const getClient = (): GoogleGenAI => {
  const apiKey = process.env[API_KEY_ENV];
  if (!apiKey) throw new MissingApiKeyError();
  client ??= new GoogleGenAI({ apiKey });
  return client;
};

const errorStatus = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

/** The API sometimes says "Please retry in 12.3s" or "retryDelay":"12s" in the error text. */
const retryDelayFromError = (e: unknown): number | undefined => {
  const text = e instanceof Error ? e.message : String(e);
  const m = /retry(?:Delay"?:\s*"|\s+in\s+)(\d+(?:\.\d+)?)s/i.exec(text);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
};

const isRetryable = (status: number | undefined): boolean =>
  status === 429 || (status !== undefined && status >= 500);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs fn, retrying on 429/5xx. Other errors fail immediately. */
const withRetry = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = errorStatus(e);
      const detail = e instanceof Error ? e.message : String(e);
      // A 429 that names a per-day quota will not clear with backoff.
      if (status === 429 && /PerDay/i.test(detail)) throw new QuotaExhaustedError(detail);
      if (!isRetryable(status)) throw new GeminiRequestError(`${what} failed: ${detail}`, status);
      if (attempt >= MAX_TRIES) {
        throw new GeminiRequestError(
          `${what} failed after ${MAX_TRIES} attempts (HTTP ${status}). Check your quota or try again later. Last error: ${detail}`,
          status,
        );
      }
      const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
      const wait = Math.max(retryDelayFromError(e) ?? 0, backoff * (0.5 + Math.random() * 0.5));
      console.error(`${what}: HTTP ${status}, retrying in ${(wait / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_TRIES})`);
      await sleep(wait);
    }
  }
};

/**
 * Asks Gemini for JSON matching `jsonSchema`, with an optional PDF attached.
 * Returns the parsed (not yet validated) JSON; callers validate with zod.
 */
export const generateJson = async (
  pdf: PdfPart | undefined,
  prompt: string,
  jsonSchema: Record<string, unknown>,
  model: string = summaryModel(),
): Promise<unknown> => {
  const ai = getClient();
  const parts: Array<Record<string, unknown>> = [];
  if (pdf) {
    parts.push({ inlineData: { mimeType: 'application/pdf', data: Buffer.from(pdf.bytes).toString('base64') } });
  }
  parts.push({ text: prompt });
  const res = await withRetry('Summary request', () =>
    ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: { responseMimeType: 'application/json', responseJsonSchema: jsonSchema },
    }),
  );
  const text = res.text;
  if (!text) throw new GeminiRequestError('Gemini returned an empty reply.');
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiRequestError('Gemini returned text that is not valid JSON.');
  }
};

/** "audio/L16;codec=pcm;rate=24000" -> 24000. Falls back to 24 kHz, the documented Gemini TTS rate. */
const rateFromMime = (mime: string | undefined): number => {
  const m = /rate=(\d+)/i.exec(mime ?? '');
  return m ? Number(m[1]) : 24000;
};

/** Speaks `text` with a prebuilt voice. Returns raw 16-bit mono PCM plus its format. */
export const synthesizeSpeech = async (
  text: string,
  voice: string,
  model: string = ttsModel(),
): Promise<SpeechResult> => {
  const ai = getClient();
  const inline = await withRetry('Speech request', async () => {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    });
    const found = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (!found?.data) throw new NoAudioError(); // TTS occasionally returns text/empty; retry
    return { data: found.data, mimeType: found.mimeType };
  });
  if (process.env.PDF2VIDEO_DEBUG) console.error('TTS mimeType:', inline.mimeType);
  const raw = Buffer.from(inline.data, 'base64');
  // Observed: the 3.8 TTS model returns a complete WAV file; older models returned bare L16 PCM.
  const wav = parseWav(raw);
  if (wav) return wav;
  return {
    pcm: raw,
    sampleRate: rateFromMime(inline.mimeType),
    channels: 1,
    bitsPerSample: 16,
  };
};
