import { ConvexError } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { nextDefaultRevealAt } from "../../convex/v0GamePolicy";
import { hash } from "../../convex/v0Policy";
import { expectCode } from "./auth-support/errors";
import { CUTOFF, REVEAL, T0 } from "./fixture";
import { v0Fixture } from "./v0-fixture";

const confirmedAt = T0 + 60_000;
type Fixture = Awaited<ReturnType<typeof confirmationFixture>>;
type Confirmation = { saved: true; option: number; confidence: number; updatedAt: number };

async function confirmationFixture() {
  const f = await v0Fixture();
  const secondToken = `synthetic_${f.runId}_friend_second_device`;
  await f.t.run(async (ctx) => {
    for (const session of await ctx.db.query("v0Sessions").collect()) await ctx.db.patch(session._id, { expiresAt: T0 + 3 * 86_400_000 });
    await ctx.db.insert("v0Sessions", { accountId: f.actors.friend.id, tokenHash: await hash(secondToken), deviceId: `${f.runId}_friend_second_device`, createdAt: T0, expiresAt: T0 + 3 * 86_400_000 });
  });
  return { ...f, secondToken };
}

const confirmation = (f: Fixture, overrides: Partial<{ token: string; option: number; confidence: number; requestId: string }> = {}) => ({ token: f.actors.friend.token, betId: f.bet, option: 0, confidence: 0.25, requestId: "final-confirm-pick", ...overrides });

async function confirm(f: Fixture, at = confirmedAt, overrides: Parameters<typeof confirmation>[1] = {}): Promise<Confirmation> {
  vi.setSystemTime(at);
  return await f.t.run(async (ctx) => {
    expect(Date.now()).toBe(at);
    const receipt: unknown = await ctx.runMutation(api.v0Bets.pick, confirmation(f, overrides));
    expect(receipt).toEqual({ saved: true, option: overrides.option ?? 0, confidence: overrides.confidence ?? 0.25, updatedAt: at });
    return receipt as Confirmation;
  });
}

async function stored(f: Fixture) {
  return await f.t.run(async (ctx) => ({ picks: await ctx.db.query("v0Picks").collect(), requests: await ctx.db.query("v0Requests").collect(), bet: await ctx.db.get(f.bet) }));
}

async function groupBalances(f: Fixture) {
  return await f.t.run(async (ctx) => ({ ledger: await ctx.db.query("v0Ledger").collect(), memberships: (await ctx.db.query("v0Memberships").collect()).map(({ _id, groupId, accountId, points, streak, lastScoredBetId }) => ({ _id, groupId, accountId, points, streak, lastScoredBetId })) }));
}

function immutableRejection(error: unknown) {
  expect(error).toBeInstanceOf(ConvexError);
  const data = (error as ConvexError<{ code: string; message: string }>).data;
  expect(data).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  expect(Object.keys(data).sort()).toEqual(["code", "message"]);
  expect(data.code).toBe("CONFLICT");
}

async function rejectsImmutable(operation: Promise<unknown>) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  immutableRejection(failure);
}

describe("approved final server confirmation using the published v0Bets.pick protocol", () => {
  it("[CONFIRM.new-key-rate-bound-cached-retry-free] bounds new-key acknowledgments without charging cached authorized retries", async () => {
    const f = await confirmationFixture();
    const original = await confirm(f);
    const balances = await groupBalances(f);
    vi.setSystemTime(confirmedAt + 1000);
    await f.t.run(async (ctx) => {
      expect(Date.now()).toBe(confirmedAt + 1000);
      for (let index = 0; index < 80; index++) expect(await ctx.runMutation(api.v0Bets.pick, confirmation(f))).toEqual(original);
      const rate = () => ctx.db.query("v0RateLimits").withIndex("by_key", (q) => q.eq("key", `pick:${f.actors.friend.id}`)).unique();
      expect(await rate()).toMatchObject({ count: 1, windowStart: confirmedAt });
      for (let index = 0; index < 59; index++) expect(await ctx.runMutation(api.v0Bets.pick, confirmation(f, { requestId: `bounded-ack-${index}` }))).toEqual(original);
      expect(await rate()).toMatchObject({ count: 60, windowStart: confirmedAt });
      const before = await ctx.db.query("v0Requests").collect();
      await expectCode(ctx.runMutation(api.v0Bets.pick, confirmation(f, { requestId: "over-new-key-quota" })), "RATE_LIMITED");
      expect(await ctx.db.query("v0Requests").collect()).toEqual(before);
      expect(await ctx.runMutation(api.v0Bets.pick, confirmation(f))).toEqual(original);
      expect(await rate()).toMatchObject({ count: 60, windowStart: confirmedAt });
      expect(await ctx.db.query("v0Picks").collect()).toHaveLength(1);
    });
    expect(await groupBalances(f)).toEqual(balances);
  });

  it("[CONFIRM.rate-window-preserves-original-receipt] resets only quota bookkeeping after its existing window, never the confirmed pick", async () => {
    const f = await confirmationFixture();
    const original = await confirm(f);
    const balances = await groupBalances(f);
    await f.t.run(async (ctx) => {
      const row = await ctx.db.query("v0RateLimits").withIndex("by_key", (q) => q.eq("key", `pick:${f.actors.friend.id}`)).unique();
      await ctx.db.patch(row!._id, { count: 60 });
    });
    vi.setSystemTime(confirmedAt + 60_000);
    await f.t.run(async (ctx) => {
      expect(Date.now()).toBe(confirmedAt + 60_000);
      expect(await ctx.runMutation(api.v0Bets.pick, confirmation(f, { requestId: "next-quota-window" }))).toEqual(original);
      expect(await ctx.db.query("v0RateLimits").withIndex("by_key", (q) => q.eq("key", `pick:${f.actors.friend.id}`)).unique()).toMatchObject({ count: 1, windowStart: confirmedAt + 60_000 });
      expect(await ctx.db.query("v0Picks").collect()).toHaveLength(1);
    });
    expect(await groupBalances(f)).toEqual(balances);
  });

  it("[CONFIRM.wire-receipt-my-pick-unchanged] returns exactly the existing receipt and myPick fields without a new confirmation discriminator", async () => {
    const f = await confirmationFixture();
    const receipt = await confirm(f);
    expect(Object.keys(receipt).sort()).toEqual(["confidence", "option", "saved", "updatedAt"]);
    vi.setSystemTime(confirmedAt + 1000);
    const view = await f.t.query(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator });
    expect(view.view).toBe("bet");
    if (view.view !== "bet") throw new Error("Expected the eligible bettor's existing bet DTO");
    expect(view.myPick).toEqual({ option: 0, confidence: 0.25 });
    expect(Object.keys(view.myPick!).sort()).toEqual(["confidence", "option"]);
    expect(JSON.stringify({ receipt, myPick: view.myPick })).not.toContain("confirmedAt");
    expect(JSON.stringify({ receipt, myPick: view.myPick })).not.toContain('"confirm"');
  });

  for (const [name, extra, field] of [["confirm-true", { confirm: true }, "confirm"], ["confirm-false", { confirm: false }, "confirm"], ["confirmed-at", { confirmedAt }, "confirmedAt"]] as const) {
    it(`[CONFIRM.wire-reject-extra.${name}] rejects an unpublished argument through the actual exported argument validator`, async () => {
      const f = await confirmationFixture();
      const before = await stored(f);
      vi.setSystemTime(confirmedAt);
      await expect(f.t.mutation(makeFunctionReference<"mutation">("v0Bets:pick"), { ...confirmation(f), ...extra })).rejects.toThrow(`Validator error: Unexpected field \`${field}\` in object`);
      expect(await stored(f)).toEqual(before);
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it("[CONFIRM.first-server-acceptance] persists one immutable account/group/membership-bound choice and confidence without a debit", async () => {
    const f = await confirmationFixture();
    const balances = await groupBalances(f);
    const originalBet = await f.t.run((ctx) => ctx.db.get(f.bet));
    expect(await confirm(f)).toEqual({ saved: true, option: 0, confidence: 0.25, updatedAt: confirmedAt });
    const state = await stored(f);
    expect(state.picks).toHaveLength(1);
    expect(state.picks[0]).toMatchObject({ betId: f.bet, groupId: f.g1, accountId: f.actors.friend.id, option: 0, confidence: 0.25, placedAt: confirmedAt, updatedAt: confirmedAt });
    expect(state.picks[0]).not.toHaveProperty("riskPoints");
    expect(state.picks[0]).not.toHaveProperty("voidedAt");
    const membership = await f.t.run((ctx) => ctx.db.query("v0Memberships").withIndex("by_group_account", (q) => q.eq("groupId", f.g1).eq("accountId", f.actors.friend.id)).unique());
    expect(state.picks[0].membershipId).toBe(membership!._id);
    expect(state.bet).toEqual(originalBet);
    expect(await groupBalances(f)).toEqual(balances);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("[CONFIRM.unconfirmed-capability] exposes confirmation to an eligible unconfirmed bettor without exposing the subject's sealed content", async () => {
    const f = await confirmationFixture();
    vi.setSystemTime(confirmedAt);
    await f.t.run(async (ctx) => {
      expect(Date.now()).toBe(confirmedAt);
      expect(await ctx.runQuery(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator })).toMatchObject({ view: "bet", canPick: true, myPick: null, canAnswer: false });
      const subject = await ctx.runQuery(api.v0Bets.get, { token: f.actors.subject.token, locator: f.locator });
      expect(subject).toMatchObject({ view: "sealed" });
      for (const secret of f.privateValues) expect(JSON.stringify(subject)).not.toContain(secret);
      expect(await ctx.db.query("v0Picks").collect()).toEqual([]);
    });
  });

  for (const [name, option, confidence] of [["choice", 1, 0.25], ["confidence", 0, 0.75], ["both", 1, 1]] as const) {
    it(`[CONFIRM.immutable-${name}] rejects a fresh request that changes an already confirmed value`, async () => {
      const f = await confirmationFixture();
      await confirm(f);
      const before = await stored(f);
      const balances = await groupBalances(f);
      vi.setSystemTime(confirmedAt + 1000);
      await rejectsImmutable(f.t.mutation(api.v0Bets.pick, confirmation(f, { option, confidence, requestId: "attempt-edit" })));
      expect(await stored(f)).toEqual(before);
      expect(await groupBalances(f)).toEqual(balances);
      expect(await f.t.query(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator })).toMatchObject({ canPick: false, myPick: { option: 0, confidence: 0.25 } });
    });
  }

  for (const elapsed of [1, 5 * 60_000, 10 * 60_000 - 1]) {
    it(`[CONFIRM.no-grace.${elapsed}] locks the bettor immediately without an edit interval or ten-minute grace`, async () => {
      const f = await confirmationFixture();
      await confirm(f);
      const before = await stored(f);
      vi.setSystemTime(confirmedAt + elapsed);
      await f.t.run(async (ctx) => {
        expect(Date.now()).toBe(confirmedAt + elapsed);
        await rejectsImmutable(ctx.runMutation(api.v0Bets.pick, confirmation(f, { option: 1, confidence: 0.9, requestId: "no-grace-edit" })));
        expect(await ctx.runQuery(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator })).toMatchObject({ canPick: false, myPick: { option: 0, confidence: 0.25 } });
      });
      expect(await stored(f)).toEqual(before);
    });
  }

  it("[CONFIRM.same-request-argument-conflict] rejects changed confirmation arguments under an existing request ID", async () => {
    const f = await confirmationFixture();
    await confirm(f);
    const before = await stored(f);
    vi.setSystemTime(confirmedAt + 1000);
    await expectCode(f.t.mutation(api.v0Bets.pick, confirmation(f, { option: 1, confidence: 0.9 })), "IDEMPOTENCY_CONFLICT");
    expect(await stored(f)).toEqual(before);
  });

  for (const at of [confirmedAt + 1000, REVEAL + 1000]) {
    it(`[CONFIRM.matching-new-key.${at}] returns the original immutable receipt for a matching selection under a new request ID`, async () => {
      const f = await confirmationFixture();
      const original = await confirm(f);
      const picks = (await stored(f)).picks;
      const balances = await groupBalances(f);
      vi.setSystemTime(at);
      const args = confirmation(f, { requestId: "matching-new-request" });
      expect(await f.t.mutation(api.v0Bets.pick, args)).toEqual(original);
      const after = await stored(f);
      expect(after.picks).toEqual(picks);
      expect(await f.t.mutation(api.v0Bets.pick, args)).toEqual(original);
      expect(await stored(f)).toEqual(after);
      expect(await groupBalances(f)).toEqual(balances);
    });
  }

  for (const invalidation of ["voided-bet", "voided-pick", "foreign-group", "foreign-membership", "duplicate-row"] as const) {
    it(`[CONFIRM.replay-stored-guard.${invalidation}] validates the current authoritative confirmation before replaying its receipt`, async () => {
      const f = await confirmationFixture();
      await confirm(f);
      vi.setSystemTime(confirmedAt + 1000);
      if (invalidation === "voided-bet") await f.t.mutation(api.v0Bets.veto, { token: f.actors.subject.token, betId: f.bet, requestId: "veto-confirmed" });
      else await f.t.run(async (ctx) => {
        const pick = (await ctx.db.query("v0Picks").collect())[0];
        if (invalidation === "voided-pick") await ctx.db.patch(pick._id, { voidedAt: Date.now() });
        if (invalidation === "foreign-group") await ctx.db.patch(pick._id, { groupId: f.g2 });
        if (invalidation === "foreign-membership") {
          const member = await ctx.db.query("v0Memberships").withIndex("by_group_account", (q) => q.eq("groupId", f.g2).eq("accountId", f.actors.creator.id)).unique();
          await ctx.db.patch(pick._id, { membershipId: member!._id });
        }
        if (invalidation === "duplicate-row") await ctx.db.insert("v0Picks", { betId: pick.betId, groupId: pick.groupId, accountId: pick.accountId, membershipId: pick.membershipId, option: pick.option, confidence: pick.confidence, placedAt: pick.placedAt, updatedAt: pick.updatedAt });
      });
      const before = await stored(f);
      vi.setSystemTime(confirmedAt + 2000);
      await expectCode(f.t.mutation(api.v0Bets.pick, confirmation(f)), invalidation === "duplicate-row" ? "CONFLICT" : "NOT_AVAILABLE");
      expect(await stored(f)).toEqual(before);
    });
  }

  it("[CONFIRM.rejoin-old-interval-denied] does not restore an old confirmation receipt after leaving and accepting a new membership interval", async () => {
    const f = await confirmationFixture();
    await confirm(f);
    vi.setSystemTime(confirmedAt + 1000);
    await f.t.mutation(api.v0Controls.leave, { token: f.actors.friend.token, groupId: f.g1, requestId: "leave-old-interval" });
    await f.t.mutation(api.v0Groups.invite, { token: f.actors.creator.token, groupId: f.g1, phone: f.actors.friend.phone, requestId: "invite-new-interval" });
    const invitation = (await f.t.query(api.v0Groups.invitations, { token: f.actors.friend.token }))[0];
    expect(invitation).toBeDefined();
    await f.t.mutation(api.v0Groups.accept, { token: f.actors.friend.token, inviteId: invitation.id, requestId: "accept-new-interval" });
    const before = await stored(f);
    vi.setSystemTime(confirmedAt + 2000);
    await expectCode(f.t.mutation(api.v0Bets.pick, confirmation(f)), "NOT_AVAILABLE");
    await expectCode(f.t.query(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator }), "NOT_AVAILABLE");
    expect(await stored(f)).toEqual(before);
  });

  it("[CONFIRM.other-bettor-independent] locks only the confirming bettor and allows a second eligible account to confirm independently", async () => {
    const f = await confirmationFixture();
    const balances = await groupBalances(f);
    const originalBet = await f.t.run((ctx) => ctx.db.get(f.bet));
    await confirm(f);
    vi.setSystemTime(confirmedAt + 1000);
    await f.t.run(async (ctx) => {
      expect(Date.now()).toBe(confirmedAt + 1000);
      expect(await ctx.runQuery(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator })).toMatchObject({ canPick: false, myPick: { option: 0, confidence: 0.25 } });
      expect(await ctx.runQuery(api.v0Bets.get, { token: f.actors.creator.token, locator: f.locator })).toMatchObject({ canPick: true, myPick: null });
      expect(await ctx.runMutation(api.v0Bets.pick, confirmation(f, { token: f.actors.creator.token, option: 1, confidence: 0.75 }))).toEqual({ saved: true, option: 1, confidence: 0.75, updatedAt: confirmedAt + 1000 });
      expect(await ctx.runQuery(api.v0Bets.get, { token: f.actors.creator.token, locator: f.locator })).toMatchObject({ canPick: false, myPick: { option: 1, confidence: 0.75 } });
      const picks = await ctx.db.query("v0Picks").collect();
      expect(picks).toHaveLength(2);
      expect(new Set(picks.map((pick) => pick.accountId))).toEqual(new Set([f.actors.friend.id, f.actors.creator.id]));
      expect(await ctx.db.get(f.bet)).toEqual(originalBet);
    });
    expect(await groupBalances(f)).toEqual(balances);
  });

  for (const offset of [-1, 0, 1]) {
    it(`[CONFIRM.old-global-cutoff-ignored.${offset}] allows an unconfirmed eligible bettor before reveal despite the obsolete shared cutoff`, async () => {
      const f = await confirmationFixture();
      const at = CUTOFF + offset;
      await confirm(f, at);
      expect((await stored(f)).picks).toHaveLength(1);
    });
  }

  for (const offset of [-1, 0, 1]) {
    it(`[CONFIRM.reveal-boundary.${offset}] admits a new confirmation strictly before reveal and rejects at or after it`, async () => {
      const f = await confirmationFixture();
      const balances = await groupBalances(f);
      const at = REVEAL + offset;
      vi.setSystemTime(at);
      await f.t.run(async (ctx) => {
        expect(Date.now()).toBe(at);
        if (offset < 0) {
          expect(await ctx.runMutation(api.v0Bets.pick, confirmation(f))).toEqual({ saved: true, option: 0, confidence: 0.25, updatedAt: at });
          expect(await ctx.db.query("v0Picks").unique()).toMatchObject({ placedAt: at, updatedAt: at });
        } else {
          await expectCode(ctx.runMutation(api.v0Bets.pick, confirmation(f)), "NOT_AVAILABLE");
          expect(await ctx.db.query("v0Picks").collect()).toEqual([]);
          expect(await ctx.db.query("v0Requests").collect()).toEqual([]);
          expect(await ctx.runQuery(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator })).toMatchObject({ canPick: false, myPick: null });
        }
      });
      expect(await groupBalances(f)).toEqual(balances);
    });
  }

  it("[CONFIRM.lost-ack-idempotent-retry] returns a stable receipt after the client discards a successful response without moving either stored timestamp", async () => {
    const f = await confirmationFixture();
    await confirm(f);
    const before = await stored(f);
    expect(before.picks).toHaveLength(1);
    vi.setSystemTime(confirmedAt + 1000);
    expect(await f.t.mutation(api.v0Bets.pick, confirmation(f))).toEqual({ saved: true, option: 0, confidence: 0.25, updatedAt: confirmedAt });
    expect(await stored(f)).toEqual(before);
  });

  it("[CONFIRM.confirmed-retry-after-reveal] replays an existing confirmation after admissions close without creating a late pick", async () => {
    const f = await confirmationFixture();
    const original = await confirm(f);
    const before = await stored(f);
    vi.setSystemTime(REVEAL + 1000);
    expect(await f.t.mutation(api.v0Bets.pick, confirmation(f))).toEqual(original);
    expect(await stored(f)).toEqual(before);
  });

  it("[CONFIRM.second-device-same-account] shares the same immutable confirmation and idempotent receipt across authenticated devices", async () => {
    const f = await confirmationFixture();
    const original = await confirm(f);
    const before = await stored(f);
    vi.setSystemTime(confirmedAt + 1000);
    expect(await f.t.mutation(api.v0Bets.pick, confirmation(f, { token: f.secondToken }))).toEqual(original);
    await rejectsImmutable(f.t.mutation(api.v0Bets.pick, confirmation(f, { token: f.secondToken, option: 1, requestId: "second-device-edit" })));
    expect(await stored(f)).toEqual(before);
  });

  for (const invalidation of ["revoked", "left", "blocked"] as const) {
    it(`[CONFIRM.retry-current-auth.${invalidation}] reauthorizes before returning a cached confirmation`, async () => {
      const f = await confirmationFixture();
      await confirm(f);
      vi.setSystemTime(confirmedAt + 1000);
      if (invalidation === "revoked") await f.t.mutation(api.v0Auth.revoke, { token: f.actors.friend.token, allDevices: false, requestId: "revoke" });
      if (invalidation === "left") await f.t.mutation(api.v0Controls.leave, { token: f.actors.friend.token, groupId: f.g1, requestId: "leave" });
      if (invalidation === "blocked") await f.t.mutation(api.v0Controls.block, { token: f.actors.friend.token, accountId: f.actors.subject.id, requestId: "block" });
      const before = await stored(f);
      vi.setSystemTime(confirmedAt + 2000);
      await expectCode(f.t.mutation(api.v0Bets.pick, confirmation(f)), invalidation === "revoked" ? "AUTH_REQUIRED" : "NOT_AVAILABLE");
      expect(await stored(f)).toEqual(before);
    });
  }

  it("[CONFIRM.two-outstanding-memory-requests] has one logical winner for competing confirmations in convex-test, not evidence of a real OCC race", async () => {
    const f = await confirmationFixture();
    const balances = await groupBalances(f);
    vi.setSystemTime(confirmedAt);
    const choices = [confirmation(f, { option: 0, confidence: 0.25, requestId: "competing-a" }), confirmation(f, { option: 1, confidence: 0.75, requestId: "competing-b" })];
    const results = await Promise.allSettled(choices.map((args) => f.t.mutation(api.v0Bets.pick, args)));
    const successes = results.flatMap((result, index) => result.status === "fulfilled" ? [{ receipt: result.value as unknown, choice: choices[index] }] : []);
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    immutableRejection(failures[0]);
    expect(successes[0].receipt).toMatchObject({ saved: true, option: successes[0].choice.option, confidence: successes[0].choice.confidence, updatedAt: expect.any(Number) });
    const state = await stored(f);
    expect(state.picks).toHaveLength(1);
    expect(state.picks[0]).toMatchObject({ accountId: f.actors.friend.id, betId: f.bet, option: successes[0].choice.option, confidence: successes[0].choice.confidence });
    expect(await groupBalances(f)).toEqual(balances);
  });

  for (const confidence of [0.01, 1]) {
    it(`[CONFIRM.confidence-accepted.${confidence}] accepts the approved confidence endpoint as an immutable final confirmation`, async () => {
      const f = await confirmationFixture();
      await confirm(f, confirmedAt, { confidence });
      expect((await stored(f)).picks).toHaveLength(1);
    });
  }

  for (const role of ["subject", "alias", "outsider", "unadmittedAlias", "revoked", "new", "left"] as const) {
    it(`[CONFIRM.ineligible.${role}] rejects an ineligible final confirmation without creating a pick or receipt`, async () => {
      const f = await confirmationFixture();
      vi.setSystemTime(confirmedAt);
      await expectCode(f.t.mutation(api.v0Bets.pick, confirmation(f, { token: f.actors[role].token })), role === "revoked" ? "AUTH_REQUIRED" : "NOT_AVAILABLE");
      expect((await stored(f)).picks).toEqual([]);
      expect((await stored(f)).requests).toEqual([]);
    });
  }
});

const createArgs = (f: Fixture) => ({ token: f.actors.creator.token, groupId: f.g1, subjectId: f.actors.subject.id, question: "Will Sage bring a puzzle to the picnic?", contextLine: "A synthetic picnic", format: "yes_no", options: ["Yes", "No"], source: "manual", requestId: "create-cutoff-compatibility" });

describe("approved optional cutoff compatibility validation, not functional creation", () => {
  for (const [name, cutoffAt, revealAt, code] of [
    ["omitted", undefined, REVEAL, "POLICY_PENDING"],
    ["equal", REVEAL, REVEAL, "POLICY_PENDING"],
    ["one-ms-before", REVEAL - 1, REVEAL, "INVALID_INPUT"],
    ["one-ms-after", REVEAL + 1, REVEAL, "INVALID_INPUT"],
    ["legacy-early-cutoff", CUTOFF, REVEAL, "INVALID_INPUT"],
    ["omitted-reveal-past", undefined, confirmedAt - 1, "INVALID_INPUT"],
    ["omitted-reveal-now", undefined, confirmedAt, "INVALID_INPUT"],
    ["omitted-reveal-next-ms", undefined, confirmedAt + 1, "POLICY_PENDING"],
    ["nonfinite-cutoff", Infinity, REVEAL, "INVALID_INPUT"],
    ["nonfinite-reveal", undefined, Infinity, "INVALID_INPUT"],
  ] as const) {
    it(`[CONFIRM.create-cutoff.explicit.${name}] accepts only omitted or exactly matching future scheduling inputs before the unresolved creator gate`, async () => {
      const f = await confirmationFixture();
      const balances = await groupBalances(f);
      const bets = await f.t.run((ctx) => ctx.db.query("v0Bets").collect());
      vi.setSystemTime(confirmedAt);
      await f.t.run(async (ctx) => {
        expect(Date.now()).toBe(confirmedAt);
        await expectCode(ctx.runMutation(makeFunctionReference<"mutation">("v0Bets:create"), { ...createArgs(f), revealAt, ...(cutoffAt === undefined ? {} : { cutoffAt }) }), code);
        expect(await ctx.db.query("v0Bets").collect()).toEqual(bets);
        expect(await ctx.db.query("v0Requests").collect()).toEqual([]);
      });
      expect(await groupBalances(f)).toEqual(balances);
    });
  }

  for (const [zoneName, zone, expected] of [["utc", "UTC", "2026-11-16T20:00:00Z"], ["los-angeles", "America/Los_Angeles", "2026-11-17T04:00:00Z"], ["tokyo", "Asia/Tokyo", "2026-11-17T11:00:00Z"]] as const) {
    for (const mode of ["omitted", "equal", "before", "after"] as const) {
      it(`[CONFIRM.create-cutoff.default.${zoneName}.${mode}] validates cutoff equality against the resolved group-local reveal without creating a bet`, async () => {
        const f = await confirmationFixture();
        await f.t.run((ctx) => ctx.db.patch(f.g1, { timezone: zone }));
        const balances = await groupBalances(f);
        const bets = await f.t.run((ctx) => ctx.db.query("v0Bets").collect());
        const expectedReveal = Date.parse(expected);
        vi.setSystemTime(confirmedAt);
        await f.t.run(async (ctx) => {
          expect(Date.now()).toBe(confirmedAt);
          expect(nextDefaultRevealAt(zone, Date.now())).toBe(expectedReveal);
          const cutoffAt = expectedReveal + (mode === "before" ? -1 : mode === "after" ? 1 : 0);
          await expectCode(ctx.runMutation(makeFunctionReference<"mutation">("v0Bets:create"), { ...createArgs(f), ...(mode === "omitted" ? {} : { cutoffAt }) }), mode === "omitted" || mode === "equal" ? "POLICY_PENDING" : "INVALID_INPUT");
          expect(await ctx.db.query("v0Bets").collect()).toEqual(bets);
          expect(await ctx.db.query("v0Requests").collect()).toEqual([]);
        });
        expect(await groupBalances(f)).toEqual(balances);
      });
    }
  }

  for (const offset of [-1, 0, 1]) {
    for (const mode of ["omitted", "equal", "before", "after"] as const) {
      it(`[CONFIRM.create-cutoff.default-strict-future.${offset}.${mode}] resolves the next strictly future 20:00 before validating optional cutoff equality`, async () => {
        const f = await confirmationFixture();
        await f.t.run((ctx) => ctx.db.patch(f.g1, { timezone: "UTC" }));
        const bets = await f.t.run((ctx) => ctx.db.query("v0Bets").collect());
        const today = Date.parse("2026-11-16T20:00:00Z");
        const at = today + offset;
        const expectedReveal = offset < 0 ? today : Date.parse("2026-11-17T20:00:00Z");
        vi.setSystemTime(at);
        await f.t.run(async (ctx) => {
          expect(Date.now()).toBe(at);
          expect(nextDefaultRevealAt("UTC", Date.now())).toBe(expectedReveal);
          expect(expectedReveal).toBeGreaterThan(at);
          const cutoffAt = expectedReveal + (mode === "before" ? -1 : mode === "after" ? 1 : 0);
          await expectCode(ctx.runMutation(makeFunctionReference<"mutation">("v0Bets:create"), { ...createArgs(f), ...(mode === "omitted" ? {} : { cutoffAt }) }), mode === "omitted" || mode === "equal" ? "POLICY_PENDING" : "INVALID_INPUT");
          expect(await ctx.db.query("v0Bets").collect()).toEqual(bets);
          expect(await ctx.db.query("v0Requests").collect()).toEqual([]);
        });
      });
    }
  }
});
