import { mutation, query } from "./v0Legacy";
import { v, ConvexError } from "convex/values";
import { START_POINTS, userByToken, requireUser, normalizeUsername, ensureDefaultGroup, isTestName } from "./lib";

export const join = mutation({
  args: { name: v.string(), emoji: v.string(), token: v.string() },
  handler: async (ctx, { name, emoji, token }) => {
    const username = normalizeUsername(name);
    if (username.length < 2) throw new ConvexError("Usernames need 2+ letters or numbers");
    if (!isSingleEmoji(emoji)) throw new ConvexError("Pick one emoji");
    const existing = await userByToken(ctx, token);
    const clash = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .first();
    if (clash && clash._id !== existing?._id) throw new ConvexError("@" + username + " is taken");
    if (existing) {
      await ctx.db.patch(existing._id, { name: username, username, emoji, lastSeen: Date.now() });
      return existing._id;
    }
    const userId = await ctx.db.insert("users", {
      name: username,
      username,
      emoji,
      token,
      points: START_POINTS,
      streak: 0,
      lastSeen: Date.now(),
      isTest: isTestName(username) || undefined,
    });
    await ctx.db.insert("members", { groupId: await ensureDefaultGroup(ctx), userId });
    return userId;
  },
});

export const me = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await userByToken(ctx, token);
    if (!user) return null;
    const { token: _t, ...rest } = user;
    return rest;
  },
});

export const setProfile = mutation({
  args: { token: v.string(), username: v.string(), emoji: v.string() },
  handler: async (ctx, { token, username: raw, emoji }) => {
    const user = await requireUser(ctx, token);
    const username = normalizeUsername(raw);
    if (username.length < 2) throw new ConvexError("Usernames need 2+ letters or numbers");
    if (!isSingleEmoji(emoji)) throw new ConvexError("Pick one emoji");
    const clash = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .first();
    if (clash && clash._id !== user._id) throw new ConvexError("@" + username + " is taken");
    await ctx.db.patch(user._id, { name: username, username, emoji });
  },
});

export const ping = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);
    await ctx.db.patch(user._id, { lastSeen: Date.now() });
  },
});

export function isSingleEmoji(s: string) {
  const t = s.trim();
  if (!t) return false;
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  if ([...seg.segment(t)].length !== 1) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(t);
}
