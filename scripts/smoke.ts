/**
 * Real-API smoke test: tiny PDF -> structured JSON, then one sentence -> WAV.
 * Run: $env:GOOGLE_AI = [Environment]::GetEnvironmentVariable('GOOGLE_AI','User'); npx tsx scripts/smoke.ts [out.wav]
 * Uses src/lib/gemini.ts. Never prints the key.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_VOICE, summaryModel, ttsModel } from '../src/config.js';
import { generateJson, synthesizeSpeech } from '../src/lib/gemini.js';
import { pcmDurationSeconds, pcmToWav } from '../src/lib/wav.js';

const OUT = process.argv[2] ?? 'smoke.wav';

/** Hand-written one-page PDF with one line of text. xref offsets are computed. */
const tinyPdf = (text: string): Buffer => {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
};

const main = async () => {
  console.log(`models: ${summaryModel()} / ${ttsModel()}, voice ${DEFAULT_VOICE}`);
  const json = await generateJson(
    { bytes: tinyPdf('Penguins live in the Southern Hemisphere.') },
    'Read the attached PDF. Return a short title and one sentence summarizing it.',
    {
      type: 'object',
      properties: { title: { type: 'string' }, sentence: { type: 'string' } },
      required: ['title', 'sentence'],
    },
  );
  console.log('JSON reply:', JSON.stringify(json));

  const { pcm, ...format } = await synthesizeSpeech('Hello from pdf2video. This is a short test.', DEFAULT_VOICE);
  console.log('PCM format:', JSON.stringify(format), `bytes=${pcm.length}`);
  console.log(`duration: ${pcmDurationSeconds(pcm, format).toFixed(2)}s`);
  mkdirSync(dirname(OUT) || '.', { recursive: true });
  writeFileSync(OUT, pcmToWav(pcm, format));
  console.log('wrote', OUT);
};

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
