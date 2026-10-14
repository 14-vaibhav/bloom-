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
    api
      .get<KbChunk>(`/kb/chunks/${encodeURIComponent(currentId)}`)
      .then((c) => {
        if (!cancelled) setChunk(c);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load this source chunk.");
      });
    return () => {
      cancelled = true;
    };
  }, [currentId]);

  return (
    <aside
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-zinc-900 bg-black shadow-2xl"
      aria-label="Source viewer"
    >
      <div className="flex items-start justify-between gap-4 border-b border-zinc-900 bg-zinc-950 px-6 py-5">
        <div>
          <p className="text-xs uppercase tracking-widest text-zinc-600 font-mono">
            {chunk ? KIND_LABEL[chunk.kind] : "Knowledge Source"}
          </p>
          <p className="mt-1 text-base font-semibold text-zinc-100">{chunk?.label ?? "Loading source material…"}</p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close source viewer"
          className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200 transition-colors"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-6">
        {error && <ErrorBox message={error} />}
        {!chunk && !error && <Loading label="Retrieving source passage…" />}
        {chunk && <ViewerBody chunk={chunk} quote={quote} />}
      </div>

      {chunk && chunk.kind !== "video" && (chunk.prev_id || chunk.next_id) && (
        <div className="flex justify-between border-t border-zinc-900 bg-zinc-950 px-6 py-4 text-sm">
          <button
            disabled={!chunk.prev_id}
            onClick={() => chunk.prev_id && setCurrentId(chunk.prev_id)}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs text-zinc-300 hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-30 transition-colors"
          >
            ← Previous Passage
          </button>
          <button
            disabled={!chunk.next_id}
            onClick={() => chunk.next_id && setCurrentId(chunk.next_id)}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs text-zinc-300 hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-30 transition-colors"
          >
            Next Passage →
          </button>
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
      <div className="space-y-4">
        {embed ? (
          <div className="aspect-video overflow-hidden rounded-2xl border border-zinc-900 bg-black">
            <iframe
              key={embed}
              src={embed}
              title={chunk.label}
              className="h-full w-full"
              allow="encrypted-media; picture-in-picture"
              allowFullScreen
            />
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Video playback unavailable or not hosted on an embeddable provider.</p>
        )}
        {chunk.deep_link && (
          <a
            href={chunk.deep_link}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Open in external player at timestamp ↗
          </a>
        )}
        <Transcript text={chunk.text} quote={quote} />
      </div>
    );
  }

  if (chunk.kind === "slides") {
    return (
      <div className="space-y-4">
        {chunk.asset_url ? (
          <img
            src={chunk.asset_url}
            alt={chunk.label}
            className="w-full rounded-2xl border border-zinc-900 bg-zinc-950 object-contain max-h-80"
          />
        ) : (
          <p className="text-sm text-zinc-500">Slide visual preview not available.</p>
        )}
        {chunk.visual_description && (
          <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-4">
            <p className="mb-1 text-xs uppercase tracking-wider text-zinc-600 font-mono">Vision Model Interpretation</p>
            <p className="text-sm text-zinc-300 leading-relaxed">{chunk.visual_description}</p>
          </div>
        )}
        {chunk.text && <Transcript text={chunk.text} quote={quote} />}
      </div>
    );
  }

  const page = Number(chunk.locator.page ?? 1);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-zinc-500 font-mono">
        <span>{String(chunk.locator.section ?? "") || "Section Text"}</span>
        <span>Page {page}</span>
      </div>
      <Transcript text={chunk.text} quote={quote} />
      {chunk.deep_link && (
        <a
          href={chunk.deep_link}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Open textbook PDF at page {page} ↗
        </a>
      )}
    </div>
  );
}

function Transcript({ text, quote }: { text: string; quote?: string }) {
  const parts = quote ? splitAtQuote(text, quote) : null;
  return (
    <div className="whitespace-pre-wrap rounded-2xl border border-zinc-900 bg-zinc-950 p-5 text-sm leading-relaxed text-zinc-300 font-mono">
      {parts ? (
        <>
          {parts[0]}
          <mark className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-100 font-semibold border border-zinc-700">
            {parts[1]}
          </mark>
          {parts[2]}
        </>
      ) : (
        text
      )}
    </div>
  );
}
