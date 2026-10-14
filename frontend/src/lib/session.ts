/** The sign-in token, kept per browser. Only used when the backend runs with AUTH_REQUIRED=true. */
const KEY = "bloom.token";

export function getToken(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function setToken(token: string): void {
  try { localStorage.setItem(KEY, token); } catch { /* private browsing: stay signed in for this page load only */ }
}

export function clearToken(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

/** Fired by the API client when the server answers 401, so the app can show the sign-in screen. */
export const UNAUTHENTICATED_EVENT = "bloom:unauthenticated";
