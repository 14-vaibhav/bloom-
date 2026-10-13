/**
 * Reusable URL liveness check. Used offline by scripts/check-links.ts during seeding,
 * and reused as-is by the RAG tool's live-verification path in Phase 2 (bloom-architecture-plan.md §14).
 */

export type UrlVerification = {
  url: string;
  status: "live" | "dead" | "unverified";
  httpStatus: number | null;
  checkedAt: string;
};

const DEFAULT_TIMEOUT_MS = 5000;

export async function verifyUrl(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<UrlVerification> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Bloom-LinkChecker/1.0" },
    });

    // Some servers don't implement HEAD properly (405/501) — fall back to a ranged GET.
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "Bloom-LinkChecker/1.0", Range: "bytes=0-1023" },
      });
    }

    clearTimeout(timeout);

    if (res.status >= 200 && res.status < 400) {
      return { url, status: "live", httpStatus: res.status, checkedAt };
    }
    if (res.status === 404 || res.status === 410) {
      return { url, status: "dead", httpStatus: res.status, checkedAt };
    }
    // Other 4xx/5xx: don't declare dead on a single ambiguous response.
    return { url, status: "unverified", httpStatus: res.status, checkedAt };
  } catch {
    clearTimeout(timeout);
    return { url, status: "unverified", httpStatus: null, checkedAt };
  }
}

export async function verifyUrlsConcurrently(
  urls: string[],
  concurrency = 8,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<UrlVerification[]> {
  const results: UrlVerification[] = new Array(urls.length);
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const i = cursor++;
      results[i] = await verifyUrl(urls[i], timeoutMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}
