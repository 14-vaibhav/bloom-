import "dotenv/config";
import { db, pool } from "../db/client.js";
import { resources } from "../db/schema.js";
import { verifyUrlsConcurrently } from "../lib/verifyUrl.js";
import { eq, sql } from "drizzle-orm";

async function main() {
  const rows = await db.select({ id: resources.id, url: resources.url }).from(resources);
  if (rows.length === 0) {
    console.log("No resources in the database yet — nothing to check.");
    await pool.end();
    return;
  }

  console.log(`Checking ${rows.length} resource URLs (concurrency 8, 5s timeout)...`);
  const results = await verifyUrlsConcurrently(rows.map((r) => r.url), 8, 5000);

  let live = 0;
  let dead = 0;
  let unverified = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const result = results[i];
    if (result.status === "live") {
      live++;
      await db
        .update(resources)
        .set({ isLive: true, lastVerifiedAt: new Date(result.checkedAt), verificationFailures: 0 })
        .where(eq(resources.id, row.id));
    } else if (result.status === "dead") {
      dead++;
      console.error(`DEAD  [${result.httpStatus}] ${row.id} → ${row.url}`);
      await db
        .update(resources)
        .set({
          isLive: false,
          lastVerifiedAt: new Date(result.checkedAt),
          verificationFailures: sql`${resources.verificationFailures} + 1`,
        })
        .where(eq(resources.id, row.id));
    } else {
      unverified++;
      console.warn(`UNVERIFIED [${result.httpStatus ?? "no response"}] ${row.id} → ${row.url}`);
    }
  }

  console.log(`\nDone: ${live} live, ${dead} dead, ${unverified} unverified (of ${rows.length}).`);
  await pool.end();

  if (dead > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
