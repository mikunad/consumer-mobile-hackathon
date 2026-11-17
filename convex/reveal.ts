import { query } from "./v0Legacy";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { defaultGroupId, isMember, percents, userByToken } from "./lib";

type Tile = "won" | "lost" | "skip" | "pending" | "void";

function tileFor(bet: Doc<"bets">, mine: Doc<"stakes">[]): Tile {
  if (bet.status === "refunded") return "void";
  if (bet.status !== "settled") return "pending";
  if (mine.length === 0) return "skip";
  return mine[0].option === bet.winningOption ? "won" : "lost";
}

function netFor(bet: Doc<"bets">, mine: Doc<"stakes">[]) {
  if (mine.length === 0 || mine.some((s) => s.payout === undefined)) return null;
  if (bet.status === "refunded") return 0;
  return mine.reduce((a, s) => a + (s.payout ?? 0) - s.amount, 0);
}

async function visibleBets(ctx: QueryCtx, roundId: Id<"rounds">, viewer: Id<"users"> | undefined) {
  return (
    await ctx.db
      .query("bets")
      .withIndex("by_round", (q) => q.eq("roundId", roundId))
      .collect()
  )
    .filter((b) => !b.hidden && b.subjectUserId !== viewer)
    .sort((a, b) => a.order - b.order);
}

function sample<T>(xs: T[], max: number) {
  if (xs.length <= max) return xs;
  const step = (xs.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => xs[Math.round(i * step)]);
}

export const dropResults = query({
  args: { token: v.optional(v.string()), roundId: v.id("rounds") },
  handler: async (ctx, { token, roundId }) => {
    const round = await ctx.db.get(roundId);
    if (!round) return null;
    const user = await userByToken(ctx, token);
    const next = await ctx.db
      .query("rounds")
      .withIndex("by_group_opensAt", (q) => q.eq("groupId", round.groupId).gt("opensAt", round.opensAt))
      .order("asc")
      .first();
    const bets = await Promise.all(
      (await visibleBets(ctx, roundId, user?._id)).map(async (bet) => {
        const stakes = await ctx.db
          .query("stakes")
          .withIndex("by_bet", (q) => q.eq("betId", bet._id))
          .collect();
        const mine = user ? stakes.filter((s) => s.userId === user._id) : [];
        const byWinner = new Map<Id<"users">, number>();
        if (bet.status === "settled")
          for (const s of stakes)
            if (s.option === bet.winningOption) byWinner.set(s.userId, (byWinner.get(s.userId) ?? 0) + (s.payout ?? 0));
        const ranked = [...byWinner.entries()].sort((a, b) => b[1] - a[1]);
        const winners = (
          await Promise.all(
            ranked.slice(0, 12).map(async ([id, payout]) => {
              const u = await ctx.db.get(id);
              return u ? { name: u.name, emoji: u.emoji, payout, me: id === user?._id } : null;
            }),
          )
        ).filter((w) => w !== null);
        const ticks = await ctx.db
          .query("ticks")
          .withIndex("by_bet", (q) => q.eq("betId", bet._id))
          .collect();
        return {
          _id: bet._id,
          question: bet.question,
          kind: bet.kind,
          options: bet.options,
          order: bet.order,
          status: bet.status,
          winningOption: bet.winningOption,
          pct: percents(bet.pools),
          total: bet.pools.reduce((a, b) => a + b, 0),
          bettors: new Set(stakes.map((s) => s.userId)).size,
          tile: tileFor(bet, mine),
          mine: mine.length
            ? {
                option: mine[0].option,
                amount: mine.reduce((a, s) => a + s.amount, 0),
                late: mine.some((s) => s.late),
              }
            : null,
          net: netFor(bet, mine),
          winners,
          winnerCount: byWinner.size,
          ticks: sample(
            ticks.sort((a, b) => a.t - b.t).map((t) => ({ t: t.t, pct: t.pct })),
            80,
          ),
        };
      }),
    );
    return {
      round: { _id: round._id, number: round.number, title: round.title, opensAt: round.opensAt },
      endsAt: next?.opensAt ?? round.opensAt + 60 * 60 * 1000,
      bets,
      net: bets.reduce((a, b) => a + (b.net ?? 0), 0),
    };
  },
});

export const myScorecards = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await userByToken(ctx, token);
    if (!user) return [];
    const myStakes = await ctx.db
      .query("stakes")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const rounds = await ctx.db.query("rounds").withIndex("by_opensAt").order("desc").take(48);
    const defaultId = await defaultGroupId(ctx);
    const groups = new Map<string, { visible: boolean; name: string | null }>();
    const cards = [];
    for (const round of rounds) {
      const bets = await visibleBets(ctx, round._id, user._id);
      const mineInRound = myStakes.filter((s) => s.roundId === round._id);
      const resolved = bets.some((b) => b.status === "settled" || b.status === "refunded");
      if (mineInRound.length === 0 && !resolved) continue;
      const groupId = round.groupId ?? defaultId;
      if (groupId && !groups.has(groupId))
        groups.set(groupId, {
          visible: groupId === defaultId || (await isMember(ctx, groupId, user._id)),
          name: groupId === defaultId ? null : ((await ctx.db.get(groupId))?.name ?? null),
        });
      const group = groupId ? groups.get(groupId) : undefined;
      if (group && !group.visible && mineInRound.length === 0) continue;
      const tiles = bets.map((bet) => {
        const mine = mineInRound.filter((s) => s.betId === bet._id);
        return { betId: bet._id, status: bet.status, tile: tileFor(bet, mine), net: netFor(bet, mine) };
      });
      cards.push({
        roundId: round._id,
        number: round.number,
        title: round.title,
        opensAt: round.opensAt,
        group: group?.name ?? null,
        played: mineInRound.length > 0,
        tiles,
        net: tiles.reduce((a, t) => a + (t.net ?? 0), 0),
      });
    }
    return cards;
  },
});
