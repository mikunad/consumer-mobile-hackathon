import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { BetView, CardLocator } from "./v0Contract";
import { activeMember, canReadBet, fail, isBlocked, once, policyStatus, rateLimit, requireBet, requireMember, requireSession } from "./v0Policy";
import { format } from "./v0Schema";
import { validateCandidate } from "./v0Safety";
import { queueNotification } from "./v0Notifications";
import { answerDeadlineFor, approvedPolicy, challengeDeadlineFor, nextDefaultRevealAt, stateAt } from "./v0GamePolicy";

async function cardFor(ctx: QueryCtx, bet: Doc<"v0Bets">): Promise<CardLocator> {
  let origin: URL;
  try {
    origin = new URL(process.env.V0_CARD_ORIGIN ?? "");
  } catch {
    return fail("PROVIDER_UNAVAILABLE", "Card links are not configured.");
  }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) fail("PROVIDER_UNAVAILABLE", "Card links are not configured.");
  const subject = await activeMember(ctx, bet.groupId, bet.subjectId);
  const subjectAlias = subject?.alias ?? "a friend";
  const picks = (await ctx.db.query("v0Picks").withIndex("by_bet", (q) => q.eq("betId", bet._id)).collect()).filter((pick) => pick.voidedAt === undefined);
  const bettorInitials: string[] = [];
  for (const pick of picks) {
    const member = await activeMember(ctx, bet.groupId, pick.accountId);
    if (member?._id === pick.membershipId) bettorInitials.push(Array.from(member.alias.trim())[0]?.toUpperCase() ?? "?");
  }
  return {
    url: `${origin.origin}/c/${bet.locator}`,
    caption: `Secret bet on ${subjectAlias}`,
    accessibilityLabel: `Called It card. Secret bet on ${subjectAlias}`,
    subjectAlias,
    bettorCount: bettorInitials.length,
    bettorInitials,
  };
}

async function viewFor(ctx: QueryCtx, bet: Doc<"v0Bets">, accountId: Id<"v0Accounts">): Promise<BetView> {
  const now = Date.now();
  const state = stateAt(bet, now);
  const answerDeadline = answerDeadlineFor(bet);
  const challengeDeadline = challengeDeadlineFor(bet);
  const challenge = state === "provisional" && accountId !== bet.subjectId ? await ctx.db.query("v0Challenges").withIndex("by_bet_account", (q) => q.eq("betId", bet._id).eq("accountId", accountId)).unique() : null;
  const base = { serverTime: now, groupId: bet.groupId, betId: bet._id, state, cutoffAt: bet.revealAt, revealAt: bet.revealAt, card: await cardFor(ctx, bet) };
  if (state === "voided") return { ...base, view: "unavailable" };
  if (accountId === bet.subjectId && now < bet.revealAt) return { ...base, view: "sealed", canVeto: true };
  const allPicks = await ctx.db.query("v0Picks").withIndex("by_bet", (q) => q.eq("betId", bet._id)).collect();
  const myPicks = allPicks.filter((pick) => pick.accountId === accountId);
  const member = await activeMember(ctx, bet.groupId, accountId);
  const mine = myPicks.length === 1 && myPicks[0].voidedAt === undefined && myPicks[0].membershipId === member?._id ? myPicks[0] : undefined;
  const picks: Extract<BetView, { view: "bet" }>["picks"] = [];
  if (now >= bet.revealAt) {
    for (const pick of allPicks) {
      const member = await activeMember(ctx, bet.groupId, pick.accountId);
      if (pick.voidedAt !== undefined || member?._id !== pick.membershipId || await isBlocked(ctx, accountId, pick.accountId)) continue;
      picks.push({ accountId: pick.accountId, alias: member.alias, option: pick.option, confidence: pick.confidence });
    }
  }
  return {
    ...base,
    view: "bet",
    question: bet.question,
    format: bet.format,
    options: bet.options,
    ...(bet.line === undefined ? {} : { line: bet.line }),
    canPick: accountId !== bet.subjectId && state === "open" && now < bet.revealAt && myPicks.length === 0,
    canAnswer: accountId === bet.subjectId && state === "revealed" && now < answerDeadline,
    canChallenge: accountId !== bet.subjectId && state === "provisional" && challengeDeadline !== undefined && now < challengeDeadline && !challenge,
    myPick: mine ? { option: mine.option, confidence: mine.confidence } : null,
    picks,
    ...(now >= bet.revealAt ? { answerDeadline } : {}),
    ...(now >= bet.revealAt && challengeDeadline !== undefined ? { challengeDeadline } : {}),
    ...(now >= bet.revealAt && bet.provisionalOutcome !== undefined ? { provisionalOutcome: bet.provisionalOutcome } : {}),
    ...(now >= bet.revealAt && state === "finalized" && bet.outcome !== undefined ? { outcome: bet.outcome } : {}),
  };
}

export async function voidBet(ctx: MutationCtx, bet: Doc<"v0Bets">) {
  if (bet.state === "finalized" || bet.state === "voided") return;
  const now = Date.now();
  await ctx.db.patch(bet._id, { state: "voided", provisionalOutcome: undefined, outcome: undefined, answeredAt: undefined, challengeDeadline: undefined });
  for (const pick of await ctx.db.query("v0Picks").withIndex("by_bet", (q) => q.eq("betId", bet._id)).collect()) {
    if (pick.voidedAt === undefined) await ctx.db.patch(pick._id, { voidedAt: now });
  }
  for (const item of await ctx.db.query("v0Outbox").collect()) {
    if (item.betId === bet._id && item.state !== "sent") await ctx.db.delete(item._id);
  }
}

export const get = query({
  args: { token: v.string(), locator: v.string() },
  handler: async (ctx, { token, locator }) => {
    const { account } = await requireSession(ctx, token);
    if (!/^[a-f0-9]{64}$/.test(locator)) fail("NOT_AVAILABLE");
    const bet = await ctx.db.query("v0Bets").withIndex("by_locator", (q) => q.eq("locator", locator)).unique();
    if (!bet || !(await canReadBet(ctx, bet, account._id))) fail("NOT_AVAILABLE");
    return await viewFor(ctx, bet, account._id);
  },
});

export const list = query({
  args: { token: v.string(), groupId: v.id("v0Groups") },
  handler: async (ctx, { token, groupId }) => {
    const { account } = await requireSession(ctx, token);
    await requireMember(ctx, groupId, account._id);
    const bets = await ctx.db.query("v0Bets").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect();
    const views: BetView[] = [];
    for (const bet of bets) if (await canReadBet(ctx, bet, account._id)) views.push(await viewFor(ctx, bet, account._id));
    return views.sort((a, b) => b.revealAt - a.revealAt);
  },
});

export const history = query({
  args: { token: v.string(), groupId: v.id("v0Groups") },
  handler: async (ctx, { token, groupId }) => {
    const { account } = await requireSession(ctx, token);
    await requireMember(ctx, groupId, account._id);
    const bets = await ctx.db.query("v0Bets").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect();
    const views: BetView[] = [];
    for (const bet of bets) if (["finalized", "voided"].includes(stateAt(bet, Date.now())) && await canReadBet(ctx, bet, account._id)) views.push(await viewFor(ctx, bet, account._id));
    return views;
  },
});

export const create = mutation({
  args: { token: v.string(), groupId: v.id("v0Groups"), subjectId: v.id("v0Accounts"), question: v.string(), contextLine: v.string(), format, options: v.array(v.string()), line: v.optional(v.number()), cutoffAt: v.optional(v.number()), revealAt: v.optional(v.number()), source: v.union(v.literal("manual"), v.literal("template"), v.literal("history"), v.literal("hosted_ai")), requestId: v.string() },
  handler: async (ctx, args) => {
    const { account } = await requireSession(ctx, args.token);
    await requireMember(ctx, args.groupId, account._id);
    await requireMember(ctx, args.groupId, args.subjectId);
    const subject = await ctx.db.get(args.subjectId);
    if (args.subjectId === account._id || !subject || subject.deletedAt !== undefined || subject.noBets || await isBlocked(ctx, account._id, args.subjectId)) fail("NOT_AVAILABLE");
    validateCandidate(args, { blockedTopics: [...subject.blockedTopics, ...account.blockedTopics], contextLine: args.contextLine });
    const group = (await ctx.db.get(args.groupId))!;
    let revealAt = args.revealAt;
    if (revealAt === undefined) {
      try {
        revealAt = nextDefaultRevealAt(group.timezone, Date.now()) ?? undefined;
      } catch {
        fail("INVALID_INPUT", "Choose a valid group timezone.");
      }
    }
    if (revealAt === undefined || !Number.isFinite(revealAt) || revealAt <= Date.now() || (args.cutoffAt !== undefined && (!Number.isFinite(args.cutoffAt) || args.cutoffAt !== revealAt))) fail("INVALID_INPUT", "New confirmations must end at the future reveal time.");
    return fail("POLICY_PENDING", "Creator rules are awaiting approval.");
  },
});

export const pick = mutation({
  args: { token: v.string(), betId: v.id("v0Bets"), option: v.number(), confidence: v.number(), riskPoints: v.optional(v.number()), requestId: v.string() },
  handler: async (ctx, args) => {
    const { account } = await requireSession(ctx, args.token);
    const bet = await requireBet(ctx, args.betId, account._id);
    const member = await requireMember(ctx, bet.groupId, account._id);
    if (bet.subjectId === account._id || stateAt(bet, Date.now()) === "voided") fail("NOT_AVAILABLE");
    if (![0, 1].includes(args.option) || !Number.isFinite(args.confidence) || args.confidence < approvedPolicy.confidenceMin || args.confidence > approvedPolicy.confidenceMax || args.riskPoints !== undefined) fail("INVALID_INPUT");
    const picks = await ctx.db.query("v0Picks").withIndex("by_bet_account", (q) => q.eq("betId", args.betId).eq("accountId", account._id)).collect();
    if (picks.length > 1) fail("CONFLICT", "This confirmation is unavailable.");
    const existing = picks[0];
    if (existing && (existing.groupId !== bet.groupId || existing.membershipId !== member._id || existing.voidedAt !== undefined || !Number.isFinite(existing.updatedAt))) fail("NOT_AVAILABLE");
    return await once(ctx, account._id, "bets.pick", args.requestId, { betId: args.betId, option: args.option, confidence: args.confidence }, async () => {
      await rateLimit(ctx, `pick:${account._id}`, 60, 60_000);
      if (existing) {
        if (existing.option !== args.option || existing.confidence !== args.confidence) fail("CONFLICT", "Your confirmed pick cannot be changed.");
        return { saved: true as const, option: existing.option, confidence: existing.confidence, updatedAt: existing.updatedAt };
      }
      const now = Date.now();
      if (stateAt(bet, now) !== "open" || now >= bet.revealAt || now < bet.createdAt) fail("NOT_AVAILABLE");
      await ctx.db.insert("v0Picks", { betId: bet._id, groupId: bet.groupId, accountId: account._id, membershipId: member._id, option: args.option, confidence: args.confidence, placedAt: now, updatedAt: now });
      return { saved: true as const, option: args.option, confidence: args.confidence, updatedAt: now };
    });
  },
});

export const veto = mutation({
  args: { token: v.string(), betId: v.id("v0Bets"), requestId: v.string() },
  handler: async (ctx, { token, betId, requestId }) => {
    const { account } = await requireSession(ctx, token);
    const bet = await requireBet(ctx, betId, account._id);
    if (bet.subjectId !== account._id) fail("NOT_AVAILABLE");
    return await once(ctx, account._id, "veto", requestId, { betId }, async () => {
      if (Date.now() >= bet.revealAt || bet.state === "finalized") fail("NOT_AVAILABLE");
      await rateLimit(ctx, `veto:${account._id}`, 60, 60_000);
      await voidBet(ctx, bet);
      return { voided: true as const };
    });
  },
});

export const answer = mutation({
  args: { token: v.string(), betId: v.id("v0Bets"), option: v.number(), requestId: v.string() },
  handler: async (ctx, { token, betId, option, requestId }) => {
    const { account } = await requireSession(ctx, token);
    const bet = await requireBet(ctx, betId, account._id);
    if (bet.subjectId !== account._id || stateAt(bet, Date.now()) === "voided") fail("NOT_AVAILABLE");
    if (![0, 1].includes(option)) fail("INVALID_INPUT");
    return await once(ctx, account._id, "bets.answer", requestId, { betId, option }, async () => {
      const now = Date.now();
      if (stateAt(bet, now) !== "revealed" || now >= answerDeadlineFor(bet)) fail("NOT_AVAILABLE");
      await rateLimit(ctx, `answer:${account._id}`, 60, 60_000);
      const challengeDeadline = now + approvedPolicy.challengeDurationMs;
      await ctx.db.patch(betId, { state: "provisional", answeredAt: now, answerDeadline: answerDeadlineFor(bet), challengeDeadline, provisionalOutcome: option, policyVersion: approvedPolicy.version });
      return { state: "provisional" as const, challengeDeadline };
    });
  },
});

export const challenge = mutation({
  args: { token: v.string(), betId: v.id("v0Bets"), requestId: v.string() },
  handler: async (ctx, { token, betId, requestId }) => {
    const { account } = await requireSession(ctx, token);
    const bet = await requireBet(ctx, betId, account._id);
    if (bet.subjectId === account._id || stateAt(bet, Date.now()) !== "provisional") fail("NOT_AVAILABLE");
    return await once(ctx, account._id, "bets.challenge", requestId, { betId }, async () => {
      const deadline = challengeDeadlineFor(bet);
      if (deadline === undefined || Date.now() >= deadline) fail("NOT_AVAILABLE");
      const existing = await ctx.db.query("v0Challenges").withIndex("by_bet_account", (q) => q.eq("betId", betId).eq("accountId", account._id)).unique();
      if (!existing) {
        await rateLimit(ctx, `challenge:${account._id}`, 60, 60_000);
        await ctx.db.insert("v0Challenges", { betId, accountId: account._id, createdAt: Date.now() });
      }
      return { recorded: true as const };
    });
  },
});

export const advance = internalMutation({
  args: { betId: v.id("v0Bets") },
  handler: async (ctx, { betId }) => {
    const bet = await ctx.db.get(betId);
    if (!bet) return;
    const state = await advanceBet(ctx, bet);
    return { state, policy: policyStatus };
  },
});

export async function advanceBet(ctx: MutationCtx, bet: Doc<"v0Bets">) {
  if (![bet.createdAt, bet.cutoffAt, bet.revealAt].every(Number.isFinite) || bet.cutoffAt <= bet.createdAt || bet.revealAt < bet.cutoffAt) {
    await voidBet(ctx, bet);
    return "voided" as const;
  }
  const state = stateAt(bet, Date.now());
  if (state === "voided") {
    await voidBet(ctx, bet);
    return state;
  }
  if (state === bet.state) return state;
  await ctx.db.patch(bet._id, { state });
  if (state === "revealed") {
    const recipients = new Set([bet.subjectId]);
    for (const pick of await ctx.db.query("v0Picks").withIndex("by_bet", (q) => q.eq("betId", bet._id)).collect()) {
      if (pick.voidedAt === undefined) recipients.add(pick.accountId);
    }
    for (const accountId of recipients) await queueNotification(ctx, { key: `reveal:${bet._id}:${accountId}`, accountId, groupId: bet.groupId, betId: bet._id, kind: "reveal" });
  }
  return state;
}
