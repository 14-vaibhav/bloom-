import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./api";

export type ApiState<T> = { data: T | null; loading: boolean; error: string | null; reload: () => void };

/** Every screen needs a loading state and an error state (bloom-phase8-brief
 * §A6 / §C2) — this is the one place that logic lives instead of copy-pasted
 * seven times. A 404 (e.g. "no plan yet") is surfaced as a normal error
 * state, not a crash — screens decide how to render that message. */
export function useApiData<T>(fetcher: () => Promise<T>, deps: unknown[]): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcher()
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : "Something went wrong loading this."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, loading, error, reload };
}
