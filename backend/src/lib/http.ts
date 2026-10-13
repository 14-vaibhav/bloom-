/**
 * Uniform REST envelope (bloom-phase8-brief §A2): every response is either
 * `{ ok: true, data }` or `{ ok: false, error: { code, message, field? } }`.
 * asyncRoute wraps a handler so a thrown ApiError (or ZodError) becomes the
 * right status code instead of an unhandled-rejection 500.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { eq } from "drizzle-orm";
import { z, ZodError, type ZodTypeAny } from "zod";
import { db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export function notFound(message: string): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

export function badRequest(message: string, field?: string, code = "BAD_REQUEST"): ApiError {
  return new ApiError(400, code, message, field);
}

export function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ ok: true, data });
}

// Generic bound on the schema type itself (not a bare `ZodType<T>` parameter) — Zod's
// Input/Output variance otherwise makes TS infer T as the pre-`.default()` input type,
// silently making every defaulted field look optional at every call site.
export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw badRequest(first?.message ?? "Invalid request body", first?.path.join(".") || undefined, "VALIDATION_ERROR");
  }
  return parsed.data;
}

export function parseQuery<S extends ZodTypeAny>(schema: S, query: unknown): z.infer<S> {
  return parseBody(schema, query);
}

/** Wraps an async Express handler so rejected promises reach the error middleware
 * instead of hanging the request (Express 4 does not do this automatically). */
export function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/** Idempotency-key wrapper for POST routes that mutate state (bloom-phase8-brief
 * §A2: "idempotency key required"). A repeated key returns the first response
 * verbatim instead of re-running the mutation — the qbank tool ops already do
 * this internally; this is the same pattern for the REST-only endpoints. */
export async function withIdempotency<T>(opts: { endpoint: string; key: string | undefined; run: () => Promise<T> }): Promise<T> {
  if (!opts.key) return opts.run();
  const [cached] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, opts.key));
  if (cached) return cached.response as T;
  const result = await opts.run();
  await db.insert(idempotencyKeys).values({ key: opts.key, endpoint: opts.endpoint, response: result as object }).onConflictDoNothing();
  return result;
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message, field: err.field } });
    return;
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    res.status(400).json({ ok: false, error: { code: "VALIDATION_ERROR", message: first?.message ?? "Invalid request", field: first?.path.join(".") } });
    return;
  }
  const message = err instanceof Error ? err.message : "Internal error";
  // PermanentError (record-not-found style) from the tool layer surfaces as a 404,
  // not a 500 — a bad id is a client mistake, not a server fault.
  if (err instanceof Error && err.name === "PermanentError") {
    res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message } });
    return;
  }
  console.error(err);
  res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message } });
}
