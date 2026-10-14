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

const TONE_COLORS: Record<string, string> = {
  rose: "border-l-rose-700",
  amber: "border-l-amber-700",
  orange: "border-l-orange-700",
  sky: "border-l-sky-700",
  emerald: "border-l-emerald-700",
  default: "border-l-zinc-800",
};

function eventTone(e: AgentEvent): string {
  if (e.event_type === "validation" && e.message.toLowerCase().includes("fail")) return TONE_COLORS.rose;
  if (e.phase === "repair") return TONE_COLORS.amber;
  if (e.error_class) return TONE_COLORS.orange;
  if (e.event_type === "llm_call" && (e.payload as { fallback_used?: boolean } | null)?.fallback_used) return TONE_COLORS.sky;
  if (e.phase === "commit") return TONE_COLORS.emerald;
  return TONE_COLORS.default;
}

function EventRow({ e }: { e: AgentEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`border-l-2 ${eventTone(e)} bg-zinc-950 px-4 py-2.5 text-sm`}>
      <button className="flex w-full items-start gap-3 text-left" onClick={() => setOpen((o) => !o)}>
        <span className="mt-0.5 text-base">{PHASE_ICONS[e.phase] ?? "•"}</span>
        <span className="flex-1 min-w-0">
          <span className="mr-2 text-[10px] uppercase tracking-widest text-zinc-600">{e.phase}</span>
          <span className="text-zinc-300">{e.message}</span>
        </span>
        {e.latency_ms !== null && <span className="shrink-0 text-xs text-zinc-700">{e.latency_ms}ms</span>}
      </button>
      {open && e.payload != null && (
        <pre className="mt-3 max-h-64 overflow-auto rounded-xl border border-zinc-900 bg-black p-3 text-xs text-zinc-500">
          {JSON.stringify(e.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

function RunHeader({ run }: { run: AgentRun }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-t-2xl border border-b-0 border-zinc-900 bg-zinc-950 px-5 py-4 text-sm">
      <span className="font-medium text-zinc-100">{run.trigger}</span>
      <span className="rounded-lg border border-zinc-900 bg-black px-2.5 py-1 text-xs text-zinc-400">{run.scope}</span>
      <span className={`rounded-lg px-2.5 py-1 text-xs ${
        run.outcome === "no_action"
          ? "border border-zinc-900 text-zinc-500"
          : run.outcome === "error"
          ? "border border-rose-900 bg-rose-500/10 text-rose-400"
          : "border border-emerald-900 bg-emerald-500/10 text-emerald-400"
      }`}>
        {run.outcome ?? run.status}
      </span>
      <span className="text-xs text-zinc-600">{run.tool_call_count} tool calls</span>
      {run.llm_call_count > 0 && <span className="text-xs text-zinc-600">{run.llm_call_count} LLM calls</span>}
      {run.degraded_tools.length > 0 && <span className="text-xs text-orange-500">degraded: {run.degraded_tools.join(", ")}</span>}
      {run.total_latency_ms !== null && <span className="text-xs text-zinc-600">{(run.total_latency_ms / 1000).toFixed(2)}s</span>}
      <span className="ml-auto text-xs text-zinc-700">{new Date(run.started_at).toLocaleString()}</span>
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
    <div className="space-y-6">
      <section className="rounded-2xl border border-zinc-900 bg-zinc-950 px-8 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-widest text-zinc-600 mb-3">Agent Activity</div>
            <h1 className="text-3xl font-semibold text-zinc-100">Live Agent Feed</h1>
            <p className="mt-2 text-base text-zinc-500">Watch the agent's 11-phase cycle in real time.</p>
          </div>
          <button
            onClick={runNow}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-2.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800 transition-colors shrink-0"
          >
            Run agent now
          </button>
        </div>
      </section>

      {replayEvents && (
        <div className="rounded-2xl border border-zinc-800 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-900">
            <span className="text-sm font-medium text-zinc-300">Replaying run {replayEvents.runId.slice(0, 8)}</span>
            <button onClick={() => setReplayEvents(null)} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Close</button>
          </div>
          <div className="divide-y divide-zinc-900/60">{replayEvents.events.map((e) => <EventRow key={e.id} e={e} />)}</div>
        </div>
      )}

      <div
        ref={feedRef}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        className="max-h-[70vh] space-y-4 overflow-y-auto"
      >
        {!runs || runs.length === 0 ? (
          <Card><p className="text-sm text-zinc-500">No agent runs yet. Click "Run agent now" to produce the first plan.</p></Card>
        ) : (
          runs.map((run) => (
            <div key={run.run_id}>
              <RunHeader run={run} />
              <div className="divide-y divide-zinc-900/40 rounded-b-2xl border border-t-0 border-zinc-900 overflow-hidden">
                {(eventsByRun.get(run.run_id) ?? []).map((e) => <EventRow key={e.id} e={e} />)}
                <div className="px-5 py-2 bg-black">
                  <button onClick={() => replay(run.run_id)} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
                    Replay this run →
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
