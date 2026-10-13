import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { agentEvents, toolHealth } from "../../src/db/schema.js";
import { dispatchWithResilience } from "../../src/tools/dispatcher.js";
import { TransientError, PermanentError, ValidationError } from "../../src/tools/errors.js";
import { getDegradedFallback } from "../../src/tools/degraded.js";
import { getDemoStudentId, makeContext, resetToolHealth, fakeClock } from "./helpers.js";

const FAKE_BUCKET = "performance" as const; // reuse a real bucket key; the operation name is what's fake
const FAKE_OP = "__resilience_test_op__";

let studentId: string;

/** A tool call that fails `failTimes` times (transientErrorFactory) before succeeding. */
function flakyRun(failTimes: number, errorFactory: () => Error) {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= failTimes) throw errorFactory();
    return { output: { ok: true, calls } };
  };
}

async function eventsForRun(runId: string) {
  return db.select().from(agentEvents).where(eq(agentEvents.runId, runId)).orderBy(agentEvents.seq);
}

beforeEach(async () => {
  studentId = await getDemoStudentId();
  await resetToolHealth();
});

describe("resilience: retry", () => {
  it("a transient error is retried once and, on success, logs one event with retry_attempt=1", async () => {
    const ctx = await makeContext(studentId);
    const run = flakyRun(1, () => new TransientError("temporary blip"));

    const result = await dispatchWithResilience(ctx, FAKE_BUCKET, FAKE_OP, {}, run);
    expect(result).toEqual({ ok: true, calls: 2 });

    const rows = await eventsForRun(ctx.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].retryAttempt).toBe(1);
    expect(rows[0].errorClass).toBeNull();
  });

  it("a permanent error is never retried", async () => {
    const ctx = await makeContext(studentId);
    let calls = 0;
    const run = async () => {
      calls += 1;
      throw new PermanentError("not found");
    };

    await expect(dispatchWithResilience(ctx, FAKE_BUCKET, FAKE_OP, {}, run)).rejects.toThrow(PermanentError);
    expect(calls).toBe(1);

    const rows = await eventsForRun(ctx.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].errorClass).toBe("permanent");
    expect(rows[0].retryAttempt).toBe(0);
  });

  it("a validation error is never retried and does not increment consecutive_failures", async () => {
    const ctx = await makeContext(studentId);
    let calls = 0;
    const run = async () => {
      calls += 1;
      throw new ValidationError("bad shape");
    };

    await expect(dispatchWithResilience(ctx, FAKE_BUCKET, FAKE_OP, {}, run)).rejects.toThrow(ValidationError);
    expect(calls).toBe(1);

    const [health] = await db.select().from(toolHealth).where(eq(toolHealth.toolName, FAKE_BUCKET));
    expect(health.consecutiveFailures).toBe(0);
  });
});

describe("resilience: circuit breaker", () => {
  it("3 consecutive transient failures open the breaker; the next call fails fast", async () => {
    const alwaysFails = async () => {
      throw new TransientError("down");
    };

    for (let i = 0; i < 3; i++) {
      const ctx = await makeContext(studentId);
      await expect(dispatchWithResilience(ctx, FAKE_BUCKET, FAKE_OP, {}, alwaysFails)).rejects.toThrow();
    }

    const [health] = await db.select().from(toolHealth).where(eq(toolHealth.toolName, FAKE_BUCKET));
    expect(health.state).toBe("open");

    const ctx = await makeContext(studentId);
    const start = Date.now();
    let called = false;
    const neverCalled = async () => {
      called = true;
      throw new Error("should not be called — breaker is open");
    };
    // FAKE_OP has no registered degraded fallback, so an open breaker must fail fast without
    // ever invoking `run` — that's the whole point of a breaker over just letting calls timeout.
    await expect(dispatchWithResilience(ctx, FAKE_BUCKET, FAKE_OP, {}, neverCalled)).rejects.toThrow(/circuit open/);
    expect(called).toBe(false);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("after 60 simulated seconds, the breaker half-opens; a successful probe closes it", async () => {
    const clock = fakeClock(Date.parse("2026-01-01T00:00:00Z"));
    const ctx = await makeContext(studentId, clock);

    const alwaysFails = async () => {
      throw new TransientError("down");
    };
    for (let i = 0; i < 3; i++) {
      await expect(dispatchWithResilience(ctx, FAKE_BUCKET, FAKE_OP, {}, alwaysFails)).rejects.toThrow();
    }
    let health = (await db.select().from(toolHealth).where(eq(toolHealth.toolName, FAKE_BUCKET)))[0];
    expect(health.state).toBe("open");

    clock.advance(61_000);

    const succeeds = async () => ({ output: { ok: true } });
    const result = await dispatchWithResilience(ctx, FAKE_BUCKET, FAKE_OP, {}, succeeds);
    expect(result).toEqual({ ok: true });

    health = (await db.select().from(toolHealth).where(eq(toolHealth.toolName, FAKE_BUCKET)))[0];
    expect(health.state).toBe("closed");
    expect(health.consecutiveFailures).toBe(0);
  });

  it("breaker state survives a fresh read (persisted in tool_health, not in-process memory)", async () => {
    const alwaysFails = async () => {
      throw new TransientError("down");
    };
    for (let i = 0; i < 3; i++) {
      const ctx = await makeContext(studentId);
      await expect(dispatchWithResilience(ctx, FAKE_BUCKET, FAKE_OP, {}, alwaysFails)).rejects.toThrow();
    }

    // A brand new context (simulating a restarted process) sees the same open breaker.
    const freshCtx = await makeContext(studentId);
    const decision = await import("../../src/tools/breaker.js").then((m) => m.checkBreaker(FAKE_BUCKET, freshCtx.clock()));
    expect(decision).toBe("open");
  });
});

describe("resilience: degraded modes", () => {
  it("RAG degraded mode returns the documented shape (array + optional signal)", async () => {
    const fallback = await getDegradedFallback("rag", "search_learning_resources", {
      subtopic_id: "arr_traversal",
      target_difficulty: 2,
      max_duration_min: 30,
      exclude_ids: [],
      k: 8,
    });
    expect(fallback).not.toBeNull();
    expect(Array.isArray(fallback!.data)).toBe(true);
    expect(typeof fallback!.message).toBe("string");
  });

  it("Calendar degraded mode plans against the template and signals PROVISIONAL_PLAN", async () => {
    const fallback = await getDegradedFallback("calendar", "get_available_slots", {
      student_id: studentId,
      from: "2026-11-02T00:00:00Z",
      to: "2026-11-03T00:00:00Z",
      min_slot_min: 15,
    });
    expect(fallback).not.toBeNull();
    expect(fallback!.signal).toBe("PROVISIONAL_PLAN");
  });

  it("Question bank degraded mode defers rather than dropping the assessment", async () => {
    const fallback = await getDegradedFallback("qbank", "compose_assessment", {
      student_id: studentId,
      subtopic_id: "arr_traversal",
      purpose: "checkpoint",
      count: 5,
    });
    expect(fallback).not.toBeNull();
    expect(fallback!.signal).toBe("DEFER_ASSESSMENTS");
  });

  it("Performance degraded mode reduces confidence rather than failing", async () => {
    const fallback = await getDegradedFallback("performance", "get_subtopic_performance", {
      student_id: studentId,
      subtopic_ids: ["arr_traversal"],
    });
    expect(fallback).not.toBeNull();
    expect(fallback!.signal).toBe("REDUCED_CONFIDENCE");
  });

  it("State store degraded mode is a hard fail, not a fallback", async () => {
    await expect(getDegradedFallback("state", "get_student_state", { student_id: studentId })).rejects.toThrow(
      /run aborted/i,
    );
  });
});
