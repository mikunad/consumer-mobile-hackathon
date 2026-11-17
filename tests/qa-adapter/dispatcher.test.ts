import { describe, expect, it, vi } from "vitest";
import { internalQueryGeneric, queryGeneric } from "convex/server";
import { createQAAdapter } from "./adapter";
import { allowedPath, createPublicDispatcher } from "./dispatcher";
import { AdapterBlocked } from "./manifest";
import { plumbingFixture } from "./fixtures";

describe("explicit real-export/kind boundary", () => {
  it("QA-DISPATCH-01 pins actual public Convex registration objects and endpoint kinds", async () => {
    const f = plumbingFixture();
    const adapter = await f.create();
    try {
      expect((await adapter.handle(f.request())).status).toBe(200);
      expect(f.calls).toHaveBeenCalledTimes(1);
      expect(f.calls.mock.calls[0][0].registration).toBe(f.modules.v0Bets.get);
      expect((await adapter.handle(f.request("v0Auth:redeemPair", {}, "/api/action"))).status).toBe(200);
      expect((await adapter.handle(f.request("v0Auth:redeemPair", {}, "/api/mutation"))).status).toBe(404);
    } finally { await adapter.dispose(); }
  });

  it("QA-DISPATCH-02 rejects unregistered, internal, legacy and test-control routes", () => {
    const f = plumbingFixture();
    const invoke = vi.fn(async () => null);
    for (const path of ["chat:stake", "internal.v0Bets:get", "v0Legacy:get", "v0Fixtures:seed", "v0Bets:reset", "v0Bets:setClock", "v0Debug:get", "v0Admin:reset", "v0Test:get", "v0Bets:get/extra"]) expect(allowedPath(path)).toBe(false);
    for (const exported of [undefined, () => null, internalQueryGeneric({ args: {}, handler: async () => null })]) {
      expect(() => createPublicDispatcher({ modules: { v0Runtime: f.modules.v0Runtime, v0Bets: { get: exported } }, allowlist: f.allowlist.slice(0, 2), invoke })).toThrow(AdapterBlocked);
    }
    expect(() => createPublicDispatcher({ modules: f.modules, allowlist: [{ path: "v0Bets:get", kind: "action" }, f.allowlist[0]], invoke })).toThrow(AdapterBlocked);
    expect(() => createPublicDispatcher({ modules: f.modules, allowlist: [f.allowlist[0], f.allowlist[0]], invoke })).toThrow(AdapterBlocked);
    expect(() => createPublicDispatcher({ modules: { v0Bets: { get: queryGeneric({ args: {}, handler: async () => null }) } }, allowlist: [f.allowlist[1]], invoke })).toThrow(AdapterBlocked);
  });

  it("QA-DISPATCH-03 blocks missing fixture/dispatcher dependencies rather than returning fake success", async () => {
    const f = plumbingFixture();
    await expect(createQAAdapter({ ...f.options, initializeRun: undefined as unknown as typeof f.options.initializeRun })).rejects.toThrow(AdapterBlocked);
    await expect(createQAAdapter({ ...f.options, initializeRun: async () => { throw new Error("SYNTHETIC_PRIVATE_SETUP_ERROR"); } })).rejects.toThrow(AdapterBlocked);
    await expect(createQAAdapter({ ...f.options, requiredFunctions: [...f.allowlist, { path: "v0Bets:missing", kind: "query" }] })).rejects.toThrow(AdapterBlocked);
    await expect(createQAAdapter({ ...f.options, mode: "simulator-runtime" })).rejects.toThrow(AdapterBlocked);
    const adapter = await f.create();
    try { await expect(adapter.listen()).rejects.toThrow(AdapterBlocked); }
    finally { await adapter.dispose(); }
  });

  it("QA-DISPATCH-05 rejects an arbitrary dispatcher object and suppresses cleanup failures", async () => {
    const f = plumbingFixture();
    const initialize = f.options.initializeRun;
    await expect(createQAAdapter({ ...f.options, initializeRun: async (context) => {
      const binding = await initialize(context);
      return { ...binding, dispatcher: { ...binding.dispatcher }, dispose: async () => { throw new Error("SYNTHETIC_PRIVATE_CLEANUP"); } };
    } })).rejects.toThrow(AdapterBlocked);
  });

  it("QA-DISPATCH-04 allocates and clears storage/outbox per run instance", async () => {
    const f = plumbingFixture();
    const first = await f.create();
    const second = await f.create();
    try {
      expect(f.allocated[0]).not.toBe(f.allocated[1]);
      f.allocated[0].storage.set("synthetic-only", new ArrayBuffer(1));
      f.allocated[0].outbox.push({ kind: "synthetic" });
      expect(f.allocated[1].storage.size).toBe(0);
      expect(f.allocated[1].outbox).toEqual([]);
      await first.dispose();
      expect(f.allocated[0].storage.size).toBe(0);
      expect(f.allocated[0].outbox).toEqual([]);
      expect((await first.handle(f.request())).status).toBe(503);
    } finally { await first.dispose(); await second.dispose(); }
  });
});
