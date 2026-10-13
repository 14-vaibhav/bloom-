import { describe, it, expect } from "vitest";
import { ALL_TOOL_NAMES, toolSchemas } from "../../src/tools/schemas.js";

describe("tool schemas", () => {
  it("has exactly 24 operations (21 + 3 knowledge-base ops)", () => {
    expect(ALL_TOOL_NAMES.length).toBe(24);
  });

  it("every operation has both an input and output schema", () => {
    for (const name of ALL_TOOL_NAMES) {
      const entry = toolSchemas[name];
      expect(entry.input, name).toBeDefined();
      expect(entry.output, name).toBeDefined();
      expect(entry.bucket, name).toMatch(/^(performance|rag|calendar|qbank|state|kb)$/);
    }
  });

  it("buckets contain the documented op counts (4/2/5/4/6)", () => {
    const counts: Record<string, number> = {};
    for (const name of ALL_TOOL_NAMES) {
      const bucket = toolSchemas[name].bucket;
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    expect(counts.performance).toBe(4);
    expect(counts.rag).toBe(2);
    expect(counts.calendar).toBe(5);
    expect(counts.qbank).toBe(4);
    expect(counts.state).toBe(6);
  });

  it("invalid input is rejected by safeParse, never throws", () => {
    const result = toolSchemas["performance.get_student_performance"].input.safeParse({ student_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rag.search_learning_resources applies its documented defaults", () => {
    const result = toolSchemas["rag.search_learning_resources"].input.safeParse({
      subtopic_id: "arr_traversal",
      target_difficulty: 2,
      max_duration_min: 30,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.k).toBe(8);
      expect(result.data.exclude_ids).toEqual([]);
    }
  });
});
