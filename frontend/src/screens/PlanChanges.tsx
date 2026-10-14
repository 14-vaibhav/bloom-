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
  if (!versions || versions.length === 0) return <Card><p className="text-sm text-zinc-500">No plan versions yet.</p></Card>;

  function pick(version: number) {
    if (from === null || (from !== null && to !== null)) { setFrom(version); setTo(null); setDiff(null); return; }
    const f = Math.min(from, version), t = Math.max(from, version);
    setFrom(f); setTo(t);
    api.get<PlanDiff>(`/students/${studentId}/plan/diff?from=${f}&to=${t}`).then(setDiff);
  }

  async function loadValidation(version: number) {
    const plan = await api.get<{ validation_report: ValidationReport | null }>(`/students/${studentId}/plan?version=${version}`);
    setValidation(plan.validation_report);
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-zinc-900 bg-zinc-950 px-8 py-8">
        <div className="text-xs uppercase tracking-widest text-zinc-600 mb-3">Plan Changes</div>
        <h1 className="text-3xl font-semibold text-zinc-100">Version History</h1>
        <p className="mt-2 text-base text-zinc-500">Click two versions to diff them. Each version records the trigger and scope that caused the replan.</p>
      </section>

      <div className="flex flex-wrap gap-2">
        {versions.map((v) => (
          <button
            key={v.version}
            onClick={() => { pick(v.version); loadValidation(v.version); }}
            className={`rounded-xl border px-4 py-3 text-left text-xs transition-colors ${
              from === v.version || to === v.version
                ? "border-zinc-600 bg-zinc-900 text-zinc-100"
                : "border-zinc-900 bg-zinc-950 text-zinc-400 hover:border-zinc-700"
            }`}
          >
            <div className="font-medium text-zinc-100">v{v.version}</div>
            <div className="text-zinc-500 mt-0.5">{v.trigger}</div>
            <div className="text-zinc-700">{v.scope}</div>
          </button>
        ))}
      </div>

      {diff && (
        <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-zinc-200">Diff v{from} → v{to}</p>
            <span className="text-xs text-zinc-600">{diff.unchanged_count} unchanged</span>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-widest text-emerald-500 mb-2">Added ({diff.added.length})</p>
              <ul className="space-y-1 text-sm text-emerald-400">
                {diff.added.map((a) => <li key={a.activity_id}>{a.subtopic_id} — {a.action}</li>)}
              </ul>
            </div>
            <div>
              <p className="text-xs uppercase tracking-widest text-rose-500 mb-2">Removed ({diff.removed.length})</p>
              <ul className="space-y-1 text-sm text-rose-400 line-through">
                {diff.removed.map((a) => <li key={a.activity_id}>{a.subtopic_id} — {a.action}</li>)}
              </ul>
            </div>
            <div>
              <p className="text-xs uppercase tracking-widest text-amber-500 mb-2">Moved ({diff.moved.length})</p>
              <ul className="space-y-1 text-sm text-amber-400">
                {diff.moved.map((m) => <li key={m.activity.activity_id}>{m.activity.subtopic_id}: {new Date(m.from).toLocaleTimeString()} → {new Date(m.to).toLocaleTimeString()}</li>)}
              </ul>
            </div>
            <div>
              <p className="text-xs uppercase tracking-widest text-zinc-400 mb-2">Modified ({diff.modified.length})</p>
              <ul className="space-y-1 text-sm text-zinc-400">
                {diff.modified.map((m, i) => <li key={i}>{m.activity.subtopic_id}: {m.field} {String(m.from)} → {String(m.to)}</li>)}
              </ul>
            </div>
          </div>
        </div>
      )}

      {validation && (
        <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-6">
          <p className="text-sm font-medium text-zinc-200 mb-1">Validation report</p>
          <p className="text-xs text-zinc-600 mb-3">Route: {validation.route} · Hard failures: {validation.hard_failures}</p>
          <pre className="max-h-64 overflow-auto rounded-xl border border-zinc-900 bg-black p-4 text-xs text-zinc-500">
            {JSON.stringify(validation, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
