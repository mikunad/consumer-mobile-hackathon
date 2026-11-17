import { describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import { fixture, ledger, REVEAL, T0 } from "../backend/fixture";

describe("SEC2 identity regressions", () => {
  it("[SEC2.pair-replay] redeems a synthetic pair once and rejects reuse", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.insert("pairs", { userId: f.actors.friend.id, code: "E2EABC", expiresAt: T0 + 60_000 }));
    const session = await f.t.mutation(api.ext.redeemPair, { code: "E2EABC", device: f.runId });
    expect(session.user._id).toBe(f.actors.friend.id);
    expect((await f.t.query(api.ext.me, { token: session.token }))?.user._id).toBe(f.actors.friend.id);
    await expect(f.t.mutation(api.ext.redeemPair, { code: "E2EABC", device: f.runId })).rejects.toThrow();
  });

  for (const expiresAt of [T0 - 1, T0]) {
    it(`[SEC2.pair-expiry.${expiresAt - T0}] rejects a code at or after expiry`, async () => {
      const f = await fixture();
      await f.t.run((ctx) => ctx.db.insert("pairs", { userId: f.actors.friend.id, code: "E2EABC", expiresAt }));
      await expect(f.t.mutation(api.ext.redeemPair, { code: "E2EABC", device: f.runId })).rejects.toThrow();
      expect(await f.t.run((ctx) => ctx.db.query("sessions").collect())).toEqual([]);
    });
  }

  it("[SEC2.username-admission] never grants a room because of a mutable username", async () => {
    const f = await fixture();
    await f.t.mutation(api.users.setProfile, { token: f.actors.alias.token, username: "mikun", emoji: "●" });
    const before = await f.t.run((ctx) => ctx.db.query("members").collect());
    const result = await f.t.mutation(api.chat.enter, { token: f.actors.alias.token });
    expect(result).toBeNull();
    expect(await f.t.run((ctx) => ctx.db.query("members").collect())).toEqual(before);
  });

  it("[SEC2.invite-recipient] does not turn knowledge of a group invite into verified account consent", async () => {
    const f = await fixture();
    const group = await f.t.run((ctx) => ctx.db.get(f.g1));
    const before = await f.t.run((ctx) => ctx.db.query("members").collect());
    await expect(f.t.mutation(api.chat.join, { token: f.actors.outsider.token, invite: group!.inviteCode! })).rejects.toThrow();
    expect(await f.t.run((ctx) => ctx.db.query("members").collect())).toEqual(before);
  });
});

describe("SEC5 server validation regressions", () => {
  for (const [category, question] of [
    ["health", "Will Sage need a hospital visit before the reveal?"],
    ["appearance", "Will Sage lose weight before the reveal?"],
    ["money", "Will Sage be unable to pay rent before the reveal?"],
    ["relationship", "Will Sage get dumped before the reveal?"],
  ]) {
    it(`[SEC5.manual-safety.${category}] rejects an unsafe manual edit on the server`, async () => {
      const f = await fixture();
      const before = await ledger(f);
      await expect(f.t.mutation(api.chat.createBet, { token: f.actors.creator.token, groupId: f.g1, subjectUserId: f.actors.subject.id, kind: "yesno", question, option: 0, amount: 0, revealAt: REVEAL })).rejects.toThrow();
      expect(await ledger(f)).toEqual(before);
    });
  }

  for (const options of [["one"], ["one", "two", "three"], ["same", "SAME"], ["", "two"]]) {
    it(`[SEC5.two-options.${options.join("_")}] enforces exactly two distinct nonempty choices`, async () => {
      const f = await fixture();
      await expect(f.t.mutation(api.chat.createBet, { token: f.actors.creator.token, groupId: f.g1, subjectUserId: f.actors.subject.id, kind: "multi", question: "Which synthetic picnic option will Sage choose?", options, option: 0, amount: 0, revealAt: REVEAL })).rejects.toThrow();
    });
  }

  it("[SEC5.admin-denied] rejects an arbitrary passcode without exposing private state", async () => {
    const f = await fixture();
    expect(await f.t.query(api.admin.check, { passcode: `synthetic_wrong_${f.runId}` })).toBe(false);
    await expect(f.t.query(api.admin.overview, { passcode: `synthetic_wrong_${f.runId}` })).rejects.toThrow("Wrong passcode");
  });

  it("[J3.3.concurrent-duplicate] never appends two picks for concurrent identical saves", async () => {
    const f = await fixture();
    const request = { token: f.actors.friend.token, betId: f.bet, option: 0, amount: 10 };
    const results = await Promise.allSettled([f.t.mutation(api.chat.stake, request), f.t.mutation(api.chat.stake, request)]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const state = await ledger(f);
    expect(state.stakes.filter((s) => s.betId === f.bet && s.userId === f.actors.friend.id)).toHaveLength(1);
    expect(state.bet?.pools).toEqual([10, 0]);
  });
});
