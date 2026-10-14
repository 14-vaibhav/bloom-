import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import { Card, ErrorBox, Loading } from "../components/ui";
import type { KbEval } from "../lib/types";

type EvalReport = {
  seed: number;
  llm_enabled: boolean;
  chaos_rate: number;
  student_count: number;
  days: number;
  metrics: Record<string, number | string>;
  calibration: Array<{ decile: number; predicted_mean: number; actual_mean: number; count: number }>;
  per_profile?: Record<string, Record<string, number>>;
};

const KB_ROWS: Array<[string, string]> = [
  ["retrieval_hit_at_5", "Retrieval hit@5"],
  ["first_pass_citation_validity", "First-pass citation validity (K1–K4)"],
  ["shown_answer_validity", "Shown-answer validity"],
  ["cross_source_rate", "Cross-source rate"],
  ["diagram_questions_answered", "Diagram questions answered"],
  ["correct_refusals", "Correct refusals"],
  ["faithfulness_hand_graded", "Faithfulness (hand-graded)"],
];

function KbEvalCard() {
  const { data, loading, error, reload } = useApiData(() => api.get<KbEval>("/eval/kb"), []);
  if (loading) return <Loading label="Loading knowledge-base evaluation…" />;
  if (error) {
    return (
      <Card>
        <p className="text-base font-semibold text-zinc-200">Knowledge-Base Evaluation</p>
        <p className="mt-2 text-sm text-zinc-500">{error}</p>
        <button
          onClick={reload}
          className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-700"
        >
          Retry
        </button>
      </Card>
    );
  }
  if (!data) return null;
  const lat = data.metrics.latency_ms as { p50: number | null; p95: number | null };

  return (
    <Card>
      <div className="flex items-center justify-between pb-3 border-b border-zinc-900">
        <div>
          <p className="text-base font-semibold text-zinc-100">Knowledge-Base Evaluation</p>
          <p className="mt-1 text-xs text-zinc-500">
            {data.gold_count} hand-written questions · measured {new Date(data.at).toLocaleString()} · tutor LLM {data.llm_enabled ? "enabled" : "disabled"}
          </p>
        </div>
      </div>
      <table className="w-full text-sm mt-3">
        <tbody>
          {KB_ROWS.map(([key, label]) => {
            const m = data.metrics[key] as { n: number; of: number; rate: number } | null;
            return (
              <tr key={key} className="border-b border-zinc-900 last:border-0">
                <td className="py-2.5 pr-4 text-zinc-400">{label}</td>
                <td className="py-2.5 text-right font-medium text-zinc-100">
                  {m ? `${Math.round(m.rate * 100)}% (${m.n}/${m.of})` : "n/a"}
                </td>
              </tr>
            );
          })}
          <tr className="border-b border-zinc-900 last:border-0">
            <td className="py-2.5 pr-4 text-zinc-400">Latency p50 / p95</td>
            <td className="py-2.5 text-right font-medium text-zinc-100">
              {lat?.p50 ?? "n/a"} / {lat?.p95 ?? "n/a"} ms
            </td>
          </tr>
        </tbody>
      </table>
      <p className="mt-3 text-xs text-zinc-600">
        Citation validity verifies a quote exists verbatim in the cited source chunk. Faithfulness is independently hand-graded.
      </p>
    </Card>
  );
}

export function Eval() {
  const { data, loading, error, reload } = useApiData(() => api.get<EvalReport>("/eval/latest"), []);

  if (loading) return <Loading label="Loading evaluation report…" />;

  if (error) {
    return (
      <div className="space-y-6">
        <section className="rounded-2xl border border-zinc-900 bg-zinc-950 px-8 py-8">
          <div className="text-xs uppercase tracking-widest text-zinc-600 mb-3">System Evaluation</div>
          <h1 className="text-3xl font-semibold text-zinc-100">Model & Pipeline Evaluation</h1>
          <p className="mt-2 text-base text-zinc-500">
            Quantitative benchmarks measuring retrieval accuracy, citation validity, and simulation calibration.
          </p>
        </section>
        <KbEvalCard />
        <ErrorBox
          message={`Learner simulation: ${error} — run "npm run eval" from the backend to generate one.`}
          onRetry={reload}
        />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-zinc-900 bg-zinc-950 px-8 py-8">
        <div className="text-xs uppercase tracking-widest text-zinc-600 mb-3">System Evaluation</div>
        <h1 className="text-3xl font-semibold text-zinc-100">Model & Pipeline Evaluation</h1>
        <p className="mt-2 text-base text-zinc-500">
          {data.student_count} simulated learners · {data.days} days horizon · seed {data.seed} · LLM {data.llm_enabled ? "enabled" : "disabled"} · chaos rate {data.chaos_rate}
        </p>
      </section>

      <KbEvalCard />

      <Card>
        <p className="mb-3 text-base font-semibold text-zinc-100">Learner Simulation Metrics</p>
        <table className="w-full text-sm">
          <tbody>
            {Object.entries(data.metrics).map(([k, v]) => (
              <tr key={k} className="border-b border-zinc-900 last:border-0">
                <td className="py-2.5 pr-4 text-zinc-400 font-mono text-xs">{k}</td>
                <td className="py-2.5 text-right font-medium text-zinc-100">
                  {typeof v === "number" ? v.toFixed(3) : v}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <p className="mb-2 text-base font-semibold text-zinc-100">Calibration Curve (Predicted vs. Actual by Decile)</p>
        <p className="mb-4 text-xs text-zinc-500">
          Grey line represents predicted mastery decile; cyan line represents actual outcome. Perfect alignment indicates reliable probabilistic modeling.
        </p>
        <div className="space-y-2">
          {data.calibration.map((bin) => (
            <div key={bin.decile} className="flex items-center gap-3 text-xs">
              <span className="w-12 text-zinc-500 font-mono">D{bin.decile}</span>
              <div className="relative h-4 flex-1 rounded-lg bg-zinc-900 border border-zinc-900 overflow-hidden">
                <div
                  className="absolute h-full w-0.5 bg-zinc-400 z-10"
                  style={{ left: `${bin.predicted_mean * 100}%` }}
                  title={`Predicted: ${(bin.predicted_mean * 100).toFixed(1)}%`}
                />
                <div
                  className="absolute h-full w-1 bg-cyan-400 z-20 shadow-[0_0_8px_rgba(34,211,238,0.5)]"
                  style={{ left: `${bin.actual_mean * 100}%` }}
                  title={`Actual: ${(bin.actual_mean * 100).toFixed(1)}%`}
                />
              </div>
              <span className="w-20 text-right text-zinc-500 font-mono">n={bin.count}</span>
            </div>
          ))}
        </div>
      </Card>

      {data.per_profile && (
        <Card>
          <p className="mb-3 text-base font-semibold text-zinc-100">Performance by Learner Persona</p>
          <pre className="max-h-64 overflow-auto rounded-xl border border-zinc-900 bg-black p-4 text-xs text-zinc-400 font-mono">
            {JSON.stringify(data.per_profile, null, 2)}
          </pre>
        </Card>
      )}
    </div>
  );
}
