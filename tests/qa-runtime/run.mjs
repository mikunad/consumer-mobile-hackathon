import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { actors } from "./tls-provider.mjs";
import { fixtureSets } from "./catalog.mjs";
import { bootOfficialBackend } from "./bootstrap.mjs";
import { confirmationSourceRoot } from "./confirmation-fixture.mjs";
import { confirmationScenarios } from "./confirmation-scenarios.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const option = (name) => argv[argv.indexOf(name) + 1];
const binaryPins = JSON.parse(readFileSync(resolve(root, "tests/qa-runtime/binary-pins.json"), "utf8"));
const binarySHA256 = binaryPins.platforms["linux-x64"].executableSHA256;
const backendRevision = "7450eed9f957261ab4bcd19cf19cb42506823c32";
const nativeRevision = "00e5cf219c0d4329d806867f4dcf6aaec54a986d";
const digest = (value) => createHash("sha256").update(value).digest("hex");
if (!argv.includes("--binary") || !argv.includes("--output")) throw new Error("Require hash-pinned --binary and fresh external --output");
const binary = resolve(option("--binary"));
const output = resolve(option("--output"));
const fixtureSetID = argv.includes("--fixture-set") ? option("--fixture-set") : fixtureSets[0];
assert.ok(fixtureSets.includes(fixtureSetID));
assert.equal(digest(readFileSync(binary)), binarySHA256);
if (output === root || output.startsWith(`${root}/`) || existsSync(output)) throw new Error("Output must be new and outside the repository");
if (!argv.includes("--namespace-worker")) {
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "test", CI: "1", QA_RUNTIME_ISOLATED: "loopback-namespace-v1" };
  const result = spawnSync("unshare", ["--user", "--map-root-user", "--net", process.execPath, fileURLToPath(import.meta.url), ...argv, "--namespace-worker"], { cwd: root, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

process.umask(0o077);
assert.equal(process.env.QA_RUNTIME_ISOLATED, "loopback-namespace-v1");
assert.deepEqual(Object.keys(process.env).filter((key) => /KEY|SECRET|TOKEN|PASSCODE|CONVEX|PROXY|CERT/i.test(key)), []);
execFileSync("ip", ["link", "set", "lo", "up"]);
assert.equal(execFileSync("ip", ["route", "show", "default"], { encoding: "utf8" }).trim(), "");
assert.equal(execFileSync("ip", ["-6", "route", "show", "default"], { encoding: "utf8" }).trim(), "");
const interfaces = JSON.parse(execFileSync("ip", ["-json", "link", "show"], { encoding: "utf8" }));
assert.deepEqual(interfaces.map((item) => item.ifname), ["lo"]);
mkdirSync(output, { mode: 0o700 });
const state = mkdtempSync(resolve(dirname(output), "qr-"));
assert.ok(Buffer.byteLength(state) + 45 < 104, "Scratch root is too long for the backend executor's Unix socket");
const runID = randomUUID().toUpperCase();
const backendOrigin = "http://127.0.0.1:3210";
const gatewayOrigin = "http://127.0.0.1:8199";
const cardOrigin = "http://127.0.0.1:3211";
const sourcePaths = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sourcePaths(resolve(directory, entry.name)) : [resolve(directory, entry.name)]).sort();
const sourceDigest = (sourceRoot = root) => digest(sourcePaths(resolve(sourceRoot, "convex")).map((path) => path.slice(sourceRoot.length + 1) + "\n" + readFileSync(path, "utf8")).join("\n"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const pinnedSourcePaths = git("ls-tree", "-r", "--name-only", backendRevision, "--", "convex").split("\n").filter(Boolean).sort();
assert.deepEqual(sourcePaths(resolve(root, "convex")).map((path) => path.slice(root.length + 1)), pinnedSourcePaths);
for (const path of pinnedSourcePaths) assert.equal(readFileSync(resolve(root, path), "utf8"), execFileSync("git", ["show", `${backendRevision}:${path}`], { cwd: root, encoding: "utf8" }), `Canonical backend bytes differ from ${backendRevision}:${path}`);
const before = sourceDigest();
const sourceRoot = confirmationSourceRoot(root, state);
assert.equal(sourceDigest(sourceRoot), before);
const executedHarnessPaths = ["tests/qa-runtime/run.mjs", "tests/qa-runtime/bootstrap.mjs", "tests/qa-runtime/binary-pins.json", "tests/qa-runtime/catalog.mjs", "tests/qa-runtime/tls-provider.mjs", "tests/qa-runtime/fixture.ts.txt", "tests/qa-runtime/confirmation-fixture.mjs", "tests/qa-runtime/confirmation-scenarios.mjs", "tests/qa-runtime/binding.ts", "tests/qa-runtime/routing.ts", "tests/qa-adapter/adapter.ts", "tests/qa-adapter/dispatcher.ts", "tests/qa-adapter/manifest.ts", "tests/qa-adapter/evidence.ts"];
const harnessHashes = Object.fromEntries(executedHarnessPaths.map((path) => [path, digest(readFileSync(resolve(root, path)))]));
const privateValues = new Set();
let local;
const redact = (input) => { let text = String(input); for (const value of privateValues) text = text.replaceAll(value, "[local credential redacted]"); return local ? local.redact(text) : text; };
const checks = [];
const metadata = {
  version: 1, runID, fixtureSetID, nativeRevision, backendRevision, candidateSha: git("rev-parse", "HEAD"), sourcePinBasis: "backend owner commit files checked against canonical bytes; native revision is owner-supplied, not executed",
  backendSourceDigest: before, binarySHA256, backendVersion: binaryPins.release, sdkVersion: JSON.parse(readFileSync(resolve(root, "node_modules/convex/package.json"), "utf8")).version,
  target: "real OSS backend and CA-verified local provider TRANSPORT in egress-denied Linux namespace",
  nativeUIExecuted: false, simulatorProvisioned: false, nativeTransportCredit: false, realProviderExecuted: false, fullV0Ready: false,
  sourceOverlays: ["scratch-only internal qaRuntimeControl.ts with seven additional synthetic confirmation bets", "scratch-only empty crons.ts"], cardOriginRewritten: false,
  fixtureOverlaySHA256: digest(readFileSync(resolve(sourceRoot, "tests/qa-runtime/fixture.ts.txt"))),
  startedAt: new Date().toISOString(), status: "blocked", assertions: checks,
};
const check = async (id, operation) => {
  const start = performance.now();
  try { await operation(); checks.push({ id, status: "passing", durationMs: performance.now() - start }); }
  catch (error) { checks.push({ id, status: "failing", error: redact(error.stack ?? error) }); throw error; }
};
const localFetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(new URL(request.url).origin, backendOrigin);
  return fetch(request, { redirect: "error", signal: AbortSignal.timeout(15000) });
};
let transport;
let adapter;
let bootstrapFailure;
try {
  const verifyIsolation = async () => {
    assert.equal(execFileSync("ip", ["route", "show", "default"], { encoding: "utf8" }).trim(), "");
    assert.equal(execFileSync("ip", ["-6", "route", "show", "default"], { encoding: "utf8" }).trim(), "");
    assert.deepEqual(JSON.parse(execFileSync("ip", ["-json", "link", "show"], { encoding: "utf8" })).map((item) => item.ifname), ["lo"]);
  };
  local = await bootOfficialBackend({ root: sourceRoot, directory: state + "b", binary, expectedBinarySHA256: binarySHA256, runID, fixtureSetID, backendRevision, configVersion: "qa-transport-v0", verifyIsolation, rejectFirstCertificate: true, processGroupMode: "independent" });
  symlinkSync(resolve(root, "node_modules"), resolve(state, "node_modules"), "dir");
  transport = local.provider;
  metadata.providerTransport = { kind: "strict localhost CONNECT plus verified verify.twilio.com TLS fixture", proxyOrigin: transport.proxyOrigin, caSHA256: transport.caSHA256, stats: transport.stats };
  const bundle = resolve(state, "binding.mjs");
  await build({ stdin: { contents: `export {officialBackendBinding} from ${JSON.stringify(resolve(root, "tests/qa-runtime/binding.ts"))};export {createQAAdapter} from ${JSON.stringify(resolve(root, "tests/qa-adapter/adapter.ts"))};`, resolveDir: root }, outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  const { officialBackendBinding, createQAAdapter } = await import(pathToFileURL(bundle).href);
  const now = Date.now();
  const manifest = { version: 1, runID, simulatorUDID: "00000000-0000-4000-8000-000000000000", nativeSourceRevision: nativeRevision, backendSourceRevision: backendRevision, deploymentID: "qa-" + runID, configVersion: "qa-transport-v0", fixtureSetID, apiOrigin: gatewayOrigin, cardOrigin, issuedAt: now, expiresAt: now + 3600000, erasedSimulator: true, syntheticDataOnly: true, outboundNetworkDenied: true };
  const raw = Buffer.from(JSON.stringify(manifest));
  metadata.manifestSHA256 = digest(raw);
  metadata.manifestKind = "plumbing-unit contract input only; placeholder simulator, NOT native launch activation";
  let fixture;
  const policies = JSON.parse(readFileSync(resolve(root, "tests/coverage/v0-public-policies.json"), "utf8"));
  const allowlist = [{ path: "v0Runtime:attestation", kind: "query" }, ...Object.entries(policies).map(([path, policy]) => ({ path, kind: policy.kind }))];
  adapter = await createQAAdapter({ mode: "plumbing-unit", manifestBytes: raw, expected: manifest, requiredFunctions: allowlist,
    initializeRun: officialBackendBinding({ backendOrigin, allowlist, backendSourceRevision: backendRevision, fixtureSetID, verifyIsolation, seedFreshFixture: async (id, set) => { fixture = await local.seedFreshFixture(id, set); }, dispose: async () => {} }),
  });
  const client = new ConvexHttpClient(gatewayOrigin, { logger: false, skipConvexDeploymentUrlCheck: true, fetch: async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, gatewayOrigin);
    request.headers.set("host", new URL(gatewayOrigin).host);
    request.headers.set("x-calledit-qa-run-id", runID);
    request.headers.set("x-calledit-qa-manifest-sha256", metadata.manifestSHA256);
    return adapter.handle(request);
  } });
  const action = (path, args) => client.action(makeFunctionReference(path), args);
  const query = (path, args) => client.query(makeFunctionReference(path), args);

  await check("QA-RUNTIME.independent-source-config-fixture-pins", async () => {
    const direct = new ConvexHttpClient(backendOrigin, { logger: false, skipConvexDeploymentUrlCheck: true, fetch: localFetch });
    const backend = await direct.query(makeFunctionReference("v0Runtime:attestation"), {});
    const expected = { app: "called-it", contractVersion: "v0.2", schemaVersion: "v0.2", environment: "local", sourceSha: backendRevision, deploymentId: "qa-" + runID, configVersion: "qa-transport-v0", testAdapters: false };
    assert.deepEqual(backend, expected);
    assert.deepEqual(await query("v0Runtime:attestation", {}), { ...expected, testAdapters: true, qaRunID: runID, qaManifestSHA256: metadata.manifestSHA256 });
    assert.equal(manifest.nativeSourceRevision, nativeRevision);
    assert.equal(manifest.backendSourceRevision, backend.sourceSha);
    assert.equal(manifest.configVersion, backend.configVersion);
    assert.equal(manifest.deploymentID, backend.deploymentId);
    assert.equal(fixture.runID, manifest.runID);
    assert.equal(fixture.fixtureSetID, manifest.fixtureSetID);
    assert.deepEqual(Object.keys(fixture.actors).sort(), Object.keys(actors).sort());
    assert.equal(new Set(Object.values(fixture.actors)).size, 4);
    assert.equal(new Set(fixture.groups).size, 2);
    assert.equal(fixture.locator, digest(`${runID}:bet-a`));
    assert.equal(fixture.unavailableLocator, digest(`${runID}:unavailable`));
    assert.deepEqual(await local.inspectFixture(), { accounts: 4, sessions: 0, memberships: 6, bets: 9, picks: 0, ledger: 0 });
    assert.deepEqual(Object.keys(fixture.confirmationScenarios).sort(), ["blockReplay", "memberReplay", "newRequestSamePayload", "revealAdmission", "sameRequestDifferentPayload", "sameRequestSamePayload", "voidReplay"]);
    metadata.independentBackendAttestation = backend;
    metadata.fixtureIdentity = { runID: fixture.runID, fixtureSetID: fixture.fixtureSetID, roles: Object.keys(fixture.actors).sort(), independentGroupCount: fixture.groups.length };
  });
  await check("QA-RUNTIME.internal-control-not-public", async () => {
    const unprivileged = new ConvexHttpClient(backendOrigin, { logger: false, skipConvexDeploymentUrlCheck: true, fetch: localFetch });
    await assert.rejects(unprivileged.query(makeFunctionReference("qaRuntimeControl:inspect"), { runID }));
    await assert.rejects(client.query(makeFunctionReference("qaRuntimeControl:inspect"), { runID }));
  });
  await check("QA-RUNTIME.untrusted-provider-certificate-rejected", async () => {
    await assert.rejects(action("v0Auth:requestCode", { phone: "+12025550199", requestId: randomUUID() }), (error) => error.data?.code === "PROVIDER_UNAVAILABLE");
    assert.ok(transport.stats.connects > 0, "Actual action fetch did not reach the strict local CONNECT fixture");
    assert.equal(transport.stats.starts, 0, "Untrusted TLS unexpectedly reached HTTP provider transport");
  });
  transport.trustFixtureCertificate();
  const sessions = {};
  for (const [role, actor] of Object.entries(actors)) {
    await check(`QA-RUNTIME.real-phone-auth.${role}`, async () => {
      const requestId = randomUUID();
      const started = await action("v0Auth:requestCode", { phone: actor.phone, requestId });
      assert.equal(started.requestId, requestId);
      if (role === "friend") {
        const count = transport.stats.starts;
        await action("v0Auth:requestCode", { phone: actor.phone, requestId });
        assert.equal(transport.stats.starts, count, "Canonical retry sent duplicate provider request");
        await assert.rejects(action("v0Auth:verifyCode", { phone: actor.phone, requestId, code: "111111", deviceId: "qa-" + runID + role }), (error) => error.data?.code === "INVALID_INPUT");
      }
      const verified = await action("v0Auth:verifyCode", { phone: actor.phone, requestId, code: "000000", deviceId: "qa-" + runID + role });
      assert.equal(typeof verified.token, "string"); privateValues.add(verified.token); local.markSensitive(verified.token);
      assert.equal(verified.account.id, fixture.actors[role]);
      sessions[role] = verified;
      await assert.rejects(action("v0Auth:verifyCode", { phone: actor.phone, requestId, code: "000000", deviceId: "qa-" + runID + role }), (error) => error.data?.code === "CONFLICT");
    });
  }
  await check("QA-RUNTIME.real-authenticated-session", async () => {
    const me = await query("v0Auth:me", { token: sessions.friend.token });
    assert.equal(me.account.id, fixture.actors.friend);
    assert.equal(me.groups.length, 2);
    assert.equal(me.policy.status, "pending");
  });
  await check("QA-RUNTIME.real-subject-sealed", async () => {
    const bet = await query("v0Bets:get", { token: sessions.subject.token, locator: fixture.locator });
    assert.equal(bet.view, "sealed"); assert.equal(bet.canVeto, true);
    assert.equal("question" in bet, false); assert.equal("options" in bet, false);
    for (const sentinel of [`SECRET_QUESTION_${runID}`, `PRIVATE_OPTION_A_${runID}`, `PRIVATE_OPTION_B_${runID}`, `PRIVATE_CONTEXT_${runID}`]) assert.ok(!JSON.stringify(bet).includes(sentinel));
  });
  await check("QA-RUNTIME.real-eligible-read-and-outsider-denial", async () => {
    const bet = await query("v0Bets:get", { token: sessions.friend.token, locator: fixture.locator });
    assert.equal(bet.view, "bet"); assert.equal(bet.question, `SECRET_QUESTION_${runID}`);
    const expectedOptions = fixtureSetID.endsWith("yes-no") ? ["Yes", "No"] : fixtureSetID.endsWith("over-under") ? ["Over 2.5", "Under 2.5"] : [`PRIVATE_OPTION_A_${runID}`, `PRIVATE_OPTION_B_${runID}`];
    assert.deepEqual(bet.options, expectedOptions); assert.equal(bet.canPick, true); assert.equal(bet.myPick, null);
    assert.equal(bet.cutoffAt, bet.revealAt);
    assert.equal("contextLine" in bet, false);
    await assert.rejects(query("v0Bets:get", { token: sessions.outsider.token, locator: fixture.locator }), (error) => error.data?.code === "NOT_AVAILABLE");
    assert.equal(new URL(bet.card.url).origin, "https://cards.qa-runtime.invalid");
    checks.push({ id: "QA-RUNTIME.native-card-origin-compatibility", status: "blocked", reason: "Canonical HTTPS card origin differs from HTTP QA manifest; no unapproved response rewrite" });
  });
  await check("QA-RUNTIME.real-unavailable-read", async () => {
    const bet = await query("v0Bets:get", { token: sessions.friend.token, locator: fixture.unavailableLocator });
    assert.equal(bet.view, "unavailable"); assert.equal("question" in bet, false); assert.equal("options" in bet, false);
    assert.ok(!JSON.stringify(bet).includes(`SECRET_VOIDED_${runID}`));
  });
  await check("QA-RUNTIME.real-scoped-read-only-boards", async () => {
    for (const [index, points] of [17, 4].entries()) {
      const board = await query("v0Groups:board", { token: sessions.friend.token, groupId: fixture.groups[index] });
      assert.equal(board.rows.find((row) => row.accountId === fixture.actors.friend)?.points, points);
    }
  });
  await check("QA-RUNTIME.remaining-creator-policy-is-not-success", async () => {
    await assert.rejects(client.mutation(makeFunctionReference("v0Bets:create"), { token: sessions.creator.token, groupId: fixture.groups[0], subjectId: fixture.actors.subject, question: "Will Sage bring a puzzle to the picnic?", contextLine: "A synthetic picnic", format: "yes_no", options: ["Yes", "No"], source: "manual", requestId: randomUUID() }), (error) => error.data?.code === "POLICY_PENDING");
    const state = await local.inspectFixture();
    assert.equal(state.picks, 0); assert.equal(state.ledger, 0); assert.equal(state.sessions, 4);
  });
  for (const [name, confidence] of [["nan", NaN], ["infinity", Infinity], ["negative-infinity", -Infinity]]) {
    await check(`QA-RUNTIME.real-nonfinite-confidence.${name}`, async () => {
      const before = await local.inspectFixture();
      await assert.rejects(client.mutation(makeFunctionReference("v0Bets:pick"), { token: sessions.friend.token, betId: fixture.betId, option: 0, confidence, requestId: randomUUID() }), (error) => error.data?.code === "INVALID_INPUT");
      assert.deepEqual(await local.inspectFixture(), before);
      assert.equal(before.picks, 0); assert.equal(before.ledger, 0);
    });
  }
  await confirmationScenarios({ origin: backendOrigin, fixture, sessions, actors, check, local, verifyIsolation,
    markSensitive: (value) => { privateValues.add(value); local.markSensitive(value); }, evidence: metadata });
  metadata.fixtureIdentity.exactRunSentinels = true;
  metadata.status = "passing-limited-real-handler-binding";
} catch (error) {
  metadata.status = checks.some((check) => check.status === "failing") ? "failing" : "blocked";
  metadata.error = redact(error.stack ?? error);
  if (error.diagnostics) bootstrapFailure = error.diagnostics;
  if (error.reason) metadata.bootstrapReason = error.reason;
  process.exitCode = 1;
} finally {
  await adapter?.dispose().catch(() => {});
  const diagnostics = local ? await local.close() : bootstrapFailure;
  assert.equal(sourceDigest(), before, "Canonical backend source changed during check");
  assert.equal(sourceDigest(sourceRoot), before, "Private copied product source changed during check");
  metadata.finishedAt = new Date().toISOString();
  metadata.harnessHashes = harnessHashes;
  metadata.harnessBytesUnchanged = executedHarnessPaths.every((path) => digest(readFileSync(resolve(root, path))) === harnessHashes[path]);
  if (!metadata.harnessBytesUnchanged) { metadata.status = "blocked"; process.exitCode = 1; }
  writeFileSync(resolve(output, "backend.log"), redact(diagnostics?.backendLog ?? ""), { mode: 0o600 });
  for (const entry of diagnostics?.cliLogs ?? []) writeFileSync(resolve(output, entry.name), redact(entry.text), { mode: 0o600 });
  rmSync(state, { recursive: true, force: true });
  metadata.cleanup = { privateStateRemoved: !existsSync(state) && !existsSync(state + "b"), sourceBytesUnchanged: true, fixtureAbsentFromRepository: !existsSync(resolve(root, "convex/qaRuntimeControl.ts")) };
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({ output, status: metadata.status, assertions: checks.length, passing: checks.filter((check) => check.status === "passing").length, nativeUIExecuted: false, fullV0Ready: false }) + "\n");
}
process.exit(process.exitCode ?? 0);
