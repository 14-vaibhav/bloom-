/**
 * Small in-memory fixed-window rate limiter for the endpoints that cost money (LLM / embedding calls).
 * Keyed by the signed-in student when there is one, otherwise by client IP. One process only: behind several
 * instances each keeps its own counters, which still bounds spend per instance.
 */
import type { RequestHandler } from "express";
import { ApiError } from "./http.js";

type Bucket = { count: number; resetAt: number };

export function rateLimit(opts: { name: string; max: number; windowMs?: number }): RequestHandler {
  const windowMs = opts.windowMs ?? 60_000;
  const buckets = new Map<string, Bucket>();
  return (req, res, next) => {
    if (process.env.RATE_LIMIT_DISABLED === "true") return next();
    const now = Date.now();
    const key = req.auth?.studentId ?? req.ip ?? "unknown";
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
      if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    b.count += 1;
    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, opts.max - b.count)));
    if (b.count > opts.max) {
      const retryAfter = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return next(new ApiError(429, "RATE_LIMITED", `Too many ${opts.name} requests. Try again in ${retryAfter}s.`));
    }
    next();
  };
}
