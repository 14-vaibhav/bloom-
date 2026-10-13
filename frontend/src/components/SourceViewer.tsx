import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { KIND_LABEL, splitAtQuote, youtubeEmbed } from "../lib/kb";
import type { KbChunk } from "../lib/types";
import { ErrorBox, Loading } from "./ui";

/** Side panel that opens the exact place a citation points at: the video at its timestamp,
 * the slide image, or the textbook page text with the cited quote highlighted. */
export function SourceViewer({ chunkId, quote, onClose }: { chunkId: string; quote?: string; onClose: () => void }) {
  const [currentId, setCurrentId] = useState(chunkId);
  const [chunk, setChunk] = useState<KbChunk | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setCurrentId(chunkId), [chunkId]);
  useEffect(() => {
    let cancelled = false;
    setChunk(null);
    setError(null);
    api.get<KbChunk>(`/kb/chunks/${encodeURIComponent(currentId)}`)
      .then((c) => { if (!cancelled) setChunk(c); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load this source."); });
    return () => { cancelled = true; };
  }, [currentId]);

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-slate-700 bg-slate-900 shadow-2xl" aria-label="Source viewer">
      <div className="flex items-start justify-between gap-3 border-b border-slate-800 p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">{chunk ? KIND_LABEL[chunk.kind] : "Source"}</p>
          <p className="text-sm font-medium text-slate-100">{chunk?.label ?? "Loading…"}</p>
        </div>
        <button onClick={onClose} aria-label="Close source viewer" className="text-slate-500 hover:text-slate-200">✕</button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {error && <ErrorBox message={error} />}
        {!chunk && !error && <Loading label="Opening source…" />}
        {chunk && <ViewerBody chunk={chunk} quote={quote} />}
      </div>
      {chunk && chunk.kind !== "video" && (chunk.prev_id || chunk.next_id) && (
        <div className="flex justify-between border-t border-slate-800 p-3 text-sm">
          <button disabled={!chunk.prev_id} onClick={() => chunk.prev_id && setCurrentId(chunk.prev_id)} className="rounded-md px-3 py-1 text-slate-300 hover:bg-slate-800 disabled:opacity-30">← Previous</button>
          <button disabled={!chunk.next_id} onClick={() => chunk.next_id && setCurrentId(chunk.next_id)} className="rounded-md px-3 py-1 text-slate-300 hover:bg-slate-800 disabled:opacity-30">Next →</button>
        </div>
      )}
    </aside>
  );
}

function ViewerBody({ chunk, quote }: { chunk: KbChunk; quote?: string }) {
  if (chunk.kind === "video") {
    const start = Number(chunk.locator.t_start ?? 0);
    const embed = youtubeEmbed(chunk.deep_link, start);
    return (
      <>
        {embed ? (
          <div className="aspect-video overflow-hidden rounded-lg border border-slate-800 bg-black">
            <iframe key={embed} src={embed} title={chunk.label} className="h-full w-full" allow="encrypted-media; picture-in-picture" allowFullScreen />
          </div>
        ) : (
          <p className="text-sm text-slate-400">This lecture is not on YouTube, so it cannot be embedded.</p>
        )}
        {chunk.deep_link && <a href={chunk.deep_link} target="_blank" rel="noreferrer" className="text-sm text-sky-400 hover:underline">Open at this timestamp ↗</a>}
        <Transcript text={chunk.text} quote={quote} />
      </>
    );
  }
  if (chunk.kind === "slides") {
    return (
      <>
        {chunk.asset_url ? <img src={chunk.asset_url} alt={chunk.label} className="w-full rounded-lg border border-slate-800 bg-white" /> : <p className="text-sm text-slate-400">The slide image is missing.</p>}
        {chunk.visual_description && (
          <div className="rounded-lg border border-violet-900 bg-violet-950/30 p-3">
            <p className="mb-1 text-xs uppercase tracking-wide text-violet-300">What the vision model read</p>
            <p className="text-sm text-slate-200">{chunk.visual_description}</p>
          </div>
        )}
        {chunk.text && <Transcript text={chunk.text} quote={quote} />}
      </>
    );
  }
  const page = Number(chunk.locator.page ?? 1);
  return (
    <>
      <p className="text-xs text-slate-500">{String(chunk.locator.section ?? "") || "Page text"} · page {page}</p>
      <Transcript text={chunk.text} quote={quote} />
      {chunk.deep_link && <a href={chunk.deep_link} target="_blank" rel="noreferrer" className="text-sm text-sky-400 hover:underline">Open PDF at page {page} ↗</a>}
    </>
  );
}

function Transcript({ text, quote }: { text: string; quote?: string }) {
  const parts = quote ? splitAtQuote(text, quote) : null;
  return (
    <p className="whitespace-pre-wrap rounded-lg bg-slate-950/60 p-3 text-sm leading-relaxed text-slate-300">
      {parts ? (<>{parts[0]}<mark className="rounded bg-amber-400/30 px-0.5 text-amber-100">{parts[1]}</mark>{parts[2]}</>) : text}
    </p>
  );
}
