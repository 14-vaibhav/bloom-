# Bloom — next steps

## Working demo (blockers first)

Environment
- [x] Postgres running locally (`bloom` db, pgvector)
- [x] `pdftotext` / `pdftoppm` installed (poppler)
- [ ] `ffmpeg` — only needed if keyframe analysis gets built (not required for the demo)
- [ ] `GEMINI_API_KEY` in `backend/.env` is set and valid (used by ingest, vision, question generation, embeddings)
- [ ] `LLM_ENABLED=true` in `backend/.env` (otherwise the tutor gives extractive answers only)

Question bank (the one failing test)
- [ ] `npm run generate:questions` — 43 subtopics, only 8 questions on a few of them, most have 0 (need 20 each)
- [ ] `npx tsx backend/src/scripts/mark-reviewed.ts dsa` after a human reads the DSA answer keys
- [ ] `npm run embed:resources` (un-skips the 2 vector tests)

Knowledge base (currently empty)
- [ ] Create `backend/kb-data/` and add a caption file (.vtt), a slide PDF and a textbook PDF
- [ ] Fill in `backend/kb-manifest.json` (one entry per source, with licence)
- [ ] Choose material that maps to linked lists, stacks/queues or trees (DSA has no hash-table or trie subtopics)
- [ ] `npm run ingest:video && npm run ingest:slides && npm run ingest:textbook`
- [ ] `npm run kb:report` — check the subtopic x source-kind coverage grid
- [ ] `npm run kb:tune-tau -- --export dsa`, label ~30 chunks, re-run to pick the threshold
- [ ] `npm run kb:segments` so the planner sees KB resources
- [ ] `npm run generate:questions -- --from-kb dsa`, then `mark:reviewed -- --kb dsa --list / --reject / --approve`

Demo run
- [ ] `npm run seed` (note: `seed:reset` wipes the KB; re-ingest afterwards)
- [ ] Complete the onboarding diagnostic so the demo student has beliefs (plans and CONFUSION_SIGNAL patches need them)
- [ ] `npm run dev`, click through all 10 screens
- [ ] Rehearse: ask a tutor question and open the citation in the Source Viewer; ask two questions on one subtopic to trigger the patch; use Break KB, Break citation and the RAG toggle in the Demo Panel

## Evaluation
- [ ] Write 20 questions in `backend/src/eval/kb/gold.json`
- [ ] `npm run eval:kb` -> `docs/kb-eval-report.md`; hand-grade faithfulness
- [ ] Wire an `npm run eval` entry point for the v3 harness (Eval screen shows 404 until then)
- [ ] `git tag pre-mmhack` on the last pre-hackathon commit

## Housekeeping
- [ ] Resolve the `README.md` merge conflict (deferred)
- [ ] Generate drizzle snapshots for migrations 0005 and 0006

## Security / robustness
- [ ] Authentication and per-student ownership checks (none today)
- [ ] Lock down CORS; rate-limit LLM-backed endpoints
- [ ] Audit unfiltered `SELECT ... LIMIT 1` student lookups

## Later
- [ ] Upload flow instead of the CLI ingest
- [ ] Video keyframe analysis
- [ ] Human-review CN / RDBMS / OOP questions
- [ ] Extend the DSA subtopic tree
