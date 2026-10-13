/**
 * Serves the Phase 9 eval harness output (bloom-phase8-brief §A2,
 * bloom-phase9-brief §B7). `npm run eval` writes eval-results.json at the
 * repo root; this route just reads it back — the harness is the only thing
 * that ever computes these numbers.
 */

import { Router } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { asyncRoute, notFound, ok } from "../lib/http.js";

export const evalRouter = Router();

const RESULTS_PATH = path.resolve(import.meta.dirname, "../../../eval-results.json");

evalRouter.get("/eval/latest", asyncRoute(async (_req, res) => {
  try {
    const raw = await readFile(RESULTS_PATH, "utf8");
    ok(res, JSON.parse(raw));
  } catch {
    throw notFound("No eval report yet — run `npm run eval` first.");
  }
}));

// v4 §N7.2 — the knowledge-base evaluation (written by `npm run eval:kb`).
const KB_RESULTS_PATH = path.resolve(import.meta.dirname, "../../../docs/kb-eval-results.json");

evalRouter.get("/eval/kb", asyncRoute(async (_req, res) => {
  try {
    ok(res, JSON.parse(await readFile(KB_RESULTS_PATH, "utf8")));
  } catch {
    throw notFound("No KB evaluation yet — run `npm run eval:kb` first.");
  }
}));
