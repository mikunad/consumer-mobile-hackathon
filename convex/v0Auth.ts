import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { GroupSummary, Session } from "./v0Contract";
import { checkVerification, requireOtpProvider, startVerification } from "./v0AuthProvider";
import { activeMember, fail, hash, normalizePhone, once, phoneHash, policyStatus, randomToken, rateLimit, requireSession } from "./v0Policy";

const minute = 60_000;
const hour = 60 * minute;
const otpTtl = 10 * minute;
const sessionTtl = 30 * 24 * hour;
const pairTtl = 5 * minute;

function validateRequestId(requestId: string) {
  if (!requestId || requestId.length > 128) fail("INVALID_INPUT", "A request identifier is required.");
}

function validateDeviceId(deviceId: string) {
  if (!deviceId.trim() || deviceId.length > 128) fail("INVALID_INPUT", "A device identifier is required.");
}

async function mintSession(ctx: MutationCtx, account: Doc<"v0Accounts">, deviceId: string): Promise<Session> {
  if (account.deletedAt !== undefined) fail("AUTH_REQUIRED", "Sign in to continue.");
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + sessionTtl;
  await ctx.db.insert("v0Sessions", { accountId: account._id, tokenHash: await hash(token), deviceId, createdAt: now, expiresAt });
  return { token, expiresAt, account: { id: account._id, displayName: account.displayName } };
}

const reserveStartRef = makeFunctionReference<"mutation", { phoneHash: string; requestId: string }, { attemptId: Id<"v0OtpAttempts">; expiresAt: number; send: boolean }>("v0Auth:reserveOtpStart");
const recordStartRef = makeFunctionReference<"mutation", { attemptId: Id<"v0OtpAttempts">; providerId: string }, null>("v0Auth:recordOtpStart");
const reserveCheckRef = makeFunctionReference<"mutation", { phoneHash: string; requestId: string }, { attemptId: Id<"v0OtpAttempts">; providerId: string }>("v0Auth:reserveOtpCheck");
const consumeApprovalRef = makeFunctionReference<"mutation", { attemptId: Id<"v0OtpAttempts">; phone: string; providerId: string; deviceId: string }, Session>("v0Auth:consumeOtpApproval");
const reservePairRef = makeFunctionReference<"mutation", { codeHash: string; deviceHash: string }, null>("v0Auth:reservePairRedemption");
const consumePairRef = makeFunctionReference<"mutation", { codeHash: string; deviceId: string; requestId: string }, Session>("v0Auth:consumePair");

export const requestCode = action({
  args: { phone: v.string(), requestId: v.string() },
  handler: async (ctx, args): Promise<{ requestId: string; expiresAt: number }> => {
    const phone = normalizePhone(args.phone);
    validateRequestId(args.requestId);
    requireOtpProvider();
    const reservation = await ctx.runMutation(reserveStartRef, { phoneHash: await phoneHash(phone), requestId: args.requestId });
    if (reservation.send) {
      const providerId = await startVerification(phone);
      await ctx.runMutation(recordStartRef, { attemptId: reservation.attemptId, providerId });
    }
    return { requestId: args.requestId, expiresAt: reservation.expiresAt };
  },
});

export const verifyCode = action({
  args: { phone: v.string(), code: v.string(), requestId: v.string(), deviceId: v.string() },
  handler: async (ctx, args): Promise<Session> => {
    const phone = normalizePhone(args.phone);
    validateRequestId(args.requestId);
    validateDeviceId(args.deviceId);
    if (!/^\d{4,10}$/.test(args.code)) fail("INVALID_INPUT", "Enter the code from your message.");
    requireOtpProvider();
    const reservation = await ctx.runMutation(reserveCheckRef, { phoneHash: await phoneHash(phone), requestId: args.requestId });
    await checkVerification(phone, args.code, reservation.providerId);
    return await ctx.runMutation(consumeApprovalRef, { attemptId: reservation.attemptId, phone, providerId: reservation.providerId, deviceId: args.deviceId });
  },
});

export const reserveOtpStart = internalMutation({
  args: { phoneHash: v.string(), requestId: v.string() },
  handler: async (ctx, args) => {
    validateRequestId(args.requestId);
    const existing = await ctx.db.query("v0OtpAttempts").withIndex("by_request", (q) => q.eq("requestId", args.requestId)).unique();
    if (existing) {
      if (existing.phoneHash !== args.phoneHash) fail("IDEMPOTENCY_CONFLICT", "This request identifier was already used.");
      if (existing.consumedAt !== undefined || existing.expiresAt <= Date.now() || !existing.providerId) fail("CONFLICT", "Request a new code.");
      return { attemptId: existing._id, expiresAt: existing.expiresAt, send: false };
    }
    await rateLimit(ctx, "otp:start:global", 1000, hour);
    await rateLimit(ctx, `otp:start:phone:${args.phoneHash}`, 5, hour);
    await rateLimit(ctx, `otp:start:cooldown:${args.phoneHash}`, 1, 30_000);
    const now = Date.now();
    const expiresAt = now + otpTtl;
    const attemptId = await ctx.db.insert("v0OtpAttempts", { ...args, createdAt: now, expiresAt, attempts: 0 });
    return { attemptId, expiresAt, send: true };
  },
});

export const recordOtpStart = internalMutation({
  args: { attemptId: v.id("v0OtpAttempts"), providerId: v.string() },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get(args.attemptId);
    if (!attempt || attempt.expiresAt <= Date.now() || attempt.consumedAt !== undefined || attempt.providerId !== undefined) fail("CONFLICT", "Request a new code.");
    if (!/^VE[0-9a-fA-F]{32}$/.test(args.providerId)) fail("PROVIDER_UNAVAILABLE");
    await ctx.db.patch(attempt._id, { providerId: args.providerId });
    return null;
  },
});

export const reserveOtpCheck = internalMutation({
  args: { phoneHash: v.string(), requestId: v.string() },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.query("v0OtpAttempts").withIndex("by_request", (q) => q.eq("requestId", args.requestId)).unique();
    if (!attempt || attempt.phoneHash !== args.phoneHash || attempt.expiresAt <= Date.now() || !attempt.providerId) fail("INVALID_INPUT", "That code is invalid or expired.");
    if (attempt.consumedAt !== undefined) fail("CONFLICT", "Request a new code.");
    if (attempt.attempts >= 5) fail("RATE_LIMITED", "Request a new code.");
    await rateLimit(ctx, "otp:check:global", 5000, hour);
    await rateLimit(ctx, `otp:check:phone:${args.phoneHash}`, 10, hour);
    await ctx.db.patch(attempt._id, { attempts: attempt.attempts + 1 });
    return { attemptId: attempt._id, providerId: attempt.providerId };
  },
});

export const consumeOtpApproval = internalMutation({
  args: { attemptId: v.id("v0OtpAttempts"), phone: v.string(), providerId: v.string(), deviceId: v.string() },
  handler: async (ctx, args): Promise<Session> => {
    requireOtpProvider();
    validateDeviceId(args.deviceId);
    const phone = normalizePhone(args.phone);
    const digest = await phoneHash(phone);
    const attempt = await ctx.db.get(args.attemptId);
    if (!attempt || attempt.phoneHash !== digest || attempt.providerId !== args.providerId || attempt.attempts < 1 || attempt.expiresAt <= Date.now()) fail("INVALID_INPUT", "That code is invalid or expired.");
    if (attempt.consumedAt !== undefined) fail("CONFLICT", "Request a new code.");
    const now = Date.now();
    const linkedPhone = await ctx.db.query("v0Phones").withIndex("by_hash", (q) => q.eq("phoneHash", digest)).unique();
    let account: Doc<"v0Accounts"> | null;
    if (linkedPhone) {
      account = await ctx.db.get(linkedPhone.accountId);
      if (!account || account.deletedAt !== undefined) fail("AUTH_REQUIRED", "Sign in to continue.");
      await ctx.db.patch(linkedPhone._id, { verifiedAt: now });
    } else {
      const accountId = await ctx.db.insert("v0Accounts", { displayName: "Friend", createdAt: now, noBets: false, blockedTopics: [] });
      await ctx.db.insert("v0Phones", { accountId, phoneHash: digest, lastFour: phone.slice(-4), verifiedAt: now });
      account = await ctx.db.get(accountId);
    }
    if (!account) fail("AUTH_REQUIRED");
    const related = await ctx.db.query("v0OtpAttempts").withIndex("by_phone", (q) => q.eq("phoneHash", digest)).collect();
    for (const row of related) {
      if (row.providerId === args.providerId && row.consumedAt === undefined) await ctx.db.patch(row._id, { consumedAt: now });
    }
    return await mintSession(ctx, account, args.deviceId);
  },
});

export const me = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { account, session } = await requireSession(ctx, token);
    const memberships = await ctx.db.query("v0Memberships").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
    const groups: GroupSummary[] = [];
    const seen = new Set<Id<"v0Groups">>();
    for (const membership of memberships) {
      if (seen.has(membership.groupId) || (await activeMember(ctx, membership.groupId, account._id))?._id !== membership._id) continue;
      const group = await ctx.db.get(membership.groupId);
      if (!group) continue;
      groups.push({ id: group._id, name: group.name, timezone: group.timezone, alias: membership.alias, points: membership.points, streak: membership.streak });
      seen.add(group._id);
    }
    return { account: { id: account._id, displayName: account.displayName }, expiresAt: session.expiresAt, groups, policy: policyStatus };
  },
});

export const revoke = mutation({
  args: { token: v.string(), allDevices: v.boolean(), requestId: v.string() },
  handler: async (ctx, args) => {
    const { account, session } = await requireSession(ctx, args.token);
    return await once(ctx, account._id, "auth:revoke", args.requestId, { allDevices: args.allDevices, sessionId: session._id }, async () => {
      const now = Date.now();
      const accountSessions = await ctx.db.query("v0Sessions").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
      const sessions = args.allDevices ? accountSessions : [session];
      for (const row of sessions) {
        if (row.revokedAt === undefined) await ctx.db.patch(row._id, { revokedAt: now });
      }
      const pairs = await ctx.db.query("v0Pairs").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
      for (const pair of pairs) {
        if (pair.consumedAt === undefined && (args.allDevices || pair.sessionId === session._id)) await ctx.db.patch(pair._id, { consumedAt: now });
      }
      const links = await ctx.db.query("v0ConversationLinks").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
      for (const link of links) {
        if (args.allDevices || link.deviceId === session.deviceId) await ctx.db.delete(link._id);
      }
      const pushTokens = await ctx.db.query("v0PushTokens").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
      for (const pushToken of pushTokens) {
        if (args.allDevices || pushToken.deviceId === session.deviceId) await ctx.db.delete(pushToken._id);
      }
      const hasOtherSession = accountSessions.some((row) => row._id !== session._id && row.revokedAt === undefined && row.expiresAt > now);
      if (args.allDevices || !hasOtherSession) {
        const outbox = await ctx.db.query("v0Outbox").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
        for (const item of outbox) {
          if (item.state !== "sent") await ctx.db.delete(item._id);
        }
      }
      return { revoked: true as const };
    });
  },
});

export const createPair = mutation({
  args: { token: v.string(), requestId: v.string() },
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    const { account, session } = await requireSession(ctx, args.token);
    let result: { code: string; expiresAt: number } | undefined;
    await once(ctx, account._id, "auth:createPair", args.requestId, { sessionId: session._id }, async () => {
      await rateLimit(ctx, `pair:start:${account._id}`, 10, hour);
      const code = randomToken();
      const codeHash = await hash(code);
      if (await ctx.db.query("v0Pairs").withIndex("by_hash", (q) => q.eq("codeHash", codeHash)).unique()) fail("CONFLICT");
      const expiresAt = Math.min(Date.now() + pairTtl, session.expiresAt);
      await ctx.db.insert("v0Pairs", { accountId: account._id, sessionId: session._id, codeHash, expiresAt });
      result = { code, expiresAt };
      return { created: true };
    });
    if (!result) fail("CONFLICT", "Make a new pairing code.");
    return result;
  },
});

export const redeemPair = action({
  args: { code: v.string(), deviceId: v.string(), requestId: v.string() },
  handler: async (ctx, args): Promise<Session> => {
    validateRequestId(args.requestId);
    validateDeviceId(args.deviceId);
    if (!/^[0-9a-f]{64}$/.test(args.code)) fail("INVALID_INPUT", "That pairing code is invalid or expired.");
    const codeHash = await hash(args.code);
    await ctx.runMutation(reservePairRef, { codeHash, deviceHash: await hash(args.deviceId) });
    return await ctx.runMutation(consumePairRef, { codeHash, deviceId: args.deviceId, requestId: args.requestId });
  },
});

export const reservePairRedemption = internalMutation({
  args: { codeHash: v.string(), deviceHash: v.string() },
  handler: async (ctx, args) => {
    await rateLimit(ctx, "pair:redeem:global", 1000, hour);
    await rateLimit(ctx, `pair:redeem:device:${args.deviceHash}`, 20, hour);
    await rateLimit(ctx, `pair:redeem:code:${args.codeHash}`, 10, hour);
    return null;
  },
});

export const consumePair = internalMutation({
  args: { codeHash: v.string(), deviceId: v.string(), requestId: v.string() },
  handler: async (ctx, args): Promise<Session> => {
    validateRequestId(args.requestId);
    validateDeviceId(args.deviceId);
    const pair = await ctx.db.query("v0Pairs").withIndex("by_hash", (q) => q.eq("codeHash", args.codeHash)).unique();
    if (!pair || pair.expiresAt <= Date.now()) fail("INVALID_INPUT", "That pairing code is invalid or expired.");
    if (pair.consumedAt !== undefined) fail("CONFLICT", "Make a new pairing code.");
    const source = await ctx.db.get(pair.sessionId);
    const account = await ctx.db.get(pair.accountId);
    if (!source || source.accountId !== pair.accountId || source.revokedAt !== undefined || source.expiresAt <= Date.now() || !account || account.deletedAt !== undefined) fail("AUTH_REQUIRED", "Sign in to continue.");
    let result: Session | undefined;
    await once(ctx, account._id, "auth:redeemPair", args.requestId, { codeHash: args.codeHash, deviceId: args.deviceId }, async () => {
      await ctx.db.patch(pair._id, { consumedAt: Date.now() });
      result = await mintSession(ctx, account, args.deviceId);
      return { redeemed: true };
    });
    if (!result) fail("CONFLICT", "Make a new pairing code.");
    return result;
  },
});
