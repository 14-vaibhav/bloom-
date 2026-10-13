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

const SAMPLE = ["How does a singly linked list store its elements?", "What is the difference between a stack and a queue?", "Why is inserting at the head of a linked list constant time?"];

/** A stored turn (after a refresh or restart) rebuilt into the same shape as a live one. Chips are re-fetched from source_chunks, never reconstructed. */
async function hydrate(t: StoredTurn): Promise<ViewTurn> {
  const ids = [...new Set([...(t.answer?.segments ?? []).flatMap((s) => s.chunk_ids), ...t.retrieved_chunk_ids])];
  const nearestIds = t.answer?.nearest_chunk_ids ?? [];
  const wanted = [...new Set([...ids, ...nearestIds])];
  const chunks = wanted.length ? await api.post<KbChunk[]>("/kb/chunks", { chunk_ids: wanted }) : [];
  const byId = new Map(chunks.map((c) => [c.chunk_id, c]));
  const hasAnswer = (t.answer?.segments?.length ?? 0) > 0;
  return {
    turn_id: t.turn_id, session_id: t.session_id, asked_at: t.asked_at, question: t.question, outcome: t.outcome, mode: t.mode,
    retrieval_mode: t.retrieval_mode, subtopic_ids: t.subtopic_ids, chunks: ids.map((id) => byId.get(id)).filter((c): c is KbChunk => !!c),
    answer: hasAnswer ? { segments: t.answer!.segments!, follow_up: t.answer!.follow_up ?? null } : null,
    message: t.answer?.message ?? null, nearest: nearestIds.map((id) => byId.get(id)).filter((c): c is KbChunk => !!c),
    validation: t.validation_report, repair_rounds: t.repair_rounds, notices: [], latency_ms: t.latency_ms ?? 0,
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

  // Restore the latest session from the database: a refresh or a backend restart loses nothing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const latest = await api.get<StoredTurn[]>(`/students/${studentId}/tutor/turns?limit=1`);
        if (latest.length === 0) return;
        const sid = latest[0].session_id;
        const stored = await api.get<StoredTurn[]>(`/students/${studentId}/tutor/turns?session_id=${sid}&limit=100`);
        const view = await Promise.all(stored.map(hydrate));
        if (!cancelled) { setSessionId(sid); setTurns(view); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load earlier questions.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [studentId]);

  const ask = useCallback(async (q: string, ctx?: { question_id?: string; assessment_id?: string }) => {
    const text = q.trim();
    if (text.length < 3) return;
    setAsking(true);
    setError(null);
    try {
      const turn = await api.post<TutorTurn>(`/students/${studentId}/tutor/ask`, {
        question: text, session_id: sessionId, context_question_id: ctx?.question_id, context_assessment_id: ctx?.assessment_id,
      });
      setSessionId(turn.session_id);
      setTurns((prev) => [...prev, turn]);
      setQuestion("");
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The tutor could not answer.");
    } finally {
      setAsking(false);
    }
  }, [studentId, sessionId]);

  // "Explain this" from a wrong answer opens the tutor with the question as context.
  useEffect(() => {
    const q = params.get("q");
    if (loading || autoAsked.current || !q) return;
    autoAsked.current = true;
    const ctx = { question_id: params.get("question_id") ?? undefined, assessment_id: params.get("assessment_id") ?? undefined };
    setParams({}, { replace: true });
    void ask(`Explain this: ${q}`, ctx);
  }, [loading, params, ask, setParams]);

  if (loading) return <Loading label="Loading your earlier questions…" />;

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-24">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Tutor</h1>
        <p className="text-sm text-slate-400">Answers come only from your course material. Every claim cites a lecture timestamp, a slide or a textbook page, and a validator rejects any answer whose citations do not check out.</p>
      </div>

      {turns.length === 0 && (
        <Card>
          <p className="text-sm text-slate-300">Ask about anything in your course. For example:</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {SAMPLE.map((s) => <button key={s} onClick={() => setQuestion(s)} className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-sky-600">{s}</button>)}
          </div>
        </Card>
      )}

      {turns.map((t) => <TurnView key={t.turn_id} turn={t} openId={open?.chunkId} onOpen={(chunkId, quote) => setOpen({ chunkId, quote })} />)}
      {asking && <Loading label="Finding it in your course material and checking the citations…" />}
      {error && <ErrorBox message={error} />}
      <div ref={bottom} />

      <form
        onSubmit={(e) => { e.preventDefault(); void ask(question); }}
        className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-800 bg-slate-950/95 px-6 py-3 backdrop-blur"
      >
        <div className="mx-auto flex max-w-3xl gap-2">
          <input
            value={question} onChange={(e) => setQuestion(e.target.value)} disabled={asking}
            placeholder="Ask a question about your course…" aria-label="Question"
            className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
          />
          <button type="submit" disabled={asking || question.trim().length < 3} className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">Ask</button>
        </div>
      </form>

      {open && <SourceViewer chunkId={open.chunkId} quote={open.quote} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TurnView({ turn, openId, onOpen }: { turn: ViewTurn; openId?: string; onOpen: (chunkId: string, quote?: string) => void }) {
  const byId = new Map([...turn.chunks, ...turn.nearest].map((c) => [c.chunk_id, c]));
  const declined = turn.outcome === "declined_no_evidence" || turn.outcome === "declined_kb_down";
  return (
    <div className="space-y-2">
      <div className="ml-auto max-w-[85%] rounded-xl bg-sky-900/40 px-4 py-2 text-sm text-slate-100">{turn.question}</div>
      <Card>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
          {turn.outcome === "answered" && <span className="rounded border border-emerald-800 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">Checked answer</span>}
          {turn.outcome === "extractive_fallback" && <span className="rounded border border-amber-800 bg-amber-500/10 px-2 py-0.5 text-amber-300">Extractive answer — passages quoted directly, not paraphrased</span>}
          {declined && <span className="rounded border border-rose-800 bg-rose-500/10 px-2 py-0.5 text-rose-300">{turn.outcome === "declined_kb_down" ? "Declined — knowledge base unavailable" : "Declined — not in your course material"}</span>}
          {turn.mode && turn.answer && <span className="rounded border border-slate-700 px-2 py-0.5 text-slate-400">{turn.mode} mode</span>}
          {turn.repair_rounds > 0 && <span className="rounded border border-slate-700 px-2 py-0.5 text-slate-400">repaired after {turn.repair_rounds} round{turn.repair_rounds > 1 ? "s" : ""}</span>}
        </div>

        {turn.answer && (
          <div className="space-y-3">
            {turn.answer.segments.map((s, i) => (
              <div key={i}>
                <p className="text-sm leading-relaxed text-slate-100">{s.text}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {s.chunk_ids.map((id) => {
                    const c = byId.get(id);
                    return c ? <CitationChip key={id} chunk={c} active={openId === id} onOpen={(cid) => onOpen(cid, s.quote)} /> : null;
                  })}
                </div>
              </div>
            ))}
            {turn.answer.follow_up && (
              <div className="rounded-lg border border-violet-900 bg-violet-950/30 p-3 text-sm text-slate-200">
                <p className="mb-0.5 text-xs uppercase tracking-wide text-violet-300">Try this</p>{turn.answer.follow_up}
              </div>
            )}
          </div>
        )}

        {declined && (
          <div className="space-y-2">
            <p className="text-sm text-slate-200">{turn.message}</p>
            {turn.nearest.length > 0 && (
              <div className="space-y-2">
                {turn.nearest.map((c) => (
                  <div key={c.chunk_id} className="rounded-lg border border-slate-800 p-2">
                    <CitationChip chunk={c} onOpen={(id) => onOpen(id)} />
                    <p className="mt-1 line-clamp-2 text-xs text-slate-400">{c.text || c.visual_description}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {turn.notices.length > 0 && turn.notices.map((n) => <p key={n} className="mt-2 text-xs text-amber-300/80">{n}</p>)}
        <AnswerCheckPanel turn={turn} />
      </Card>
    </div>
  );
}
