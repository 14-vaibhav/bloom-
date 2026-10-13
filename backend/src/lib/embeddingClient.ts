/**
 * Embedding client for scripts/embed-resources.ts and KB ingestion (offline), plus the single runtime query embedding in the tutor's retrieval (v4 §N3.1, which passes a timeout).
 *
 * Uses Gemini's gemini-embedding-001, requesting 1536-dim output (via Matryoshka
 * truncation, which the model supports natively) so it matches the `vector(1536)`
 * column in schema.ts without needing a schema change if the provider ever switches
 * to OpenAI's text-embedding-3-small (also natively 1536-dim).
 */

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_DIM = 1536;

export async function embedText(text: string, opts: { timeoutMs?: number } = {}): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set. Add it to backend/.env before running embed-resources.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIM,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini embedContent failed: ${res.status} ${res.statusText} — ${errText.slice(0, 500)}`);
  }

  const json = (await res.json()) as { embedding?: { values?: number[] } };
  const values = json.embedding?.values;
  if (!values || values.length !== EMBEDDING_DIM) {
    throw new Error(`Unexpected embedding shape: got ${values?.length ?? 0} dims, expected ${EMBEDDING_DIM}`);
  }
  return values;
}
