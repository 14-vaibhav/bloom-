import type { KbChunk, ReviewSource } from "../lib/types";
import { KIND_ICON, KIND_STYLE } from "../lib/kb";

/** A chip exists only if a source_chunks row backs it (v4 §N8.3): it is always built from a fetched chunk or a server-issued review source. */
export function CitationChip({ chunk, active, onOpen }: { chunk: Pick<KbChunk, "chunk_id" | "kind" | "label"> | ReviewSource; active?: boolean; onOpen: (chunkId: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(chunk.chunk_id)}
      title="Open this exact place in the source"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${KIND_STYLE[chunk.kind]} ${active ? "ring-1 ring-white/40" : ""}`}
    >
      <span aria-hidden>{KIND_ICON[chunk.kind]}</span>
      {chunk.label}
    </button>
  );
}
