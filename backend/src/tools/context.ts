/**
 * AgentContext carries the identifiers every dispatcher call needs to log itself
 * against the right agent_runs row. Phase 2 ships no orchestrator, so
 * createAgentContext() below is the stand-in scripts and tests use to get one —
 * Phase 6's orchestrator will build contexts the same way, just from inside the loop.
 */

import { db } from "../db/client.js";
import { agentRuns } from "../db/schema.js";
import { systemClock, type Clock } from "../lib/clock.js";

export const AGENT_PHASES = [
  "observe", "update_beliefs", "triggers", "analyze", "decide",
  "retrieve", "plan", "validate", "repair", "commit", "act",
] as const;

export type AgentPhase = (typeof AGENT_PHASES)[number];

export type AgentContext = {
  runId: string;
  /** Work that runs outside the agent loop (the tutor, v4 §N3.2): the dispatcher writes no agent_events row and no agent_runs row exists. */
  untracked?: boolean;
  studentId: string;
  phase: AgentPhase;
  clock: Clock;
  nextSeq: () => number;
};

export function withPhase(ctx: AgentContext, phase: AgentPhase): AgentContext {
  return { ...ctx, phase };
}

export function createSeqCounter(start = 0): () => number {
  let seq = start;
  return () => ++seq;
}

export async function createAgentContext(opts: {
  studentId: string;
  trigger?: string;
  phase?: AgentPhase;
  clock?: Clock;
}): Promise<AgentContext> {
  const [run] = await db
    .insert(agentRuns)
    .values({ studentId: opts.studentId, trigger: opts.trigger ?? "MANUAL", scope: "PATCH" })
    .returning({ id: agentRuns.id });
  return {
    runId: run.id,
    studentId: opts.studentId,
    phase: opts.phase ?? "observe",
    clock: opts.clock ?? systemClock,
    nextSeq: createSeqCounter(),
  };
}

/** Context for tool calls made outside the agent loop (the tutor). No agent_runs row is created. */
export function createUntrackedContext(opts: { studentId: string; clock?: Clock; phase?: AgentPhase }): AgentContext {
  return {
    runId: "00000000-0000-0000-0000-000000000000",
    studentId: opts.studentId,
    phase: opts.phase ?? "retrieve",
    clock: opts.clock ?? systemClock,
    nextSeq: createSeqCounter(),
    untracked: true,
  };
}
