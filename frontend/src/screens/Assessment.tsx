import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import type { AssessmentDetail, AssessmentSubmitResult, MasteryTree } from "../lib/types";
import { Card, ErrorBox, Loading } from "../components/ui";
import { CitationChip } from "../components/CitationChip";
import { SourceViewer } from "../components/SourceViewer";

export function AssessmentScreen({ studentId }: { studentId: string }) {
  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  const { data: tree } = useApiData(() => api.get<MasteryTree>(`/students/${studentId}/mastery-tree`), [studentId]);
  const [subtopicId, setSubtopicId] = useState("");
  const [starting, setStarting] = useState(false);

  if (assessmentId) return <AssessmentRunner assessmentId={assessmentId} />;

  const subtopics = (tree?.topics ?? []).flatMap((t) => t.subtopics);

  async function start() {
    if (!subtopicId) return;
    setStarting(true);
    try {
      const created = await api.post<{ assessment_id: string }>(`/students/${studentId}/assessments`, { student_id: studentId, subtopic_id: subtopicId, purpose: "immediate", count: 8 });
      setAssessmentId(created.assessment_id);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-100">Assessment</h1>
      <Card className="max-w-md">
        <label className="text-sm text-slate-300">Subtopic</label>
        <select value={subtopicId} onChange={(e) => setSubtopicId(e.target.value)} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100">
          <option value="">Choose a subtopic…</option>
          {subtopics.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button disabled={!subtopicId || starting} onClick={start} className="mt-3 rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40">
          {starting ? "Starting…" : "Start assessment"}
        </button>
      </Card>
    </div>
  );
}

export function AssessmentRunner({ assessmentId, onSubmitted }: { assessmentId: string; onSubmitted?: (result: AssessmentSubmitResult) => void }) {
  const { data: assessment, loading, error } = useApiData(() => api.get<AssessmentDetail>(`/assessments/${assessmentId}`), [assessmentId]);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<AssessmentSubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const navigate = useNavigate();

  if (loading) return <Loading label="Loading assessment…" />;
  if (error) return <ErrorBox message={error} />;
  if (!assessment) return null;

  if (result) {
    return (
      <Card className="max-w-lg">
        <h2 className="text-lg font-medium text-slate-100">Results</h2>
        <p className="mt-2 text-sm text-slate-300">Score: <span className="font-medium text-slate-100">{Math.round(result.score * 100)}%</span> (predicted {Math.round(result.predicted_score * 100)}%)</p>
        <p className="text-sm text-slate-400">Prediction error: {result.prediction_error.toFixed(2)}</p>
        <div className="mt-3">
          <p className="text-sm font-medium text-slate-200">Per concept</p>
          <ul className="mt-1 space-y-0.5 text-sm text-slate-400">
            {Object.entries(result.per_concept).map(([id, c]) => <li key={id}>{id}: {c.correct}/{c.total} ({Math.round(c.accuracy * 100)}%)</li>)}
          </ul>
        </div>
        {result.newly_weak_questions.length > 0 && (
          <p className="mt-3 text-sm text-amber-300">{result.newly_weak_questions.length} question(s) entered the revision pool — they'll resurface until answered correctly twice on separate days.</p>
        )}
        <WrongAnswers assessment={assessment} result={result} onOpen={setViewer} onExplain={(q) => navigate(`/tutor?${new URLSearchParams({ q: q.stem, question_id: q.question_id, assessment_id: assessmentId })}`)} />
        {viewer && <SourceViewer chunkId={viewer} onClose={() => setViewer(null)} />}
      </Card>
    );
  }

  const q = assessment.questions[index];
  const isLast = index === assessment.questions.length - 1;

  async function submit() {
    setSubmitting(true);
    try {
      const payload = { answers: Object.entries(answers).map(([question_id, chosen_index]) => ({ question_id, chosen_index })) };
      const submitted = await api.post<AssessmentSubmitResult>(`/assessments/${assessmentId}/submit`, payload);
      setResult(submitted);
      onSubmitted?.(submitted);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="max-w-lg">
      <p className="text-xs text-slate-500">Question {index + 1} of {assessment.questions.length} · {q.subtopic_id}</p>
      <p className="mt-2 text-slate-100">{q.stem}</p>
      <div className="mt-3 space-y-2">
        {q.options.map((opt, i) => (
          <label key={i} className={`block cursor-pointer rounded-lg border px-3 py-2 text-sm ${answers[q.question_id] === i ? "border-sky-500 bg-sky-950/40 text-sky-200" : "border-slate-800 text-slate-300 hover:border-slate-600"}`}>
            <input type="radio" name={q.question_id} className="sr-only" checked={answers[q.question_id] === i} onChange={() => setAnswers({ ...answers, [q.question_id]: i })} />
            {opt}
          </label>
        ))}
      </div>
      <div className="mt-4 flex justify-between">
        <button disabled={index === 0} onClick={() => setIndex((i) => i - 1)} className="rounded-md px-3 py-1.5 text-sm text-slate-400 disabled:opacity-30">Back</button>
        {isLast ? (
          <button disabled={submitting || answers[q.question_id] === undefined} onClick={submit} className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40">
            {submitting ? "Submitting…" : "Submit"}
          </button>
        ) : (
          <button disabled={answers[q.question_id] === undefined} onClick={() => setIndex((i) => i + 1)} className="rounded-md bg-slate-800 px-4 py-1.5 text-sm text-slate-100 disabled:opacity-40">Next</button>
        )}
      </div>
    </Card>
  );
}

/** v4 §N6.3: a wrong answer routes the student to the exact passage, not just a score. */
function WrongAnswers({ assessment, result, onOpen, onExplain }: {
  assessment: AssessmentDetail; result: AssessmentSubmitResult; onOpen: (chunkId: string) => void; onExplain: (q: AssessmentDetail["questions"][number]) => void;
}) {
  const sources = result.review_sources ?? {};
  const wrongIds = new Set([...Object.keys(sources), ...result.newly_weak_questions]);
  const wrong = assessment.questions.filter((q) => wrongIds.has(q.question_id));
  if (wrong.length === 0) return null;
  return (
    <div className="mt-4 space-y-3 border-t border-slate-800 pt-3">
      <p className="text-sm font-medium text-slate-200">Review these</p>
      {result.review_sources_note && <p className="text-xs text-amber-300/80">{result.review_sources_note}</p>}
      {wrong.map((q) => (
        <div key={q.question_id} className="rounded-lg border border-slate-800 p-3">
          <p className="text-sm text-slate-200">{q.stem}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {(sources[q.question_id] ?? []).map((s) => <CitationChip key={s.chunk_id} chunk={s} onOpen={onOpen} />)}
            <button onClick={() => onExplain(q)} className="ml-auto rounded-md border border-slate-700 px-2.5 py-0.5 text-xs text-slate-300 hover:border-sky-600">Explain this</button>
          </div>
        </div>
      ))}
    </div>
  );
}
