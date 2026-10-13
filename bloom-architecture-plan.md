# BLOOM — Autonomous Learning Agent
### Complete architecture & implementation plan · v3 (rubric-aligned)

> Supersedes `lodestar-architecture-plan.md` (the pre-rename v2-era draft). This document merges the Bloom v3 PRD (rubric map, failure-recovery layer, evaluation harness, live external tool interaction, 7-screen cut, re-costed phase plan) with the implementation-level detail the PRD assumes but doesn't spell out — exact schema, tool signatures, worked scenarios, repo layout, and a coding-agent build order. Treat this file as the single source of truth; the PRD's own section numbers (§1–§24) are kept so the two stay cross-referenceable.

---

## §0 The honest starting point

"Autonomous learning agent" is the single most-attempted problem statement in every agentic hackathon, and most submissions will be: form → LLM prompt → pretty timetable → maybe a "regenerate" button. You will not win with a nicer calendar UI. Three things make it impossible to mistake for a chatbot, and everything below serves them:

1. **The plan carries predictions, and predictions get falsified.** Every scheduled activity ships an explicit `predicted_score`. Replanning is triggered by *prediction error*, not by `if (missed) { reschedule() }`. This reframes the system from "scheduler" to "closed-loop controller with a model of the student that can be wrong."
2. **The agent negotiates when the goal is infeasible.** It does not silently produce a fantasy plan — it states the conflict, makes a defensible tradeoff against the confirmed blueprint weighting, and quantifies the options.
3. **Verification is a visible gate, not a claim.** A validator runs after every plan, prints a pass/fail table of named constraints, and can *reject the agent's own output* and force a repair round — on screen, in front of the judge.

**Framing rule for the pitch and README:** never describe architecture as a feature. "We use three LLM agents" scores zero. "The model's judgement changes which tools get called — when it decides to test rather than teach, retrieval is skipped entirely" scores under Agentic Workflow. Same fact, different framing. Show two runs side by side with different tool traces.

**Analogy for the pitch:** a study timetable is a printed set of driving directions. Bloom is autopilot — it holds the destination, watches the road, notices when you missed the exit, and recomputes. Same destination, continuously re-derived route.

---

## §1 Rubric map

| Criterion | Weight | Where it's earned | Target |
|---|---|---|---|
| Agentic workflow & autonomy | 25% | §7 seven loci of agency · §10 loop · §11 triggers & scope · §12 explore/exploit | 23/25 |
| Tool/environment interaction | 15% | §13 five tools, 21 ops, logged dispatcher · §14 live external fetch · §16.2 degraded-mode adaptation | 13/15 |
| Adaptation & failure recovery | 15% | §8 learner adaptation · §16 system failure recovery | 13/15 |
| Technical implementation | 15% | §18 schema · §15 deterministic/LLM split · §23 test protocol | 13/15 |
| Problem relevance & innovation | 10% | §2 · §6 pre-emptive recall · §17 calibration evidence | 8/10 |
| Prototype functionality & UX | 10% | §20 seven screens, polished | 8/10 |
| Evaluation, verification & robustness | 10% | §19 validator · §17 eval harness · §16.5 chaos testing | 9/10 |

Never cut: the eval harness, the resilience layer, the Agent Activity screen. Those three are where this document most exceeds a typical submission.

---

## §2 Product

**Name:** Bloom
**Pitch:** A learning autopilot — it predicts how each study session will go, tests whether it was right, and rewrites your plan the moment reality disagrees.

**Core design rule:** do not optimise for "generate the best study timetable." Optimise for "continuously determine the best next learning action given what the student actually knows, what they've forgotten, what they got wrong, how much time is left, and whether the goal is still reachable."

**Problem:** Study plans die on contact with real life. Students miss sessions, availability collapses during exam week, and a topic they thought was fine turns out to be a hole. No tool knows *how wrong it was* — it never compares what it expected you to score against what you scored.

**Target user:** College students preparing for placements — real deadline, well-defined prerequisite graph, chaotic availability, objectively measurable knowledge. Chosen because judges understand the domain instantly and the prerequisite graph is real, not decorative.

**Why it is genuinely autonomous:** it runs on a tick with no user prompt, decides *whether* to act (and logs "no action needed" outcomes with reasons), chooses the *scope* of its intervention, calls tools to gather evidence it wasn't given, revises its own model of the student (not just the plan), and gates its own output through a validator that can reject it.

**Why it is different from "ChatGPT, make me a study plan":** ChatGPT has no memory of what it predicted, no ability to observe whether it was right, no clock, no constraint checker, and no mechanism to override its own earlier decision. Bloom's core artefact is not the plan — it is the *diff between plan versions and the reason for it*.

**Anti-goal:** goal in → LLM → timetable → done.

**Scope discipline:** no auth beyond a student picker, no mobile, no real web crawling beyond the one live-verification fetch in §14, no collaborative features, no LLM chat interface. Every hour goes into the loop being visible and correct.

---

## §3 User workflow

1. **Select subject** — DSA · Computer Networks · RDBMS · OOP. Subjects are pure data; adding a fifth requires no agent code change.
2. **Set deadline & availability** — max 60 days, min 7, validated server-side. Stores `total_days`, `total_available_hours`, `intensity`. Deadline is immutable unless explicitly changed (a logged `GOAL_CHANGE`-class `AVAILABILITY_CHANGE` trigger).
3. **Confirm blueprint + diagnostic** — Bloom shows its intended decomposition with subtopic weights; the student may drop or reweight. That confirmed weighting is what makes later tradeoffs defensible — without it, "which subtopic do we sacrifice" is arbitrary. Then a 15-question diagnostic seeds beliefs.
4. **Plan v1** — deadline-aware, prerequisite-ordered, every activity carrying a prediction and a one-sentence reason.
5. **The loop** — study → test → active recall → retest → final subtopic test → weakness detection → revision → mastery update → daily summary → automatic adaptation, indefinitely, until the deadline or mastery is reached.

---

## §4 Domain model

```
Subject → Topic → Subtopic → Concept (tag; questions and weaknesses attach here)
```

**Mastery lives at subtopic grain.** Topic and subject readiness are weighted rollups, never stored. "Tree traversal recursion — 22%, four repeated errors on base-case handling" is a diagnosis; "Trees — 48%" is a complaint.

- **DSA is demo-grade:** 6 topics, 24 subtopics (~4 subtopics/topic), full prerequisite DAG, full resource + question coverage.
- **CN / RDBMS / OOP are catalog-grade:** 2 topics × ~3 subtopics each per subject (~6 subtopics/subject), enough to prove the multi-subject claim without burning the week on content.

Blueprint weights are set per subtopic (confirmed by the student at onboarding) and sum to 1 within a subject; topic- and subject-level "readiness" is always `Σ weight_i × mu_i` computed on read, never persisted, so it can never drift out of sync with the underlying beliefs.

---

## §5 Activity types

| Type | Purpose | Length | Scheduling rule |
|---|---|---|---|
| `LEARN` | First exposure | 30–60 min | Prerequisites ≥ 0.6 |
| `PRACTICE` | Drill | 30–45 min | `mu` between 0.35 and target |
| `IMMEDIATE_TEST` | Measure after learning | 10 min | Same day as last `LEARN` |
| `ACTIVE_RECALL` | Retrieval practice | 10–15 min | +3d, +10d, decay-adjusted |
| `REVISION` | Targeted repair | 20–30 min | On recall failure or low score |
| `FINAL_TEST` | Subtopic sign-off | 15–20 min | All learn/practice done AND `mu ≥ target − 0.1` |

Every activity carries `predicted_score`, `expected_mastery_after`, and a one-sentence `reason` shown in the UI. There is no `DROP` activity type — sacrificing a subtopic under infeasibility is a planning-time `DEFER` decision (§16, repair operators), not something scheduled.

---

## §6 Active recall & spaced repetition

```
base intervals: +3d, +10d
recall ≥ 0.85    → next interval × 2.0 (max 21d)
recall 0.5–0.85  → × 1.0
recall < 0.5     → × 0.4 AND insert REVISION
```

Decay:
```
retention_estimate(t) = mu × exp(−t / strength)
strength = 3 + 12 × mu × confidence     (days)
```

When `retention_estimate` for a high-weight subtopic falls below `target × 0.8`, `ACTIVE_RECALL_FAILURE` fires **pre-emptively** — before anything has failed. There is no event being reacted to; the agent is acting on a forecast it computed. This is the single cheapest, highest-signal demo beat available: nobody asked for it, and the feed shows the forecast that triggered it.

---

## §7 What is agentic (say exactly this, nothing more)

Seven loci. Each has a visible artifact in the demo or it doesn't count.

1. **Starts on its own** — clock tick, no button. `agent_runs` rows with no user action.
2. **Decides whether to act** — trigger evaluator can output `NONE` with a logged reason.
3. **Decides its own intervention scope** — one miss → `PATCH`, zero LLM calls, sub-second. A 40% score → `FULL`, because a wrong student model contaminates every downstream estimate.
4. **Acts on predicted future state** — pre-emptive recall from retention decay (§6).
5. **Revises its model, not just its plan** — `learn_rate` and `format_efficacy` change. Adapting the plan is scheduling; adapting the model is agency.
6. **Gates and rejects its own output** — validator with a real rejection path and bounded self-repair (§19).
7. **Refuses an impossible goal** — negotiation with quantified options instead of a plausible fake schedule (§11).

Plus: **exploration over exploitation** — the largest gap gets a *test*, not nine hours of study, because confidence is 0.30 (§12).

**Not agentic, don't claim it is:** the scheduler, the BKT math, the validator checks, the CRUD, the diff engine. Those are the agent's hands, not its judgement.

**LLM-drives-tools evidence (required for the 25% criterion).** The Strategist's action choice must observably change the tool sequence: choosing `IMMEDIATE_TEST` for a subtopic skips RAG retrieval entirely for that subtopic. Log both traces and show them side by side. This is the direct answer to "your control flow is hardcoded, so the LLM isn't driving anything."

---

## §8 Mastery model

Deterministic; **the LLM cannot assign numbers.** Per subtopic: `mu`, `confidence`, `learn_rate`, `evidence_count`, `retention_estimate`, `strength_days`, `format_efficacy`.

**Update** (score `s`, `n` questions, difficulty `d`):
```
w      = min(1, n/8) × difficulty_reliability[d]
s_adj  = clamp(s × difficulty_factor[d], 0, 1)     easy .85 · med 1.0 · hard 1.18
α      = 0.15 + 0.45 × (1 − confidence)
mu'    = mu + α × w × (s_adj − mu)
conf'  = 1 − (1 − confidence) × (1 − 0.5 × w)
```

**Decay each tick:** `confidence ← confidence × 0.97^days_since_observation`

**Learn-rate recalibration:**
```
predicted_gain = learn_rate × hours_since_last_observation
actual_gain    = mu' − mu_at_last_observation
learn_rate    ← clamp(learn_rate × (0.5 + 0.5 × actual_gain/max(predicted_gain, 0.01)), 0.02, 0.35)
```

Every update writes an append-only `mastery_observations` row. The LLM interprets ("this is implementation precision, not conceptual") but never assigns.

**Worked example (implementation test target):** a subtopic at `mu=0.68, confidence=0.55` observes `s=0.40` on 5 medium questions → `mu'` drops sharply toward the low 0.4–0.5 range and `learn_rate` roughly halves once the actual gain is compared against what was predicted for the hours invested. Pin the exact constants (`difficulty_reliability`, `difficulty_factor`) during Phase 3 (§23) and lock this example as a Vitest assertion — it is the test that proves the belief-update code, not the formula on paper, is correct.

**Mastery badge** — all four, or amber with the reason shown: `mu ≥ target` · `confidence ≥ 0.70` · evidence from ≥2 separate assessments, one at difficulty ≥ target · observed within 14 days. A green badge can demote itself as confidence decays.

---

## §9 On-track determination

Three independent signals, shown separately — a single progress bar hides exactly what makes the system look intelligent.

| Signal | Formula | Threshold |
|---|---|---|
| Attendance | `completed / (completed + missed)`, 14d | < 0.60 → stated availability isn't real |
| Trajectory | EMA of `actual_gain / predicted_gain` | < 0.70 → learning slower than modelled |
| Arrival | `projected_completion` vs `deadline` | see below |

```
required_hours   = Σ_subtopics max(0, target − mu) / learn_rate
available_hours  = free slot minutes (sim_now → deadline) / 60
projected_completion = sim_now + required_hours / effective_daily_hours
buffer_days = deadline − projected_completion

status = buffer ≥ 3d and attendance ≥ .7        → ON_TRACK
         buffer 0–3d, or trajectory < 0.7        → AT_RISK
         buffer < 0                              → BEHIND
         required > available after compression  → INFEASIBLE
```

---

## §10 Agent loop

```
1  OBSERVE            deltas since last tick + clock-driven miss detection
2  UPDATE BELIEFS     BKT-lite · decay · learn-rate recalibration · question_state
3  EVALUATE TRIGGERS   triggers → severity → scope, coalesced and debounced
4  ANALYZE            gap engine (deterministic) + Diagnostician (LLM)
5  DECIDE             per-subtopic action + budget (+ Strategist)
6  RETRIEVE           RAG · question bank · calendar   ← skipped when action doesn't need it
7  PLAN               build (FULL) or patch (PATCH)
8  VALIDATE           hard + learning checks
9  REPAIR             ≤3 rounds → else NEGOTIATE
10 COMMIT             single transaction: plan_version + activities + calendar + run status
11 ACT / INFORM       emit events, update daily summary
```

Every phase writes its completion to `agent_runs.last_completed_phase` so an interrupted run is resumable (§16.3). **Phases 1–9 must write nothing but `agent_events`** — all state mutation happens in phase 10, in one transaction. This single rule is what makes resumability trivial instead of a nightmare; enforce it in code review.

**What the agent observes:**

| Observation | Source | Emitted when |
|---|---|---|
| `ACTIVITY_COMPLETED` | activity FSM | student marks done (self-rated difficulty 1–5) |
| `ACTIVITY_MISSED` | clock tick | `sim_now > scheduled_end` and status still `planned` |
| `ASSESSMENT_SUBMITTED` | question bank | score + per-concept tags |
| `AVAILABILITY_CHANGED` | constraints API | student edits weekly availability or deadline |
| `CALENDAR_EVENT_ADDED` | calendar tool | new busy block conflicts with a session |
| `RESOURCE_FEEDBACK` | activity completion | student marks resource unhelpful, or live-check marks it dead (§14) |
| `TOOL_STATE_CHANGED` | dispatcher | a circuit breaker opens, half-opens, or closes (§16.1) |
| `TIME_ADVANCED` | simulated clock | demo button or cron |

---

## §11 Triggers & scope

| Trigger | Condition | Scope |
|---|---|---|
| `INITIAL_GOAL` | No plan exists | FULL |
| `MISSED_SESSION` | 1 missed | PATCH |
| `MISSED_STREAK` | ≥3 in 7d or attendance < 0.6 | FULL |
| `LOW_SCORE` | assessment < 0.5 on a weighted subtopic | PATCH → FULL if ≥2 affected |
| `HIGH_PREDICTION_ERROR` | \|actual − predicted\| > 0.15 | FULL |
| `ACTIVE_RECALL_FAILURE` | recall < 0.5 or `retention_estimate < target×0.8` | PATCH |
| `DEADLINE_RISK` | `buffer_days < 3` | FULL |
| `AVAILABILITY_CHANGE` | delta > 20% or deadline moved | FULL |
| `RESOURCE_FAILURE` | resource unhelpful, dead, or unreachable | PATCH |
| `TOOL_DEGRADED` | a tool tripped its circuit breaker | PATCH in degraded mode (§16.2) |
| `FEASIBILITY_BREACH` | required > available after 3 repairs | NEGOTIATE |

One replan per tick. Same-class triggers merge. FULL supersedes PATCH; NEGOTIATE supersedes all. Log `"3 triggers coalesced → FULL"`.

**Zero LLM calls on a `PATCH` run is a feature, not a gap** — it shows the agent scales its own effort to the situation. Say that out loud in the demo.

**NEGOTIATE output** — no fake schedule:
```
Required 40h · available 20h · deadline unchanged.
A) Extend deadline by 7 days
B) Add 45 min/day
C) Drop Tries and Advanced Graphs (12% of subject weight)
Recommended: B — smallest change that restores a 2-day buffer.
```

---

## §12 Gap engine & action selection

```
gap            = max(0, target − mu)
severity       = gap × blueprint_weight
blocking       = 1 + 0.4 × (# unmastered dependents)
urgency        = 1 / (1 + days_until_needed / 7)
learnability   = learn_rate / max_learn_rate
uncertainty    = (1 − confidence) × 0.25
retention_risk = max(0, target − retention_estimate) × blueprint_weight

priority = 100 × (0.35×severity + 0.15×severity×(blocking−1) + 0.15×urgency
                + 0.08×learnability + 0.10×uncertainty + 0.17×retention_risk)
```

Deterministic action baseline; Strategist may override **with logged justification**:
```
confidence < 0.40 and weight > 0.10  → IMMEDIATE_TEST
retention_estimate < target × 0.8    → ACTIVE_RECALL
mu < 0.35                            → LEARN
mu < target                          → PRACTICE
mu ≥ target and activities complete  → FINAL_TEST
else                                 → NONE
```

**Worked example (qualitative — lock exact numbers as a Phase 3 test, not here):** a subtopic can have the single largest gap in the table and still not rank first, and its action can be `IMMEDIATE_TEST` rather than `PRACTICE`, purely because `confidence` is low (e.g. 0.30). The agent is refusing to spend hours studying against a belief it doesn't trust yet — it tests first. **Explain this exact row to the judges.** It is the clearest possible proof that the system reasons rather than sorts. Reproduce it as a fixed fixture in the Phase 3 test suite so the demo always shows the same subtopic doing this.

---

## §13 The five tools

Performance · Educational RAG · Calendar · Question Bank · Student State. 21 operations behind one dispatcher that logs `run_id, seq, phase, tool, operation, input, output_summary, latency_ms, ok, error_class`. Any FULL replan uses at least three distinct tools. PATCH runs often use two and zero LLM calls — that restraint is evidence of judgement, not a gap.

**13.1 Performance / LMS Tool** (4 ops)
```ts
get_student_performance(student_id, subject_id) → {
  overall_mastery, trend_7d, completion_ratio_14d, total_study_minutes_14d,
  assessments_taken, last_activity_at
}
get_subtopic_performance(student_id, subtopic_ids?) → [{
  subtopic_id, mastery, confidence, evidence_count, last_observed_at, days_stale,
  recent_scores, trend, minutes_invested, mastery_gain_per_hour,
  retention_estimate, strength_days, format_efficacy: { video, article, practice }
}]
get_assessment_history(student_id, limit) → [{
  assessment_id, taken_at, subtopic_ids, difficulty, score, predicted_score,
  prediction_error, per_question: [{ q_id, subtopic_id, concept_id, correct, time_sec }]
}]
get_completion_history(student_id, since) → [{ activity_id, subtopic_id, status, scheduled_start, actual_duration_min, self_rated_difficulty }]
```

**13.2 Educational RAG Tool** (2 ops)

Corpus: ~150 hand-seeded real resources (title, provider, URL, type, difficulty 1–5, duration_min, topic/subtopic/concept tags, quality 0–1, description), embedded into pgvector at seed time. Honest RAG on a curated corpus — say so; do not pretend the internet was indexed. `search_learning_resources` is also where the §14 live-verification behaviour lives.
```ts
search_learning_resources({ subtopic_id, target_difficulty, max_duration_min, types, exclude_ids, k }) → [{
  resource_id, title, type, provider, url, difficulty, duration_min, quality,
  subtopic_ids, concept_ids, similarity, summary,
  verification: { status: "live"|"dead"|"unverified", last_checked_at }
}]
get_resource_details(resource_id) → { ...full record, prerequisites, covers_concepts }
```

**13.3 Calendar Tool** (5 ops) — internal simulated calendar (a table), demo-deterministic.
```ts
get_existing_events(student_id, from, to) → [{ event_id, title, start, end, source: "external"|"bloom", busy }]
get_available_slots(student_id, from, to, min_slot_min) → [{ start, end, minutes, day_of_week, energy_weight }]
create_learning_session({ activity_id, start, end, title }) → { event_id, ok }
modify_learning_session({ event_id, start, end }) → { ok }
delete_learning_session({ event_id }) → { ok }
```
`energy_weight` is derived from historical completion rate by time-of-day — cheap to compute, reads as genuinely adaptive: the agent prefers slots the student actually shows up to.

**13.4 Question Bank Tool** (4 ops)
```ts
get_questions({ subtopic_ids, difficulty, count, exclude_seen }) → [{ q_id, subtopic_id, difficulty, stem, options, correct_index, concept_id }]
generate_assessment({ student_id, subtopic_ids, purpose: "diagnostic"|"checkpoint"|"final", count }) → { assessment_id, questions, predicted_score, blueprint }
submit_answers({ assessment_id, answers }) → { score, per_subtopic, per_concept, predicted_score, prediction_error }
compose_final_test({ student_id, subtopic_id }) → { assessment_id, questions }   // must carry forward previously-incorrect questions
```
`predicted_score` is written **at generation time**, before the student answers — the mechanism that makes falsification real, and a killer predicted-vs-actual UI element.

**13.5 Student State Store Tool** (6 ops)
```ts
get_student_state(student_id) → full state object
patch_student_state(student_id, patch) → { version, ok }
append_observation({ student_id, type, payload }) → { observation_id }
get_plan(student_id, version?) → plan
save_plan_version({ student_id, plan, parent_version, reason, trigger, diff }) → { version }
get_constraints(student_id, effective_at) → constraints
```

---

## §14 External environment interaction

Every tool reading only your own Postgres invites the judgement "that's a sandbox, not an environment." One tool must genuinely reach outside.

**RAG live verification.** Before recommending a resource, the RAG tool issues a `HEAD` (falling back to a ranged `GET`) against the resource URL with a 3-second timeout:

- **200** → recommend; update `resources.last_verified_at`, `is_live = true`
- **404/410** → mark `is_live = false`, exclude from results, fire `RESOURCE_FAILURE`, pick the next-best candidate, log *"Resource res_112 returned 404 — excluded and replaced with res_204."*
- **timeout / network error** → recommend anyway but flag `unverified` in the activity card; do not mark dead on one timeout
- **whole-network failure** (3 consecutive) → circuit breaker opens, RAG enters degraded mode (§16.2)

This gives a real external dependency, a real failure surface, and a real adaptive response — and scores under both Tool/Environment Interaction and Adaptation & Failure Recovery. Cache verification results for 24 simulated hours so the demo doesn't hammer anyone's server.

Google Calendar read-only is the fallback alternative but carries OAuth risk on demo day. Skip unless everything else is finished.

---

## §15 LLM vs deterministic

| LLM decides | Code decides |
|---|---|
| Root cause of errors (**Diagnostician**, Haiku) | Mastery, confidence, learn rate |
| Resource choice among top-3 fit-scored + justification (**Curator**, Haiku) | All calendar arithmetic, collision detection |
| Strategy, budget, negotiation and recovery wording (**Strategist**, Sonnet) | Prerequisite ordering |
| Daily summary phrasing | Feasibility, progress, deficit, question scoring |
| — | Validation, repair limits, persistence |

Three LLM calls per FULL replan (Haiku ×2 concurrent, Sonnet ×1). Zero on most PATCH runs. Every output is Zod-validated with one retry, then a deterministic fallback. Response cache keyed on input hash — makes reruns instant and demo-safe. `LLM_ENABLED=false` must run the entire demo correctly; this is the Phase 6 gate (§23) and the single most important reliability guarantee in the project.

State this table on a slide: "We used an LLM where judgement is needed and code where correctness is needed" is a mature answer that judges reward; "we asked the LLM to do everything" is not.

---

## §16 Failure recovery

Two kinds of failure. Most submissions only handle the first.

- **Learner failure** — missed sessions, low scores, forgetting. Covered by §6, §8, §11.
- **System failure** — tools erroring, models returning garbage, the process dying mid-run. Covered below. This is 15% of the score and the half that's easiest to underbuild.

### 16.1 Tool-level resilience

Every tool call goes through the dispatcher's resilience wrapper:
```
retry:            2 attempts, exponential backoff 200ms → 600ms, transient errors only
                  (timeout, 5xx, connection reset — never on validation errors)
timeout:          3s for external fetch, 1s for DB reads, 8s for LLM
circuit breaker:  3 consecutive failures → OPEN for 60 simulated seconds
                  → HALF_OPEN (single probe) → CLOSED on success
```
State lives in `tool_health` so it survives restart:
```sql
tool_health (tool_name TEXT PK, state TEXT, consecutive_failures INT,
             opened_at TIMESTAMPTZ, last_error TEXT, last_success_at TIMESTAMPTZ)
```
Every failure and every state transition writes an `agent_events` row. The feed shows them.

### 16.2 Degraded-mode adaptation — the part that scores

A circuit breaker that just returns an error is engineering. An agent that *changes its plan because a tool is unavailable* is agentic. Each tool has a defined degraded behaviour:

| Tool down | Degraded behaviour | Logged as |
|---|---|---|
| **RAG** | Reuse the last known-good resource for that subtopic; if none, schedule the activity as `PRACTICE` from the question bank instead of `LEARN` | *"RAG unavailable — reusing res_204 for Binary Search, flagged for review."* |
| **Calendar** | Fall back to the stored weekly availability template, ignoring external events; mark the plan `provisional` and re-verify when the tool recovers | *"Calendar unavailable — planned against availability template; plan marked provisional."* |
| **Question Bank** | Defer assessment activities by one day rather than dropping them; never substitute a study activity for a test | *"Question bank unavailable — 2 assessments deferred to Nov 9."* |
| **LLM** | Deterministic baselines for all three specialists | *"LLM unavailable — deterministic action selection used."* |
| **State store** | Hard failure. Abort the run cleanly, mark `agent_runs.status = 'failed'`, change nothing | *"State store unavailable — run aborted, no changes committed."* |

The general principle, said this way to judges: **degrade the quality of the decision, never the integrity of the state.**

When a tool recovers, fire `TOOL_RECOVERED` → the agent re-plans anything it marked `provisional`. Recovery is itself an autonomous action.

### 16.3 Run resumability

```sql
agent_runs (... status TEXT CHECK (status IN ('running','completed','failed','abandoned')),
            last_completed_phase SMALLINT, error_class TEXT, error_detail TEXT,
            recovered_from_run_id UUID NULL)
```
On backend startup, a reconciler scans for `status = 'running'`:
- Phase ≤ 9 (nothing committed) → mark `abandoned`, re-evaluate triggers from scratch on the next tick. Safe because phases 1–9 are side-effect free.
- Phase 10+ (commit started) → verify the transaction landed; if it did, mark `completed`; if not, roll forward from the persisted plan draft.

### 16.4 Idempotent commit

Plan version, activities, calendar writes, and run status are **one** transaction. A crash between "save plan" and "write calendar" must be impossible, not merely unlikely. Idempotency keys on the mutating endpoints so a double-submitted assessment or double-clicked "complete" does not corrupt state.

### 16.5 Malformed input and edge cases

Each returns a sane error, logs it, and changes nothing:
- assessment submitted twice → second returns the first result
- activity completed after being marked missed → un-miss it, log the correction, re-evaluate triggers
- activity completed that belongs to a superseded plan version → accept the outcome (the learning happened), do not resurrect the activity
- question referenced that no longer exists → drop from the assessment, log, recompose
- goal deadline moved into the past → reject with a clear message, do not attempt to plan

### 16.6 Chaos testing

`CHAOS_MODE=true` injects a configurable failure rate into the dispatcher. Phase 9 runs 100 agent executions at 10% tool failure. **Acceptance: ≥95% of runs complete successfully or abort cleanly, and zero runs leave corrupt state.**

### 16.7 Demo hook

The demo panel gets a **`Break RAG`** button. Fifteen seconds of screen time: tool fails, breaker opens, agent adapts and says why, tool recovers, agent re-plans the provisional activity. Directly answers the Adaptation & Failure Recovery criterion.

Second hook, if there's nerve for it: kill the backend mid-replan and restart it. The reconciler cleans up and the next tick continues. Twenty seconds, and it proves persistence and resumability at once.

---

## §17 Evaluation harness

The validator proves each *plan* is valid. Nothing yet proves the *agent* is any good — that's the other half of "Evaluation, verification & robustness," and almost nobody else in the room will have it. The simulator and clock already exist, so this is cheap to add.

### 17.1 Synthetic student profiles

```ts
type Profile = {
  name: string;
  true_mastery: Record<subtopic_id, number>;   // ground truth the agent cannot see
  true_learn_rate: number;
  attendance_probability: number;
  noise_sigma: number;                          // score variance around true mastery
  availability_shock?: { day: number; new_daily_hours: number };
};
```
Five profiles: `fast_learner` · `chronic_misser` · `plateauer` (learn rate collapses at day 10) · `availability_collapse` · `average`. Ten seeded students each — 50 runs, 30 simulated days, fully deterministic under a fixed RNG seed.

The simulated student answers questions by sampling against their hidden true mastery. The agent never sees `true_mastery`; it must infer it. That's what makes the calibration number meaningful.

### 17.2 Metrics

| Metric | Definition | Target |
|---|---|---|
| **Prediction calibration (MAE)** | mean \|predicted_score − actual_score\| over all assessments | < 0.12 |
| **Calibration curve** | actual score binned by predicted decile — the diagonal plot | monotone, near-diagonal |
| **Belief accuracy** | mean \|estimated mu − true_mastery\| at day 30 | < 0.15 |
| **Plan validity first-pass rate** | % of plans passing validation with 0 repair rounds | > 70% |
| **Mean repair rounds** | across all replans | < 0.6 |
| **Goal attainment** | % of students reaching target by deadline, by profile | fast 100% · average > 80% · collapse: correctly negotiated, not silently failed |
| **Scope appropriateness** | % of replans where resolved scope matched the expected scope for a known trigger | > 90% |
| **Recovery rate** | % of runs completing or aborting cleanly at 10% injected tool failure | > 95% |
| **Latency** | p50 / p95 per run, split PATCH vs FULL | PATCH p95 < 1.5s |

**Prediction calibration is the headline number.** If the agent predicts 0.65 across hundreds of activities and students average 0.63, that is measured evidence its model of the learner is sound — the most credible possible answer to "how do you know your mastery model isn't made up?"

### 17.3 Output

`npm run eval` writes `docs/eval-report.md` with the table above plus an ASCII calibration curve, and `eval-results.json`. The `/eval` frontend route renders the JSON as three charts. README embeds the table.

Run it once with `LLM_ENABLED=false` and once with LLM on, report both. If the numbers are close, say so as a strength: the deterministic core carries the correctness and the LLM adds interpretation.

---

## §18 Database schema

```sql
-- ── Identity & goal ──────────────────────────────────────────
students (
  id UUID PK, name TEXT, email TEXT UNIQUE,
  sim_now TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
)

learning_goals (
  id UUID PK, student_id UUID FK→students ON DELETE CASCADE,
  subject_id TEXT FK→subjects, title TEXT, deadline DATE NOT NULL,
  blueprint JSONB,                          -- { subtopic_id: weight }, confirmed by the student
  target_mastery JSONB,                     -- { subtopic_id: 0.75 }
  must_have_subtopics TEXT[],
  status TEXT CHECK (status IN ('active','achieved','abandoned')),
  created_at TIMESTAMPTZ
)
CREATE INDEX ON learning_goals(student_id, status);

-- ── Domain model (Subject → Topic → Subtopic → Concept) ───────
subjects ( id TEXT PK, name TEXT )                              -- dsa, cn, rdbms, oop
topics ( id TEXT PK, subject_id TEXT FK→subjects, name TEXT, base_hours NUMERIC(4,1), difficulty SMALLINT CHECK (difficulty BETWEEN 1 AND 5) )
subtopics (
  id TEXT PK, topic_id TEXT FK→topics, name TEXT,
  base_hours NUMERIC(4,1), difficulty SMALLINT CHECK (difficulty BETWEEN 1 AND 5),
  description TEXT
)
subtopic_prerequisites (
  subtopic_id TEXT FK→subtopics, prereq_id TEXT FK→subtopics,
  strength NUMERIC(3,2) DEFAULT 1.0,
  PRIMARY KEY (subtopic_id, prereq_id)
)
concepts ( id TEXT PK, subtopic_id TEXT FK→subtopics, name TEXT )

-- ── Beliefs (subtopic grain — the mastery model, §8) ──────────
subtopic_mastery (
  student_id UUID FK→students, subtopic_id TEXT FK→subtopics,
  mu NUMERIC(4,3) NOT NULL, confidence NUMERIC(4,3) NOT NULL,
  learn_rate NUMERIC(4,3) DEFAULT 0.10,
  evidence_count INT DEFAULT 0,
  retention_estimate NUMERIC(4,3), strength_days NUMERIC(5,2),
  format_efficacy JSONB DEFAULT '{"video":0.10,"article":0.10,"practice":0.10}',
  last_observed_at TIMESTAMPTZ,
  PRIMARY KEY (student_id, subtopic_id)
)

mastery_observations (            -- append-only audit trail; powers the improvement chart
  id BIGSERIAL PK, student_id UUID, subtopic_id TEXT,
  observed_at TIMESTAMPTZ, source TEXT,            -- 'assessment' | 'activity' | 'decay'
  mu_before NUMERIC(4,3), mu_after NUMERIC(4,3),
  confidence_before NUMERIC(4,3), confidence_after NUMERIC(4,3),
  evidence JSONB
)
CREATE INDEX ON mastery_observations(student_id, subtopic_id, observed_at DESC);

-- ── Resources / RAG (with live verification, §14) ─────────────
resources (
  id TEXT PK, title TEXT, provider TEXT, url TEXT,
  type TEXT CHECK (type IN ('video','article','doc','course','practice')),
  difficulty SMALLINT, duration_min INT, quality NUMERIC(3,2),
  subtopic_ids TEXT[], concept_ids TEXT[], description TEXT,
  embedding VECTOR(1536),
  last_verified_at TIMESTAMPTZ, is_live BOOLEAN DEFAULT true,
  verification_failures INT DEFAULT 0
)
CREATE INDEX ON resources USING ivfflat (embedding vector_cosine_ops) WITH (lists=10);
CREATE INDEX ON resources USING GIN (subtopic_ids);

resource_feedback (
  id BIGSERIAL PK, student_id UUID, resource_id TEXT,
  rating TEXT CHECK (rating IN ('helpful','unhelpful','dead_link')),
  observed_mastery_gain NUMERIC(4,3), created_at TIMESTAMPTZ
)

-- ── Constraints (effective-dated) ────────────────────────────
student_constraints (
  id UUID PK, student_id UUID FK→students,
  weekly_availability JSONB,               -- { "1":[{"start":"18:00","end":"21:00"}], ... }
  max_daily_study_min INT, min_session_min INT, max_session_min INT,
  blackout_dates DATE[], preferred_formats TEXT[],
  effective_from TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ
)
CREATE INDEX ON student_constraints(student_id, effective_from DESC);

-- ── Calendar ─────────────────────────────────────────────────
calendar_events (
  id UUID PK, student_id UUID FK→students,
  title TEXT, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ,
  source TEXT CHECK (source IN ('external','bloom')),
  busy BOOLEAN DEFAULT true,
  activity_id UUID NULL
)
CREATE INDEX ON calendar_events(student_id, starts_at);

-- ── Plans ────────────────────────────────────────────────────
study_plans ( id UUID PK, student_id UUID, goal_id UUID FK→learning_goals, current_version INT DEFAULT 1, created_at TIMESTAMPTZ )

plan_versions (
  id UUID PK, plan_id UUID FK→study_plans, version INT, parent_version INT NULL,
  trigger TEXT, scope TEXT,                -- 'PATCH' | 'FULL' | 'NEGOTIATE'
  reason TEXT, diff JSONB,                 -- { added:[], removed:[], moved:[], modified:[] }
  gap_snapshot JSONB, projection JSONB, validation_report JSONB,
  repair_rounds INT DEFAULT 0, created_at TIMESTAMPTZ,
  UNIQUE (plan_id, version)
)

learning_activities (
  id UUID PK, plan_id UUID, plan_version INT,
  student_id UUID, subtopic_id TEXT FK→subtopics, resource_id TEXT NULL FK→resources,
  action TEXT CHECK (action IN ('LEARN','PRACTICE','IMMEDIATE_TEST','ACTIVE_RECALL','REVISION','FINAL_TEST')),
  scheduled_start TIMESTAMPTZ, scheduled_end TIMESTAMPTZ, duration_min INT,
  priority NUMERIC(5,2),
  predicted_score NUMERIC(4,3), expected_mastery_after NUMERIC(4,3),
  status TEXT CHECK (status IN ('planned','in_progress','completed','missed','skipped','cancelled')),
  completed_at TIMESTAMPTZ, actual_duration_min INT, self_rated_difficulty SMALLINT,
  carried_from_activity_id UUID NULL,      -- lineage across replans → powers the diff view
  provisional BOOLEAN DEFAULT false,       -- set under degraded-mode planning (§16.2)
  resource_verified BOOLEAN NULL
)
CREATE INDEX ON learning_activities(student_id, scheduled_start);
CREATE INDEX ON learning_activities(plan_id, plan_version);
CREATE INDEX ON learning_activities(student_id, status) WHERE status='planned';

-- ── Assessment ───────────────────────────────────────────────
questions (
  id TEXT PK, subtopic_id TEXT, concept_id TEXT NULL,
  difficulty SMALLINT, stem TEXT, options JSONB, correct_index SMALLINT,
  explanation TEXT
)

assessments (
  id UUID PK, student_id UUID, activity_id UUID NULL,
  purpose TEXT CHECK (purpose IN ('diagnostic','checkpoint','final')),
  subtopic_ids TEXT[], question_ids TEXT[],
  predicted_score NUMERIC(4,3),            -- WRITTEN AT CREATION TIME
  created_at TIMESTAMPTZ, submitted_at TIMESTAMPTZ NULL
)

assessment_results (
  id UUID PK, assessment_id UUID FK→assessments,
  score NUMERIC(4,3), per_subtopic JSONB, per_concept JSONB,
  prediction_error NUMERIC(4,3),
  answers JSONB, submitted_at TIMESTAMPTZ
)

-- ── Agent audit trail (+ failure recovery, §16) ───────────────
agent_runs (
  id UUID PK, student_id UUID, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
  trigger TEXT, scope TEXT, outcome TEXT,   -- 'no_action' | 'patched' | 'replanned' | 'infeasible' | 'error'
  status TEXT CHECK (status IN ('running','completed','failed','abandoned')),
  last_completed_phase SMALLINT, degraded_tools TEXT[],
  error_class TEXT, error_detail TEXT, recovered_from_run_id UUID NULL,
  new_plan_version INT NULL, tool_call_count INT, llm_call_count INT, total_latency_ms INT
)

agent_events (
  id BIGSERIAL PK, run_id UUID FK→agent_runs, student_id UUID, seq INT,
  phase TEXT,          -- 'observe'|'update_beliefs'|'triggers'|'analyze'|'decide'|'retrieve'|'plan'|'validate'|'repair'|'commit'|'act'
  event_type TEXT,     -- 'tool_call'|'llm_call'|'decision'|'state_change'|'validation'|'notice'
  tool_name TEXT NULL, message TEXT, payload JSONB,
  error_class TEXT NULL, retry_attempt SMALLINT DEFAULT 0,
  latency_ms INT, created_at TIMESTAMPTZ
)
CREATE INDEX ON agent_events(student_id, created_at DESC);
CREATE INDEX ON agent_events(run_id, seq);

-- ── Tool resilience (§16.1) ────────────────────────────────────
tool_health (
  tool_name TEXT PK, state TEXT CHECK (state IN ('closed','open','half_open')),
  consecutive_failures INT DEFAULT 0, opened_at TIMESTAMPTZ,
  last_error TEXT, last_success_at TIMESTAMPTZ
)

-- ── Evaluation harness (§17) ──────────────────────────────────
eval_runs (
  id UUID PK, started_at TIMESTAMPTZ, config JSONB, seed INT,
  llm_enabled BOOLEAN, chaos_rate NUMERIC, metrics JSONB
)
eval_students (
  id UUID PK, eval_run_id UUID FK→eval_runs, profile TEXT,
  true_mastery JSONB, true_learn_rate NUMERIC, outcome JSONB
)

-- ── Idempotency (§16.4) ────────────────────────────────────────
idempotency_keys ( key TEXT PK, endpoint TEXT, response JSONB, created_at TIMESTAMPTZ )
```

`carried_from_activity_id` and `plan_versions.diff` are the two columns that make the Plan Changes screen possible. Don't skip them.

---

## §19 Validator

A pure function with no knowledge of how the plan was produced: `validate(plan, state, constraints) → ValidationReport`.

**Hard constraints (failure forces repair):**

| ID | Check | Implementation |
|---|---|---|
| C1 | No overlapping sessions | Interval sweep over sorted activities + external calendar events |
| C2 | Daily capacity not exceeded | Σ minutes per day ≤ `max_daily_study_min` and ≤ available window |
| C3 | All activities before deadline | `max(activity.end) ≤ deadline` |
| C4 | Each activity fits its slot | `resource.duration + buffer ≤ slot.minutes` |
| C5 | Prerequisite ordering | For each activity, all prereq subtopics reach `target×0.7` in an earlier activity or already do |
| C6 | Session bounds | `min_session ≤ duration ≤ max_session`; no session in a blackout window |
| C7 | Final-test coverage | Every subtopic with a started activity has a scheduled `FINAL_TEST` |

**Learning constraints:**

| ID | Check | Threshold |
|---|---|---|
| L1 | Top-3 priority gaps each have ≥1 activity | hard |
| L2 | Every completed subtopic has ≥2 `ACTIVE_RECALL` activities | hard |
| L3 | Weak subtopics have a `REVISION` activity | hard |
| L4 | Practice + assessment minutes ≥ 30% of total | soft warn |
| L5 | Projected attainment ≥ target for must-haves | hard → escalates to `NEGOTIATE`, not repair |

**Repair operators, cheapest first:** `SHIFT → SPLIT → SWAP → SUBSTITUTE → COMPRESS → DEFER → NEGOTIATE`. Max 3 rounds, hard-coded. Each application logged, e.g. `"Repair 2/3: applied COMPRESS to Trees (4.0h → 2.4h) to satisfy C2 daily-capacity."`

**Loop:**
```
plan = generate()
for round in 1..3:
    report = validate(plan)
    if report.hard_failures == 0: break
    plan = repair(plan, report)          // applies operators in order, logs each
    emit AGENT_EVENT("validation_failed", report)
if report.hard_failures > 0:
    plan = negotiate(plan, report)       // best partial plan + explicit tradeoff message
    emit AGENT_EVENT("infeasible", ...)
commit(plan, report)
```

Build a test hook that forces a validation failure and use it live in the demo. A validator that has never fired proves nothing — ship the injection hook (Test Scenario 10, §23) and use it.

---

## §20 Frontend — seven screens

Seven polished screens beat eleven half-built ones under Prototype Functionality & UX, and the reclaimed hours go into §16 and §17 where the points actually are.

1. **Onboarding** — subject cards → deadline (60-day cap) + availability grid → blueprint confirmation with weights. One flow, three steps.
2. **Dashboard** — status pill (ON_TRACK / AT_RISK / BEHIND / INFEASIBLE), three separate gauges (attendance · trajectory · arrival), deadline countdown, projected completion, today's activities, top 3 weaknesses, today's daily summary inline.
3. **Study Plan** — timeline colour-coded by activity type, external events greyed, click a card for *why this activity* (gap breakdown, resource justification, predicted score, verification status).
4. **Topic Progress** — per subtopic: mastery + confidence band, badge state with reason, initial/recall/retest/final scores side by side, weaknesses and revision pool folded in here.
5. **Assessment** — question runner; on submit: score, per-concept breakdown, which questions entered the revision pool, predicted vs actual.
6. **★ Agent Activity** — SSE feed grouped by run: trigger, scope, latency, tool count, LLM count, degraded tools, per-phase events with expandable payloads. Validation failures red, repairs amber, tool failures orange, final pass green. **Build this first — it de-risks everything else and is the differentiator.**
7. **Plan Changes** — version rail with trigger pills, colour-coded diff (added green, removed red struck-through, moved amber, modified blue), validation checklist per version.

Plus `/eval` (a static render of the eval report) and a floating **Demo Panel**: advance 1 day · miss next session · complete next session · take assessment (score slider) · set availability to 1h/day · **break RAG** · reset to seed.

**Rule: no fake data in React.** Agent events come from `agent_events` or they don't exist.

---

## §21 Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite, TailwindCSS, shadcn/ui, Recharts | Don't experiment; you know this |
| Backend | Node 20 + Express + TypeScript, Zod for all tool schemas | Zod schemas double as LLM tool definitions — write once |
| Agent orchestration | Hand-rolled, ~400 lines | A framework costs a day fighting abstractions and hides the loop from judges. A visible, readable `orchestrator.ts` is an asset in a code review |
| LLM | Anthropic Claude (Sonnet for Strategist, Haiku for Diagnostician/Curator) | Native tool-use + strict JSON. Env-flag to swap providers |
| Database | PostgreSQL 16 (Neon free tier) + Drizzle ORM | Drizzle over Prisma: faster migrations, less magic |
| Vector/RAG | pgvector in the same Postgres | One database — do not add Pinecone/Chroma for 150 documents |
| Embeddings | `text-embedding-3-small`, precomputed at seed time | Zero runtime embedding cost for the corpus |
| Calendar | Internal simulated table (primary) + optional read-only Google Calendar behind a flag | Real OAuth in a demo is a coin flip |
| Question bank | Seeded Postgres tables, concept-tagged | Real content beats LLM-generated questions for reliability |
| Realtime | Server-Sent Events (`/api/students/:id/stream`) | Simpler than WebSockets, sufficient for a one-way feed |
| Clock | `sim_now` column + `POST /api/sim/advance` | Non-negotiable |
| Deployment | Vercel (frontend) + Railway/Render (backend) + Neon (DB) | Also: `docker-compose up` must work locally |

**What is real vs simulated (state this openly on a slide):**

| Real | Simulated | Why |
|---|---|---|
| LLM reasoning (3 agents, real API calls) | Student behaviour (demo buttons) | Reproducible scenarios |
| Vector search over ~150 curated real resources with real, live-verified URLs | Resource "quality" scores (hand-assigned) | No usage data exists |
| Live HTTP verification of every recommended URL (§14) | Calendar (internal table; GCal import optional) | OAuth risk |
| Postgres persistence, all state survives restart | Clock | Can't wait 30 days |
| Deterministic scheduling, validation, BKT-lite math, resilience layer | — | — |

---

## §22 Repository structure

```
bloom/
├── docker-compose.yml            postgres+pgvector, backend, frontend
├── README.md                     pitch · architecture diagram · real-vs-simulated · eval results · setup
├── docs/
│   ├── architecture.md           this document, trimmed
│   ├── agent-loop.md             the loop, triggers, scopes
│   ├── eval-report.md            generated by `npm run eval`
│   └── demo-script.md            the 4-minute script (§25)
│
├── backend/
│   ├── src/
│   │   ├── index.ts
│   │   ├── db/
│   │   │   ├── schema.ts             Drizzle table definitions (§18)
│   │   │   ├── client.ts
│   │   │   └── seed/                 subjects, topics, subtopics, prereqs, resources+embeddings, questions, student
│   │   ├── tools/
│   │   │   ├── schemas.ts            Zod in/out for all 21 ops — SINGLE source of truth
│   │   │   ├── dispatcher.ts         resilience wrapper + logs every call to agent_events
│   │   │   ├── performance.ts  rag.ts  calendar.ts  qbank.ts  state.ts
│   │   ├── core/
│   │   │   ├── clock.ts              sim_now read/advance, auto-miss detection
│   │   │   ├── beliefs.ts            BKT-lite update, decay, learn-rate recalibration
│   │   │   ├── gapEngine.ts          §12 priority formula
│   │   │   ├── actionSelector.ts     LEARN/PRACTICE/IMMEDIATE_TEST/ACTIVE_RECALL/REVISION/FINAL_TEST
│   │   │   ├── resourceFit.ts        fit-scoring for RAG candidates
│   │   │   ├── slotter.ts            calendar → session slots
│   │   │   ├── planner.ts            budget → topo order → greedy fill → predictions
│   │   │   ├── repair.ts             7 ordered repair operators
│   │   │   ├── validator.ts          C1–C7, L1–L5, report builder
│   │   │   ├── onTrack.ts            §9 attendance/trajectory/arrival
│   │   │   └── diff.ts               plan version diffing
│   │   ├── agent/
│   │   │   ├── orchestrator.ts       ★ the 11-phase loop — keep it readable, judges will open this file
│   │   │   ├── triggers.ts           11 triggers → severity → scope, with debouncing
│   │   │   ├── context.ts            AgentContext, run/event emission, phase checkpointing
│   │   │   ├── reconciler.ts         startup scan for status='running' (§16.3)
│   │   │   └── llm/
│   │   │       ├── client.ts  cache.ts
│   │   │       ├── diagnostician.ts  curator.ts  strategist.ts
│   │   │       └── prompts/          .md files, versioned, not inline strings
│   │   ├── resilience/
│   │   │   ├── circuitBreaker.ts     open/half-open/closed, tool_health persistence
│   │   │   └── retry.ts
│   │   ├── routes/                   students, plans, activities, assessments, agent, sim, stream
│   │   ├── eval/
│   │   │   ├── profiles.ts           §17.1 synthetic students
│   │   │   ├── runner.ts             `npm run eval`
│   │   │   └── metrics.ts            calibration MAE, belief accuracy, etc.
│   │   └── sim/
│   │       ├── clockCron.ts          tick loop
│   │       ├── chaos.ts              CHAOS_MODE failure injection (§16.6)
│   │       └── scenarios.ts          demo scenarios + reset
│   └── test/                         beliefs.test.ts · planner.property.test.ts · validator.test.ts · scenarios.e2e.test.ts · chaos.test.ts
│
└── frontend/
    └── src/
        ├── pages/  Onboarding · Dashboard · StudyPlan · TopicProgress · Assessment · AgentActivity · PlanChanges · Eval
        ├── components/  AgentFeed · PlanTimeline · ActivityCard · PlanDiff ·
        │                MasteryChart · ValidationReport · PredictionScatter · DemoPanel · OnTrackGauges
        ├── hooks/  useAgentStream · useStudentState
        └── lib/  api.ts · types.ts (generated from backend Zod)
```

**Files that carry the project:** `agent/orchestrator.ts`, `core/validator.ts`, `core/gapEngine.ts`, `resilience/circuitBreaker.ts`, `eval/runner.ts`, `components/AgentFeed.tsx`. Make those genuinely well-written; a judge who opens the repo will open the orchestrator first.

---

## §23 Phases (re-costed for v3)

Each phase: implement → unit test → integration test → break it deliberately and confirm detection → fix → regression → report. Do not advance on a failure.

| # | Phase | Gate before moving on | Est. |
|---|---|---|---|
| 1 | Foundation, DB, seed, question pipeline, link checker | `up && migrate && seed && test` green; vector search relevant; DSA questions reviewed; 3 injected defects caught | **11h** |
| 2 | Five tools + dispatcher + resilience layer (retry, breaker, `tool_health`, degraded modes) + live RAG verification | 21 ops exercised; breaker opens and recovers; each degraded mode produces correct fallback; every call logged | **9h** |
| 3 | Mastery, decay, active recall, weakness engine | mu update matches the §8 worked-example test target; property test mu ∈ [0,1] over 10k updates; survives restart | 7h |
| 4 | Resource fit + planner | 50 randomised schedules: zero overlaps, prereqs respected, ≥2 recall per completed subtopic | 9h |
| 5 | Assessment composer + validator + repair | final-test carry-forward exact; 5 injected defects caught; repair never exceeds 3 rounds | 8h |
| 6 | Orchestrator, triggers, clock, versioning, daily summary, transactional commit + startup reconciler | Scenarios A–D pass with `LLM_ENABLED=false`; kill backend mid-run and confirm clean recovery | **10h** |
| 7 | LLM specialists + fallback | Timeout, invalid JSON, provider down — every run still completes | 5h |
| 8 | API + SSE + 7 screens + demo panel | Refresh, restart, SSE reconnect clean; no fabricated events | **11h** |
| 9 | Eval harness + E2E scenarios + chaos testing | `npm run eval` produces the report; calibration MAE < 0.12; ≥95% recovery at 10% failure; scenarios identical across 3 runs | **12h** |
| 10 | Link check, README, demo video, clean-clone test | Video recorded; clean clone runs unaided | 5h |

**~87 hours total.** The extra hours over a bare-bones build buy roughly eight rubric points via §16 and §17 — the best exchange rate available anywhere in this project.

**Split (2 people):** Person A → 1, 2, 4, 5 (data + core engine + resilience). Person B → 3, 6, then 8 (beliefs + orchestrator + frontend). Phase 9 together. Merge at Phase 6.

**If time runs out, cut in this order:** CN/RDBMS/OOP question depth → Topic Progress screen polish → the LLM-enabled eval run (report deterministic only) → chaos testing at 100 runs (do 25). **Never cut:** the eval harness, the resilience layer, or the Agent Activity screen.

---

## §24 Build order — coding-agent prompts

Give these to a coding agent one at a time, pasting the relevant section of this document as context with each.

**P1 — Scaffold.** Monorepo `bloom/` with `backend/` (Node 20, TS, Express, Drizzle, Zod) and `frontend/` (Vite, React 18, TS, Tailwind, shadcn/ui). `docker-compose.yml` running `pgvector/pgvector:pg16` on 5432, backend on 4000, frontend on 5173. `.env.example`, root `npm run dev` via concurrently, `/health` endpoint. No business logic. *(Phase 1)*

**P2 — Schema.** Implement the full Drizzle schema from §18 in `backend/src/db/schema.ts`, including the pgvector column on `resources`. Generate and run the migration, add `db/client.ts`. Do not add tables outside the spec. *(Phase 1)*

**P3 — Seed.** `backend/src/db/seed/` producing: 4 subjects; DSA with 6 topics / 24 subtopics and a real prerequisite DAG; CN/RDBMS/OOP with 2 topics × ~3 subtopics each; ~150 real resources with working URLs (freeCodeCamp, USACO Guide, CP-Algorithms, NeetCode, GeeksforGeeks, MIT OCW) tagged by subtopic and concept; ~120 MCQs concept-tagged; one student with `sim_now = 2026-11-01T08:00:00Z`; external calendar events; initial constraints. Embed resource descriptions at seed time. `npm run seed` / `npm run seed:reset`. *(Phase 1)*

**P4 — Tool layer + resilience.** Five tools from §13 in `backend/src/tools/`, Zod schemas in `schemas.ts` exporting both TS types and tool-call JSON schemas. `dispatcher.ts` wraps every call with the §16.1 retry/timeout/circuit-breaker logic backed by `tool_health`, and writes an `agent_events` row per call. RAG search does pgvector cosine similarity plus the §14 live HTTP verification. `npm run test:tools` exercises all 21 operations, plus a forced-failure test proving the breaker opens and the tool enters degraded mode. *(Phase 2)*

**P5 — Beliefs + clock.** `core/clock.ts` (sim_now read/advance, auto-mark overdue `planned` activities `missed`) and `core/beliefs.ts` implementing the exact §8 formulas: evidence-weighted mastery update, confidence update, staleness decay, learn-rate recalibration, plus `retention_estimate`/`strength_days` from §6. Every update writes `mastery_observations`. Vitest test locking the §8 worked example. *(Phase 3)*

**P6 — Gap engine + action selector.** `core/gapEngine.ts` with the §12 formula, `core/actionSelector.ts` with the six-branch rule. Pure functions over a state snapshot. Test reproducing the "largest gap still doesn't win because confidence is low" case from §12 as a fixed fixture. *(Phase 3)*

**P7 — Resource fit + on-track.** `core/resourceFit.ts` scoring RAG candidates against slot length, mastery (ZPD), format efficacy, and novelty. `core/onTrack.ts` implementing §9's attendance/trajectory/arrival signals and status resolution. *(Phase 3–4)*

**P8 — Slotter + planner.** `core/slotter.ts` (calendar + weekly availability + blackouts + sim_now → usable slots, with `energy_weight`) and `core/planner.ts` implementing budget → topo order → greedy fill → predictions, emitting `LEARN`/`PRACTICE`/`IMMEDIATE_TEST`/`ACTIVE_RECALL`/`REVISION`/`FINAL_TEST` activities. Deterministic, no LLM. Property test: 50 random constraint sets, zero overlaps, prereqs respected. *(Phase 4)*

**P9 — Validator + repair.** `core/validator.ts` with C1–C7 and L1–L5 from §19, exact report shape. `core/repair.ts` with the 7 ordered operators. Tests: hand-crafted overlapping plan fails C1; an over-constrained input reaches NEGOTIATE within 3 repair rounds; a `FINAL_TEST` correctly carries forward previously-incorrect questions. *(Phase 5)*

**P10 — Triggers + orchestrator + resumability.** `agent/triggers.ts` with the 11 triggers, severities, scope resolution and coalescing from §11. `agent/orchestrator.ts` running the 11-phase loop from §10, checkpointing `last_completed_phase` after every phase and committing all state in one transaction at phase 10. `agent/reconciler.ts` runs on startup per §16.3. Every phase emits `agent_events` with a human-readable `message`. Must run end-to-end with LLM calls stubbed to deterministic fallbacks. Expose `POST /api/agent/run` and `POST /api/agent/tick`. E2E test: kill the process mid-run, restart, confirm clean recovery. *(Phase 6)*

**P11 — LLM agents.** `agent/llm/` — provider-agnostic client, input-hash response cache, 8s timeout, deterministic fallback. Three agents with prompts in `prompts/*.md`: Diagnostician (Haiku), Curator (Haiku), Strategist (Sonnet, also authors the negotiation message). All outputs Zod-validated, one retry then fallback. `LLM_ENABLED=false` selects the deterministic path everywhere. *(Phase 7)*

**P12 — REST + SSE.** All routes, `GET /api/students/:id/stream` (SSE broadcasting `agent_events` live), `POST /api/sim/advance`, `POST /api/sim/scenario/:name`. Export Zod types for frontend consumption. *(Phase 8)*

**P13 — Agent Activity screen.** `frontend/src/pages/AgentActivity.tsx` + `components/AgentFeed.tsx`: live SSE feed grouped by run (trigger, scope, latency, tool count, LLM count, degraded tools), per-event phase icons and expandable payloads. Validation failures red, repairs amber, tool failures orange, final pass green. Build this before any other screen. *(Phase 8)*

**P14 — Remaining screens.** Onboarding, Dashboard (status pill, three on-track gauges, countdown, today's activities, daily summary inline), Study Plan (timeline, why-this-activity), Topic Progress (mastery + confidence bands, badge, score history, weaknesses/revision), Assessment (question runner, predicted-vs-actual), Plan Changes (version rail, colour-coded diff, validation checklist), `/eval` (static render of the eval report), and the floating Demo Panel including **Break RAG**. *(Phase 8)*

**P15 — Eval harness + chaos testing + hardening.** `eval/profiles.ts` (5 profiles × 10 seeded students), `eval/runner.ts` (`npm run eval` producing `docs/eval-report.md` + `eval-results.json`), `eval/metrics.ts` (calibration MAE, belief accuracy, scope appropriateness, etc.). `sim/chaos.ts` for `CHAOS_MODE`; run 100 executions at 10% failure and assert ≥95% clean completion. Resource-URL link checker. README with architecture diagram, LLM-vs-deterministic table, real-vs-simulated table, eval results, limitations. Verify from a clean clone. *(Phase 9–10)*

---

## §25 Demo (4:00)

| Time | Beat | Line |
|---|---|---|
| 0:00 | Loop diagram | "A timetable is printed directions. Bloom is autopilot." |
| 0:20 | DSA, 30-day deadline, blueprint confirmed, diagnostic done. **Run agent.** | "Seventeen tool calls, three specialists, one validated plan." |
| 0:45 | Plan v1, open the DP card | "Biggest gap is DP — but it scheduled a *test*, not study. Confidence is 0.30. It won't spend nine hours on a belief it doesn't trust." |
| 1:05 | Advance 1 day without completing | "Found the miss itself. Scope PATCH, zero LLM calls, 0.9 seconds. One miss doesn't invalidate a plan, and it says so." |
| 1:25 | Test at 40% | "Predicted 65, scored 40. Mastery down, learn rate down, root cause diagnosed, that video blacklisted, switched to practice-first. Two questions entered the revision pool." |
| 1:55 | Advance 3 days — recall fires | "Nobody asked for this. Retention estimate fell below threshold, so it scheduled recall *before* the failure." |
| 2:15 | **Break RAG** | "Tool's down. Breaker opens, it reuses the last known-good resource, marks the activity provisional, and keeps going. Tool recovers — it re-plans the provisional activity on its own." |
| 2:40 | Availability → 1h/day; validation fails twice, repairs, negotiates | "It can't reach the goal, so it doesn't pretend. Three options, quantified, with a recommendation." |
| 3:10 | Plan Changes rail v1→v6 | "Six versions, each with a trigger, a reason, a diff, and a passed validation report." |
| 3:25 | Eval screen — calibration curve | "Fifty synthetic students, thirty simulated days. Mean prediction error 0.09. Ninety-six percent of runs recover cleanly at ten percent tool failure. We didn't just build it — we measured it." |
| 3:50 | LLM-vs-deterministic slide | "Model where judgement is needed, code where correctness is needed. Kill the process — state's in Postgres." |

**Rules:** pre-seed the student so nothing is typed on stage. Run against a local DB. Record the video the day before.

---

## §26 Judge perspective

**What would impress:**
- The agent choosing `IMMEDIATE_TEST` over `PRACTICE` because of low confidence.
- A validation failure shown on screen, then repaired.
- The agent declining to fully replan on a single miss — restraint implies judgement.
- Predicted vs actual scatter plot.
- The negotiation message with quantified options.
- A clean statement of what's real vs simulated, offered unprompted.
- `learn_rate` visibly changing.
- The calibration curve from the eval harness.
- The Break RAG demo hook: fail → degrade → recover → re-plan, on screen.

**What would make it fail:**
- Any dead resource URL. One 404 and RAG credibility is gone — this is exactly why §14 exists.
- Overlapping sessions in the rendered calendar.
- "Replanning" that produces a plan with no relationship to the previous one.
- No persistence — refresh and it's gone.
- The team unable to say where the LLM is and where the code is.
- A validator that has never failed.
- An unbounded repair loop hanging the demo.

**Evidence table:**

| Claim | Required evidence | Where in the build |
|---|---|---|
| Autonomy | Agent runs from a clock tick with no user input; sometimes decides not to act | `POST /api/agent/tick` + `outcome='no_action'` rows |
| Multi-tool | ≥3 distinct tools per FULL replan, logged with latency | `agent_events` where `event_type='tool_call'` |
| Statefulness | Restart the server mid-demo, refresh, state intact | Postgres, no in-memory truth |
| Replanning | ≥6 versions with distinct triggers, scopes, and diffs | `plan_versions` table + diff UI |
| Verification | Validation report per version, with ≥1 recorded failure→repair | `validation_report` JSONB + repair round events |
| Adaptation (learner) | `learn_rate` and `format_efficacy` change across the demo | Topic Progress screen |
| Adaptation (system) | Tool breaker opens/recovers, plan marked provisional then re-planned | Agent Activity feed + Break RAG hook |
| Goal persistence | Goal row unchanged across replans; every plan re-derives from it | Plan Changes rail |
| Evaluation | Calibration MAE, chaos-recovery rate, both measured and reported | `docs/eval-report.md` + `/eval` |

---

## §27 Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Question bank volume underestimated | **Fatal** | Pipeline in Phase 1. Review DSA only. Flag the rest `reviewed: false`. |
| Reads as "another AI study planner" | Fatal | Open on the low-confidence-test decision and pre-emptive recall, never on plan generation. |
| LLM down on demo day | Fatal | Phase 6/7 gate: everything works with `LLM_ENABLED=false`. Cache, timeouts, recorded video. |
| Dead resource URLs | High | Live verification in the RAG tool (§14) + link-check script in Phase 1 and Phase 10. |
| Eval harness slips to "if there's time" | High | It is 10% of the rubric and cheap. Scheduled as Phase 9, not stretch. |
| Four subjects consume the week | High | DSA demo-grade, others catalog-grade. Decided in §4, not on day 4. |
| Resilience layer bolted on late | Medium | It belongs in Phase 2's dispatcher. Retrofitting a breaker into 21 call sites later is miserable. |
| Unbounded repair loop | Medium | Hard cap 3, enforced in code, negotiation as the exit. |
| Validator never fires | Medium | Ship the injection hook (Test Scenario 10) and use it live. |
| Two-person coordination | Medium | Person A: DB + tools + core math. Person B: clock/beliefs then frontend. Merge at Phase 6. |

---

## §28 MVP / Should / Stretch

**MUST HAVE — the submission, nothing here is optional:**
1. Postgres schema + seed (4 subjects, DSA demo-grade with 6 topics/24 subtopics + full prereq graph, ~150 resources, ~120 questions, 1 student, calendar events)
2. Simulated clock + `POST /api/sim/advance`
3. Five tools with Zod schemas behind a logging, resilient dispatcher (retry, circuit breaker, degraded modes)
4. Live RAG URL verification with degraded-mode fallback
5. BKT-lite belief updater + confidence decay + learn-rate recalibration + retention/decay model
6. Gap Engine with the §12 scoring formula + action selection
7. Trigger Evaluator with the 11 triggers and scope resolution
8. Planner (budget → slots → topo order → greedy fill → predictions)
9. Validator with C1–C7/L1–L5 + bounded repair loop + negotiate path
10. Plan versioning with diff, transactional commit, run resumability
11. `agent_events` + SSE stream
12. Seven screens per §20, including Agent Activity and the Demo Panel
13. Evaluation harness (`npm run eval`, calibration MAE reported)
14. Chaos test suite (≥95% recovery at 10% injected failure)
15. README with architecture diagram + real/simulated table + eval results

**SHOULD HAVE:**
- Diagnostician LLM (concept-level root-cause) — the highest-value SHOULD; promote to MUST if there's slack
- Curator LLM justifications
- Predicted-vs-actual scatter on Topic Progress
- `energy_weight` slot preference from historical completion
- Strategist LLM for negotiation copy

**STRETCH (only once everything above is done and tested):**
- Google Calendar read-only import
- Multi-student cron across a cohort
- LLM-generated questions for uncovered concepts
- Export plan to `.ics`
- Kill-the-backend-mid-run as a second live demo hook

**Explicitly out of scope, do not build:** auth beyond a student picker, mobile, chat interface, social/leaderboard, notifications, payment, admin panel.
