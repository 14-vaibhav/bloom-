import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-800 bg-slate-900/60 p-4 ${className}`}>{children}</div>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-slate-400">
      <span className="h-2 w-2 animate-pulse rounded-full bg-slate-500" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-rose-900 bg-rose-950/40 p-4 text-sm text-rose-200">
      <p>{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-2 rounded-md border border-rose-700 px-3 py-1 text-xs hover:bg-rose-900/40">
          Retry
        </button>
      )}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  ON_TRACK: "bg-emerald-500/20 text-emerald-300 border-emerald-700",
  AT_RISK: "bg-amber-500/20 text-amber-300 border-amber-700",
  BEHIND: "bg-rose-500/20 text-rose-300 border-rose-700",
  INFEASIBLE: "bg-rose-700/30 text-rose-200 border-rose-600",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${STATUS_COLORS[status] ?? "border-slate-700 bg-slate-800 text-slate-300"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

const BADGE_COLORS: Record<string, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  grey: "bg-slate-600",
};

export function BadgeDot({ level }: { level: string }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${BADGE_COLORS[level] ?? "bg-slate-600"}`} />;
}

const ACTION_COLORS: Record<string, string> = {
  LEARN: "bg-sky-500/20 text-sky-300 border-sky-800",
  PRACTICE: "bg-violet-500/20 text-violet-300 border-violet-800",
  IMMEDIATE_TEST: "bg-amber-500/20 text-amber-300 border-amber-800",
  ACTIVE_RECALL: "bg-teal-500/20 text-teal-300 border-teal-800",
  REVISION: "bg-orange-500/20 text-orange-300 border-orange-800",
  FINAL_TEST: "bg-rose-500/20 text-rose-300 border-rose-800",
};

export function ActionPill({ action }: { action: string }) {
  return <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${ACTION_COLORS[action] ?? "border-slate-700 text-slate-300"}`}>{action.replace("_", " ")}</span>;
}

export function Bar({ value, className = "" }: { value: number; className?: string }) {
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full bg-slate-800 ${className}`}>
      <div className="h-full rounded-full bg-sky-500" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  );
}
