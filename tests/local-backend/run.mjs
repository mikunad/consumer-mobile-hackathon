import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { convexToJson } from "convex/values";
import { makePng } from "../fixtures/png.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const option = (name) => argv[argv.indexOf(name) + 1];
const binarySha256 = "044eedfe569b1550d5003683aec7fceb4dcee3f82abf00ab9baf1c10d3ca0b4c";
const backendVersion = "precompiled-2026-10-22-1447815";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (!argv.includes("--binary") || !argv.includes("--output")) throw new Error("Require --binary and fresh --output outside the repository");
const binary = resolve(option("--binary"));
const output = resolve(option("--output"));
if (output === root || output.startsWith(`${root}/`) || existsSync(output)) throw new Error("Output must be a new external run directory");
assert.equal(digest(readFileSync(binary)), binarySha256, "Unexpected local backend binary");

if (!argv.includes("--namespace-worker")) {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "test", CI: "1", E2E_LOCAL_RPC: "loopback-namespace-v1" };
  const result = spawnSync("unshare", ["--user", "--map-root-user", "--net", process.execPath, fileURLToPath(import.meta.url), ...argv, "--namespace-worker"], { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

assert.equal(process.env.E2E_LOCAL_RPC, "loopback-namespace-v1");
assert.deepEqual(Object.keys(process.env).filter((key) => /KEY|SECRET|TOKEN|PASSCODE|CONVEX/i.test(key)), []);
execFileSync("ip", ["link", "set", "lo", "up"], { stdio: "pipe" });
assert.equal(execFileSync("ip", ["route", "show", "default"], { encoding: "utf8" }).trim(), "");
assert.equal(execFileSync("ip", ["-6", "route", "show", "default"], { encoding: "utf8" }).trim(), "");
mkdirSync(output, { recursive: true, mode: 0o700 });
const state = mkdtempSync(resolve(output, "private-state-"));
const project = resolve(state, "project");
const home = resolve(state, "home");
mkdirSync(project);
mkdirSync(home);
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: state, CI: "1", NODE_ENV: "test", EXPO_NO_DOTENV: "1", CONVEX_AGENT_MODE: "anonymous", DISABLE_BEACON: "1", DO_NOT_TRACK: "1" };
const runId = `e2e_${randomUUID().replaceAll("-", "")}`;
const origin = "http://127.0.0.1:3210";
const instanceSecret = randomBytes(32).toString("hex");
const adminKey = execFileSync(binary, ["keygen", "admin-key", "--instance-name", runId, "--instance-secret", instanceSecret], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const redact = (value) => String(value).replaceAll(instanceSecret, "[local secret redacted]").replaceAll(adminKey, "[local key redacted]");
const results = [];
const httpEvidence = [];
const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
const sourceFiles = git("ls-files", "convex").split("\n").filter(Boolean).sort();
const sourceDigest = digest(sourceFiles.map((path) => path + "\n" + readFileSync(resolve(root, path), "utf8")).join("\n"));
const metadata = { schemaVersion: 1, runId, candidateSha: git("rev-parse", "HEAD"), backendSourceSha: git("log", "-1", "--format=%H", "--", "convex"), backendSourceDigest: sourceDigest, harnessSha256: digest(readFileSync(fileURLToPath(import.meta.url))), fixtureSha256: digest(readFileSync(resolve(root, "tests/local-backend/fixtures/qaRpc.ts.txt"))), mediaFixtureSha256: digest(readFileSync(resolve(root, "tests/fixtures/png.mjs"))), mediaContentHashes: [undefined, 257, 512 * 1024].map((length) => { const bytes = makePng(length); return { length: bytes.byteLength, sha256: digest(new Uint8Array(bytes)) }; }), backendVersion, binarySha256, convexClientVersion: JSON.parse(readFileSync(resolve(root, "node_modules/convex/package.json"), "utf8")).version, os: { platform: process.platform, architecture: process.arch, node: process.version }, startedAt: new Date().toISOString(), origin, target: "real OSS backend in isolated loopback network namespace", sourceOverlays: ["qaRpc.ts (test-only fixture)", "crons.ts (empty test-only scheduler)"], productionProof: false, nativeTransportExecuted: false, businessHandlerProof: "proof media and session revocation only; no complete journey", providerRunIds: [], signedBuild: null, status: "blocked" };
const safeFetch = async (url, options = {}) => {
  const target = new URL(url);
  assert.equal(target.origin, origin);
  assert.equal(target.username, "");
  assert.equal(target.password, "");
  return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
};
const client = new ConvexHttpClient(origin, { skipConvexDeploymentUrlCheck: true, logger: false, fetch: safeFetch });
const check = async (id, perform) => {
  const start = performance.now();
  try {
    await perform();
    results.push({ id, status: "passing", durationMs: performance.now() - start });
  } catch (error) {
    results.push({ id, status: "failing", durationMs: performance.now() - start, error: redact(error.stack ?? error) });
    throw error;
  }
};
let server;
let logs = "";
try {
  cpSync(resolve(root, "convex"), resolve(project, "convex"), { recursive: true });
  cpSync(resolve(root, "tests/local-backend/fixtures/qaRpc.ts.txt"), resolve(project, "convex/qaRpc.ts"));
  writeFileSync(resolve(project, "convex/crons.ts"), 'import { cronJobs } from "convex/server";\nexport default cronJobs();\n');
  writeFileSync(resolve(project, "package.json"), JSON.stringify({ name: "calledit-isolated-rpc", private: true, version: "0.0.0", dependencies: { convex: metadata.convexClientVersion } }));
  symlinkSync(resolve(root, "node_modules"), resolve(project, "node_modules"), "dir");
  server = spawn(binary, ["--interface", "127.0.0.1", "--port", "3210", "--site-proxy-port", "3211", "--instance-name", runId, "--instance-secret", instanceSecret, "--disable-beacon", "--local-storage", resolve(state, "storage"), resolve(state, "backend.sqlite3")], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  const collect = (data) => { logs = (logs + data.toString()).slice(-200000); };
  server.stdout.on("data", collect);
  server.stderr.on("data", collect);
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error("Local backend exited before readiness");
    try { const response = await safeFetch(`${origin}/version`); if (response.ok) { ready = true; break; } } catch { }
    await delay(250);
  }
  assert.ok(ready, "Local backend did not become ready");
  const deploy = spawnSync(process.execPath, [resolve(root, "node_modules/convex/bin/main.js"), "dev", "--once", "--typecheck", "disable", "--codegen", "disable", "--tail-logs", "disable"], { cwd: project, env: { ...env, CONVEX_SELF_HOSTED_URL: origin, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey }, encoding: "utf8", timeout: 120000 });
  writeFileSync(resolve(output, "local-push.log"), redact((deploy.stdout ?? "") + (deploy.stderr ?? "")), { mode: 0o600 });
  assert.equal(deploy.status, 0, "Local-only source push failed; see redacted local-push.log");

  await check("RPC.real-runtime-attestation", async () => {
    const value = await client.query(makeFunctionReference("v0Runtime:attestation"), {});
    assert.equal(value.app, "called-it");
    assert.equal(value.testAdapters, false);
    assert.equal(value.environment, "unconfigured");
  });

  for (const length of [0, 1, 257, 512 * 1024]) {
    await check(`RPC.real-storage-bytes.${length}`, async () => {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31) % 256).buffer;
      const result = await client.action(makeFunctionReference("qaRpc:storageBytes"), { runId, bytes });
      assert.ok(result.bytes instanceof ArrayBuffer);
      assert.equal(result.length, length);
      assert.deepEqual(new Uint8Array(result.bytes), new Uint8Array(bytes));
    });
  }

  for (const shape of ["object", "string", "null"]) {
    await check(`RPC.real-udf-envelope.${shape}`, async () => {
      const body = { path: "qaRpc:failure", format: "convex_encoded_json", args: [convexToJson({ runId, shape, code: shape === "object" ? "AUTH_REQUIRED" : "POLICY_PENDING" })] };
      const response = await safeFetch(`${origin}/api/query`, { method: "POST", headers: { "Content-Type": "application/json", "Convex-Client": `npm-${metadata.convexClientVersion}` }, body: JSON.stringify(body) });
      const envelope = await response.json();
      httpEvidence.push({ id: `RPC.real-udf-envelope.${shape}`, request: body, httpStatus: response.status, envelope });
      assert.ok([200, 560].includes(response.status), "Only SDK-supported success/UDF-error transport statuses are valid");
      assert.equal(envelope.status, "error");
      if (shape === "object") assert.equal(envelope.errorData.code, "AUTH_REQUIRED");
      if (shape === "string") assert.equal(JSON.parse(envelope.errorData).code, "POLICY_PENDING");
      if (shape === "null") assert.equal(envelope.errorData, null);
      await assert.rejects(client.query(makeFunctionReference("qaRpc:failure"), { runId, shape, code: shape === "object" ? "AUTH_REQUIRED" : "POLICY_PENDING" }), (error) => {
        assert.deepEqual(error.data, envelope.errorData);
        return true;
      });
    });
  }

  await check("RPC.actual-retired-handler", async () => {
    await assert.rejects(client.query(makeFunctionReference("chat:home"), {}), (error) => error.data?.code === "NOT_AVAILABLE");
  });

  await check("RPC.typed-request-and-response", async () => {
    const payload = new Uint8Array([0, 1, 127, 128, 255]).buffer;
    const body = { path: "qaRpc:echo", format: "convex_encoded_json", args: [convexToJson({ runId, payload })] };
    const response = await safeFetch(`${origin}/api/query`, { method: "POST", headers: { "Content-Type": "application/json", "Convex-Client": `npm-${metadata.convexClientVersion}` }, body: JSON.stringify(body) });
    const envelope = await response.json();
    assert.equal(response.status, 200);
    assert.equal(envelope.status, "success");
    assert.deepEqual(envelope.value, { $bytes: "AAF/gP8=" });
    const sdk = await client.query(makeFunctionReference("qaRpc:echo"), { runId, payload });
    assert.deepEqual(new Uint8Array(sdk), new Uint8Array(payload));
    httpEvidence.push({ id: "RPC.typed-request-and-response", request: body, httpStatus: response.status, envelope });
  });

  const token = `synthetic_${runId}_account`;
  const fixture = await client.mutation(makeFunctionReference("qaRpc:seed"), { runId, token });
  await check("RPC.real-transaction-idempotency-race", async () => {
    const args = { token, groupId: fixture.groupId, requestId: `${runId}_once`, delta: 1 };
    const replies = await Promise.all(Array.from({ length: 20 }, () => client.mutation(makeFunctionReference("qaRpc:writeOnce"), args, { skipQueue: true })));
    assert.ok(replies.every((reply) => reply.points === 1001));
    assert.deepEqual(await client.query(makeFunctionReference("qaRpc:readMember"), { token, groupId: fixture.groupId }), { points: 1001 });
    await assert.rejects(client.mutation(makeFunctionReference("qaRpc:writeOnce"), { ...args, delta: 2 }), (error) => error.data?.code === "IDEMPOTENCY_CONFLICT");
  });

  const proofFixture = await client.mutation(makeFunctionReference("qaRpc:seedProof"), { runId, token });
  let lastProof;
  for (const length of [undefined, 257, 512 * 1024]) {
    await check(`RPC.canonical-proof-roundtrip.${length ?? "tiny-png"}`, async () => {
      const bytes = makePng(length);
      const args = { token, betId: proofFixture.betId, contentType: "image/png", bytes, requestId: `${runId}_proof_${bytes.byteLength}` };
      const stored = await client.action(makeFunctionReference("v0Proof:upload"), args);
      assert.deepEqual(await client.action(makeFunctionReference("v0Proof:upload"), args), stored);
      const read = await client.action(makeFunctionReference("v0Proof:read"), { token, proofId: stored.id });
      assert.equal(read.contentType, "image/png");
      assert.ok(read.bytes instanceof ArrayBuffer);
      assert.deepEqual(new Uint8Array(read.bytes), new Uint8Array(bytes));
      assert.equal("url" in read, false);
      lastProof = stored;
    });
  }

  await check("RPC.canonical-proof-input-bounds", async () => {
    const base = { token, betId: proofFixture.betId, contentType: "image/png" };
    for (const [index, bytes] of [new ArrayBuffer(0), new ArrayBuffer(8), makePng(512 * 1024 + 1)].entries()) {
      await assert.rejects(client.action(makeFunctionReference("v0Proof:upload"), { ...base, bytes, requestId: `${runId}_bad_${index}` }), (error) => error.data?.code === "INVALID_INPUT");
    }
    assert.equal((await client.query(makeFunctionReference("v0Proof:list"), { token, betId: proofFixture.betId })).length, 3);
  });

  await check("RPC.canonical-proof-role-and-leave", async () => {
    assert.ok(lastProof);
    const foreign = { token: `${token}_outsider`, proofId: lastProof.id };
    await assert.rejects(client.action(makeFunctionReference("v0Proof:read"), foreign), (error) => error.data?.code === "NOT_AVAILABLE");
    const friendToken = `${token}_friend`;
    assert.ok((await client.action(makeFunctionReference("v0Proof:read"), { token: friendToken, proofId: lastProof.id })).bytes instanceof ArrayBuffer);
    await client.mutation(makeFunctionReference("v0Controls:leave"), { token: friendToken, groupId: proofFixture.groupId, requestId: `${runId}_friend_leave` });
    await assert.rejects(client.action(makeFunctionReference("v0Proof:read"), { token: friendToken, proofId: lastProof.id }), (error) => error.data?.code === "NOT_AVAILABLE");
  });

  await check("RPC.real-session-revocation", async () => {
    assert.deepEqual(await client.mutation(makeFunctionReference("v0Auth:revoke"), { token, allDevices: true, requestId: `${runId}_revoke` }), { revoked: true });
    await assert.rejects(client.query(makeFunctionReference("qaRpc:readMember"), { token, groupId: fixture.groupId }), (error) => error.data?.code === "AUTH_REQUIRED");
  });
  await check("RPC.canonical-proof-revocation", async () => {
    await assert.rejects(client.action(makeFunctionReference("v0Proof:read"), { token, proofId: lastProof.id }), (error) => error.data?.code === "AUTH_REQUIRED");
  });
  metadata.status = "passing-limited-contract";
} catch (error) {
  metadata.status = results.some((result) => result.status === "failing") ? "failing" : "blocked";
  metadata.error = redact(error.stack ?? error);
  process.exitCode = 1;
} finally {
  server?.kill("SIGTERM");
  if (server) await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]);
  if (server && server.exitCode === null) server.kill("SIGKILL");
  const after = digest(sourceFiles.map((path) => path + "\n" + readFileSync(resolve(root, path), "utf8")).join("\n"));
  assert.equal(after, sourceDigest, "Repository product source changed during local contract run");
  assert.equal(existsSync(resolve(root, "convex/qaRpc.ts")), false, "Fixture endpoint entered repository source");
  writeFileSync(resolve(output, "backend.log"), redact(logs), { mode: 0o600 });
  writeFileSync(resolve(output, "http-envelopes.json"), JSON.stringify(httpEvidence, null, 2) + "\n", { mode: 0o600 });
  metadata.finishedAt = new Date().toISOString();
  metadata.assertions = results;
  metadata.gates = { realBackendProtocol: results.length === 18 && results.every((r) => r.status === "passing"), nativeTransport: false, canonicalProofHandlers: results.filter((r) => r.id.startsWith("RPC.canonical-proof")).length === 6 && results.filter((r) => r.id.startsWith("RPC.canonical-proof")).every((r) => r.status === "passing"), fullV0Ready: false };
  rmSync(state, { recursive: true, force: true });
  assert.equal(existsSync(state), false, "Private local database/storage state was not removed");
  metadata.cleanup = { productSourceUnchanged: true, fixtureEndpointAbsent: true, privateStateRemoved: true };
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
  await new Promise((resolve) => process.stdout.write(JSON.stringify({ output, status: metadata.status, assertions: results.length, passing: results.filter((r) => r.status === "passing").length, fullV0Ready: false }) + "\n", resolve));
}
process.exit(process.exitCode ?? 0);
