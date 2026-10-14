import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import type { AssessmentDetail, AssessmentSubmitResult, MasteryTree } from "../lib/types";
import { Card, ErrorBox, Loading } from "../components/ui";
import { CitationChip } from "../components/CitationChip";
import { SourceViewer } from "../components/SourceViewer";

function formatName(raw: string): string {
  return raw
    .replace(/^(arr_|ll_|tr_|gr_|dp_|sq_|cn_|rdbms_|oop_)/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function AssessmentScreen({ studentId }: { studentId: string }) {
  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  const { data: tree, loading: treeLoading, error: treeError, reload } = useApiData(
    () => api.get<MasteryTree>(`/students/${studentId}/mastery-tree`),
    [studentId],
  );
  const [selectedSubtopic, setSelectedSubtopic] = useState("");
  const [starting, setStarting] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");

  if (assessmentId) return <AssessmentRunner assessmentId={assessmentId} onReset={() => setAssessmentId(null)} />;
  if (treeLoading) return <Loading label="Loading assessment question banks…" />;
  if (treeError) return <ErrorBox message={treeError} onRetry={reload} />;

  const subtopics = (tree?.topics ?? []).flatMap((t) => t.subtopics);
  const filtered = subtopics.filter((s) => !filterQuery || s.name.toLowerCase().includes(filterQuery.toLowerCase()));

  async function start(subtopic: string) {
    if (!subtopic || starting) return;
    setStarting(true);
    try {
      const created = await api.post<{ assessment_id: string }>(`/students/${studentId}/assessments`, {
        student_id: studentId,
        subtopic_id: subtopic,
        purpose: "immediate",
        count: 8,
      });
      setAssessmentId(created.assessment_id);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Header Banner */}
      <section className="rounded-3xl border border-zinc-900 bg-zinc-950 p-8 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-widest text-zinc-500 font-mono">Deliberate Practice</div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Knowledge Checkpoints</h1>
            <p className="text-sm text-zinc-400 mt-1">
              8-question diagnostic quizzes with quote-verified feedback and Bayesian mastery calibration.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="text"
              placeholder="Search concepts…"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className="rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none w-48"
            />
          </div>
        </div>
      </section>

      {/* Subtopics Practice Cards Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Select a Concept to Practice</h2>
          <span className="text-xs text-zinc-500 font-mono">{filtered.length} subtopics available</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((s) => {
            const mastery = Math.round(s.mu * 100);
            return (
              <div
                key={s.id}
                className="rounded-2xl border border-zinc-900 bg-zinc-950 p-5 flex flex-col justify-between hover:border-zinc-800 transition-all group"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-zinc-100 group-hover:text-white">{s.name}</span>
                    <span
                      className={`rounded-md border px-2 py-0.5 text-[10px] font-mono ${
                        s.badge === "green"
                          ? "border-emerald-900/60 bg-emerald-950/20 text-emerald-400"
                          : s.badge === "amber"
                          ? "border-amber-900/60 bg-amber-950/20 text-amber-400"
                          : "border-zinc-800 bg-zinc-900 text-zinc-400"
                      }`}
                    >
                      {mastery}% mastery
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-zinc-500 font-mono">Target: {Math.round(s.target_mastery * 100)}%</p>
                </div>

                <div className="mt-5 pt-3 border-t border-zinc-900/80 flex items-center justify-between">
                  <span className="text-[11px] text-zinc-600 font-mono">8 questions</span>
                  <button
                    type="button"
                    disabled={starting}
                    onClick={() => start(s.id)}
                    className="rounded-xl bg-white px-3.5 py-1.5 text-xs font-semibold text-black hover:bg-zinc-200 disabled:opacity-40 transition-colors shadow-sm"
                  >
                    Start Quiz →
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function AssessmentRunner({
  assessmentId,
  onSubmitted,
  onReset,
}: {
  assessmentId: string;
  onSubmitted?: (result: AssessmentSubmitResult) => void;
  onReset?: () => void;
}) {
  const { data: assessment, loading, error } = useApiData(
    () => api.get<AssessmentDetail>(`/assessments/${assessmentId}`),
    [assessmentId],
  );
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<AssessmentSubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const navigate = useNavigate();

  if (loading) return <Loading label="Loading quiz questions from verified course bank…" />;
  if (error) return <ErrorBox message={error} />;
  if (!assessment) return null;

  if (result) {
    const accuracy = Math.round(result.score * 100);
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <section className="rounded-3xl border border-zinc-900 bg-zinc-950 p-8 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-widest text-zinc-500 font-mono">Evaluation Completed</div>
              <h1 className="text-4xl font-semibold tracking-tight text-white mt-1">{accuracy}% Accuracy</h1>
              <p className="mt-1 text-xs text-zinc-400 font-mono">
                Bayesian Prior: {Math.round(result.predicted_score * 100)}% · Calibration Error:{" "}
                {result.prediction_error.toFixed(2)}
              </p>
            </div>
            {onReset && (
              <button
                type="button"
                onClick={onReset}
                className="rounded-xl bg-white px-4 py-2 text-xs font-semibold text-black hover:bg-zinc-200 transition-colors shrink-0"
              >
                Practice Another Concept →
              </button>
            )}
          </div>
        </section>

        {/* Concept Results Table */}
        <Card className="p-6">
          <p className="text-sm font-semibold text-white mb-3">Concept Mastery Calibration</p>
          <table className="w-full text-xs">
            <tbody>
              {Object.entries(result.per_concept).map(([id, c]) => (
                <tr key={id} className="border-b border-zinc-900 last:border-0 font-mono">
                  <td className="py-2.5 pr-4 text-zinc-400 font-sans">{formatName(id)}</td>
                  <td className="py-2.5 text-right font-medium text-zinc-100">
                    {c.correct}/{c.total} ({Math.round(c.accuracy * 100)}%)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {result.newly_weak_questions.length > 0 && (
          <div className="rounded-2xl border border-amber-900/60 bg-amber-950/20 p-4 text-xs text-amber-300">
            {result.newly_weak_questions.length} question(s) flagged for revision will be automatically re-tested by Bloom's spaced repetition engine.
          </div>
        )}

        <WrongAnswers
          assessment={assessment}
          result={result}
          onOpen={setViewer}
          onExplain={(q) =>
            navigate(
              `/tutor?${new URLSearchParams({
                q: `Explain this question and walk me through the solution: "${q.stem}"`,
                question_id: q.question_id,
                assessment_id: assessmentId,
              })}`,
            )
          }
        />

        {viewer && <SourceViewer chunkId={viewer} onClose={() => setViewer(null)} />}
      </div>
    );
  }

  const q = assessment.questions[index];
  const isLast = index === assessment.questions.length - 1;
  const answeredCount = Object.keys(answers).length;

  async function submit() {
    setSubmitting(true);
    try {
      const payload = {
        answers: Object.entries(answers).map(([question_id, chosen_index]) => ({ question_id, chosen_index })),
      };
      const submitted = await api.post<AssessmentSubmitResult>(`/assessments/${assessmentId}/submit`, payload);
      setResult(submitted);
      onSubmitted?.(submitted);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Quiz Progress & Question Card */}
      <div className="rounded-3xl border border-zinc-900 bg-zinc-950 p-8 shadow-xl space-y-4">
        <div className="flex items-center justify-between text-xs text-zinc-500 font-mono pb-3 border-b border-zinc-900">
          <span>
            Question <span className="text-zinc-200 font-bold">{index + 1}</span> of {assessment.questions.length}
          </span>
          <span className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-zinc-300">
            {formatName(q.subtopic_id)}
          </span>
        </div>

        <p className="text-lg font-medium text-white leading-relaxed pt-1">{q.stem}</p>
      </div>

      {/* Answer Options */}
      <div className="space-y-3">
        {q.options.map((opt, i) => {
          const isSelected = answers[q.question_id] === i;
          const letter = "ABCD"[i] ?? i + 1;
          return (
            <label
              key={i}
              className={`flex items-center gap-4 cursor-pointer rounded-2xl border px-5 py-4 text-sm transition-all ${
                isSelected
                  ? "border-zinc-500 bg-zinc-900/90 text-white shadow-md ring-1 ring-zinc-500"
                  : "border-zinc-900 bg-zinc-950 text-zinc-400 hover:border-zinc-800 hover:text-zinc-200"
              }`}
            >
              <input
                type="radio"
                name={q.question_id}
                className="sr-only"
                checked={isSelected}
                onChange={() => setAnswers({ ...answers, [q.question_id]: i })}
              />
              <span
                className={`h-7 w-7 rounded-xl border flex items-center justify-center text-xs font-mono font-semibold shrink-0 transition-all ${
                  isSelected ? "border-white bg-white text-black" : "border-zinc-800 bg-black text-zinc-500"
                }`}
              >
                {letter}
              </span>
              <span className="leading-relaxed flex-1">{opt}</span>
            </label>
          );
        })}
      </div>

      {/* Bottom Navigation */}
      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => setIndex((i) => i - 1)}
          className="rounded-xl border border-zinc-900 bg-zinc-950 px-5 py-2.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors"
        >
          ← Previous
        </button>

        <span className="text-xs text-zinc-500 font-mono">
          {answeredCount} of {assessment.questions.length} answered
        </span>

        {isLast ? (
          <button
            type="button"
            disabled={submitting || answers[q.question_id] === undefined}
            onClick={submit}
            className="rounded-xl bg-white px-6 py-2.5 text-xs font-semibold text-black hover:bg-zinc-200 disabled:opacity-40 transition-colors shadow-sm"
          >
            {submitting ? "Submitting…" : "Submit Checkpoint ✓"}
          </button>
        ) : (
          <button
            type="button"
            disabled={answers[q.question_id] === undefined}
            onClick={() => setIndex((i) => i + 1)}
            className="rounded-xl bg-white px-6 py-2.5 text-xs font-semibold text-black hover:bg-zinc-200 disabled:opacity-40 transition-colors shadow-sm"
          >
            Next Question →
          </button>
        )}
      </div>
    </div>
  );
}

function WrongAnswers({
  assessment,
  result,
  onOpen,
  onExplain,
}: {
  assessment: AssessmentDetail;
  result: AssessmentSubmitResult;
  onOpen: (chunkId: string) => void;
  onExplain: (q: AssessmentDetail["questions"][number]) => void;
}) {
  const sources = result.review_sources ?? {};
  const wrongIds = new Set([...Object.keys(sources), ...result.newly_weak_questions]);
  const wrong = assessment.questions.filter((q) => wrongIds.has(q.question_id));
  if (wrong.length === 0) return null;

  return (
    <div className="space-y-4 pt-4 border-t border-zinc-900">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Recommended Reviews & Evidence</h3>
        <span className="text-xs text-zinc-500 font-mono">{wrong.length} missed</span>
      </div>

      <div className="space-y-3">
        {wrong.map((q) => (
          <div key={q.question_id} className="rounded-2xl border border-zinc-900 bg-zinc-950 p-5 space-y-3">
            <p className="text-sm text-zinc-200 leading-relaxed">{q.stem}</p>
            <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-zinc-900">
              {(sources[q.question_id] ?? []).map((s) => (
                <CitationChip key={s.chunk_id} chunk={s} onOpen={onOpen} />
              ))}
              <button
                type="button"
                onClick={() => onExplain(q)}
                className="ml-auto rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:text-white transition-colors"
              >
                Explain with AI Tutor →
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
