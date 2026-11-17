import { afterEach, describe, expect, it } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError, convexToJson, jsonToConvex } from "convex/values";
import { createQAAdapter, MAX_BINARY_BYTES, MAX_BODY_BYTES } from "./adapter";
import { plumbingFixture, NOW } from "./fixtures";
import { parseManifest } from "./manifest";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

describe("in-process HTTP plumbing only; dispatcher bodies are stubs", () => {
  it("QA-HTTP-01 emits only the exact manifest-bound special attestation", async () => {
    const f = plumbingFixture();
    const adapter = await f.create();
    disposals.push(adapter.dispose);
    const result = await adapter.handle(f.request("v0Runtime:attestation"));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const envelope = await result.json();
    expect(jsonToConvex(envelope.value)).toEqual({
      app: "called-it", contractVersion: "v0.2", schemaVersion: "v0.2", environment: "local",
      sourceSha: f.manifest.backendSourceRevision, deploymentId: f.manifest.deploymentID, configVersion: f.manifest.configVersion,
      testAdapters: true, qaRunID: f.manifest.runID,
      qaManifestSHA256: parseManifest(f.options.manifestBytes, f.options.expected, NOW).sha256,
    });
    expect(envelope.logLines).toEqual([]);
    expect(f.calls).not.toHaveBeenCalled();
    expect((await adapter.handle(f.request("v0Runtime:attestation", { extra: true }))).status).toBe(400);
    expect((await adapter.handle(f.request("v0Runtime:attestation", {}, "/api/action"))).status).toBe(404);
  });

  it("QA-HTTP-02 rejects wrong routes/method/origin/host, run/hash and proxy/auth headers", async () => {
    const f = plumbingFixture();
    const adapter = await f.create();
    disposals.push(adapter.dispose);
    for (const route of ["/api/query?x=1", "/api/query#x", "/api/query_at_ts", "/api/function", "/seed", "/api/query/"]) {
      expect((await adapter.handle(f.request("v0Bets:get", {}, route))).status).toBe(404);
    }
    const valid = f.request();
    expect((await adapter.handle(new Request(valid.url, { method: "GET", headers: valid.headers }))).status).toBe(404);
    expect((await adapter.handle(new Request("http://localhost:43127/api/query", valid))).status).toBe(404);
    for (const [name, value] of [
      ["host", "foreign.invalid:43127"], ["origin", "https://foreign.invalid"], ["x-calledit-qa-run-id", "wrong"],
      ["x-calledit-qa-manifest-sha256", "0".repeat(64)], ["authorization", "Convex SYNTHETIC_PRIVATE"],
      ["cookie", "synthetic=value"], ["forwarded", "for=127.0.0.1"], ["x-forwarded-host", "foreign.invalid"],
    ]) {
      const request = f.request();
      request.headers.set(name, value);
      expect((await adapter.handle(request)).status).toBe(name === "host" ? 404 : 403);
    }
    for (const name of ["x-calledit-qa-run-id", "x-calledit-qa-manifest-sha256"]) {
      const request = f.request();
      request.headers.delete(name);
      expect((await adapter.handle(request)).status).toBe(403);
    }
    expect(f.calls).not.toHaveBeenCalled();
  });

  it("QA-HTTP-03 requires bounded official envelopes and rejects legacy/test-control/unknown calls", async () => {
    const f = plumbingFixture();
    const adapter = await f.create();
    disposals.push(adapter.dispose);
    for (const body of ["not JSON", JSON.stringify({ path: "v0Bets:get", args: {}, format: "json" }), JSON.stringify({ path: "v0Bets:get", args: [], format: "convex_encoded_json" }), JSON.stringify({ path: "v0Bets:get", args: [{}, {}], format: "convex_encoded_json" }), JSON.stringify({ path: "v0Bets:get", args: [{}], format: "convex_encoded_json", admin: true }), JSON.stringify({ path: "v0Bets:get", args: [{ $bytes: "%%%" }], format: "convex_encoded_json" })]) {
      expect((await adapter.handle(f.request("v0Bets:get", {}, "/api/query", { body }))).status).toBe(400);
    }
    for (const path of ["ext:card", "game:today", "v0Bets:reset", "v0Internal:get", "v0Bets:missing"]) {
      expect((await adapter.handle(f.request(path))).status).toBe(path === "v0Bets:missing" ? 404 : 400);
    }
    expect((await adapter.handle(f.request("v0Bets:get", { now: NOW }))).status).toBe(400);
    expect((await adapter.handle(f.request("v0Bets:get", {}, "/api/query", { body: " ".repeat(MAX_BODY_BYTES + 1) }))).status).toBe(413);
    expect((await adapter.handle(f.request("v0Bets:get", {}, "/api/query", { headers: { "content-length": String(MAX_BODY_BYTES + 1) } }))).status).toBe(413);
    expect((await adapter.handle(f.request("v0Bets:get", {}, "/api/query", { headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect((await adapter.handle(f.request("v0Bets:get", {}, "/api/query", { headers: { "content-encoding": "gzip" } }))).status).toBe(415);
    expect(f.calls).not.toHaveBeenCalled();
  });

  it("QA-SERIALIZATION-01 uses the installed official Convex HTTP client and value codecs end to end", async () => {
    const f = plumbingFixture();
    const adapter = await f.create();
    disposals.push(adapter.dispose);
    const wireBodies: unknown[] = [];
    const client = new ConvexHttpClient(f.manifest.apiOrigin, {
      logger: false, skipConvexDeploymentUrlCheck: true,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        wireBodies.push(await request.clone().json());
        for (const [key, value] of f.request().headers) request.headers.set(key, value);
        return adapter.handle(request);
      },
    });
    const bytes = new Uint8Array([0, 1, 127, 255]).buffer;
    const args = { nested: { bytes, integer: 9_223_372_036_854_775_807n, notANumber: Number.NaN, negativeZero: -0 } };
    const result = await client.query(makeFunctionReference<"query">("v0Bets:get"), args);
    expect(wireBodies).toEqual([{ path: "v0Bets:get", format: "convex_encoded_json", args: [convexToJson(args)] }]);
    expect(result.nested.bytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result.nested.bytes)).toEqual(new Uint8Array(bytes));
    expect(result.nested.integer).toBe(args.nested.integer);
    expect(Number.isNaN(result.nested.notANumber)).toBe(true);
    expect(Object.is(result.nested.negativeZero, -0)).toBe(true);
    expect(f.calls.mock.calls[0][0].args).toEqual(args);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("QA-SERIALIZATION-02 accepts the exact binary bound and denies oversized encoded input/output", async () => {
    const f = plumbingFixture();
    const adapter = await f.create();
    disposals.push(adapter.dispose);
    const exact = new ArrayBuffer(MAX_BINARY_BYTES);
    const accepted = await adapter.handle(f.request("v0Bets:pick", { bytes: exact }, "/api/mutation"));
    expect(accepted.status).toBe(200);
    expect(jsonToConvex((await accepted.json()).value)).toEqual({ bytes: exact });
    expect((await adapter.handle(f.request("v0Bets:pick", { bytes: new ArrayBuffer(MAX_BINARY_BYTES + 1) }, "/api/mutation"))).status).toBe(413);
    const output = plumbingFixture(async () => new ArrayBuffer(MAX_BINARY_BYTES + 1));
    const oversized = await output.create();
    disposals.push(oversized.dispose);
    expect((await oversized.handle(output.request())).status).toBe(500);
  });

  it("QA-ERROR-01 propagates safe structured Convex UDF codes at HTTP 560 without private messages/logs", async () => {
    for (const data of [{ code: "AUTH_REQUIRED", message: "SYNTHETIC_PRIVATE", token: "SYNTHETIC_PRIVATE" }, JSON.stringify({ code: "POLICY_PENDING", message: "SYNTHETIC_PRIVATE" }), "FORBIDDEN", null]) {
      const f = plumbingFixture(async () => { throw new ConvexError(data); });
      const adapter = await f.create();
      disposals.push(adapter.dispose);
      const response = await adapter.handle(f.request());
      const text = await response.text();
      expect(response.status).toBe(560);
      expect(text).not.toContain("SYNTHETIC_PRIVATE");
      const parsed = JSON.parse(text);
      expect(parsed.status).toBe("error");
      expect(parsed.logLines).toEqual([]);
      expect(jsonToConvex(parsed.errorData)).toEqual({
        code: typeof data === "object" && data !== null ? "AUTH_REQUIRED" : data === null ? "UNKNOWN" : data === "FORBIDDEN" ? "FORBIDDEN" : "POLICY_PENDING",
        message: expect.any(String),
      });
    }
  });

  it("QA-ERROR-02 gives the official client a typed safe UDF error, not a proxy failure", async () => {
    const f = plumbingFixture(async () => { throw new ConvexError({ code: "POLICY_PENDING", message: "SYNTHETIC_PRIVATE" }); });
    const adapter = await f.create();
    disposals.push(adapter.dispose);
    const client = new ConvexHttpClient(f.manifest.apiOrigin, { logger: false, skipConvexDeploymentUrlCheck: true, fetch: async (input, init) => {
      const request = new Request(input, init);
      for (const [key, value] of f.request().headers) request.headers.set(key, value);
      return adapter.handle(request);
    } });
    await expect(client.query(makeFunctionReference<"query">("v0Bets:get"), {})).rejects.toMatchObject({ name: "ConvexError", data: { code: "POLICY_PENDING" } });
    const broken = plumbingFixture(async () => { throw new Error("SYNTHETIC_PRIVATE_STACK"); });
    const generic = await broken.create();
    disposals.push(generic.dispose);
    const result = await generic.handle(broken.request());
    expect(result.status).toBe(500);
    expect(await result.text()).not.toContain("SYNTHETIC_PRIVATE_STACK");
  });

  it("QA-LIFETIME-01 rejects expired runs before any later handler call", async () => {
    const f = plumbingFixture();
    let now = NOW;
    const adapter = await createQAAdapter({ ...f.options, now: () => now });
    disposals.push(adapter.dispose);
    now = f.manifest.expiresAt + 1;
    expect((await adapter.handle(f.request())).status).toBe(503);
    expect(f.calls).not.toHaveBeenCalled();
  });

  it("QA-HTTP-04 rejects deeply nested, ambiguous typed values and cancelled requests before dispatch", async () => {
    const f = plumbingFixture();
    const adapter = await f.create();
    disposals.push(adapter.dispose);
    let nested: unknown = "synthetic";
    for (let i = 0; i < 40; i++) nested = { nested };
    for (const args of [nested, { $bytes: "%%%" }, { $integer: "not-base64" }]) {
      const body = JSON.stringify({ path: "v0Bets:get", args: [args], format: "convex_encoded_json" });
      expect((await adapter.handle(f.request("v0Bets:get", {}, "/api/query", { body }))).status).toBe(400);
    }
    const controller = new AbortController();
    controller.abort();
    expect((await adapter.handle(f.request("v0Bets:get", {}, "/api/query", { signal: controller.signal }))).status).toBe(503);
    expect(f.calls).not.toHaveBeenCalled();
  });
});
