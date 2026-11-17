import { vi } from "vitest";
import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { convexToJson, type Value } from "convex/values";
import * as runtime from "../../convex/v0Runtime";
import { createPublicDispatcher, type Invocation, type RunResources } from "./dispatcher";
import { createQAAdapter, type AdapterOptions } from "./adapter";
import { parseManifest, type ExpectedRun, type Manifest } from "./manifest";

export const NOW = 1_795_000_000_000;

export function manifestFixture(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: 1, runID: "11111111-2222-4333-8444-555555555555", simulatorUDID: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
    nativeSourceRevision: "a".repeat(40), backendSourceRevision: "b".repeat(40),
    deploymentID: "qa-11111111-2222-4333-8444-555555555555", configVersion: "qa-plumbing-unit-v0", fixtureSetID: "synthetic-v0-plumbing-unit",
    apiOrigin: "http://127.0.0.1:43127", cardOrigin: "http://127.0.0.1:43127",
    issuedAt: NOW - 1_000, expiresAt: NOW + 60_000,
    erasedSimulator: true, syntheticDataOnly: true, outboundNetworkDenied: true, ...overrides,
  };
}

export const manifestBytes = (manifest: unknown) => Buffer.from(JSON.stringify(manifest));

export function expectedRun(manifest: Manifest): ExpectedRun {
  const { runID, simulatorUDID, nativeSourceRevision, backendSourceRevision, deploymentID, configVersion, fixtureSetID, apiOrigin, cardOrigin } = manifest;
  return { runID, simulatorUDID, nativeSourceRevision, backendSourceRevision, deploymentID, configVersion, fixtureSetID, apiOrigin, cardOrigin };
}

export function plumbingFixture(invokeImplementation: (invocation: Invocation) => Promise<Value> = async ({ args }) => args) {
  const manifest = manifestFixture();
  const calls = vi.fn(invokeImplementation);
  const dispose = vi.fn(async () => {});
  const allocated: RunResources[] = [];
  const modules = {
    v0Runtime: runtime,
    v0Bets: {
      get: queryGeneric({ args: {}, handler: async () => null }),
      pick: mutationGeneric({ args: {}, handler: async () => null }),
    },
    v0Auth: { redeemPair: actionGeneric({ args: {}, handler: async () => null }) },
  };
  const allowlist = [
    { path: "v0Runtime:attestation", kind: "query" }, { path: "v0Bets:get", kind: "query" },
    { path: "v0Bets:pick", kind: "mutation" }, { path: "v0Auth:redeemPair", kind: "action" },
  ] as const;
  const options: AdapterOptions = {
    mode: "plumbing-unit", manifestBytes: manifestBytes(manifest), expected: expectedRun(manifest), now: () => NOW,
    requiredFunctions: allowlist,
    initializeRun: async ({ manifest, resources }) => {
      allocated.push(resources);
      return {
        execution: "plumbing-stub", runID: manifest.runID, backendSourceRevision: manifest.backendSourceRevision,
        fixtureSetID: manifest.fixtureSetID, freshDatabase: true, outboundNetworkDenied: true,
        dispatcher: createPublicDispatcher({ modules, allowlist, invoke: calls }), dispose,
      };
    },
  };
  const context = parseManifest(options.manifestBytes, options.expected, NOW);
  function request(path = "v0Bets:get", args: Record<string, Value> = {}, route = "/api/query", overrides: RequestInit = {}) {
    const headers = new Headers({ "host": new URL(manifest.apiOrigin).host, "content-type": "application/json", "x-calledit-qa-run-id": manifest.runID, "x-calledit-qa-manifest-sha256": context.sha256 });
    for (const [key, value] of new Headers(overrides.headers)) headers.set(key, value);
    return new Request(manifest.apiOrigin + route, {
      method: "POST", body: JSON.stringify({ path, args: [convexToJson(args)], format: "convex_encoded_json" }),
      ...overrides, headers,
    });
  }
  return { manifest, options, calls, dispose, modules, allowlist, allocated, request, create: () => createQAAdapter(options) };
}
