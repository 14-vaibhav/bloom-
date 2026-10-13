import { useState } from "react";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import type { StudentState } from "../lib/types";

const TOOLS = ["performance", "rag", "calendar", "qbank", "state", "kb", "llm"];

export function DemoPanel({ studentId, onReset }: { studentId: string; onReset: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { data: state, reload } = useApiData(() => api.get<StudentState>(`/students/${studentId}/state`), [studentId]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try { await fn(); reload(); } finally { setBusy(null); }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="fixed bottom-4 right-4 z-30 rounded-full bg-slate-800 px-4 py-2 text-sm text-slate-200 shadow-lg hover:bg-slate-700">
        Demo panel
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-30 w-72 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium text-slate-100">Demo panel</p>
        <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-300">✕</button>
      </div>
      <p className="mb-3 text-xs text-slate-500">sim_now: {state?.student.sim_now ? new Date(state.student.sim_now).toLocaleString() : "—"}</p>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <button disabled={!!busy} onClick={() => run("advance1", () => api.post("/sim/advance", { student_id: studentId, hours: 24 }))} className="rounded-md bg-slate-800 px-2 py-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40">Advance 1 day</button>
        <button disabled={!!busy} onClick={() => run("advance3", () => api.post("/sim/advance", { student_id: studentId, hours: 72 }))} className="rounded-md bg-slate-800 px-2 py-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40">Advance 3 days</button>
        <button disabled={!!busy} onClick={() => run("run", () => api.post("/agent/run", { student_id: studentId }))} className="col-span-2 rounded-md bg-sky-700 px-2 py-1.5 text-white hover:bg-sky-600 disabled:opacity-40">Run agent</button>
        <button
          disabled={!!busy || !state?.plan?.upcoming_activities.length}
          onClick={() => run("complete", () => api.post(`/activities/${state!.plan!.upcoming_activities[0].activity_id}/complete`, { actual_duration_min: state!.plan!.upcoming_activities[0].duration_min }))}
          className="rounded-md bg-emerald-800 px-2 py-1.5 text-emerald-100 hover:bg-emerald-700 disabled:opacity-40"
        >
          Complete next
        </button>
        <button
          disabled={!!busy || !state?.plan?.upcoming_activities.length}
          onClick={() => run("miss", () => api.post(`/activities/${state!.plan!.upcoming_activities[0].activity_id}/missed`, {}))}
          className="rounded-md bg-rose-900/60 px-2 py-1.5 text-rose-200 hover:bg-rose-800 disabled:opacity-40"
        >
          Miss next
        </button>
        <button disabled={!!busy} onClick={() => run("break", () => api.post("/sim/break-tool", { tool: "rag", duration_sec: 30 }))} className="col-span-2 rounded-md bg-orange-800 px-2 py-1.5 text-orange-100 hover:bg-orange-700 disabled:opacity-40">Break RAG (30s)</button>
        <button disabled={!!busy} onClick={() => run("break-kb", () => api.post("/sim/break-tool", { tool: "kb", duration_sec: 60 }))} className="rounded-md bg-orange-800 px-2 py-1.5 text-orange-100 hover:bg-orange-700 disabled:opacity-40" title="Opens the knowledge-base breaker for 60s: the tutor must refuse to answer uncited">Break KB</button>
        <button disabled={!!busy} onClick={() => run("restore-kb", () => api.post("/sim/restore-tool", { tool: "kb" }))} className="rounded-md bg-slate-800 px-2 py-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40">Restore KB</button>
        <button disabled={!!busy} onClick={() => run("break-citation", () => api.post("/sim/break-citation", { armed: true }))} className="col-span-2 rounded-md bg-orange-800 px-2 py-1.5 text-orange-100 hover:bg-orange-700 disabled:opacity-40" title="The tutor's next answer gets an invented source; watch the validator reject it">Break citation (next tutor answer)</button>
        <button disabled={!!busy} onClick={() => run("restore", () => api.post("/sim/restore-tool", { tool: "rag" }))} className="col-span-2 rounded-md bg-slate-800 px-2 py-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40">Restore RAG</button>
        <button disabled={!!busy} onClick={() => run("availability", () => api.post(`/students/${studentId}/availability`, { weekly_availability: { "1": [{ start: "18:00", end: "19:00" }] }, max_daily_min: 60 }))} className="col-span-2 rounded-md bg-slate-800 px-2 py-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40">Set availability 1h/day</button>
        <button
          disabled={!!busy}
          onClick={() => run("reset", async () => { await api.post("/sim/reset", { student_id: studentId }); onReset(); })}
          className="col-span-2 rounded-md bg-rose-900/60 px-2 py-1.5 text-rose-200 hover:bg-rose-800 disabled:opacity-40"
        >
          Reset to seed
        </button>
      </div>
      {busy && <p className="mt-2 text-[11px] text-slate-500">Running {busy}…</p>}
      <div className="mt-2 flex flex-wrap gap-1">
        {TOOLS.map((t) => <span key={t} className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">{t}</span>)}
      </div>
    </div>
  );
}
