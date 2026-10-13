import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import type { MasteryTree } from "../lib/types";
import { BadgeDot, Card, ErrorBox, Loading } from "../components/ui";

function ConfidenceBand({ mu, confidence }: { mu: number; confidence: number }) {
  // Confidence widens the band around mu — low confidence means "could plausibly be
  // anywhere in this range," which a single bar can never communicate.
  const half = (1 - confidence) * 0.25;
  const lo = Math.max(0, mu - half) * 100;
  const hi = Math.min(1, mu + half) * 100;
  return (
    <div className="relative h-3 w-full rounded-full bg-slate-800">
      <div className="absolute h-full rounded-full bg-sky-900" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
      <div className="absolute h-full w-0.5 bg-sky-400" style={{ left: `${mu * 100}%` }} />
    </div>
  );
}

export function TopicProgress({ studentId }: { studentId: string }) {
  const { data, loading, error, reload } = useApiData(() => api.get<MasteryTree>(`/students/${studentId}/mastery-tree`), [studentId]);

  if (loading) return <Loading label="Loading topic progress…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return <Card><p className="text-sm text-slate-400">No goal yet.</p></Card>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-100">Topic Progress</h1>
      {data.topics.map((topic) => (
        <Card key={topic.id}>
          <p className="mb-3 text-sm font-medium text-slate-200">{topic.name}</p>
          <div className="space-y-3">
            {topic.subtopics.map((s) => (
              <div key={s.id}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 text-slate-200"><BadgeDot level={s.badge} />{s.name}</span>
                  <span className="text-xs text-slate-500">{Math.round(s.mu * 100)}% / target {Math.round(s.target_mastery * 100)}%</span>
                </div>
                <ConfidenceBand mu={s.mu} confidence={s.confidence} />
                {s.badge !== "green" && s.badge_reasons.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-xs text-slate-500">{s.badge_reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
