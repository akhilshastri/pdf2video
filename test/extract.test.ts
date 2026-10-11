import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { extractPages } from '../src/pipeline/extract.js';
import { PdfError } from '../src/pipeline/pdfinfo.js';

const work = mkdtempSync(join(tmpdir(), 'p2v-extract-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const sample = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'sample.pdf')));

const size = async (path: string) => {
  const img = await loadImage(path);
  return { w: img.width, h: img.height };
};

/** Counts pixels that are not (near) white. */
const nonWhite = async (path: string): Promise<number> => {
  const img = await loadImage(path);
  const ctx = createCanvas(img.width, img.height).getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i]! < 250 || d[i + 1]! < 250 || d[i + 2]! < 250) n++;
  return n;
};

const blankPdf = async (pages: Array<[number, number]>): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  for (const [w, h] of pages) doc.addPage([w, h]);
  return doc.save();
};

describe('extractPages', () => {
  it('renders every sample page at the target height with visible text', async () => {
    const out = await extractPages({ pdfBytes: sample, pdfHash: 'sample', workDir: join(work, 'a') });
    expect([...out.keys()]).toEqual([1, 2, 3, 4]);
    for (const path of out.values()) {
      expect((await size(path)).h).toBe(2160);
      expect(await nonWhite(path)).toBeGreaterThan(1000);
    }
  });

  it('renders only the requested pages', async () => {
    const out = await extractPages({ pdfBytes: sample, pdfHash: 'sample', workDir: join(work, 'b'), pages: [2] });
    expect([...out.keys()]).toEqual([2]);
    expect(readdirSync(join(out.get(2)!, '..'))).toEqual(['002.png']);
  });

  it('reuses existing files unless forced', async () => {
    const opts = { pdfBytes: sample, pdfHash: 'sample', workDir: join(work, 'c'), pages: [1] };
    const path = (await extractPages(opts)).get(1)!;
    const first = statSync(path).mtimeMs;
    await new Promise((r) => setTimeout(r, 50));
    await extractPages(opts);
    expect(statSync(path).mtimeMs).toBe(first);
    await extractPages({ ...opts, force: true });
    expect(statSync(path).mtimeMs).toBeGreaterThan(first);
  });

  it('gives different directories for different target heights', async () => {
    const base = { pdfBytes: sample, pdfHash: 'sample', workDir: join(work, 'd'), pages: [1] };
    const a = (await extractPages(base)).get(1)!;
    const b = (await extractPages({ ...base, targetHeight: 540 })).get(1)!;
    expect(a).not.toBe(b);
    expect((await size(b)).h).toBe(540);
  });

  it('renders a generated 10-page PDF as 10 PNGs', async () => {
    const bytes = await blankPdf(Array.from({ length: 10 }, () => [612, 792] as [number, number]));
    const out = await extractPages({ pdfBytes: bytes, pdfHash: 'ten', workDir: join(work, 'e'), targetHeight: 540 });
    expect(out.size).toBe(10);
    expect(readdirSync(join(out.get(1)!, '..')).length).toBe(10);
  });

  it('keeps a landscape page landscape and caps the long side', async () => {
    const bytes = await blankPdf([[792, 612], [3000, 100]]);
    const out = await extractPages({ pdfBytes: bytes, pdfHash: 'land', workDir: join(work, 'f') });
    const land = await size(out.get(1)!);
    expect(land.w).toBeGreaterThan(land.h);
    const wide = await size(out.get(2)!);
    expect(Math.max(wide.w, wide.h)).toBeLessThanOrEqual(4096);
  });

  it('rejects a page outside the document', async () => {
    await expect(
      extractPages({ pdfBytes: sample, pdfHash: 'sample', workDir: join(work, 'g'), pages: [9] }),
    ).rejects.toThrow(PdfError);
  });

  // No cheap way to build an encrypted PDF (pdf-lib cannot encrypt), so mock pdfjs's reply.
  it('maps a password error to a clean PdfError', async () => {
    vi.resetModules();
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      getDocument: () => ({
        promise: Promise.reject(Object.assign(new Error('No password given'), { name: 'PasswordException' })),
        destroy: async () => {},
      }),
    }));
    const mod = await import('../src/pipeline/extract.js');
    const { PdfError: MockedPdfError } = await import('../src/pipeline/pdfinfo.js');
    const err = await mod
      .extractPages({ pdfBytes: sample, pdfHash: 's', workDir: join(work, 'h') })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MockedPdfError);
    expect((err as Error).message).toMatch(/password-protected/);
    vi.doUnmock('pdfjs-dist/legacy/build/pdf.mjs');
  });
});
