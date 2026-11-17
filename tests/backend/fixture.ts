import { convexTest } from "convex-test";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import schema from "../../convex/schema";
import type { Id } from "../../convex/_generated/dataModel";

export const T0 = Date.parse("2026-11-16T15:59:00Z");
export const CUTOFF = T0 + 10 * 60_000;
export const REVEAL = T0 + 20 * 60_000;
const modules = import.meta.glob("../../convex/**/*.{ts,js}");

export async function fixture(withPicks = false) {
  const t = convexTest(schema, modules);
  const runId = `e2e_${crypto.randomUUID().replaceAll("-", "")}`;
  if (!process.env.E2E_ARTIFACT_DIR) throw new Error("Fixture evidence directory required");
  appendFileSync(resolve(process.env.E2E_ARTIFACT_DIR, "fixtures.jsonl"), JSON.stringify({ runId, testName: expect.getState().currentTestName, serverTime: T0, database: "fresh-convex-test", actors: ["creator", "friend", "subject", "outsider", "alias", "revoked", "new", "left", "otherSubject"] }) + "\n");
  const secret = `SECRET_G1_${runId}`;
  const options = [`OPTION_A_${runId}`, `OPTION_B_${runId}`];
  const privateValues = [secret, ...options, `CONTEXT_${runId}`, `PROOF_${runId}`];
  const names = { creator: "Cora", friend: "Finn", subject: "Sage", outsider: "Oli", alias: "Sage", revoked: "Rae", new: "Nico", left: "Lee", otherSubject: "Dana" };
  type Actor = { id: Id<"users">; token: string };
  const actors = {} as Record<keyof typeof names, Actor>;
  const state = await t.run(async (ctx) => {
    for (const [role, name] of Object.entries(names)) {
      const token = `synthetic_${runId}_${role}`;
      const id = await ctx.db.insert("users", { name, username: `${runId}_${role}`, emoji: "●", token, points: 1000, streak: 0, lastSeen: T0 });
      actors[role as keyof typeof names] = { id, token };
    }
    const revokedToken = `synthetic_revoked_session_${runId}`;
    const revokedSession = await ctx.db.insert("sessions", { userId: actors.revoked.id, token: revokedToken, device: runId });
    await ctx.db.delete(revokedSession);
    actors.revoked.token = revokedToken;
    const g1 = await ctx.db.insert("groups", { name: `ROOM_G1_${runId}`, kind: "chat", createdBy: actors.creator.id, revealAt: REVEAL, inviteCode: `invite_${runId}` });
    const g2 = await ctx.db.insert("groups", { name: `ROOM_G2_${runId}`, kind: "chat", createdBy: actors.outsider.id, revealAt: REVEAL });
    for (const role of ["creator", "friend", "subject"] as const) {
      await ctx.db.insert("members", { groupId: g1, userId: actors[role].id, points: 1000 });
    }
    const leftMembership = await ctx.db.insert("members", { groupId: g1, userId: actors.left.id, points: 1000 });
    await ctx.db.delete(leftMembership);
    for (const role of ["creator", "outsider", "otherSubject"] as const) {
      await ctx.db.insert("members", { groupId: g2, userId: actors[role].id, points: role === "creator" ? 50 : 1000 });
    }
    const round = await ctx.db.insert("rounds", { number: 1, title: runId, opensAt: T0 - 60_000, locksAt: CUTOFF, revealAt: REVEAL, groupId: g1 });
    const bet = await ctx.db.insert("bets", { roundId: round, question: secret, kind: "yesno", options, pools: withPicks ? [10, 20] : [0, 0], status: "open", subjectUserId: actors.subject.id, createdBy: actors.creator.id, revealAt: REVEAL, order: 1 });
    const snapshot = await ctx.db.insert("snapshots", { groupId: g1, label: runId, data: "{}" });
    if (withPicks) {
      for (const [role, option, amount] of [["creator", 0, 10], ["friend", 1, 20]] as const) {
        await ctx.db.insert("stakes", { betId: bet, roundId: round, userId: actors[role].id, option, amount, late: false, streakAtBet: 0 });
        const member = await ctx.db.query("members").withIndex("by_group_user", (q) => q.eq("groupId", g1).eq("userId", actors[role].id)).unique();
        await ctx.db.patch(member!._id, { points: 1000 - amount });
      }
    }
    return { g1, g2, round, bet, snapshot };
  });
  return { t, runId, actors, secret, options, privateValues, ...state };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function ledger(f: Fixture) {
  return f.t.run(async (ctx) => ({
    users: await ctx.db.query("users").collect(),
    members: await ctx.db.query("members").collect(),
    stakes: await ctx.db.query("stakes").collect(),
    bet: await ctx.db.get(f.bet),
  }));
}
