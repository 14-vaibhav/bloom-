import type { TutorTurn } from "../lib/types";

const MODE_NOTE: Record<string, string> = {
  explain: "Mastery is low (or prerequisite weak) → starts from fundamentals, prefers lecture and slides.",
  connect: "Mastery is mid-range → direct concise answer, linked to recent misses.",
  challenge: "Mastery is at target → concise answer accompanied by practice challenge.",
};

export function AnswerCheckPanel({
  turn,
}: {
  turn: Pick<TutorTurn, "mode" | "retrieval_mode" | "validation" | "repair_rounds" | "notices" | "outcome" | "latency_ms">;
}) {
  const v = turn.validation;
  return (
    <details className="mt-4 rounded-xl border border-zinc-900 bg-zinc-950 text-xs text-zinc-400 group">
      <summary className="cursor-pointer select-none px-4 py-3 text-zinc-300 font-medium hover:text-zinc-100 transition-colors list-none flex items-center justify-between">
        <span>Verification & Citations Inspection</span>
        <span className="text-zinc-600 group-open:rotate-180 transition-transform">▼</span>
      </summary>
      <div className="space-y-3 px-4 pb-4 pt-1 border-t border-zinc-900/60">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-zinc-500">Pedagogical Mode:</span>{" "}
            <span className="text-zinc-200 capitalize">{turn.mode ?? "—"}</span>
            {turn.mode && <p className="text-[11px] text-zinc-500 mt-0.5">{MODE_NOTE[turn.mode]}</p>}
          </div>
          <div>
            <span className="text-zinc-500">Retrieval Pipeline:</span>{" "}
            <span className="text-zinc-200">{turn.retrieval_mode ?? "—"}</span>
            {turn.retrieval_mode === "lexical" && <span className="text-zinc-500"> (lexical fallback)</span>}
          </div>
        </div>

        <div className="flex flex-wrap gap-4 text-xs text-zinc-400 pt-1">
          <span>
            <span className="text-zinc-500">Repair iterations:</span> {turn.repair_rounds}
          </span>
          <span>
            <span className="text-zinc-500">Validation outcome:</span>{" "}
            <span className="text-zinc-200 font-mono">{turn.outcome.replace(/_/g, " ")}</span>
          </span>
          {turn.latency_ms && (
            <span>
              <span className="text-zinc-500">Latency:</span> {turn.latency_ms} ms
            </span>
          )}
        </div>

        {v ? (
          <div className="space-y-1.5 pt-2">
            <p className="text-[11px] uppercase tracking-wider text-zinc-600 font-mono">Rule Checks</p>
            <ul className="space-y-1">
              {v.checks.map((c) => (
                <li key={c.id} className="flex items-center gap-2 rounded-lg bg-black px-2.5 py-1.5 border border-zinc-900">
                  <span className={c.passed ? "text-emerald-400" : c.severity === "hard" ? "text-rose-400" : "text-amber-400"}>
                    {c.passed ? "✓" : c.severity === "hard" ? "✗" : "!"}
                  </span>
                  <span className="w-8 shrink-0 font-mono text-[11px] text-zinc-300">{c.id}</span>
                  <span className="text-zinc-300 text-xs flex-1">{c.detail}</span>
                  <span className="shrink-0 text-[10px] uppercase font-mono text-zinc-600">{c.severity}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-zinc-500 text-xs">No citations verified — empty response or direct refuse.</p>
        )}

        {turn.notices.map((n) => (
          <p key={n} className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-1.5 text-xs text-amber-300/80">
            {n}
          </p>
        ))}
      </div>
    </details>
  );
}
