import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { approvedPolicy } from "./v0GamePolicy";

export function fail(code: string, message = "This action is not available."): never {
  throw new ConvexError({ code, message });
}

export async function hash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizePhone(phone: string) {
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) fail("INVALID_INPUT", "Enter a phone number with its country code.");
  return phone;
}

export async function phoneHash(phone: string) {
  const pepper = process.env.V0_PHONE_PEPPER;
  if (!pepper || pepper.length < 32) fail("PROVIDER_UNAVAILABLE", "Phone sign-in is not configured.");
  return await hash(`${pepper}:${normalizePhone(phone)}`);
}

export async function requireSession(ctx: QueryCtx, token: string) {
  if (!token || token.length > 256) fail("AUTH_REQUIRED", "Sign in to continue.");
  const digest = await hash(token);
  const current = await ctx.db.query("v0Sessions").withIndex("by_hash", (q) => q.eq("tokenHash", digest)).unique();
  if (!current || current.revokedAt !== undefined || !Number.isFinite(current.createdAt) || !Number.isFinite(current.expiresAt) || current.createdAt > Date.now() || current.expiresAt <= Date.now() || current.expiresAt <= current.createdAt) fail("AUTH_REQUIRED", "Sign in to continue.");
  const account = await ctx.db.get(current.accountId);
  if (!account || account.deletedAt !== undefined) fail("AUTH_REQUIRED", "Sign in to continue.");
  return { account, session: current };
}

export async function activeMember(ctx: QueryCtx, groupId: Id<"v0Groups">, accountId: Id<"v0Accounts">) {
  const rows = await ctx.db.query("v0Memberships").withIndex("by_group_account", (q) => q.eq("groupId", groupId).eq("accountId", accountId)).collect();
  const active = rows.filter((row) => row.leftAt === undefined && Number.isFinite(row.joinedAt) && row.joinedAt <= Date.now());
  return active.length === 1 ? active[0] : null;
}

export async function requireMember(ctx: QueryCtx, groupId: Id<"v0Groups">, accountId: Id<"v0Accounts">) {
  const membership = await activeMember(ctx, groupId, accountId);
  if (!membership || !(await ctx.db.get(groupId))) fail("NOT_AVAILABLE");
  return membership;
}

export async function isBlocked(ctx: QueryCtx, first: Id<"v0Accounts">, second: Id<"v0Accounts">) {
  if (first === second) return false;
  const [a, b] = await Promise.all([
    ctx.db.query("v0Blocks").withIndex("by_pair", (q) => q.eq("accountId", first).eq("blockedId", second)).first(),
    ctx.db.query("v0Blocks").withIndex("by_pair", (q) => q.eq("accountId", second).eq("blockedId", first)).first(),
  ]);
  return !!(a || b);
}

export async function canReadBet(ctx: QueryCtx, bet: Doc<"v0Bets">, accountId: Id<"v0Accounts">) {
  if (![bet.createdAt, bet.cutoffAt, bet.revealAt].every(Number.isFinite) || bet.cutoffAt <= bet.createdAt || bet.revealAt < bet.cutoffAt) return false;
  const member = await activeMember(ctx, bet.groupId, accountId);
  return !!member && (member.joinedAt < bet.createdAt || (member.joinedAt === bet.createdAt && member._creationTime < bet._creationTime))
    && !(await isBlocked(ctx, accountId, bet.creatorId))
    && !(await isBlocked(ctx, accountId, bet.subjectId));
}

export async function requireBet(ctx: QueryCtx, betId: Id<"v0Bets">, accountId: Id<"v0Accounts">) {
  const bet = await ctx.db.get(betId);
  if (!bet || !(await canReadBet(ctx, bet, accountId))) fail("NOT_AVAILABLE");
  return bet;
}

export async function rateLimit(ctx: MutationCtx, key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const row = await ctx.db.query("v0RateLimits").withIndex("by_key", (q) => q.eq("key", key)).unique();
  if (!row || now - row.windowStart >= windowMs) {
    if (row) await ctx.db.patch(row._id, { windowStart: now, count: 1 });
    else await ctx.db.insert("v0RateLimits", { key, windowStart: now, count: 1 });
    return;
  }
  if (row.count >= limit) fail("RATE_LIMITED", "Please wait before trying again.");
  await ctx.db.patch(row._id, { count: row.count + 1 });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

export async function once<T>(ctx: MutationCtx, accountId: Id<"v0Accounts">, scope: string, requestId: string, args: unknown, perform: () => Promise<T>): Promise<T> {
  if (!requestId || requestId.length > 128) fail("INVALID_INPUT", "A request identifier is required.");
  const fingerprint = await hash(canonical(args));
  const existing = await ctx.db.query("v0Requests").withIndex("by_key", (q) => q.eq("accountId", accountId).eq("scope", scope).eq("key", requestId)).unique();
  if (existing) {
    if (existing.fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT", "This request identifier was already used.");
    return JSON.parse(existing.result) as T;
  }
  const result = await perform();
  await ctx.db.insert("v0Requests", { accountId, scope, key: requestId, fingerprint, result: JSON.stringify(result), createdAt: Date.now() });
  return result;
}

export const policyStatus = { status: "pending" as const, version: approvedPolicy.version, approved: approvedPolicy, missing: ["streaks", "reward_rounding", "majority_rule", "creator_rule", "turn_schedule", "recap_schedule", "goal_confirmation"] };

export function legacyUnavailable(): never {
  return fail("NOT_AVAILABLE", "This app version is no longer supported. Update Called It and sign in by phone.");
}
