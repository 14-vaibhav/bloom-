import { describe, it, expect } from "vitest";
import { composeAssessment } from "../../src/core/composer.js";
import type { ComposerInput, QuestionCandidate } from "../../src/core/types.js";

function q(id: string, overrides: Partial<QuestionCandidate> = {}): QuestionCandidate {
  return { question_id: id, concept_id: null, difficulty: 3, weakness_score: 0, ...overrides };
}

function pool(prefix: string, count: number, overrides: Partial<QuestionCandidate> = {}): QuestionCandidate[] {
  return Array.from({ length: count }, (_, i) => q(`${prefix}_${i}`, overrides));
}

function baseInput(overrides: Partial<ComposerInput> = {}): ComposerInput {
  return {
    purpose: "final",
    mu: 0.5,
    concept_accuracy: {},
    new_pool: pool("new", 20),
    correct_pool: pool("correct", 20),
    revision_pool: [],
    targeted_pool: pool("targeted", 20),
    ...overrides,
  };
}

describe("composer — bloom-phase5-brief §3", () => {
  it("★ a 10-question final test with 4 wrong answers contains all 4 (4 revision + 1 targeted + 5 new)", () => {
    const revisionPool = pool("wrong", 4, { weakness_score: 1 });
    const composed = composeAssessment(baseInput({ purpose: "final", revision_pool: revisionPool }));

    expect(composed.composition).toEqual({ new: 5, revision: 4, targeted: 1, correct: 0 });
    for (const wrong of revisionPool) {
      expect(composed.question_ids).toContain(wrong.question_id);
    }
    expect(composed.question_ids).toHaveLength(10);
  });

  it("empty revision pool → 0 revision + 2 targeted + 8 new, logged", () => {
    const composed = composeAssessment(baseInput({ purpose: "final", revision_pool: [] }));
    expect(composed.composition).toEqual({ new: 8, revision: 0, targeted: 2, correct: 0 });
    expect(composed.note).not.toBeNull();
    expect(composed.note).toMatch(/revision pool held 0/);
  });

  it("pool of 7 → capped at 4 revision, MIN_NEW=5 honoured (targeted drops to 1)", () => {
    const composed = composeAssessment(baseInput({ purpose: "final", revision_pool: pool("wrong", 7, { weakness_score: 1 }) }));
    expect(composed.composition).toEqual({ new: 5, revision: 4, targeted: 1, correct: 0 });
  });

  it("pool of 2 → 2 revision + 2 targeted + 6 new", () => {
    const composed = composeAssessment(baseInput({ purpose: "final", revision_pool: pool("wrong", 2, { weakness_score: 1 }) }));
    expect(composed.composition).toEqual({ new: 6, revision: 2, targeted: 2, correct: 0 });
  });

  it("active_recall pulls previously-CORRECT questions, not failed ones", () => {
    const composed = composeAssessment(
      baseInput({ purpose: "active_recall", correct_pool: pool("correct", 5), revision_pool: pool("wrong", 5, { weakness_score: 1 }) }),
    );
    expect(composed.composition).toEqual({ new: 3, revision: 0, targeted: 0, correct: 2 });
    expect(composed.question_ids.some((id) => id.startsWith("wrong_"))).toBe(false);
    expect(composed.question_ids.filter((id) => id.startsWith("correct_"))).toHaveLength(2);
  });

  it("retest: 4 new + up to 4 from revision pool, capped even with a larger pool", () => {
    const composed = composeAssessment(baseInput({ purpose: "retest", revision_pool: pool("wrong", 9, { weakness_score: 1 }) }));
    expect(composed.composition).toEqual({ new: 4, revision: 4, targeted: 0, correct: 0 });
  });

  it("diagnostic and immediate purposes draw new questions only", () => {
    const diagnostic = composeAssessment(baseInput({ purpose: "diagnostic" }));
    expect(diagnostic.composition).toEqual({ new: 15, revision: 0, targeted: 0, correct: 0 });
    const immediate = composeAssessment(baseInput({ purpose: "immediate" }));
    expect(immediate.composition).toEqual({ new: 8, revision: 0, targeted: 0, correct: 0 });
  });

  it("no duplicate question_id within one assessment even when pools overlap", () => {
    const shared = q("shared_q", { weakness_score: 5 });
    const composed = composeAssessment(
      baseInput({ purpose: "final", revision_pool: [shared], targeted_pool: [shared, ...pool("targeted", 5)] }),
    );
    const ids = composed.question_ids;
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("deterministic: identical input produces the identical question set, twice", () => {
    const input = baseInput({ purpose: "final", revision_pool: pool("wrong", 3, { weakness_score: 1 }) });
    const a = composeAssessment(input);
    const b = composeAssessment(input);
    expect(a.question_ids).toEqual(b.question_ids);
    expect(a.predicted_score).toBe(b.predicted_score);
  });

  it("revision questions are predicted at mu * 0.70, not mu", () => {
    const composed = composeAssessment(
      baseInput({
        purpose: "retest",
        mu: 0.8,
        revision_pool: pool("wrong", 4, { weakness_score: 1 }),
        new_pool: [], // isolate: only revision-pool predictions contribute
      }),
    );
    // retest with a full revision pool composes 0 new (4 revision only, since revision=4 caps new at 4... wait
    // retest ideal is new:4,revision:4 regardless of pool — but new_pool is empty here, so only revision fills.
    expect(composed.composition.revision).toBe(4);
    expect(composed.predicted_score).toBeCloseTo(0.8 * 0.7, 5);
  });

  it("unseen questions are predicted from mu adjusted by difficulty, not a flat mu", () => {
    const easy = q("easy", { difficulty: 1 });
    const hard = q("hard", { difficulty: 5 });
    const composed = composeAssessment(baseInput({ purpose: "immediate", mu: 0.5, new_pool: [easy, hard] }));
    // predictUnseen(0.5, 1) = 0.5 - 0.15*(1-3)/2 = 0.5 + 0.15 = 0.65
    // predictUnseen(0.5, 5) = 0.5 - 0.15*(5-3)/2 = 0.5 - 0.15 = 0.35
    expect(composed.predicted_score).toBeCloseTo((0.65 + 0.35) / 2, 5);
  });

  it("backfills from the new pool when revision/targeted pools fall short, and logs it", () => {
    const composed = composeAssessment(
      baseInput({ purpose: "final", revision_pool: pool("wrong", 1, { weakness_score: 1 }), targeted_pool: [] }),
    );
    // ideal for pool=1: revision=1, targeted=min(2,10-1-5)=2, new=7. Only 1 revision + 0 targeted
    // available, so the 2 unfilled targeted slots backfill from new: new = 7 + 2 = 9.
    expect(composed.composition).toEqual({ revision: 1, targeted: 0, correct: 0, new: 9 });
    expect(composed.question_ids).toHaveLength(10);
    expect(composed.note).not.toBeNull();
  });
});
