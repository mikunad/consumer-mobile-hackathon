import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { GroupSummary, Recap, Turn } from "./v0Contract";
import { activeMember, canReadBet, fail, isBlocked, once, phoneHash, policyStatus, rateLimit, requireMember, requireSession } from "./v0Policy";

function summary(group: Doc<"v0Groups">, member: Doc<"v0Memberships">): GroupSummary {
  return { id: group._id, name: group.name, timezone: group.timezone, alias: member.alias, points: member.points, streak: member.streak };
}

function conversationKey(value: string) {
  if (!value.trim() || value.length > 256 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) fail("INVALID_INPUT", "Choose a valid conversation.");
  return value;
}

async function currentTurn(ctx: QueryCtx, group: Doc<"v0Groups">, member: Doc<"v0Memberships">): Promise<Doc<"v0Turns"> | null> {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: group.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(Date.now());
  const part = (name: string) => parts.find((entry) => entry.type === name)?.value;
  const localDate = `${part("year")}-${part("month")}-${part("day")}`;
  const turn = await ctx.db.query("v0Turns").withIndex("by_group_date", (q) => q.eq("groupId", group._id).eq("localDate", localDate)).unique();
  if (!turn || !Number.isFinite(turn.assignedAt) || !Number.isFinite(turn.passAt) || turn.assignedAt > Date.now() || turn.creatorId === turn.subjectId) return null;
  const creator = await ctx.db.get(turn.creatorId);
  const subject = await ctx.db.get(turn.subjectId);
  if (!creator || creator.deletedAt !== undefined || !subject || subject.deletedAt !== undefined || subject.noBets) return null;
  const creatorMember = await activeMember(ctx, group._id, creator._id);
  const subjectMember = await activeMember(ctx, group._id, subject._id);
  if (!creatorMember || !subjectMember || [member, creatorMember, subjectMember].some((row) => row.joinedAt > turn.assignedAt || (row.joinedAt === turn.assignedAt && row._creationTime >= turn._creationTime))) return null;
  if (await isBlocked(ctx, creator._id, subject._id) || await isBlocked(ctx, member.accountId, creator._id) || await isBlocked(ctx, member.accountId, subject._id)) return null;
  return turn;
}

export const create = mutation({
  args: { token: v.string(), name: v.string(), timezone: v.string(), requestId: v.string() },
  handler: async (ctx, { token, name, timezone, requestId }) => {
    const { account } = await requireSession(ctx, token);
    const cleanName = name.trim();
    if (!cleanName || name.length > 160 || cleanName.length > 80 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(name) || !timezone || timezone.length > 100) fail("INVALID_INPUT", "Enter a group name and timezone.");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    } catch {
      fail("INVALID_INPUT", "Choose a valid timezone.");
    }
    const result = await once(ctx, account._id, "groups.create", requestId, { name, timezone }, async () => {
      await rateLimit(ctx, `groups.create:${account._id}`, 10, 3_600_000);
      const now = Date.now();
      const groupId = await ctx.db.insert("v0Groups", { name: cleanName, timezone, creatorId: account._id, createdAt: now, nextTurnAt: Number.MAX_SAFE_INTEGER });
      const membershipId = await ctx.db.insert("v0Memberships", { groupId, accountId: account._id, joinedAt: now, alias: account.displayName, points: 0, streak: 0 });
      return summary((await ctx.db.get(groupId))!, (await ctx.db.get(membershipId))!);
    });
    await requireMember(ctx, result.id, account._id);
    return result;
  },
});

export const invite = mutation({
  args: { token: v.string(), groupId: v.id("v0Groups"), phone: v.string(), requestId: v.string() },
  handler: async (ctx, { token, groupId, phone, requestId }) => {
    const { account } = await requireSession(ctx, token);
    await requireMember(ctx, groupId, account._id);
    const targetHash = await phoneHash(phone);
    return await once(ctx, account._id, "groups.invite", requestId, { groupId, phoneHash: targetHash }, async () => {
      await rateLimit(ctx, `groups.invite:${account._id}`, 30, 3_600_000);
      const targetPhone = await ctx.db.query("v0Phones").withIndex("by_hash", (q) => q.eq("phoneHash", targetHash)).unique();
      if (targetPhone && await isBlocked(ctx, account._id, targetPhone.accountId)) return { invited: true as const };
      const now = Date.now();
      const existing = await ctx.db.query("v0Invites").withIndex("by_phone", (q) => q.eq("phoneHash", targetHash)).collect();
      if (!existing.some((row) => row.groupId === groupId && row.inviterId === account._id && row.acceptedAt === undefined && row.revokedAt === undefined && row.expiresAt > now)) {
        await ctx.db.insert("v0Invites", { groupId, inviterId: account._id, phoneHash: targetHash, createdAt: now, expiresAt: now + 7 * 24 * 60 * 60_000 });
      }
      return { invited: true as const };
    });
  },
});

export const invitations = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { account } = await requireSession(ctx, token);
    const phones = await ctx.db.query("v0Phones").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
    const result = [];
    for (const phone of phones) {
      const invites = await ctx.db.query("v0Invites").withIndex("by_phone", (q) => q.eq("phoneHash", phone.phoneHash)).collect();
      for (const invitation of invites) {
        if (invitation.acceptedAt !== undefined || invitation.revokedAt !== undefined || invitation.expiresAt <= Date.now()) continue;
        if (!(await activeMember(ctx, invitation.groupId, invitation.inviterId)) || await isBlocked(ctx, account._id, invitation.inviterId)) continue;
        const group = await ctx.db.get(invitation.groupId);
        if (group) result.push({ id: invitation._id, groupName: group.name, expiresAt: invitation.expiresAt });
      }
    }
    return result;
  },
});

export const accept = mutation({
  args: { token: v.string(), inviteId: v.id("v0Invites"), requestId: v.string() },
  handler: async (ctx, { token, inviteId, requestId }) => {
    const { account } = await requireSession(ctx, token);
    const result = await once(ctx, account._id, "groups.accept", requestId, { inviteId }, async () => {
      const invitation = await ctx.db.get(inviteId);
      if (!invitation || invitation.acceptedAt !== undefined || invitation.revokedAt !== undefined || invitation.expiresAt <= Date.now()) fail("NOT_AVAILABLE");
      const phones = await ctx.db.query("v0Phones").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
      if (!phones.some((phone) => phone.phoneHash === invitation.phoneHash)) fail("NOT_AVAILABLE");
      const group = await ctx.db.get(invitation.groupId);
      const inviter = await ctx.db.get(invitation.inviterId);
      if (!group || !inviter || inviter.deletedAt !== undefined || !(await activeMember(ctx, group._id, inviter._id)) || await isBlocked(ctx, account._id, inviter._id)) fail("NOT_AVAILABLE");
      await rateLimit(ctx, `groups.accept:${account._id}`, 30, 3_600_000);
      const now = Date.now();
      await ctx.db.patch(inviteId, { acceptedAt: now });
      let member = await activeMember(ctx, group._id, account._id);
      if (!member) {
        const membershipId = await ctx.db.insert("v0Memberships", { groupId: group._id, accountId: account._id, joinedAt: now, alias: account.displayName, points: 0, streak: 0 });
        member = (await ctx.db.get(membershipId))!;
      }
      return summary(group, member);
    });
    await requireMember(ctx, result.id, account._id);
    return result;
  },
});

export const members = query({
  args: { token: v.string(), groupId: v.id("v0Groups") },
  handler: async (ctx, { token, groupId }) => {
    const { account } = await requireSession(ctx, token);
    await requireMember(ctx, groupId, account._id);
    const memberships = await ctx.db.query("v0Memberships").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect();
    const result = [];
    for (const member of memberships) {
      if ((await activeMember(ctx, groupId, member.accountId))?._id !== member._id || await isBlocked(ctx, account._id, member.accountId)) continue;
      const person = await ctx.db.get(member.accountId);
      if (person && person.deletedAt === undefined) result.push({ accountId: person._id, alias: member.alias, noBets: person.noBets });
    }
    return result;
  },
});

export const linkConversation = mutation({
  args: { token: v.string(), groupId: v.id("v0Groups"), conversationKey: v.string(), requestId: v.string() },
  handler: async (ctx, { token, groupId, conversationKey: key, requestId }) => {
    const { account, session } = await requireSession(ctx, token);
    await requireMember(ctx, groupId, account._id);
    conversationKey(key);
    return await once(ctx, account._id, "groups.linkConversation", requestId, { groupId, conversationKey: key, deviceId: session.deviceId }, async () => {
      await rateLimit(ctx, `groups.linkConversation:${account._id}`, 60, 60_000);
      const existing = await ctx.db.query("v0ConversationLinks").withIndex("by_key", (q) => q.eq("accountId", account._id).eq("deviceId", session.deviceId).eq("conversationKey", key)).unique();
      if (existing && existing.groupId !== groupId) fail("CONFLICT", "This conversation is already linked to another group.");
      if (!existing) await ctx.db.insert("v0ConversationLinks", { accountId: account._id, deviceId: session.deviceId, conversationKey: key, groupId, linkedAt: Date.now() });
      return { groupId };
    });
  },
});

export const resolveConversation = query({
  args: { token: v.string(), conversationKey: v.string() },
  handler: async (ctx, { token, conversationKey: key }) => {
    const { account, session } = await requireSession(ctx, token);
    conversationKey(key);
    const link = await ctx.db.query("v0ConversationLinks").withIndex("by_key", (q) => q.eq("accountId", account._id).eq("deviceId", session.deviceId).eq("conversationKey", key)).unique();
    if (!link || !(await activeMember(ctx, link.groupId, account._id)) || !(await ctx.db.get(link.groupId))) return null;
    return { groupId: link.groupId };
  },
});

export const unlinkConversation = mutation({
  args: { token: v.string(), conversationKey: v.string(), requestId: v.string() },
  handler: async (ctx, { token, conversationKey: key, requestId }) => {
    const { account, session } = await requireSession(ctx, token);
    conversationKey(key);
    return await once(ctx, account._id, "groups.unlinkConversation", requestId, { conversationKey: key, deviceId: session.deviceId }, async () => {
      await rateLimit(ctx, `groups.unlinkConversation:${account._id}`, 60, 60_000);
      const link = await ctx.db.query("v0ConversationLinks").withIndex("by_key", (q) => q.eq("accountId", account._id).eq("deviceId", session.deviceId).eq("conversationKey", key)).unique();
      if (link) await ctx.db.delete(link._id);
      return { unlinked: true as const };
    });
  },
});

export const turn = query({
  args: { token: v.string(), groupId: v.id("v0Groups") },
  handler: async (ctx, { token, groupId }): Promise<Turn | null> => {
    const { account } = await requireSession(ctx, token);
    const member = await requireMember(ctx, groupId, account._id);
    const assigned = await currentTurn(ctx, (await ctx.db.get(groupId))!, member);
    if (!assigned) return null;
    return { id: assigned._id, groupId, localDate: assigned.localDate, creatorId: assigned.creatorId, subjectId: assigned.subjectId, status: assigned.status, assignedAt: assigned.assignedAt, passAt: assigned.passAt, canPass: false };
  },
});

export const passTurn = mutation({
  args: { token: v.string(), groupId: v.id("v0Groups"), requestId: v.string() },
  handler: async (ctx, { token, groupId, requestId }): Promise<Turn | null> => {
    const { account } = await requireSession(ctx, token);
    const member = await requireMember(ctx, groupId, account._id);
    if (!requestId || requestId.length > 128) fail("INVALID_INPUT", "A request identifier is required.");
    const assigned = await currentTurn(ctx, (await ctx.db.get(groupId))!, member);
    if (!assigned) return null;
    if (assigned.creatorId !== account._id || assigned.status !== "assigned") fail("NOT_AVAILABLE");
    return fail("POLICY_PENDING", "Turn reassignment rules are awaiting approval.");
  },
});

export const recap = query({
  args: { token: v.string(), groupId: v.id("v0Groups") },
  handler: async (ctx, { token, groupId }): Promise<Recap | null> => {
    const { account } = await requireSession(ctx, token);
    const member = await requireMember(ctx, groupId, account._id);
    const recaps = await ctx.db.query("v0Recaps").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect();
    const latest = recaps.filter((item) => Number.isFinite(item.startsAt) && Number.isFinite(item.endsAt) && item.startsAt < item.endsAt && item.endsAt > member.joinedAt && item.endsAt <= Date.now() && item.createdAt <= Date.now()).sort((a, b) => b.endsAt - a.endsAt || b.createdAt - a.createdAt)[0];
    if (!latest) return null;
    const startsAt = Math.max(latest.startsAt, member.joinedAt);
    const rows = new Map<Id<"v0Accounts">, Recap["rows"][number]>();
    for (const entry of await ctx.db.query("v0Ledger").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect()) {
      if (!entry.accountId || !entry.membershipId || entry.createdAt < startsAt || entry.createdAt >= latest.endsAt || !Number.isFinite(entry.points)) continue;
      const bet = await ctx.db.get(entry.betId);
      if (!bet || bet.groupId !== groupId || bet.state !== "finalized" || !(await canReadBet(ctx, bet, account._id)) || await isBlocked(ctx, account._id, entry.accountId)) continue;
      const person = await ctx.db.get(entry.accountId);
      const membership = await activeMember(ctx, groupId, entry.accountId);
      if (!person || person.deletedAt !== undefined || membership?._id !== entry.membershipId) continue;
      const previous = rows.get(person._id);
      rows.set(person._id, { accountId: person._id, alias: membership.alias, points: (previous?.points ?? 0) + entry.points });
    }
    return { id: latest._id, groupId, startsAt, endsAt: latest.endsAt, rows: [...rows.values()].sort((a, b) => b.points - a.points || a.alias.localeCompare(b.alias) || a.accountId.localeCompare(b.accountId)), policy: policyStatus };
  },
});

export const board = query({
  args: { token: v.string(), groupId: v.id("v0Groups") },
  handler: async (ctx, { token, groupId }) => {
    const { account } = await requireSession(ctx, token);
    await requireMember(ctx, groupId, account._id);
    const memberships = await ctx.db.query("v0Memberships").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect();
    const rows = [];
    for (const member of memberships) {
      if ((await activeMember(ctx, groupId, member.accountId))?._id !== member._id || await isBlocked(ctx, account._id, member.accountId)) continue;
      const person = await ctx.db.get(member.accountId);
      if (person && person.deletedAt === undefined) rows.push({ accountId: person._id, alias: member.alias, points: member.points, streak: member.streak });
    }
    rows.sort((a, b) => b.points - a.points || a.alias.localeCompare(b.alias) || a.accountId.localeCompare(b.accountId));
    return { groupId, rows, goal: null, policy: policyStatus };
  },
});

export const proposeGoal = mutation({
  args: { token: v.string(), groupId: v.id("v0Groups"), label: v.string(), targetPoints: v.number(), requestId: v.string() },
  handler: async (ctx, { token, groupId }) => {
    const { account } = await requireSession(ctx, token);
    await requireMember(ctx, groupId, account._id);
    return fail("POLICY_PENDING", "Group goal rules are awaiting approval.");
  },
});

export const confirmGoal = mutation({
  args: { token: v.string(), groupId: v.id("v0Groups"), requestId: v.string() },
  handler: async (ctx, { token, groupId }) => {
    const { account } = await requireSession(ctx, token);
    await requireMember(ctx, groupId, account._id);
    return fail("POLICY_PENDING", "Group goal rules are awaiting approval.");
  },
});
