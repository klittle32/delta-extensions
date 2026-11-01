import { defineConfig } from "vitest/config";
// Explicit measurements run separately from normal lifecycle tests.
export default defineConfig({
  test: {
    include: ["packages/core/bench/watch-projection.bench.ts"],
    maxWorkers: 1,
  },
});
