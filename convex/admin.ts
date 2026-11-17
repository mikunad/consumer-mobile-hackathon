import { mutation, query, internalMutation } from "./v0Legacy";
import { v, ConvexError } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { HOUR, LOCK_AFTER_MS, multiplier, percents, requireAdmin, ensureDefaultGroup, normalizeUsername, uniqueUsername, isTestName } from "./lib";

const kind = v.union(v.literal("yesno"), v.literal("overunder"), v.literal("multi"));

function optionsFor(k: "yesno" | "overunder" | "multi", line?: number, options?: string[]) {
  if (k === "yesno") return ["Yes", "No"];
  if (k === "overunder") {
    if (line === undefined) throw new ConvexError("Over/under needs a line");
    return ["Over " + line, "Under " + line];
  }
  const opts = (options ?? []).map((o) => o.trim()).filter(Boolean);
  if (opts.length < 2) throw new ConvexError("Need at least 2 options");
  return opts;
}

export async function insertBet(
  ctx: MutationCtx,
  roundId: Id<"rounds">,
  question: string,
  k: "yesno" | "overunder" | "multi",
  line?: number,
  options?: string[],
  subjectUserId?: Id<"users">,
) {
  const opts = optionsFor(k, line, options);
  const existing = await ctx.db
    .query("bets")
    .withIndex("by_round", (q) => q.eq("roundId", roundId))
    .collect();
  const betId = await ctx.db.insert("bets", {
    roundId,
    question: question.trim(),
    kind: k,
    options: opts,
    line,
    pools: opts.map(() => 0),
    status: "open",
    order: existing.length,
    subjectUserId,
  });
  await ctx.db.insert("ticks", { betId, t: Date.now(), pct: percents(opts.map(() => 0)) });
  return betId;
}

export async function ensureRound(ctx: MutationCtx, opensAt: number, group?: Id<"groups">) {
  const groupId = group ?? (await ensureDefaultGroup(ctx));
  const existing = await ctx.db
    .query("rounds")
    .withIndex("by_group_opensAt", (q) => q.eq("groupId", groupId).eq("opensAt", opensAt))
    .first();
  if (existing) return existing._id;
  const last = await ctx.db
    .query("rounds")
    .withIndex("by_group_opensAt", (q) => q.eq("groupId", groupId))
    .order("desc")
    .first();
  const number = (last?.number ?? 0) + 1;
  return await ctx.db.insert("rounds", {
    number,
    title: "Drop " + number,
    opensAt,
    locksAt: opensAt + LOCK_AFTER_MS,
    groupId,
  });
}

export const migrateGroups = internalMutation({
  args: {},
  handler: async (ctx) => {
    const groupId = await ensureDefaultGroup(ctx);
    let rounds = 0;
    for (const r of await ctx.db.query("rounds").collect()) {
      if (!r.groupId) {
        await ctx.db.patch(r._id, { groupId });
        rounds++;
      }
    }
    let users = 0;
    for (const u of await ctx.db.query("users").collect()) {
      if (!u.username) {
        const username = await uniqueUsername(ctx, normalizeUsername(u.name), u._id);
        await ctx.db.patch(u._id, { username, name: username });
        users++;
      }
      const m = await ctx.db
        .query("members")
        .withIndex("by_group_user", (q) => q.eq("groupId", groupId).eq("userId", u._id))
        .first();
      if (!m) await ctx.db.insert("members", { groupId, userId: u._id });
    }
    return { groupId, rounds, users };
  },
});

async function ensureDefaultGroupId(ctx: QueryCtx) {
  return (await ctx.db.query("groups").withIndex("by_default", (q) => q.eq("isDefault", true)).first())?._id ?? null;
}

export const check = query({
  args: { passcode: v.string() },
  handler: async (_ctx, { passcode }) => {
    try {
      requireAdmin(passcode);
      return true;
    } catch {
      return false;
    }
  },
});

export const overview = query({
  args: { passcode: v.string() },
  handler: async (ctx, { passcode }) => {
    requireAdmin(passcode);
    const groupId = await ensureDefaultGroupId(ctx);
    const rounds = await ctx.db
      .query("rounds")
      .withIndex("by_group_opensAt", (q) => q.eq("groupId", groupId ?? undefined))
      .order("desc")
      .take(6);
    return await Promise.all(
      rounds.map(async (r) => ({
        ...r,
        bets: (
          await ctx.db
            .query("bets")
            .withIndex("by_round", (q) => q.eq("roundId", r._id))
            .collect()
        ).sort((a, b) => a.order - b.order),
      })),
    );
  },
});

export const settlePreview = query({
  args: { passcode: v.string(), betId: v.id("bets"), winningOption: v.number() },
  handler: async (ctx, { passcode, betId, winningOption }) => {
    requireAdmin(passcode);
    const bet = await ctx.db.get(betId);
    if (!bet) return null;
    const total = bet.pools.reduce((a, b) => a + b, 0);
    const winPool = bet.pools[winningOption];
    const stakes = await ctx.db
      .query("stakes")
      .withIndex("by_bet", (q) => q.eq("betId", betId))
      .collect();
    const winners = stakes.filter((s) => s.option === winningOption);
    if (winPool === 0) return { refund: true, total, winners: 0, biggest: null };
    let biggest: { name: string; emoji: string; amount: number } | null = null;
    const byUser = new Map<string, number>();
    for (const s of winners) {
      const p = Math.floor(((total * s.amount) / winPool) * multiplier(s.streakAtBet));
      byUser.set(s.userId, (byUser.get(s.userId) ?? 0) + p);
    }
    for (const [uid, amount] of byUser) {
      if (!biggest || amount > biggest.amount) {
        const u = await ctx.db.get(uid as Id<"users">);
        if (u) biggest = { name: u.name, emoji: u.emoji, amount };
      }
    }
    return { refund: false, total, winners: byUser.size, biggest };
  },
});

export const addBet = mutation({
  args: {
    passcode: v.string(),
    roundId: v.id("rounds"),
    question: v.string(),
    kind,
    line: v.optional(v.number()),
    options: v.optional(v.array(v.string())),
  },
  handler: async (ctx, a) => {
    requireAdmin(a.passcode);
    if (!a.question.trim()) throw new ConvexError("Write a question");
    return await insertBet(ctx, a.roundId, a.question, a.kind, a.line, a.options);
  },
});

export const editBet = mutation({
  args: { passcode: v.string(), betId: v.id("bets"), question: v.string() },
  handler: async (ctx, { passcode, betId, question }) => {
    requireAdmin(passcode);
    await ctx.db.patch(betId, { question: question.trim() });
  },
});

export const deleteBet = mutation({
  args: { passcode: v.string(), betId: v.id("bets") },
  handler: async (ctx, { passcode, betId }) => {
    requireAdmin(passcode);
    await refundAll(ctx, betId);
    await ctx.db.delete(betId);
  },
});

export const lockBet = mutation({
  args: { passcode: v.string(), betId: v.id("bets"), locked: v.boolean() },
  handler: async (ctx, { passcode, betId, locked }) => {
    requireAdmin(passcode);
    const bet = await ctx.db.get(betId);
    if (!bet || bet.status === "settled" || bet.status === "refunded")
      throw new ConvexError("Already settled");
    await ctx.db.patch(betId, { status: locked ? "locked" : "open" });
  },
});

async function refundAll(ctx: MutationCtx, betId: Id<"bets">) {
  const stakes = await ctx.db
    .query("stakes")
    .withIndex("by_bet", (q) => q.eq("betId", betId))
    .collect();
  for (const s of stakes) {
    if (s.payout !== undefined) continue;
    const u = await ctx.db.get(s.userId);
    if (u) await ctx.db.patch(u._id, { points: u.points + s.amount });
    await ctx.db.patch(s._id, { payout: s.amount });
  }
}

export async function settleBet(ctx: MutationCtx, betId: Id<"bets">, winningOption: number | null) {
  const bet = await ctx.db.get(betId);
  if (!bet) throw new ConvexError("Bet not found");
  if (bet.status === "settled" || bet.status === "refunded") throw new ConvexError("Already settled");
  const winPool = winningOption === null ? 0 : bet.pools[winningOption];
  if (winningOption === null || winPool === 0) {
    await refundAll(ctx, betId);
    await ctx.db.patch(betId, { status: "refunded", winningOption: winningOption ?? undefined });
    return { refunded: true };
  }
  const total = bet.pools.reduce((a, b) => a + b, 0);
  const stakes = await ctx.db
    .query("stakes")
    .withIndex("by_bet", (q) => q.eq("betId", betId))
    .collect();
  for (const s of stakes) {
    if (s.option !== winningOption) {
      await ctx.db.patch(s._id, { payout: 0 });
      continue;
    }
    const payout = Math.floor(((total * s.amount) / winPool) * multiplier(s.streakAtBet));
    const u = await ctx.db.get(s.userId);
    if (u) await ctx.db.patch(u._id, { points: u.points + payout });
    await ctx.db.patch(s._id, { payout });
  }
  await ctx.db.patch(betId, { status: "settled", winningOption });
  return { refunded: false };
}

export const settle = mutation({
  args: { passcode: v.string(), betId: v.id("bets"), winningOption: v.union(v.number(), v.null()) },
  handler: async (ctx, { passcode, betId, winningOption }) => {
    requireAdmin(passcode);
    return await settleBet(ctx, betId, winningOption);
  },
});

export const createRound = mutation({
  args: { passcode: v.string(), opensAt: v.number() },
  handler: async (ctx, { passcode, opensAt }) => {
    requireAdmin(passcode);
    return await ensureRound(ctx, opensAt);
  },
});

export const setRoundTimes = mutation({
  args: { passcode: v.string(), roundId: v.id("rounds"), opensAt: v.number(), locksAt: v.number() },
  handler: async (ctx, { passcode, roundId, opensAt, locksAt }) => {
    requireAdmin(passcode);
    await ctx.db.patch(roundId, { opensAt, locksAt });
  },
});

export const ensureNextRound = internalMutation({
  args: {},
  handler: async (ctx) => {
    const nextHour = Math.ceil((Date.now() + 1) / HOUR) * HOUR;
    await ensureRound(ctx, nextHour);
  },
});

export const seed = internalMutation({
  args: { opensAt: v.number() },
  handler: async (ctx, { opensAt }) => {
    const roundId = await ensureRound(ctx, opensAt);
    const bets = await ctx.db
      .query("bets")
      .withIndex("by_round", (q) => q.eq("roundId", roundId))
      .collect();
    if (bets.length > 0) return roundId;
    await insertBet(ctx, roundId, "Is dinner pizza tonight?", "yesno");
    await insertBet(ctx, roundId, "How many dating apps get built today?", "overunder", 3.5);
    await insertBet(ctx, roundId, "Does a demo crash live on stage at finals?", "yesno");
    return roundId;
  },
});

export const seedBets = internalMutation({
  args: {
    opensAt: v.number(),
    bets: v.array(v.object({ question: v.string(), kind, line: v.optional(v.number()), counter: v.optional(v.number()) })),
  },
  handler: async (ctx, { opensAt, bets }) => {
    const roundId = await ensureRound(ctx, opensAt);
    const existing = await ctx.db
      .query("bets")
      .withIndex("by_round", (q) => q.eq("roundId", roundId))
      .collect();
    for (const b of bets) {
      if (existing.some((e) => e.question === b.question)) continue;
      const id = await insertBet(ctx, roundId, b.question, b.kind, b.line);
      if (b.counter !== undefined) await ctx.db.patch(id, { counter: b.counter });
    }
    return roundId;
  },
});

export const testRound = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const roundId = await ctx.db.insert("rounds", {
      number: 0,
      title: "Test drop",
      opensAt: now - 11 * 60 * 1000,
      locksAt: now + 30 * 60 * 1000,
    });
    await insertBet(ctx, roundId, "Test: does the API respond?", "yesno");
    await insertBet(ctx, roundId, "Test: pick a color", "multi", undefined, ["Red", "Green", "Blue"]);
    return roundId;
  },
});

export const wipeRound = internalMutation({
  args: { roundId: v.id("rounds") },
  handler: async (ctx, { roundId }) => {
    const bets = await ctx.db
      .query("bets")
      .withIndex("by_round", (q) => q.eq("roundId", roundId))
      .collect();
    for (const b of bets) {
      for (const s of await ctx.db.query("stakes").withIndex("by_bet", (q) => q.eq("betId", b._id)).collect())
        await ctx.db.delete(s._id);
      for (const t of await ctx.db.query("ticks").withIndex("by_bet", (q) => q.eq("betId", b._id)).collect())
        await ctx.db.delete(t._id);
      await ctx.db.delete(b._id);
    }
    await ctx.db.delete(roundId);
  },
});

export const purgeTestUsers = internalMutation({
  args: { prefix: v.string() },
  handler: async (ctx, { prefix }) => {
    const users = (await ctx.db.query("users").collect()).filter((u) => (u.username ?? u.name).startsWith(prefix));
    for (const u of users) {
      for (const g of (await ctx.db.query("groups").collect()).filter((g) => g.createdBy === u._id)) {
        for (const r of await ctx.db.query("rounds").withIndex("by_group_opensAt", (q) => q.eq("groupId", g._id)).collect()) {
          for (const b of await ctx.db.query("bets").withIndex("by_round", (q) => q.eq("roundId", r._id)).collect()) {
            for (const s of await ctx.db.query("stakes").withIndex("by_bet", (q) => q.eq("betId", b._id)).collect()) await ctx.db.delete(s._id);
            for (const t of await ctx.db.query("ticks").withIndex("by_bet", (q) => q.eq("betId", b._id)).collect()) await ctx.db.delete(t._id);
            await ctx.db.delete(b._id);
          }
          await ctx.db.delete(r._id);
        }
        for (const m of await ctx.db.query("members").withIndex("by_group", (q) => q.eq("groupId", g._id)).collect()) await ctx.db.delete(m._id);
        await ctx.db.delete(g._id);
      }
      for (const m of await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", u._id)).collect()) await ctx.db.delete(m._id);
      for (const s of await ctx.db.query("stakes").withIndex("by_user", (q) => q.eq("userId", u._id)).collect()) {
        const b = await ctx.db.get(s.betId);
        if (b && s.payout === undefined) await ctx.db.patch(b._id, { pools: b.pools.map((p, i) => (i === s.option ? p - s.amount : p)) });
        await ctx.db.delete(s._id);
      }
      await ctx.db.delete(u._id);
    }
    return users.length;
  },
});

export const markTest = internalMutation({
  args: { usernames: v.array(v.string()), isTest: v.boolean() },
  handler: async (ctx, { usernames, isTest }) => {
    let n = 0;
    for (const u of await ctx.db.query("users").collect()) {
      if (usernames.includes(u.username ?? u.name) || (isTest && isTestName(u.username ?? u.name))) {
        await ctx.db.patch(u._id, { isTest });
        n++;
      }
    }
    return n;
  },
});

export const adjustCounter = mutation({
  args: { passcode: v.string(), betId: v.id("bets"), delta: v.number() },
  handler: async (ctx, { passcode, betId, delta }) => {
    requireAdmin(passcode);
    const bet = await ctx.db.get(betId);
    if (!bet) throw new ConvexError("Bet not found");
    if (bet.line === undefined) throw new ConvexError("Counters are for over/under bets");
    await ctx.db.patch(betId, { counter: Math.max(0, (bet.counter ?? 0) + Math.sign(delta)) });
  },
});

export const settleFromCounter = mutation({
  args: { passcode: v.string(), betId: v.id("bets") },
  handler: async (ctx, { passcode, betId }) => {
    requireAdmin(passcode);
    const bet = await ctx.db.get(betId);
    if (!bet || bet.line === undefined || bet.counter === undefined) throw new ConvexError("No counter on this bet");
    return await settleBet(ctx, betId, bet.counter > bet.line ? 0 : 1);
  },
});

export const deleteUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await ctx.db.delete(userId);
  },
});

export type _Unused = Doc<"bets">;
