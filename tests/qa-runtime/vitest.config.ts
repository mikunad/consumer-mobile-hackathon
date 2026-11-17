import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", include: ["tests/qa-runtime/**/*.test.ts"], setupFiles: ["tests/qa-adapter/setup.ts"], fileParallelism: false, maxWorkers: 1 } });
