/**
 * Deterministic PRNG (bloom-phase9-brief §B2: "everything uses one seeded
 * RNG... same seed, identical run, always"). mulberry32 rather than
 * Math.random() specifically because it's a pure function of its own state —
 * no hidden global, so two harness runs with the same seed produce
 * byte-identical draws even running concurrently in the same process.
 */
export type Rng = () => number; // uniform in [0, 1)

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** String -> 32-bit seed, so "eval_run.seed + student_index" (§B2) can be composed
 * from readable identifiers instead of requiring the caller to pre-hash anything. */
export function seedFrom(...parts: Array<string | number>): number {
  const str = parts.join(":");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Box-Muller, consuming two draws from `rng` per call. */
export function gaussian(rng: Rng, mean: number, sigma: number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + sigma * z0;
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
