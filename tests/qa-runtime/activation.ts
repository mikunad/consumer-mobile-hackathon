import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { createQAAdapter } from "../qa-adapter/adapter";
import { allowedPath, type AllowedFunction } from "../qa-adapter/dispatcher";
import { verifyProvisioning, type ProvisioningVerifier } from "../qa-adapter/evidence";
import { AdapterBlocked, assertManifestLive, parseManifest, type ExpectedRun } from "../qa-adapter/manifest";
import { createLiveProvisioningController } from "../simulator-provisioner/controller";
import { bootOfficialBackend, type BootstrapDiagnostics, type FixtureCatalog } from "./bootstrap.mjs";
import { officialBackendBinding } from "./binding";
import { createBoundedCardRouting, SYNTHETIC_CARD_SOURCE_ORIGIN } from "./routing";

export type RuntimeBuildRecord = Readonly<{ sourceRevision: string; artifactPath: string; artifactSHA256: string; buildID: string }>;
export type RuntimeActivationOptions = Readonly<{
  root: string;
  directory: string;
  manifestBytes: Uint8Array;
  manifestSHA256: string;
  expected: ExpectedRun;
  nativeBuild: RuntimeBuildRecord;
  backendBuild: RuntimeBuildRecord;
  backendSourceSHA256: string;
  overlaySourceSHA256: string;
  entrySHA256: string;
  sourceCardOrigin: typeof SYNTHETIC_CARD_SOURCE_ORIGIN;
  allowlist: readonly AllowedFunction[];
  provisioning: Readonly<{ path: string; verify: ProvisioningVerifier }>;
  verifyIsolation: () => Promise<void>;
  path?: string;
}>;
export type ProvisionedRuntimeOptions = Omit<RuntimeActivationOptions, "provisioning" | "verifyIsolation"> & Readonly<{
  contextPath: string;
  receiptPath: string;
  expectedHarnessSources: Readonly<Record<string, string>>;
}>;

type Phase = "admission" | "pins" | "provisioning" | "backend" | "binding" | "attestation" | "routing" | "listen" | "live-verification" | "cleanup";
type StopReason = "caller" | "expired" | "isolation-failed" | "activation-failed";
type Cleanup = Readonly<{ privateStateRemoved: true; backendDiagnostics?: BootstrapDiagnostics }>;
export type RuntimeStopped = Readonly<{ reason: StopReason; cleanupComplete: boolean }>;

export class RuntimeActivationBlocked extends Error {
  constructor(readonly phase: Phase, readonly cleanupComplete: boolean) {
    super(`QA runtime BLOCKED during ${phase}; cleanup ${cleanupComplete ? "completed" : "unproven"}`);
    this.name = "RuntimeActivationBlocked";
  }
}

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const isSHA256 = (value: string) => /^[a-f0-9]{64}$/.test(value);

async function fileSHA256(path: string) {
  if (!isAbsolute(path) || await realpath(path) !== resolve(path)) throw new AdapterBlocked();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size <= 0 || before.size > 536_870_912) throw new AdapterBlocked();
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new AdapterBlocked();
    return hash.digest("hex");
  } finally { await file.close(); }
}

async function backendSourceSHA256(root: string) {
  const paths: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const info = await lstat(path);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) paths.push(path);
      else throw new AdapterBlocked();
    }
  };
  const directory = join(root, "convex");
  if (!(await lstat(directory)).isDirectory()) throw new AdapterBlocked();
  await walk(directory);
  const chunks: string[] = [];
  for (const path of paths.sort()) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { chunks.push(relative(root, path) + "\n" + await file.readFile("utf8")); }
    finally { await file.close(); }
  }
  if (!chunks.length) throw new AdapterBlocked();
  return digest(chunks.join("\n"));
}

export async function activateOfficialQARuntime(options: RuntimeActivationOptions) {
  let phase: Phase = "admission";
  let local: Awaited<ReturnType<typeof bootOfficialBackend>> | undefined;
  let adapter: Awaited<ReturnType<typeof createQAAdapter>> | undefined;
  let server: Awaited<ReturnType<NonNullable<typeof adapter>["listen"]>> | undefined;
  let expiry: AbortController | undefined;
  let closing: Promise<Cleanup> | undefined;
  let active = false;
  let directory: string | undefined;
  let settleStopped!: (value: RuntimeStopped) => void;
  const stopped = new Promise<RuntimeStopped>((accept) => { settleStopped = accept; });
  const shutdown = (reason: StopReason) => closing ??= (async () => {
    active = false;
    expiry?.abort();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => adapter?.dispose()),
      Promise.resolve().then(() => server?.close()),
      Promise.resolve().then(() => local?.close()),
    ]);
    let removed = true;
    if (directory) {
      try { await lstat(directory); removed = false; }
      catch (error) { removed = (error as NodeJS.ErrnoException).code === "ENOENT"; }
    }
    const cleanupComplete = removed && results.every((result) => result.status === "fulfilled");
    settleStopped(Object.freeze({ reason, cleanupComplete }));
    if (!cleanupComplete) throw new RuntimeActivationBlocked("cleanup", false);
    const backend = results[2];
    return Object.freeze({ privateStateRemoved: true as const, backendDiagnostics: backend.status === "fulfilled" ? backend.value : undefined });
  })();
  try {
    const raw = Buffer.from(options.manifestBytes);
    const expected = Object.freeze({ ...options.expected });
    const nativeBuild = Object.freeze({ ...options.nativeBuild });
    const backendBuild = Object.freeze({ ...options.backendBuild });
    const { root, manifestSHA256, backendSourceSHA256: sourcePin, overlaySourceSHA256, entrySHA256, sourceCardOrigin, verifyIsolation, path } = options;
    const provisioning = Object.freeze({ ...options.provisioning });
    const allowlist = Object.freeze(options.allowlist.map((entry) => Object.freeze({ ...entry })));
    if (typeof verifyIsolation !== "function" || typeof provisioning.verify !== "function" || !provisioning.path ||
        ![manifestSHA256, sourcePin, overlaySourceSHA256, entrySHA256, nativeBuild.artifactSHA256, backendBuild.artifactSHA256].every(isSHA256) ||
        sourceCardOrigin !== SYNTHETIC_CARD_SOURCE_ORIGIN || !allowlist.some((entry) => entry.path === "v0Runtime:attestation" && entry.kind === "query") ||
        !allowlist.some((entry) => entry.path !== "v0Runtime:attestation") || new Set(allowlist.map((entry) => entry.path)).size !== allowlist.length ||
        allowlist.some((entry) => !allowedPath(entry.path) || !["query", "mutation", "action"].includes(entry.kind)) ||
        Object.entries(process.env).some(([key, value]) => value && /(?:KEY|SECRET|TOKEN|PASSCODE|CONVEX.*(?:URL|DEPLOY)|TWILIO|APNS)/i.test(key))) throw new AdapterBlocked();
    if (digest(raw) !== manifestSHA256) throw new AdapterBlocked();
    const context = parseManifest(raw, expected);
    if (context.apiOrigin !== "http://127.0.0.1:8199" || context.cardOrigin !== "http://127.0.0.1:3211" ||
        nativeBuild.sourceRevision !== expected.nativeSourceRevision || backendBuild.sourceRevision !== expected.backendSourceRevision ||
        [nativeBuild, backendBuild].some((build) => !/^[A-Za-z0-9._:-]{1,128}$/.test(build.buildID))) throw new AdapterBlocked();
    if (!isAbsolute(root) || await realpath(root) !== root) throw new AdapterBlocked();
    const scratch = options.directory;
    try { await lstat(scratch); throw new AdapterBlocked(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    directory = scratch;
    const verifyLive = async () => {
      try {
        if (closing) throw new AdapterBlocked();
        assertManifestLive(context.manifest);
        await verifyIsolation();
        if (closing) throw new AdapterBlocked();
        assertManifestLive(context.manifest);
      } catch {
        if (active) void shutdown("isolation-failed").catch(() => undefined);
        throw new AdapterBlocked();
      }
    };
    const verifyPins = async () => {
      if (await fileSHA256(nativeBuild.artifactPath) !== nativeBuild.artifactSHA256 || await fileSHA256(backendBuild.artifactPath) !== backendBuild.artifactSHA256 ||
          await backendSourceSHA256(root) !== sourcePin || await fileSHA256(join(root, "tests/qa-runtime/routing.ts")) !== overlaySourceSHA256 ||
          await fileSHA256(fileURLToPath(import.meta.url)) !== entrySHA256) throw new AdapterBlocked();
    };
    phase = "pins";
    await verifyPins();
    phase = "provisioning";
    await verifyLive();
    const receipt = await verifyProvisioning({ ...provisioning, manifest: context, now: Date.now() });
    phase = "backend";
    local = await bootOfficialBackend({ root, directory: scratch, binary: backendBuild.artifactPath, expectedBinarySHA256: backendBuild.artifactSHA256,
      runID: context.manifest.runID, fixtureSetID: expected.fixtureSetID, backendRevision: backendBuild.sourceRevision, configVersion: expected.configVersion, verifyIsolation: verifyLive, path, processGroupMode: "supervised" });
    if (local.origin !== "http://127.0.0.1:3210") throw new AdapterBlocked();
    const overlay = createBoundedCardRouting({ context, sourceOrigin: sourceCardOrigin, overlaySourceSHA256 });
    let fixture: FixtureCatalog | undefined;
    phase = "binding";
    adapter = await createQAAdapter({ mode: "simulator-runtime", manifestBytes: raw, expected, requiredFunctions: allowlist, provisioning,
      initializeRun: officialBackendBinding({ backendOrigin: local.origin, allowlist, backendSourceRevision: backendBuild.sourceRevision, fixtureSetID: expected.fixtureSetID,
        verifyIsolation: verifyLive, routingOverlay: overlay, dispose: async () => {},
        seedFreshFixture: async (runID, set) => { fixture = await local!.seedFreshFixture(runID, set); },
      }),
    });
    if (!fixture || fixture.runID !== context.manifest.runID || fixture.fixtureSetID !== expected.fixtureSetID) throw new AdapterBlocked();
    phase = "attestation";
    const gateway = adapter;
    const client = new ConvexHttpClient(context.apiOrigin, { logger: false, skipConvexDeploymentUrlCheck: true, fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== context.apiOrigin + "/api/query") throw new AdapterBlocked();
      request.headers.set("host", new URL(context.apiOrigin).host);
      request.headers.set("x-calledit-qa-run-id", context.manifest.runID);
      request.headers.set("x-calledit-qa-manifest-sha256", context.sha256);
      return gateway.handle(request);
    } });
    const attestation = await client.query(makeFunctionReference<"query">("v0Runtime:attestation"), {});
    phase = "routing";
    const routing = await overlay.activate({ receiptPath: provisioning.path, verify: provisioning.verify, attestation });
    phase = "live-verification";
    await verifyPins();
    await verifyLive();
    phase = "listen";
    server = await adapter.listen();
    if (server.origin !== context.apiOrigin) throw new AdapterBlocked();
    phase = "live-verification";
    await verifyPins();
    await verifyLive();
    active = true;
    expiry = new AbortController();
    void delay(Math.max(0, context.manifest.expiresAt - Date.now()), undefined, { signal: expiry.signal, ref: false }).then(
      () => shutdown("expired"),
      () => closing ? undefined : shutdown("isolation-failed"),
    ).catch(() => undefined);
    return Object.freeze({
      apiOrigin: context.apiOrigin, cardOrigin: context.cardOrigin,
      fixture: Object.freeze({ ...fixture, actors: Object.freeze({ ...fixture.actors }), groups: Object.freeze([...fixture.groups]) }),
      provenance: Object.freeze({ version: 1, evidenceClass: "receipt-gated-synthetic-loopback-with-routing-overlay", manifestSHA256: context.sha256,
        nativeBuild, backendBuild, backendSourceSHA256: sourcePin, overlaySourceSHA256, entrySHA256, sourceCardOrigin, configVersion: expected.configVersion,
        provisioningVerificationID: receipt.verificationID, routing, qaAttestation: Object.freeze({ ...attestation }), processGroupMode: "supervised",
        nativeUIExecuted: false, realProviderExecuted: false, fullV0Ready: false }),
      stopped, close: () => shutdown("caller"),
    });
  } catch {
    let complete = false;
    try { await shutdown("activation-failed"); complete = true; } catch { }
    throw new RuntimeActivationBlocked(phase, complete);
  }
}

export async function activateProvisionedQARuntime(options: ProvisionedRuntimeOptions) {
  const { contextPath, receiptPath, expectedHarnessSources, ...runtimeOptions } = options;
  const expected = Object.freeze({ ...runtimeOptions.expected });
  const harnessSources = Object.freeze({ ...expectedHarnessSources });
  const expectedSourceCardOrigin = runtimeOptions.sourceCardOrigin;
  let controller: ReturnType<typeof createLiveProvisioningController>;
  try {
    controller = createLiveProvisioningController({ contextPath, expected, expectedHarnessSources: harnessSources, expectedSourceCardOrigin });
    if (typeof controller?.verify !== "function" || typeof controller?.assertLiveIsolation !== "function") throw new AdapterBlocked();
  } catch { throw new RuntimeActivationBlocked("admission", true); }
  const runtime = await activateOfficialQARuntime({ ...runtimeOptions, expected,
    provisioning: { path: receiptPath, verify: controller.verify }, verifyIsolation: controller.assertLiveIsolation,
  });
  return Object.freeze({ ...runtime, provenance: Object.freeze({ ...runtime.provenance,
    controller: Object.freeze({ contextPath, receiptPath, expectedHarnessSources: harnessSources, expectedSourceCardOrigin }),
  }) });
}
