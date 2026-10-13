import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { resources } from "../../src/db/schema.js";
import { verifyAndFilter } from "../../src/tools/rag.js";
import { fakeClock } from "./helpers.js";

type ResourceRow = typeof resources.$inferSelect;

function makeResource(overrides: Partial<ResourceRow> = {}): ResourceRow {
  return {
    id: "res_test_1",
    title: "Test resource",
    provider: "test",
    url: "https://example.com/test",
    type: "article",
    difficulty: 2,
    durationMin: 15,
    quality: "0.8",
    topicIds: ["arrays"],
    subtopicIds: ["arr_traversal"],
    conceptIds: [],
    description: "test",
    embedding: null,
    lastVerifiedAt: null,
    isLive: true,
    verificationFailures: 0,
    ...overrides,
  } as ResourceRow;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function cleanupTestResource(id: string) {
  await db.delete(resources).where(eq(resources.id, id));
}

describe("live resource verification", () => {
  it("200 → included, last_verified_at updated, is_live true", async () => {
    const row = makeResource({ id: "res_verify_200" });
    await db.insert(resources).values(row).onConflictDoNothing();

    global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const { hits, notices } = await verifyAndFilter([row], 8);
    expect(hits).toHaveLength(1);
    expect(hits[0].verified).toBe(true);
    expect(notices).toEqual([]);

    const [updated] = await db.select().from(resources).where(eq(resources.id, row.id));
    expect(updated.isLive).toBe(true);
    expect(updated.lastVerifiedAt).not.toBeNull();

    await cleanupTestResource(row.id);
  });

  it("404 → excluded, is_live=false, a notice is emitted, backfilled from the next candidate", async () => {
    const dead = makeResource({ id: "res_verify_404", url: "https://example.com/dead" });
    const good = makeResource({ id: "res_verify_backup", url: "https://example.com/good" });
    await db.insert(resources).values([dead, good]).onConflictDoNothing();

    global.fetch = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("dead")) return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const { hits, notices } = await verifyAndFilter([dead, good], 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].row.id).toBe(good.id);
    expect(notices.some((n) => n.includes("404"))).toBe(true);

    const [updatedDead] = await db.select().from(resources).where(eq(resources.id, dead.id));
    expect(updatedDead.isLive).toBe(false);

    await cleanupTestResource(dead.id);
    await cleanupTestResource(good.id);
  });

  it("timeout → included anyway, flagged unverified, is_live untouched on a single failure", async () => {
    const row = makeResource({ id: "res_verify_timeout" });
    await db.insert(resources).values(row).onConflictDoNothing();

    global.fetch = vi.fn(() => {
      const err = new DOMException("aborted", "AbortError");
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    const { hits } = await verifyAndFilter([row], 8);
    expect(hits).toHaveLength(1);
    expect(hits[0].verified).toBe(false);

    const [updated] = await db.select().from(resources).where(eq(resources.id, row.id));
    expect(updated.isLive).toBe(true); // one timeout must not kill a good resource
    expect(updated.verificationFailures).toBe(1);

    await cleanupTestResource(row.id);
  });

  it("3 consecutive timeouts → is_live set to false", async () => {
    const row = makeResource({ id: "res_verify_3fail", verificationFailures: 2 });
    await db.insert(resources).values(row).onConflictDoNothing();

    global.fetch = vi.fn(() => Promise.reject(new DOMException("aborted", "AbortError"))) as unknown as typeof fetch;

    await verifyAndFilter([row], 8);

    const [updated] = await db.select().from(resources).where(eq(resources.id, row.id));
    expect(updated.isLive).toBe(false);
    expect(updated.verificationFailures).toBe(3);

    await cleanupTestResource(row.id);
  });

  it("cached within 24 simulated hours → no HTTP call made", async () => {
    const clock = fakeClock(Date.parse("2026-01-02T00:00:00Z"));
    const row = makeResource({ id: "res_verify_cached", lastVerifiedAt: new Date("2026-01-01T12:00:00Z") });
    await db.insert(resources).values(row).onConflictDoNothing();

    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { hits } = await verifyAndFilter([row], 8, clock);
    expect(hits).toHaveLength(1);
    expect(hits[0].verified).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    await cleanupTestResource(row.id);
  });
});
