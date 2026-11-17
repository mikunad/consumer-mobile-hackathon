import { afterEach, beforeEach, vi } from "vitest";

if (process.env.E2E_ISOLATED !== "network-namespace-v1") {
  throw new Error("Use node tests/run-isolated.mjs; direct test execution is forbidden");
}

for (const key of Object.keys(process.env)) {
  if (/(?:KEY|SECRET|TOKEN|PASSCODE|CONVEX.*(?:URL|DEPLOY))/i.test(key)) {
    throw new Error(`Inherited credential or deployment configuration: ${key}`);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T15:59:00Z"));
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Outbound transport denied; use an explicit synthetic adapter");
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
