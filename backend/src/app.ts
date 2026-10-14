import express from "express";
import cors from "cors";
import { errorMiddleware } from "./lib/http.js";
import { agentRouter } from "./routes/agent.js";
import { activitiesRouter } from "./routes/activities.js";
import { assessmentsRouter } from "./routes/assessments.js";
import { catalogRouter } from "./routes/catalog.js";
import { constraintsRouter } from "./routes/constraints.js";
import { evalRouter } from "./routes/eval.js";
import { plansRouter } from "./routes/plans.js";
import { simRouter } from "./routes/sim.js";
import { studentsRouter } from "./routes/students.js";
import { tutorRouter } from "./routes/tutor.js";
import path from "node:path";
import { assertAuthConfig, attachAuth, guardStudentParam, requireAuth } from "./lib/auth.js";
import { rateLimit } from "./lib/rateLimit.js";
import { authRouter } from "./routes/auth.js";

/**
 * Browsers may call the API only from CORS_ORIGINS (comma-separated). When it is unset, only local dev origins
 * (localhost / 127.0.0.1 on any port) are allowed. Requests with no Origin header (curl, server-to-server, the
 * Vite proxy) are unaffected: CORS is a browser rule.
 */
function corsOrigin(origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) {
  if (!origin) return cb(null, true);
  const configured = (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  const allowed = configured.length > 0
    ? configured.includes(origin)
    : /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  cb(null, allowed);
}

export function createApp() {
  assertAuthConfig();
  const app = express();
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: "256kb" }));
  app.use(attachAuth);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "bloom-backend", phase: 10 });
  });

  // slide PNGs written by the slide ingester (v4 §N1.2)
  app.use("/kb-assets", express.static(path.resolve(import.meta.dirname, "../kb-assets")));

  const api = express.Router();
  api.use(authRouter);
  // Everything under /students/:id belongs to that student only (no-op unless AUTH_REQUIRED=true).
  api.use("/students/:id", guardStudentParam);
  // Demo tooling that flips shared state (tool health, citation break) just needs a signed-in caller.
  api.use(["/sim/break-tool", "/sim/restore-tool", "/sim/break-citation"], requireAuth);
  // Endpoints that make paid LLM / embedding calls.
  const llmLimit = rateLimit({ name: "tutor", max: Number(process.env.RATE_LIMIT_TUTOR_PER_MIN ?? 20) });
  const agentLimit = rateLimit({ name: "agent", max: Number(process.env.RATE_LIMIT_AGENT_PER_MIN ?? 30) });
  api.post("/students/:id/tutor/ask", llmLimit);
  api.post("/kb/chunks", llmLimit);
  api.post(["/agent/run", "/agent/tick"], agentLimit);
  api.use(catalogRouter);
  api.use(studentsRouter);
  api.use(plansRouter);
  api.use(activitiesRouter);
  api.use(assessmentsRouter);
  api.use(constraintsRouter);
  api.use(agentRouter);
  api.use(simRouter);
  api.use(evalRouter);
  api.use(tutorRouter);
  app.use("/api", api);

  app.use(errorMiddleware);
  return app;
}
