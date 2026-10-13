import type { TutorTurn } from "../lib/types";

const MODE_NOTE: Record<string, string> = {
  explain: "Mastery is low (or a prerequisite is weak) → starts from the basics, prefers lecture and slides.",
  connect: "Mastery is mid-range → direct answer, tied to what you last got wrong.",
  challenge: "Mastery is at target → short answer plus a practice question.",
};

export function AnswerCheckPanel({ turn }: { turn: Pick<TutorTurn, "mode" | "retrieval_mode" | "validation" | "repair_rounds" | "notices" | "outcome" | "latency_ms"> }) {
  const v = turn.validation;
  return (
    <details className="mt-3 rounded-lg border border-slate-800 bg-slate-950/50 text-xs text-slate-400">
      <summary className="cursor-pointer select-none px-3 py-2 text-slate-300">How this answer was checked</summary>
      <div className="space-y-2 px-3 pb-3">
        <p>
          <span className="text-slate-500">Mode:</span> {turn.mode ?? "—"}
          {turn.mode && <span className="text-slate-500"> — {MODE_NOTE[turn.mode]}</span>}
        </p>
        <p><span className="text-slate-500">Retrieval:</span> {turn.retrieval_mode ?? "—"}{turn.retrieval_mode === "lexical" ? " (embedding was unavailable)" : ""} · <span className="text-slate-500">Repair rounds:</span> {turn.repair_rounds} · <span className="text-slate-500">Outcome:</span> {turn.outcome.replace(/_/g, " ")}{turn.latency_ms ? ` · ${turn.latency_ms} ms` : ""}</p>
        {v ? (
          <ul className="space-y-0.5">
            {v.checks.map((c) => (
              <li key={c.id} className="flex gap-2">
                <span className={c.passed ? "text-emerald-400" : c.severity === "hard" ? "text-rose-400" : "text-amber-400"}>{c.passed ? "✓" : c.severity === "hard" ? "✗" : "!"}</span>
                <span className="w-6 shrink-0 text-slate-300">{c.id}</span>
                <span>{c.detail}</span>
                <span className="ml-auto shrink-0 text-slate-600">{c.severity}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No citation check ran — nothing was shown.</p>
        )}
        {turn.notices.map((n) => <p key={n} className="text-amber-300/80">{n}</p>)}
      </div>
    </details>
  );
}
