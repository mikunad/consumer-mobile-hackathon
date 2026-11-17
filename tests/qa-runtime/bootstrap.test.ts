import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootOfficialBackend, type BootstrapOptions } from "./bootstrap.mjs";

const doubles = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn(), spawnSync: vi.fn(), provider: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: doubles.spawn, execFileSync: doubles.execFileSync, spawnSync: doubles.spawnSync }));
vi.mock("./tls-provider.mjs", async (original) => ({ ...await original<typeof import("./tls-provider.mjs")>(), startProviderTransport: doubles.provider }));
vi.mock("node:timers/promises", () => ({ setTimeout: (...args: [number, unknown?, { signal?: AbortSignal }?]) => new Promise<void>((accept, reject) => {
  const signal = args[2]?.signal;
  const abort = () => { clearTimeout(timer); reject(new Error("UNIT aborted wait")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); accept(); }, args[0]);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
}) }));

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const folders: string[] = [];
const locals: Awaited<ReturnType<typeof bootOfficialBackend>>[] = [];
beforeEach(() => { doubles.spawn.mockReset(); doubles.execFileSync.mockReset(); doubles.spawnSync.mockReset(); doubles.provider.mockReset(); });
afterEach(async () => {
  for (const local of locals.splice(0)) await local.close().catch(() => undefined);
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.useRealTimers();
});

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "qb-unit-")); folders.push(folder);
  const binary = join(folder, "UNIT-FAKE-NOT-EXECUTED"); await writeFile(binary, "UNIT FAKE BACKEND, NEVER EXECUTED");
  const child = Object.assign(new EventEmitter(), { pid: 924001, exitCode: null as number | null, signalCode: null as string | null, stdout: new EventEmitter(), stderr: new EventEmitter() });
  doubles.spawn.mockReturnValue(child);
  doubles.execFileSync.mockReturnValue("UNIT-FAKE-ADMIN-NOT-A-REAL-CREDENTIAL");
  doubles.spawnSync.mockReturnValue({ status: 0, stdout: "UNIT CLI MOCK", stderr: "" });
  const provider = { caPath: join(folder, "UNIT-FAKE-CA"), proxyOrigin: "http://127.0.0.1:43128", caSHA256: "c".repeat(64), stats: {}, trustFixtureCertificate: vi.fn(), close: vi.fn(async () => {}) };
  doubles.provider.mockResolvedValue(provider);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("UNIT FAKE VERSION", { status: 200 })));
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    child.signalCode = String(signal); child.emit("exit", null, signal); return true;
  });
  const options: BootstrapOptions = { root, directory: join(folder, "p"), binary, expectedBinarySHA256: createHash("sha256").update(await readFile(binary)).digest("hex"),
    runID: randomUUID().toUpperCase(), fixtureSetID: "synthetic-v0-subject-locked", backendRevision: "b".repeat(40), configVersion: "bootstrap-unit", verifyIsolation: vi.fn(async () => {}) };
  return { options, child, provider, kill };
}

async function start(options: BootstrapOptions) {
  const local = await bootOfficialBackend(options); locals.push(local); return local;
}

describe("bootstrap ownership units with mocked processes/provider: no process/kernel/PF/runtime evidence", () => {
  it.each([undefined, "supervised"] as const)("QA-BOOT-01 defaults to supervised ownership and never detaches (%s)", async (mode) => {
    const f = await fixture(); const local = await start({ ...f.options, processGroupMode: mode });
    expect(doubles.spawn.mock.calls[0][2].detached).toBe(false);
    const closing = local.close(); expect(local.close()).toBe(closing); await closing;
    expect(f.kill.mock.calls).toEqual([[f.child.pid, "SIGTERM"]]);
    expect(f.kill.mock.calls.every(([pid]) => pid > 0)).toBe(true);
    expect(f.provider.close).toHaveBeenCalledTimes(1);
    await expect(stat(f.options.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("QA-BOOT-02 permits a separate group only when the isolated Linux owner explicitly requests it", async () => {
    const f = await fixture(); const local = await start({ ...f.options, processGroupMode: "independent" });
    expect(doubles.spawn.mock.calls[0][2].detached).toBe(true);
    await local.close();
    expect(f.kill.mock.calls).toEqual([[-f.child.pid, "SIGTERM"], [-f.child.pid, "SIGKILL"]]);
    expect(f.provider.close).toHaveBeenCalledTimes(1);
  });

  it("QA-BOOT-03 escalates only the owned supervised PID after a bounded wait", async () => {
    const f = await fixture(); const local = await start({ ...f.options, processGroupMode: "supervised" });
    vi.useFakeTimers();
    f.kill.mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") { f.child.signalCode = "SIGKILL"; f.child.emit("exit", null, signal); }
      return true;
    });
    const closing = local.close(); await vi.advanceTimersByTimeAsync(3001); await closing;
    expect(f.kill.mock.calls).toEqual([[f.child.pid, "SIGTERM"], [f.child.pid, "SIGKILL"]]);
    expect(f.provider.close).toHaveBeenCalledTimes(1);
  });

  it("QA-BOOT-04 retains private state and reports unproved cleanup if that PID survives both waits", async () => {
    const f = await fixture(); const local = await start({ ...f.options, processGroupMode: "supervised" });
    vi.useFakeTimers(); f.kill.mockReturnValue(true);
    const result = expect(local.close()).rejects.toThrow("cleanup is unproven");
    await vi.advanceTimersByTimeAsync(6001); await result;
    expect(f.kill.mock.calls).toEqual([[f.child.pid, "SIGTERM"], [f.child.pid, "SIGKILL"]]);
    expect(f.provider.close).toHaveBeenCalledTimes(1); expect((await stat(f.options.directory)).isDirectory()).toBe(true);
  });

  it("QA-BOOT-05 never sends a signal to an already-exited supervised PID or the owner's group", async () => {
    const f = await fixture(); const local = await start({ ...f.options, processGroupMode: "supervised" });
    f.child.exitCode = 0;
    await local.close();
    expect(f.kill).not.toHaveBeenCalled(); expect(f.provider.close).toHaveBeenCalledTimes(1);
  });

  it("QA-BOOT-06 rejects unsupported ownership modes before creating resources", async () => {
    const f = await fixture();
    await expect(bootOfficialBackend({ ...f.options, processGroupMode: "daemon" } as unknown as BootstrapOptions)).rejects.toThrow("process ownership");
    expect(doubles.spawn).not.toHaveBeenCalled(); expect(doubles.provider).not.toHaveBeenCalled(); expect(f.kill).not.toHaveBeenCalled();
  });

  it("QA-BOOT-07 never inherits configured credentials into the supervised child environment", async () => {
    const f = await fixture(); const local = await start({ ...f.options, processGroupMode: "supervised" });
    const environment = doubles.spawn.mock.calls[0][2].env;
    expect(Object.keys(environment).sort()).toEqual(["CI", "CONVEX_AGENT_MODE", "DISABLE_BEACON", "DO_NOT_TRACK", "EXPO_NO_DOTENV", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "NODE_ENV", "NO_PROXY", "PATH", "SSL_CERT_FILE", "TMPDIR"].sort());
    expect(environment.NO_PROXY).toBe("127.0.0.1,localhost"); expect(environment.SSL_CERT_FILE).toBe(f.provider.caPath);
    await local.close();
    expect(Buffer.byteLength(f.options.directory) + 45).toBeLessThan(104);
  });
});
