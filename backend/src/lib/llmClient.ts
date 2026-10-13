/**
 * Minimal, provider-agnostic text-generation client for offline content scripts
 * (scripts/generate-questions.ts). Not used at runtime by the application in Phase 1 —
 * Phase 1 makes zero LLM calls from the running server.
 *
 * Only Gemini is wired up right now (that's what this project has a key for); the
 * shape is deliberately narrow (one method, JSON in, JSON out) so swapping in
 * Anthropic/OpenAI later is a new function, not a rewrite.
 */

export type GenerateJsonOptions = {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
};

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1] : text;
}

export async function generateJson<T = unknown>(opts: GenerateJsonOptions): Promise<T> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set. Add it to backend/.env before running generation scripts.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: opts.systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: opts.userPrompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 4096,
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini generateContent failed: ${res.status} ${res.statusText} — ${errText.slice(0, 500)}`);
  }

  const json = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Gemini response had no text content: ${JSON.stringify(json).slice(0, 500)}`);
  }

  try {
    return JSON.parse(stripCodeFence(text)) as T;
  } catch (err) {
    throw new Error(`Failed to parse Gemini JSON output: ${(err as Error).message}\nRaw text: ${text.slice(0, 1000)}`);
  }
}

/** Simple delay helper for respecting free-tier rate limits between calls. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
