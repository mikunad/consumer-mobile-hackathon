import { mutation, query, QueryCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { START_POINTS, percents, requireUser, userByToken } from "./lib";
import { sidesFor } from "./market";
import { betRevealAt } from "./chat";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomString(chars: string, n: number) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export const createPair = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);
    let code = "";
    for (let i = 0; i < 10; i++) {
      code = randomString(CODE_CHARS, 6);
      const clash = await ctx.db.query("pairs").withIndex("by_code", (q) => q.eq("code", code)).first();
      if (!clash || clash.usedAt !== undefined || clash.expiresAt < Date.now()) break;
    }
    const expiresAt = Date.now() + 10 * 60 * 1000;
    await ctx.db.insert("pairs", { userId: user._id, code, expiresAt });
    return { code, expiresAt };
  },
});

export const redeemPair = mutation({
  args: { code: v.string(), device: v.string() },
  handler: async (ctx, { code, device }) => {
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const pair = await ctx.db.query("pairs").withIndex("by_code", (q) => q.eq("code", clean)).order("desc").first();
    if (!pair || pair.usedAt !== undefined || pair.expiresAt < Date.now()) throw new ConvexError("That code is expired or already used. Make a new one in the app.");
    await ctx.db.patch(pair._id, { usedAt: Date.now() });
    const user = await ctx.db.get(pair.userId);
    if (!user) throw new ConvexError("Account not found");
    const token = randomString("abcdefghijklmnopqrstuvwxyz0123456789", 40);
    await ctx.db.insert("sessions", { userId: user._id, token, device: device.slice(0, 60) });
    return { token, user: { _id: user._id, name: user.name, emoji: user.emoji } };
  },
});

async function memberRow(ctx: QueryCtx, groupId: Id<"groups">, userId: Id<"users">) {
  return await ctx.db
    .query("members")
    .withIndex("by_group_user", (q) => q.eq("groupId", groupId).eq("userId", userId))
    .first();
}

async function roomMembers(ctx: QueryCtx, groupId: Id<"groups">) {
  const rows = await ctx.db.query("members").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect();
  const out = [];
  for (const m of rows) {
    const u = await ctx.db.get(m.userId);
    if (u) out.push({ _id: u._id, name: u.name, emoji: u.emoji, points: m.points ?? START_POINTS });
  }
  return out.sort((a, b) => b.points - a.points);
}

export const me = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await userByToken(ctx, token);
    if (!user) return null;
    const rows = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    const rooms = [];
    for (const m of rows) {
      const g = await ctx.db.get(m.groupId);
      if (!g || g.kind !== "chat") continue;
      rooms.push({ _id: g._id, name: g.name, inviteCode: g.inviteCode ?? null, revealAt: g.revealAt ?? null, members: await roomMembers(ctx, g._id) });
    }
    return { user: { _id: user._id, name: user.name, emoji: user.emoji }, rooms };
  },
});

async function betRoom(ctx: QueryCtx, bet: Doc<"bets">) {
  const round = await ctx.db.get(bet.roundId);
  const group = round?.groupId ? await ctx.db.get(round.groupId) : null;
  return group && group.kind === "chat" ? group : null;
}

export const card = query({
  args: { token: v.optional(v.string()), betId: v.string(), now: v.number() },
  handler: async (ctx, { token, betId, now: clientNow }) => {
    const now = Math.min(clientNow, Date.now());
    const id = ctx.db.normalizeId("bets", betId);
    const bet = id ? await ctx.db.get(id) : null;
    const user = await userByToken(ctx, token);
    if (!bet || !user) return { access: "none" as const };
    const group = await betRoom(ctx, bet);
    const me = group ? await memberRow(ctx, group._id, user._id) : null;
    if (!group || !me) return { access: "none" as const };
    const stakes = await ctx.db.query("stakes").withIndex("by_bet", (q) => q.eq("betId", bet._id)).collect();
    const bettorIds = [...new Set(stakes.map((s) => s.userId))];
    const bettors = [];
    const who = [];
    for (const uid of bettorIds) {
      const u = await ctx.db.get(uid);
      if (!u) continue;
      bettors.push(u.emoji);
      who.push({ name: u.name, emoji: u.emoji, amount: stakes.filter((s) => s.userId === uid).reduce((a, s) => a + s.amount, 0) });
    }
    const subject = bet.subjectUserId ? await ctx.db.get(bet.subjectUserId) : null;
    const revealAt = betRevealAt(bet, group);
    const revealed = now >= revealAt;
    const total = bet.pools.reduce((a, b) => a + b, 0);
    const room = { _id: group._id, name: group.name };
    const subj = subject ? { _id: subject._id, name: subject.name, emoji: subject.emoji } : null;
    const isSubject = bet.subjectUserId === user._id;
    if (isSubject && !revealed) return { access: "sealed" as const, room, subject: subj, revealAt, bettors, who, friends: bettorIds.length, total };
    const author = bet.createdBy ? await ctx.db.get(bet.createdBy) : null;
    const mine = stakes.filter((s) => s.userId === user._id);
    return {
      access: "open" as const,
      room,
      subject: subj,
      author: bet.byAI ? null : author ? { name: author.name, emoji: author.emoji } : null,
      ai: !!bet.byAI,
      question: bet.question,
      kind: bet.kind,
      options: bet.options,
      line: bet.line ?? null,
      pct: percents(bet.pools),
      pools: bet.pools,
      total,
      status: bet.status,
      winningOption: bet.winningOption ?? null,
      revealAt,
      revealed,
      isSubject,
      canDeclare: revealed && bet.status === "open" && (isSubject || (!bet.subjectUserId && bet.createdBy === user._id)),
      mine: mine.length ? { option: mine[0].option, amount: mine.reduce((a, s) => a + s.amount, 0) } : null,
      points: me.points ?? START_POINTS,
      sides: (await sidesFor(ctx, bet, user._id)).map((side) => side.map((p) => ({ name: p.name, emoji: p.emoji, amount: p.amount, me: p.me }))),
      bettors,
    };
  },
});

export const board = query({
  args: { token: v.string(), roomId: v.string() },
  handler: async (ctx, { token, roomId }) => {
    const user = await userByToken(ctx, token);
    const gid = ctx.db.normalizeId("groups", roomId);
    const group = gid ? await ctx.db.get(gid) : null;
    if (!user || !group || group.kind !== "chat" || !(await memberRow(ctx, group._id, user._id))) return null;
    const members = await roomMembers(ctx, group._id);
    const rounds = await ctx.db.query("rounds").withIndex("by_group_opensAt", (q) => q.eq("groupId", group._id)).collect();
    const settled: Doc<"bets">[] = [];
    for (const r of rounds) settled.push(...(await ctx.db.query("bets").withIndex("by_round", (q) => q.eq("roundId", r._id)).collect()).filter((b) => b.status === "settled"));
    settled.sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
    const record = new Map<string, boolean[]>();
    for (const b of settled) {
      const stakes = await ctx.db.query("stakes").withIndex("by_bet", (q) => q.eq("betId", b._id)).collect();
      for (const uid of new Set(stakes.map((s) => s.userId))) {
        const s = stakes.find((x) => x.userId === uid)!;
        record.set(uid, [...(record.get(uid) ?? []), s.option === b.winningOption]);
      }
    }
    return {
      room: { _id: group._id, name: group.name },
      rows: members.map((m) => {
        const r = record.get(m._id) ?? [];
        let streak = 0;
        for (let i = r.length - 1; i >= 0 && r[i]; i--) streak++;
        return { ...m, streak, correct: r.filter(Boolean).length, called: r.length };
      }),
    };
  },
});
