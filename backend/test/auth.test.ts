import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { students } from "../src/db/schema.js";
import { hashPassword, signToken, verifyPassword, verifyToken } from "../src/lib/auth.js";

const app = createApp();
const emails = [`auth-a-${crypto.randomUUID()}@bloom.test`, `auth-b-${crypto.randomUUID()}@bloom.test`];
let a: { id: string; token: string };
let b: { id: string; token: string };

beforeAll(async () => {
  process.env.RATE_LIMIT_DISABLED = "true";
  for (const [i, email] of emails.entries()) {
    const res = await request(app).post("/api/auth/register").send({ name: `Auth ${i}`, email, password: "correct horse battery" });
    expect(res.status).toBe(201);
    const who = { id: res.body.data.student.id as string, token: res.body.data.token as string };
    if (i === 0) a = who; else b = who;
  }
});

afterEach(() => {
  delete process.env.AUTH_REQUIRED;
  delete process.env.AUTH_SECRET;
});

afterAll(async () => {
  await db.delete(students).where(inArray(students.email, emails));
  delete process.env.RATE_LIMIT_DISABLED;
});

describe("passwords and tokens", () => {
  it("verifies the right password and rejects the wrong one", () => {
    const stored = hashPassword("hunter2hunter2");
    expect(verifyPassword("hunter2hunter2", stored)).toBe(true);
    expect(verifyPassword("hunter2hunter3", stored)).toBe(false);
    expect(verifyPassword("anything", null)).toBe(false);
  });

  it("salts every hash", () => {
    expect(hashPassword("same-password")).not.toBe(hashPassword("same-password"));
  });

  it("round-trips a token and rejects tampered or expired ones", () => {
    const token = signToken("student-1", 1_000);
    expect(verifyToken(token, 1_001)).toBe("student-1");
    const [h, , s] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: "student-2", exp: 9_999_999_999 })).toString("base64url")}.${s}`;
    expect(verifyToken(forged, 1_001)).toBeNull();
    expect(verifyToken(token, 1_000 + 8 * 24 * 3600)).toBeNull();
    expect(verifyToken("not.a.token")).toBeNull();
  });
});

describe("register and login", () => {
  it("never stores the plain password", async () => {
    const [row] = await db.select().from(students).where(eq(students.email, emails[0]));
    expect(row.passwordHash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(row.passwordHash).not.toContain("correct horse");
  });

  it("rejects a duplicate email and a short password", async () => {
    const dup = await request(app).post("/api/auth/register").send({ name: "X", email: emails[0], password: "correct horse battery" });
    expect(dup.status).toBe(409);
    const short = await request(app).post("/api/auth/register").send({ name: "X", email: "short@bloom.test", password: "short" });
    expect(short.status).toBe(400);
  });

  it("logs in with the right password and gives the same error for a wrong password and an unknown email", async () => {
    const good = await request(app).post("/api/auth/login").send({ email: emails[0], password: "correct horse battery" });
    expect(good.status).toBe(200);
    expect(verifyToken(good.body.data.token)).toBe(a.id);
    const wrong = await request(app).post("/api/auth/login").send({ email: emails[0], password: "wrong password!" });
    const unknown = await request(app).post("/api/auth/login").send({ email: "nobody@bloom.test", password: "wrong password!" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it("GET /auth/me returns the signed-in student", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${a.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(a.id);
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
  });
});

describe("enforcement (AUTH_REQUIRED=true)", () => {
  it("is off by default: unauthenticated requests still work", async () => {
    const res = await request(app).get(`/api/students/${a.id}/state`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("refuses a request with no token", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.AUTH_SECRET = "x".repeat(40);
    const res = await request(app).get(`/api/students/${a.id}/state`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("refuses another student's id with a valid token (403), and allows your own", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.AUTH_SECRET = "x".repeat(40);
    const mine = signToken(a.id);
    const other = await request(app).get(`/api/students/${b.id}/state`).set("Authorization", `Bearer ${mine}`);
    expect(other.status).toBe(403);
    const own = await request(app).get(`/api/students/${a.id}/state`).set("Authorization", `Bearer ${mine}`);
    expect(own.status).not.toBe(401);
    expect(own.status).not.toBe(403);
  });

  it("guards body-addressed routes too", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.AUTH_SECRET = "x".repeat(40);
    const res = await request(app).post("/api/agent/run").set("Authorization", `Bearer ${signToken(a.id)}`).send({ student_id: b.id });
    expect(res.status).toBe(403);
  });

  it("lists only the caller in GET /students", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.AUTH_SECRET = "x".repeat(40);
    const res = await request(app).get("/api/students").set("Authorization", `Bearer ${signToken(a.id)}`);
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([a.id]);
  });

  it("rejects a token signed with a different secret", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.AUTH_SECRET = "y".repeat(40);
    const stale = a.token; // signed earlier with the dev secret
    const res = await request(app).get(`/api/students/${a.id}/state`).set("Authorization", `Bearer ${stale}`);
    expect(res.status).toBe(401);
  });

  it("refuses to boot with enforcement on and no usable secret", () => {
    process.env.AUTH_REQUIRED = "true";
    expect(() => createApp()).toThrow(/AUTH_SECRET/);
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the sign-in limit is exceeded", async () => {
    delete process.env.RATE_LIMIT_DISABLED;
    let last = 0;
    let retryAfter: string | undefined;
    for (let i = 0; i < 14; i++) {
      const res = await request(app).post("/api/auth/login").send({ email: "nobody@bloom.test", password: "wrong password!" });
      last = res.status;
      retryAfter = res.headers["retry-after"];
      if (last === 429) break;
    }
    process.env.RATE_LIMIT_DISABLED = "true";
    expect(last).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});

describe("CORS", () => {
  it("allows localhost origins and refuses unknown ones by default", async () => {
    const local = await request(app).get("/health").set("Origin", "http://localhost:5173");
    expect(local.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const evil = await request(app).get("/health").set("Origin", "https://evil.example");
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("honours CORS_ORIGINS when set", async () => {
    process.env.CORS_ORIGINS = "https://bloom.example";
    const ok = await request(app).get("/health").set("Origin", "https://bloom.example");
    const local = await request(app).get("/health").set("Origin", "http://localhost:5173");
    delete process.env.CORS_ORIGINS;
    expect(ok.headers["access-control-allow-origin"]).toBe("https://bloom.example");
    expect(local.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
