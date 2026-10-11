/**
 * Scene format: the contract between summarize, review, TTS and render stages.
 * Owns the zod schemas, the JSON Schema sent to Gemini, and the runtime check
 * against the real PDF page count (zod alone can't know it).
 * Dependents: src/pipeline/summarize.ts, tts.ts, subtitles.ts, render.ts, src/cli.ts.
 */
import { z } from 'zod';

/** Crop box as fractions (0-1) of the page. Origin is top-left. */
export const Focus = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
  })
  .describe('Optional zoom box as 0-1 fractions of the page, origin top-left');

export const Scene = z.object({
  id: z.number().int().positive(),
  page: z
    .number()
    .int()
    .min(1)
    .describe('1-based position of the page in the file, not the printed page number'),
  focus: Focus.optional(),
  narration: z.string().trim().min(1).describe('Plain sentences read aloud'),
});

export const Scenes = z.object({
  title: z.string().trim().min(1),
  language: z.string().min(2),
  scenes: z.array(Scene).min(1),
});

export type Focus = z.infer<typeof Focus>;
export type Scene = z.infer<typeof Scene>;
export type Scenes = z.infer<typeof Scenes>;

/** JSON Schema for Gemini `responseJsonSchema`. Derived so it can't drift from the zod schema. */
export const scenesJsonSchema = z.toJSONSchema(Scenes, { target: 'draft-7' });

/**
 * Second validation pass using the real page count.
 * Out-of-range page -> clamped; focus running off the page -> dropped. Each is a warning.
 * Pure: returns new objects, input untouched.
 */
export const checkScenesAgainstPdf = (
  scenes: Scenes,
  pageCount: number,
): { scenes: Scenes; warnings: string[] } => {
  const warnings: string[] = [];
  // Tiny tolerance: models emit values like 0.1 + 0.9 that overshoot 1 by float error.
  const EPS = 1e-9;
  const fixed = scenes.scenes.map((scene) => {
    let next: Scene = { ...scene };
    const page = Math.min(Math.max(scene.page, 1), pageCount);
    if (page !== scene.page) {
      warnings.push(`Scene ${scene.id}: page ${scene.page} is outside 1-${pageCount}, using page ${page}`);
      next = { ...next, page };
    }
    const f = scene.focus;
    if (f && (f.x + f.w > 1 + EPS || f.y + f.h > 1 + EPS)) {
      warnings.push(`Scene ${scene.id}: focus box runs past the page edge, showing the whole page`);
      const { focus: _dropped, ...rest } = next;
      next = rest;
    }
    return next;
  });
  return { scenes: { ...scenes, scenes: fixed }, warnings };
};
