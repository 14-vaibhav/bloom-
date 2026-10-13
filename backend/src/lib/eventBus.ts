/**
 * In-process pub/sub for agent_events rows (bloom-phase8-brief §A3). One
 * backend process, one EventEmitter, one channel per student — no Redis.
 * The three write sites (dispatcher.ts, orchestrator.ts, agent/llm/service.ts)
 * call publishAgentEvent() right after their insert so the SSE route never
 * has to poll the database for new rows.
 */

import { EventEmitter } from "node:events";
import type { agentEvents } from "../db/schema.js";

export type AgentEventRow = typeof agentEvents.$inferSelect;

const emitter = new EventEmitter();
// Many concurrent student streams (demo + judges' laptops) is expected; the
// default cap of 10 would log spurious "possible EventEmitter memory leak" warnings.
emitter.setMaxListeners(0);

function channel(studentId: string): string {
  return `student:${studentId}`;
}

export function publishAgentEvent(row: AgentEventRow): void {
  emitter.emit(channel(row.studentId), row);
}

/** Returns an unsubscribe function — callers MUST call it on disconnect or every
 * page reload during a rehearsal leaks a listener. */
export function subscribeAgentEvents(studentId: string, handler: (row: AgentEventRow) => void): () => void {
  const ch = channel(studentId);
  emitter.on(ch, handler);
  return () => emitter.off(ch, handler);
}

export function listenerCountFor(studentId: string): number {
  return emitter.listenerCount(channel(studentId));
}
