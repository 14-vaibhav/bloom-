# Bloom — demo run sheet

A ~6-minute walkthrough. "Expected" lines come from how the code is built (README, `backend/src/tutor`, `backend/src/agent`); tick each off during rehearsal and note anything that differs. Nothing here has been run end-to-end yet — the Gemini quota blocked the tutor test.

## Before you start (once)

- [ ] Postgres up, `npm run migrate`, `npm run seed`
- [ ] Course material ingested and **tagged**: `npm run kb:report` shows every source with `tagged > 0`
- [ ] `backend/.env`: valid `GEMINI_API_KEY`, `LLM_ENABLED=true` (otherwise the tutor gives extractive answers only)
- [ ] `npm run generate:questions -- --from-kb dsa`, then approve the DSA questions with `mark:reviewed`
- [ ] Demo student has onboarding diagnostic beliefs (Setup Wizard → pick DSA → answer the diagnostic) — plans and `CONFUSION_SIGNAL` patches do not commit cleanly without them
- [ ] `npm run dev` → http://localhost:5173 (frontend), :4000 (backend)
- [ ] If you turned on `AUTH_REQUIRED=true`: `npm run set-password --workspace=backend -- demo@bloom.local <password>` and sign in first

## 1. The plan (1 min) — Dashboard, Study Plan

1. Dashboard: goal, deadline, mastery per topic, upcoming activities.
2. Study Plan: prerequisite-ordered sessions with deadlines.
- Say: mastery numbers come from a deterministic belief model; the LLM never assigns a number.

## 2. Cited tutor (2 min) — AI Tutor, Library

1. Ask: *"Why does reading the i-th element of a linked list take linear time?"* (covered by MIT 6.006 lecture 2.)
2. Expected: an answer with citation chips; click one → Source Viewer opens at the lecture timestamp (or textbook page).
3. Ask a question the material covers in the book: *"How does a binary heap store its elements in an array?"*
4. Expected: citation to *Open Data Structures* with a page number.
5. Ask something not in the material: *"How does TCP congestion control work?"*
6. Expected: the tutor declines and shows the nearest passages instead of inventing an answer.
7. Library: per-source counts and the subtopic × source-kind coverage.

## 3. The citation validator (30 s) — Demo Panel

1. Demo Panel → **Inject Broken Citation**, then ask any question.
2. Expected: the first draft fails the check, one repair round runs, and the shown answer still has valid citations (or an extractive fallback). A broken citation never reaches the screen.

## 4. The agent reacts (2 min) — Demo Panel, Agent Activity Stream, Plan Version Diff

1. Demo Panel → **Simulate Miss** (marks the next activity missed), then **Run Agent**.
2. Agent Activity Stream: the run shows trigger, scope (a single miss should be a PATCH with no LLM calls) and the new plan version.
3. Plan Version Diff: shows exactly what moved.
4. Confusion signal: in the tutor, ask two questions on the same subtopic while its confidence is below 0.70, then **Run Agent**. Expected: a `CONFUSION_SIGNAL` run that inserts an `IMMEDIATE_TEST`, with zero LLM calls.
5. Time: **Advance 24h / 72h** then **Run Agent** to show forgetting-risk and deadline-risk triggers.

## 5. Resilience (30 s) — Demo Panel

1. **Break RAG Service (30s)**, then open Study Plan / run the agent.
2. Expected: planning continues using the last-known-good resource, marked `provisional`, and re-plans when the tool recovers.
- The panel has no button for breaking the knowledge base itself; `POST /api/sim/break-tool {"tool":"kb","duration_sec":30}` does it from the command line. Expected: the tutor refuses to answer uncited while assessments keep working. (Untested.)

## 6. Honest numbers (30 s) — Model & KB Evaluation

- `npm run eval:kb` first (needs the quota and the 20-question gold set; 15 are written, the 5 diagram questions need slides). Then open the screen.
- `/api/eval/latest` (learner simulation) returns 404 until `npm run eval` produces a real report — say so rather than showing nothing.

## If something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| Tutor errors on every question | Gemini quota exhausted (embedding the query) | Enable billing or wait for the reset |
| Tutor answers are extractive, not paraphrased | `LLM_ENABLED=false` | Set it to `true`, restart the backend |
| Library shows chunks but no coverage | Chunks not tagged | Re-run `npm run ingest:textbook` / `ingest:video` |
| Plan won't commit | No diagnostic beliefs | Finish the Setup Wizard |
| 401 on every call | `AUTH_REQUIRED=true` | Sign in, or set it back to `false` |
