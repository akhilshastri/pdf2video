/**
 * Defaults for models, voice and output. Everything here is a default that a CLI flag or
 * environment variable overrides (wired in src/cli.ts). Model ids change often, so they are
 * kept in one place. Confirmed against https://ai.google.dev/gemini-api/docs/models (2026-10-11).
 * Used by: src/lib/gemini.ts, scripts/smoke.ts, later the pipeline modules and src/cli.ts.
 */

export const DEFAULT_SUMMARY_MODEL = 'gemini-3.8-flash';
export const DEFAULT_TTS_MODEL = 'gemini-3.8-flash-tts';
export const DEFAULT_VOICE = 'Kore';

export const DEFAULT_LANGUAGE = 'en';
export const DEFAULT_LENGTH_SECONDS = 90;
export const DEFAULT_SIZE = '1920x1080';

/** Name of the env var holding the Gemini API key. Only src/lib/gemini.ts reads its value. */
export const API_KEY_ENV = 'GOOGLE_AI';

export const summaryModel = (): string => process.env.PDF2VIDEO_MODEL ?? DEFAULT_SUMMARY_MODEL;
export const ttsModel = (): string => process.env.PDF2VIDEO_TTS_MODEL ?? DEFAULT_TTS_MODEL;
