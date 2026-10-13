import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../client.js";
import { resources } from "../schema.js";
import { verifyUrlsConcurrently } from "../../lib/verifyUrl.js";

const DATA_DIR = path.resolve(import.meta.dirname, "data");

type ResourceJson = {
  id: string; title: string; provider: string; url: string;
  type: "video" | "article" | "doc" | "course" | "practice";
  difficulty: number; durationMin: number; quality: number;
  topicId: string; subtopicId: string; conceptIds: string[];
  description: string; unreviewed?: boolean;
};

type EmbeddingCache = Record<string, { hash: string; embedding: number[] }>;

async function loadJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf-8"));
  } catch {
    return null;
  }
}

export async function seedResources() {
  const resourcesData = (await loadJson<ResourceJson[]>("resources.json")) ?? [];
  if (resourcesData.length === 0) {
    console.log("  no resources.json found — skipping");
    return;
  }

  console.log(`  verifying ${resourcesData.length} resource URLs live...`);
  const verifications = await verifyUrlsConcurrently(
    resourcesData.map((r) => r.url),
    8,
    5000,
  );

  const dead = verifications.filter((v) => v.status === "dead");
  if (dead.length > 0) {
    throw new Error(
      `Seed aborted: ${dead.length} resource URL(s) are dead:\n` +
        dead.map((d) => `  ${d.url} → ${d.httpStatus}`).join("\n"),
    );
  }
  const unverifiedCount = verifications.filter((v) => v.status === "unverified").length;
  if (unverifiedCount > 0) {
    console.warn(`  ${unverifiedCount} URL(s) timed out / unverifiable — seeding anyway, flagged unverified.`);
  }

  const embeddingCache = (await loadJson<EmbeddingCache>("embeddings.json")) ?? {};

  const rows = resourcesData.map((r, i) => ({
    id: r.id,
    title: r.title,
    provider: r.provider,
    url: r.url,
    type: r.type,
    difficulty: r.difficulty,
    durationMin: r.durationMin,
    quality: String(r.quality),
    topicIds: [r.topicId],
    subtopicIds: [r.subtopicId],
    conceptIds: r.conceptIds.map((c) => `${r.subtopicId}__${c}`),
    description: r.description,
    embedding: embeddingCache[r.id]?.embedding ?? null,
    isLive: verifications[i].status !== "dead",
    lastVerifiedAt: verifications[i].status === "live" ? new Date(verifications[i].checkedAt) : null,
    verificationFailures: 0,
  }));

  for (const row of rows) {
    await db
      .insert(resources)
      .values(row)
      .onConflictDoUpdate({
        target: resources.id,
        set: {
          title: sql`excluded.title`,
          provider: sql`excluded.provider`,
          url: sql`excluded.url`,
          type: sql`excluded.type`,
          difficulty: sql`excluded.difficulty`,
          durationMin: sql`excluded.duration_min`,
          quality: sql`excluded.quality`,
          topicIds: sql`excluded.topic_ids`,
          subtopicIds: sql`excluded.subtopic_ids`,
          conceptIds: sql`excluded.concept_ids`,
          description: sql`excluded.description`,
          embedding: row.embedding ? sql`excluded.embedding` : sql`resources.embedding`,
          isLive: sql`excluded.is_live`,
          lastVerifiedAt: sql`excluded.last_verified_at`,
        },
      });
  }

  const embedded = rows.filter((r) => r.embedding !== null).length;
  console.log(`  resources: ${rows.length} (${embedded} embedded, ${rows.length - embedded} pending embed-resources)`);
}
