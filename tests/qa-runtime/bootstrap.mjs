import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { actors, fixtureProviderSettings, startProviderTransport } from "./tls-provider.mjs";
import { fixtureSets } from "./catalog.mjs";

export async function bootOfficialBackend(options) {
  const { root, directory, binary, expectedBinarySHA256, runID, fixtureSetID, backendRevision, configVersion, verifyIsolation } = options;
  if (typeof verifyIsolation !== "function" || !/^[a-f0-9]{64}$/.test(expectedBinarySHA256) || !/^[A-Fa-f0-9-]{36}$/.test(runID) || !fixtureSets.includes(fixtureSetID) || !/^[a-f0-9]{40}$/.test(backendRevision)) throw new Error("Verified isolated bootstrap inputs required");
  const processGroupMode = options.processGroupMode ?? "supervised";
  if (!["independent", "supervised"].includes(processGroupMode)) throw new Error("Explicit supported backend process ownership required");
  assert.equal(createHash("sha256").update(readFileSync(binary)).digest("hex"), expectedBinarySHA256);
  assert.ok(!existsSync(directory), "Private backend directory must be fresh");
  assert.ok(isAbsolute(directory) && realpathSync(dirname(directory)) === dirname(directory), "Private scratch parent must be canonical, not a symlink");
  assert.ok(!resolve(directory).startsWith(resolve(root) + "/") && Buffer.byteLength(directory) + 45 < 104, "Use short private scratch outside the repository");
  await verifyIsolation();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const project = resolve(directory, "project"); const home = resolve(directory, "home");
  mkdirSync(project); mkdirSync(home);
  const environment = { PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: directory, CI: "1", NODE_ENV: "test", EXPO_NO_DOTENV: "1", CONVEX_AGENT_MODE: "anonymous", DISABLE_BEACON: "1", DO_NOT_TRACK: "1" };
  const origin = "http://127.0.0.1:3210";
  const privateValues = new Set();
  const markSensitive = (value) => { if (typeof value === "string" && value) privateValues.add(value); };
  const redact = (input) => { let text = String(input); for (const value of privateValues) text = text.replaceAll(value, "[local credential redacted]"); return text; };
  let backend; let provider; let logs = ""; let closing;
  const diagnostics = [];
  const close = () => closing ??= (async () => {
    const running = () => backend && backend.exitCode === null && backend.signalCode === null;
    const awaitExit = async () => {
      if (!running()) return;
      const timer = new AbortController();
      let accept;
      const exited = new Promise((resolve) => { accept = resolve; backend.once("exit", accept); });
      try { await Promise.race([exited, delay(3000, undefined, { signal: timer.signal })]); }
      finally { timer.abort(); backend.removeListener("exit", accept); }
    };
    const signal = (name) => {
      try { process.kill(processGroupMode === "independent" ? -backend.pid : backend.pid, name); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    let failed = false;
    try {
      if (backend?.pid) {
        if (processGroupMode === "independent" || running()) signal("SIGTERM");
        await awaitExit();
        if (processGroupMode === "independent" || running()) signal("SIGKILL");
        await awaitExit();
        if (running()) failed = true;
      }
    } catch { failed = true; }
    try { await provider?.close(); } catch { failed = true; }
    const retained = { backendLog: redact(logs), cliLogs: diagnostics.map((entry) => ({ ...entry, text: redact(entry.text) })) };
    if (!failed) { try { rmSync(directory, { recursive: true, force: true }); } catch { failed = true; } }
    if (failed) throw new Error("Private backend cleanup is unproven; keep controller isolation active");
    return retained;
  })();
  try {
    cpSync(resolve(root, "convex"), resolve(project, "convex"), { recursive: true });
    const overlay = readFileSync(resolve(root, "tests/qa-runtime/fixture.ts.txt"), "utf8").replaceAll("__QA_RUN_ID__", runID).replace("__QA_ACTORS__", JSON.stringify(actors)).replace("__QA_FIXTURE_SETS__", JSON.stringify(fixtureSets));
    writeFileSync(resolve(project, "convex/qaRuntimeControl.ts"), overlay, { mode: 0o600 });
    writeFileSync(resolve(project, "convex/crons.ts"), 'import { cronJobs } from "convex/server";\nexport default cronJobs();\n');
    writeFileSync(resolve(project, "package.json"), JSON.stringify({ name: "calledit-private-qa-runtime", version: "0.0.0", private: true, dependencies: { convex: JSON.parse(readFileSync(resolve(root, "node_modules/convex/package.json"), "utf8")).version } }));
    symlinkSync(resolve(root, "node_modules"), resolve(project, "node_modules"), "dir");
    provider = await startProviderTransport({ directory, environment });
    if (options.rejectFirstCertificate !== true) provider.trustFixtureCertificate();
    const instanceSecret = randomBytes(32).toString("hex"); markSensitive(instanceSecret);
    const adminKey = execFileSync(binary, ["keygen", "admin-key", "--instance-name", "qa-" + runID, "--instance-secret", instanceSecret], { env: environment, encoding: "utf8", stdio: "pipe" }).trim(); markSensitive(adminKey);
    backend = spawn(binary, ["--interface", "127.0.0.1", "--port", "3210", "--site-proxy-port", "3211", "--convex-http-proxy", provider.proxyOrigin, "--instance-name", "qa-" + runID, "--instance-secret", instanceSecret, "--disable-beacon", "--local-storage", resolve(directory, "storage"), resolve(directory, "backend.sqlite3")], {
      cwd: project, env: { ...environment, SSL_CERT_FILE: provider.caPath, HTTPS_PROXY: provider.proxyOrigin, HTTP_PROXY: provider.proxyOrigin, NO_PROXY: "127.0.0.1,localhost" }, detached: processGroupMode === "independent", stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (data) => { logs = (logs + data.toString()).slice(-200000); };
    backend.stdout.on("data", collect); backend.stderr.on("data", collect);
    let startupError;
    backend.once("error", (error) => { startupError = error.code ?? "BACKEND_START_FAILED"; });
    const localFetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).origin, origin);
      return fetch(request, { redirect: "error", signal: AbortSignal.timeout(15000) });
    };
    let ready = false;
    for (let index = 0; index < 120; index++) {
      if (startupError || backend.exitCode !== null) throw new Error("Official backend exited before readiness");
      try { if ((await localFetch(origin + "/version")).ok) { ready = true; break; } } catch { }
      await delay(250);
    }
    assert.ok(ready, "Official backend readiness timed out");
    const cli = (args, name) => {
      const result = spawnSync(process.execPath, [resolve(root, "node_modules/convex/bin/main.js"), ...args], { cwd: project, env: { ...environment, CONVEX_SELF_HOSTED_URL: origin, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey }, encoding: "utf8", timeout: 120000 });
      diagnostics.push({ name, text: (result.stdout ?? "") + (result.stderr ?? "") });
      assert.equal(result.status, 0, "Isolated local backend CLI operation failed");
    };
    cli(["dev", "--once", "--typecheck", "disable", "--codegen", "disable", "--tail-logs", "disable"], "local-push.log");
    const pepper = randomBytes(32).toString("hex"); markSensitive(pepper);
    const settings = { ...fixtureProviderSettings, V0_PHONE_PEPPER: pepper, V0_ENVIRONMENT: "local", V0_SOURCE_SHA: backendRevision, V0_DEPLOYMENT_ID: "qa-" + runID, V0_CONFIG_VERSION: configVersion, V0_CARD_ORIGIN: "https://cards.qa-runtime.invalid" };
    const envPath = resolve(directory, "backend.env");
    writeFileSync(envPath, Object.entries(settings).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
    cli(["env", "set", "--from-file", envPath], "local-env-names.log");
    const admin = new ConvexHttpClient(origin, { logger: false, skipConvexDeploymentUrlCheck: true, fetch: localFetch }); admin.setAdminAuth(adminKey);
    let seeded = false;
    return Object.freeze({
      origin, provider, markSensitive, redact, close,
      async seedFreshFixture(id, set) {
        assert.ok(!seeded && id === runID && set === fixtureSetID, "One exact fresh fixture initialization required");
        await verifyIsolation();
        const fixture = await admin.mutation(makeFunctionReference("qaRuntimeControl:seed"), { runID: id, fixtureSetID: set });
        seeded = true; return fixture;
      },
      async inspectFixture() { return await admin.query(makeFunctionReference("qaRuntimeControl:inspect"), { runID }); },
    });
  } catch (error) {
    const retained = await close();
    const safe = new Error("Isolated official backend bootstrap failed");
    safe.diagnostics = retained;
    safe.reason = redact(error.stack ?? error);
    throw safe;
  }
}
