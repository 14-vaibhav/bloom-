import { useState } from "react";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import { KIND_LABEL } from "../lib/kb";
import type { KbOutline, KbReport, KbSource } from "../lib/types";
import { CitationChip } from "../components/CitationChip";
import { SourceViewer } from "../components/SourceViewer";
import { Card, ErrorBox, Loading } from "../components/ui";

const MODALITY_LABEL: Record<string, string> = { transcript: "transcript", slide_vision: "slides (vision)", page_text: "page text", keyframe_vision: "keyframes" };

export function Library() {
  const sources = useApiData(() => api.get<KbSource[]>("/kb/sources"), []);
  const report = useApiData(() => api.get<KbReport>("/kb/report"), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);

  if (sources.loading || report.loading) return <Loading label="Loading the library…" />;
  if (sources.error || report.error) return <ErrorBox message={sources.error ?? report.error ?? "Could not load the library."} onRetry={() => { sources.reload(); report.reload(); }} />;
  const rows = report.data?.sources ?? [];
  const srcById = new Map((sources.data ?? []).map((s) => [s.id, s]));

  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold text-slate-100">Library</h1>
        <Card><p className="text-sm text-slate-300">No course material has been ingested yet. Add sources to <code className="rounded bg-slate-800 px-1">backend/kb-manifest.json</code>, then run <code className="rounded bg-slate-800 px-1">npm run ingest:video</code>, <code className="rounded bg-slate-800 px-1">ingest:slides</code> and <code className="rounded bg-slate-800 px-1">ingest:textbook</code>.</p></Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Library</h1>
        <p className="text-sm text-slate-400">Everything the tutor can cite. Video is indexed by its transcript; slides are read by a vision model, including diagrams; the textbook is anchored to exact pages.</p>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-2 pr-3">Source</th><th className="pr-3">Kind</th><th className="pr-3">Licence</th><th className="pr-3">Chunks</th><th className="pr-3">Tagged</th><th className="pr-3">Ingested</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setSelected(selected === r.id ? null : r.id)} className="cursor-pointer border-b border-slate-800/60 last:border-0 hover:bg-slate-800/30">
                <td className="py-2 pr-3 text-slate-100">{r.title}<div className="text-[11px] text-slate-500">{r.id}</div></td>
                <td className="pr-3 text-slate-300">{KIND_LABEL[r.kind]}</td>
                <td className="pr-3 text-slate-400">{r.license ?? "—"}</td>
                <td className="pr-3 text-slate-300">{r.chunks}<div className="text-[11px] text-slate-500">{Object.entries(r.by_modality).map(([m, n]) => `${n} ${MODALITY_LABEL[m] ?? m}`).join(" · ")}</div></td>
                <td className="pr-3 text-slate-300">{r.tagged}<span className="text-slate-600"> / {r.untagged} untagged</span>{r.low_info > 0 && <div className="text-[11px] text-slate-500">{r.low_info} low-information (not retrieved)</div>}</td>
                <td className="pr-3 text-slate-400">{r.ingested_at ? new Date(r.ingested_at).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-slate-500">Click a source to see its outline.</p>
      </Card>

      {selected && <Outline sourceId={selected} source={srcById.get(selected)} onOpen={setViewer} />}

      <Card className="overflow-x-auto">
        <p className="mb-2 text-sm font-medium text-slate-200">Coverage by subtopic</p>
        {(report.data?.coverage ?? []).length === 0 ? (
          <p className="text-sm text-slate-400">No chunks are tagged to a subtopic yet.</p>
        ) : (
          <table className="w-full min-w-[480px] text-sm">
            <thead><tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wide text-slate-500"><th className="py-2 pr-3">Subtopic</th><th className="pr-3">Lecture</th><th className="pr-3">Slides</th><th className="pr-3">Textbook</th><th /></tr></thead>
            <tbody>
              {report.data!.coverage.map((c) => (
                <tr key={c.subtopic_id} className="border-b border-slate-800/60 last:border-0">
                  <td className="py-1.5 pr-3 text-slate-100">{c.name}</td>
                  {[c.video, c.slides, c.textbook].map((n, i) => <td key={i} className={`pr-3 ${n === 0 ? "text-slate-600" : "text-slate-300"}`}>{n}</td>)}
                  <td>{c.single_source && <span className="rounded border border-amber-800 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">single-source gap</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {viewer && <SourceViewer chunkId={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

function Outline({ sourceId, source, onOpen }: { sourceId: string; source?: KbSource; onOpen: (chunkId: string) => void }) {
  const { data, loading, error } = useApiData(() => api.get<KbOutline>(`/kb/sources/${encodeURIComponent(sourceId)}/outline`), [sourceId]);
  if (loading) return <Loading label="Loading outline…" />;
  if (error) return <ErrorBox message={error} />;
  if (!data) return null;
  return (
    <Card>
      <p className="mb-2 text-sm font-medium text-slate-200">{data.source.title} — outline ({data.units.length} units)</p>
      {source?.license && <p className="mb-2 text-[11px] text-slate-500">Licence: {source.license}</p>}
      <div className="max-h-72 space-y-1 overflow-y-auto">
        {data.units.map((u) => {
          const loc = u.locator;
          const where = data.source.kind === "video" ? `${Math.floor(Number(loc.t_start) / 60)}:${String(Math.floor(Number(loc.t_start) % 60)).padStart(2, "0")}` : data.source.kind === "slides" ? `slide ${loc.slide}` : `p. ${loc.page}`;
          return (
            <div key={u.chunk_ids[0]} className="flex items-center gap-2 text-sm">
              <CitationChip chunk={{ chunk_id: u.chunk_ids[0], kind: data.source.kind, label: where }} onOpen={onOpen} />
              <span className="truncate text-slate-400">{u.heading ?? ""}</span>
              {u.subtopic_ids.length > 0 && <span className="ml-auto shrink-0 text-[11px] text-slate-600">{u.subtopic_ids.join(", ")}</span>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
