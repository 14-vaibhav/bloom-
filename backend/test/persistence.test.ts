import { describe, it, expect, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { idempotencyKeys } from "../src/db/schema.js";

describe("persistence", () => {
  it("a row written through one connection pool is readable through a brand new one", async () => {
    const key = `persistence-test-${Date.now()}`;

    const poolA = new Pool({ connectionString: process.env.DATABASE_URL });
    const dbA = drizzle(poolA, { schema });
    await dbA.insert(idempotencyKeys).values({ key, endpoint: "test", response: { ok: true } });
    await poolA.end();

    // Fresh pool + fresh connection — simulates the app restarting and reconnecting,
    // proving the row lives in Postgres, not in any in-process cache.
    const poolB = new Pool({ connectionString: process.env.DATABASE_URL });
    const dbB = drizzle(poolB, { schema });
    const [row] = await dbB.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    expect(row?.endpoint).toBe("test");

    await dbB.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    await poolB.end();
  });
});
