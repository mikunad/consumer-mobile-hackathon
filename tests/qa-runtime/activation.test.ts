import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterOptions, createQAAdapter } from "../qa-adapter/adapter";
import type { BootstrapOptions, FixtureCatalog } from "./bootstrap.mjs";
import { activateOfficialQARuntime, activateProvisionedQARuntime, type RuntimeActivationOptions, type ProvisionedRuntimeOptions } from "./activation";
import { SYNTHETIC_CARD_SOURCE_ORIGIN } from "./routing";

const doubles = vi.hoisted(() => ({
  boot: vi.fn(), listen: vi.fn(), serverClose: vi.fn(), controller: vi.fn(), events: [] as string[], corruptGatewayAttestation: false,
  adapters: [] as { value: Awaited<ReturnType<typeof createQAAdapter>>; dispose: ReturnType<typeof vi.fn>; options: AdapterOptions }[],
}));
vi.mock("./bootstrap.mjs", () => ({ bootOfficialBackend: doubles.boot }));
vi.mock("../simulator-provisioner/controller", () => ({ createLiveProvisioningController: doubles.controller }));
vi.mock("node:timers/promises", () => ({ setTimeout: (...args: [number, unknown?, { signal?: AbortSignal; ref?: boolean }?]) => new Promise<void>((accept, reject) => {
  const signal = args[2]?.signal;
  const abort = () => { clearTimeout(timer); reject(new Error("UNIT aborted wait")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); accept(); }, args[0]);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
}) }));
vi.mock("../qa-adapter/adapter", async (original) => {
  const actual = await original<typeof import("../qa-adapter/adapter")>();
  return { ...actual, createQAAdapter: async (options: AdapterOptions) => {
    const value = await actual.createQAAdapter(options);
    const dispose = vi.fn(value.dispose);
    const handle = async (request: Request) => {
      doubles.events.push("gateway-attestation");
      const response = await value.handle(request);
      if (!doubles.corruptGatewayAttestation) return response;
      const body = await response.json();
      body.value.qaManifestSHA256 = "0".repeat(64);
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    };
    doubles.adapters.push({ value, dispose, options });
    return { ...value, dispose, handle, listen: doubles.listen };
  } };
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const folders: string[] = [];
const runtimes: Awaited<ReturnType<typeof activateOfficialQARuntime>>[] = [];

beforeEach(() => {
  doubles.boot.mockReset(); doubles.listen.mockReset(); doubles.serverClose.mockReset();
  doubles.controller.mockReset();
  doubles.adapters.length = 0; doubles.events.length = 0; doubles.corruptGatewayAttestation = false;
  doubles.serverClose.mockResolvedValue(undefined);
  doubles.listen.mockImplementation(async () => { doubles.events.push("listen"); return { origin: "http://127.0.0.1:8199", close: doubles.serverClose }; });
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  vi.useRealTimers();
});

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "qa-composition-unit-")); folders.push(folder);
  const nativePath = join(folder, "native-unit-artifact");
  const backendPath = join(folder, "backend-unit-artifact");
  await writeFile(nativePath, "UNIT FAKE NATIVE ARTIFACT, NOT AN APP");
  await writeFile(backendPath, "UNIT FAKE BACKEND ARTIFACT, NOT AN EXECUTABLE");
  const runID = randomUUID().toUpperCase();
  const manifest = { version: 1, runID, simulatorUDID: randomUUID().toUpperCase(), nativeSourceRevision: "a".repeat(40), backendSourceRevision: "b".repeat(40),
    deploymentID: "qa-" + runID, configVersion: "composition-unit", fixtureSetID: "synthetic-v0-subject-locked", apiOrigin: "http://127.0.0.1:8199", cardOrigin: "http://127.0.0.1:3211",
    issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60000, erasedSimulator: true, syntheticDataOnly: true, outboundNetworkDenied: true } as const;
  const raw = Buffer.from("  " + JSON.stringify(manifest) + "\n");
  const artifacts = [];
  for (const kind of ["simulator-created", "simulator-erased", "empty-state-verified", "outbound-denied"]) {
    const file = kind + ".txt";
    const bytes = Buffer.from("FABRICATED UNIT PROVENANCE ONLY, NO SIMULATOR/PF/EXCLUSIVITY EVIDENCE: " + kind);
    await writeFile(join(folder, file), bytes);
    artifacts.push({ kind, file, sha256: digest(bytes) });
  }
  const receiptPath = join(folder, "receipt.json");
  await writeFile(receiptPath, JSON.stringify({ version: 1, runID, simulatorUDID: manifest.simulatorUDID, nativeSourceRevision: manifest.nativeSourceRevision,
    backendSourceRevision: manifest.backendSourceRevision, fixtureSetID: manifest.fixtureSetID, hostBundleID: "com.mikunad.calledit.qa.host", extensionBundleID: "com.mikunad.calledit.qa.host.messages",
    manifestSHA256: digest(raw), recordedAt: Date.now(), artifacts }));
  const sourcePaths = async (directory: string): Promise<string[]> => {
    const paths: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(...await sourcePaths(join(directory, entry.name)));
      else paths.push(join(directory, entry.name));
    }
    return paths.sort();
  };
  const chunks = [];
  for (const path of await sourcePaths(join(root, "convex"))) chunks.push(path.slice(root.length + 1) + "\n" + await readFile(path, "utf8"));
  const verify = vi.fn(async () => ({ approved: true as const, verificationID: "UNIT-FAKE-NO-RUNTIME-EVIDENCE" }));
  const verifyIsolation = vi.fn(async () => {});
  const options: RuntimeActivationOptions = {
    root, directory: join(folder, "private"), manifestBytes: raw, manifestSHA256: digest(raw), expected: { ...manifest },
    nativeBuild: { sourceRevision: manifest.nativeSourceRevision, artifactPath: nativePath, artifactSHA256: digest(await readFile(nativePath)), buildID: "UNIT-FAKE-NATIVE" },
    backendBuild: { sourceRevision: manifest.backendSourceRevision, artifactPath: backendPath, artifactSHA256: digest(await readFile(backendPath)), buildID: "UNIT-FAKE-BACKEND" },
    backendSourceSHA256: digest(chunks.join("\n")), overlaySourceSHA256: digest(await readFile(join(root, "tests/qa-runtime/routing.ts"))),
    entrySHA256: digest(await readFile(join(root, "tests/qa-runtime/activation.ts"))), sourceCardOrigin: SYNTHETIC_CARD_SOURCE_ORIGIN,
    allowlist: [{ path: "v0Runtime:attestation", kind: "query" }, { path: "v0Bets:get", kind: "query" }], provisioning: { path: receiptPath, verify }, verifyIsolation,
  };
  const catalog: FixtureCatalog = { runID, fixtureSetID: manifest.fixtureSetID, actors: { creator: "unit-creator", friend: "unit-friend", outsider: "unit-outsider", subject: "unit-subject" },
    groups: ["unit-g1", "unit-g2"], betId: "unit-bet", locator: "c".repeat(64), unavailableBetId: "unit-unavailable", unavailableLocator: "d".repeat(64) };
  const backendAttestation = { app: "called-it", contractVersion: "v0.2", schemaVersion: "v0.2", environment: "local", sourceSha: manifest.backendSourceRevision,
    deploymentId: manifest.deploymentID, configVersion: manifest.configVersion as string, testAdapters: false };
  const local = {
    origin: "http://127.0.0.1:3210" as const,
    seedFreshFixture: vi.fn(async () => { doubles.events.push("seed"); return catalog; }),
    inspectFixture: vi.fn(), markSensitive: vi.fn(), redact: (value: unknown) => String(value),
    provider: { stats: { connects: 0, deniedConnects: 0, starts: 0, checks: 0, invalidCodes: 0, tlsErrors: [], unexpectedRequests: 0 }, proxyOrigin: "http://127.0.0.1:43128", caSHA256: "e".repeat(64), caPath: join(folder, "UNIT-NO-REAL-CA"), trustFixtureCertificate: vi.fn() },
    close: vi.fn(async () => { await rm(options.directory, { recursive: true, force: true }); return { backendLog: "UNIT MOCK ONLY", cliLogs: [] }; }),
  };
  doubles.boot.mockImplementation(async (input: BootstrapOptions) => {
    doubles.events.push("boot"); await input.verifyIsolation(); await mkdir(input.directory); return local;
  });
  const fetchBackend = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe(local.origin);
    expect(request.headers.has("authorization")).toBe(false);
    const envelope = await request.json();
    if (envelope.path === "v0Runtime:attestation") {
      doubles.events.push("backend-attestation");
      return new Response(JSON.stringify({ status: "success", value: backendAttestation, logLines: [] }), { headers: { "content-type": "application/json" } });
    }
    if (envelope.path !== "v0Bets:get") throw new Error("Unexpected unit backend request");
    return new Response(JSON.stringify({ status: "success", value: { view: "sealed", canVeto: true, card: { url: `${SYNTHETIC_CARD_SOURCE_ORIGIN}/c/${catalog.locator}`, caption: "Neutral unit caption" } }, logLines: [] }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchBackend);
  const requestBet = () => doubles.adapters[0].value.handle(new Request(manifest.apiOrigin + "/api/query", { method: "POST", headers: {
    host: "127.0.0.1:8199", "content-type": "application/json", "x-calledit-qa-run-id": runID, "x-calledit-qa-manifest-sha256": options.manifestSHA256,
  }, body: JSON.stringify({ path: "v0Bets:get", format: "convex_encoded_json", args: [{}] }) }));
  return { options, local, raw, manifest, verify, verifyIsolation, fetchBackend, backendAttestation, requestBet };
}

async function start(options: RuntimeActivationOptions) {
  const runtime = await activateOfficialQARuntime(options); runtimes.push(runtime); return runtime;
}

describe("portable composition units: fabricated provenance and backend, no runtime/native/PF/exclusivity evidence", () => {
  it("QA-COMPOSE-01 preserves exact bytes, gates routing before listen, and closes once", async () => {
    const f = await fixture();
    const runtime = await start(f.options);
    expect(doubles.adapters[0].options.mode).toBe("simulator-runtime");
    expect(doubles.boot.mock.calls[0][0].processGroupMode).toBe("supervised");
    expect(Buffer.from(doubles.adapters[0].options.manifestBytes)).toEqual(f.raw);
    expect(runtime.provenance.manifestSHA256).toBe(digest(f.raw));
    expect(runtime.provenance.routing.overlaySourceSHA256).toBe(f.options.overlaySourceSHA256);
    expect(runtime.provenance.nativeBuild).toEqual(f.options.nativeBuild);
    expect(runtime.provenance.backendBuild).toEqual(f.options.backendBuild);
    expect(runtime.provenance.qaAttestation).toMatchObject({ testAdapters: true, qaRunID: f.manifest.runID, qaManifestSHA256: digest(f.raw) });
    expect(runtime.provenance).toMatchObject({ nativeUIExecuted: false, realProviderExecuted: false, fullV0Ready: false });
    expect(doubles.events).toEqual(["boot", "backend-attestation", "seed", "gateway-attestation", "listen"]);
    expect(f.verify).toHaveBeenCalledTimes(3);
    const response = await f.requestBet();
    expect(response.status).toBe(200);
    expect((await response.json()).value).toEqual({ view: "sealed", canVeto: true, card: { url: `http://127.0.0.1:3211/c/${"c".repeat(64)}`, caption: "Neutral unit caption" } });
    const first = runtime.close(); expect(runtime.close()).toBe(first); await first;
    expect(await runtime.stopped).toEqual({ reason: "caller", cleanupComplete: true });
    expect(doubles.serverClose).toHaveBeenCalledTimes(1); expect(f.local.close).toHaveBeenCalledTimes(1);
    await expect(stat(f.options.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["verifier", "isolation", "raw-hash", "build-source", "source-origin"])("QA-COMPOSE-02 rejects missing/mismatched %s before backend startup", async (kind) => {
    const f = await fixture();
    let options = f.options;
    if (kind === "verifier") options = { ...options, provisioning: { ...options.provisioning, verify: undefined } } as unknown as RuntimeActivationOptions;
    if (kind === "isolation") options = { ...options, verifyIsolation: undefined } as unknown as RuntimeActivationOptions;
    if (kind === "raw-hash") options = { ...options, manifestSHA256: "0".repeat(64) };
    if (kind === "build-source") options = { ...options, nativeBuild: { ...options.nativeBuild, sourceRevision: "c".repeat(40) } };
    if (kind === "source-origin") options = { ...options, sourceCardOrigin: "https://unapproved.invalid" } as unknown as RuntimeActivationOptions;
    await expect(activateOfficialQARuntime(options)).rejects.toMatchObject({ phase: "admission", cleanupComplete: true });
    expect(doubles.boot).not.toHaveBeenCalled(); expect(doubles.listen).not.toHaveBeenCalled();
  });

  it.each(["native", "backend", "source", "overlay", "entry", "symlink"])("QA-COMPOSE-03 rejects the wrong %s byte pin before startup", async (kind) => {
    const f = await fixture();
    let options = f.options;
    if (kind === "native") options = { ...options, nativeBuild: { ...options.nativeBuild, artifactSHA256: "0".repeat(64) } };
    if (kind === "backend") options = { ...options, backendBuild: { ...options.backendBuild, artifactSHA256: "0".repeat(64) } };
    if (kind === "source") options = { ...options, backendSourceSHA256: "0".repeat(64) };
    if (kind === "overlay") options = { ...options, overlaySourceSHA256: "0".repeat(64) };
    if (kind === "entry") options = { ...options, entrySHA256: "0".repeat(64) };
    if (kind === "symlink") {
      const path = f.options.nativeBuild.artifactPath + "-symlink"; await symlink(f.options.nativeBuild.artifactPath, path);
      options = { ...options, nativeBuild: { ...options.nativeBuild, artifactPath: path } };
    }
    await expect(activateOfficialQARuntime(options)).rejects.toMatchObject({ phase: "pins", cleanupComplete: true });
    expect(doubles.boot).not.toHaveBeenCalled();
  });

  it("QA-COMPOSE-04 requires trusted provenance approval, not receipt booleans", async () => {
    const f = await fixture(); f.verify.mockRejectedValue(new Error("UNIT: exclusivity/PF provenance unproved"));
    await expect(activateOfficialQARuntime(f.options)).rejects.toMatchObject({ phase: "provisioning", cleanupComplete: true });
    expect(doubles.boot).not.toHaveBeenCalled();
  });

  it("QA-COMPOSE-05 closes the private backend on independent real-attestation mismatch", async () => {
    const f = await fixture(); f.backendAttestation.configVersion = "UNIT-WRONG-CONFIG";
    await expect(activateOfficialQARuntime(f.options)).rejects.toMatchObject({ phase: "binding", cleanupComplete: true });
    expect(f.local.seedFreshFixture).not.toHaveBeenCalled(); expect(doubles.listen).not.toHaveBeenCalled(); expect(f.local.close).toHaveBeenCalledTimes(1);
  });

  it("QA-COMPOSE-06 rejects a wrong gateway raw hash and closes everything without listening", async () => {
    const f = await fixture(); doubles.corruptGatewayAttestation = true;
    await expect(activateOfficialQARuntime(f.options)).rejects.toMatchObject({ phase: "routing", cleanupComplete: true });
    expect(doubles.adapters[0].dispose).toHaveBeenCalledTimes(1); expect(f.local.close).toHaveBeenCalledTimes(1); expect(doubles.listen).not.toHaveBeenCalled();
  });

  it("QA-COMPOSE-07 rechecks the trusted verifier when routing activates", async () => {
    const f = await fixture();
    f.verify.mockReset().mockResolvedValueOnce({ approved: true, verificationID: "UNIT-FAKE-NO-RUNTIME-EVIDENCE" })
      .mockResolvedValueOnce({ approved: true, verificationID: "UNIT-FAKE-NO-RUNTIME-EVIDENCE" }).mockRejectedValueOnce(new Error("UNIT lease no longer valid"));
    await expect(activateOfficialQARuntime(f.options)).rejects.toMatchObject({ phase: "routing", cleanupComplete: true });
    expect(f.local.close).toHaveBeenCalledTimes(1); expect(doubles.listen).not.toHaveBeenCalled();
  });

  it("QA-COMPOSE-08 closes backend/adapter if listen fails", async () => {
    const f = await fixture(); doubles.listen.mockRejectedValue(new Error("UNIT EADDRINUSE"));
    await expect(activateOfficialQARuntime(f.options)).rejects.toMatchObject({ phase: "listen", cleanupComplete: true });
    expect(doubles.adapters[0].dispose).toHaveBeenCalledTimes(1); expect(f.local.close).toHaveBeenCalledTimes(1);
  });

  it.each(["isolation", "artifact"])("QA-COMPOSE-09 closes the opened listener after post-listen %s drift", async (kind) => {
    const f = await fixture();
    if (kind === "isolation") f.verifyIsolation.mockImplementation(async () => { if (doubles.listen.mock.calls.length) throw new Error("UNIT lost isolation"); });
    else doubles.listen.mockImplementation(async () => { await writeFile(f.options.nativeBuild.artifactPath, "UNIT ARTIFACT CHANGED"); return { origin: f.manifest.apiOrigin, close: doubles.serverClose }; });
    await expect(activateOfficialQARuntime(f.options)).rejects.toMatchObject({ phase: "live-verification", cleanupComplete: true });
    expect(doubles.serverClose).toHaveBeenCalledTimes(1); expect(doubles.adapters[0].dispose).toHaveBeenCalledTimes(1); expect(f.local.close).toHaveBeenCalledTimes(1);
  });

  it.each(["adapter", "server", "backend", "adapter-sync", "server-sync", "backend-sync"])("QA-COMPOSE-10 attempts every cleanup when %s cleanup fails", async (kind) => {
    const f = await fixture();
    f.verifyIsolation.mockImplementation(async () => { if (doubles.listen.mock.calls.length) throw new Error("UNIT lost isolation"); });
    if (kind === "backend") f.local.close.mockRejectedValue(new Error("UNIT cleanup failure must not escape diagnostics"));
    if (kind === "backend-sync") f.local.close.mockImplementation(() => { throw new Error("UNIT synchronous cleanup failed"); });
    if (kind === "server") doubles.serverClose.mockRejectedValue(new Error("UNIT server cleanup failed"));
    if (kind === "server-sync") doubles.serverClose.mockImplementation(() => { throw new Error("UNIT synchronous cleanup failed"); });
    if (kind === "adapter" || kind === "adapter-sync") doubles.listen.mockImplementation(async () => {
      if (kind === "adapter-sync") doubles.adapters[0].dispose.mockImplementation(() => { throw new Error("UNIT synchronous cleanup failed"); });
      else doubles.adapters[0].dispose.mockRejectedValue(new Error("UNIT adapter cleanup failed"));
      return { origin: f.manifest.apiOrigin, close: doubles.serverClose };
    });
    await expect(activateOfficialQARuntime(f.options)).rejects.toMatchObject({ name: "RuntimeActivationBlocked", phase: "live-verification", cleanupComplete: false });
    expect(doubles.serverClose).toHaveBeenCalledTimes(1); expect(doubles.adapters[0].dispose).toHaveBeenCalledTimes(1); expect(f.local.close).toHaveBeenCalledTimes(1);
  });

  it("QA-COMPOSE-11 denies business dispatch and begins full shutdown if live isolation is lost", async () => {
    const f = await fixture(); const runtime = await start(f.options);
    const calls = f.fetchBackend.mock.calls.length;
    f.verifyIsolation.mockRejectedValue(new Error("UNIT lost exclusive lease"));
    expect((await f.requestBet()).status).toBe(503);
    expect(await runtime.stopped).toEqual({ reason: "isolation-failed", cleanupComplete: true });
    expect(f.fetchBackend).toHaveBeenCalledTimes(calls); expect(doubles.serverClose).toHaveBeenCalledTimes(1); expect(f.local.close).toHaveBeenCalledTimes(1);
  });

  it("QA-COMPOSE-12 closes resources at manifest expiry without granting a clock override", async () => {
    vi.useFakeTimers();
    const f = await fixture(); const runtime = await start(f.options);
    await vi.advanceTimersByTimeAsync(60001);
    expect(await runtime.stopped).toEqual({ reason: "expired", cleanupComplete: true });
    expect(doubles.serverClose).toHaveBeenCalledTimes(1); expect(f.local.close).toHaveBeenCalledTimes(1);
  });

  it("QA-COMPOSE-13 does not expose privileged handles or mutate caller-owned manifest bytes", async () => {
    const f = await fixture(); const original = Buffer.from(f.raw);
    f.verifyIsolation.mockImplementation(async () => { f.raw.fill(0); });
    const runtime = await start(f.options);
    expect(Buffer.from(doubles.adapters[0].options.manifestBytes)).toEqual(original);
    expect(Object.keys(runtime).sort()).toEqual(["apiOrigin", "cardOrigin", "close", "fixture", "provenance", "stopped"]);
    expect("seedFreshFixture" in runtime).toBe(false); expect("provider" in runtime).toBe(false); expect("admin" in runtime).toBe(false);
  });

  it("QA-COMPOSE-14 leaves an existing directory untouched and never treats it as owned", async () => {
    const f = await fixture(); await mkdir(f.options.directory);
    const path = join(f.options.directory, "unowned.txt"); await writeFile(path, "UNIT UNOWNED DATA");
    await expect(activateOfficialQARuntime(f.options)).rejects.toMatchObject({ phase: "admission", cleanupComplete: true });
    expect(await readFile(path, "utf8")).toBe("UNIT UNOWNED DATA"); expect(doubles.boot).not.toHaveBeenCalled();
  });

  it("QA-COMPOSE-15 never listens when bootstrap rejects and cleans its private resources", async () => {
    const f = await fixture(); doubles.boot.mockRejectedValue(new Error("UNIT bootstrap rejected after its own cleanup"));
    await expect(activateOfficialQARuntime(f.options)).rejects.toMatchObject({ phase: "backend", cleanupComplete: true });
    expect(doubles.listen).not.toHaveBeenCalled(); expect(doubles.adapters).toHaveLength(0);
  });

  it("QA-COMPOSE-16 accepts fresh trusted verification IDs without assuming controller internals", async () => {
    const f = await fixture();
    f.verify.mockResolvedValueOnce({ approved: true, verificationID: "UNIT-FAKE-INITIAL" })
      .mockResolvedValueOnce({ approved: true, verificationID: "UNIT-FAKE-ADAPTER" })
      .mockResolvedValueOnce({ approved: true, verificationID: "UNIT-FAKE-ROUTING" });
    const runtime = await start(f.options);
    expect(runtime.provenance.provisioningVerificationID).toBe("UNIT-FAKE-INITIAL");
    expect(runtime.provenance.routing.verificationID).toBe("UNIT-FAKE-ROUTING");
  });

  it("QA-COMPOSE-17 wires the actual controller interface and separately records its pinned origin/sources", async () => {
    const f = await fixture();
    const { provisioning, verifyIsolation, ...options } = f.options;
    const contextPath = join(dirname(provisioning.path), "UNIT-context.json");
    const expectedHarnessSources = Object.fromEntries(["status.py", "lease.py", "launch_provenance.py", "provision.py", "job.py", "global_pf.py", "netprobe.py", "drive.py"].map((name) => [name, "e".repeat(64)]));
    doubles.controller.mockReturnValue({ verify: provisioning.verify, assertLiveIsolation: verifyIsolation });
    const runtime = await activateProvisionedQARuntime({ ...options, contextPath, receiptPath: provisioning.path, expectedHarnessSources }); runtimes.push(runtime);
    expect(doubles.controller).toHaveBeenCalledTimes(1);
    expect(doubles.controller.mock.calls[0][0]).toEqual({ contextPath, expected: options.expected, expectedHarnessSources, expectedSourceCardOrigin: SYNTHETIC_CARD_SOURCE_ORIGIN });
    expect(Object.isFrozen(doubles.controller.mock.calls[0][0].expectedHarnessSources)).toBe(true);
    expectedHarnessSources["status.py"] = "f".repeat(64);
    expect(runtime.provenance.controller).toEqual({ contextPath, receiptPath: provisioning.path,
      expectedHarnessSources: { ...expectedHarnessSources, "status.py": "e".repeat(64) }, expectedSourceCardOrigin: SYNTHETIC_CARD_SOURCE_ORIGIN });
    expect(f.verify).toHaveBeenCalledTimes(3); expect(f.verifyIsolation).toHaveBeenCalled();
    expect("verify" in runtime).toBe(false); expect("assertLiveIsolation" in runtime).toBe(false);
  });

  it("QA-COMPOSE-18 refuses controller-construction failure without a fallback or private startup", async () => {
    const f = await fixture();
    doubles.controller.mockImplementation(() => { throw new Error("UNIT controller provenance unavailable"); });
    const { provisioning, ...options } = f.options;
    await expect(activateProvisionedQARuntime({ ...options, contextPath: join(dirname(provisioning.path), "UNIT-context.json"), receiptPath: provisioning.path,
      expectedHarnessSources: { "status.py": "e".repeat(64) },
    } as ProvisionedRuntimeOptions)).rejects.toMatchObject({ phase: "admission", cleanupComplete: true });
    expect(doubles.boot).not.toHaveBeenCalled(); expect(doubles.listen).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
  });

  it("QA-COMPOSE-19 refuses an incompatible controller interface instead of using caller hooks", async () => {
    const f = await fixture();
    doubles.controller.mockReturnValue({ verify: undefined, assertLiveIsolation: undefined });
    await expect(activateProvisionedQARuntime({ ...f.options, contextPath: join(dirname(f.options.provisioning.path), "UNIT-context.json"),
      receiptPath: f.options.provisioning.path, expectedHarnessSources: {},
    } as ProvisionedRuntimeOptions)).rejects.toMatchObject({ phase: "admission", cleanupComplete: true });
    expect(doubles.boot).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled(); expect(f.verifyIsolation).not.toHaveBeenCalled();
  });
});
