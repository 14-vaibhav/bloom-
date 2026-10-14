import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import type { DailySummary, StudentState } from "../lib/types";
import { Bar, Card, ErrorBox, Loading, StatusPill } from "../components/ui";

function formatName(raw: string): string {
  return raw
    .replace(/^(arr_|ll_|tr_|gr_|dp_|sq_|cn_|rdbms_|oop_)/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function Dashboard({ studentId }: { studentId: string }) {
  const navigate = useNavigate();
  const state = useApiData(() => api.get<StudentState>(`/students/${studentId}/state`), [studentId]);
  const summary = useApiData(
    () => api.get<DailySummary>(`/students/${studentId}/daily-summary`).catch(() => null as unknown as DailySummary),
    [studentId],
  );

  if (state.loading) return <Loading label="Calibrating your learning dashboard…" />;
  if (state.error) return <ErrorBox message={state.error} onRetry={state.reload} />;

  if (!state.data?.goal) {
    return (
      <div className="max-w-2xl mx-auto py-12 text-center space-y-6">
        <div className="h-16 w-16 mx-auto rounded-3xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-2xl text-white">
          ✦
        </div>
        <div>
          <h1 className="text-3xl font-semibold text-zinc-100 tracking-tight">Welcome to Bloom</h1>
          <p className="mt-2 text-base text-zinc-400 max-w-md mx-auto">
            Your personalized AI study companion that adapts your curriculum, schedules deliberate practice, and provides citation-backed tutoring.
          </p>
        </div>
        <div className="pt-2">
          <Link
            to="/onboarding"
            className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black hover:bg-zinc-200 transition-all shadow-lg"
          >
            <span>Set Up Your Study Plan</span>
            <span>→</span>
          </Link>
        </div>
      </div>
    );
  }

  const { student, goal, plan, recent_mastery } = state.data;
  const daily = summary.data;
  const signals = daily?.signals;
  const weakest = [...recent_mastery].sort((a, b) => a.mu - b.mu).slice(0, 4);

  const deadline = new Date(`${goal.deadline}T23:59:59Z`);
  const simNow = new Date(student.sim_now);
  const daysLeft = Math.max(0, Math.ceil((deadline.getTime() - simNow.getTime()) / 86_400_000));
  const simToday = simNow.toDateString();

  const todayActivities = (plan?.upcoming_activities ?? []).filter(
    (a) => new Date(a.scheduled_start).toDateString() === simToday,
  );
  const nextActivity = todayActivities[0] ?? plan?.upcoming_activities[0];

  return (
    <div className="space-y-8">
      {/* Hero Welcome & Plan Status */}
      <section className="relative overflow-hidden rounded-3xl border border-zinc-900 bg-zinc-950 p-8 shadow-xl">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono uppercase tracking-widest text-zinc-500">Active Curriculum</span>
              {daily?.status && <StatusPill status={daily.status} />}
              {plan && (
                <span className="rounded-full border border-zinc-800 bg-zinc-900/60 px-2.5 py-0.5 text-[10px] font-mono text-zinc-400">
                  plan v{plan.current_version}
                </span>
              )}
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">{goal.title}</h1>
            <p className="text-sm text-zinc-400">
              Target completion in <span className="font-semibold text-zinc-200">{daysLeft} days</span> ({goal.deadline}) ·{" "}
              {typeof signals?.bufferDays === "number" ? `${signals.bufferDays.toFixed(1)} days buffer pacing` : "calibrated"}
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {nextActivity && (
              <button
                type="button"
                onClick={() => navigate("/plan")}
                className="flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-xs font-semibold text-black hover:bg-zinc-200 transition-colors shadow-sm"
              >
                <span>Start Next Session</span>
                <span>→</span>
              </button>
            )}
            <Link
              to="/tutor"
              className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-xs font-medium text-zinc-300 hover:border-zinc-700 hover:text-white transition-colors"
            >
              Ask AI Tutor
            </Link>
          </div>
        </div>
      </section>

      {/* Top Level Metric Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-5">
          <p className="text-xs text-zinc-500 font-mono uppercase tracking-wider">Timeline Window</p>
          <p className="mt-2 text-2xl font-semibold text-white tracking-tight">{daysLeft} <span className="text-xs text-zinc-500 font-normal">days left</span></p>
          <p className="mt-1 text-xs text-zinc-500">Deadline: {goal.deadline}</p>
        </div>

        <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-5">
          <p className="text-xs text-zinc-500 font-mono uppercase tracking-wider">Required / Available</p>
          <p className="mt-2 text-2xl font-semibold text-white tracking-tight">
            {signals ? `${signals.requiredHours.toFixed(0)}h` : "—"}{" "}
            <span className="text-xs text-zinc-500 font-normal">/ {signals ? `${signals.availableHours.toFixed(0)}h` : "—"}</span>
          </p>
          <p className="mt-1 text-xs text-zinc-500">Total estimated study effort</p>
        </div>

        <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-5">
          <p className="text-xs text-zinc-500 font-mono uppercase tracking-wider">Pacing Health</p>
          <p className="mt-2 text-2xl font-semibold text-white tracking-tight">
            {typeof signals?.bufferDays === "number" ? `${signals.bufferDays >= 0 ? "+" : ""}${signals.bufferDays.toFixed(1)}d` : "Optimal"}
          </p>
          <p className="mt-1 text-xs text-zinc-500">Margin ahead of schedule</p>
        </div>

        <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-5">
          <p className="text-xs text-zinc-500 font-mono uppercase tracking-wider">Active Plan Agenda</p>
          <p className="mt-2 text-2xl font-semibold text-white tracking-tight">
            {todayActivities.length} <span className="text-xs text-zinc-500 font-normal">due today</span>
          </p>
          <p className="mt-1 text-xs text-zinc-500">{(plan?.upcoming_activities ?? []).length} total planned</p>
        </div>
      </div>

      {/* Main 2-Column Command Center */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left 2 Columns: Today's Agenda & Pacing Signals */}
        <div className="lg:col-span-2 space-y-6">
          {/* Today's Agenda */}
          <Card className="p-6">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-900">
              <div>
                <h2 className="text-base font-semibold text-white">Today's Scheduled Activities</h2>
                <p className="text-xs text-zinc-500">Target sessions calibrated for your retention curve</p>
              </div>
              <Link to="/plan" className="text-xs text-zinc-400 hover:text-white font-mono transition-colors">
                View Full Calendar →
              </Link>
            </div>

            <div className="mt-4">
              {todayActivities.length === 0 ? (
                <div className="py-8 text-center space-y-3">
                  <p className="text-sm text-zinc-400">All planned activities for today have been completed!</p>
                  <p className="text-xs text-zinc-600">You can practice extra questions or review topics in the library.</p>
                  <div className="pt-2 flex justify-center gap-3">
                    <Link
                      to="/assessment"
                      className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-200 hover:border-zinc-700"
                    >
                      Take Quick Quiz
                    </Link>
                    <Link
                      to="/library"
                      className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-200 hover:border-zinc-700"
                    >
                      Browse Library
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {todayActivities.map((a) => {
                    const start = new Date(a.scheduled_start);
                    return (
                      <div
                        key={a.activity_id}
                        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-zinc-900 bg-black p-4 hover:border-zinc-800 transition-colors"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-zinc-100">{formatName(a.subtopic_id)}</span>
                            <span className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] font-mono text-zinc-400 uppercase">
                              {a.action}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-500">
                            {start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {a.duration_min} minutes
                            {a.predicted_score !== null && ` · ${Math.round(a.predicted_score * 100)}% expected accuracy`}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {a.action === "study" && (
                            <Link
                              to="/library"
                              className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 hover:text-white"
                            >
                              Open Material
                            </Link>
                          )}
                          <Link
                            to={`/tutor?q=${encodeURIComponent(`Explain key concepts of ${formatName(a.subtopic_id)}`)}`}
                            className="rounded-lg bg-white px-3.5 py-1.5 text-xs font-medium text-black hover:bg-zinc-200"
                          >
                            Study with AI →
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>

          {/* Progress & Trajectory Signals */}
          <Card className="p-6">
            <h2 className="text-base font-semibold text-white mb-1">Learning Signals & Trajectory</h2>
            <p className="text-xs text-zinc-500 mb-5">
              Probabilistic Bayesian beliefs measuring your true conceptual mastery vs mere attendance.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-zinc-400">Attendance (14d)</span>
                  <span className="text-zinc-200 font-mono">{signals ? `${Math.round((signals.attendance14d ?? 0) * 100)}%` : "—"}</span>
                </div>
                <Bar value={signals?.attendance14d ?? 0} />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-zinc-400">Mastery Trajectory</span>
                  <span className="text-zinc-200 font-mono">{signals ? `${Math.round((signals.trajectory ?? 0) * 100)}%` : "—"}</span>
                </div>
                <Bar value={signals?.trajectory ?? 0} />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-zinc-400">Pacing Arrival Margin</span>
                  <span className="text-zinc-200 font-mono">
                    {typeof signals?.bufferDays === "number" ? `${signals.bufferDays >= 0 ? "+" : ""}${signals.bufferDays.toFixed(1)}d` : "—"}
                  </span>
                </div>
                <Bar value={typeof signals?.bufferDays === "number" ? Math.max(0, Math.min(1, (signals.bufferDays + 5) / 10)) : 0} />
              </div>
            </div>
          </Card>
        </div>

        {/* Right 1 Column: Daily Summary & Focus Areas */}
        <div className="space-y-6">
          {/* Daily Coach Message */}
          {daily?.message && (
            <Card className="p-6 border-zinc-800/80 bg-zinc-950">
              <div className="flex items-center gap-2 mb-3">
                <span className="h-2 w-2 rounded-full bg-cyan-400" />
                <h3 className="text-xs uppercase tracking-widest text-zinc-400 font-mono">Pedagogical Insight</h3>
              </div>
              <p className="text-sm text-zinc-200 leading-relaxed">{daily.message}</p>
              {daily.motivation && (
                <p className="mt-3 text-xs text-zinc-500 border-t border-zinc-900 pt-3 leading-relaxed italic">
                  "{daily.motivation}"
                </p>
              )}
            </Card>
          )}

          {/* Top Focus / Revision Priorities */}
          <Card className="p-6">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-900 mb-4">
              <h3 className="text-sm font-semibold text-white">Priority Focus Areas</h3>
              <Link to="/progress" className="text-[11px] text-zinc-500 hover:text-zinc-300 font-mono">
                Full Tree →
              </Link>
            </div>

            {weakest.length === 0 ? (
              <p className="text-xs text-zinc-600">No mastery signals recorded yet. Take an assessment to initialize.</p>
            ) : (
              <div className="space-y-3">
                {weakest.map((w) => {
                  const masteryPct = Math.round(w.mu * 100);
                  return (
                    <div
                      key={w.subtopic_id}
                      className="rounded-xl border border-zinc-900 bg-black p-3 flex items-center justify-between gap-3"
                    >
                      <div>
                        <p className="text-xs font-semibold text-zinc-200">{formatName(w.subtopic_id)}</p>
                        <p className="text-[10px] text-zinc-500 font-mono mt-0.5">Mastery estimate: {masteryPct}%</p>
                      </div>
                      <Link
                        to={`/tutor?q=${encodeURIComponent(`Give me a practice problem on ${formatName(w.subtopic_id)}`)}`}
                        className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-300 hover:text-white shrink-0"
                      >
                        Review
                      </Link>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Quick Shortcuts */}
          <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-5 space-y-2">
            <p className="text-xs uppercase tracking-wider text-zinc-500 font-mono mb-2">Workspace Shortcuts</p>
            <Link
              to="/assessment"
              className="flex items-center justify-between rounded-xl px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors"
            >
              <span>Test Knowledge on Specific Subtopic</span>
              <span className="font-mono text-zinc-600">→</span>
            </Link>
            <Link
              to="/library"
              className="flex items-center justify-between rounded-xl px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors"
            >
              <span>Ingested Lecture & Textbook Repository</span>
              <span className="font-mono text-zinc-600">→</span>
            </Link>
            <Link
              to="/onboarding"
              className="flex items-center justify-between rounded-xl px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors"
            >
              <span>Reconfigure Curriculum & Constraints</span>
              <span className="font-mono text-zinc-600">→</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
