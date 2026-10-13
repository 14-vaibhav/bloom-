import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "./types";

/**
 * Live SSE feed for one student's agent_events (bloom-phase8-brief §A3/§A5
 * Agent Activity screen). The browser's native EventSource already handles
 * Last-Event-ID replay on reconnect for us (it resends the last `id:` field
 * it saw), so a hard refresh or a dropped connection resumes without a gap
 * and without re-fetching history.
 */
export function useAgentStream(studentId: string | null) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seenIds = useRef(new Set<number>());

  useEffect(() => {
    if (!studentId) return;
    setEvents([]);
    seenIds.current = new Set();
    const source = new EventSource(`/api/students/${studentId}/stream`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("agent_event", (e) => {
      const row = JSON.parse((e as MessageEvent).data) as AgentEvent;
      if (seenIds.current.has(row.id)) return;
      seenIds.current.add(row.id);
      setEvents((prev) => [...prev, row]);
    });
    return () => source.close();
  }, [studentId]);

  return { events, connected };
}
