import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { resources } from "../src/db/schema.js";
import { embedText } from "../src/lib/embeddingClient.js";

async function anyEmbedded(): Promise<boolean> {
  const result = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from resources where embedding is not null`,
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

describe("vector search", () => {
  it("ranks a binary-search resource in the top 3 for an off-by-one boundary query", async () => {
    if (!(await anyEmbedded())) {
      console.warn("SKIPPED: no resources embedded yet — run `npm run embed:resources` (needs GEMINI_API_KEY).");
      return;
    }
    const queryEmbedding = await embedText("binary search off by one boundary condition");
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const result = await db.execute(
      sql`select id, subtopic_ids from resources where embedding is not null
          order by embedding <=> ${vectorLiteral}::vector limit 3`,
    );
    const top3 = result.rows as unknown as Array<{ id: string; subtopic_ids: string[] }>;
    const hasBinarySearch = top3.some((r) => r.subtopic_ids.includes("arr_binary_search"));
    expect(hasBinarySearch).toBe(true);
  });

  it("does not rank an array resource in the top 3 for a graph shortest-path query", async () => {
    if (!(await anyEmbedded())) {
      console.warn("SKIPPED: no resources embedded yet — run `npm run embed:resources` (needs GEMINI_API_KEY).");
      return;
    }
    const queryEmbedding = await embedText("graph shortest path algorithm");
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const result = await db.execute(
      sql`select id, topic_ids from resources where embedding is not null
          order by embedding <=> ${vectorLiteral}::vector limit 3`,
    );
    const top3 = result.rows as unknown as Array<{ id: string; topic_ids: string[] }>;
    const hasArraysResource = top3.some((r) => r.topic_ids.includes("arrays"));
    expect(hasArraysResource).toBe(false);
  });
});
