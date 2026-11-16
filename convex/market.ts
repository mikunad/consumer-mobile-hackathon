import { query, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { HOUR, betLocked, defaultGroupId, multiplier, nextRound, percents, streakFor, supersededAt, userByToken } from "./lib";

type Staker = {
  id: Id<"users">;
  emoji: string;
  name: string;
  amount: number;
  late: boolean;
  first: number;
  payout?: number;
  me: boolean;
};

export async function sidesFor(ctx: QueryCtx, bet: Doc<"bets">, meId: Id<"users"> | null) {
  const stakes = await ctx.db
    .query("stakes")
    .withIndex("by_bet", (q) => q.eq("betId", bet._id))
    .collect();
  const byUser = new Map<string, Staker & { option: number; settled: boolean }>();
  for (const st of stakes.sort((a, b) => a._creationTime - b._creationTime)) {
    const prev = byUser.get(st.userId);
    if (prev) {
      prev.amount += st.amount;
      prev.settled = prev.settled && st.payout !== undefined;
      prev.payout = (prev.payout ?? 0) + (st.payout ?? 0);
      continue;
    }
    const user = await ctx.db.get(st.userId);
    byUser.set(st.userId, {
      id: st.userId,
      emoji: user?.emoji ?? "🙂",
      name: user?.name ?? "Someone",
      amount: st.amount,
      late: st.late,
      first: st._creationTime,
      payout: st.payout ?? 0,
      settled: st.payout !== undefined,
      me: st.userId === meId,
      option: st.option,
    });
  }
  const sides: Staker[][] = bet.options.map(() => []);
  for (const { option, settled, payout, ...rest } of byUser.values()) {
    sides[option]?.push({ ...rest, payout: settled ? payout : undefined });
  }
  for (const side of sides) side.sort((a, b) => b.amount - a.amount || a.first - b.first);
  return sides;
}

export const people = query({
  args: { betId: v.id("bets"), token: v.optional(v.string()) },
  handler: async (ctx, { betId, token }) => {
    const bet = await ctx.db.get(betId);
    if (!bet || bet.hidden) return null;
    const user = await userByToken(ctx, token);
    if (user && bet.subjectUserId === user._id) return null;
    return { sides: await sidesFor(ctx, bet, user?._id ?? null) };
  },
});

export const market = query({
  args: { betId: v.id("bets"), token: v.optional(v.string()), now: v.optional(v.number()) },
  handler: async (ctx, { betId, token, now: nowArg }) => {
    const bet = await ctx.db.get(betId);
    if (!bet || bet.hidden) return null;
    const round = await ctx.db.get(bet.roundId);
    if (!round) return null;
    const now = Math.min(nowArg ?? Date.now(), Date.now());
    const user = await userByToken(ctx, token);
    if (user && bet.subjectUserId === user._id) return null;
    const isDefault = !round.groupId || round.groupId === (await defaultGroupId(ctx));
    const subject = bet.subjectUserId ? await ctx.db.get(bet.subjectUserId) : null;
    const ticks = await ctx.db
      .query("ticks")
      .withIndex("by_bet", (q) => q.eq("betId", bet._id))
      .collect();
    const siblings = (
      await ctx.db
        .query("bets")
        .withIndex("by_round", (q) => q.eq("roundId", round._id))
        .collect()
    )
      .filter((b) => !b.hidden && (!user || b.subjectUserId !== user._id))
      .sort((a, b) => a.order - b.order);
    const mine = user
      ? (
          await ctx.db
            .query("stakes")
            .withIndex("by_bet", (q) => q.eq("betId", bet._id))
            .filter((q) => q.eq(q.field("userId"), user._id))
            .collect()
        ).map((s) => ({ option: s.option, amount: s.amount, late: s.late, payout: s.payout }))
      : [];
    const sides = await sidesFor(ctx, bet, user?._id ?? null);
    const streak = user && isDefault ? (await streakFor(ctx, user, round)).next : 1;
    const closedAt = await supersededAt(ctx, round, now);
    const upcoming = closedAt === null ? await nextRound(ctx, round.groupId ?? null, now) : null;
    return {
      bet: {
        _id: bet._id,
        question: bet.question,
        kind: bet.kind,
        options: bet.options,
        line: bet.line,
        pools: bet.pools,
        status: bet.status,
        winningOption: bet.winningOption,
        counter: bet.counter,
        subject: subject ? { name: subject.name, emoji: subject.emoji } : null,
        locked: await betLocked(ctx, bet, round, now),
        pct: percents(bet.pools),
        total: bet.pools.reduce((a, b) => a + b, 0),
        bettors: sides.reduce((a, s) => a + s.length, 0),
        ticks: ticks.sort((a, b) => a.t - b.t).map((t) => ({ t: t.t, pct: t.pct })),
        mine,
      },
      round: { _id: round._id, number: round.number, title: round.title, opensAt: round.opensAt, groupId: round.groupId ?? null },
      endsAt: closedAt ?? upcoming?.opensAt ?? round.opensAt + HOUR,
      position: siblings.findIndex((b) => b._id === bet._id) + 1,
      count: siblings.length,
      sides,
      mult: multiplier(streak),
      points: user?.points ?? 0,
      joined: user !== null,
    };
  },
});
