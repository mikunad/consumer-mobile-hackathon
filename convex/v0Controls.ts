import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { blockInteractions, cancelSubjectBets, deleteAccountData, leaveGroup } from "./v0Cleanup";
import { activeMember, fail, once, rateLimit, requireBet, requireMember, requireSession } from "./v0Policy";

const copyDeletionCaveat = "Called It cannot erase cards or copies already received in other people's Messages. Provider deletion may require additional processing.";

function settings(account: Doc<"v0Accounts">) {
  return { noBets: account.noBets, blockedTopics: account.blockedTopics, hostedAiConsent: account.hostedAiConsentAt !== undefined, copyDeletionCaveat };
}

export const get = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { account } = await requireSession(ctx, token);
    return settings(account);
  },
});

export const update = mutation({
  args: { token: v.string(), noBets: v.boolean(), blockedTopics: v.array(v.string()), hostedAiConsent: v.boolean(), requestId: v.string() },
  handler: async (ctx, { token, noBets, blockedTopics, hostedAiConsent, requestId }) => {
    const { account } = await requireSession(ctx, token);
    if (blockedTopics.length > 20 || blockedTopics.some((topic) => topic.length > 120 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(topic))) fail("INVALID_INPUT", "Use up to 20 short blocked topics.");
    const topics = blockedTopics.map((topic) => topic.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " "));
    if (topics.some((topic) => !topic || topic.length > 60 || !/^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u.test(topic))) fail("INVALID_INPUT", "Use short words or phrases for blocked topics.");
    return await once(ctx, account._id, "controls.update", requestId, { noBets, blockedTopics, hostedAiConsent }, async () => {
      await rateLimit(ctx, `controls.update:${account._id}`, 60, 60_000);
      await ctx.db.patch(account._id, { noBets, blockedTopics: [...new Set(topics)], hostedAiConsentAt: hostedAiConsent ? account.hostedAiConsentAt ?? Date.now() : undefined });
      if (noBets) await cancelSubjectBets(ctx, account._id);
      return settings((await ctx.db.get(account._id))!);
    });
  },
});

export const alias = mutation({
  args: { token: v.string(), groupId: v.id("v0Groups"), alias: v.string(), requestId: v.string() },
  handler: async (ctx, { token, groupId, alias: value, requestId }) => {
    const { account } = await requireSession(ctx, token);
    const member = await requireMember(ctx, groupId, account._id);
    const cleanAlias = value.trim();
    if (!cleanAlias || value.length > 96 || cleanAlias.length > 48 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) fail("INVALID_INPUT", "Use a name of up to 48 characters.");
    return await once(ctx, account._id, "controls.alias", requestId, { groupId, alias: value }, async () => {
      await rateLimit(ctx, `controls.alias:${account._id}`, 30, 60_000);
      await ctx.db.patch(member._id, { alias: cleanAlias });
      return { alias: cleanAlias };
    });
  },
});

export const leave = mutation({
  args: { token: v.string(), groupId: v.id("v0Groups"), requestId: v.string() },
  handler: async (ctx, { token, groupId, requestId }) => {
    const { account } = await requireSession(ctx, token);
    return await once(ctx, account._id, "controls.leave", requestId, { groupId }, async () => {
      await leaveGroup(ctx, account._id, groupId);
      return { left: true as const };
    });
  },
});

export const block = mutation({
  args: { token: v.string(), accountId: v.id("v0Accounts"), requestId: v.string() },
  handler: async (ctx, { token, accountId: blockedId, requestId }) => {
    const { account } = await requireSession(ctx, token);
    if (account._id === blockedId) fail("INVALID_INPUT", "Choose another member.");
    const target = await ctx.db.get(blockedId);
    if (!target || target.deletedAt !== undefined) fail("NOT_AVAILABLE");
    const mine = await ctx.db.query("v0Memberships").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
    let eligible = false;
    for (const groupId of new Set(mine.map((member) => member.groupId))) {
      if (!(await ctx.db.get(groupId))) continue;
      const [callerMember, targetMember] = await Promise.all([
        activeMember(ctx, groupId, account._id),
        activeMember(ctx, groupId, blockedId),
      ]);
      if (callerMember && targetMember) {
        eligible = true;
        break;
      }
    }
    if (!eligible) fail("NOT_AVAILABLE");
    return await once(ctx, account._id, "controls.block", requestId, { accountId: blockedId }, async () => {
      await rateLimit(ctx, `controls.block:${account._id}`, 30, 3_600_000);
      const existing = await ctx.db.query("v0Blocks").withIndex("by_pair", (q) => q.eq("accountId", account._id).eq("blockedId", blockedId)).unique();
      if (!existing) await ctx.db.insert("v0Blocks", { accountId: account._id, blockedId, createdAt: Date.now() });
      await blockInteractions(ctx, account._id, blockedId);
      return { blocked: true as const };
    });
  },
});

export const report = mutation({
  args: { token: v.string(), groupId: v.id("v0Groups"), betId: v.optional(v.id("v0Bets")), reason: v.string(), requestId: v.string() },
  handler: async (ctx, { token, groupId, betId, reason, requestId }) => {
    const { account } = await requireSession(ctx, token);
    await requireMember(ctx, groupId, account._id);
    if (betId && (await requireBet(ctx, betId, account._id)).groupId !== groupId) fail("NOT_AVAILABLE");
    const cleanReason = reason.trim();
    if (!cleanReason || reason.length > 2000 || cleanReason.length > 1000 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(reason)) fail("INVALID_INPUT", "Enter a short reason for the report.");
    return await once(ctx, account._id, "controls.report", requestId, { groupId, betId, reason }, async () => {
      await rateLimit(ctx, `controls.report:${account._id}`, 20, 3_600_000);
      await ctx.db.insert("v0Reports", { reporterId: account._id, groupId, ...(betId ? { betId } : {}), reason: cleanReason, createdAt: Date.now(), status: "open" });
      return { received: true as const };
    });
  },
});

export const deleteAccount = mutation({
  args: { token: v.string(), requestId: v.string() },
  handler: async (ctx, { token, requestId }) => {
    const { account } = await requireSession(ctx, token);
    if (!requestId || requestId.length > 128) fail("INVALID_INPUT", "A request identifier is required.");
    await deleteAccountData(ctx, account._id);
    return { deleted: true as const, providerCleanup: "pending" as const, copyDeletionCaveat };
  },
});
