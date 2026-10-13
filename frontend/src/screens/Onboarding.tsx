import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import { useAgentStream } from "../lib/useAgentStream";
import type { AssessmentDetail, StudentState, Subject, SubjectTree } from "../lib/types";
import { Card, ErrorBox, Loading } from "../components/ui";
import { AssessmentRunner } from "./Assessment";

const DAYS = [
  { key: "1", label: "Mon" }, { key: "2", label: "Tue" }, { key: "3", label: "Wed" }, { key: "4", label: "Thu" },
  { key: "5", label: "Fri" }, { key: "6", label: "Sat" }, { key: "0", label: "Sun" },
];

type Step = "subject" | "deadline" | "blueprint" | "diagnostic" | "running";

export function Onboarding({ studentId, onComplete }: { studentId: string; onComplete: () => void }) {
  const [step, setStep] = useState<Step>("subject");
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [deadline, setDeadline] = useState("");
  const [maxDailyMin, setMaxDailyMin] = useState(90);
  const [availability, setAvailability] = useState<Record<string, Array<{ start: string; end: string }>>>({});
  const [goalId, setGoalId] = useState<string | null>(null);
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [assessmentId, setAssessmentId] = useState<string | null>(null);

  const { data: subjects, loading: subjectsLoading, error: subjectsError } = useApiData(() => api.get<Subject[]>("/subjects"), []);
  const { data: tree } = useApiData(() => (subjectId ? api.get<SubjectTree>(`/subjects/${subjectId}/tree`) : Promise.resolve(null as SubjectTree | null)), [subjectId]);
  // Deadline validity (7-60 days out) is checked server-side against the student's simulated
  // clock, not the viewer's wall-clock time — the picker bounds must agree with that or every
  // demo student (whose sim_now can be months from real "now") sees a confusing 400 on submit.
  const { data: studentState } = useApiData(() => api.get<StudentState>(`/students/${studentId}/state`), [studentId]);
  const simNow = studentState ? new Date(studentState.student.sim_now) : new Date();

  const usableHours = useMemo(() => {
    let minutes = 0;
    for (const windows of Object.values(availability)) for (const w of windows) {
      const [sh, sm] = w.start.split(":").map(Number);
      const [eh, em] = w.end.split(":").map(Number);
      minutes += Math.max(0, (eh * 60 + em) - (sh * 60 + sm));
    }
    return (minutes * 4.3) / 60; // rough weeks-per-month multiplier for a "usable hours" readout
  }, [availability]);

  function toggleDay(day: string) {
    setAvailability((prev) => {
      const next = { ...prev };
      if (next[day]) delete next[day];
      else next[day] = [{ start: "18:00", end: "20:00" }];
      return next;
    });
  }

  async function createGoal() {
    const created = await api.post<{ goal_id: string; blueprint: Record<string, number> }>("/goals", {
      student_id: studentId, subject_id: subjectId, deadline, availability, max_daily_min: maxDailyMin,
    });
    setGoalId(created.goal_id);
    setWeights(created.blueprint);
    setStep("blueprint");
  }

  async function confirmBlueprint() {
    const kept = Object.fromEntries(Object.entries(weights).filter(([id]) => !dropped.has(id)));
    await api.post(`/goals/${goalId}/blueprint`, { weights: kept, dropped: [...dropped] });
    const diagnostic = await api.get<AssessmentDetail & { assessment_id: string }>(`/goals/${goalId}/diagnostic`);
    setAssessmentId(diagnostic.assessment_id);
    setStep("diagnostic");
  }

  if (step === "subject") {
    if (subjectsLoading) return <Loading label="Loading subjects…" />;
    if (subjectsError) return <ErrorBox message={subjectsError} />;
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold text-slate-100">What are you studying for?</h1>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[...(subjects ?? [])].sort((a, b) => Number(b.id === "dsa") - Number(a.id === "dsa")).map((s) => (
            <button key={s.id} onClick={() => { setSubjectId(s.id); setStep("deadline"); }} className={`rounded-xl border bg-slate-900/60 p-4 text-left hover:border-sky-600 ${s.id === "dsa" ? "border-sky-700" : "border-slate-800"}`}>
              <p className="text-lg font-medium text-slate-100">{s.name}{s.id === "dsa" && <span className="ml-2 rounded bg-sky-500/20 px-1.5 py-0.5 align-middle text-[10px] font-medium text-sky-300">default</span>}</p>
              <p className="mt-1 text-sm text-slate-400">{s.description}</p>
              <p className="mt-2 text-xs text-slate-500">{s.topic_count} subtopics</p>
              {s.has_course_material === false && <p className="mt-1 text-xs text-amber-400/80">No course material ingested — the tutor and source links are unavailable for this subject.</p>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (step === "deadline") {
    const min = new Date(simNow.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    const max = new Date(simNow.getTime() + 60 * 86_400_000).toISOString().slice(0, 10);
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-2xl font-semibold text-slate-100">When's your deadline?</h1>
        <Card>
          <label className="text-sm text-slate-300">Deadline (7–60 days out)</label>
          <input type="date" min={min} max={max} value={deadline} onChange={(e) => setDeadline(e.target.value)} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100" />
        </Card>
        <Card>
          <p className="mb-2 text-sm text-slate-300">Which evenings can you study?</p>
          <div className="flex gap-2">
            {DAYS.map((d) => (
              <button key={d.key} onClick={() => toggleDay(d.key)} className={`rounded-md border px-3 py-2 text-xs ${availability[d.key] ? "border-sky-500 bg-sky-950/40 text-sky-200" : "border-slate-800 text-slate-400"}`}>
                {d.label}
              </button>
            ))}
          </div>
          <label className="mt-3 block text-sm text-slate-300">Max minutes/day</label>
          <input type="number" min={15} max={360} value={maxDailyMin} onChange={(e) => setMaxDailyMin(Number(e.target.value))} className="mt-1 w-32 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100" />
          <p className="mt-2 text-xs text-slate-500">~{usableHours.toFixed(0)} usable hours over the study window at this pace.</p>
        </Card>
        <button disabled={!deadline || Object.keys(availability).length === 0} onClick={createGoal} className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
          Continue
        </button>
      </div>
    );
  }

  if (step === "blueprint") {
    if (!tree) return <Loading label="Loading subject tree…" />;
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold text-slate-100">Confirm what to cover</h1>
        {tree.topics.map((topic) => (
          <Card key={topic.id}>
            <p className="mb-2 text-sm font-medium text-slate-200">{topic.name}</p>
            <div className="space-y-1">
              {topic.subtopics.map((s) => (
                <div key={s.id} className="flex items-center justify-between text-sm">
                  <label className="flex items-center gap-2 text-slate-300">
                    <input type="checkbox" checked={!dropped.has(s.id)} onChange={() => setDropped((prev) => { const n = new Set(prev); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
                    {s.name}
                  </label>
                  <span className="text-xs text-slate-500">{((weights[s.id] ?? 0) * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </Card>
        ))}
        <button onClick={confirmBlueprint} className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white">Confirm and take diagnostic</button>
      </div>
    );
  }

  if (step === "diagnostic" && assessmentId) {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <h1 className="text-2xl font-semibold text-slate-100">Quick diagnostic</h1>
        <p className="text-sm text-slate-400">15 questions across everything you just confirmed — this seeds Bloom's first belief estimates.</p>
        <DiagnosticWrapper assessmentId={assessmentId} onDone={() => setStep("running")} />
      </div>
    );
  }

  return <FirstRun studentId={studentId} onComplete={onComplete} />;
}

function DiagnosticWrapper({ assessmentId, onDone }: { assessmentId: string; onDone: () => void }) {
  const [submitted, setSubmitted] = useState(false);
  if (submitted) {
    return (
      <Card>
        <p className="text-sm text-slate-300">Diagnostic submitted.</p>
        <button onClick={onDone} className="mt-3 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white">Build my plan</button>
      </Card>
    );
  }
  return <AssessmentRunner assessmentId={assessmentId} onSubmitted={() => setSubmitted(true)} />;
}

/** Streams live agent events during the first FULL plan build — "the most convincing
 * thirty seconds in the product" (bloom-phase8-brief §A5). */
function FirstRun({ studentId, onComplete }: { studentId: string; onComplete: () => void }) {
  const { events } = useAgentStream(studentId);
  const [done, setDone] = useState(false);
  const [started, setStarted] = useState(false);

  if (!started) {
    setStarted(true);
    void api.post("/agent/run", { student_id: studentId }).then(() => setDone(true));
  }

  return (
    <div className="mx-auto max-w-lg space-y-3">
      <h1 className="text-2xl font-semibold text-slate-100">Building your plan…</h1>
      <div className="max-h-96 space-y-1 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/50 p-3">
        {events.map((e) => <p key={e.id} className="text-xs text-slate-400"><span className="text-slate-600">{e.phase}</span> {e.message}</p>)}
        {events.length === 0 && <p className="text-xs text-slate-500">Waiting for the agent…</p>}
      </div>
      {done && <button onClick={onComplete} className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white">See my dashboard</button>}
    </div>
  );
}
