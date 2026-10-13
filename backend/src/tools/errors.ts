/**
 * Error taxonomy (bloom-phase2-brief.md §7.1). Every error a tool throws must
 * classify into exactly one of these three, because retry and the circuit
 * breaker both key off the class. Get this wrong and you either retry
 * something that can never succeed, or let one dead resource URL take the
 * whole tool offline.
 */

export type ErrorClass = "transient" | "permanent" | "validation";

// `llm` deliberately shares the durable Phase 2 circuit breaker.  It is not
// a dispatcher operation, but has the same failure semantics and must survive
// a restart like every other dependency.
export type ToolBucket = "performance" | "rag" | "calendar" | "qbank" | "state" | "kb" | "llm";

export class ToolError extends Error {
  readonly errorClass: ErrorClass;
  constructor(message: string, errorClass: ErrorClass, options?: { cause?: unknown }) {
    super(message, options);
    this.errorClass = errorClass;
    this.name = new.target.name;
  }
}

/** timeout, ECONNRESET, HTTP 5xx, DB pool exhaustion — retry, and it counts toward the breaker. */
export class TransientError extends ToolError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "transient", options);
  }
}

/** 404, record not found, constraint violation — never retried, never trips the breaker. */
export class PermanentError extends ToolError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "permanent", options);
  }
}

/** Zod input/output failure — our bug, not the dependency's. Never retried, never trips the breaker. */
export class ValidationError extends ToolError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "validation", options);
  }
}

export class TimeoutError extends TransientError {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** Thrown by the dispatcher itself when a breaker is open — the call never reached the tool. */
export class ToolUnavailableError extends Error {
  readonly tool: ToolBucket;
  constructor(tool: ToolBucket, message: string) {
    super(message);
    this.name = "ToolUnavailableError";
    this.tool = tool;
  }
}

/** State-store degraded mode is a hard fail, not a fallback — the caller must abort the run. */
export class StateStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateStoreUnavailableError";
  }
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"]);

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof ToolError) return err.errorClass;
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: string }).code;
    if (code && TRANSIENT_CODES.has(code)) return "transient";
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|ECONNRESET|connection.*(reset|refused|terminated)|pool/i.test(msg)) return "transient";
  return "permanent";
}

export function errorClassName(err: unknown): string {
  if (err instanceof Error) return err.name;
  return "UnknownError";
}
