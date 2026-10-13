/**
 * Slides → one chunk per slide, read by a vision model (v4 §N1.2). This is the load-bearing
 * multimodal step: a diagram has no text to retrieve until the vision model writes it down.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { kbComplete } from "../../agent/llm/kb.js";
import { IngestError, validateChunks, type RawChunk } from "./types.js";

const run = promisify(execFile);

export const SlideAnalysisSchema = z.object({
  title: z.string(),
  bullet_text: z.string(),
  visual_description: z.string(),
  has_diagram: z.boolean(),
  low_information: z.boolean(),
});
export type SlideAnalysis = z.infer<typeof SlideAnalysisSchema>;

/** `pdftoppm -png -r 110` → slide-001.png … ; returns absolute paths in slide order. */
export async function renderSlidePngs(pdfPath: string, outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  await run("pdftoppm", ["-png", "-r", "110", pdfPath, path.join(outDir, "slide")]);
  const files = (await readdir(outDir)).filter((f) => /^slide-\d+\.png$/.test(f));
  files.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (files.length === 0) throw new IngestError(`pdftoppm produced no slides for ${pdfPath}`);
  return files.map((f) => path.join(outDir, f));
}

export function slideNumberFromFile(file: string): number {
  const m = /slide-(\d+)\.png$/.exec(file);
  if (!m) throw new IngestError(`cannot read slide number from ${file}`);
  return Number(m[1]);
}

export type SlideDescriber = (pngPath: string) => Promise<SlideAnalysis>;

export const visionDescriber: SlideDescriber = async (pngPath) => {
  const data = await readFile(pngPath);
  const { value } = await kbComplete({
    agent: "slide_vision",
    user: "Describe this slide.",
    schema: SlideAnalysisSchema,
    images: [{ mimeType: "image/png", data }],
    maxTokens: 1500,
    offline: true,
  });
  return value;
};

export type SlideInput = { slide: number; analysis: SlideAnalysis; assetPath: string };

/** Pure: analyses → chunks. An empty slide is an error unless allowEmpty, in which case it is kept low-information. */
export function buildSlideChunks(inputs: SlideInput[], opts: { allowEmpty?: boolean } = {}): RawChunk[] {
  const chunks: RawChunk[] = [];
  for (const { slide, analysis, assetPath } of inputs) {
    const title = analysis.title.trim();
    const bullets = analysis.bullet_text.trim();
    const visual = analysis.visual_description.trim();
    const empty = !title && !bullets && !visual;
    if (empty && !opts.allowEmpty) throw new IngestError(`slide ${slide}: vision model returned no title, text or description`);
    chunks.push({
      seq: chunks.length,
      modality: "slide_vision",
      locator: { slide },
      heading: title || null,
      text: [title, bullets].filter(Boolean).join("\n") || (empty ? `(blank slide ${slide})` : ""),
      visualDescription: visual || null,
      assetPath,
      lowInformation: empty || analysis.low_information,
    });
  }
  validateChunks(chunks);
  return chunks;
}

export async function ingestSlidePdf(opts: {
  pdfPath: string;
  assetDir: string;
  /** path stored in the DB, relative to backend/kb-assets */
  assetPrefix: string;
  describe?: SlideDescriber;
  allowEmpty?: boolean;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<RawChunk[]> {
  const pngs = await renderSlidePngs(opts.pdfPath, opts.assetDir);
  const describe = opts.describe ?? visionDescriber;
  const concurrency = opts.concurrency ?? 3;
  const results: SlideInput[] = new Array(pngs.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pngs.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= pngs.length) return;
        const analysis = await describe(pngs[i]);
        results[i] = { slide: slideNumberFromFile(pngs[i]), analysis, assetPath: `${opts.assetPrefix}/${path.basename(pngs[i])}` };
        opts.onProgress?.(++done, pngs.length);
      }
    }),
  );
  return buildSlideChunks(results, { allowEmpty: opts.allowEmpty });
}
