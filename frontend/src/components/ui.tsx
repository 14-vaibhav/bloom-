import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-zinc-900 bg-zinc-950 p-5 ${className}`}>
      {children}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-10 text-zinc-500">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-600" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
      <p className="text-sm text-zinc-300">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 rounded-lg border border-zinc-800 px-4 py-1.5 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  ON_TRACK: "border-emerald-800 bg-emerald-500/10 text-emerald-400",
  AT_RISK: "border-amber-800 bg-amber-500/10 text-amber-400",
  BEHIND: "border-rose-800 bg-rose-500/10 text-rose-400",
  INFEASIBLE: "border-rose-700 bg-rose-700/20 text-rose-300",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${STATUS_COLORS[status] ?? "border-zinc-800 bg-zinc-900 text-zinc-400"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

const BADGE_COLORS: Record<string, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  grey: "bg-zinc-600",
};

export function BadgeDot({ level }: { level: string }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${BADGE_COLORS[level] ?? "bg-zinc-600"}`} />;
}

const ACTION_COLORS: Record<string, string> = {
  LEARN: "border-sky-900 bg-sky-500/10 text-sky-400",
  PRACTICE: "border-violet-900 bg-violet-500/10 text-violet-400",
  IMMEDIATE_TEST: "border-amber-900 bg-amber-500/10 text-amber-400",
  ACTIVE_RECALL: "border-teal-900 bg-teal-500/10 text-teal-400",
  REVISION: "border-orange-900 bg-orange-500/10 text-orange-400",
  FINAL_TEST: "border-rose-900 bg-rose-500/10 text-rose-400",
};

export function ActionPill({ action }: { action: string }) {
  return (
    <span className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${ACTION_COLORS[action] ?? "border-zinc-800 text-zinc-400"}`}>
      {action.replace("_", " ")}
    </span>
  );
}

export function Bar({ value, className = "" }: { value: number; className?: string }) {
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-zinc-900 ${className}`}>
      <div
        className="h-full rounded-full bg-zinc-400 transition-all"
        style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }}
      />
    </div>
  );
}
