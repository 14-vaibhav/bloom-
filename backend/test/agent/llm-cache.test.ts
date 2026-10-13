import { describe, expect, it } from "vitest";
import { cacheKey, canonicalJson } from "../../src/agent/llm/cache.js";

describe("Phase 7 canonical LLM cache keys", () => {
  it("normalizes recursively reordered object keys", () => {
    const left = { student: { mu: 0.4, confidence: 0.3 }, ids: ["a", "b"] };
    const right = { ids: ["a", "b"], student: { confidence: 0.3, mu: 0.4 } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(cacheKey("strategist", "v1", left)).toBe(cacheKey("strategist", "v1", right));
  });

  it("keeps array order meaningful and invalidates on a prompt version bump", () => {
    expect(cacheKey("curator", "v1", ["a", "b"])).not.toBe(cacheKey("curator", "v1", ["b", "a"]));
    expect(cacheKey("curator", "v1", { candidate: "r1" })).not.toBe(cacheKey("curator", "v2", { candidate: "r1" }));
  });
});
