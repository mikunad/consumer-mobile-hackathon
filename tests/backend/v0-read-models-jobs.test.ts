import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { noPrivateValues } from "./assertions";
import { CUTOFF, REVEAL, T0 } from "./fixture";
import { v0Fixture } from "./v0-fixture";

type Fixture = Awaited<ReturnType<typeof v0Fixture>>;

async function seedTurn(f: Fixture) {
  return await f.t.run((ctx) => ctx.db.insert("v0Turns", { groupId: f.g1, localDate: "2026-11-16", creatorId: f.actors.creator.id, subjectId: f.actors.subject.id, status: "assigned", assignedAt: T0 - 1000, passAt: T0 + 60_000 }));
}

describe("actual V0 read models and implemented reveal scheduler", () => {
  it("[V0.sweep-reveal-boundaries] preserves personal confirmation until reveal with one logical reveal event per eligible recipient", async () => {
    const f = await v0Fixture();
    await f.t.run(async (ctx) => {
      const member = await ctx.db.query("v0Memberships").withIndex("by_group_account", (q) => q.eq("groupId", f.g1).eq("accountId", f.actors.friend.id)).unique();
      await ctx.db.insert("v0Picks", { groupId: f.g1, betId: f.bet, accountId: f.actors.friend.id, membershipId: member!._id, option: 0, confidence: 0.5, placedAt: T0, updatedAt: T0 });
    });
    for (const [now, state, advanced] of [[CUTOFF - 1, "open", 0], [CUTOFF, "open", 0], [REVEAL - 1, "open", 0], [REVEAL, "revealed", 1]] as const) {
      vi.setSystemTime(now);
      expect(await f.t.mutation(internal.v0Jobs.sweep, {})).toEqual({ advanced });
      expect((await f.t.run((ctx) => ctx.db.get(f.bet)))?.state).toBe(state);
      if (now < REVEAL) expect(await f.t.run((ctx) => ctx.db.query("v0Outbox").collect())).toEqual([]);
    }
    const events = await f.t.run((ctx) => ctx.db.query("v0Outbox").collect());
    expect(events).toHaveLength(2);
    expect(new Set(events.map((item) => item.accountId))).toEqual(new Set([f.actors.subject.id, f.actors.friend.id]));
    for (const event of events) expect(event).toMatchObject({ groupId: f.g1, betId: f.bet, kind: "reveal", state: "pending", attempts: 0 });
    noPrivateValues(events, [...f.privateValues, ...Object.values(f.actors).map((actor) => actor.token)]);
    expect(await f.t.mutation(internal.v0Jobs.sweep, {})).toEqual({ advanced: 0 });
    expect(await f.t.mutation(internal.v0Bets.advance, { betId: f.bet })).toMatchObject({ state: "revealed", policy: { status: "pending" } });
    expect(await f.t.run((ctx) => ctx.db.query("v0Outbox").collect())).toEqual(events);
    expect(await f.t.run((ctx) => ctx.db.query("v0Ledger").collect())).toEqual([]);
  });

  it("[V0.sweep-invalid-interval] voids malformed timing instead of revealing or inventing settlement", async () => {
    const f = await v0Fixture();
    await f.t.run((ctx) => ctx.db.patch(f.bet, { cutoffAt: REVEAL, revealAt: CUTOFF }));
    vi.setSystemTime(REVEAL + 1000);
    expect(await f.t.mutation(internal.v0Jobs.sweep, {})).toEqual({ advanced: 1 });
    expect((await f.t.run((ctx) => ctx.db.get(f.bet)))?.state).toBe("voided");
    expect(await f.t.run((ctx) => ctx.db.query("v0Outbox").collect())).toEqual([]);
    expect(await f.t.run((ctx) => ctx.db.query("v0Ledger").collect())).toEqual([]);
  });

  it("[V0.history-rejoin] permits a seeded terminal read but does not restore pre-join history after rejoining", async () => {
    const f = await v0Fixture();
    vi.setSystemTime(REVEAL + 1000);
    await f.t.run((ctx) => ctx.db.patch(f.bet, { state: "finalized", outcome: 0 }));
    const history = await f.t.query(api.v0Bets.history, { token: f.actors.friend.token, groupId: f.g1 });
    expect(history.map((bet) => bet.betId)).toEqual([f.bet]);
    expect(history[0]).toMatchObject({ view: "bet", state: "finalized", outcome: 0, canPick: false, canAnswer: false, canChallenge: false });
    expect(await f.t.query(api.v0Bets.history, { token: f.actors.creator.token, groupId: f.g2 })).toEqual([]);
    expect(await f.t.query(api.v0Bets.history, { token: f.actors.new.token, groupId: f.g1 })).toEqual([]);
    await f.t.mutation(api.v0Controls.leave, { token: f.actors.friend.token, groupId: f.g1, requestId: `${f.runId}_leave` });
    await expect(f.t.query(api.v0Bets.history, { token: f.actors.friend.token, groupId: f.g1 })).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
    await f.t.mutation(api.v0Groups.invite, { token: f.actors.creator.token, groupId: f.g1, phone: f.actors.friend.phone, requestId: `${f.runId}_invite` });
    const invitation = (await f.t.query(api.v0Groups.invitations, { token: f.actors.friend.token }))[0];
    expect(invitation).toBeDefined();
    await f.t.mutation(api.v0Groups.accept, { token: f.actors.friend.token, inviteId: invitation.id, requestId: `${f.runId}_rejoin` });
    expect(await f.t.query(api.v0Bets.list, { token: f.actors.friend.token, groupId: f.g1 })).toEqual([]);
    expect(await f.t.query(api.v0Bets.history, { token: f.actors.friend.token, groupId: f.g1 })).toEqual([]);
    await expect(f.t.query(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator })).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
    expect(await f.t.run((ctx) => ctx.db.query("v0Ledger").collect())).toEqual([]);
  });

  it("[V0.turn-read] reads an existing eligible local-date turn without claiming rotation or pass policy", async () => {
    const f = await v0Fixture();
    const id = await seedTurn(f);
    expect(await f.t.query(api.v0Groups.turn, { token: f.actors.friend.token, groupId: f.g1 })).toEqual({ id, groupId: f.g1, localDate: "2026-11-16", creatorId: f.actors.creator.id, subjectId: f.actors.subject.id, status: "assigned", assignedAt: T0 - 1000, passAt: T0 + 60_000, canPass: false });
    expect(await f.t.query(api.v0Groups.turn, { token: f.actors.creator.token, groupId: f.g2 })).toBeNull();
    await expect(f.t.mutation(api.v0Groups.passTurn, { token: f.actors.friend.token, groupId: f.g1, requestId: `${f.runId}_wrong` })).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
    await expect(f.t.mutation(api.v0Groups.passTurn, { token: f.actors.creator.token, groupId: f.g1, requestId: `${f.runId}_pass` })).rejects.toMatchObject({ data: { code: "POLICY_PENDING" } });
    expect((await f.t.run((ctx) => ctx.db.get(id)))?.status).toBe("assigned");
  });

  for (const invalid of ["future", "new-viewer", "duplicate-subject", "no-bets", "blocked"] as const) {
    it(`[V0.turn-hidden.${invalid}] does not expose an ineligible seeded turn`, async () => {
      const f = await v0Fixture();
      const id = await seedTurn(f);
      await f.t.run(async (ctx) => {
        if (invalid === "future") await ctx.db.patch(id, { assignedAt: T0 + 1000 });
        if (invalid === "duplicate-subject") await ctx.db.insert("v0Memberships", { groupId: f.g1, accountId: f.actors.subject.id, alias: "Duplicate synthetic subject", joinedAt: T0 - 1000, points: 0, streak: 0 });
        if (invalid === "no-bets") await ctx.db.patch(f.actors.subject.id, { noBets: true });
        if (invalid === "blocked") await ctx.db.insert("v0Blocks", { accountId: f.actors.friend.id, blockedId: f.actors.subject.id, createdAt: T0 });
      });
      if (invalid === "new-viewer") vi.setSystemTime(T0 + 2000);
      const token = invalid === "new-viewer" ? f.actors.new.token : f.actors.friend.token;
      expect(await f.t.query(api.v0Groups.turn, { token, groupId: f.g1 })).toBeNull();
    });
  }

  it("[V0.recap-read] aggregates only visible seeded ledger rows in a closed interval and retains pending schedule policy", async () => {
    const f = await v0Fixture();
    const resultTime = REVEAL + 1000;
    vi.setSystemTime(resultTime + 2000);
    const id = await f.t.run(async (ctx) => {
      await ctx.db.patch(f.bet, { state: "finalized", outcome: 0 });
      const member = await ctx.db.query("v0Memberships").withIndex("by_group_account", (q) => q.eq("groupId", f.g1).eq("accountId", f.actors.friend.id)).unique();
      const base = { groupId: f.g1, betId: f.bet, accountId: f.actors.friend.id, membershipId: member!._id, points: 7, streakBefore: 0, streakAfter: 0, policyVersion: "synthetic-read-only-not-approved-scoring", createdAt: resultTime };
      await ctx.db.insert("v0Ledger", base);
      await ctx.db.insert("v0Ledger", { ...base, points: 3, createdAt: resultTime + 1 });
      await ctx.db.insert("v0Ledger", { ...base, points: 1000, createdAt: resultTime + 1000 });
      await ctx.db.insert("v0Ledger", { ...base, points: 2000, createdAt: T0 - 120_001 });
      await ctx.db.insert("v0Ledger", { ...base, points: 4000, groupId: f.g2 });
      await ctx.db.insert("v0Ledger", { ...base, points: 8000, accountId: undefined, membershipId: undefined });
      await ctx.db.insert("v0Recaps", { groupId: f.g1, startsAt: resultTime, endsAt: resultTime + 10_000, createdAt: resultTime });
      return await ctx.db.insert("v0Recaps", { groupId: f.g1, startsAt: T0 - 120_000, endsAt: resultTime + 1000, createdAt: resultTime + 1000 });
    });
    const recap = await f.t.query(api.v0Groups.recap, { token: f.actors.creator.token, groupId: f.g1 });
    expect(recap).toMatchObject({ id, groupId: f.g1, startsAt: T0 - 60_000, endsAt: resultTime + 1000, rows: [{ accountId: f.actors.friend.id, alias: "Finn", points: 10 }], policy: { status: "pending" } });
    noPrivateValues(recap, f.privateValues);
    expect(await f.t.query(api.v0Groups.recap, { token: f.actors.creator.token, groupId: f.g2 })).toBeNull();
    expect((await f.t.query(api.v0Groups.recap, { token: f.actors.new.token, groupId: f.g1 }))?.rows).toEqual([]);
  });
});
