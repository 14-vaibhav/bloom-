import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import { useAgentStream } from "../lib/useAgentStream";
import type { AgentEvent, AgentRun } from "../lib/types";
import { Card, ErrorBox, Loading } from "../components/ui";

const PHASE_ICONS: Record<string, string> = {
  observe: "\u{1F441}", update_beliefs: "\u{1F9E0}", triggers: "⚡", analyze: "\u{1F50D}",
  decide: "⚖️", retrieve: "\u{1F4DA}", plan: "\u{1F5D3}️", validate: "✅",
  repair: "\u{1F527}", commit: "\u{1F4BE}", act: "▶️",
};

function eventTone(e: AgentEvent): string {
  if (e.event_type === "validation" && e.message.toLowerCase().includes("fail")) return "border-l-rose-500";
  if (e.phase === "repair") return "border-l-amber-500";
  if (e.error_class) return "border-l-orange-500";
  if (e.event_type === "llm_call" && (e.payload as { fallback_used?: boolean } | null)?.fallback_used) return "border-l-sky-500";
  if (e.phase === "commit") return "border-l-emerald-500";
  return "border-l-slate-700";
}

function EventRow({ e }: { e: AgentEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`border-l-2 ${eventTone(e)} bg-slate-900/40 px-3 py-2 text-sm`}>
      <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <span>{PHASE_ICONS[e.phase] ?? "•"}</span>
        <span className="flex-1">
          <span className="mr-2 text-xs uppercase tracking-wide text-slate-500">{e.phase}</span>
          <span className="text-slate-200">{e.message}</span>
        </span>
        {e.latency_ms !== null && <span className="shrink-0 text-xs text-slate-500">{e.latency_ms}ms</span>}
      </button>
      {open && e.payload != null && (
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-950 p-2 text-xs text-slate-400">{JSON.stringify(e.payload, null, 2)}</pre>
      )}
    </div>
  );
}

function RunHeader({ run }: { run: AgentRun }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-t-xl border border-b-0 border-slate-800 bg-slate-900 px-4 py-3 text-sm">
      <span className="font-medium text-slate-100">{run.trigger}</span>
      <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{run.scope}</span>
      <span className={`rounded px-2 py-0.5 text-xs ${run.outcome === "no_action" ? "bg-slate-800 text-slate-400" : run.outcome === "error" ? "bg-rose-900/50 text-rose-300" : "bg-emerald-900/40 text-emerald-300"}`}>
        {run.outcome ?? run.status}
      </span>
      <span className="text-xs text-slate-500">{run.tool_call_count} tool calls</span>
      {run.llm_call_count > 0 && <span className="text-xs text-slate-500">{run.llm_call_count} LLM calls</span>}
      {run.degraded_tools.length > 0 && <span className="text-xs text-orange-400">degraded: {run.degraded_tools.join(", ")}</span>}
      {run.total_latency_ms !== null && <span className="text-xs text-slate-500">{(run.total_latency_ms / 1000).toFixed(2)}s</span>}
      <span className="ml-auto text-xs text-slate-600">{new Date(run.started_at).toLocaleString()}</span>
    </div>
  );
}

export function AgentActivity({ studentId }: { studentId: string }) {
  const { events: liveEvents } = useAgentStream(studentId);
  const [historyEvents, setHistoryEvents] = useState<AgentEvent[]>([]);
  const [replayEvents, setReplayEvents] = useState<{ runId: string; events: AgentEvent[] } | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);

  const { data: runs, loading: runsLoading, error: runsError, reload } = useApiData(
    () => api.get<AgentRun[]>(`/agent/runs?student_id=${studentId}`),
    [studentId],
  );

  useEffect(() => {
    api.get<AgentEvent[]>(`/students/${studentId}/events?limit=200`).then(setHistoryEvents).catch(() => {});
  }, [studentId]);

  const allEvents = useMemo(() => {
    const merged = new Map<number, AgentEvent>();
    for (const e of historyEvents) merged.set(e.id, e);
    for (const e of liveEvents) merged.set(e.id, e);
    return [...merged.values()].sort((a, b) => a.id - b.id);
  }, [historyEvents, liveEvents]);

  const eventsByRun = useMemo(() => {
    const map = new Map<string, AgentEvent[]>();
    for (const e of allEvents) map.set(e.run_id, [...(map.get(e.run_id) ?? []), e]);
    return map;
  }, [allEvents]);

  useEffect(() => {
    if (paused || !feedRef.current) return;
    feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [allEvents, paused]);

  async function runNow() {
    await api.post(`/agent/run`, { student_id: studentId });
    reload();
  }

  async function replay(runId: string) {
    const events = await api.get<AgentEvent[]>(`/students/${studentId}/events?run_id=${runId}`);
    setReplayEvents({ runId, events });
  }

  if (runsLoading) return <Loading label="Loading agent runs…" />;
  if (runsError) return <ErrorBox message={runsError} onRetry={reload} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Agent Activity</h1>
        <button onClick={runNow} className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500">
          Run agent now
        </button>
      </div>

      {replayEvents && (
        <Card className="border-sky-800">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-sky-300">Replaying run {replayEvents.runId.slice(0, 8)}</span>
            <button onClick={() => setReplayEvents(null)} className="text-xs text-slate-400 hover:text-slate-200">Close</button>
          </div>
          <div className="space-y-1">{replayEvents.events.map((e) => <EventRow key={e.id} e={e} />)}</div>
        </Card>
      )}

      <div
        ref={feedRef}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        className="max-h-[70vh] space-y-4 overflow-y-auto"
      >
        {!runs || runs.length === 0 ? (
          <Card><p className="text-sm text-slate-400">No agent runs yet. Click "Run agent now" to produce the first plan.</p></Card>
        ) : (
          runs.map((run) => (
            <div key={run.run_id}>
              <RunHeader run={run} />
              <div className="space-y-1 rounded-b-xl border border-t-0 border-slate-800 bg-slate-950/40 p-2">
                {(eventsByRun.get(run.run_id) ?? []).map((e) => <EventRow key={e.id} e={e} />)}
                <button onClick={() => replay(run.run_id)} className="mt-1 text-xs text-slate-500 hover:text-slate-300">
                  Replay this run →
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
