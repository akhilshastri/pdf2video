/**
 * Stage 1b: rasterise PDF pages to PNG files (plan D13: pdfjs-dist + @napi-rs/canvas).
 * Only the requested pages are rendered; files live at <workDir>/pages/<settingsHash>/NNN.png,
 * where the hash covers the PDF and the raster settings, so a changed setting never reuses
 * stale PNGs (plan D15). Existing files are skipped unless `force`.
 * Dependents: src/pipeline/render.ts (via src/cli.ts). Uses PdfError from ./pdfinfo.ts.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { hashOf } from '../lib/cache.js';
import { PdfError } from './pdfinfo.js';

/** Bump when the rasterising code changes in a way that alters the pixels. */
export const RASTER_VERSION = 1;

/** Longest allowed side in pixels; keeps very long/odd pages from exhausting memory. */
const MAX_SIDE = 4096;

export interface ExtractOptions {
  pdfBytes: Uint8Array;
  pdfHash: string;
  workDir: string;
  /** 1-based page numbers; default = all pages. */
  pages?: number[];
  /** Rendered page height in px (2x 1080p leaves headroom for zoom). */
  targetHeight?: number;
  force?: boolean;
}

/** pdfjs needs these folders (with a trailing slash) to draw text PDFs in Node. */
const assetUrl = (folder: string): string => {
  const pkgJson = createRequire(import.meta.url).resolve('pdfjs-dist/package.json');
  return `${pathToFileURL(join(dirname(pkgJson), folder)).href}/`;
};

export const pagesDir = (workDir: string, pdfHash: string, targetHeight = 2160): string =>
  join(workDir, 'pages', hashOf(pdfHash, targetHeight, RASTER_VERSION).slice(0, 16));

/** Returns page number -> PNG path for every requested page. */
export const extractPages = async (opts: ExtractOptions): Promise<Map<number, string>> => {
  const { pdfBytes, pdfHash, workDir, targetHeight = 2160, force = false } = opts;
  const dir = pagesDir(workDir, pdfHash, targetHeight);
  const out = new Map<number, string>();

  // pdfjs takes ownership of the buffer it is given, so hand it a copy.
  const task = getDocument({
    data: new Uint8Array(pdfBytes),
    verbosity: 0,
    standardFontDataUrl: assetUrl('standard_fonts'),
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    iccUrl: assetUrl('iccs'),
    wasmUrl: assetUrl('wasm'),
  });
  try {
    const doc = await task.promise;
    const pages = opts.pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
    await mkdir(dir, { recursive: true });
    for (const n of pages) {
      if (!Number.isInteger(n) || n < 1 || n > doc.numPages) {
        throw new PdfError(`Page ${n} does not exist (the PDF has ${doc.numPages} pages).`);
      }
      const file = join(dir, `${String(n).padStart(3, '0')}.png`);
      out.set(n, file);
      if (!force && existsSync(file)) continue;
      await writeFile(file, await renderPage(doc, n, targetHeight));
    }
    return out;
  } catch (e) {
    if (e instanceof PdfError) throw e;
    if ((e as Error).name === 'PasswordException') {
      throw new PdfError('The PDF is password-protected. Remove the password and try again.');
    }
    throw new PdfError(`Could not render the PDF (${(e as Error).message}). The file may be damaged.`);
  } finally {
    await task.destroy();
  }
};

type Doc = Awaited<ReturnType<typeof getDocument>['promise']>;

const renderPage = async (doc: Doc, pageNumber: number, targetHeight: number): Promise<Buffer> => {
  const page = await doc.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(targetHeight / base.height, MAX_SIDE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    // PDFs with transparency would otherwise come out black in the PNG.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // The cast: pdfjs types expect a DOM canvas; the napi canvas is API-compatible.
    await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    page.cleanup();
  }
};
