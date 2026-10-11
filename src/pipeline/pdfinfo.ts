/**
 * Stage 1: read the PDF from disk, hash it, count its pages.
 * Page count uses the pdfjs-dist legacy build (plan D13: works on Node without a canvas).
 * Errors are PdfError so src/cli.ts can print them without a stack trace.
 * Dependents: src/cli.ts. The hash feeds src/lib/cache.ts (work dir and cache keys).
 */
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createHash } from 'node:crypto';

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfError';
  }
}

export interface PdfInfo {
  bytes: Uint8Array;
  hash: string;
  pageCount: number;
}

const HEADER = '%PDF-';

export const readPdf = async (path: string): Promise<PdfInfo> => {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new PdfError(`File not found: ${path}`);
    throw new PdfError(`Cannot read ${path}: ${code ?? 'unknown error'}`);
  }
  // The spec allows junk in the first 1024 bytes, so look for the header there.
  if (!Buffer.from(bytes.subarray(0, 1024)).toString('latin1').includes(HEADER)) {
    throw new PdfError(`${path} is not a PDF file.`);
  }
  // pdfjs takes ownership of the buffer it is given, so hand it a copy.
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const doc = await task.promise;
    const pageCount = doc.numPages;
    return { bytes, hash: createHash('sha256').update(bytes).digest('hex').slice(0, 16), pageCount };
  } catch (e) {
    if ((e as Error).name === 'PasswordException') {
      throw new PdfError('The PDF is password-protected. Remove the password and try again.');
    }
    throw new PdfError(`Could not read the PDF (${(e as Error).message}). The file may be damaged.`);
  } finally {
    await task.destroy();
  }
};
