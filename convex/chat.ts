import { mutation, query, QueryCtx, MutationCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { START_POINTS, percents, requireAdmin, requireUser, userByToken } from "./lib";
import { insertBet } from "./admin";
import { sidesFor } from "./market";

const CREW = ["mikun", "mikunad", "febe", "jill"];
const CREW_INVITE = "jill5pm";
const CREW_NAME = "Mikun, Febe & Jill";
const REVEAL_AT = Date.UTC(2026, 10, 16, 1, 0, 0);

const kind = v.union(v.literal("yesno"), v.literal("overunder"), v.literal("multi"));

async function memberRow(ctx: QueryCtx, groupId: Id<"groups">, userId: Id<"users">) {
  return await ctx.db
    .query("members")
    .withIndex("by_group_user", (q) => q.eq("groupId", groupId).eq("userId", userId))
    .first();
}

async function chatGroupOf(ctx: QueryCtx, userId: Id<"users">) {
  const rows = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
  for (const m of rows) {
    const g = await ctx.db.get(m.groupId);
    if (g?.kind === "chat") return g;
  }
  return null;
}

async function roundOf(ctx: QueryCtx, groupId: Id<"groups">) {
  return await ctx.db
    .query("rounds")
    .withIndex("by_group_opensAt", (q) => q.eq("groupId", groupId))
    .order("desc")
    .first();
}

async function ensureCrew(ctx: MutationCtx) {
  const found = await ctx.db
    .query("groups")
    .withIndex("by_invite", (q) => q.eq("inviteCode", CREW_INVITE))
    .first();
  const groupId =
    found?._id ?? (await ctx.db.insert("groups", { name: CREW_NAME, kind: "chat", inviteCode: CREW_INVITE, revealAt: REVEAL_AT }));
  if (!(await roundOf(ctx, groupId))) {
    const opensAt = Date.now() - 60 * 1000;
    await ctx.db.insert("rounds", { number: 1, title: "The 5:00 drop", opensAt, locksAt: REVEAL_AT, revealAt: REVEAL_AT, groupId });
  }
  return groupId;
}

function isRevealed(group: Doc<"groups">, now: number) {
  return now >= (group.revealAt ?? REVEAL_AT);
}

export function betRevealAt(bet: Doc<"bets">, group: Doc<"groups">) {
  return bet.revealAt ?? group.revealAt ?? REVEAL_AT;
}

function betRevealed(bet: Doc<"bets">, group: Doc<"groups">, now: number) {
  return now >= betRevealAt(bet, group);
}

export const enter = mutation({
  args: { token: v.string(), invite: v.optional(v.string()) },
  handler: async (ctx, { token, invite }) => {
    const user = await requireUser(ctx, token);
    if (CREW.includes(user.username ?? "")) {
      const crew = await ensureCrew(ctx);
      if (!(await memberRow(ctx, crew, user._id))) await ctx.db.insert("members", { groupId: crew, userId: user._id, points: START_POINTS });
      return crew;
    }
    const existing = await chatGroupOf(ctx, user._id);
    if (existing) return existing._id;
    const code = invite?.trim().toLowerCase();
    let groupId: Id<"groups"> | null = null;
    if (code && code !== CREW_INVITE) {
      groupId = (await ctx.db.query("groups").withIndex("by_invite", (q) => q.eq("inviteCode", code)).first())?._id ?? null;
      if (!groupId) throw new ConvexError("That invite code doesn't match a group");
    } else if (code === CREW_INVITE || CREW.includes(user.username ?? "")) {
      groupId = await ensureCrew(ctx);
    }
    if (!groupId) return null;
    if (!(await memberRow(ctx, groupId, user._id))) await ctx.db.insert("members", { groupId, userId: user._id, points: START_POINTS });
    return groupId;
  },
});

export const home = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await userByToken(ctx, token);
    if (!user) return { user: null, groupId: null, groups: [], stats: null };
    const rows = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    const groups = [];
    let total = 0;
    let best: { rank: number; name: string } | null = null;
    const against = new Map<string, number>();
    for (const m of rows) {
      const g = await ctx.db.get(m.groupId);
      if (!g || g.kind !== "chat") continue;
      const members = await ctx.db.query("members").withIndex("by_group", (q) => q.eq("groupId", g._id)).collect();
      const users = (await Promise.all(members.map((x) => ctx.db.get(x.userId)))).filter((u) => u !== null);
      const pts = members.map((x) => x.points ?? START_POINTS).sort((a, b) => b - a);
      const mine = m.points ?? START_POINTS;
      total += mine;
      const rank = pts.indexOf(mine) + 1;
      if (!best || rank < best.rank) best = { rank, name: g.name };
      const round = await roundOf(ctx, g._id);
      const bets = round ? await ctx.db.query("bets").withIndex("by_round", (q) => q.eq("roundId", round._id)).collect() : [];
      let last: { t: number; text: string } | null = null;
      for (const b of bets) {
        const stakes = await ctx.db.query("stakes").withIndex("by_bet", (q) => q.eq("betId", b._id)).collect();
        const myStake = stakes.find((s) => s.userId === user._id);
        if (b.winningOption !== undefined && b.status === "settled") {
          for (const s of stakes) {
            if (s.option !== b.winningOption || s.userId === user._id) continue;
            if (b.subjectUserId === user._id || (myStake && myStake.option !== s.option)) against.set(s.userId, (against.get(s.userId) ?? 0) + 1);
          }
        }
        const author = b.byAI ? "AI" : users.find((u) => u._id === b.createdBy)?.name ?? "someone";
        const text = b.subjectUserId === user._id && now() < betRevealAt(b, g) ? author + ": 🔒 a bet about you" : author + ": " + b.question;
        if (!last || b._creationTime > last.t) last = { t: b._creationTime, text };
      }
      groups.push({
        _id: g._id,
        name: g.name,
        inviteCode: g.inviteCode ?? null,
        faces: users.filter((u) => u._id !== user._id).map((u) => u.emoji),
        people: users.filter((u) => u._id !== user._id).map((u) => ({ name: u.name, emoji: u.emoji })),
        members: users.length,
        last,
        rank,
        points: mine,
      });
    }
    groups.sort((a, b) => (b.last?.t ?? 0) - (a.last?.t ?? 0));
    let nemesis: { name: string; emoji: string; times: number } | null = null;
    for (const [id, times] of against) {
      if (nemesis && times <= nemesis.times) continue;
      const u = await ctx.db.get(id as Id<"users">);
      if (u) nemesis = { name: u.name, emoji: u.emoji, times };
    }
    return {
      user: { _id: user._id, name: user.name, emoji: user.emoji },
      groupId: groups[0]?._id ?? null,
      groups,
      stats: { total, best, nemesis },
    };
  },
});

function now() {
  return Date.now();
}

export const createGroup = mutation({
  args: { token: v.string(), name: v.string() },
  handler: async (ctx, { token, name }) => {
    const user = await requireUser(ctx, token);
    const clean = name.trim().slice(0, 32);
    if (clean.length < 2) throw new ConvexError("Give your group a name");
    let inviteCode = "";
    for (let i = 0; i < 20; i++) {
      inviteCode = clean.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) + Math.floor(100 + Math.random() * 900);
      if (!(await ctx.db.query("groups").withIndex("by_invite", (q) => q.eq("inviteCode", inviteCode)).first())) break;
    }
    const groupId = await ctx.db.insert("groups", { name: clean, createdBy: user._id, kind: "chat", inviteCode, revealAt: REVEAL_AT });
    await ctx.db.insert("rounds", { number: 1, title: "The 5:00 drop", opensAt: Date.now() - 60 * 1000, locksAt: REVEAL_AT, revealAt: REVEAL_AT, groupId });
    await ctx.db.insert("members", { groupId, userId: user._id, points: START_POINTS });
    return groupId;
  },
});

export const join = mutation({
  args: { token: v.string(), invite: v.string() },
  handler: async (ctx, { token, invite }) => {
    const user = await requireUser(ctx, token);
    const code = invite.trim().toLowerCase();
    const groupId = code === CREW_INVITE ? await ensureCrew(ctx) : (await ctx.db.query("groups").withIndex("by_invite", (q) => q.eq("inviteCode", code)).first())?._id;
    if (!groupId) throw new ConvexError("That invite code doesn't match a group");
    if (!(await memberRow(ctx, groupId, user._id))) await ctx.db.insert("members", { groupId, userId: user._id, points: START_POINTS });
    return groupId;
  },
});

type Who = { _id: Id<"users">; name: string; emoji: string };

export const thread = query({
  args: { token: v.optional(v.string()), groupId: v.id("groups"), now: v.number() },
  handler: async (ctx, { token, groupId, now }) => {
    const user = await userByToken(ctx, token);
    const group = await ctx.db.get(groupId);
    if (!user || !group) return null;
    const me = await memberRow(ctx, groupId, user._id);
    if (!me) return null;
    const revealed = isRevealed(group, now);
    const memberRows = await ctx.db.query("members").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect();
    const people = new Map<string, Who & { points: number }>();
    for (const m of memberRows) {
      const u = await ctx.db.get(m.userId);
      if (u) people.set(u._id, { _id: u._id, name: u.name, emoji: u.emoji, points: m.points ?? START_POINTS });
    }
    const who = async (id: Id<"users"> | undefined): Promise<Who | null> => {
      if (!id) return null;
      const p = people.get(id);
      if (p) return { _id: p._id, name: p.name, emoji: p.emoji };
      const u = await ctx.db.get(id);
      return u ? { _id: u._id, name: u.name, emoji: u.emoji } : null;
    };
    const round = await roundOf(ctx, groupId);
    const bets = round ? await ctx.db.query("bets").withIndex("by_round", (q) => q.eq("roundId", round._id)).collect() : [];
    const items: unknown[] = [];
    const aboutMe = { bets: 0, friends: new Set<string>(), points: 0 };
    for (const b of bets.sort((x, y) => x._creationTime - y._creationTime)) {
      const stakes = await ctx.db.query("stakes").withIndex("by_bet", (q) => q.eq("betId", b._id)).collect();
      const total = b.pools.reduce((a, c) => a + c, 0);
      const stakers = new Set(stakes.map((s) => s.userId));
      const sealed = b.subjectUserId === user._id && !betRevealed(b, group, now);
      if (b.subjectUserId === user._id) {
        aboutMe.bets++;
        for (const s of stakers) aboutMe.friends.add(s);
        aboutMe.points += total;
      }
      if (sealed) {
        items.push({ type: "sealed", _id: b._id, t: b._creationTime, friends: stakers.size, total, author: b.byAI ? { _id: "ai", name: "AI", emoji: "✦" } : await who(b.createdBy), faces: [...stakers].map((id) => people.get(id)).filter((p) => p).map((p) => ({ emoji: p!.emoji, name: p!.name })) });
        continue;
      }
      const mine = stakes.filter((s) => s.userId === user._id);
      items.push({
        type: "bet",
        _id: b._id,
        t: b._creationTime,
        question: b.question,
        kind: b.kind,
        options: b.options,
        line: b.line,
        pools: b.pools,
        pct: percents(b.pools),
        total,
        bettors: stakers.size,
        status: b.status,
        winningOption: b.winningOption,
        subject: await who(b.subjectUserId),
        author: b.byAI ? { _id: "ai", name: "AI", emoji: "✦" } : await who(b.createdBy),
        ai: !!b.byAI,
        aboutMe: b.subjectUserId === user._id,
        mine: mine.length ? { option: mine[0].option, amount: mine.reduce((a, s) => a + s.amount, 0), payout: mine.every((s) => s.payout !== undefined) ? mine.reduce((a, s) => a + (s.payout ?? 0), 0) : undefined } : null,
        faces: [...stakers].map((id) => people.get(id)).filter((p) => p).map((p) => ({ emoji: p!.emoji, name: p!.name })),
      });
      for (const s of stakes.sort((x, y) => x._creationTime - y._creationTime)) {
        const p = await who(s.userId);
        items.push({ type: "stake", _id: s._id, t: s._creationTime, betId: b._id, who: p, amount: s.amount, option: b.options[s.option], question: b.question });
      }
      if (b.settledAt !== undefined) {
        const won = new Map<string, number>();
        for (const s of stakes) if ((s.payout ?? 0) > 0 && b.status === "settled") won.set(s.userId, (won.get(s.userId) ?? 0) + (s.payout ?? 0) - s.amount);
        const payouts = [];
        for (const [id, net] of won) {
          const p = await who(id as Id<"users">);
          if (p) payouts.push({ emoji: p.emoji, name: p.name, net });
        }
        items.push({ type: "settled", _id: b._id + ":settled", t: b.settledAt, betId: b._id, question: b.question, status: b.status, winner: b.winningOption === undefined ? null : b.options[b.winningOption], subject: await who(b.subjectUserId), payouts });
      }
    }
    items.sort((a, b) => (a as { t: number }).t - (b as { t: number }).t);
    return {
      group: { _id: group._id, name: group.name, inviteCode: group.inviteCode ?? null, revealAt: group.revealAt ?? REVEAL_AT, revealed },
      me: { _id: user._id, name: user.name, emoji: user.emoji, points: me.points ?? START_POINTS },
      members: [...people.values()].sort((a, b) => b.points - a.points),
      items,
      aboutMe: { bets: aboutMe.bets, friends: aboutMe.friends.size, points: aboutMe.points },
    };
  },
});

export const market = query({
  args: { token: v.optional(v.string()), betId: v.id("bets"), now: v.number() },
  handler: async (ctx, { token, betId, now }) => {
    const user = await userByToken(ctx, token);
    const bet = await ctx.db.get(betId);
    if (!user || !bet) return null;
    const round = await ctx.db.get(bet.roundId);
    const group = round?.groupId ? await ctx.db.get(round.groupId) : null;
    if (!round || !group) return null;
    const me = await memberRow(ctx, group._id, user._id);
    if (!me) return null;
    const revealed = betRevealed(bet, group, now);
    if (bet.subjectUserId === user._id && !revealed) return null;
    const ticks = await ctx.db.query("ticks").withIndex("by_bet", (q) => q.eq("betId", bet._id)).collect();
    const subject = bet.subjectUserId ? await ctx.db.get(bet.subjectUserId) : null;
    const author = bet.createdBy ? await ctx.db.get(bet.createdBy) : null;
    const mine = (await ctx.db.query("stakes").withIndex("by_bet", (q) => q.eq("betId", bet._id)).collect()).filter((s) => s.userId === user._id);
    return {
      _id: bet._id,
      question: bet.question,
      kind: bet.kind,
      options: bet.options,
      line: bet.line,
      pools: bet.pools,
      pct: percents(bet.pools),
      total: bet.pools.reduce((a, b) => a + b, 0),
      status: bet.status,
      winningOption: bet.winningOption,
      locked: bet.status !== "open" || revealed,
      revealed,
      opensAt: round.opensAt,
      revealAt: betRevealAt(bet, group),
      subject: subject ? { _id: subject._id, name: subject.name, emoji: subject.emoji } : null,
      author: author ? { name: author.name, emoji: author.emoji } : null,
      isSubject: bet.subjectUserId === user._id,
      canDeclare: revealed && bet.status === "open" && (bet.subjectUserId === user._id || (!bet.subjectUserId && bet.createdBy === user._id)),
      ticks: ticks.sort((a, b) => a.t - b.t).map((t) => ({ t: t.t, pct: t.pct })),
      sides: await sidesFor(ctx, bet, user._id),
      mine: mine.length ? { option: mine[0].option, amount: mine.reduce((a, s) => a + s.amount, 0), payout: mine.every((s) => s.payout !== undefined) ? mine.reduce((a, s) => a + (s.payout ?? 0), 0) : undefined } : null,
      points: me.points ?? START_POINTS,
    };
  },
});

async function stakeOn(ctx: MutationCtx, user: Doc<"users">, bet: Doc<"bets">, option: number, amount: number) {
  const round = await ctx.db.get(bet.roundId);
  const group = round?.groupId ? await ctx.db.get(round.groupId) : null;
  if (!round || !group || group.kind !== "chat") throw new ConvexError("Bet not found");
  const me = await memberRow(ctx, group._id, user._id);
  if (!me) throw new ConvexError("You're not in this group");
  if (bet.subjectUserId === user._id) throw new ConvexError("This bet is about you");
  const now = Date.now();
  if (bet.status !== "open" || betRevealed(bet, group, now)) throw new ConvexError("Betting is closed");
  if (!Number.isInteger(option) || option < 0 || option >= bet.options.length) throw new ConvexError("Bad pick");
  const prior = (await ctx.db.query("stakes").withIndex("by_bet", (q) => q.eq("betId", bet._id)).collect()).find((s) => s.userId === user._id);
  if (prior && prior.option !== option) throw new ConvexError("You're already on " + bet.options[prior.option] + ". You can only add to that side.");
  const amt = Math.floor(amount);
  const points = me.points ?? START_POINTS;
  if (!Number.isFinite(amt) || amt < 1) throw new ConvexError("Stake at least 1 point");
  if (amt > points) throw new ConvexError("You only have " + points + " points");
  await ctx.db.patch(me._id, { points: points - amt });
  const pools = bet.pools.map((p, i) => (i === option ? p + amt : p));
  await ctx.db.patch(bet._id, { pools });
  await ctx.db.insert("ticks", { betId: bet._id, t: now, pct: percents(pools) });
  await ctx.db.insert("stakes", { betId: bet._id, roundId: round._id, userId: user._id, option, amount: amt, late: false, streakAtBet: 0 });
}

export const stake = mutation({
  args: { token: v.string(), betId: v.id("bets"), option: v.number(), amount: v.number() },
  handler: async (ctx, { token, betId, option, amount }) => {
    const user = await requireUser(ctx, token);
    const bet = await ctx.db.get(betId);
    if (!bet) throw new ConvexError("Bet not found");
    await stakeOn(ctx, user, bet, option, amount);
  },
});

export const createBet = mutation({
  args: {
    token: v.string(),
    groupId: v.id("groups"),
    subjectUserId: v.id("users"),
    kind,
    question: v.string(),
    line: v.optional(v.number()),
    options: v.optional(v.array(v.string())),
    option: v.number(),
    amount: v.number(),
    ai: v.optional(v.boolean()),
    revealAt: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const user = await requireUser(ctx, a.token);
    const group = await ctx.db.get(a.groupId);
    if (!group || group.kind !== "chat") throw new ConvexError("Group not found");
    if (!(await memberRow(ctx, a.groupId, user._id))) throw new ConvexError("You're not in this group");
    if (!(await memberRow(ctx, a.groupId, a.subjectUserId))) throw new ConvexError("Pick a friend from the group");
    if (a.subjectUserId === user._id) throw new ConvexError("You can't bet about yourself");
    const reveal = a.revealAt ?? group.revealAt ?? REVEAL_AT;
    if (reveal <= Date.now()) throw new ConvexError(a.revealAt ? "Pick a reveal time in the future" : "This drop is closed");
    const question = a.question.trim().slice(0, 140);
    if (question.length < 5) throw new ConvexError("Write the question");
    let line: number | undefined;
    let options: string[] | undefined;
    if (a.kind === "overunder") {
      if (a.line === undefined || !Number.isFinite(a.line) || a.line < 0) throw new ConvexError("Over/under needs a line");
      line = Math.floor(a.line) + 0.5;
    }
    if (a.kind === "multi") {
      options = (a.options ?? []).map((o) => o.trim().slice(0, 28));
      if (options.length !== 2 || options.some((o) => !o)) throw new ConvexError("Give both choices a name");
      if (options[0].toLowerCase() === options[1].toLowerCase()) throw new ConvexError("The two choices need different names");
    }
    const round = (await roundOf(ctx, a.groupId))?._id ?? (await ensureCrew(ctx), (await roundOf(ctx, a.groupId))!._id);
    const betId = await insertBet(ctx, round, question, a.kind, line, options, a.subjectUserId);
    await ctx.db.patch(betId, { createdBy: user._id, byAI: a.ai || undefined, revealAt: a.revealAt !== undefined && a.revealAt !== (group.revealAt ?? REVEAL_AT) ? a.revealAt : undefined });
    if (a.amount > 0) await stakeOn(ctx, user, (await ctx.db.get(betId))!, a.option, a.amount);
    return betId;
  },
});

export const declare = mutation({
  args: { token: v.string(), betId: v.id("bets"), winningOption: v.number() },
  handler: async (ctx, { token, betId, winningOption }) => {
    const user = await requireUser(ctx, token);
    const bet = await ctx.db.get(betId);
    if (!bet) throw new ConvexError("Bet not found");
    const round = await ctx.db.get(bet.roundId);
    const group = round?.groupId ? await ctx.db.get(round.groupId) : null;
    if (!group || group.kind !== "chat") throw new ConvexError("Bet not found");
    const allowed = bet.subjectUserId ? bet.subjectUserId === user._id : bet.createdBy === user._id;
    if (!allowed) throw new ConvexError("Only the person it's about can call it");
    if (!betRevealed(bet, group, Date.now())) throw new ConvexError("Wait for the reveal");
    if (bet.status !== "open") throw new ConvexError("Already called");
    if (!Number.isInteger(winningOption) || winningOption < 0 || winningOption >= bet.options.length) throw new ConvexError("Bad pick");
    const stakes = await ctx.db.query("stakes").withIndex("by_bet", (q) => q.eq("betId", betId)).collect();
    const total = bet.pools.reduce((a, b) => a + b, 0);
    const winPool = bet.pools[winningOption];
    for (const s of stakes) {
      const payout = winPool === 0 ? s.amount : s.option === winningOption ? Math.floor((total * s.amount) / winPool) : 0;
      const m = await memberRow(ctx, group._id, s.userId);
      if (m && payout > 0) await ctx.db.patch(m._id, { points: (m.points ?? START_POINTS) + payout });
      await ctx.db.patch(s._id, { payout });
    }
    await ctx.db.patch(betId, { status: winPool === 0 ? "refunded" : "settled", winningOption, settledAt: Date.now() });
  },
});

export const veto = mutation({
  args: { token: v.string(), betId: v.id("bets") },
  handler: async (ctx, { token, betId }) => {
    const user = await requireUser(ctx, token);
    const bet = await ctx.db.get(betId);
    if (!bet || bet.subjectUserId !== user._id) throw new ConvexError("Only the person it's about can veto");
    const round = await ctx.db.get(bet.roundId);
    const group = round?.groupId ? await ctx.db.get(round.groupId) : null;
    if (!group || !betRevealed(bet, group, Date.now())) throw new ConvexError("Wait for the reveal");
    if (bet.status !== "open") throw new ConvexError("Already called");
    for (const s of await ctx.db.query("stakes").withIndex("by_bet", (q) => q.eq("betId", betId)).collect()) {
      const m = await memberRow(ctx, group._id, s.userId);
      if (m) await ctx.db.patch(m._id, { points: (m.points ?? START_POINTS) + s.amount });
      await ctx.db.patch(s._id, { payout: s.amount });
    }
    await ctx.db.patch(betId, { status: "refunded", winningOption: undefined, settledAt: Date.now() });
  },
});

async function crewOrThrow(ctx: QueryCtx) {
  const g = await ctx.db.query("groups").withIndex("by_invite", (q) => q.eq("inviteCode", CREW_INVITE)).first();
  if (!g) throw new ConvexError("No crew group yet");
  return g;
}

async function groupState(ctx: QueryCtx, groupId: Id<"groups">) {
  const round = await roundOf(ctx, groupId);
  const bets = round ? await ctx.db.query("bets").withIndex("by_round", (q) => q.eq("roundId", round._id)).collect() : [];
  const stakes = [];
  for (const b of bets) stakes.push(...(await ctx.db.query("stakes").withIndex("by_bet", (q) => q.eq("betId", b._id)).collect()));
  const members = await ctx.db.query("members").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect();
  return { bets, stakes, members };
}

export const demoStatus = query({
  args: { passcode: v.string() },
  handler: async (ctx, { passcode }) => {
    requireAdmin(passcode);
    const g = await ctx.db.query("groups").withIndex("by_invite", (q) => q.eq("inviteCode", CREW_INVITE)).first();
    if (!g) return null;
    const { bets, members } = await groupState(ctx, g._id);
    const snaps = await ctx.db.query("snapshots").withIndex("by_group", (q) => q.eq("groupId", g._id)).order("desc").take(10);
    return {
      group: { _id: g._id, name: g.name, revealAt: g.revealAt ?? REVEAL_AT },
      bets: bets.length,
      settled: bets.filter((b) => b.status !== "open").length,
      members: members.length,
      snapshots: snaps.map((s) => ({ _id: s._id, label: s.label, t: s._creationTime })),
    };
  },
});

export const demoReplay = mutation({
  args: { passcode: v.string(), inSeconds: v.number() },
  handler: async (ctx, { passcode, inSeconds }) => {
    requireAdmin(passcode);
    const g = await crewOrThrow(ctx);
    const state = await groupState(ctx, g._id);
    await ctx.db.insert("snapshots", {
      groupId: g._id,
      label: "Before replay · " + state.bets.filter((b) => b.status !== "open").length + " of " + state.bets.length + " called",
      data: JSON.stringify({
        revealAt: g.revealAt ?? REVEAL_AT,
        bets: state.bets.map((b) => ({ _id: b._id, status: b.status, winningOption: b.winningOption ?? null, settledAt: b.settledAt ?? null })),
        stakes: state.stakes.map((s) => ({ _id: s._id, payout: s.payout ?? null })),
        members: state.members.map((m) => ({ _id: m._id, points: m.points ?? START_POINTS })),
      }),
    });
    const owed = new Map<string, number>();
    for (const s of state.stakes) {
      if (s.payout === undefined) continue;
      owed.set(s.userId, (owed.get(s.userId) ?? 0) + s.payout);
      await ctx.db.patch(s._id, { payout: undefined });
    }
    for (const m of state.members) {
      const back = owed.get(m.userId) ?? 0;
      if (back) await ctx.db.patch(m._id, { points: (m.points ?? START_POINTS) - back });
    }
    for (const b of state.bets) if (b.status !== "open") await ctx.db.patch(b._id, { status: "open", winningOption: undefined, settledAt: undefined });
    await ctx.db.patch(g._id, { revealAt: Date.now() + Math.max(0, inSeconds) * 1000 });
  },
});

export const demoRestore = mutation({
  args: { passcode: v.string(), snapshotId: v.id("snapshots") },
  handler: async (ctx, { passcode, snapshotId }) => {
    requireAdmin(passcode);
    const snap = await ctx.db.get(snapshotId);
    if (!snap) throw new ConvexError("Snapshot not found");
    const d = JSON.parse(snap.data) as {
      revealAt: number;
      bets: { _id: Id<"bets">; status: Doc<"bets">["status"]; winningOption: number | null; settledAt: number | null }[];
      stakes: { _id: Id<"stakes">; payout: number | null }[];
      members: { _id: Id<"members">; points: number }[];
    };
    for (const b of d.bets) if (await ctx.db.get(b._id)) await ctx.db.patch(b._id, { status: b.status, winningOption: b.winningOption ?? undefined, settledAt: b.settledAt ?? undefined });
    for (const s of d.stakes) if (await ctx.db.get(s._id)) await ctx.db.patch(s._id, { payout: s.payout ?? undefined });
    for (const m of d.members) if (await ctx.db.get(m._id)) await ctx.db.patch(m._id, { points: m.points });
    await ctx.db.patch(snap.groupId, { revealAt: d.revealAt });
  },
});

export const demoRevealAt = mutation({
  args: { passcode: v.string(), at: v.number(), groupId: v.optional(v.id("groups")) },
  handler: async (ctx, { passcode, at, groupId }) => {
    requireAdmin(passcode);
    const g = groupId ? await ctx.db.get(groupId) : await crewOrThrow(ctx);
    if (!g) throw new ConvexError("Group not found");
    await ctx.db.patch(g._id, { revealAt: at });
  },
});
