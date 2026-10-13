import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import type { DailySummary, StudentState } from "../lib/types";
import { Bar, Card, ErrorBox, Loading, StatusPill } from "../components/ui";

function Gauge({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-slate-400">
        <span>{label}</span>
        <span>{value === null ? "n/a" : `${Math.round(value * 100)}%`}</span>
      </div>
      <Bar value={value ?? 0} />
    </div>
  );
}

export function Dashboard({ studentId }: { studentId: string }) {
  const state = useApiData(() => api.get<StudentState>(`/students/${studentId}/state`), [studentId]);
  const summary = useApiData(
    () => api.get<DailySummary>(`/students/${studentId}/daily-summary`).catch(() => null as unknown as DailySummary),
    [studentId],
  );

  if (state.loading) return <Loading label="Loading dashboard…" />;
  if (state.error) return <ErrorBox message={state.error} onRetry={state.reload} />;
  if (!state.data?.goal) return (
    <Card>
      <p className="text-sm text-slate-400">No active goal yet.</p>
      <Link to="/onboarding" className="mt-2 inline-block rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white">Start onboarding</Link>
    </Card>
  );

  const { student, goal, plan, recent_mastery } = state.data;
  const daily = summary.data;
  const signals = daily?.signals;
  const weakest = [...recent_mastery].sort((a, b) => a.mu - b.mu).slice(0, 3);
  const deadline = new Date(`${goal.deadline}T23:59:59Z`);
  // Bloom runs on a simulated clock (student.sim_now), not the viewer's wall-clock time —
  // the Demo Panel advances it independently of real time, so every "today" here must be
  // relative to sim_now or it silently disagrees with what the agent itself just acted on.
  const simNow = new Date(student.sim_now);
  const daysLeft = Math.max(0, Math.ceil((deadline.getTime() - simNow.getTime()) / 86_400_000));
  const simToday = simNow.toDateString();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-100">{goal.title}</h1>
        {daily?.status && <StatusPill status={daily.status} />}
        {plan && <span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-300">plan v{plan.current_version}</span>}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card><p className="text-xs text-slate-400">Deadline</p><p className="text-lg text-slate-100">{goal.deadline}</p><p className="text-xs text-slate-500">{daysLeft} days left</p></Card>
        <Card><p className="text-xs text-slate-400">Hours needed / available</p><p className="text-lg text-slate-100">{signals ? `${signals.requiredHours.toFixed(1)}h / ${signals.availableHours.toFixed(1)}h` : "—"}</p></Card>
        <Card><p className="text-xs text-slate-400">Buffer</p><p className="text-lg text-slate-100">{signals?.bufferDays !== null && signals?.bufferDays !== undefined ? `${signals.bufferDays.toFixed(1)} days` : "—"}</p></Card>
      </div>

      <Card>
        <p className="mb-3 text-sm font-medium text-slate-200">Progress signals</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Gauge label="Attendance (14d)" value={signals?.attendance14d ?? null} />
          <Gauge label="Trajectory" value={signals?.trajectory ?? null} />
          <Gauge label="Arrival (buffer)" value={signals?.bufferDays !== null && signals?.bufferDays !== undefined ? Math.max(0, Math.min(1, (signals.bufferDays + 5) / 10)) : null} />
        </div>
        <p className="mt-2 text-[11px] text-slate-500">Kept separate deliberately — a healthy attendance bar with a falling trajectory bar means "showing up but not learning," which a single blended number would hide.</p>
      </Card>

      {daily?.message && (
        <Card>
          <p className="text-sm font-medium text-slate-200">Today's summary</p>
          <p className="mt-1 text-sm text-slate-300">{daily.message}</p>
          {daily.motivation && <p className="mt-1 text-sm text-slate-400">{daily.motivation}</p>}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <p className="mb-2 text-sm font-medium text-slate-200">Today's activities</p>
          {(plan?.upcoming_activities ?? []).filter((a) => new Date(a.scheduled_start).toDateString() === simToday).length === 0 ? (
            <p className="text-sm text-slate-500">Nothing scheduled today.</p>
          ) : (
            <ul className="space-y-1 text-sm text-slate-300">
              {plan!.upcoming_activities.filter((a) => new Date(a.scheduled_start).toDateString() === simToday).map((a) => (
                <li key={a.activity_id} className="flex justify-between">
                  <span>{a.subtopic_id} — {a.action}</span>
                  <span className="text-slate-500">{a.predicted_score !== null ? `${Math.round(a.predicted_score * 100)}%` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <p className="mb-2 text-sm font-medium text-slate-200">Top weaknesses</p>
          {weakest.length === 0 ? <p className="text-sm text-slate-500">No mastery data yet.</p> : (
            <ul className="space-y-1 text-sm text-slate-300">
              {weakest.map((w) => (
                <li key={w.subtopic_id} className="flex justify-between"><span>{w.subtopic_id}</span><span className="text-slate-500">{Math.round(w.mu * 100)}%</span></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
