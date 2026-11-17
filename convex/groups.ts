import { mutation, query } from "./v0Legacy";
import { v, ConvexError } from "convex/values";
import { HOUR, defaultGroupId, isMember, normalizeUsername, requireUser, userByToken } from "./lib";
import { ensureRound, insertBet, settleBet } from "./admin";

export const mine = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await userByToken(ctx, token);
    if (!user) return [];
    const defaultId = await defaultGroupId(ctx);
    const memberships = await ctx.db
      .query("members")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const groups = await Promise.all(
      memberships.map(async (m) => {
        const g = await ctx.db.get(m.groupId);
        if (!g) return null;
        const count = (await ctx.db.query("members").withIndex("by_group", (q) => q.eq("groupId", g._id)).collect()).length;
        return { _id: g._id, name: g.name, isDefault: g._id === defaultId, members: count };
      }),
    );
    return groups.filter((g) => g !== null).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  },
});

export const get = query({
  args: { token: v.optional(v.string()), groupId: v.id("groups") },
  handler: async (ctx, { token, groupId }) => {
    const group = await ctx.db.get(groupId);
    if (!group) return null;
    const user = await userByToken(ctx, token);
    const memberRows = await ctx.db.query("members").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect();
    const members = (await Promise.all(memberRows.map((m) => ctx.db.get(m.userId))))
      .filter((u) => u !== null)
      .map((u) => ({ _id: u._id, name: u.name, emoji: u.emoji, points: u.points }));
    return {
      _id: group._id,
      name: group.name,
      isOwner: !!user && group.createdBy === user._id,
      isDefault: group._id === (await defaultGroupId(ctx)),
      isMember: !!user && memberRows.some((m) => m.userId === user._id),
      members,
    };
  },
});

export const create = mutation({
  args: { token: v.string(), name: v.string() },
  handler: async (ctx, { token, name }) => {
    const user = await requireUser(ctx, token);
    const clean = name.trim().slice(0, 32);
    if (clean.length < 2) throw new ConvexError("Give your group a name");
    const groupId = await ctx.db.insert("groups", { name: clean, createdBy: user._id });
    await ctx.db.insert("members", { groupId, userId: user._id });
    return groupId;
  },
});

export const searchUsers = query({
  args: { token: v.optional(v.string()), q: v.string() },
  handler: async (ctx, { q }) => {
    const prefix = normalizeUsername(q);
    if (!prefix) return [];
    const users = await ctx.db
      .query("users")
      .withIndex("by_username", (x) => x.gte("username", prefix).lt("username", prefix + "\uffff"))
      .take(8);
    return users.map((u) => ({ _id: u._id, name: u.name, emoji: u.emoji }));
  },
});

export const addMember = mutation({
  args: { token: v.string(), groupId: v.id("groups"), userId: v.id("users") },
  handler: async (ctx, { token, groupId, userId }) => {
    const user = await requireUser(ctx, token);
    if (!(await isMember(ctx, groupId, user._id))) throw new ConvexError("Only members can add people");
    if (await isMember(ctx, groupId, userId)) return;
    await ctx.db.insert("members", { groupId, userId });
  },
});

export const addBet = mutation({
  args: {
    token: v.string(),
    groupId: v.id("groups"),
    question: v.string(),
    kind: v.union(v.literal("yesno"), v.literal("overunder"), v.literal("multi")),
    line: v.optional(v.number()),
    options: v.optional(v.array(v.string())),
    subjectUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, a) => {
    const user = await requireUser(ctx, a.token);
    if (a.groupId === (await defaultGroupId(ctx))) throw new ConvexError("Hackathon bets come from the hosts");
    if (!(await isMember(ctx, a.groupId, user._id))) throw new ConvexError("Join this group first");
    if (!a.question.trim()) throw new ConvexError("Write a question");
    if (a.subjectUserId && !(await isMember(ctx, a.groupId, a.subjectUserId)))
      throw new ConvexError("That person isn't in this group");
    if (a.subjectUserId === user._id) throw new ConvexError("Pick someone other than you");
    const opensAt = Math.floor(Date.now() / HOUR) * HOUR;
    const roundId = await ensureRound(ctx, opensAt, a.groupId);
    return await insertBet(ctx, roundId, a.question, a.kind, a.line, a.options, a.subjectUserId);
  },
});

export const settle = mutation({
  args: { token: v.string(), betId: v.id("bets"), winningOption: v.union(v.number(), v.null()) },
  handler: async (ctx, { token, betId, winningOption }) => {
    const user = await requireUser(ctx, token);
    const bet = await ctx.db.get(betId);
    if (!bet) throw new ConvexError("Bet not found");
    const round = await ctx.db.get(bet.roundId);
    const group = round?.groupId ? await ctx.db.get(round.groupId) : null;
    if (!group || group.isDefault || group.createdBy !== user._id) throw new ConvexError("Only the group's creator can call results");
    return await settleBet(ctx, betId, winningOption);
  },
});
