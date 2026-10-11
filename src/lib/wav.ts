/** Wraps raw PCM in a RIFF/WAVE header. Used by scripts/smoke.ts and later src/pipeline/tts.ts. */

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** Duration in seconds, computed from the byte count (no decoding needed). */
export const pcmDurationSeconds = (pcm: Buffer, f: PcmFormat): number =>
  pcm.length / (f.sampleRate * f.channels * (f.bitsPerSample / 8));

/**
 * Extracts format and raw PCM from a RIFF/WAVE buffer, or returns undefined if it is not one.
 * Gemini TTS (gemini-3.8-flash-tts) replies with mimeType audio/wav, i.e. a full WAV file.
 */
export const parseWav = (buf: Buffer): (PcmFormat & { pcm: Buffer }) | undefined => {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let fmt: PcmFormat | undefined;
  for (let pos = 12; pos + 8 <= buf.length; ) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    } else if (id === 'data' && fmt) {
      return { ...fmt, pcm: buf.subarray(body, Math.min(body + size, buf.length)) };
    }
    pos = body + size + (size % 2);
  }
  return undefined;
};

export const pcmToWav = (pcm: Buffer, f: PcmFormat): Buffer => {
  const blockAlign = f.channels * (f.bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(f.channels, 22);
  header.writeUInt32LE(f.sampleRate, 24);
  header.writeUInt32LE(f.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(f.bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};
