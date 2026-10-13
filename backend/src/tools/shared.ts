/** Shared across tool buckets — kept tiny on purpose (bloom-phase2-brief.md §12: five tools, no plugin system). */

import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { studentConstraints } from "../db/schema.js";

export async function resolveEffectiveConstraints(studentId: string, at: Date) {
  const [row] = await db
    .select()
    .from(studentConstraints)
    .where(and(eq(studentConstraints.studentId, studentId), lte(studentConstraints.effectiveFrom, at)))
    .orderBy(sql`${studentConstraints.effectiveFrom} desc`)
    .limit(1);
  return row ?? null;
}
