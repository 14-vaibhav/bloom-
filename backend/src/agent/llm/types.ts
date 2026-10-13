export type LLMProviderName = "anthropic" | "gemini";
export type LLMAgentName = "diagnostician" | "curator" | "strategist" | "summary" | "slide_vision" | "tutor_answer" | "kb_question_gen";

export interface LLMProvider {
  name: LLMProviderName;
  complete(req: {
    model: string;
    system: string;
    user: string;
    maxTokens: number;
    temperature: number;
    timeoutMs: number;
    /** v4 §N1.2 — optional inline images (vision). */
    images?: Array<{ mimeType: string; base64: string }>;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

export type LLMSource = "llm" | "cache" | "fallback";
export type LLMResult<T> = {
  value: T;
  source: LLMSource;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  fallbackUsed: boolean;
};
