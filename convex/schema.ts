import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { v0Tables } from "./v0Schema";

export default defineSchema({
  ...v0Tables,
  users: defineTable({
    name: v.string(),
    emoji: v.string(),
    token: v.string(),
    points: v.number(),
    streak: v.number(),
    lastRoundNumber: v.optional(v.number()),
    lastRoundId: v.optional(v.id("rounds")),
    lastSeen: v.number(),
    username: v.optional(v.string()),
    isTest: v.optional(v.boolean()),
  })
    .index("by_token", ["token"])
    .index("by_points", ["points"])
    .index("by_username", ["username"]),
  groups: defineTable({
    name: v.string(),
    createdBy: v.optional(v.id("users")),
    isDefault: v.optional(v.boolean()),
    kind: v.optional(v.literal("chat")),
    inviteCode: v.optional(v.string()),
    revealAt: v.optional(v.number()),
  })
    .index("by_default", ["isDefault"])
    .index("by_invite", ["inviteCode"]),
  members: defineTable({
    groupId: v.id("groups"),
    userId: v.id("users"),
    points: v.optional(v.number()),
  })
    .index("by_group", ["groupId"])
    .index("by_user", ["userId"])
    .index("by_group_user", ["groupId", "userId"]),
  rounds: defineTable({
    number: v.number(),
    title: v.string(),
    opensAt: v.number(),
    locksAt: v.number(),
    revealAt: v.optional(v.number()),
    groupId: v.optional(v.id("groups")),
  })
    .index("by_number", ["number"])
    .index("by_opensAt", ["opensAt"])
    .index("by_group_opensAt", ["groupId", "opensAt"]),
  bets: defineTable({
    roundId: v.id("rounds"),
    question: v.string(),
    kind: v.union(v.literal("yesno"), v.literal("overunder"), v.literal("multi")),
    options: v.array(v.string()),
    line: v.optional(v.number()),
    pools: v.array(v.number()),
    status: v.union(v.literal("open"), v.literal("locked"), v.literal("settled"), v.literal("refunded")),
    winningOption: v.optional(v.number()),
    subjectUserId: v.optional(v.id("users")),
    hidden: v.optional(v.boolean()),
    order: v.number(),
    counter: v.optional(v.number()),
    createdBy: v.optional(v.id("users")),
    byAI: v.optional(v.boolean()),
    revealAt: v.optional(v.number()),
    settledAt: v.optional(v.number()),
  }).index("by_round", ["roundId"]),
  sessions: defineTable({
    userId: v.id("users"),
    token: v.string(),
    device: v.string(),
  }).index("by_token", ["token"]),
  pairs: defineTable({
    userId: v.id("users"),
    code: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  }).index("by_code", ["code"]),
  snapshots: defineTable({
    groupId: v.id("groups"),
    label: v.string(),
    data: v.string(),
  }).index("by_group", ["groupId"]),
  reactions: defineTable({
    betId: v.id("bets"),
    userId: v.id("users"),
    emoji: v.string(),
  }).index("by_bet", ["betId"]),
  stakes: defineTable({
    betId: v.id("bets"),
    roundId: v.id("rounds"),
    userId: v.id("users"),
    option: v.number(),
    amount: v.number(),
    late: v.boolean(),
    streakAtBet: v.number(),
    payout: v.optional(v.number()),
  })
    .index("by_bet", ["betId"])
    .index("by_user", ["userId"])
    .index("by_round_user", ["roundId", "userId"]),
  ticks: defineTable({
    betId: v.id("bets"),
    t: v.number(),
    pct: v.array(v.number()),
  }).index("by_bet", ["betId"]),
  assets: defineTable({
    path: v.string(),
    storageId: v.id("_storage"),
    contentType: v.string(),
    deployId: v.string(),
  }).index("by_path", ["path"]),
});
