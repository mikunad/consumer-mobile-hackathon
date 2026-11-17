import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { voidBet } from "./v0Bets";
import { requireMember } from "./v0Policy";

export async function cancelSubjectBets(ctx: MutationCtx, accountId: Id<"v0Accounts">, groupId?: Id<"v0Groups">) {
  const bets = await ctx.db.query("v0Bets").withIndex("by_subject", (q) => q.eq("subjectId", accountId)).collect();
  for (const bet of bets) if (groupId === undefined || bet.groupId === groupId) await voidBet(ctx, bet);
}

export async function leaveGroup(ctx: MutationCtx, accountId: Id<"v0Accounts">, groupId: Id<"v0Groups">) {
  const member = await requireMember(ctx, groupId, accountId);
  const now = Date.now();
  await ctx.db.patch(member._id, { leftAt: now });
  await cancelSubjectBets(ctx, accountId, groupId);
  const picks = await ctx.db.query("v0Picks").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect();
  for (const pick of picks) {
    if (pick.groupId !== groupId || pick.voidedAt !== undefined) continue;
    const bet = await ctx.db.get(pick.betId);
    if (bet?.state !== "finalized") await ctx.db.patch(pick._id, { voidedAt: now });
  }
  for (const link of await ctx.db.query("v0ConversationLinks").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()) {
    if (link.groupId === groupId) await ctx.db.delete(link._id);
  }
  for (const item of await ctx.db.query("v0Outbox").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()) {
    if (item.groupId === groupId || (item.betId && (await ctx.db.get(item.betId))?.groupId === groupId)) await ctx.db.delete(item._id);
  }
  for (const invitation of await ctx.db.query("v0Invites").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect()) {
    if (invitation.inviterId === accountId && invitation.acceptedAt === undefined && invitation.revokedAt === undefined) await ctx.db.patch(invitation._id, { revokedAt: now });
  }
  for (const turn of await ctx.db.query("v0Turns").withIndex("by_group_date", (q) => q.eq("groupId", groupId)).collect()) {
    if ((turn.creatorId === accountId || turn.subjectId === accountId) && (turn.status === "assigned" || turn.status === "passed")) await ctx.db.patch(turn._id, { status: "expired" });
  }
}

export async function blockInteractions(ctx: MutationCtx, accountId: Id<"v0Accounts">, blockedId: Id<"v0Accounts">) {
  const bets = new Map<Id<"v0Bets">, Doc<"v0Bets">>();
  for (const person of [accountId, blockedId]) {
    for (const bet of await ctx.db.query("v0Bets").withIndex("by_creator", (q) => q.eq("creatorId", person)).collect()) bets.set(bet._id, bet);
    for (const bet of await ctx.db.query("v0Bets").withIndex("by_subject", (q) => q.eq("subjectId", person)).collect()) bets.set(bet._id, bet);
  }
  const now = Date.now();
  for (const bet of bets.values()) {
    const targeted = (bet.creatorId === accountId && bet.subjectId === blockedId) || (bet.creatorId === blockedId && bet.subjectId === accountId);
    if (targeted) await voidBet(ctx, bet);
    if (bet.state === "finalized" || bet.state === "voided" || targeted) continue;
    for (const pick of await ctx.db.query("v0Picks").withIndex("by_bet", (q) => q.eq("betId", bet._id)).collect()) {
      const affected = (pick.accountId === accountId && (bet.creatorId === blockedId || bet.subjectId === blockedId)) || (pick.accountId === blockedId && (bet.creatorId === accountId || bet.subjectId === accountId));
      if (affected && pick.voidedAt === undefined) await ctx.db.patch(pick._id, { voidedAt: now });
    }
  }
  for (const person of [accountId, blockedId]) {
    const other = person === accountId ? blockedId : accountId;
    for (const item of await ctx.db.query("v0Outbox").withIndex("by_account", (q) => q.eq("accountId", person)).collect()) {
      const bet = item.betId ? bets.get(item.betId) : null;
      if (bet && (bet.creatorId === other || bet.subjectId === other)) await ctx.db.delete(item._id);
    }
    for (const phone of await ctx.db.query("v0Phones").withIndex("by_account", (q) => q.eq("accountId", person)).collect()) {
      for (const invitation of await ctx.db.query("v0Invites").withIndex("by_phone", (q) => q.eq("phoneHash", phone.phoneHash)).collect()) {
        if (invitation.inviterId === other && invitation.acceptedAt === undefined && invitation.revokedAt === undefined) await ctx.db.patch(invitation._id, { revokedAt: now });
      }
    }
  }
}

export async function deleteAccountData(ctx: MutationCtx, accountId: Id<"v0Accounts">) {
  const now = Date.now();
  const phones = await ctx.db.query("v0Phones").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect();
  const phoneHashes = new Set(phones.map((phone) => phone.phoneHash));
  const references = new Set<string>();
  for (const phone of phones) {
    for (const attempt of await ctx.db.query("v0OtpAttempts").withIndex("by_phone", (q) => q.eq("phoneHash", phone.phoneHash)).collect()) {
      if (attempt.providerId) references.add(attempt.providerId);
      await ctx.db.delete(attempt._id);
    }
    await ctx.db.delete(phone._id);
  }
  await ctx.db.insert("v0ProviderCleanup", { accountId, provider: "twilio_verify", references: [...references], state: "manual_required", attempts: 0, availableAt: now, createdAt: now });

  const memberships = await ctx.db.query("v0Memberships").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect();
  const membershipIds = new Set(memberships.map((member) => member._id));
  const bets = new Map<Id<"v0Bets">, Doc<"v0Bets">>();
  for (const bet of await ctx.db.query("v0Bets").withIndex("by_creator", (q) => q.eq("creatorId", accountId)).collect()) bets.set(bet._id, bet);
  for (const bet of await ctx.db.query("v0Bets").withIndex("by_subject", (q) => q.eq("subjectId", accountId)).collect()) bets.set(bet._id, bet);
  const betIds = [...bets.keys()];
  for (const bet of bets.values()) {
    await voidBet(ctx, bet);
    for (const pick of await ctx.db.query("v0Picks").withIndex("by_bet", (q) => q.eq("betId", bet._id)).collect()) await ctx.db.delete(pick._id);
    for (const challenge of await ctx.db.query("v0Challenges").withIndex("by_bet", (q) => q.eq("betId", bet._id)).collect()) await ctx.db.delete(challenge._id);
    for (const proof of await ctx.db.query("v0Proofs").withIndex("by_bet", (q) => q.eq("betId", bet._id)).collect()) {
      await ctx.storage.delete(proof.storageId);
      await ctx.db.delete(proof._id);
    }
    await ctx.db.delete(bet._id);
  }
  for (const entry of await ctx.db.query("v0Ledger").collect()) {
    if (entry.accountId === accountId || (entry.membershipId && membershipIds.has(entry.membershipId))) await ctx.db.patch(entry._id, { accountId: undefined, membershipId: undefined });
  }
  for (const pick of await ctx.db.query("v0Picks").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()) await ctx.db.delete(pick._id);
  for (const proof of await ctx.db.query("v0Proofs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()) {
    await ctx.storage.delete(proof.storageId);
    await ctx.db.delete(proof._id);
  }
  for (const challenge of await ctx.db.query("v0Challenges").collect()) {
    if (challenge.accountId === accountId) await ctx.db.delete(challenge._id);
  }
  for (const item of await ctx.db.query("v0Outbox").collect()) {
    if (item.accountId === accountId || (item.betId && bets.has(item.betId))) await ctx.db.delete(item._id);
  }
  for (const request of await ctx.db.query("v0Requests").collect()) {
    if (request.accountId === accountId || betIds.some((betId) => request.result.includes(betId))) await ctx.db.delete(request._id);
  }
  for (const invitation of await ctx.db.query("v0Invites").collect()) {
    if (invitation.inviterId === accountId || phoneHashes.has(invitation.phoneHash)) await ctx.db.delete(invitation._id);
  }
  for (const report of await ctx.db.query("v0Reports").collect()) {
    if (report.reporterId === accountId || (report.betId && bets.has(report.betId))) await ctx.db.delete(report._id);
  }
  for (const block of await ctx.db.query("v0Blocks").collect()) {
    if (block.accountId === accountId || block.blockedId === accountId) await ctx.db.delete(block._id);
  }
  for (const turn of await ctx.db.query("v0Turns").collect()) {
    if (turn.creatorId === accountId || turn.subjectId === accountId || (turn.betId && bets.has(turn.betId))) await ctx.db.delete(turn._id);
  }
  for (const goal of await ctx.db.query("v0Goals").collect()) {
    if (goal.proposerId === accountId) await ctx.db.delete(goal._id);
    else if (goal.confirmedBy.includes(accountId)) await ctx.db.patch(goal._id, { confirmedBy: goal.confirmedBy.filter((id) => id !== accountId) });
  }
  for (const group of await ctx.db.query("v0Groups").collect()) {
    if (group.lastCreatorId === accountId) await ctx.db.patch(group._id, { lastCreatorId: undefined });
  }
  for (const limit of await ctx.db.query("v0RateLimits").collect()) {
    if (limit.key.includes(accountId) || [...phoneHashes].some((phone) => limit.key.includes(phone))) await ctx.db.delete(limit._id);
  }
  for (const session of await ctx.db.query("v0Sessions").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()) await ctx.db.delete(session._id);
  for (const pair of await ctx.db.query("v0Pairs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()) await ctx.db.delete(pair._id);
  for (const link of await ctx.db.query("v0ConversationLinks").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()) await ctx.db.delete(link._id);
  for (const push of await ctx.db.query("v0PushTokens").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()) await ctx.db.delete(push._id);
  for (const member of memberships) await ctx.db.delete(member._id);
  await ctx.db.patch(accountId, { displayName: "Deleted account", noBets: true, blockedTopics: [], hostedAiConsentAt: undefined, notificationsEnabled: false, deletedAt: now });
}
