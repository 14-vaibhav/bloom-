import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import type { Activity, Plan } from "../lib/types";
import { ActionPill, Card, ErrorBox, Loading } from "../components/ui";

function formatName(raw: string): string {
  return raw
    .replace(/^(arr_|ll_|tr_|gr_|dp_|sq_|cn_|rdbms_|oop_)/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function dayKey(iso: string) {
  return new Date(iso).toISOString().slice(0, 10);
}

function ActivityCard({ activity, onOpen }: { activity: Activity; onOpen: () => void }) {
  const start = new Date(activity.scheduled_start);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-xl border border-zinc-900 bg-black p-4 text-left hover:border-zinc-700 transition-all group"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-zinc-100 group-hover:text-white truncate">
          {formatName(activity.subtopic_id)}
        </span>
        <ActionPill action={activity.action} />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-zinc-500 font-mono">
        <span>
          {start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {activity.duration_min}m
        </span>
        {activity.predicted_score !== null && (
          <span className="text-zinc-400">{Math.round(activity.predicted_score * 100)}% exp</span>
        )}
      </div>
      {activity.resource?.title && (
        <p className="mt-2 truncate text-xs text-zinc-500 font-sans" title={activity.resource.title}>
          ▶ {activity.resource.title.split(" — ")[0]}
        </p>
      )}
      <div className="mt-3 flex items-center gap-1.5">
        {activity.provisional && (
          <span className="rounded-md bg-amber-500/10 border border-amber-900/60 px-2 py-0.5 text-[10px] font-mono text-amber-400">
            provisional
          </span>
        )}
        <span
          className={`rounded-md border px-2 py-0.5 text-[10px] font-mono capitalize ${
            activity.status === "completed"
              ? "border-emerald-900/60 bg-emerald-950/20 text-emerald-400"
              : activity.status === "missed"
              ? "border-rose-900/60 bg-rose-950/20 text-rose-400"
              : "border-zinc-900 bg-zinc-950 text-zinc-500"
          }`}
        >
          {activity.status}
        </span>
      </div>
    </button>
  );
}

function ActivityDetail({
  activity,
  onClose,
  onReload,
}: {
  activity: Activity;
  onClose: () => void;
  onReload: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function markComplete() {
    setBusy(true);
    try {
      await api.post(`/activities/${activity.activity_id}/complete`, { actual_duration_min: activity.duration_min });
      onReload();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function markMissed() {
    setBusy(true);
    try {
      await api.post(`/activities/${activity.activity_id}/missed`, {});
      onReload();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3 pb-3 border-b border-zinc-900">
          <div>
            <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Scheduled Session</span>
            <h3 className="text-xl font-semibold text-white mt-0.5">{formatName(activity.subtopic_id)}</h3>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-500 hover:text-white transition-colors">
            ✕
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between border-b border-zinc-900 pb-2.5">
            <span className="text-zinc-500">Activity Type</span>
            <ActionPill action={activity.action} />
          </div>
          <div className="flex items-start justify-between border-b border-zinc-900 pb-2.5 gap-4">
            <span className="text-zinc-500 shrink-0">Resource</span>
            <span className="text-zinc-300 text-right text-xs">
              {activity.resource
                ? activity.resource.title
                : activity.resource_id ?? "Algorithmic question bank & reference notes"}
            </span>
          </div>
          <div className="flex justify-between border-b border-zinc-900 pb-2.5">
            <span className="text-zinc-500">Scheduled Duration</span>
            <span className="text-zinc-300 font-mono">{activity.duration_min} minutes</span>
          </div>
          <div className="flex justify-between border-b border-zinc-900 pb-2.5">
            <span className="text-zinc-500">Expected Accuracy</span>
            <span className="text-zinc-300 font-mono">
              {activity.predicted_score !== null ? `${Math.round(activity.predicted_score * 100)}%` : "Calibrating"}
            </span>
          </div>
          <div className="flex justify-between pb-1">
            <span className="text-zinc-500">Execution Status</span>
            <span className="text-zinc-300 font-mono capitalize">{activity.status}</span>
          </div>
        </div>

        {/* Quick Launch Actions */}
        <div className="mt-6 pt-4 border-t border-zinc-900 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => {
              navigate(`/tutor?q=${encodeURIComponent(`Explain key concepts and walk me through ${formatName(activity.subtopic_id)}`)}`);
              onClose();
            }}
            className="w-full rounded-xl bg-white py-2.5 text-xs font-semibold text-black hover:bg-zinc-200 transition-colors shadow-sm"
          >
            Study Topic with AI Tutor →
          </button>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={markComplete}
              className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-40 transition-colors"
            >
              Mark Completed ✓
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={markMissed}
              className="rounded-xl border border-zinc-800 bg-zinc-900 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 disabled:opacity-40 transition-colors"
            >
              Skip / Mark Missed
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function StudyPlan({ studentId }: { studentId: string }) {
  const { data: plan, loading, error, reload } = useApiData(() => api.get<Plan>(`/students/${studentId}/plan`), [studentId]);
  const [selected, setSelected] = useState<Activity | null>(null);
  const [filterMode, setFilterMode] = useState<"all" | "today" | "week">("all");

  if (loading) return <Loading label="Synthesizing personalized study timeline…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!plan) return <Card><p className="text-sm text-zinc-500">No active plan recorded.</p></Card>;

  const todayIso = new Date().toISOString().slice(0, 10);
  const byDay = new Map<string, Activity[]>();
  for (const a of plan.activities) {
    const k = dayKey(a.scheduled_start);
    byDay.set(k, [...(byDay.get(k) ?? []), a]);
  }

  let days = [...byDay.keys()].sort();
  if (filterMode === "today") {
    days = days.filter((d) => d === todayIso);
  } else if (filterMode === "week") {
    days = days.slice(0, 7);
  }

  return (
    <div className="space-y-8">
      {/* Header Banner */}
      <section className="rounded-3xl border border-zinc-900 bg-zinc-950 p-8 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-widest text-zinc-500 font-mono">Paced Curriculum Schedule</div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Your Study Timeline</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Optimized by Bloom solver (v{plan.version} · {plan.scope} · {plan.trigger})
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setFilterMode("all")}
              className={`rounded-xl px-3 py-1.5 text-xs font-medium transition-all ${
                filterMode === "all"
                  ? "border border-zinc-700 bg-zinc-900 text-white"
                  : "border border-zinc-900 bg-zinc-950 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              All Horizons
            </button>
            <button
              type="button"
              onClick={() => setFilterMode("week")}
              className={`rounded-xl px-3 py-1.5 text-xs font-medium transition-all ${
                filterMode === "week"
                  ? "border border-zinc-700 bg-zinc-900 text-white"
                  : "border border-zinc-900 bg-zinc-950 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Next 7 Days
            </button>
          </div>
        </div>
      </section>

      {/* Days Grid */}
      {days.length === 0 ? (
        <Card className="p-8 text-center space-y-3">
          <p className="text-base text-zinc-300 font-medium">No sessions scheduled for this window</p>
          <p className="text-xs text-zinc-500">Switch filter to "All Horizons" to view upcoming milestones.</p>
          <button
            type="button"
            onClick={() => setFilterMode("all")}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs text-zinc-200"
          >
            Show All Dates
          </button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {days.map((day) => {
            const dateObj = new Date(day);
            const isToday = day === todayIso;
            const items = byDay.get(day) ?? [];

            return (
              <div
                key={day}
                className={`rounded-2xl border p-5 flex flex-col justify-between transition-all ${
                  isToday
                    ? "border-zinc-700 bg-zinc-950/90 ring-1 ring-zinc-700"
                    : "border-zinc-900 bg-zinc-950"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between pb-3 border-b border-zinc-900/80 mb-3">
                    <div>
                      <p className="text-sm font-semibold text-white">
                        {dateObj.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                      </p>
                      <p className="text-[11px] text-zinc-500 font-mono">{items.length} sessions planned</p>
                    </div>
                    {isToday && (
                      <span className="rounded-md border border-emerald-900/60 bg-emerald-950/30 px-2 py-0.5 text-[10px] font-mono text-emerald-400">
                        Today
                      </span>
                    )}
                  </div>

                  <div className="space-y-2.5">
                    {items.map((a) => (
                      <ActivityCard key={a.activity_id} activity={a} onOpen={() => setSelected(a)} />
                    ))}
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-zinc-900 text-xs text-zinc-600 font-mono flex justify-between">
                  <span>Total Effort:</span>
                  <span>{items.reduce((sum, a) => sum + a.duration_min, 0)} mins</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selected && (
        <ActivityDetail activity={selected} onClose={() => setSelected(null)} onReload={reload} />
      )}
    </div>
  );
}
