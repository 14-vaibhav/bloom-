import { useState } from "react";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import { KIND_LABEL } from "../lib/kb";
import type { KbOutline, KbReport, KbSource } from "../lib/types";
import { CitationChip } from "../components/CitationChip";
import { SourceViewer } from "../components/SourceViewer";
import { ErrorBox, Loading } from "../components/ui";

const MODALITY_LABEL: Record<string, string> = {
  transcript: "transcript",
  slide_vision: "slides (vision)",
  page_text: "page text",
  keyframe_vision: "keyframes",
};

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
      <div className="space-y-6">
        <section className="rounded-2xl border border-zinc-900 bg-zinc-950 px-8 py-8">
          <div className="text-xs uppercase tracking-widest text-zinc-600 mb-3">Library</div>
          <h1 className="text-3xl font-semibold text-zinc-100">Course Material</h1>
        </section>
        <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-6">
          <p className="text-sm text-zinc-400">
            No course material ingested yet. Add sources to{" "}
            <code className="rounded-lg border border-zinc-900 bg-black px-2 py-0.5 text-zinc-300">backend/kb-manifest.json</code>,
            then run the ingest scripts.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-zinc-900 bg-zinc-950 px-8 py-8">
        <div className="text-xs uppercase tracking-widest text-zinc-600 mb-3">Library</div>
        <h1 className="text-3xl font-semibold text-zinc-100">Course Material</h1>
        <p className="mt-2 text-base text-zinc-500">
          Everything the tutor can cite. Video indexed by transcript; slides read by a vision model; textbook anchored to exact pages.
        </p>
      </section>

      {/* Sources table */}
      <div className="rounded-2xl border border-zinc-900 bg-zinc-950 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-zinc-900">
                <th className="py-4 px-6 text-left text-xs font-normal text-zinc-600 uppercase tracking-widest">Source</th>
                <th className="py-4 px-6 text-left text-xs font-normal text-zinc-600 uppercase tracking-widest">Kind</th>
                <th className="py-4 px-6 text-left text-xs font-normal text-zinc-600 uppercase tracking-widest">Licence</th>
                <th className="py-4 px-6 text-left text-xs font-normal text-zinc-600 uppercase tracking-widest">Chunks</th>
                <th className="py-4 px-6 text-left text-xs font-normal text-zinc-600 uppercase tracking-widest">Tagged</th>
                <th className="py-4 px-6 text-left text-xs font-normal text-zinc-600 uppercase tracking-widest">Ingested</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(selected === r.id ? null : r.id)}
                  className="border-b border-zinc-900 last:border-0 hover:bg-zinc-900/40 cursor-pointer transition-colors"
                >
                  <td className="py-5 px-6">
                    <div className="font-medium text-zinc-100">{r.title}</div>
                    <div className="text-xs text-zinc-600 mt-0.5">{r.id}</div>
                  </td>
                  <td className="py-5 px-6 text-zinc-400">{KIND_LABEL[r.kind]}</td>
                  <td className="py-5 px-6 text-zinc-500">{r.license ?? "—"}</td>
                  <td className="py-5 px-6">
                    <div className="text-zinc-300">{r.chunks}</div>
                    <div className="text-xs text-zinc-600 mt-0.5">{Object.entries(r.by_modality).map(([m, n]) => `${n} ${MODALITY_LABEL[m] ?? m}`).join(" · ")}</div>
                  </td>
                  <td className="py-5 px-6 text-zinc-300">{r.tagged}<span className="text-zinc-700"> / {r.untagged} untagged</span></td>
                  <td className="py-5 px-6 text-zinc-500">{r.ingested_at ? new Date(r.ingested_at).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-6 py-3 text-xs text-zinc-700 border-t border-zinc-900">Click a source to see its outline.</p>
      </div>

      {selected && <Outline sourceId={selected} source={srcById.get(selected)} onOpen={setViewer} />}

      {/* Coverage table */}
      <div className="rounded-2xl border border-zinc-900 bg-zinc-950 overflow-hidden">
        <div className="px-6 pt-5 pb-4 border-b border-zinc-900">
          <p className="text-sm font-medium text-zinc-200">Coverage by subtopic</p>
        </div>
        {(report.data?.coverage ?? []).length === 0 ? (
          <p className="px-6 py-5 text-sm text-zinc-600">No chunks are tagged to a subtopic yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="border-b border-zinc-900">
                  <th className="py-3 px-6 text-left text-xs font-normal text-zinc-600 uppercase tracking-widest">Subtopic</th>
                  <th className="py-3 px-6 text-left text-xs font-normal text-zinc-600 uppercase tracking-widest">Lecture</th>
                  <th className="py-3 px-6 text-left text-xs font-normal text-zinc-600 uppercase tracking-widest">Slides</th>
                  <th className="py-3 px-6 text-left text-xs font-normal text-zinc-600 uppercase tracking-widest">Textbook</th>
                  <th className="py-3 px-6" />
                </tr>
              </thead>
              <tbody>
                {report.data!.coverage.map((c) => (
                  <tr key={c.subtopic_id} className="border-b border-zinc-900 last:border-0">
                    <td className="py-3 px-6 text-zinc-100">{c.name}</td>
                    {[c.video, c.slides, c.textbook].map((n, i) => (
                      <td key={i} className={`py-3 px-6 ${n === 0 ? "text-zinc-700" : "text-zinc-300"}`}>{n}</td>
                    ))}
                    <td className="py-3 px-6">
                      {c.single_source && <span className="rounded-full border border-amber-900 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-400">single-source gap</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
    <div className="rounded-2xl border border-zinc-900 bg-zinc-950 overflow-hidden">
      <div className="px-6 pt-5 pb-4 border-b border-zinc-900">
        <p className="text-sm font-medium text-zinc-200">{data.source.title} — outline ({data.units.length} units)</p>
        {source?.license && <p className="text-xs text-zinc-600 mt-1">Licence: {source.license}</p>}
      </div>
      <div className="max-h-80 overflow-y-auto divide-y divide-zinc-900">
        {data.units.map((u) => {
          const loc = u.locator;
          const where = data.source.kind === "video"
            ? `${Math.floor(Number(loc.t_start) / 60)}:${String(Math.floor(Number(loc.t_start) % 60)).padStart(2, "0")}`
            : data.source.kind === "slides" ? `slide ${loc.slide}` : `p. ${loc.page}`;
          return (
            <div key={u.chunk_ids[0]} className="flex items-center gap-3 px-6 py-3 text-sm">
              <CitationChip chunk={{ chunk_id: u.chunk_ids[0], kind: data.source.kind, label: where }} onOpen={onOpen} />
              <span className="truncate text-zinc-500">{u.heading ?? ""}</span>
              {u.subtopic_ids.length > 0 && <span className="ml-auto shrink-0 text-xs text-zinc-700">{u.subtopic_ids.join(", ")}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
