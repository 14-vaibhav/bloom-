import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import type { MasteryTree } from "../lib/types";
import { BadgeDot, Card, ErrorBox, Loading } from "../components/ui";

function ConfidenceBand({ mu, confidence }: { mu: number; confidence: number }) {
  const half = (1 - confidence) * 0.25;
  const lo = Math.max(0, mu - half) * 100;
  const hi = Math.min(1, mu + half) * 100;
  return (
    <div className="relative h-2 w-full rounded-full bg-zinc-900 overflow-hidden">
      <div
        className="absolute h-full rounded-full bg-zinc-800/80"
        style={{ left: `${lo}%`, width: `${Math.max(4, hi - lo)}%` }}
        title={`Uncertainty interval: ${Math.round(lo)}% - ${Math.round(hi)}%`}
      />
      <div
        className="absolute h-full w-1 bg-white rounded-full shadow-[0_0_8px_rgba(255,255,255,0.6)]"
        style={{ left: `${mu * 100}%` }}
        title={`Estimated mastery point: ${Math.round(mu * 100)}%`}
      />
    </div>
  );
}

export function TopicProgress({ studentId }: { studentId: string }) {
  const { data, loading, error, reload } = useApiData(() => api.get<MasteryTree>(`/students/${studentId}/mastery-tree`), [studentId]);
  const [filterQuery, setFilterQuery] = useState("");

  if (loading) return <Loading label="Calculating probabilistic mastery tree…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return <Card><p className="text-sm text-zinc-500">No active curriculum goal recorded.</p></Card>;

  const allSubtopics = data.topics.flatMap((t) => t.subtopics);
  const masteredCount = allSubtopics.filter((s) => s.badge === "green").length;
  const inProgressCount = allSubtopics.filter((s) => s.badge === "amber").length;
  const needsEvalCount = allSubtopics.filter((s) => s.badge === "grey").length;

  return (
    <div className="space-y-8">
      {/* Header Banner */}
      <section className="rounded-3xl border border-zinc-900 bg-zinc-950 p-8 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-widest text-zinc-500 font-mono">Curriculum Mastery</div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Knowledge Tree</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Probabilistic belief estimates and Bayesian confidence bands across every subtopic.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Search concepts…"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className="rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none w-48"
            />
          </div>
        </div>
      </section>

      {/* Overview Stat Counters */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-5">
          <p className="text-xs text-zinc-500 font-mono uppercase tracking-wider">Total Concepts</p>
          <p className="mt-2 text-2xl font-semibold text-white tracking-tight">{allSubtopics.length}</p>
          <p className="mt-1 text-xs text-zinc-500">{data.topics.length} domain modules</p>
        </div>

        <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-5">
          <p className="text-xs text-zinc-500 font-mono uppercase tracking-wider">Mastered (Green)</p>
          <p className="mt-2 text-2xl font-semibold text-emerald-400 tracking-tight">{masteredCount}</p>
          <p className="mt-1 text-xs text-zinc-500">Above retention threshold</p>
        </div>

        <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-5">
          <p className="text-xs text-zinc-500 font-mono uppercase tracking-wider">In Progress (Amber)</p>
          <p className="mt-2 text-2xl font-semibold text-amber-400 tracking-tight">{inProgressCount}</p>
          <p className="mt-1 text-xs text-zinc-500">Scheduled for revision</p>
        </div>

        <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-5">
          <p className="text-xs text-zinc-500 font-mono uppercase tracking-wider">Needs Evaluation</p>
          <p className="mt-2 text-2xl font-semibold text-zinc-400 tracking-tight">{needsEvalCount}</p>
          <p className="mt-1 text-xs text-zinc-500">High uncertainty interval</p>
        </div>
      </div>

      {/* Modules List */}
      <div className="space-y-6">
        {data.topics.map((topic) => {
          const visible = topic.subtopics.filter(
            (s) => !filterQuery || s.name.toLowerCase().includes(filterQuery.toLowerCase()),
          );
          if (filterQuery && visible.length === 0) return null;

          const topicAvg = Math.round(
            (topic.subtopics.reduce((sum, s) => sum + s.mu, 0) / (topic.subtopics.length || 1)) * 100,
          );

          return (
            <Card key={topic.id} className="p-6">
              <div className="flex items-center justify-between pb-4 border-b border-zinc-900 mb-5">
                <div>
                  <h2 className="text-base font-semibold text-white">{topic.name}</h2>
                  <p className="text-xs text-zinc-500 font-mono mt-0.5">
                    {topic.subtopics.length} subtopics · {topicAvg}% module mastery
                  </p>
                </div>
                <span className="rounded-full border border-zinc-900 bg-zinc-950 px-3 py-1 text-xs font-mono text-zinc-400">
                  Target: {Math.round((topic.subtopics[0]?.target_mastery ?? 0.85) * 100)}%
                </span>
              </div>

              <div className="space-y-6">
                {visible.map((s) => (
                  <div key={s.id} className="space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <span className="flex items-center gap-2.5 text-sm font-medium text-zinc-200">
                        <BadgeDot level={s.badge} />
                        <span>{s.name}</span>
                      </span>

                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono text-zinc-400">
                          {Math.round(s.mu * 100)}%{" "}
                          <span className="text-zinc-600">/ {Math.round(s.target_mastery * 100)}% target</span>
                        </span>
                        <Link
                          to={`/tutor?q=${encodeURIComponent(`Explain ${s.name} and test my understanding`)}`}
                          className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-300 hover:text-white"
                        >
                          Review with AI
                        </Link>
                      </div>
                    </div>

                    <ConfidenceBand mu={s.mu} confidence={s.confidence} />

                    {s.badge !== "green" && s.badge_reasons.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-0.5">
                        {s.badge_reasons.map((r, i) => (
                          <span
                            key={i}
                            className="rounded-md border border-zinc-900 bg-black px-2 py-0.5 text-[10px] font-mono text-zinc-500"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
