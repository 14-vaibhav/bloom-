import type { KbChunk, ReviewSource } from "../lib/types";
import { KIND_ICON, KIND_STYLE } from "../lib/kb";

/** A chip exists only if a source_chunks row backs it: it is always built from a fetched chunk or a server-issued review source. */
export function CitationChip({
  chunk,
  active,
  onOpen,
}: {
  chunk: Pick<KbChunk, "chunk_id" | "kind" | "label"> | ReviewSource;
  active?: boolean;
  onOpen: (chunkId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(chunk.chunk_id)}
      title="Open cited passage in source viewer"
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
        KIND_STYLE[chunk.kind]
      } ${active ? "border-zinc-500 bg-zinc-800 text-zinc-100 shadow-sm" : ""}`}
    >
      <span aria-hidden className="text-[10px] text-zinc-500">{KIND_ICON[chunk.kind]}</span>
      <span className="truncate max-w-[200px]">{chunk.label}</span>
    </button>
  );
}
