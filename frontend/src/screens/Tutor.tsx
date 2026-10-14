import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import type { KbChunk, StoredTurn, TutorTurn } from "../lib/types";
import { AnswerCheckPanel } from "../components/AnswerCheckPanel";
import { CitationChip } from "../components/CitationChip";
import { SourceViewer } from "../components/SourceViewer";
import { Card, ErrorBox, Loading } from "../components/ui";

type ViewTurn = TutorTurn;
type Open = { chunkId: string; quote?: string } | null;

const SAMPLE_PROMPTS = [
  "How does a singly linked list store its elements in memory?",
  "Explain the difference between a stack and a queue with examples.",
  "Why is inserting at the head of a linked list O(1) constant time?",
  "What is the two-pointer technique for detecting cycles?",
];

async function hydrate(t: StoredTurn): Promise<ViewTurn> {
  const ids = [...new Set([...(t.answer?.segments ?? []).flatMap((s) => s.chunk_ids), ...t.retrieved_chunk_ids])];
  const nearestIds = t.answer?.nearest_chunk_ids ?? [];
  const wanted = [...new Set([...ids, ...nearestIds])];
  const chunks = wanted.length ? await api.post<KbChunk[]>("/kb/chunks", { chunk_ids: wanted }) : [];
  const byId = new Map(chunks.map((c) => [c.chunk_id, c]));
  const hasAnswer = (t.answer?.segments?.length ?? 0) > 0;
  return {
    turn_id: t.turn_id,
    session_id: t.session_id,
    asked_at: t.asked_at,
    question: t.question,
    outcome: t.outcome,
    mode: t.mode,
    retrieval_mode: t.retrieval_mode,
    subtopic_ids: t.subtopic_ids,
    chunks: ids.map((id) => byId.get(id)).filter((c): c is KbChunk => !!c),
    answer: hasAnswer ? { segments: t.answer!.segments!, follow_up: t.answer!.follow_up ?? null } : null,
    message: t.answer?.message ?? null,
    nearest: nearestIds.map((id) => byId.get(id)).filter((c): c is KbChunk => !!c),
    validation: t.validation_report,
    repair_rounds: t.repair_rounds,
    notices: [],
    latency_ms: t.latency_ms ?? 0,
  };
}

export function Tutor({ studentId }: { studentId: string }) {
  const [params, setParams] = useSearchParams();
  const [turns, setTurns] = useState<ViewTurn[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [open, setOpen] = useState<Open>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const autoAsked = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const latest = await api.get<StoredTurn[]>(`/students/${studentId}/tutor/turns?limit=1`);
        if (latest.length === 0) return;
        const sid = latest[0].session_id;
        const stored = await api.get<StoredTurn[]>(`/students/${studentId}/tutor/turns?session_id=${sid}&limit=100`);
        const view = await Promise.all(stored.map(hydrate));
        if (!cancelled) {
          setSessionId(sid);
          setTurns(view);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load earlier questions.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  const ask = useCallback(
    async (q: string) => {
      if (!q.trim() || asking) return;
      setError(null);
      setAsking(true);
      const queryText = q.trim();
      setQuestion("");
      try {
        const res = await api.post<TutorTurn>(`/students/${studentId}/tutor/ask`, {
          student_id: studentId,
          question: queryText,
          session_id: sessionId,
        });
        setSessionId(res.session_id);
        const view = await hydrate({
          turn_id: res.turn_id,
          session_id: res.session_id,
          asked_at: res.asked_at,
          question: res.question,
          outcome: res.outcome,
          mode: res.mode,
          retrieval_mode: res.retrieval_mode,
          subtopic_ids: res.subtopic_ids,
          retrieved_chunk_ids: res.chunks.map((c) => c.chunk_id),
          answer: res.answer
            ? {
                segments: res.answer.segments,
                follow_up: res.answer.follow_up,
                nearest_chunk_ids: res.nearest.map((c) => c.chunk_id),
              }
            : null,
          validation_report: res.validation,
          repair_rounds: res.repair_rounds,
          latency_ms: res.latency_ms,
        });
        setTurns((prev) => [...prev, view]);
        setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 100);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not get an answer from the tutor.");
      } finally {
        setAsking(false);
      }
    },
    [studentId, sessionId, asking],
  );

  useEffect(() => {
    const q = params.get("q");
    if (q && !autoAsked.current && !asking) {
      autoAsked.current = true;
      setParams({}, { replace: true });
      void ask(q);
    }
  }, [params, ask, asking, setParams]);

  if (loading) return <Loading label="Connecting to AI tutor and course knowledge graph…" />;

  return (
    <div className="mx-auto max-w-4xl space-y-8 pb-36">
      {/* Header Banner */}
      <section className="rounded-3xl border border-zinc-900 bg-zinc-950 p-8 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-widest text-zinc-500 font-mono">Pedagogical Dialogue</div>
            <h1 className="text-3xl font-semibold tracking-tight text-white mt-1">Course Material AI Tutor</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Every factual assertion is grounded in your course slides, video lectures, and textbook chapters.
            </p>
          </div>
          {sessionId && (
            <button
              type="button"
              onClick={() => {
                setSessionId(undefined);
                setTurns([]);
              }}
              className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 hover:text-white shrink-0 font-mono"
            >
              New Chat Session
            </button>
          )}
        </div>
      </section>

      {/* Suggested Prompts if no turns */}
      {turns.length === 0 && (
        <Card className="p-6">
          <p className="text-xs uppercase tracking-widest text-zinc-500 font-mono mb-3">Recommended Discussion Prompts</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {SAMPLE_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => void ask(prompt)}
                className="rounded-xl border border-zinc-900 bg-black p-3.5 text-left text-xs text-zinc-300 hover:border-zinc-700 hover:text-white transition-all group"
              >
                <span className="line-clamp-2 leading-relaxed">{prompt}</span>
                <span className="mt-2 block text-[10px] font-mono text-zinc-600 group-hover:text-zinc-400">Ask now →</span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Message History */}
      <div className="space-y-6">
        {turns.map((t) => (
          <TurnView
            key={t.turn_id}
            turn={t}
            openId={open?.chunkId}
            onOpen={(chunkId, quote) => setOpen({ chunkId, quote })}
          />
        ))}

        {asking && (
          <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-6 flex items-center gap-3 text-zinc-400">
            <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
            <span className="text-xs">Searching course chunks and verifying verbatim citations…</span>
          </div>
        )}

        {error && <ErrorBox message={error} onRetry={() => setError(null)} />}
        <div ref={bottom} />
      </div>

      {/* Fixed Bottom Input Bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-900 bg-black/90 px-6 py-4 backdrop-blur-xl"
      >
        <div className="mx-auto flex max-w-4xl gap-3">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={asking}
            placeholder="Ask anything about your syllabus, concepts, or algorithms…"
            aria-label="Question"
            className="flex-1 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none transition-colors shadow-inner"
          />
          <button
            type="submit"
            disabled={asking || question.trim().length < 2}
            className="rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black hover:bg-zinc-200 disabled:opacity-30 transition-all shadow-md shrink-0"
          >
            Ask Tutor →
          </button>
        </div>
      </form>

      {open && <SourceViewer chunkId={open.chunkId} quote={open.quote} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TurnView({
  turn,
  openId,
  onOpen,
}: {
  turn: ViewTurn;
  openId?: string;
  onOpen: (chunkId: string, quote?: string) => void;
}) {
  const byId = new Map([...turn.chunks, ...turn.nearest].map((c) => [c.chunk_id, c]));
  const declined = turn.outcome === "declined_no_evidence" || turn.outcome === "declined_kb_down";

  return (
    <div className="space-y-4">
      {/* User Bubble */}
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl border border-zinc-800 bg-zinc-900 px-5 py-3.5 text-sm text-zinc-100 shadow-sm leading-relaxed">
          {turn.question}
        </div>
      </div>

      {/* Assistant Card */}
      <div className="rounded-3xl border border-zinc-900 bg-zinc-950 p-6 space-y-4 shadow-md">
        {/* Verification & Outcome Badge Bar */}
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono pb-3 border-b border-zinc-900">
          {turn.outcome === "answered" && (
            <span className="rounded-md border border-emerald-900/60 bg-emerald-950/20 px-2.5 py-0.5 text-emerald-400">
              Verified Against Ingested Sources ✓
            </span>
          )}
          {turn.outcome === "extractive_fallback" && (
            <span className="rounded-md border border-amber-900/60 bg-amber-950/20 px-2.5 py-0.5 text-amber-400">
              Extractive Passage
            </span>
          )}
          {declined && (
            <span className="rounded-md border border-rose-900/60 bg-rose-950/20 px-2.5 py-0.5 text-rose-400">
              Declined (Not In Course Material)
            </span>
          )}
          {turn.mode && (
            <span className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-0.5 text-zinc-400 capitalize">
              {turn.mode} mode
            </span>
          )}
          {turn.repair_rounds > 0 && (
            <span className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-0.5 text-zinc-500">
              {turn.repair_rounds} repair pass(es)
            </span>
          )}
          {turn.latency_ms > 0 && (
            <span className="text-zinc-600 ml-auto">{turn.latency_ms}ms</span>
          )}
        </div>

        {/* Answer Content with Citations */}
        {turn.answer && (
          <div className="space-y-4">
            {turn.answer.segments.map((s, i) => (
              <div key={i} className="space-y-2">
                <p className="text-sm leading-relaxed text-zinc-200">{s.text}</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  {s.chunk_ids.map((id) => {
                    const c = byId.get(id);
                    return c ? (
                      <CitationChip
                        key={id}
                        chunk={c}
                        active={openId === id}
                        onOpen={(cid) => onOpen(cid, s.quote)}
                      />
                    ) : null;
                  })}
                </div>
              </div>
            ))}

            {turn.answer.follow_up && (
              <div className="rounded-2xl border border-zinc-900 bg-black p-4 text-xs space-y-1 mt-3">
                <p className="font-mono uppercase tracking-wider text-zinc-500">Suggested Follow-up Challenge</p>
                <p className="text-zinc-300 leading-relaxed">{turn.answer.follow_up}</p>
              </div>
            )}
          </div>
        )}

        {/* Declined State */}
        {declined && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-300">{turn.message}</p>
            {turn.nearest.length > 0 && (
              <div className="space-y-2 pt-2">
                <p className="text-xs text-zinc-500 font-mono">Closest Related Course Material:</p>
                {turn.nearest.map((c) => (
                  <div key={c.chunk_id} className="rounded-xl border border-zinc-900 bg-black p-3">
                    <CitationChip chunk={c} onOpen={(id) => onOpen(id)} />
                    <p className="mt-2 line-clamp-2 text-xs text-zinc-400">{c.text || c.visual_description}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Collapsible Answer Check Panel */}
        <AnswerCheckPanel turn={turn} />
      </div>
    </div>
  );
}
