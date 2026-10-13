# Bloom — Demo Video Script (≈3:45)

Current live state on localhost: demo student has a fresh **DSA** goal (deadline Dec 15, target mastery 75% across 24 subtopics), Demo Panel is available bottom-right. The plan is in a **NEGOTIATE** scope — that's real, not staged: use it.

---

## [0:00–0:25] Cold open — what Bloom is and why it's agentic

*(Screen: Dashboard)*

> "Most study planners do one thing: goal in, timetable out. Bloom is different — it's a closed loop. It observes what actually happened, updates its beliefs about what the student knows, decides whether that changes anything, and only then acts. That loop runs on its own clock, not on a button click. Everything on screen right now is live data from a running Postgres database — nothing here is mocked."

**What to point at:** the status pill (top of dashboard), the three gauges, today's activities.

---

## [0:25–1:00] Dashboard — three signals, not one bar

*(Point at attendance / trajectory / arrival gauges one at a time)*

> "A typical progress bar collapses everything into one number. Bloom keeps three separate signals, because they mean different things: **attendance** — is the student actually showing up to sessions; **trajectory** — when they do show up, are they learning at the rate the model predicted; **arrival** — at this pace, do they land before the deadline. A student who's behind because they keep missing sessions needs a different fix than one who's behind despite perfect attendance. Merging these into one bar would hide exactly the distinction that makes this system look intelligent instead of just decorative."

---

## [1:00–1:45] Study Plan — the negotiation is real

*(Navigate to Study Plan screen)*

> "Here's the plan the agent actually built. Notice the badge says **NEGOTIATE**, not a clean 'on track.' I asked for 75% mastery across all 24 DSA subtopics in about six weeks with roughly two and a half hours a day. The agent did the arithmetic — required study hours versus what's actually available before the deadline — and it doesn't fit. A lot of study apps would silently generate a schedule anyway and let the student discover the problem in week five. Bloom refuses to do that. It still builds a best-effort plan — you can see activities scheduled here — but it flags the plan as infeasible and offers quantified options: push the deadline out, add time per day, or drop lower-weight subtopics from the target. That refusal to fake a workable schedule is one of the seven things that make this agentic rather than just automated scheduling."

*(Click a study session card)*

> "Click any card and you get the 'why' — which gap this closes, the priority score behind it, which resource was picked and why, and whether that resource's URL was actually verified live before being recommended."

---

## [1:45–2:20] Agent Activity — watching the judgment happen

*(Navigate to Agent Activity screen)*

> "This is the feed I'd point to first if someone doubts there's real judgment happening here. Every run the agent makes is logged: which trigger fired, what scope it picked, which tools it called, whether it needed the LLM or fell back to a deterministic rule, and how long it took. The scope decision is the important part — a single missed session gets a PATCH: no LLM call, sub-second, because one miss shouldn't blow up a whole plan. But a low test score, or — like right now — an impossible deadline, gets a FULL replan or a negotiation, because a wrong belief about what the student knows contaminates every downstream decision. That's not a hardcoded if-statement per event type; it's the trigger evaluator weighing severity and coalescing multiple triggers into one decision, which you can see logged right here: 'INITIAL_GOAL + AVAILABILITY_CHANGE → FULL, 2 triggers coalesced.'"

---

## [2:20–2:55] Demo Panel — time moves, the agent notices on its own

*(Open Demo Panel, click "Advance 1 day", then "Miss next session", then "Run agent")*

> "This panel fast-forwards simulated time so I don't have to wait real days for the story to unfold. I'll advance the clock a day and mark the next session as missed — simulating a student who didn't show up. Now watch the Agent Activity feed as I run the agent again: nobody told it a session was missed. It detected that on its own during observation, decided this was a single miss — not a pattern — so it issued a cheap PATCH instead of a full replan, and logged exactly why."

---

## [2:55–3:25] Break RAG — failure recovery, not just a try/catch

*(Click "Break RAG (30s)", then "Run agent" again, then after ~30s "Restore RAG")*

> "Now I'll deliberately break one of the agent's tools — the resource-recommendation service. After repeated failures its circuit breaker trips open. Watch what the agent does: it doesn't stop planning. It reuses the last known-good resource for that subtopic, marks that activity `provisional`, and keeps going — because degrading the quality of a decision is fine, but degrading the integrity of the plan's data is not. Once I restore the tool, the agent notices the recovery on its own and re-plans the provisional work — nobody asked it to."

---

## [3:25–3:45] Close — deterministic core, LLM only where judgment is needed

*(Back to Dashboard, or a static slide)*

> "Under the hood: mastery scores, scheduling, validation — all deterministic code, because a study plan has to be correct, not just plausible. The LLM only gets called for things that genuinely need judgment — diagnosing *why* an answer was wrong, choosing between resources, writing the plain-English summary. Turn the LLM off completely and the whole loop still runs, because the thing that makes this agentic was never which model answered — it's the judgment about when to act, when a single miss doesn't matter, and when to admit the goal as stated isn't reachable."

*(End card)*

---

## Appendix — the "agentic" checklist, if you get asked to justify it

1. **Starts on its own** — the clock scheduler ticks without a user action; runs with `no_action` outcomes are logged, not hidden.
2. **Decides whether to act** — the trigger evaluator can output no-op with a reason.
3. **Decides its own scope** — PATCH vs FULL vs NEGOTIATE, based on severity and coalesced triggers, not a fixed per-event-type rule.
4. **Acts on predicted future state** — active recall is scheduled from a retention forecast, before anything has actually been forgotten (not shown in this cut, but present in `core/recall.ts`).
5. **Revises its model, not just its plan** — learn-rate recalibration after each observation (`core/belief.ts`), separate from replanning.
6. **Gates its own output** — the 12-check plan validator with a real repair loop, capped at 3 rounds.
7. **Refuses an impossible goal** — the NEGOTIATE path shown live in this demo, with quantified options instead of a fabricated schedule.

## Recording notes

- Don't type anything live — the DSA goal, plan, and activities are already seeded.
- Rehearse the Break RAG beat once — it's timing-sensitive (30s window before "Restore").
- Skip `/eval` entirely — the evaluation harness report isn't wired to a CLI yet, so that screen is empty.
- If you want a second, harder beat: composing and submitting an assessment on `arr_traversal`, `arr_prefix_sum`, or `arr_binary_search` (the only subtopics with a real, human-reviewed question bank right now) shows the predicted-vs-actual score comparison live.
