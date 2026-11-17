import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/qa-adapter/**/*.test.ts"],
    setupFiles: ["tests/qa-adapter/setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 10_000,
    restoreMocks: true,
  },
});
