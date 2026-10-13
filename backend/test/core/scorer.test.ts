import { describe, it, expect } from "vitest";
import { scoreAssessment } from "../../src/core/scorer.js";
import type { QuestionMeta, ScorerInput } from "../../src/core/types.js";

function meta(id: string, overrides: Partial<QuestionMeta> = {}): QuestionMeta {
  return { question_id: id, subtopic_id: "st1", concept_id: null, difficulty: 3, correct_index: 0, ...overrides };
}

describe("scorer — bloom-phase5-brief §4", () => {
  it("per_concept accuracy is correct across mixed-concept assessments", () => {
    const questions: QuestionMeta[] = [
      meta("q1", { concept_id: "c1", correct_index: 0 }),
      meta("q2", { concept_id: "c1", correct_index: 0 }),
      meta("q3", { concept_id: "c2", correct_index: 0 }),
    ];
    const input: ScorerInput = {
      predicted_score: 0.5,
      questions,
      answers: [
        { question_id: "q1", chosen_index: 0 }, // correct
        { question_id: "q2", chosen_index: 1 }, // wrong
        { question_id: "q3", chosen_index: 0 }, // correct
      ],
    };
    const result = scoreAssessment(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.per_concept.c1).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
    expect(result.result.per_concept.c2).toEqual({ correct: 1, total: 1, accuracy: 1 });
  });

  it("prediction_error = actual - predicted, sign correct both directions", () => {
    const questions = [meta("q1"), meta("q2")];
    const over = scoreAssessment({
      predicted_score: 0.9,
      questions,
      answers: [
        { question_id: "q1", chosen_index: 0 },
        { question_id: "q2", chosen_index: 1 },
      ],
    });
    expect(over.ok).toBe(true);
    if (over.ok) expect(over.result.prediction_error).toBeCloseTo(0.5 - 0.9, 5);

    const under = scoreAssessment({
      predicted_score: 0.1,
      questions,
      answers: [
        { question_id: "q1", chosen_index: 0 },
        { question_id: "q2", chosen_index: 0 },
      ],
    });
    expect(under.ok).toBe(true);
    if (under.ok) expect(under.result.prediction_error).toBeCloseTo(1 - 0.1, 5);
  });

  it("significant flag flips around |error| > 0.15", () => {
    // 10 questions so `score` lands on exact tenths — avoids floating-point noise right at
    // the 0.15 boundary that a single-question 1/0 score would introduce.
    const questions = Array.from({ length: 10 }, (_, i) => meta(`q${i}`));
    const answersCorrect = (n: number) => questions.map((q, i) => ({ question_id: q.question_id, chosen_index: i < n ? 0 : 1 }));

    const belowThreshold = scoreAssessment({ predicted_score: 0.5, questions, answers: answersCorrect(6) }); // score=0.6, error=0.10
    expect(belowThreshold.ok).toBe(true);
    if (belowThreshold.ok) expect(belowThreshold.result.significant).toBe(false);

    const aboveThreshold = scoreAssessment({ predicted_score: 0.5, questions, answers: answersCorrect(7) }); // score=0.7, error=0.20
    expect(aboveThreshold.ok).toBe(true);
    if (aboveThreshold.ok) expect(aboveThreshold.result.significant).toBe(true);
  });

  it("4 wrong answers produce 4 entries in newly_weak_questions", () => {
    const questions = [meta("q1"), meta("q2"), meta("q3"), meta("q4"), meta("q5")];
    const result = scoreAssessment({
      predicted_score: 0.5,
      questions,
      answers: [
        { question_id: "q1", chosen_index: 1 },
        { question_id: "q2", chosen_index: 1 },
        { question_id: "q3", chosen_index: 1 },
        { question_id: "q4", chosen_index: 1 },
        { question_id: "q5", chosen_index: 0 },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.newly_weak_questions).toHaveLength(4);
      expect(result.result.newly_weak_questions.sort()).toEqual(["q1", "q2", "q3", "q4"]);
    }
  });

  it("a correct answer on a revision-pool question clears it", () => {
    const questions = [meta("q1", { was_in_revision_pool: true }), meta("q2", { was_in_revision_pool: false })];
    const result = scoreAssessment({
      predicted_score: 0.5,
      questions,
      answers: [
        { question_id: "q1", chosen_index: 0 },
        { question_id: "q2", chosen_index: 0 },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.cleared_questions).toEqual(["q1"]);
  });

  it("an answer referencing an unknown question returns a clean error, no throw", () => {
    const result = scoreAssessment({ predicted_score: 0.5, questions: [meta("q1")], answers: [{ question_id: "ghost", chosen_index: 0 }] });
    expect(result.ok).toBe(false);
  });

  it("zero answers returns a clean error, no throw", () => {
    const result = scoreAssessment({ predicted_score: 0.5, questions: [meta("q1")], answers: [] });
    expect(result.ok).toBe(false);
  });

  it("per_difficulty accuracy is scoped to the difficulties present", () => {
    const questions = [meta("q1", { difficulty: 2 }), meta("q2", { difficulty: 4 }), meta("q3", { difficulty: 4 })];
    const result = scoreAssessment({
      predicted_score: 0.5,
      questions,
      answers: [
        { question_id: "q1", chosen_index: 0 },
        { question_id: "q2", chosen_index: 0 },
        { question_id: "q3", chosen_index: 1 },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.per_difficulty[2]).toBe(1);
      expect(result.result.per_difficulty[4]).toBe(0.5);
      expect(result.result.per_difficulty[1]).toBeUndefined();
    }
  });
});
