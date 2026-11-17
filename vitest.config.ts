import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["tests/backend/**/*.test.ts"],
    setupFiles: ["tests/backend/setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 10000,
    restoreMocks: true,
  },
});
