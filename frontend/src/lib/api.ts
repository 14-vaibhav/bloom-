/**
 * Thin fetch client over Bloom's REST API. Every function returns the
 * `data` half of the { ok, data } / { ok:false, error } envelope, throwing
 * an ApiError on failure — never a fabricated fallback value. Types here
 * are hand-written to match the backend's Zod schemas (bloom-phase8-brief
 * §A2 asks for z.infer directly, but frontend and backend are separate npm
 * workspaces with no shared package, so this is the pragmatic equivalent).
 */

export class ApiError extends Error {
  code: string;
  field?: string;
  status: number;
  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    const err = body?.error ?? { code: "UNKNOWN", message: `Request failed: ${res.status}` };
    throw new ApiError(res.status, err.code, err.message, err.field);
  }
  return body.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
};
