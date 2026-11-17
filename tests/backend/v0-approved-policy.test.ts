import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { nextDefaultRevealAt } from "../../convex/v0GamePolicy";
import { queueNotification } from "../../convex/v0Notifications";
import { makePng } from "../fixtures/png.mjs";
import { expectCode } from "./auth-support/errors";
import { CUTOFF, REVEAL, T0 } from "./fixture";
import { v0Fixture } from "./v0-fixture";

const hour = 3_600_000;
const day = 86_400_000;
const answerTime = REVEAL + 17 * 60_000 + 123;
const timeout = REVEAL + day;
type Fixture = Awaited<ReturnType<typeof policyFixture>>;

async function policyFixture(state: "open" | "locked" | "revealed" = "revealed") {
  const f = await v0Fixture();
  await f.t.run(async (ctx) => {
    for (const session of await ctx.db.query("v0Sessions").collect()) await ctx.db.patch(session._id, { expiresAt: REVEAL + 10 * day });
    await ctx.db.patch(f.bet, { state, answerDeadline: REVEAL + 3 * day });
    for (const [index, role] of (["creator", "friend"] as const).entries()) {
      const member = await ctx.db.query("v0Memberships").withIndex("by_group_account", (q) => q.eq("groupId", f.g1).eq("accountId", f.actors[role].id)).unique();
      await ctx.db.patch(member!._id, { points: 713 + index, streak: 3 + index });
      await ctx.db.insert("v0Picks", { groupId: f.g1, betId: f.bet, accountId: f.actors[role].id, membershipId: member!._id, option: index, confidence: index ? 1 : 0.01, riskPoints: 7, placedAt: T0, updatedAt: T0 });
    }
  });
  return f;
}

async function scoreState(f: Awaited<ReturnType<typeof v0Fixture>>) {
  return await f.t.run(async (ctx) => ({
    ledger: await ctx.db.query("v0Ledger").collect(),
    groups: await ctx.db.query("v0Groups").collect(),
    members: (await ctx.db.query("v0Memberships").collect()).map(({ _id, accountId, groupId, points, streak, lastScoredBetId }) => ({ _id, accountId, groupId, points, streak, lastScoredBetId })),
  }));
}

const answerArgs = (f: Fixture, token = f.actors.subject.token) => ({ token, betId: f.bet, option: 0, requestId: "approved-answer" });
const challengeArgs = (f: Fixture, token = f.actors.friend.token) => ({ token, betId: f.bet, requestId: "approved-challenge" });
const event = (f: Fixture, key = "approved-policy-event") => ({ key, accountId: f.actors.friend.id, groupId: f.g1, betId: f.bet, kind: "reveal" as const });

async function recordedAnswer(f: Fixture, at = answerTime) {
  vi.setSystemTime(at);
  return await f.t.run(async (ctx) => {
    expect(Date.now()).toBe(at);
    const result = await ctx.runMutation(api.v0Bets.answer, answerArgs(f));
    expect(result).toEqual({ state: "provisional", challengeDeadline: at + hour });
    expect(await ctx.db.get(f.bet)).toMatchObject({ state: "provisional", answeredAt: at, provisionalOutcome: 0, answerDeadline: timeout, challengeDeadline: at + hour, policyVersion: "v0-policy.2" });
    return result;
  });
}

describe("approved server answer and challenge windows, not settlement policy", () => {
  for (const offset of [-1, 0, 1]) {
    it(`[APPROVED.answer.reveal-boundary.${offset}] admits the subject only at or after the recorded reveal`, async () => {
      const f = await policyFixture("locked");
      const before = await scoreState(f);
      const at = REVEAL + offset;
      vi.setSystemTime(at);
      await f.t.run(async (ctx) => {
        expect(Date.now()).toBe(at);
        const subject = await ctx.runQuery(api.v0Bets.get, { token: f.actors.subject.token, locator: f.locator });
        const friend = await ctx.runQuery(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator });
        expect(subject.serverTime).toBe(at);
        expect(friend).toMatchObject({ view: "bet", canAnswer: false, canChallenge: false });
        if (offset < 0) {
          expect(subject).toMatchObject({ view: "sealed", state: "open", cutoffAt: REVEAL });
          await expectCode(ctx.runMutation(api.v0Bets.answer, answerArgs(f)), "NOT_AVAILABLE");
          expect(await ctx.db.get(f.bet)).not.toHaveProperty("answeredAt");
        } else {
          expect(subject).toMatchObject({ view: "bet", state: "revealed", canAnswer: true, answerDeadline: timeout });
          expect(await ctx.runMutation(api.v0Bets.answer, answerArgs(f))).toEqual({ state: "provisional", challengeDeadline: at + hour });
          expect(await ctx.db.get(f.bet)).toMatchObject({ answeredAt: at, challengeDeadline: at + hour, answerDeadline: timeout });
        }
      });
      expect(await scoreState(f)).toEqual(before);
    });
  }

  for (const offset of [-1, 0, 1]) {
    it(`[APPROVED.unanswered.answer-boundary.${offset}] enforces the strict 24-hour write boundary without an auth-expiry false positive`, async () => {
      const f = await policyFixture();
      const before = await scoreState(f);
      const at = timeout + offset;
      vi.setSystemTime(at);
      await f.t.run(async (ctx) => {
        expect(Date.now()).toBe(at);
        expect(await ctx.runQuery(api.v0Auth.me, { token: f.actors.subject.token })).toMatchObject({ account: { id: f.actors.subject.id }, expiresAt: REVEAL + 10 * day });
        if (offset < 0) {
          expect(await ctx.runMutation(api.v0Bets.answer, answerArgs(f))).toEqual({ state: "provisional", challengeDeadline: at + hour });
          expect(await ctx.db.get(f.bet)).toMatchObject({ answeredAt: at, challengeDeadline: at + hour, state: "provisional" });
          expect(at + hour).toBeGreaterThan(timeout);
        } else {
          await expectCode(ctx.runMutation(api.v0Bets.answer, answerArgs(f)), "NOT_AVAILABLE");
          expect(await ctx.db.get(f.bet)).toMatchObject({ state: "revealed" });
          expect(await ctx.db.get(f.bet)).not.toHaveProperty("answeredAt");
        }
      });
      expect(await scoreState(f)).toEqual(before);
    });
  }

  for (const role of ["subject", "alias", "creator", "friend", "outsider", "unadmittedAlias", "revoked", "new", "left"] as const) {
    it(`[APPROVED.answer.role.${role}] uses stable subject identity and historical membership rather than a name`, async () => {
      const f = await policyFixture();
      const before = await scoreState(f);
      vi.setSystemTime(answerTime);
      await f.t.run(async (ctx) => {
        expect(Date.now()).toBe(answerTime);
        const operation = ctx.runMutation(api.v0Bets.answer, answerArgs(f, f.actors[role].token));
        if (role === "subject" || role === "alias") {
          expect(await operation).toEqual({ state: "provisional", challengeDeadline: answerTime + hour });
          expect(await ctx.db.get(f.bet)).toMatchObject({ answeredAt: answerTime });
        } else {
          await expectCode(operation, role === "revoked" ? "AUTH_REQUIRED" : "NOT_AVAILABLE");
          expect(await ctx.db.get(f.bet)).not.toHaveProperty("answeredAt");
        }
      });
      expect(await scoreState(f)).toEqual(before);
    });
  }

  it("[APPROVED.answer.replay-stable] keeps the recorded server timestamps on same-request retries before and after the challenge window", async () => {
    const f = await policyFixture();
    const before = await scoreState(f);
    const original = await recordedAnswer(f);
    const stored = await f.t.run((ctx) => ctx.db.get(f.bet));
    const receipts = await f.t.run((ctx) => ctx.db.query("v0Requests").collect());
    for (const at of [answerTime + 30 * 60_000, answerTime + 2 * hour, timeout + hour]) {
      vi.setSystemTime(at);
      expect(await f.t.mutation(api.v0Bets.answer, answerArgs(f))).toEqual(original);
      expect(await f.t.run((ctx) => ctx.db.get(f.bet))).toEqual(stored);
      expect(await f.t.run((ctx) => ctx.db.query("v0Requests").collect())).toEqual(receipts);
    }
    await expectCode(f.t.mutation(api.v0Bets.answer, { ...answerArgs(f), option: 1 }), "IDEMPOTENCY_CONFLICT");
    await expectCode(f.t.mutation(api.v0Bets.answer, { ...answerArgs(f), requestId: "another-answer" }), "NOT_AVAILABLE");
    expect(await scoreState(f)).toEqual(before);
  });

  for (const option of [-1, 0.5, 2]) {
    it(`[APPROVED.answer.invalid-option.${option}] rejects a non-outcome without recording an answer`, async () => {
      const f = await policyFixture();
      vi.setSystemTime(answerTime);
      await expectCode(f.t.mutation(api.v0Bets.answer, { ...answerArgs(f), option }), "INVALID_INPUT");
      expect(await f.t.run((ctx) => ctx.db.get(f.bet))).not.toHaveProperty("answeredAt");
      expect(await f.t.run((ctx) => ctx.db.query("v0Requests").collect())).toEqual([]);
    });
  }

  for (const operation of ["answer", "challenge"] as const) {
    for (const invalidation of ["revoked", "left", "blocked"] as const) {
      it(`[APPROVED.${operation}.replay-auth.${invalidation}] reauthorizes before returning an existing receipt`, async () => {
        const f = await policyFixture();
        await recordedAnswer(f);
        const actor = operation === "answer" ? f.actors.subject : f.actors.friend;
        if (operation === "challenge") {
          vi.setSystemTime(answerTime + 1000);
          expect(await f.t.mutation(api.v0Bets.challenge, challengeArgs(f))).toEqual({ recorded: true });
        }
        vi.setSystemTime(answerTime + 10_000);
        if (invalidation === "revoked") await f.t.mutation(api.v0Auth.revoke, { token: actor.token, allDevices: false, requestId: "revoke" });
        if (invalidation === "left") await f.t.mutation(api.v0Controls.leave, { token: actor.token, groupId: f.g1, requestId: "leave" });
        if (invalidation === "blocked") await f.t.mutation(api.v0Controls.block, { token: actor.token, accountId: operation === "answer" ? f.actors.creator.id : f.actors.subject.id, requestId: "block" });
        const stored = await f.t.run(async (ctx) => ({ bet: await ctx.db.get(f.bet), challenges: await ctx.db.query("v0Challenges").collect(), receipts: await ctx.db.query("v0Requests").collect() }));
        vi.setSystemTime(answerTime + 20_000);
        await expectCode(operation === "answer" ? f.t.mutation(api.v0Bets.answer, answerArgs(f, actor.token)) : f.t.mutation(api.v0Bets.challenge, challengeArgs(f, actor.token)), invalidation === "revoked" ? "AUTH_REQUIRED" : "NOT_AVAILABLE");
        expect(await f.t.run(async (ctx) => ({ bet: await ctx.db.get(f.bet), challenges: await ctx.db.query("v0Challenges").collect(), receipts: await ctx.db.query("v0Requests").collect() }))).toEqual(stored);
      });
    }
  }

  for (const obsoleteDeadline of ["earlier", "later"] as const) {
    for (const offset of [-1, 0, 1]) {
      it(`[APPROVED.challenge.boundary.${obsoleteDeadline}.${offset}] uses one hour from answeredAt rather than the obsolete stored deadline`, async () => {
        const f = await policyFixture();
        const before = await scoreState(f);
        await recordedAnswer(f);
        await f.t.run((ctx) => ctx.db.patch(f.bet, { challengeDeadline: answerTime + (obsoleteDeadline === "earlier" ? 1 : 3 * hour) }));
        const at = answerTime + hour + offset;
        vi.setSystemTime(at);
        await f.t.run(async (ctx) => {
          expect(Date.now()).toBe(at);
          const view = await ctx.runQuery(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator });
          expect(view).toMatchObject({ view: "bet", state: "provisional", canAnswer: false, canChallenge: offset < 0, challengeDeadline: answerTime + hour, provisionalOutcome: 0 });
          if (offset < 0) {
            expect(await ctx.runMutation(api.v0Bets.challenge, challengeArgs(f))).toEqual({ recorded: true });
            expect(await ctx.db.query("v0Challenges").unique()).toMatchObject({ accountId: f.actors.friend.id, createdAt: at });
          } else {
            await expectCode(ctx.runMutation(api.v0Bets.challenge, challengeArgs(f)), "NOT_AVAILABLE");
            expect(await ctx.db.query("v0Challenges").collect()).toEqual([]);
          }
          expect(await ctx.db.get(f.bet)).toMatchObject({ state: "provisional", answeredAt: answerTime });
        });
        expect(await scoreState(f)).toEqual(before);
      });
    }
  }

  for (const role of ["subject", "alias", "creator", "friend", "outsider", "unadmittedAlias", "revoked", "new", "left"] as const) {
    it(`[APPROVED.challenge.role.${role}] permits eligible non-subject members only`, async () => {
      const f = await policyFixture();
      await recordedAnswer(f);
      vi.setSystemTime(answerTime + 1000);
      await f.t.run(async (ctx) => {
        expect(Date.now()).toBe(answerTime + 1000);
        const request = ctx.runMutation(api.v0Bets.challenge, challengeArgs(f, f.actors[role].token));
        if (role === "friend" || role === "creator") {
          expect(await request).toEqual({ recorded: true });
          expect(await ctx.db.query("v0Challenges").unique()).toMatchObject({ accountId: f.actors[role].id });
        } else {
          await expectCode(request, role === "revoked" ? "AUTH_REQUIRED" : "NOT_AVAILABLE");
          expect(await ctx.db.query("v0Challenges").collect()).toEqual([]);
        }
      });
    });
  }

  it("[APPROVED.challenge.unique-late-ack] records one challenge and treats a cached late acknowledgment as no new vote or reopened window", async () => {
    const f = await policyFixture();
    const before = await scoreState(f);
    await recordedAnswer(f);
    const challengedAt = answerTime + 5 * 60_000;
    vi.setSystemTime(challengedAt);
    await f.t.run(async (ctx) => {
      expect(Date.now()).toBe(challengedAt);
      expect(await ctx.runMutation(api.v0Bets.challenge, challengeArgs(f))).toEqual({ recorded: true });
      expect(await ctx.runMutation(api.v0Bets.challenge, challengeArgs(f))).toEqual({ recorded: true });
      expect(await ctx.runMutation(api.v0Bets.challenge, { ...challengeArgs(f), requestId: "another-same-person-request" })).toEqual({ recorded: true });
      expect(await ctx.db.query("v0Challenges").unique()).toMatchObject({ createdAt: challengedAt, accountId: f.actors.friend.id });
      expect(await ctx.runQuery(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator })).toMatchObject({ canChallenge: false });
    });
    const stable = await f.t.run(async (ctx) => ({ bet: await ctx.db.get(f.bet), challenges: await ctx.db.query("v0Challenges").collect(), receipts: await ctx.db.query("v0Requests").collect() }));
    vi.setSystemTime(answerTime + hour + 1000);
    expect(await f.t.mutation(api.v0Bets.challenge, challengeArgs(f))).toEqual({ recorded: true });
    await expectCode(f.t.mutation(api.v0Bets.challenge, { ...challengeArgs(f), requestId: "fresh-late-request" }), "NOT_AVAILABLE");
    await expectCode(f.t.mutation(api.v0Bets.challenge, { ...challengeArgs(f, f.actors.creator.token), requestId: "fresh-late-person" }), "NOT_AVAILABLE");
    expect(await f.t.query(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator })).toMatchObject({ canChallenge: false, challengeDeadline: answerTime + hour });
    expect(await f.t.run(async (ctx) => ({ bet: await ctx.db.get(f.bet), challenges: await ctx.db.query("v0Challenges").collect(), receipts: await ctx.db.query("v0Requests").collect() }))).toEqual(stable);
    expect(await scoreState(f)).toEqual(before);
  });

  it("[APPROVED.answer.late-full-hour] a valid answer one millisecond before the unanswered timeout retains its entire hour afterward", async () => {
    const f = await policyFixture();
    const before = await scoreState(f);
    const answeredAt = timeout - 1;
    await recordedAnswer(f, answeredAt);
    vi.setSystemTime(timeout + 30 * 60_000);
    await f.t.run(async (ctx) => {
      expect(Date.now()).toBe(timeout + 30 * 60_000);
      expect(await ctx.runMutation(internal.v0Jobs.sweep, {})).toEqual({ advanced: 0 });
      expect(await ctx.runQuery(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator })).toMatchObject({ state: "provisional", canChallenge: true, challengeDeadline: answeredAt + hour });
      expect(await ctx.runMutation(api.v0Bets.challenge, challengeArgs(f))).toEqual({ recorded: true });
    });
    vi.setSystemTime(answeredAt + hour);
    await f.t.run(async (ctx) => {
      expect(Date.now()).toBe(answeredAt + hour);
      expect(await ctx.runQuery(api.v0Bets.get, { token: f.actors.creator.token, locator: f.locator })).toMatchObject({ state: "provisional", canChallenge: false });
      await expectCode(ctx.runMutation(api.v0Bets.challenge, challengeArgs(f, f.actors.creator.token)), "NOT_AVAILABLE");
    });
    expect(await scoreState(f)).toEqual(before);
  });

  it("[APPROVED.settlement.stays-pending] expired challenge windows and multiple recorded challenges do not invent a majority verdict or reward", async () => {
    const f = await policyFixture();
    const before = await scoreState(f);
    await recordedAnswer(f);
    vi.setSystemTime(answerTime + 1000);
    await f.t.mutation(api.v0Bets.challenge, challengeArgs(f));
    await f.t.mutation(api.v0Bets.challenge, challengeArgs(f, f.actors.creator.token));
    vi.setSystemTime(timeout + day);
    await f.t.run(async (ctx) => {
      expect(Date.now()).toBe(timeout + day);
      expect(await ctx.runMutation(internal.v0Jobs.sweep, {})).toEqual({ advanced: 0 });
      const advanced = await ctx.runMutation(internal.v0Bets.advance, { betId: f.bet });
      expect(advanced).toMatchObject({ state: "provisional", policy: { status: "pending", version: "v0-policy.2", missing: expect.arrayContaining(["streaks", "reward_rounding", "majority_rule", "creator_rule", "turn_schedule", "recap_schedule", "goal_confirmation"]) } });
      expect(advanced?.policy.missing).not.toContain("cutoff_limits");
      expect(await ctx.runQuery(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator })).toMatchObject({ view: "bet", state: "provisional", canAnswer: false, canChallenge: false, provisionalOutcome: 0 });
      expect(await ctx.db.get(f.bet)).not.toHaveProperty("outcome");
      expect(await ctx.db.get(f.bet)).not.toHaveProperty("finalizedAt");
      expect(await ctx.db.query("v0Challenges").collect()).toHaveLength(2);
      expect((await ctx.db.query("v0Picks").collect()).every((pick) => pick.voidedAt === undefined)).toBe(true);
    });
    expect(await scoreState(f)).toEqual(before);
  });
});

describe("approved unanswered timeout and resume catch-up", () => {
  for (const offset of [-1, 0, 1]) {
    it(`[APPROVED.unanswered.query-derived.${offset}] derives timeout in get/list/history before any scheduler mutation`, async () => {
      const f = await policyFixture();
      const before = await scoreState(f);
      const at = timeout + offset;
      vi.setSystemTime(at);
      await f.t.run(async (ctx) => {
        expect(Date.now()).toBe(at);
        const get = await ctx.runQuery(api.v0Bets.get, { token: f.actors.subject.token, locator: f.locator });
        const list = await ctx.runQuery(api.v0Bets.list, { token: f.actors.subject.token, groupId: f.g1 });
        const history = await ctx.runQuery(api.v0Bets.history, { token: f.actors.subject.token, groupId: f.g1 });
        expect(get.serverTime).toBe(at);
        expect(list).toEqual([get]);
        if (offset < 0) {
          expect(get).toMatchObject({ view: "bet", state: "revealed", answerDeadline: timeout, canAnswer: true });
          expect(history).toEqual([]);
        } else {
          expect(get).toMatchObject({ view: "unavailable", state: "voided" });
          expect(history).toEqual([get]);
          for (const secret of f.privateValues) expect(JSON.stringify(get)).not.toContain(secret);
          expect(get).not.toHaveProperty("question");
          expect(get).not.toHaveProperty("options");
        }
        expect(await ctx.db.get(f.bet)).toMatchObject({ state: "revealed", answerDeadline: REVEAL + 3 * day });
        expect((await ctx.db.query("v0Picks").collect()).every((pick) => pick.voidedAt === undefined)).toBe(true);
      });
      expect(await scoreState(f)).toEqual(before);
    });
  }

  for (const state of ["open", "locked", "revealed"] as const) {
    for (const offset of [-1, 0, 1]) {
      it(`[APPROVED.unanswered.sweep.${state}.${offset}] catches up stale stored state, voids all picks exactly at timeout, and remains idempotent`, async () => {
        const f = await policyFixture(state);
        const before = await scoreState(f);
        await f.t.run((ctx) => queueNotification(ctx, event(f)));
        const at = timeout + offset;
        vi.setSystemTime(at);
        await f.t.run(async (ctx) => {
          expect(Date.now()).toBe(at);
          expect(await ctx.runMutation(internal.v0Jobs.sweep, {})).toEqual({ advanced: state === "revealed" && offset < 0 ? 0 : 1 });
          expect(await ctx.db.get(f.bet)).toMatchObject({ state: offset < 0 ? "revealed" : "voided" });
          const picks = await ctx.db.query("v0Picks").collect();
          expect(picks).toHaveLength(2);
          if (offset < 0) expect(picks.every((pick) => pick.voidedAt === undefined)).toBe(true);
          else {
            expect(picks.map((pick) => pick.voidedAt)).toEqual([at, at]);
            expect(await ctx.db.query("v0Outbox").collect()).toEqual([]);
          }
          expect(await ctx.runMutation(internal.v0Jobs.sweep, {})).toEqual({ advanced: 0 });
          expect(await ctx.runMutation(internal.v0Bets.advance, { betId: f.bet })).toMatchObject({ state: offset < 0 ? "revealed" : "voided", policy: { status: "pending" } });
          expect(await ctx.db.query("v0Picks").collect()).toEqual(picks);
        });
        expect(await scoreState(f)).toEqual(before);
      });
    }
  }

  it("[APPROVED.unanswered.obsolete-short-deadline] an obsolete earlier stored answer deadline cannot shorten the approved 24 hours", async () => {
    const f = await policyFixture();
    await f.t.run((ctx) => ctx.db.patch(f.bet, { answerDeadline: REVEAL + hour }));
    const at = REVEAL + 2 * hour;
    vi.setSystemTime(at);
    await f.t.run(async (ctx) => {
      expect(Date.now()).toBe(at);
      expect(await ctx.runQuery(api.v0Bets.get, { token: f.actors.subject.token, locator: f.locator })).toMatchObject({ state: "revealed", canAnswer: true, answerDeadline: timeout });
      expect(await ctx.runMutation(internal.v0Jobs.sweep, {})).toEqual({ advanced: 0 });
      expect(await ctx.runMutation(api.v0Bets.answer, answerArgs(f))).toEqual({ state: "provisional", challengeDeadline: at + hour });
    });
  });

  for (const offset of [-1, 0, 1]) {
    it(`[APPROVED.unanswered.proof-notification.${offset}] denies proof and queued delivery from derived timeout even while the stored state is still revealed`, async () => {
      const f = await policyFixture();
      await f.t.mutation(api.v0Notifications.register, { token: f.actors.friend.token, deviceToken: "a".repeat(64), environment: "sandbox", requestId: "register" });
      const id = await f.t.run((ctx) => queueNotification(ctx, event(f)));
      expect(id).not.toBeNull();
      vi.setSystemTime(timeout - 30_000);
      const lease = (await f.t.mutation(internal.v0Notifications.claimBatch, {}))[0];
      expect(lease.id).toBe(id);
      const device = (await f.t.query(internal.v0Notifications.deliveryPlan, { ...lease, environment: "sandbox" }))[0];
      const at = timeout + offset;
      vi.setSystemTime(at);
      await f.t.run(async (ctx) => {
        expect(Date.now()).toBe(at);
        const input = { ...lease, ...device, environment: "sandbox" as const };
        const authorization = await ctx.runMutation(internal.v0Notifications.authorizeDevice, input);
        const newIntent = await queueNotification(ctx, event(f, "after-derived-timeout"));
        if (offset < 0) {
          expect(authorization).toMatchObject({ userInfo: { kind: "reveal", locator: f.locator } });
          expect(newIntent).not.toBeNull();
          expect(await ctx.runQuery(api.v0Proof.list, { token: f.actors.friend.token, betId: f.bet })).toHaveLength(1);
          expect(await ctx.runQuery(internal.v0Proof.authorizeRead, { token: f.actors.friend.token, proofId: f.proof })).toMatchObject({ id: f.proof, storageId: f.storageId });
        } else {
          expect(authorization).toBeNull();
          expect(newIntent).toBeNull();
          expect(await ctx.runQuery(internal.v0Notifications.deliveryPlan, { ...lease, environment: "sandbox" })).toEqual([]);
          await expectCode(ctx.runQuery(api.v0Proof.list, { token: f.actors.friend.token, betId: f.bet }), "NOT_AVAILABLE");
          await expectCode(ctx.runQuery(internal.v0Proof.authorizeRead, { token: f.actors.friend.token, proofId: f.proof }), "NOT_AVAILABLE");
          expect(await ctx.runMutation(internal.v0Notifications.finishAttempt, { ...lease, environment: "sandbox" })).toBe("stale");
          expect(await ctx.db.get(id!)).toBeNull();
        }
        expect(await ctx.db.get(f.bet)).toMatchObject({ state: "revealed" });
      });
      if (offset >= 0) {
        vi.setSystemTime(at + 1000);
        await expectCode(f.t.action(api.v0Proof.read, { token: f.actors.friend.token, proofId: f.proof }), "NOT_AVAILABLE");
        await expectCode(f.t.action(api.v0Proof.upload, { token: f.actors.subject.token, betId: f.bet, contentType: "image/png", bytes: makePng(), requestId: "timeout-upload" }), "NOT_AVAILABLE");
        expect(await f.t.run((ctx) => ctx.db.query("v0Proofs").collect())).toHaveLength(1);
      }
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  for (const offset of [-1, 0]) {
    for (const order of ["answer-first", "sweep-first"] as const) {
      it(`[APPROVED.unanswered.ordering.${order}.${offset}] preserves the same legal boundary result in either serialized answer/sweep order`, async () => {
        const f = await policyFixture();
        const before = await scoreState(f);
        const at = timeout + offset;
        vi.setSystemTime(at);
        await f.t.run(async (ctx) => {
          expect(Date.now()).toBe(at);
          const answer = async () => {
            if (offset < 0) expect(await ctx.runMutation(api.v0Bets.answer, answerArgs(f))).toEqual({ state: "provisional", challengeDeadline: at + hour });
            else await expectCode(ctx.runMutation(api.v0Bets.answer, answerArgs(f)), "NOT_AVAILABLE");
          };
          const sweep = async () => expect(await ctx.runMutation(internal.v0Jobs.sweep, {})).toEqual({ advanced: offset < 0 ? 0 : 1 });
          if (order === "answer-first") { await answer(); await sweep(); }
          else { await sweep(); await answer(); }
          expect(await ctx.db.get(f.bet)).toMatchObject({ state: offset < 0 ? "provisional" : "voided" });
          expect((await ctx.db.query("v0Picks").collect()).map((pick) => pick.voidedAt)).toEqual(offset < 0 ? [undefined, undefined] : [at, at]);
        });
        expect(await scoreState(f)).toEqual(before);
      });
    }
  }
});

describe("approved confidence validation retains unresolved creation and reward gates", () => {
  for (const [name, confidence, code] of [["below-min", 0.0099, "INVALID_INPUT"], ["min", 0.01, "CONFLICT"], ["middle", 0.5, "CONFLICT"], ["max", 1, "CONFLICT"], ["above-max", 1.0001, "INVALID_INPUT"], ["nan", Number.NaN, "INVALID_INPUT"], ["infinity", Infinity, "INVALID_INPUT"], ["negative-infinity", -Infinity, "INVALID_INPUT"]] as const) {
    it(`[APPROVED.confidence.${name}] validates normalized confidence while preserving the already-confirmed immutable pick and no reward`, async () => {
      const f = await policyFixture("open");
      const before = await scoreState(f);
      const picks = await f.t.run((ctx) => ctx.db.query("v0Picks").collect());
      vi.setSystemTime(T0 + 60_000);
      await expectCode(f.t.mutation(api.v0Bets.pick, { token: f.actors.friend.token, betId: f.bet, option: 0, confidence, requestId: "confidence" }), code);
      expect(await f.t.run((ctx) => ctx.db.query("v0Picks").collect())).toEqual(picks);
      expect(await scoreState(f)).toEqual(before);
    });
  }

  for (const riskPoints of [0, -1, 0.5, 100]) {
    it(`[APPROVED.confidence.reject-risk.${riskPoints}] rejects every present legacy risk field, including zero, without debiting either group`, async () => {
      const f = await policyFixture("open");
      const before = await scoreState(f);
      const picks = await f.t.run((ctx) => ctx.db.query("v0Picks").collect());
      vi.setSystemTime(T0 + 60_000);
      await expectCode(f.t.mutation(api.v0Bets.pick, { token: f.actors.friend.token, betId: f.bet, option: 0, confidence: 0.5, riskPoints, requestId: "no-risk" }), "INVALID_INPUT");
      expect(await f.t.run((ctx) => ctx.db.query("v0Picks").collect())).toEqual(picks);
      expect(await scoreState(f)).toEqual(before);
    });
  }
});

describe("approved next strictly future group-local 20:00 default", () => {
  for (const [name, zone, now, expected] of [
    ["la-before-spring", "America/Los_Angeles", "2026-03-08T03:00:00Z", "2026-03-08T04:00:00Z"],
    ["la-after-spring", "America/Los_Angeles", "2026-03-09T02:00:00Z", "2026-03-09T03:00:00Z"],
    ["la-before-fall", "America/Los_Angeles", "2026-11-01T02:00:00Z", "2026-11-01T03:00:00Z"],
    ["la-after-fall", "America/Los_Angeles", "2026-11-02T03:00:00Z", "2026-11-02T04:00:00Z"],
    ["la-at-spring-eve", "America/Los_Angeles", "2026-03-08T04:00:00Z", "2026-03-09T03:00:00Z"],
    ["la-at-fall-eve", "America/Los_Angeles", "2026-11-01T03:00:00Z", "2026-11-02T04:00:00Z"],
    ["tokyo", "Asia/Tokyo", "2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z"],
    ["utc-before", "UTC", "2026-11-16T19:59:59.999Z", "2026-11-16T20:00:00Z"],
    ["utc-at", "UTC", "2026-11-16T20:00:00Z", "2026-11-17T20:00:00Z"],
    ["utc-after", "UTC", "2026-11-16T20:00:00.001Z", "2026-11-17T20:00:00Z"],
    ["kolkata-half-hour", "Asia/Kolkata", "2026-11-16T14:29:59.999Z", "2026-11-16T14:30:00Z"],
    ["berlin-spring", "Europe/Berlin", "2026-03-29T17:59:00Z", "2026-03-29T18:00:00Z"],
    ["berlin-fall", "Europe/Berlin", "2026-10-25T18:59:00Z", "2026-10-25T19:00:00Z"],
    ["lord-howe-standard", "Australia/Lord_Howe", "2026-07-01T09:00:00Z", "2026-07-01T09:30:00Z"],
    ["lord-howe-daylight", "Australia/Lord_Howe", "2026-10-04T08:30:00Z", "2026-10-04T09:00:00Z"],
  ] as const) {
    it(`[APPROVED.reveal.default.${name}] matches an independent UTC/DST vector rather than the caller timezone`, () => {
      vi.stubEnv("TZ", "Pacific/Honolulu");
      expect(nextDefaultRevealAt(zone, Date.parse(now))).toBe(Date.parse(expected));
      expect(Date.parse(expected)).toBeGreaterThan(Date.parse(now));
    });
  }

  it("[APPROVED.reveal.nonfinite-clock] rejects an unusable clock instead of manufacturing a default", () => {
    expect(nextDefaultRevealAt("UTC", Number.NaN)).toBeNull();
    expect(nextDefaultRevealAt("UTC", Infinity)).toBeNull();
    expect(nextDefaultRevealAt("UTC", -Infinity)).toBeNull();
  });

  for (const [name, zone, reveal, cutoff, code] of [
    ["la-default", "America/Los_Angeles", undefined, undefined, "POLICY_PENDING"],
    ["tokyo-default", "Asia/Tokyo", undefined, undefined, "POLICY_PENDING"],
    ["utc-default", "UTC", undefined, undefined, "POLICY_PENDING"],
    ["invalid-default-zone", "Synthetic/Invalid", undefined, CUTOFF, "INVALID_INPUT"],
    ["explicit-override", "UTC", T0 + 123_456, T0 + 123_456, "POLICY_PENDING"],
    ["override-bypasses-default-zone", "Synthetic/Invalid", REVEAL, REVEAL, "POLICY_PENDING"],
    ["reveal-past", "UTC", T0 + 59_999, CUTOFF, "INVALID_INPUT"],
    ["reveal-now", "UTC", T0 + 60_000, CUTOFF, "INVALID_INPUT"],
    ["reveal-nonfinite", "UTC", Infinity, CUTOFF, "INVALID_INPUT"],
    ["cutoff-past", "UTC", REVEAL, T0 + 59_999, "INVALID_INPUT"],
    ["cutoff-now", "UTC", REVEAL, T0 + 60_000, "INVALID_INPUT"],
    ["cutoff-nonfinite", "UTC", REVEAL, Infinity, "INVALID_INPUT"],
  ] as const) {
    it(`[APPROVED.reveal.create-validation.${name}] validates only the concrete scheduling inputs while creation remains policy-gated`, async () => {
      const f = await policyFixture("open");
      await f.t.run((ctx) => ctx.db.patch(f.g1, { timezone: zone }));
      const before = await scoreState(f);
      const bets = await f.t.run((ctx) => ctx.db.query("v0Bets").collect());
      const at = T0 + 60_000;
      vi.setSystemTime(at);
      await f.t.run(async (ctx) => {
        expect(Date.now()).toBe(at);
        await expectCode(ctx.runMutation(api.v0Bets.create, { token: f.actors.creator.token, groupId: f.g1, subjectId: f.actors.subject.id, question: "Will Sage bring a puzzle to the picnic?", contextLine: "A synthetic picnic", format: "yes_no", options: ["Yes", "No"], cutoffAt: cutoff, ...(reveal === undefined ? {} : { revealAt: reveal }), source: "manual", requestId: "approved-create" }), code);
        expect(await ctx.db.query("v0Bets").collect()).toEqual(bets);
      });
      expect(await scoreState(f)).toEqual(before);
    });
  }
});
