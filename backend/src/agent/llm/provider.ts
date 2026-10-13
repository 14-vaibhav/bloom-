import type { LLMProvider, LLMProviderName } from "./types.js";
import { TimeoutError, TransientError, PermanentError } from "../../tools/errors.js";

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function requestError(provider: string, status: number, body: string): Error {
  const message = `${provider} completion failed: ${status} ${body.slice(0, 300)}`;
  return status >= 500 || status === 429 ? new TransientError(message) : new PermanentError(message);
}

const gemini: LLMProvider = {
  name: "gemini",
  async complete(req) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new PermanentError("GEMINI_API_KEY is not set");
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: timeoutSignal(req.timeoutMs),
        body: JSON.stringify({ system_instruction: { parts: [{ text: req.system }] }, contents: [{ role: "user", parts: [...(req.images ?? []).map((i) => ({ inline_data: { mime_type: i.mimeType, data: i.base64 } })), { text: req.user }] }], generationConfig: { temperature: req.temperature, maxOutputTokens: req.maxTokens, responseMimeType: "application/json" } }),
      });
      if (!response.ok) throw requestError("Gemini", response.status, await response.text());
      const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new PermanentError("Gemini completion had no text");
      return { text, inputTokens: body.usageMetadata?.promptTokenCount ?? 0, outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0 };
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new TimeoutError(`Gemini timed out after ${req.timeoutMs}ms`);
      throw error;
    }
  },
};

const anthropic: LLMProvider = {
  name: "anthropic",
  async complete(req) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new PermanentError("ANTHROPIC_API_KEY is not set");
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: timeoutSignal(req.timeoutMs),
        body: JSON.stringify({ model: req.model, system: req.system, messages: [{ role: "user", content: req.images?.length ? [...req.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.base64 } })), { type: "text", text: req.user }] : req.user }], max_tokens: req.maxTokens, temperature: req.temperature }),
      });
      if (!response.ok) throw requestError("Anthropic", response.status, await response.text());
      const body = await response.json() as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      const text = body.content?.find((part) => part.type === "text")?.text;
      if (!text) throw new PermanentError("Anthropic completion had no text");
      return { text, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new TimeoutError(`Anthropic timed out after ${req.timeoutMs}ms`);
      throw error;
    }
  },
};

export function getProvider(name = process.env.LLM_PROVIDER ?? "gemini"): LLMProvider {
  if (name === "anthropic") return anthropic;
  if (name === "gemini") return gemini;
  throw new PermanentError(`Unsupported LLM_PROVIDER ${name as LLMProviderName}`);
}
