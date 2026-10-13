import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import { Card, ErrorBox, Loading } from "../components/ui";
import type { KbEval } from "../lib/types";

type EvalReport = {
  seed: number; llm_enabled: boolean; chaos_rate: number; student_count: number; days: number;
  metrics: Record<string, number | string>;
  calibration: Array<{ decile: number; predicted_mean: number; actual_mean: number; count: number }>;
  per_profile?: Record<string, Record<string, number>>;
};

const KB_ROWS: Array<[string, string]> = [
  ["retrieval_hit_at_5", "Retrieval hit@5"], ["first_pass_citation_validity", "First-pass citation validity (K1–K4)"],
  ["shown_answer_validity", "Shown-answer validity"], ["cross_source_rate", "Cross-source rate"],
  ["diagram_questions_answered", "Diagram questions answered"], ["correct_refusals", "Correct refusals"], ["faithfulness_hand_graded", "Faithfulness (hand-graded)"],
];

function KbEvalCard() {
  const { data, loading, error } = useApiData(() => api.get<KbEval>("/eval/kb"), []);
  if (loading) return <Loading label="Loading knowledge-base evaluation…" />;
  if (error) return <Card><p className="text-sm font-medium text-slate-200">Knowledge-base evaluation</p><p className="mt-1 text-sm text-slate-400">{error}</p></Card>;
  if (!data) return null;
  const lat = data.metrics.latency_ms as { p50: number | null; p95: number | null };
  return (
    <Card>
      <p className="text-sm font-medium text-slate-200">Knowledge-base evaluation</p>
      <p className="mb-2 text-xs text-slate-500">{data.gold_count} hand-written questions · measured {new Date(data.at).toLocaleString()} · tutor LLM {data.llm_enabled ? "on" : "off"}</p>
      <table className="w-full text-sm"><tbody>
        {KB_ROWS.map(([key, label]) => {
          const m = data.metrics[key] as { n: number; of: number; rate: number } | null;
          return <tr key={key} className="border-b border-slate-800 last:border-0"><td className="py-1 pr-4 text-slate-400">{label}</td><td className="py-1 text-slate-100">{m ? `${Math.round(m.rate * 100)}% (${m.n}/${m.of})` : "n/a"}</td></tr>;
        })}
        <tr><td className="py-1 pr-4 text-slate-400">Latency p50 / p95</td><td className="py-1 text-slate-100">{lat?.p50 ?? "n/a"} / {lat?.p95 ?? "n/a"} ms</td></tr>
      </tbody></table>
      <p className="mt-2 text-[11px] text-slate-500">Citation validity proves a quote exists in the cited passage, not that the paraphrase is faithful — faithfulness is graded by hand.</p>
    </Card>
  );
}

export function Eval() {
  const { data, loading, error } = useApiData(() => api.get<EvalReport>("/eval/latest"), []);

  if (loading) return <Loading label="Loading eval report…" />;
  if (error) return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-100">Evaluation</h1>
      <KbEvalCard />
      <ErrorBox message={`Learner simulation: ${error} — run "npm run eval" from the backend to generate one.`} />
    </div>
  );
  if (!data) return null;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-100">Evaluation</h1>
      <KbEvalCard />
      <p className="text-sm text-slate-400">{data.student_count} simulated students · {data.days} days · seed {data.seed} · LLM {data.llm_enabled ? "on" : "off"} · chaos rate {data.chaos_rate}</p>

      <Card>
        <p className="mb-2 text-sm font-medium text-slate-200">Metrics</p>
        <table className="w-full text-sm">
          <tbody>
            {Object.entries(data.metrics).map(([k, v]) => (
              <tr key={k} className="border-b border-slate-800 last:border-0">
                <td className="py-1 pr-4 text-slate-400">{k}</td>
                <td className="py-1 text-slate-100">{typeof v === "number" ? v.toFixed(3) : v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <p className="mb-2 text-sm font-medium text-slate-200">Calibration curve (predicted vs actual, by decile)</p>
        <div className="space-y-1">
          {data.calibration.map((bin) => (
            <div key={bin.decile} className="flex items-center gap-2 text-xs">
              <span className="w-10 text-slate-500">{bin.decile}</span>
              <div className="relative h-3 flex-1 rounded bg-slate-800">
                <div className="absolute h-full w-0.5 bg-slate-500" style={{ left: `${bin.predicted_mean * 100}%` }} title="predicted" />
                <div className="absolute h-full w-0.5 bg-sky-400" style={{ left: `${bin.actual_mean * 100}%` }} title="actual" />
              </div>
              <span className="w-16 text-slate-500">n={bin.count}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">Grey mark: predicted. Blue mark: actual. Perfect calibration puts them on top of each other in every row.</p>
      </Card>

      {data.per_profile && (
        <Card>
          <p className="mb-2 text-sm font-medium text-slate-200">By profile</p>
          <pre className="max-h-64 overflow-auto rounded bg-slate-950 p-2 text-xs text-slate-400">{JSON.stringify(data.per_profile, null, 2)}</pre>
        </Card>
      )}
    </div>
  );
}
