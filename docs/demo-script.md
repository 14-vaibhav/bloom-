# Bloom v4 — Demo script (≈4 min; every beat is droppable)

Prerequisites: course material ingested (`npm run kb:report` shows all three kinds), `LLM_ENABLED=true`, demo student onboarded with the DSA slice and the diagnostic submitted, `npm run kb:segments` run, KB questions reviewed. Record the video the day before.

| # | Beat | What to do | What the judge sees |
|---|---|---|---|
| 1 | **Library** | Open Library | One lecture, one deck, one textbook; chunk counts by modality; coverage grid with a single-source gap flagged |
| 2 | **Tutor, cross-source question** | Ask something all three sources cover | One answer, three chips (a lecture timestamp, a slide, a page). Click each: the Source Viewer opens at that exact place, quote highlighted |
| 3 | **Tutor, diagram question** | Ask a question only a diagram slide answers | The cited slide has almost no text — the answer comes from the "What the vision model read" box |
| 4 | **Break citation** | Demo Panel → *Break citation*, then ask anything | The validator rejects the first attempt (open "How this answer was checked"), one repair round, then a clean answer or the extractive fallback |
| 5 | **Unanswerable question** | Ask something outside the course | The tutor declines and shows the closest passages |
| 6 | **Assessment** | Start one; note the predicted score; answer wrong on purpose | "Review these" chips per wrong answer; open one; try *Explain this* |
| 7 | **Ask twice, advance the clock** | Ask the tutor two questions about one subtopic, *Advance 1 day*, *Run agent* | The agent schedules an `IMMEDIATE_TEST` nobody asked for. Zero LLM calls (`CONFUSION_SIGNAL`) |
| 8 | **Plan Changes** | Open the new version | Trigger, diff, validation report; a LEARN/REVISION card reads "Lecture 5, 14:20–22:05" |
| 9 | **Break KB** | Demo Panel → *Break KB*, ask the tutor | The tutor refuses to answer without sources; start an assessment — it still works |
| 10 | **Eval** | Open Eval | The KB evaluation table with the measured numbers (only if `npm run eval:kb` has been run) |

Say unprompted: the citation check proves the quote exists in the cited passage, not that the paraphrase is faithful — that is the hand-graded number. Video is indexed by transcript; the visual modality comes from slides.

The v3 narration (plan negotiation, scope selection, resilience) is in `demo-script-v3.md`; beats 7–9 are that engine, keep them short.
