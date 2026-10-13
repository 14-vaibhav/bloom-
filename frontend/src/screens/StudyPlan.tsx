import { useState } from "react";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import type { Activity, Plan } from "../lib/types";
import { ActionPill, Card, ErrorBox, Loading } from "../components/ui";

function dayKey(iso: string) {
  return new Date(iso).toISOString().slice(0, 10);
}

function ActivityCard({ activity, onOpen }: { activity: Activity; onOpen: () => void }) {
  const start = new Date(activity.scheduled_start);
  return (
    <button onClick={onOpen} className="w-full rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-left hover:border-slate-600">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-100">{activity.subtopic_id}</span>
        <ActionPill action={activity.action} />
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
        <span>{start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {activity.duration_min}min</span>
        {activity.predicted_score !== null && <span>{Math.round(activity.predicted_score * 100)}% predicted</span>}
      </div>
      {activity.resource?.source_id && <p className="mt-1 truncate text-xs text-sky-300" title={activity.resource.title}>▶ {activity.resource.title.split(" — ")[0]}</p>}
      {activity.provisional && <span className="mt-1 inline-block rounded bg-orange-900/40 px-1.5 py-0.5 text-[10px] text-orange-300">provisional</span>}
      {activity.status !== "planned" && <span className="ml-1 mt-1 inline-block rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{activity.status}</span>}
    </button>
  );
}

function ActivityDetail({ activity, onClose }: { activity: Activity; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-lg font-medium text-slate-100">{activity.subtopic_id}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">✕</button>
        </div>
        <div className="space-y-1 text-sm text-slate-300">
          <p><span className="text-slate-500">Action:</span> {activity.action}</p>
          <p><span className="text-slate-500">Resource:</span> {activity.resource ? (activity.resource.source_id ? `${activity.resource.title} (from your course material)` : activity.resource.title) : activity.resource_id ?? "question bank (no resource)"}</p>
          {activity.resource?.url && <p><a href={activity.resource.url} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">Open{activity.resource.source_id ? " at this place" : ""} ↗</a></p>}
          <p><span className="text-slate-500">Duration:</span> {activity.duration_min} min</p>
          <p><span className="text-slate-500">Priority:</span> {activity.priority ?? "—"}</p>
          <p><span className="text-slate-500">Predicted score:</span> {activity.predicted_score !== null ? `${Math.round(activity.predicted_score * 100)}%` : "—"}</p>
          <p><span className="text-slate-500">Status:</span> {activity.status}{activity.provisional ? " (provisional — a tool was degraded when this was scheduled)" : ""}</p>
        </div>
      </div>
    </div>
  );
}

export function StudyPlan({ studentId }: { studentId: string }) {
  const { data: plan, loading, error, reload } = useApiData(() => api.get<Plan>(`/students/${studentId}/plan`), [studentId]);
  const [selected, setSelected] = useState<Activity | null>(null);

  if (loading) return <Loading label="Loading study plan…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!plan) return <Card><p className="text-sm text-slate-400">No plan yet.</p></Card>;

  const byDay = new Map<string, Activity[]>();
  for (const a of plan.activities) byDay.set(dayKey(a.scheduled_start), [...(byDay.get(dayKey(a.scheduled_start)) ?? []), a]);
  const days = [...byDay.keys()].sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Study Plan</h1>
        <span className="text-sm text-slate-400">v{plan.version} · {plan.scope} · {plan.trigger}</span>
      </div>
      <p className="text-sm text-slate-400">{plan.reason}</p>

      {days.length === 0 ? (
        <Card><p className="text-sm text-slate-400">No activities scheduled.</p></Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {days.map((day) => (
            <Card key={day}>
              <p className="mb-2 text-sm font-medium text-slate-200">{new Date(day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</p>
              <div className="space-y-2">
                {byDay.get(day)!.map((a) => <ActivityCard key={a.activity_id} activity={a} onOpen={() => setSelected(a)} />)}
              </div>
            </Card>
          ))}
        </div>
      )}

      {selected && <ActivityDetail activity={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
