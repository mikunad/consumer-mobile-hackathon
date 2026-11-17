import { describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { CUTOFF, fixture, ledger, REVEAL, type Fixture } from "../backend/fixture";

const stakeRoutes = {
  "chat.stake": (f: Fixture, option = 0, amount = 10) => f.t.mutation(api.chat.stake, { token: f.actors.friend.token, betId: f.bet, option, amount }),
  "game.placeStake": (f: Fixture, option = 0, amount = 10) => f.t.mutation(api.game.placeStake, { token: f.actors.friend.token, betId: f.bet, option, amount }),
};

describe("SEC4 timing and single-ledger regressions", () => {
  for (const [name, stake] of Object.entries(stakeRoutes)) {
    for (const at of [CUTOFF, REVEAL - 1, REVEAL, REVEAL + 1]) {
      it(`[SEC4.cutoff.${name}.${at - CUTOFF}] rejects at and after the authoritative cutoff`, async () => {
        const f = await fixture();
        vi.setSystemTime(at);
        const before = await ledger(f);
        await expect(stake(f)).rejects.toThrow();
        expect(await ledger(f)).toEqual(before);
      });
    }

    it(`[SEC4.global-wallet.${name}] never debits the global wallet for a room pick`, async () => {
      const f = await fixture();
      const before = await ledger(f);
      await stake(f);
      const after = await ledger(f);
      expect(after.users.map((u) => [u._id, u.points])).toEqual(before.users.map((u) => [u._id, u.points]));
      expect(after.members.filter((m) => m.groupId === f.g2)).toEqual(before.members.filter((m) => m.groupId === f.g2));
    });

    it(`[J3.3.edit.${name}] replaces a pick before cutoff instead of appending exposure`, async () => {
      const f = await fixture();
      await stake(f, 0, 10);
      await stake(f, 1, 20);
      const state = await ledger(f);
      const picks = state.stakes.filter((s) => s.betId === f.bet && s.userId === f.actors.friend.id);
      expect(picks).toHaveLength(1);
      expect(picks[0]).toMatchObject({ option: 1, amount: 20 });
      expect(state.bet?.pools).toEqual([0, 20]);
    });

    it(`[J3.3.duplicate.${name}] does not double-book a retried identical pick`, async () => {
      const f = await fixture();
      await stake(f);
      const before = await ledger(f);
      await stake(f);
      expect(await ledger(f)).toEqual(before);
    });

    for (const option of [-1, 0.5, 2]) {
      it(`[SEC4.invalid-pick.${name}.${option}] rejects an invalid outcome without mutation`, async () => {
        const f = await fixture();
        const before = await ledger(f);
        await expect(stake(f, option)).rejects.toThrow();
        expect(await ledger(f)).toEqual(before);
      });
    }
  }

  it("[SEC4.wrong-settler] prevents the group creator settling a subject's bet before reveal", async () => {
    const f = await fixture(true);
    const before = await ledger(f);
    await expect(f.t.mutation(api.groups.settle, { token: f.actors.creator.token, betId: f.bet, winningOption: 0 })).rejects.toThrow();
    expect(await ledger(f)).toEqual(before);
  });

  for (const option of [-1, 0.5, 2]) {
    it(`[SEC4.invalid-settlement.${option}] rejects invalid legacy settlement outcomes`, async () => {
      const f = await fixture(true);
      const before = await ledger(f);
      await expect(f.t.mutation(api.groups.settle, { token: f.actors.creator.token, betId: f.bet, winningOption: option })).rejects.toThrow();
      expect(await ledger(f)).toEqual(before);
    });
  }

  it("[SEC4.mixed-routes] never transfers room stake returns into the global wallet", async () => {
    const f = await fixture(true);
    const before = await ledger(f);
    await f.t.mutation(api.groups.settle, { token: f.actors.creator.token, betId: f.bet, winningOption: null });
    const after = await ledger(f);
    expect(after.users.map((u) => [u._id, u.points])).toEqual(before.users.map((u) => [u._id, u.points]));
  });

  it("[J4.3.quiet-veto] permits a subject to veto while still sealed", async () => {
    const f = await fixture(true);
    await f.t.mutation(api.chat.veto, { token: f.actors.subject.token, betId: f.bet });
    const first = await ledger(f);
    expect(first.bet?.status).toMatch(/^(refunded|voided)$/);
    for (const stake of first.stakes) expect(stake.payout).toBe(stake.amount);
    try { await f.t.mutation(api.chat.veto, { token: f.actors.subject.token, betId: f.bet }); } catch { }
    expect(await ledger(f)).toEqual(first);
  });

  it("[SEC4.exactly-once] never pays a completed settlement twice", async () => {
    const f = await fixture(true);
    vi.setSystemTime(REVEAL);
    await f.t.mutation(api.chat.declare, { token: f.actors.subject.token, betId: f.bet, winningOption: 0 });
    const first = await ledger(f);
    await expect(f.t.mutation(api.chat.declare, { token: f.actors.subject.token, betId: f.bet, winningOption: 0 })).rejects.toThrow();
    expect(await ledger(f)).toEqual(first);
  });

  it("[SEC4.left-settler] rejects a former subject after their membership is removed", async () => {
    const f = await fixture(true);
    await f.t.run(async (ctx) => {
      const member = await ctx.db.query("members").withIndex("by_group_user", (q) => q.eq("groupId", f.g1).eq("userId", f.actors.subject.id)).unique();
      await ctx.db.delete(member!._id);
    });
    vi.setSystemTime(REVEAL);
    const before = await ledger(f);
    await expect(f.t.mutation(api.chat.declare, { token: f.actors.subject.token, betId: f.bet, winningOption: 0 })).rejects.toThrow();
    expect(await ledger(f)).toEqual(before);
  });

  it("[J7.2.group-board] reads the room score rather than the global wallet", async () => {
    const f = await fixture();
    const board = await f.t.query(api.ext.board, { token: f.actors.creator.token, roomId: f.g2 });
    expect(board?.rows.find((u) => u._id === f.actors.creator.id)?.points).toBe(50);
    const legacy = await f.t.query(api.game.leaderboard, { groupId: f.g2, now: REVEAL });
    expect(legacy.find((u) => u._id === f.actors.creator.id)?.points).toBe(50);
  });
});
