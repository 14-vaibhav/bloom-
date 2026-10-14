import { useState } from "react";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import type { StudentState } from "../lib/types";

const TOOLS = ["performance", "rag", "calendar", "qbank", "state", "kb", "llm"];

export function DemoPanel({
  studentId,
  onReset,
  onClose,
}: {
  studentId: string;
  onReset: () => void;
  onClose?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const { data: state, reload } = useApiData(() => api.get<StudentState>(`/students/${studentId}/state`), [studentId]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try {
      await fn();
      reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {/* Background Dim Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Slide-over Drawer */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-sm border-l border-zinc-900 bg-zinc-950 p-6 shadow-2xl overflow-y-auto">
        <div className="mb-4 flex items-center justify-between pb-4 border-b border-zinc-900">
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <p className="text-sm font-semibold tracking-wide text-zinc-100">Learner Simulation Lab</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200 transition-colors"
          >
            ✕
          </button>
        </div>

        <p className="text-xs text-zinc-400 mb-2">
          Control the simulated environment clock, test resilient agent scheduling, or inject circuit-breaker faults.
        </p>

        <div className="rounded-xl border border-zinc-900 bg-black p-3 mb-5 font-mono text-xs text-zinc-400 flex items-center justify-between">
          <span className="text-zinc-500">sim_clock:</span>
          <span className="text-zinc-200 font-medium">
            {state?.student.sim_now ? new Date(state.student.sim_now).toLocaleString() : "—"}
          </span>
        </div>

        <div className="space-y-4">
          <div>
            <p className="text-[11px] font-mono uppercase tracking-wider text-zinc-500 mb-2">Time Controls</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                disabled={!!busy}
                onClick={() => run("advance1", () => api.post("/sim/advance", { student_id: studentId, hours: 24 }))}
                className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:border-zinc-700 hover:text-white disabled:opacity-40 transition-colors"
              >
                +24 Hours (1 Day)
              </button>
              <button
                disabled={!!busy}
                onClick={() => run("advance3", () => api.post("/sim/advance", { student_id: studentId, hours: 72 }))}
                className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:border-zinc-700 hover:text-white disabled:opacity-40 transition-colors"
              >
                +72 Hours (3 Days)
              </button>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-mono uppercase tracking-wider text-zinc-500 mb-2">Pacing & Agent Engine</p>
            <div className="space-y-2">
              <button
                disabled={!!busy}
                onClick={() => run("run", () => api.post("/agent/run", { student_id: studentId }))}
                className="w-full rounded-xl bg-white px-3 py-2.5 text-xs font-semibold text-black hover:bg-zinc-200 disabled:opacity-40 transition-colors shadow-sm"
              >
                Trigger Planner & Solver Sweep
              </button>

              <div className="grid grid-cols-2 gap-2">
                <button
                  disabled={!!busy || !state?.plan?.upcoming_activities.length}
                  onClick={() =>
                    run("complete", () =>
                      api.post(`/activities/${state!.plan!.upcoming_activities[0].activity_id}/complete`, {
                        actual_duration_min: state!.plan!.upcoming_activities[0].duration_min,
                      }),
                    )
                  }
                  className="rounded-xl border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-40 transition-colors"
                >
                  Complete Next
                </button>
                <button
                  disabled={!!busy || !state?.plan?.upcoming_activities.length}
                  onClick={() =>
                    run("miss", () =>
                      api.post(`/activities/${state!.plan!.upcoming_activities[0].activity_id}/missed`, {}),
                    )
                  }
                  className="rounded-xl border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300 hover:bg-rose-900/50 disabled:opacity-40 transition-colors"
                >
                  Simulate Miss
                </button>
              </div>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-mono uppercase tracking-wider text-zinc-500 mb-2">Chaos & Verification Tests</p>
            <div className="space-y-2 text-xs">
              <button
                disabled={!!busy}
                onClick={() => run("break", () => api.post("/sim/break-tool", { tool: "rag", duration_sec: 30 }))}
                className="w-full rounded-xl border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-left text-amber-300 hover:bg-amber-950/40 disabled:opacity-40 transition-colors"
              >
                <span className="font-medium block">Break RAG Service (30s)</span>
                <span className="text-[10px] text-zinc-500">Forces fallback lexical retrieval</span>
              </button>

              <button
                disabled={!!busy}
                onClick={() => run("break-citation", () => api.post("/sim/break-citation", { armed: true }))}
                className="w-full rounded-xl border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-left text-amber-300 hover:bg-amber-950/40 disabled:opacity-40 transition-colors"
              >
                <span className="font-medium block">Inject Broken Citation</span>
                <span className="text-[10px] text-zinc-500">Tests tutor hallucination-rejection filter</span>
              </button>

              <button
                disabled={!!busy}
                onClick={() => run("restore", () => api.post("/sim/restore-tool", { tool: "rag" }))}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-center text-zinc-300 hover:border-zinc-700 hover:text-white disabled:opacity-40 transition-colors"
              >
                Restore All Services
              </button>
            </div>
          </div>

          <div className="pt-2 border-t border-zinc-900">
            <button
              disabled={!!busy}
              onClick={() =>
                run("reset", async () => {
                  await api.post("/sim/reset", { student_id: studentId });
                  onReset();
                })
              }
              className="w-full rounded-xl border border-rose-900/50 bg-rose-950/20 py-2.5 text-xs font-semibold text-rose-300 hover:bg-rose-950/40 disabled:opacity-40 transition-colors"
            >
              Reset Simulation State to Baseline
            </button>
          </div>
        </div>

        {busy && <p className="mt-4 text-[11px] font-mono text-zinc-500 animate-pulse text-center">Executing: {busy}…</p>}

        <div className="mt-6 border-t border-zinc-900 pt-4">
          <p className="text-[10px] uppercase tracking-wider text-zinc-600 font-mono mb-2">Audited Agent Subsystems</p>
          <div className="flex flex-wrap gap-1">
            {TOOLS.map((t) => (
              <span key={t} className="rounded-md border border-zinc-900 bg-black px-2 py-0.5 text-[10px] font-mono text-zinc-500">
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
