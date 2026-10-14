/**
 * Authentication and per-student authorisation, with no extra dependencies (node:crypto only).
 *
 * - Passwords: scrypt with a per-user random salt, stored as "salt:hash" (hex).
 * - Sessions: a compact HS256 token  base64url(header).base64url(payload).base64url(hmac)  carrying
 *   { sub: studentId, exp }. Signed with AUTH_SECRET.
 * - Enforcement is controlled by AUTH_REQUIRED=true. When it is off (the default, so the demo and the
 *   existing test suite keep working) tokens are still honoured if sent, but nothing is refused.
 *   Set AUTH_REQUIRED=true and AUTH_SECRET (32+ chars) for any deployment that is not a local demo.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ApiError } from "./http.js";

declare module "express-serve-static-core" {
  interface Request {
    auth?: { studentId: string };
  }
}

const TOKEN_TTL_SEC = Number(process.env.AUTH_TOKEN_TTL_SEC ?? 7 * 24 * 3600);

export function authRequired(): boolean {
  return process.env.AUTH_REQUIRED === "true";
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    if (authRequired()) throw new Error("AUTH_REQUIRED=true needs AUTH_SECRET to be set to a random string of at least 32 characters.");
    // Auth is off: tokens are a convenience only, so a fixed dev secret is acceptable.
    return "bloom-dev-secret-not-for-production-use";
  }
  return s;
}

/** Throws at boot when enforcement is on but the secret is unusable, instead of failing on the first request. */
export function assertAuthConfig(): void {
  if (authRequired()) secret();
}

// ── passwords ───────────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ── tokens ──────────────────────────────────────────────────────

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (data: string) => createHmac("sha256", secret()).update(data).digest();

export function signToken(studentId: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ sub: studentId, iat: nowSec, exp: nowSec + TOKEN_TTL_SEC }));
  return `${head}.${body}.${b64(sign(`${head}.${body}`))}`;
}

/** Returns the student id, or null for a malformed, tampered or expired token. */
export function verifyToken(token: string, nowSec = Math.floor(Date.now() / 1000)): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = sign(`${head}.${body}`);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { sub?: unknown; exp?: unknown };
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number" || payload.exp < nowSec) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

// ── middleware ──────────────────────────────────────────────────

const unauthenticated = () => new ApiError(401, "UNAUTHENTICATED", "Sign in first.");
const forbidden = () => new ApiError(403, "FORBIDDEN", "That belongs to a different student.");

/** Reads `Authorization: Bearer <token>` (or ?token= for EventSource, which cannot set headers). Never refuses. */
export const attachAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : typeof req.query.token === "string" ? req.query.token : null;
  const studentId = token ? verifyToken(token) : null;
  if (studentId) req.auth = { studentId };
  next();
};

/** Refuses unauthenticated requests when AUTH_REQUIRED=true. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (authRequired() && !req.auth) return next(unauthenticated());
  next();
};

/** Throws unless the caller is `studentId`. A no-op while auth is not enforced. */
export function assertOwns(req: Request, studentId: string): void {
  if (!authRequired()) return;
  if (!req.auth) throw unauthenticated();
  if (req.auth.studentId !== studentId) throw forbidden();
}

/** Mount with `router.use("/students/:id", guardStudentParam)` to cover every /students/:id/... route. */
export const guardStudentParam: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  try {
    assertOwns(req, req.params.id);
    next();
  } catch (err) {
    next(err);
  }
};
