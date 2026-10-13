/**
 * bloom-phase2-brief.md §10: "Then break it on purpose and confirm detection."
 * If these three stay green when they shouldn't, the surrounding tests aren't
 * testing anything.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { dispatchWithResilience } from "../../src/tools/dispatcher.js";
import { PermanentError, TransientError } from "../../src/tools/errors.js";
import { getDemoStudentId, makeContext, resetToolHealth } from "./helpers.js";

describe("break it on purpose", () => {
  it("an output schema violation is caught, not silently accepted", async () => {
    const studentId = await getDemoStudentId();
    await resetToolHealth();
    const ctx = await makeContext(studentId);

    const strictSchema = z.object({ mu: z.number() });
    const brokenRun = async () => ({ output: { mu: "not-a-number" } as unknown });

    await expect(
      dispatchWithResilience(
        ctx,
        "performance",
        "broken_shape_op",
        {},
        brokenRun,
        (o) => {
          const parsed = strictSchema.safeParse(o);
          return parsed.success ? { success: true, data: parsed.data } : { success: false, error: parsed.error };
        },
      ),
    ).rejects.toThrow(/Invalid output/);
  });

  it("a query against a dropped/nonexistent table surfaces as a real error, not a silent empty result", async () => {
    await expect(db.execute(sql`select * from this_table_does_not_exist`)).rejects.toThrow();
  });

  it("a permanent error forced into the transient retry path must not be retried", async () => {
    const studentId = await getDemoStudentId();
    await resetToolHealth();
    const ctx = await makeContext(studentId);

    let calls = 0;
    const run = async () => {
      calls += 1;
      // Deliberately using PermanentError here, not TransientError — the point of this
      // test is that misclassifying an error class is what the taxonomy exists to prevent.
      throw new PermanentError("looks like a 404, must not be retried");
    };

    await expect(dispatchWithResilience(ctx, "performance", "fake_permanent_op", {}, run)).rejects.toThrow(
      PermanentError,
    );
    expect(calls).toBe(1); // if this is ever 2, permanent errors are being retried — a real bug

    // Sanity: confirm a TransientError in the same harness *would* have been retried,
    // proving the previous assertion is actually distinguishing the two, not just always 1.
    let transientCalls = 0;
    const flaky = async () => {
      transientCalls += 1;
      if (transientCalls === 1) throw new TransientError("blip");
      return { output: { ok: true } };
    };
    const ctx2 = await makeContext(studentId);
    await dispatchWithResilience(ctx2, "performance", "fake_transient_op", {}, flaky);
    expect(transientCalls).toBe(2);
  });
});
