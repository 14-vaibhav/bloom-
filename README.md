# Bloom — Multimodal Study Companion

An AI study companion that has read your course. It unifies lecture videos, slides and a textbook into one source-cited knowledge base, then uses it to tutor and to run adaptive assessments. **Every tutor answer and every question points at an exact lecture timestamp, slide or textbook page — and a validator rejects any answer whose citations do not check out.** Underneath is the v3 learning autopilot, which is the personalisation engine: it predicts how a study session will go, tests whether it was right, and rewrites the plan the moment reality disagrees. Not "goal in → LLM → timetable → done" — a closed loop that observes, updates beliefs, evaluates triggers, decides scope, plans, validates, repairs, and acts, on its own clock.

## What the study companion adds (v4)

- **One knowledge base, three source kinds** (`backend/src/kb/`): video is indexed by its caption transcript in 60–90 s windows; slides are rendered to images and **read by a vision model** (so a diagram-only slide becomes searchable text); the textbook is split per page with exact page numbers. Every chunk keeps a deterministic locator (`{t_start,t_end}`, `{slide}`, `{page}`), never one written by an LLM.
- **Deterministic tagging**: chunks attach to the existing subtopic tree by embedding similarity above a tuned threshold; no LLM assigns a tag.
- **Cited tutor** (`backend/src/tutor/`): hybrid retrieval (vector + lexical, reciprocal-rank fused, with a kind-diversity swap so one answer can cite a lecture, a slide and a page together). Code picks the mode (`explain` / `connect` / `challenge`) from the student's mastery and orders citations by their measured `format_efficacy`; the LLM only writes the words. A pure-function **citation validator** (K1–K6) gates every answer: it must cite retrieved chunks, quote 6–30 words that really appear in them, and every locator must resolve. One repair round, then an extractive fallback; with no evidence the tutor declines and shows the nearest passages. The tutor never writes plans or mastery.
- **Grounded assessments**: MCQs are generated offline from a chunk and accepted only if their `evidence_quote` is found in it; the demo student only ever receives human-reviewed questions. A wrong answer links to the exact source passages.
- **Tutoring feeds the loop**: two tutor questions on one subtopic within 48 simulated hours, while confidence is below 0.70, fire `CONFUSION_SIGNAL` → a PATCH that inserts an `IMMEDIATE_TEST`. Zero LLM calls.
- **KB segments become resources**, so the unchanged planner, Curator and live URL verification work on course material.

## What it does

- Builds a deadline-aware, prerequisite-ordered study plan per subject (DSA, Computer Networks, RDBMS, OOP).
- Tracks mastery per subtopic with a deterministic belief model (BKT-style update, confidence decay, learn-rate recalibration) — the LLM never assigns a number.
- Runs autonomously on a clock tick: detects missed sessions, low scores, forgetting risk (pre-emptive active recall from a retention forecast), and deadline risk — without being asked.
- Chooses its own intervention **scope**: a single miss gets a sub-second PATCH with zero LLM calls; a wrong belief about the student gets a FULL replan.
- Refuses to fake a schedule it knows won't work: when required hours exceed available hours, it negotiates with quantified options (extend deadline / add time / drop scope) instead of committing an infeasible plan.
- Degrades gracefully under tool failure: a broken resource-lookup tool doesn't block planning — the agent reuses the last-known-good resource, marks the activity `provisional`, and re-plans automatically once the tool recovers.

## Architecture

```
Frontend (React + Vite)  ──HTTP/SSE──►  Backend (Express + TS)
                                             │
                          ┌──────────────────┼──────────────────┐
                          │                  │                  │
                    Agent loop         Tool dispatcher      Postgres + pgvector
                 (observe→update→          (5 tools,         (mastery, plans,
                  evaluate→decide→        21 ops, circuit      activities, runs,
                  retrieve→plan→           breakers,           events, eval data)
                  validate→repair→         retry/backoff)
                  commit→act)
```

- **Agent loop** (`backend/src/agent/`) — the 11-phase cycle: observe deltas, update beliefs (decay + BKT-lite), evaluate triggers → scope, run the deterministic gap engine plus (optionally) three LLM specialists, retrieve via tools, plan/patch, validate, repair (max 3 rounds) or negotiate, commit everything in one transaction, emit events.
- **Tools** (`backend/src/tools/`) — Performance, Educational RAG (with live URL verification), Calendar, Question Bank, Student State, and Knowledge Base — 24 operations behind one logged dispatcher with per-tool circuit breakers (`tool_health`) and defined degraded-mode behavior.
- **Core** (`backend/src/core/`) — pure, deterministic: mastery/decay math, gap-priority scoring, action selection baseline, the scheduler/slotter, the 12-check plan validator and repair operators, negotiation option generation.
- **Frontend** (`frontend/src/`) — 9 screens (Dashboard, Study Plan, Topic Progress, Library, Tutor, Assessment, Agent Activity, Plan Changes, Eval), a Source Viewer side panel, and a floating Demo Panel that advances simulated time and can break the RAG tool, the knowledge base (`Break KB`) and the tutor's next citation (`Break citation`) live.

## Deterministic vs LLM

| LLM decides | Code decides |
|---|---|
| Root cause of a wrong answer (Diagnostician) | Mastery, confidence, learn rate (BKT-lite update) |
| Resource choice among top-3 + justification (Curator) | Calendar arithmetic, slot/collision detection |
| Strategy, budget, negotiation wording (Strategist) | Prerequisite ordering, gap-priority scoring |
| Daily summary phrasing | Validation, repair limits, transactional persistence |

`LLM_ENABLED=false` runs the full loop with deterministic fallbacks for all three specialists — no LLM call is ever required for the agent to function correctly.

## Real vs simulated

| Real | Simulated or limited |
|---|---|
| Three source kinds ingested into one index with exact locators | Ingestion is an offline CLI, not an upload flow |
| A vision model reads every slide, including diagram-only slides | Video is indexed by transcript; frames are not analysed (the `ffmpeg` keyframe step is not built) |
| Every shown tutor answer passed a citation check (K1–K4 hard, K5–K6 soft) | The check proves the source exists and was quoted, **not** that the paraphrase is faithful — the faithfulness number in `eval:kb` is hand-graded |
| Questions generated from the material, quote-verified, and (for the demo slice) human-reviewed | One course slice; other subjects have no ingested material and the UI says so |
| Mastery model, planner, validator, resilience layer (v3), live URL verification of KB deep links | The passage of time (`sim_now`); student answers in the learner-simulation eval |
| Circuit breakers incl. the KB tool: `Break KB` makes the tutor refuse to answer uncited while assessments keep working | CN/RDBMS/OOP question banks are LLM-generated and **not** human-reviewed (`reviewed: false`) |

### Built before this hackathon / built during it

Bloom v3 — the agent loop, mastery model, planner/validator/repair, resilience layer, the five original tools, the learner-simulation harness and the first seven screens — **predates** the hackathon. The knowledge base, ingesters, vision step, cited tutor, citation validator, KB tool (tool 6), grounded question generation, `CONFUSION_SIGNAL`, `eval:kb`, and the Library / Tutor / Source Viewer screens were built **during** it. Tag the pre-hackathon state in git (`git tag pre-mmhack`) to make that split provable.

### Knowledge-base evaluation

`npm run eval:kb` reads only (no students or turns are written) and produces `docs/kb-eval-report.md` and `docs/kb-eval-results.json`: retrieval hit@5, first-pass and shown-answer citation validity, cross-source rate, diagram questions answered, correct refusals, hand-graded faithfulness and latency p50/p95, over a 20-question gold set you write in `backend/src/eval/kb/gold.json`. **No numbers are reported here until that gold set exists and the evaluation has been run.**

## Setup

```bash
# Postgres running locally with the pgvector extension available
createdb bloom
psql -d bloom -c "CREATE EXTENSION IF NOT EXISTS vector;"

cp backend/.env.example backend/.env   # fill in DATABASE_URL at minimum
npm install
npm run migrate
npm run seed
npm run test        # backend test suite
npm run dev          # backend on :4000, frontend on :5173 (or next free port)
```

Course material (offline; needs `GEMINI_API_KEY`, plus `pdftotext`/`pdftoppm` from poppler):
```bash
# 1. Put captions / PDFs in backend/kb-data/ and describe them in backend/kb-manifest.json (record each licence)
npm run ingest:video && npm run ingest:slides && npm run ingest:textbook   # ingest + embed + tag, idempotent
npm run kb:report                    # per-source counts and the subtopic × source-kind coverage grid
npm run kb:tune-tau -- --export dsa  # label 30 chunks, then re-run without --export to pick the tagging threshold
npm run kb:segments                  # KB segments → resources rows for the planner
npm run generate:questions -- --from-kb dsa
npm run mark:reviewed -- --kb dsa --list      # read every answer key, --reject <id> the wrong ones, then:
npm run mark:reviewed -- --kb dsa --approve
npm run eval:kb
```
Note: `npm run seed:reset` truncates `subjects`, which cascades to the knowledge base — re-run ingestion afterwards.

Optional content pipeline (needs `GEMINI_API_KEY` in `backend/.env`, offline only — never called at runtime):
```bash
npm run generate:questions          # or -- <subject-id> to scope one subject
npx tsx backend/src/scripts/mark-reviewed.ts dsa   # only after a human reads the answer keys
npm run embed:resources
npm run check:links
```

## Authentication, CORS and rate limits

- `POST /api/auth/register`, `POST /api/auth/login` (email + password, 8+ characters, scrypt-hashed) return a signed 7-day token; send it as `Authorization: Bearer <token>`. The SSE stream takes `?token=` because `EventSource` cannot set headers. `GET /api/auth/me` returns the signed-in student.
- With `AUTH_REQUIRED=true`, every `/api/students/:id/...` route, activity, assessment, goal and plan-version route checks that the token's student owns the resource (403 otherwise), `GET /students` returns only the caller, and `/agent/tick` sweeps only the caller. The server refuses to start without a usable `AUTH_SECRET`.
- Give the seeded demo student a login with `npm run set-password --workspace=backend -- demo@bloom.local <password>`.
- The frontend shows a sign-in screen when the API answers 401.
- CORS: browsers may call the API from `CORS_ORIGINS` (comma-separated); unset allows only `localhost` / `127.0.0.1`.
- Rate limits (per student, else per IP; in-memory, per process): sign-in 10/min, tutor and `/kb/chunks` `RATE_LIMIT_TUTOR_PER_MIN` (default 20), `/agent/run` and `/agent/tick` `RATE_LIMIT_AGENT_PER_MIN` (default 30). `RATE_LIMIT_DISABLED=true` turns them off (the tests do).

## Known limitations

- The knowledge base has no course material until you ingest some (`kb-manifest.json` ships empty). The DSA subtopic tree is arrays / linked lists / stacks & queues / trees / graphs / DP — it has no hash-table or trie subtopics, so pick demo material that maps onto linked lists, stacks and queues, or trees.
- With `LLM_ENABLED=false` (the repo default in `backend/.env`) the tutor returns extractive answers only; set it to `true` to see paraphrased, validated answers.
- The plan validator's C7 rule drops LEARN/PRACTICE activities that have no scheduled FINAL_TEST, and C5 rejects a plan in which a prerequisite is not yet mastered; both are v3 behaviour. A demo student needs diagnostic beliefs (the onboarding diagnostic) for plans, and therefore for `CONFUSION_SIGNAL` patches, to commit cleanly.
- Only DSA's question bank has been human-reviewed; CN/RDBMS/OOP are LLM-generated and flagged `reviewed: false` deliberately (see PRD §1's "never fake correctness").
- The Phase 9 evaluation harness (`backend/src/eval/`) is now wired to `npm run eval -- [--per-profile 2] [--days 21] [--subject dsa] [--seed 42]`, which writes `eval-results.json` for `GET /api/eval/latest`. In a first trial the simulated goals came back `infeasible` (the agent negotiated instead of planning) even over 60 days, so no assessments were recorded; the cause is not yet diagnosed, so there is no published eval report. `/api/eval/latest` still returns a clean 404 until a real one exists.
- The `SELECT ... LIMIT 1` audit is done: every `limit(1)` in `backend/src` is scoped by student or goal, and the one unscoped lookup (a test fixture, `ensureGoal`) is fixed. `npm run eval` creates synthetic students (`eval-…@bloom.sim`) in the same `students` table and does not delete them; remove them with `delete from students where email like 'eval-%@bloom.sim'`.
- Auth is **off by default** so the local demo and the test suite work unchanged. Set `AUTH_REQUIRED=true` and `AUTH_SECRET` (32+ random characters) to enforce it; see "Authentication" below. While it is off, any client that knows a student id can read and change that student's data.

## Tech stack

Express + TypeScript + Drizzle ORM + Postgres/pgvector on the backend; React + Vite + Tailwind on the frontend; Zod for validation end to end; Vitest for tests (320+ passing).
