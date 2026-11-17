import { defineTable } from "convex/server";
import { v } from "convex/values";

export const format = v.union(v.literal("yes_no"), v.literal("over_under"), v.literal("this_that"));
export const betState = v.union(v.literal("open"), v.literal("locked"), v.literal("revealed"), v.literal("provisional"), v.literal("finalized"), v.literal("voided"));

export const v0Tables = {
  v0Accounts: defineTable({
    displayName: v.string(), createdAt: v.number(), noBets: v.boolean(),
    blockedTopics: v.array(v.string()), hostedAiConsentAt: v.optional(v.number()), notificationsEnabled: v.optional(v.boolean()), deletedAt: v.optional(v.number()),
  }),
  v0Phones: defineTable({ accountId: v.id("v0Accounts"), phoneHash: v.string(), lastFour: v.string(), verifiedAt: v.number() })
    .index("by_hash", ["phoneHash"]).index("by_account", ["accountId"]),
  v0Sessions: defineTable({ accountId: v.id("v0Accounts"), tokenHash: v.string(), deviceId: v.string(), createdAt: v.number(), expiresAt: v.number(), revokedAt: v.optional(v.number()) })
    .index("by_hash", ["tokenHash"]).index("by_account", ["accountId"]),
  v0OtpAttempts: defineTable({ phoneHash: v.string(), requestId: v.string(), providerId: v.optional(v.string()), createdAt: v.number(), expiresAt: v.number(), consumedAt: v.optional(v.number()), attempts: v.number() })
    .index("by_request", ["requestId"]).index("by_phone", ["phoneHash"]),
  v0Pairs: defineTable({ accountId: v.id("v0Accounts"), sessionId: v.id("v0Sessions"), codeHash: v.string(), expiresAt: v.number(), consumedAt: v.optional(v.number()) })
    .index("by_hash", ["codeHash"]).index("by_account", ["accountId"]),
  v0Groups: defineTable({ name: v.string(), creatorId: v.id("v0Accounts"), timezone: v.string(), createdAt: v.number(), nextTurnAt: v.number(), nextRecapAt: v.optional(v.number()), lastCreatorId: v.optional(v.id("v0Accounts")), policyVersion: v.optional(v.string()) }),
  v0Memberships: defineTable({ groupId: v.id("v0Groups"), accountId: v.id("v0Accounts"), joinedAt: v.number(), leftAt: v.optional(v.number()), alias: v.string(), points: v.number(), streak: v.number(), lastScoredBetId: v.optional(v.id("v0Bets")) })
    .index("by_group", ["groupId"]).index("by_account", ["accountId"]).index("by_group_account", ["groupId", "accountId"]),
  v0Invites: defineTable({ groupId: v.id("v0Groups"), inviterId: v.id("v0Accounts"), phoneHash: v.string(), createdAt: v.number(), expiresAt: v.number(), acceptedAt: v.optional(v.number()), revokedAt: v.optional(v.number()) })
    .index("by_group", ["groupId"]).index("by_phone", ["phoneHash"]),
  v0ConversationLinks: defineTable({ accountId: v.id("v0Accounts"), deviceId: v.string(), conversationKey: v.string(), groupId: v.id("v0Groups"), linkedAt: v.number() })
    .index("by_account", ["accountId"]).index("by_key", ["accountId", "deviceId", "conversationKey"]),
  v0Bets: defineTable({ groupId: v.id("v0Groups"), creatorId: v.id("v0Accounts"), subjectId: v.id("v0Accounts"), createdAt: v.number(), question: v.string(), contextLine: v.string(), format, options: v.array(v.string()), line: v.optional(v.number()), source: v.union(v.literal("manual"), v.literal("template"), v.literal("history"), v.literal("hosted_ai")), state: betState, cutoffAt: v.number(), revealAt: v.number(), answerDeadline: v.optional(v.number()), answeredAt: v.optional(v.number()), challengeDeadline: v.optional(v.number()), provisionalOutcome: v.optional(v.number()), outcome: v.optional(v.number()), finalizedAt: v.optional(v.number()), policyVersion: v.optional(v.string()), locator: v.string() })
    .index("by_group", ["groupId"]).index("by_subject", ["subjectId"]).index("by_creator", ["creatorId"]).index("by_locator", ["locator"]).index("by_state_cutoff", ["state", "cutoffAt"]).index("by_state_reveal", ["state", "revealAt"]),
  v0Picks: defineTable({ betId: v.id("v0Bets"), groupId: v.id("v0Groups"), accountId: v.id("v0Accounts"), membershipId: v.id("v0Memberships"), option: v.number(), confidence: v.number(), riskPoints: v.optional(v.number()), placedAt: v.number(), updatedAt: v.number(), voidedAt: v.optional(v.number()) })
    .index("by_bet", ["betId"]).index("by_account", ["accountId"]).index("by_bet_account", ["betId", "accountId"]),
  v0Challenges: defineTable({ betId: v.id("v0Bets"), accountId: v.id("v0Accounts"), createdAt: v.number() })
    .index("by_bet", ["betId"]).index("by_bet_account", ["betId", "accountId"]),
  v0Proofs: defineTable({ accountId: v.id("v0Accounts"), betId: v.id("v0Bets"), storageId: v.id("_storage"), contentType: v.union(v.literal("image/jpeg"), v.literal("image/png"), v.literal("audio/mp4")), sha256: v.string(), requestId: v.string(), createdAt: v.number() })
    .index("by_bet", ["betId"]).index("by_account", ["accountId"]).index("by_request", ["accountId", "requestId"]),
  v0Ledger: defineTable({ groupId: v.id("v0Groups"), betId: v.id("v0Bets"), accountId: v.optional(v.id("v0Accounts")), membershipId: v.optional(v.id("v0Memberships")), points: v.number(), streakBefore: v.number(), streakAfter: v.number(), policyVersion: v.string(), createdAt: v.number() })
    .index("by_group", ["groupId"]).index("by_bet", ["betId"]).index("by_account", ["accountId"]),
  v0Turns: defineTable({ groupId: v.id("v0Groups"), localDate: v.string(), creatorId: v.id("v0Accounts"), subjectId: v.id("v0Accounts"), status: v.union(v.literal("assigned"), v.literal("passed"), v.literal("created"), v.literal("expired")), assignedAt: v.number(), passAt: v.number(), betId: v.optional(v.id("v0Bets")) })
    .index("by_group_date", ["groupId", "localDate"]),
  v0Recaps: defineTable({ groupId: v.id("v0Groups"), startsAt: v.number(), endsAt: v.number(), createdAt: v.number() })
    .index("by_group", ["groupId"]),
  v0PushTokens: defineTable({ accountId: v.id("v0Accounts"), deviceId: v.string(), token: v.string(), environment: v.union(v.literal("sandbox"), v.literal("production")), updatedAt: v.number() })
    .index("by_account", ["accountId"]).index("by_device", ["accountId", "deviceId"]).index("by_token", ["token", "environment"]),
  v0Outbox: defineTable({ key: v.string(), accountId: v.id("v0Accounts"), groupId: v.optional(v.id("v0Groups")), betId: v.optional(v.id("v0Bets")), kind: v.union(v.literal("turn"), v.literal("reveal"), v.literal("result"), v.literal("recap")), state: v.union(v.literal("pending"), v.literal("delivering"), v.literal("sent"), v.literal("failed")), attempts: v.number(), availableAt: v.number(), leaseUntil: v.optional(v.number()), sentAt: v.optional(v.number()) })
    .index("by_key", ["key"]).index("by_account", ["accountId"]).index("by_state_available", ["state", "availableAt"]),
  v0Requests: defineTable({ accountId: v.id("v0Accounts"), scope: v.string(), key: v.string(), fingerprint: v.string(), result: v.string(), createdAt: v.number() })
    .index("by_key", ["accountId", "scope", "key"]).index("by_account", ["accountId"]),
  v0RateLimits: defineTable({ key: v.string(), windowStart: v.number(), count: v.number() }).index("by_key", ["key"]),
  v0Blocks: defineTable({ accountId: v.id("v0Accounts"), blockedId: v.id("v0Accounts"), createdAt: v.number() })
    .index("by_account", ["accountId"]).index("by_pair", ["accountId", "blockedId"]),
  v0Reports: defineTable({ reporterId: v.id("v0Accounts"), groupId: v.id("v0Groups"), betId: v.optional(v.id("v0Bets")), reason: v.string(), createdAt: v.number(), status: v.union(v.literal("open"), v.literal("reviewed")) })
    .index("by_reporter", ["reporterId"]),
  v0ProviderCleanup: defineTable({ accountId: v.id("v0Accounts"), provider: v.literal("twilio_verify"), references: v.array(v.string()), state: v.union(v.literal("pending"), v.literal("manual_required"), v.literal("complete")), attempts: v.number(), availableAt: v.number(), createdAt: v.number() })
    .index("by_account", ["accountId"]).index("by_state_available", ["state", "availableAt"]),
  v0Goals: defineTable({ groupId: v.id("v0Groups"), proposerId: v.id("v0Accounts"), label: v.string(), targetPoints: v.number(), confirmedBy: v.array(v.id("v0Accounts")), state: v.union(v.literal("proposed"), v.literal("confirmed")), createdAt: v.number() })
    .index("by_group", ["groupId"]),
};
