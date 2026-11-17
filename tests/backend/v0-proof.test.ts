import { describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { makePng } from "../fixtures/png.mjs";
import { CUTOFF, REVEAL } from "./fixture";
import { v0Fixture } from "./v0-fixture";

type Fixture = Awaited<ReturnType<typeof v0Fixture>>;

function upload(f: Fixture, requestId = `${f.runId}_upload`, bytes = makePng()) {
  return { token: f.actors.subject.token, betId: f.bet, contentType: "image/png" as const, bytes, requestId };
}

async function proofState(f: Fixture) {
  return await f.t.run(async (ctx) => ({ proofs: await ctx.db.query("v0Proofs").collect(), files: await ctx.db.system.query("_storage").collect() }));
}

describe("actual V0 private proof handlers with synthetic storage", () => {
  it("[V0.proof.subject-upload-private-roundtrip] stores valid PNG privately and returns only authenticated bytes/references", async () => {
    const f = await v0Fixture();
    vi.setSystemTime(REVEAL);
    const args = upload(f);
    const created = await f.t.action(api.v0Proof.upload, args);
    expect(Object.keys(created).sort()).toEqual(["contentType", "createdAt", "id"]);
    expect(created).toMatchObject({ contentType: "image/png", createdAt: REVEAL });
    const listed = await f.t.query(api.v0Proof.list, { token: f.actors.friend.token, betId: f.bet });
    expect(listed.map((proof) => proof.id)).toContain(created.id);
    expect(listed.every((proof) => Object.keys(proof).sort().join(",") === "contentType,createdAt,id")).toBe(true);
    const read = await f.t.action(api.v0Proof.read, { token: f.actors.friend.token, proofId: created.id });
    expect(Object.keys(read).sort()).toEqual(["bytes", "contentType", "createdAt", "id"]);
    expect(read.bytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(read.bytes)).toEqual(new Uint8Array(args.bytes));
    const state = await proofState(f);
    const row = state.proofs.find((proof) => proof._id === created.id)!;
    expect(row.accountId).toBe(f.actors.subject.id);
    expect(row.betId).toBe(f.bet);
    expect(state.files.some((file) => file._id === row.storageId)).toBe(true);
    expect(await f.t.run(async (ctx) => (await ctx.storage.get(row.storageId))?.type)).toBe("image/png");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  for (const role of ["creator", "friend", "outsider", "unadmittedAlias", "new", "left", "revoked"] as const) {
    it(`[V0.proof.upload-role.${role}] denies non-subject or invalid-session upload without new storage`, async () => {
      const f = await v0Fixture();
      vi.setSystemTime(REVEAL);
      const before = await proofState(f);
      await expect(f.t.action(api.v0Proof.upload, { ...upload(f), token: f.actors[role].token })).rejects.toMatchObject({ data: { code: role === "revoked" ? "AUTH_REQUIRED" : "NOT_AVAILABLE" } });
      expect(await proofState(f)).toEqual(before);
    });
  }

  for (const at of [CUTOFF, REVEAL - 1]) {
    it(`[V0.proof.before-reveal.${at - REVEAL}] denies upload/list/read before the server reveal boundary`, async () => {
      const f = await v0Fixture();
      vi.setSystemTime(at);
      await expect(f.t.action(api.v0Proof.upload, upload(f))).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
      await expect(f.t.query(api.v0Proof.list, { token: f.actors.subject.token, betId: f.bet })).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
      await expect(f.t.action(api.v0Proof.read, { token: f.actors.friend.token, proofId: f.proof })).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
      expect((await proofState(f)).proofs).toHaveLength(1);
    });
  }

  for (const role of ["subject", "alias", "creator", "friend"] as const) {
    it(`[V0.proof.read-role.${role}] permits eligible revealed proof reads through the actual action`, async () => {
      const f = await v0Fixture();
      vi.setSystemTime(REVEAL);
      const created = await f.t.action(api.v0Proof.upload, upload(f));
      const listed = await f.t.query(api.v0Proof.list, { token: f.actors[role].token, betId: f.bet });
      expect(listed.map((proof) => proof.id)).toContain(created.id);
      const read = await f.t.action(api.v0Proof.read, { token: f.actors[role].token, proofId: created.id });
      expect(new Uint8Array(read.bytes)).toEqual(new Uint8Array(makePng()));
    });
  }

  for (const role of ["outsider", "unadmittedAlias", "new", "left", "revoked"] as const) {
    it(`[V0.proof.read-denied.${role}] knowing proof IDs does not grant list or media access`, async () => {
      const f = await v0Fixture();
      vi.setSystemTime(REVEAL);
      const code = role === "revoked" ? "AUTH_REQUIRED" : "NOT_AVAILABLE";
      await expect(f.t.query(api.v0Proof.list, { token: f.actors[role].token, betId: f.bet })).rejects.toMatchObject({ data: { code } });
      await expect(f.t.action(api.v0Proof.read, { token: f.actors[role].token, proofId: f.proof })).rejects.toMatchObject({ data: { code } });
    });
  }

  it("[V0.proof.voided-denied] denies every media operation on a voided bet", async () => {
    const f = await v0Fixture();
    await f.t.mutation(api.v0Bets.veto, { token: f.actors.subject.token, betId: f.bet, requestId: `${f.runId}_veto` });
    vi.setSystemTime(REVEAL);
    await expect(f.t.action(api.v0Proof.upload, upload(f))).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
    await expect(f.t.query(api.v0Proof.list, { token: f.actors.friend.token, betId: f.bet })).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
    await expect(f.t.action(api.v0Proof.read, { token: f.actors.subject.token, proofId: f.proof })).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
  });

  for (const size of [0, 8, 512 * 1024 + 1]) {
    it(`[V0.proof.invalid-bytes.${size}] rejects empty, wrong-signature or oversized input without orphan files`, async () => {
      const f = await v0Fixture();
      vi.setSystemTime(REVEAL);
      const bytes = size > 8 ? makePng(size) : new ArrayBuffer(size);
      const before = await proofState(f);
      await expect(f.t.action(api.v0Proof.upload, upload(f, `${f.runId}_invalid`, bytes))).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });
      expect(await proofState(f)).toEqual(before);
    });
  }

  it("[V0.proof.exact-size-boundary] accepts an actual valid PNG exactly at the 512 KiB limit", async () => {
    const f = await v0Fixture();
    vi.setSystemTime(REVEAL);
    const bytes = makePng(512 * 1024);
    const created = await f.t.action(api.v0Proof.upload, upload(f, `${f.runId}_boundary`, bytes));
    const read = await f.t.action(api.v0Proof.read, { token: f.actors.creator.token, proofId: created.id });
    expect(read.bytes.byteLength).toBe(512 * 1024);
    expect(new Uint8Array(read.bytes)).toEqual(new Uint8Array(bytes));
  });

  it("[V0.proof.mime-and-signature] enforces the MIME allowlist and matching declared file signature", async () => {
    const f = await v0Fixture();
    vi.setSystemTime(REVEAL);
    const before = await proofState(f);
    await expect(f.t.action(api.v0Proof.upload, { ...upload(f), contentType: "image/jpeg" })).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });
    await expect(f.t.action(api.v0Proof.upload, { ...upload(f), contentType: "audio/mp4" })).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });
    await expect(f.t.action(api.v0Proof.upload, { ...upload(f), contentType: "image/svg+xml" as "image/png" })).rejects.toThrow();
    expect(await proofState(f)).toEqual(before);
  });

  it("[V0.proof.idempotent-private-storage] reuses one proof/blob across retries and verified alias devices", async () => {
    const f = await v0Fixture();
    vi.setSystemTime(REVEAL);
    const args = upload(f);
    const first = await f.t.action(api.v0Proof.upload, args);
    expect(await f.t.action(api.v0Proof.upload, args)).toEqual(first);
    expect(await f.t.action(api.v0Proof.upload, { ...args, token: f.actors.alias.token })).toEqual(first);
    const state = await proofState(f);
    expect(state.proofs).toHaveLength(2);
    expect(state.files).toHaveLength(2);
    await expect(f.t.action(api.v0Proof.upload, { ...args, bytes: makePng(128) })).rejects.toMatchObject({ data: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(await proofState(f)).toEqual(state);
  });

  it("[V0.proof.upload-quota] counts unique uploads once and bounds the actual hourly storage path", async () => {
    const f = await v0Fixture();
    vi.setSystemTime(REVEAL);
    const args = upload(f);
    await f.t.action(api.v0Proof.upload, args);
    await f.t.action(api.v0Proof.upload, args);
    for (let index = 1; index < 12; index++) await f.t.action(api.v0Proof.upload, { ...args, requestId: `${f.runId}_quota_${index}` });
    await expect(f.t.action(api.v0Proof.upload, { ...args, requestId: `${f.runId}_thirteenth` })).rejects.toMatchObject({ data: { code: "RATE_LIMITED" } });
    const state = await proofState(f);
    expect(state.proofs).toHaveLength(13);
    expect(state.files).toHaveLength(13);
    expect(await f.t.run((ctx) => ctx.db.query("v0RateLimits").withIndex("by_key", (q) => q.eq("key", `proof:${f.actors.subject.id}`)).unique())).toMatchObject({ count: 12 });
  });

  it("[V0.proof.revocation] revokes media access for one session and then all aliases without deleting other members' access", async () => {
    const f = await v0Fixture();
    vi.setSystemTime(REVEAL);
    const created = await f.t.action(api.v0Proof.upload, upload(f));
    await f.t.mutation(api.v0Auth.revoke, { token: f.actors.subject.token, allDevices: false, requestId: `${f.runId}_one` });
    await expect(f.t.action(api.v0Proof.read, { token: f.actors.subject.token, proofId: created.id })).rejects.toMatchObject({ data: { code: "AUTH_REQUIRED" } });
    expect((await f.t.action(api.v0Proof.read, { token: f.actors.alias.token, proofId: created.id })).id).toBe(created.id);
    await f.t.mutation(api.v0Auth.revoke, { token: f.actors.alias.token, allDevices: true, requestId: `${f.runId}_all` });
    await expect(f.t.action(api.v0Proof.read, { token: f.actors.alias.token, proofId: created.id })).rejects.toMatchObject({ data: { code: "AUTH_REQUIRED" } });
    expect((await f.t.action(api.v0Proof.read, { token: f.actors.friend.token, proofId: created.id })).id).toBe(created.id);
  });

  for (const role of ["friend", "subject"] as const) {
    it(`[V0.proof.leave.${role}] removes departed member media access and quietly invalidates subject bets`, async () => {
      const f = await v0Fixture();
      vi.setSystemTime(REVEAL);
      const created = await f.t.action(api.v0Proof.upload, upload(f));
      await f.t.mutation(api.v0Controls.leave, { token: f.actors[role].token, groupId: f.g1, requestId: `${f.runId}_leave` });
      await expect(f.t.action(api.v0Proof.read, { token: f.actors[role].token, proofId: created.id })).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
      if (role === "subject") {
        await expect(f.t.action(api.v0Proof.read, { token: f.actors.creator.token, proofId: created.id })).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
        expect(await f.t.run((ctx) => ctx.db.get(f.bet))).toMatchObject({ state: "voided" });
      } else {
        expect((await f.t.action(api.v0Proof.read, { token: f.actors.creator.token, proofId: created.id })).id).toBe(created.id);
      }
    });
  }

  it("[V0.proof.delete-cascade] deletes actual private rows/blobs and denies retained proof IDs", async () => {
    const f = await v0Fixture();
    vi.setSystemTime(REVEAL);
    const created = await f.t.action(api.v0Proof.upload, upload(f));
    const stored = (await proofState(f)).proofs.find((proof) => proof._id === created.id)!;
    const result = await f.t.mutation(api.v0Controls.deleteAccount, { token: f.actors.subject.token, requestId: `${f.runId}_delete` });
    expect(result).toMatchObject({ deleted: true, providerCleanup: "pending" });
    expect(await proofState(f)).toEqual({ proofs: [], files: [] });
    expect(await f.t.run((ctx) => ctx.storage.get(stored.storageId))).toBeNull();
    await expect(f.t.action(api.v0Proof.read, { token: f.actors.friend.token, proofId: created.id })).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
    await expect(f.t.action(api.v0Proof.read, { token: f.actors.subject.token, proofId: created.id })).rejects.toMatchObject({ data: { code: "AUTH_REQUIRED" } });
  });

  for (const change of ["revoke", "leave", "delete"] as const) {
    it(`[V0.proof.reauthorize-mid-read.${change}] rechecks real authorization after storage resolves and never returns stale bytes`, async () => {
      const f = await v0Fixture();
      vi.setSystemTime(REVEAL);
      const created = await f.t.action(api.v0Proof.upload, upload(f));
      const original = Blob.prototype.arrayBuffer;
      let intercepted = false;
      const storage = vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementationOnce(async function (this: Blob) {
        const bytes = await original.call(this);
        intercepted = true;
        if (change === "revoke") await f.t.mutation(api.v0Auth.revoke, { token: f.actors.friend.token, allDevices: false, requestId: `${f.runId}_mid_revoke` });
        if (change === "leave") await f.t.mutation(api.v0Controls.leave, { token: f.actors.friend.token, groupId: f.g1, requestId: `${f.runId}_mid_leave` });
        if (change === "delete") await f.t.mutation(api.v0Controls.deleteAccount, { token: f.actors.subject.token, requestId: `${f.runId}_mid_delete` });
        return bytes;
      });
      try {
        await expect(f.t.action(api.v0Proof.read, { token: f.actors.friend.token, proofId: created.id })).rejects.toMatchObject({ data: { code: change === "revoke" ? "AUTH_REQUIRED" : "NOT_AVAILABLE" } });
        expect(intercepted).toBe(true);
        expect(storage).toHaveBeenCalledTimes(1);
      } finally {
        storage.mockRestore();
      }
    });
  }
});
