import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ["./test/setup.ts"],
    // The integration suites intentionally exercise the same durable tables
    // (notably tool_health). Running files concurrently makes one suite's
    // cleanup race another suite's circuit-breaker assertions.
    fileParallelism: false,
  },
});
