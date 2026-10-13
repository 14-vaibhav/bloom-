import { useState } from "react";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import type { PlanDiff, PlanVersionSummary, ValidationReport } from "../lib/types";
import { Card, ErrorBox, Loading } from "../components/ui";

export function PlanChanges({ studentId }: { studentId: string }) {
  const { data: versions, loading, error, reload } = useApiData(() => api.get<PlanVersionSummary[]>(`/students/${studentId}/plans`), [studentId]);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [diff, setDiff] = useState<PlanDiff | null>(null);
  const [validation, setValidation] = useState<ValidationReport | null>(null);

  if (loading) return <Loading label="Loading plan history…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!versions || versions.length === 0) return <Card><p className="text-sm text-slate-400">No plan versions yet.</p></Card>;

  function pick(version: number) {
    if (from === null || (from !== null && to !== null)) { setFrom(version); setTo(null); setDiff(null); return; }
    const f = Math.min(from, version), t = Math.max(from, version);
    setFrom(f); setTo(t);
    api.get<PlanDiff>(`/students/${studentId}/plan/diff?from=${f}&to=${t}`).then(setDiff);
  }

  async function loadValidation(version: number) {
    // plan-versions/:id needs the version ROW id, not the number — fetch the plan payload
    // for that version, whose validation_report is embedded directly.
    const plan = await api.get<{ validation_report: ValidationReport | null }>(`/students/${studentId}/plan?version=${version}`);
    setValidation(plan.validation_report);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-100">Plan Changes</h1>

      <div className="flex flex-wrap gap-2">
        {versions.map((v) => (
          <button
            key={v.version}
            onClick={() => { pick(v.version); loadValidation(v.version); }}
            className={`rounded-lg border px-3 py-2 text-left text-xs ${from === v.version || to === v.version ? "border-sky-500 bg-sky-950/40" : "border-slate-800 bg-slate-900/60 hover:border-slate-600"}`}
          >
            <div className="font-medium text-slate-100">v{v.version}</div>
            <div className="text-slate-400">{v.trigger}</div>
            <div className="text-slate-500">{v.scope}</div>
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">Click two versions to diff them.</p>

      {diff && (
        <Card>
          <p className="mb-2 text-sm font-medium text-slate-200">Diff v{from} → v{to}</p>
          <p className="mb-3 text-sm font-medium text-emerald-400">{diff.unchanged_count} unchanged</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase text-emerald-400">Added ({diff.added.length})</p>
              <ul className="mt-1 space-y-0.5 text-sm text-emerald-300">{diff.added.map((a) => <li key={a.activity_id}>{a.subtopic_id} — {a.action}</li>)}</ul>
            </div>
            <div>
              <p className="text-xs uppercase text-rose-400">Removed ({diff.removed.length})</p>
              <ul className="mt-1 space-y-0.5 text-sm text-rose-300 line-through">{diff.removed.map((a) => <li key={a.activity_id}>{a.subtopic_id} — {a.action}</li>)}</ul>
            </div>
            <div>
              <p className="text-xs uppercase text-amber-400">Moved ({diff.moved.length})</p>
              <ul className="mt-1 space-y-0.5 text-sm text-amber-300">{diff.moved.map((m) => <li key={m.activity.activity_id}>{m.activity.subtopic_id}: {new Date(m.from).toLocaleTimeString()} → {new Date(m.to).toLocaleTimeString()}</li>)}</ul>
            </div>
            <div>
              <p className="text-xs uppercase text-sky-400">Modified ({diff.modified.length})</p>
              <ul className="mt-1 space-y-0.5 text-sm text-sky-300">{diff.modified.map((m, i) => <li key={i}>{m.activity.subtopic_id}: {m.field} {String(m.from)} → {String(m.to)}</li>)}</ul>
            </div>
          </div>
        </Card>
      )}

      {validation && (
        <Card>
          <p className="mb-2 text-sm font-medium text-slate-200">Validation report</p>
          <p className="text-sm text-slate-400">Route: {validation.route} · Hard failures: {validation.hard_failures}</p>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-950 p-2 text-xs text-slate-400">{JSON.stringify(validation, null, 2)}</pre>
        </Card>
      )}
    </div>
  );
}
