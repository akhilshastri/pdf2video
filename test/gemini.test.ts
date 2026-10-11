import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

const { synthesizeSpeech } = await import('../src/lib/gemini.js');
const { API_KEY_ENV } = await import('../src/config.js');

describe('synthesizeSpeech', () => {
  beforeEach(() => {
    generateContent.mockReset();
    process.env[API_KEY_ENV] = 'test-key';
  });

  it('returns empty pcm for a no-audio reply after ONE request (retrying is speakWithChecks job)', async () => {
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    const r = await synthesizeSpeech('hello', 'Kore', 'm');
    expect(r.pcm.length).toBe(0);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('still retries a 503', async () => {
    vi.useFakeTimers();
    try {
      generateContent
        .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))
        .mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(4).toString('base64'), mimeType: 'audio/L16;rate=24000' } }] } }] });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const p = synthesizeSpeech('hello', 'Kore', 'm');
      await vi.runAllTimersAsync();
      expect((await p).pcm.length).toBe(4);
      expect(generateContent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
