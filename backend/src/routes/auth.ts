/** Sign-up, sign-in and "who am I". Enforcement of the resulting token lives in lib/auth.ts. */
import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { students } from "../db/schema.js";
import { ApiError, asyncRoute, ok, parseBody } from "../lib/http.js";
import { hashPassword, signToken, verifyPassword } from "../lib/auth.js";
import { rateLimit } from "../lib/rateLimit.js";

export const authRouter = Router();

const credentials = z.object({ email: z.string().email().max(200).transform((e) => e.toLowerCase()), password: z.string().min(8).max(200) });
// Sign-in is the brute-force target, so it gets a much tighter limit than the LLM endpoints.
const authLimit = rateLimit({ name: "sign-in", max: 10 });

authRouter.post("/auth/register", authLimit, asyncRoute(async (req, res) => {
  const body = parseBody(credentials.extend({ name: z.string().min(1).max(100) }), req.body);
  const [existing] = await db.select({ id: students.id }).from(students).where(eq(students.email, body.email));
  if (existing) throw new ApiError(409, "EMAIL_TAKEN", "That email is already registered.", "email");
  const [row] = await db.insert(students)
    .values({ name: body.name, email: body.email, passwordHash: hashPassword(body.password), simNow: new Date() })
    .returning({ id: students.id, name: students.name, email: students.email });
  ok(res, { student: row, token: signToken(row.id) }, 201);
}));

authRouter.post("/auth/login", authLimit, asyncRoute(async (req, res) => {
  const body = parseBody(credentials, req.body);
  const [row] = await db.select().from(students).where(eq(students.email, body.email));
  // Same message for "no such account" and "wrong password" so the endpoint does not reveal which emails exist.
  if (!row || !verifyPassword(body.password, row.passwordHash)) throw new ApiError(401, "BAD_CREDENTIALS", "Wrong email or password.");
  ok(res, { student: { id: row.id, name: row.name, email: row.email }, token: signToken(row.id) });
}));

authRouter.get("/auth/me", asyncRoute(async (req, res) => {
  if (!req.auth) throw new ApiError(401, "UNAUTHENTICATED", "Sign in first.");
  const [row] = await db.select({ id: students.id, name: students.name, email: students.email }).from(students).where(eq(students.id, req.auth.studentId));
  if (!row) throw new ApiError(401, "UNAUTHENTICATED", "That account no longer exists.");
  ok(res, row);
}));
