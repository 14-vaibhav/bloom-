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

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "bloom-backend", phase: 10 });
  });

  // slide PNGs written by the slide ingester (v4 §N1.2)
  app.use("/kb-assets", express.static(path.resolve(import.meta.dirname, "../kb-assets")));

  const api = express.Router();
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
