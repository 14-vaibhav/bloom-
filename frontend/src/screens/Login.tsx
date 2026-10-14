import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { setToken } from "../lib/session";

type AuthResult = { student: { id: string; name: string; email: string }; token: string };

/** Shown only when the server answers 401, i.e. it runs with AUTH_REQUIRED=true. */
export function Login({ onSignedIn }: { onSignedIn: (studentId: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<AuthResult>(mode === "login" ? "/auth/login" : "/auth/register", mode === "login" ? { email, password } : { name, email, password });
      setToken(result.token);
      onSignedIn(result.student.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full rounded-xl border border-zinc-800 bg-black px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-zinc-600";
  return (
    <div className="min-h-screen bg-black text-zinc-100 flex items-center justify-center p-6">
      <form onSubmit={submit} className="max-w-sm w-full rounded-2xl border border-zinc-900 bg-zinc-950 p-8 space-y-4">
        <div className="h-10 w-10 mx-auto rounded-xl bg-white text-black flex items-center justify-center font-bold text-lg">✦</div>
        <h1 className="text-xl font-semibold text-white text-center">{mode === "login" ? "Sign in to Bloom" : "Create your Bloom account"}</h1>
        {mode === "register" && <input className={field} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />}
        <input className={field} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        <input className={field} type="password" placeholder="Password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} />
        {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
        <button type="submit" disabled={busy} className="w-full rounded-xl bg-white py-2.5 text-sm font-semibold text-black hover:bg-zinc-200 transition-colors disabled:opacity-60">
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }} className="w-full text-xs text-zinc-500 hover:text-zinc-300">
          {mode === "login" ? "New here? Create an account" : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
