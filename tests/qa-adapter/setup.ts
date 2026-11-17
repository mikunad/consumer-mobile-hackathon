import { afterEach, beforeEach, vi } from "vitest";

if (process.env.QA_ADAPTER_TEST_ISOLATED !== "network-namespace-v1") {
  throw new Error("QA adapter plumbing units require node tests/qa-adapter/run.mjs");
}
for (const key of Object.keys(process.env)) {
  if (/(?:KEY|SECRET|TOKEN|PASSCODE|CONVEX.*(?:URL|DEPLOY))/i.test(key)) {
    throw new Error("Inherited credential/deployment configuration is forbidden");
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No outbound fetch in adapter plumbing units"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
