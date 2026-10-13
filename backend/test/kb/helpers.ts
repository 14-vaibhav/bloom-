import { createHash } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { questions, sourceChunks, sources, tutorSessions, tutorTurns } from "../../src/db/schema.js";
import { embeddingInput, storeSource, vectorLiteral } from "../../src/kb/ingest/store.js";
import type { RawChunk } from "../../src/kb/ingest/types.js";
import { normalizeText } from "../../src/kb/ingest/types.js";
import { sql } from "drizzle-orm";

export const TEST_PREFIX = "tst_";
export const DIM = 1536;

/** Deterministic bag-of-words embedding: shared words → shared dimensions, so cosine similarity is meaningful offline. */
export function fakeEmbed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const w of normalizeText(text).split(" ").filter(Boolean)) {
    const h = createHash("md5").update(w).digest();
    v[h.readUInt16BE(0) % DIM] += 1;
    v[h.readUInt16BE(2) % DIM] += 0.5;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
export const fakeEmbedQuery = async (q: string) => fakeEmbed(q);

const chunk = (seq: number, modality: RawChunk["modality"], locator: RawChunk["locator"], text: string, extra: Partial<RawChunk> = {}): RawChunk => ({
  seq, modality, locator, heading: null, text, visualDescription: null, assetPath: null, lowInformation: false, ...extra,
});

export const VIDEO = `${TEST_PREFIX}vid`;
export const SLIDES = `${TEST_PREFIX}sld`;
export const BOOK = `${TEST_PREFIX}txt`;

export async function seedFakeKb(): Promise<void> {
  await cleanFakeKb();
  const defs = [
    { meta: { id: VIDEO, subjectId: "dsa", kind: "video" as const, title: "Lecture 5", url: "https://www.youtube.com/watch?v=abcdefghijk", license: "CC BY-NC-SA", durationSec: 3000 },
      chunks: [
        chunk(0, "transcript", { t_start: 860, t_end: 935 }, "A singly linked list stores each element in a node and every node holds a pointer to the next node, so inserting at the head takes constant time."),
        chunk(1, "transcript", { t_start: 935, t_end: 1010 }, "To reverse a linked list we walk the list while flipping each next pointer so it points to the previous node."),
        chunk(2, "transcript", { t_start: 1010, t_end: 1090 }, "A stack is last in first out and supports push and pop at the same end."),
      ] },
    { meta: { id: SLIDES, subjectId: "dsa", kind: "slides" as const, title: "Slides wk5", url: null, unitCount: 40 },
      chunks: [
        chunk(0, "slide_vision", { slide: 11 }, "Linked list\nnodes and next pointers", { heading: "Linked list", visualDescription: "Four boxes joined by arrows; each box holds a value and an arrow to the next box; the last arrow points to NULL.", assetPath: `${SLIDES}/slide-011.png` }),
        chunk(1, "slide_vision", { slide: 12 }, "", { visualDescription: "A diagram of a stack drawn as a vertical pile: push adds a plate on top and pop removes the top plate.", assetPath: `${SLIDES}/slide-012.png` }),
        chunk(2, "slide_vision", { slide: 1 }, "Week 5 Data Structures", { heading: "Week 5", lowInformation: true }),
      ] },
    { meta: { id: BOOK, subjectId: "dsa", kind: "textbook" as const, title: "ODS", url: "https://example.org/ods.pdf", license: "CC BY", unitCount: 300 },
      chunks: [
        chunk(0, "page_text", { page: 44, section: "3.1 Singly linked lists" }, "A singly linked list is a sequence of nodes where each node stores a value and a reference to the next node in the sequence.", { heading: "3.1 Singly linked lists" }),
        chunk(1, "page_text", { page: 45, section: "3.2 Stacks" }, "A stack supports push and pop operations on one end following last in first out order.", { heading: "3.2 Stacks" }),
      ] },
  ];
  for (const d of defs) {
    await storeSource(d.meta, d.chunks);
    const rows = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, d.meta.id));
    for (const r of rows) {
      await db.execute(sql`update source_chunks set embedding = ${vectorLiteral(fakeEmbed(embeddingInput(r)))}::vector where id = ${r.id}`);
    }
  }
  await db.update(sourceChunks).set({ subtopicIds: ["ll_singly"] }).where(sql`${sourceChunks.id} in (${VIDEO + ":0"}, ${SLIDES + ":0"}, ${BOOK + ":0"})`);
  await db.update(sourceChunks).set({ subtopicIds: ["sq_stack_ops"] }).where(sql`${sourceChunks.id} in (${VIDEO + ":2"}, ${SLIDES + ":1"}, ${BOOK + ":1"})`);
}

export async function cleanFakeKb(): Promise<void> {
  await db.delete(questions).where(like(questions.id, `${TEST_PREFIX}%`));
  await db.update(questions).set({ sourceChunkId: null }).where(like(questions.sourceChunkId, `${TEST_PREFIX}%`));
  await db.delete(sources).where(like(sources.id, `${TEST_PREFIX}%`));
}

export async function cleanTutorRows(studentId: string): Promise<void> {
  await db.delete(tutorTurns).where(eq(tutorTurns.studentId, studentId));
  await db.delete(tutorSessions).where(eq(tutorSessions.studentId, studentId));
}
