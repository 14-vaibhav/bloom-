/**
 * Persistence for ingested sources: idempotent (unchanged content_hash → no-op), deterministic
 * chunk ids `<source_id>:<seq>`, tsv populated in SQL, embeddings filled in a separate pass.
 */
import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { questions, resources, sourceChunks, sources } from "../../db/schema.js";
import { embedText } from "../../lib/embeddingClient.js";
import type { RawChunk, SourceKind } from "./types.js";

export type SourceMeta = {
  id: string;
  subjectId: string;
  kind: SourceKind;
  title: string;
  provider?: string | null;
  url?: string | null;
  license?: string | null;
  durationSec?: number | null;
  unitCount?: number | null;
};

export function hashChunks(chunks: RawChunk[]): string {
  const h = createHash("sha256");
  for (const c of chunks) h.update(JSON.stringify([c.modality, c.locator, c.heading, c.text, c.visualDescription]));
  return h.digest("hex");
}

export function embeddingInput(c: { heading: string | null; text: string; visualDescription: string | null }): string {
  return [c.heading, c.text, c.visualDescription].filter(Boolean).join("\n").slice(0, 8000);
}

export async function storeSource(meta: SourceMeta, chunks: RawChunk[], opts: { force?: boolean } = {}): Promise<{ status: "ingested" | "unchanged"; chunks: number }> {
  const contentHash = hashChunks(chunks);
  const [existing] = await db.select().from(sources).where(eq(sources.id, meta.id));
  if (existing && existing.contentHash === contentHash && !opts.force) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(sourceChunks).where(eq(sourceChunks.sourceId, meta.id));
    if (n === chunks.length) return { status: "unchanged", chunks: n };
  }

  await db.transaction(async (tx) => {
    if (existing) {
      const old = await tx.select({ id: sourceChunks.id }).from(sourceChunks).where(eq(sourceChunks.sourceId, meta.id));
      if (old.length) {
        const ids = old.map((o) => o.id);
        await tx.update(questions).set({ sourceChunkId: null }).where(inArray(questions.sourceChunkId, ids));
      }
      await tx.delete(sourceChunks).where(eq(sourceChunks.sourceId, meta.id));
    }
    const row = {
      id: meta.id, subjectId: meta.subjectId, kind: meta.kind, title: meta.title,
      provider: meta.provider ?? null, url: meta.url ?? null, license: meta.license ?? null,
      durationSec: meta.durationSec ?? null, unitCount: meta.unitCount ?? null,
      contentHash, ingestedAt: new Date(),
    };
    await tx.insert(sources).values(row).onConflictDoUpdate({ target: sources.id, set: row });
    for (let i = 0; i < chunks.length; i += 100) {
      await tx.insert(sourceChunks).values(
        chunks.slice(i, i + 100).map((c) => ({
          id: `${meta.id}:${c.seq}`, sourceId: meta.id, seq: c.seq, modality: c.modality, locator: c.locator,
          heading: c.heading, text: c.text, visualDescription: c.visualDescription, assetPath: c.assetPath,
          lowInformation: c.lowInformation,
        })),
      );
    }
    await tx.execute(sql`
      update source_chunks set tsv = to_tsvector('english',
        coalesce(heading, '') || ' ' || text || ' ' || coalesce(visual_description, ''))
      where source_id = ${meta.id}`);
  });
  return { status: "ingested", chunks: chunks.length };
}

export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** Embeds every chunk of the source that has no embedding yet. Returns how many were embedded. */
export async function embedPendingChunks(sourceId: string, concurrency = 4, onProgress?: (done: number, total: number) => void): Promise<number> {
  const pending = await db
    .select({ id: sourceChunks.id, heading: sourceChunks.heading, text: sourceChunks.text, visualDescription: sourceChunks.visualDescription })
    .from(sourceChunks)
    .where(sql`${sourceChunks.sourceId} = ${sourceId} and ${sourceChunks.embedding} is null`);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= pending.length) return;
        const c = pending[i];
        const v = await embedText(embeddingInput(c));
        await db.execute(sql`update source_chunks set embedding = ${vectorLiteral(v)}::vector where id = ${c.id}`);
        onProgress?.(++done, pending.length);
      }
    }),
  );
  return pending.length;
}

export async function deleteSource(sourceId: string): Promise<void> {
  await db.update(resources).set({ sourceId: null }).where(eq(resources.sourceId, sourceId));
  await db.transaction(async (tx) => {
    const ids = (await tx.select({ id: sourceChunks.id }).from(sourceChunks).where(eq(sourceChunks.sourceId, sourceId))).map((r) => r.id);
    if (ids.length) await tx.update(questions).set({ sourceChunkId: null }).where(inArray(questions.sourceChunkId, ids));
    await tx.delete(sources).where(eq(sources.id, sourceId));
  });
}
