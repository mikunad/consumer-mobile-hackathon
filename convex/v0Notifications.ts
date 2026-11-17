import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { NotificationPreferences, NotificationTap } from "./v0Contract";
import { activeMember, canReadBet, fail, hash, once, rateLimit, requireSession } from "./v0Policy";
import { stateAt } from "./v0GamePolicy";

export type NotificationInput = {
  key: string;
  accountId: Id<"v0Accounts">;
  groupId?: Id<"v0Groups">;
  betId?: Id<"v0Bets">;
  kind: Doc<"v0Outbox">["kind"];
};

export type NotificationLease = { id: Id<"v0Outbox">; attempt: number; leaseUntil: number };
export type PushEnvironment = "sandbox" | "production";
export type ApnsAvailability = { ready: boolean; reason: "ready" | "not_activated" | "invalid_configuration" };
export type ApnsOutcome = { status: "sent" | "invalid_token" | "retry" | "permanent"; code: "accepted" | "unregistered" | "bad_device_token" | "rate_limited" | "provider_error" | "rejected" | "network_error" | "timeout"; invalidatedAt?: number };
export type DeviceAuthorization = { token: string; userInfo: NotificationTap };
type DeviceSnapshot = { tokenId: Id<"v0PushTokens">; updatedAt: number };
type DeviceAttempt = { attempt: number; status: "sending" | ApnsOutcome["status"]; at: number; code?: ApnsOutcome["code"] };
type DeviceReceipt = { attempts: DeviceAttempt[] };
type FinishInput = NotificationLease & { environment: PushEnvironment };
type FinishResult = "sent" | "retry" | "failed" | "stale";
type AdapterResult = { status: "complete"; environment: PushEnvironment } | { status: "unavailable" };

const leaseMs = 120_000;
const maxAttempts = 6;
const maxDevices = 32;
const leaseArgs = { id: v.id("v0Outbox"), attempt: v.number(), leaseUntil: v.number() };
const environment = v.union(v.literal("sandbox"), v.literal("production"));
const deviceArgs = { ...leaseArgs, tokenId: v.id("v0PushTokens"), updatedAt: v.number(), environment };
const claimRef = makeFunctionReference<"mutation", Record<string, never>, NotificationLease[]>("v0Notifications:claimBatch");
const finishRef = makeFunctionReference<"mutation", FinishInput, FinishResult>("v0Notifications:finishAttempt");
const releaseRef = makeFunctionReference<"mutation", NotificationLease, null>("v0Notifications:releaseLease");
const availabilityRef = makeFunctionReference<"action", Record<string, never>, ApnsAvailability>("v0Apns:availability");
const adapterRef = makeFunctionReference<"action", NotificationLease, AdapterResult>("v0Apns:deliverLease");

function validDeviceToken(token: string) {
  return /^[a-fA-F0-9]{32,512}$/.test(token) && token.length % 2 === 0;
}

function currentDeviceSession(session: Doc<"v0Sessions">, now: number) {
  return session.revokedAt === undefined && Number.isFinite(session.createdAt) && Number.isFinite(session.expiresAt)
    && session.createdAt <= now && session.expiresAt > now && session.expiresAt > session.createdAt;
}

async function canNotify(ctx: QueryCtx, input: NotificationInput) {
  const account = await ctx.db.get(input.accountId);
  if (!account || account.deletedAt !== undefined || account.notificationsEnabled === false) return false;
  if (input.groupId && !(await activeMember(ctx, input.groupId, input.accountId))) return false;
  if (input.groupId && !(await ctx.db.get(input.groupId))) return false;
  if (!input.betId) return true;
  const bet = await ctx.db.get(input.betId);
  if (!bet || bet.groupId !== input.groupId || stateAt(bet, Date.now()) === "voided" || !(await canReadBet(ctx, bet, input.accountId))) return false;
  const [subject, creator, subjectCanRead, creatorCanRead] = await Promise.all([
    ctx.db.get(bet.subjectId),
    ctx.db.get(bet.creatorId),
    canReadBet(ctx, bet, bet.subjectId),
    canReadBet(ctx, bet, bet.creatorId),
  ]);
  return !!subject && subject.deletedAt === undefined && !subject.noBets
    && !!creator && creator.deletedAt === undefined
    && subjectCanRead && creatorCanRead;
}

export async function queueNotification(ctx: MutationCtx, input: NotificationInput): Promise<Id<"v0Outbox"> | null> {
  if (!/^[a-zA-Z0-9:_-]{1,200}$/.test(input.key) || !["turn", "reveal", "result", "recap"].includes(input.kind)) fail("INVALID_INPUT", "This notification cannot be queued.");
  if (input.betId && !input.groupId) fail("INVALID_INPUT", "This notification cannot be queued.");
  if (!(await canNotify(ctx, input))) return null;
  const existing = await ctx.db.query("v0Outbox").withIndex("by_key", (q) => q.eq("key", input.key)).unique();
  if (existing) {
    if (existing.accountId !== input.accountId || existing.groupId !== input.groupId || existing.betId !== input.betId || existing.kind !== input.kind) fail("IDEMPOTENCY_CONFLICT", "This notification identifier was already used.");
    return existing._id;
  }
  return await ctx.db.insert("v0Outbox", {
    key: input.key,
    accountId: input.accountId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.betId ? { betId: input.betId } : {}),
    kind: input.kind,
    state: "pending",
    attempts: 0,
    availableAt: Date.now(),
  });
}

export const register = mutation({
  args: { token: v.string(), deviceToken: v.string(), environment: v.union(v.literal("sandbox"), v.literal("production")), requestId: v.string() },
  handler: async (ctx, args) => {
    const { account, session } = await requireSession(ctx, args.token);
    if (account.notificationsEnabled === false) fail("FORBIDDEN", "Enable notifications in settings before registering this device.");
    if (!validDeviceToken(args.deviceToken)) fail("INVALID_INPUT", "This device cannot receive notifications yet.");
    const deviceToken = args.deviceToken.toLowerCase();
    return await once(ctx, account._id, "notifications.register", args.requestId, { deviceId: session.deviceId, deviceToken, environment: args.environment }, async () => {
      await rateLimit(ctx, `push:${account._id}`, 20, 60_000);
      const existing = await ctx.db.query("v0PushTokens").withIndex("by_device", (q) => q.eq("accountId", account._id).eq("deviceId", session.deviceId)).collect();
      const registrations = await ctx.db.query("v0PushTokens").withIndex("by_token", (q) => q.eq("token", deviceToken).eq("environment", args.environment)).collect();
      const matchingIds = new Set(registrations.map((row) => row._id));
      if (!existing.length && (await ctx.db.query("v0PushTokens").withIndex("by_account", (q) => q.eq("accountId", account._id)).take(maxDevices + matchingIds.size)).filter((row) => !matchingIds.has(row._id)).length >= maxDevices) fail("RATE_LIMITED", "Remove an older device before adding another.");
      const updatedAt = Math.max(Date.now(), ...[...existing, ...registrations].map((row) => Number.isFinite(row.updatedAt) ? row.updatedAt + 1 : 0));
      const value = { token: deviceToken, environment: args.environment, updatedAt };
      if (existing[0]) await ctx.db.patch(existing[0]._id, value);
      else await ctx.db.insert("v0PushTokens", { accountId: account._id, deviceId: session.deviceId, ...value });
      const duplicates = new Set([...existing.slice(1), ...registrations].filter((row) => row._id !== existing[0]?._id).map((row) => row._id));
      for (const duplicate of duplicates) await ctx.db.delete(duplicate);
      return { registered: true as const };
    });
  },
});

export const unregister = mutation({
  args: { token: v.string(), requestId: v.string() },
  handler: async (ctx, args) => {
    const { account, session } = await requireSession(ctx, args.token);
    return await once(ctx, account._id, "notifications.unregister", args.requestId, { deviceId: session.deviceId }, async () => {
      await rateLimit(ctx, `push:${account._id}`, 20, 60_000);
      const tokens = await ctx.db.query("v0PushTokens").withIndex("by_device", (q) => q.eq("accountId", account._id).eq("deviceId", session.deviceId)).collect();
      for (const token of tokens) await ctx.db.delete(token._id);
      return { registered: false as const };
    });
  },
});

export const preferences = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<NotificationPreferences> => {
    const { account } = await requireSession(ctx, token);
    return { enabled: account.notificationsEnabled !== false };
  },
});

export const setPreferences = mutation({
  args: { token: v.string(), enabled: v.boolean(), requestId: v.string() },
  handler: async (ctx, { token, enabled, requestId }): Promise<NotificationPreferences> => {
    const { account } = await requireSession(ctx, token);
    return await once(ctx, account._id, "notifications.preferences", requestId, { enabled }, async () => {
      await rateLimit(ctx, `push-preferences:${account._id}`, 30, 60_000);
      await ctx.db.patch(account._id, { notificationsEnabled: enabled });
      if (!enabled) {
        const [tokens, outbox] = await Promise.all([
          ctx.db.query("v0PushTokens").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect(),
          ctx.db.query("v0Outbox").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect(),
        ]);
        for (const device of tokens) await ctx.db.delete(device._id);
        for (const item of outbox) if (item.state !== "sent") await ctx.db.delete(item._id);
      }
      return { enabled };
    });
  },
});

export const claimBatch = internalMutation({
  args: {},
  handler: async (ctx): Promise<NotificationLease[]> => {
    const now = Date.now();
    const [pending, abandoned] = await Promise.all([
      ctx.db.query("v0Outbox").withIndex("by_state_available", (q) => q.eq("state", "pending").lte("availableAt", now)).take(10),
      ctx.db.query("v0Outbox").withIndex("by_state_available", (q) => q.eq("state", "delivering").lte("availableAt", now)).take(10),
    ]);
    const leases: NotificationLease[] = [];
    for (const row of [...abandoned, ...pending]) {
      if (leases.length >= 10) break;
      if (row.state === "delivering" && row.leaseUntil !== undefined && row.leaseUntil > now) continue;
      if (!(await canNotify(ctx, row))) {
        await ctx.db.delete(row._id);
        continue;
      }
      if (row.attempts >= maxAttempts) {
        await ctx.db.patch(row._id, { state: "failed", leaseUntil: undefined });
        continue;
      }
      const [tokens, sessions] = await Promise.all([
        ctx.db.query("v0PushTokens").withIndex("by_account", (q) => q.eq("accountId", row.accountId)).take(maxDevices + 1),
        ctx.db.query("v0Sessions").withIndex("by_account", (q) => q.eq("accountId", row.accountId)).collect(),
      ]);
      const liveDevices = new Set(sessions.filter((session) => currentDeviceSession(session, now)).map((session) => session.deviceId));
      let validTokens = 0;
      for (const token of tokens) {
        if (!validDeviceToken(token.token) || !liveDevices.has(token.deviceId)) await ctx.db.delete(token._id);
        else validTokens++;
      }
      if (!validTokens) {
        await ctx.db.patch(row._id, { state: "failed", leaseUntil: undefined });
        continue;
      }
      const leaseUntil = now + leaseMs;
      const attempt = row.attempts + 1;
      const bet = row.betId ? await ctx.db.get(row.betId) : null;
      if (bet && !/^[a-f0-9]{64}$/.test(bet.locator)) {
        await ctx.db.patch(row._id, { state: "failed", leaseUntil: undefined });
        continue;
      }
      await ctx.db.patch(row._id, { state: "delivering", attempts: attempt, leaseUntil, availableAt: leaseUntil });
      leases.push({ id: row._id, attempt, leaseUntil });
    }
    return leases;
  },
});

function receiptScope(id: Id<"v0Outbox">) {
  return `notifications.delivery:${id}`;
}

function receiptKey(input: DeviceSnapshot) {
  return `${input.tokenId}:${input.updatedAt}`;
}

function readReceipt(value: string): DeviceReceipt {
  const parsed = JSON.parse(value) as DeviceReceipt;
  if (!parsed || !Array.isArray(parsed.attempts) || parsed.attempts.length > maxAttempts) fail("CONFLICT", "Notification delivery needs attention.");
  return parsed;
}

function receiptStatus(receipt: DeviceReceipt) {
  if (receipt.attempts.some((attempt) => attempt.status === "sent")) return "sent";
  return receipt.attempts.at(-1)?.status;
}

function ownsLease(row: Doc<"v0Outbox"> | null, lease: NotificationLease) {
  return !!row && row.state === "delivering" && row.attempts === lease.attempt && row.leaseUntil === lease.leaseUntil && lease.leaseUntil > Date.now();
}

export const deliveryPlan = internalQuery({
  args: { ...leaseArgs, environment },
  handler: async (ctx, args): Promise<DeviceSnapshot[]> => {
    const row = await ctx.db.get(args.id);
    if (!ownsLease(row, args) || !row || !(await canNotify(ctx, row))) return [];
    const tokens = await ctx.db.query("v0PushTokens").withIndex("by_account", (q) => q.eq("accountId", row.accountId)).take(maxDevices);
    return tokens.filter((token) => token.environment === args.environment).map((token) => ({ tokenId: token._id, updatedAt: token.updatedAt }));
  },
});

export const authorizeDevice = internalMutation({
  args: deviceArgs,
  handler: async (ctx, args): Promise<DeviceAuthorization | null> => {
    const row = await ctx.db.get(args.id);
    if (!ownsLease(row, args) || args.leaseUntil - Date.now() < 3000 || !row || !(await canNotify(ctx, row))) return null;
    const token = await ctx.db.get(args.tokenId);
    if (!token || token.accountId !== row.accountId || token.updatedAt !== args.updatedAt || token.environment !== args.environment) return null;
    const sessions = await ctx.db.query("v0Sessions").withIndex("by_account", (q) => q.eq("accountId", row.accountId)).collect();
    if (!validDeviceToken(token.token) || !sessions.some((session) => session.deviceId === token.deviceId && currentDeviceSession(session, Date.now()))) {
      await ctx.db.delete(token._id);
      return null;
    }
    const scope = receiptScope(row._id);
    const key = receiptKey(args);
    const existing = await ctx.db.query("v0Requests").withIndex("by_key", (q) => q.eq("accountId", row.accountId).eq("scope", scope).eq("key", key)).unique();
    const receipt = existing ? readReceipt(existing.result) : { attempts: [] };
    if (["sent", "invalid_token", "permanent"].includes(receiptStatus(receipt) ?? "") || receipt.attempts.some((attempt) => attempt.attempt === args.attempt)) return null;
    const bet = row.betId ? await ctx.db.get(row.betId) : null;
    if (bet && !/^[a-f0-9]{64}$/.test(bet.locator)) return null;
    const userInfo: NotificationTap = { kind: row.kind, ...(row.groupId ? { groupId: row.groupId } : {}), ...(bet ? { locator: bet.locator } : {}) };
    receipt.attempts.push({ attempt: args.attempt, status: "sending", at: Date.now() });
    if (existing) await ctx.db.patch(existing._id, { result: JSON.stringify(receipt) });
    else await ctx.db.insert("v0Requests", { accountId: row.accountId, scope, key, fingerprint: await hash(key), result: JSON.stringify(receipt), createdAt: Date.now() });
    return { token: token.token, userInfo };
  },
});

export const recordDeviceResult = internalMutation({
  args: {
    ...deviceArgs,
    outcome: v.object({
      status: v.union(v.literal("sent"), v.literal("invalid_token"), v.literal("retry"), v.literal("permanent")),
      code: v.union(v.literal("accepted"), v.literal("unregistered"), v.literal("bad_device_token"), v.literal("rate_limited"), v.literal("provider_error"), v.literal("rejected"), v.literal("network_error"), v.literal("timeout")),
      invalidatedAt: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return null;
    const account = await ctx.db.get(row.accountId);
    if (!account || account.deletedAt !== undefined) return null;
    const existing = await ctx.db.query("v0Requests").withIndex("by_key", (q) => q.eq("accountId", row.accountId).eq("scope", receiptScope(row._id)).eq("key", receiptKey(args))).unique();
    if (!existing) return null;
    const receipt = readReceipt(existing.result);
    const attempt = receipt.attempts.find((attempt) => attempt.attempt === args.attempt);
    if (!attempt || attempt.status !== "sending") return null;
    attempt.status = args.outcome.status;
    attempt.code = args.outcome.code;
    attempt.at = Date.now();
    await ctx.db.patch(existing._id, { result: JSON.stringify(receipt) });
    if (args.outcome.status === "invalid_token") {
      const token = await ctx.db.get(args.tokenId);
      if (token && token.accountId === row.accountId && token.environment === args.environment && token.updatedAt === args.updatedAt
        && (args.outcome.invalidatedAt === undefined || args.outcome.invalidatedAt >= token.updatedAt)) await ctx.db.delete(token._id);
    }
    return null;
  },
});

export const releaseLease = internalMutation({
  args: leaseArgs,
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.id);
    if (ownsLease(row, args) && row) await ctx.db.patch(row._id, { state: "pending", attempts: Math.max(0, row.attempts - 1), leaseUntil: undefined, availableAt: Date.now() + 30_000 });
    return null;
  },
});

export const finishAttempt = internalMutation({
  args: { ...leaseArgs, environment },
  handler: async (ctx, args): Promise<FinishResult> => {
    const row = await ctx.db.get(args.id);
    if (!ownsLease(row, args) || !row) return "stale";
    if (!(await canNotify(ctx, row))) {
      await ctx.db.delete(row._id);
      return "stale";
    }
    const [tokens, records] = await Promise.all([
      ctx.db.query("v0PushTokens").withIndex("by_account", (q) => q.eq("accountId", row.accountId)).take(maxDevices),
      ctx.db.query("v0Requests").withIndex("by_key", (q) => q.eq("accountId", row.accountId).eq("scope", receiptScope(row._id))).collect(),
    ]);
    const receipts = new Map(records.map((record) => [record.key, readReceipt(record.result)]));
    const needsRetry = tokens.filter((token) => token.environment === args.environment).some((token) => {
      const receipt = receipts.get(receiptKey({ tokenId: token._id, updatedAt: token.updatedAt }));
      return !receipt || ["sending", "retry"].includes(receiptStatus(receipt) ?? "");
    });
    const anySent = [...receipts.values()].some((receipt) => receiptStatus(receipt) === "sent");
    if (!needsRetry && anySent) {
      await ctx.db.patch(row._id, { state: "sent", sentAt: Date.now(), leaseUntil: undefined });
      return "sent";
    }
    if (!needsRetry || row.attempts >= maxAttempts) {
      await ctx.db.patch(row._id, { state: "failed", leaseUntil: undefined });
      return "failed";
    }
    const backoff = Math.min(3_600_000, 30_000 * 2 ** (row.attempts - 1));
    await ctx.db.patch(row._id, { state: "pending", leaseUntil: undefined, availableAt: Date.now() + backoff });
    return "retry";
  },
});

export const deliverPending = internalAction({
  args: {},
  handler: async (ctx): Promise<{ status: "unavailable" | "processed"; reason: ApnsAvailability["reason"]; processed: number; sent: number; retried: number; failed: number }> => {
    if (process.env.V0_APNS_ENABLED !== "true" || !process.env.V0_APNS_CONFIG_VERSION) return { status: "unavailable", reason: "not_activated", processed: 0, sent: 0, retried: 0, failed: 0 };
    const availability = await ctx.runAction(availabilityRef, {});
    if (!availability.ready) return { status: "unavailable", reason: availability.reason, processed: 0, sent: 0, retried: 0, failed: 0 };
    const leases = await ctx.runMutation(claimRef, {});
    const results = await Promise.all(leases.map(async (lease) => {
      const result = await ctx.runAction(adapterRef, lease);
      if (result.status === "unavailable") {
        await ctx.runMutation(releaseRef, lease);
        return "stale";
      }
      return await ctx.runMutation(finishRef, { ...lease, environment: result.environment });
    }));
    return { status: "processed", reason: "ready", processed: leases.length, sent: results.filter((result) => result === "sent").length, retried: results.filter((result) => result === "retry").length, failed: results.filter((result) => result === "failed").length };
  },
});
