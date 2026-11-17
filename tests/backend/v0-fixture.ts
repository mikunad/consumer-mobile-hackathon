import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { convexTest } from "convex-test";
import { expect, vi } from "vitest";
import schema from "../../convex/schema";
import { hash, phoneHash } from "../../convex/v0Policy";
import type { Id } from "../../convex/_generated/dataModel";
import { T0, CUTOFF, REVEAL } from "./fixture";

const modules = import.meta.glob("../../convex/**/*.{ts,js}");

export async function v0Fixture() {
  vi.stubEnv("V0_CARD_ORIGIN", "https://cards.e2e.invalid");
  vi.stubEnv("V0_PHONE_PEPPER", "synthetic_fixture_phone_pepper_not_a_live_secret");
  const t = convexTest(schema, modules);
  const runId = `e2e_${crypto.randomUUID().replaceAll("-", "")}`;
  if (!process.env.E2E_ARTIFACT_DIR) throw new Error("Fixture evidence directory required");
  appendFileSync(resolve(process.env.E2E_ARTIFACT_DIR, "fixtures.jsonl"), JSON.stringify({ runId, testName: expect.getState().currentTestName, serverTime: T0, database: "fresh-convex-test-v0.2", actors: ["creator", "friend", "subject", "outsider", "alias", "unadmittedAlias", "revoked", "new", "left"] }) + "\n");
  const names = { creator: "Cora", friend: "Finn", subject: "Sage", outsider: "Oli", unadmittedAlias: "Sage", revoked: "Rae", new: "Nico", left: "Lee", otherSubject: "Dana" };
  type Actor = { id: Id<"v0Accounts">; session: Id<"v0Sessions">; token: string; deviceId: string; phone: string };
  const actors = {} as Record<keyof typeof names | "alias", Actor>;
  const privateValues = [`SECRET_G1_${runId}`, `OPTION_A_${runId}`, `OPTION_B_${runId}`, `CONTEXT_${runId}`, `PROOF_${runId}`];
  const ids = await t.run(async (ctx) => {
    for (const [index, [role, displayName]] of Object.entries(names).entries()) {
      const id = await ctx.db.insert("v0Accounts", { displayName, createdAt: T0 - 120_000, noBets: false, blockedTopics: [], notificationsEnabled: true });
      const token = `synthetic_${runId}_${role}`;
      const deviceId = `${runId}_${role}_device`;
      const session = await ctx.db.insert("v0Sessions", { accountId: id, tokenHash: await hash(token), deviceId, createdAt: T0 - 60_000, expiresAt: T0 + 86_400_000, ...(role === "revoked" ? { revokedAt: T0 - 1 } : {}) });
      const phone = `+1202555${String(101 + index).padStart(4, "0")}`;
      actors[role as keyof typeof names] = { id, token, session, deviceId, phone };
      await ctx.db.insert("v0Phones", { accountId: id, phoneHash: await phoneHash(phone), lastFour: phone.slice(-4), verifiedAt: T0 - 60_000 });
    }
    const aliasToken = `synthetic_${runId}_subject_alias_device`;
    const aliasSession = await ctx.db.insert("v0Sessions", { accountId: actors.subject.id, tokenHash: await hash(aliasToken), deviceId: `${runId}_alias_device`, createdAt: T0 - 60_000, expiresAt: T0 + 86_400_000 });
    const aliasPhone = "+12025550110";
    actors.alias = { id: actors.subject.id, token: aliasToken, session: aliasSession, deviceId: `${runId}_alias_device`, phone: aliasPhone };
    await ctx.db.insert("v0Phones", { accountId: actors.subject.id, phoneHash: await phoneHash(aliasPhone), lastFour: "0110", verifiedAt: T0 - 60_000 });
    const g1 = await ctx.db.insert("v0Groups", { name: `ROOM_G1_${runId}`, creatorId: actors.creator.id, timezone: "America/Los_Angeles", createdAt: T0 - 120_000, nextTurnAt: T0 + 60_000 });
    const g2 = await ctx.db.insert("v0Groups", { name: `ROOM_G2_${runId}`, creatorId: actors.outsider.id, timezone: "Asia/Tokyo", createdAt: T0 - 120_000, nextTurnAt: T0 + 60_000 });
    const invite = await ctx.db.insert("v0Invites", { groupId: g1, inviterId: actors.creator.id, phoneHash: await phoneHash(actors.outsider.phone), createdAt: T0 - 1000, expiresAt: T0 + 60_000 });
    for (const role of ["creator", "friend", "subject", "revoked", "new", "left"] as const) {
      await ctx.db.insert("v0Memberships", { groupId: g1, accountId: actors[role].id, alias: names[role], joinedAt: role === "new" ? T0 + 1 : T0 - 60_000, ...(role === "left" ? { leftAt: T0 - 1 } : {}), points: 1000, streak: 0 });
    }
    for (const role of ["creator", "outsider", "otherSubject"] as const) {
      await ctx.db.insert("v0Memberships", { groupId: g2, accountId: actors[role].id, alias: names[role], joinedAt: T0 - 60_000, points: role === "creator" ? 50 : 1000, streak: 0 });
    }
    const locator = await hash(`${runId}:opaque-locator`);
    const bet = await ctx.db.insert("v0Bets", { groupId: g1, creatorId: actors.creator.id, subjectId: actors.subject.id, createdAt: T0, question: privateValues[0], contextLine: privateValues[3], format: "this_that", options: privateValues.slice(1, 3), source: "manual", state: "open", cutoffAt: CUTOFF, revealAt: REVEAL, locator });
    const bytes = new TextEncoder().encode(privateValues[4]);
    const storageId = await ctx.storage.store(new Blob([bytes], { type: "image/png" }));
    const proof = await ctx.db.insert("v0Proofs", { accountId: actors.subject.id, betId: bet, storageId, contentType: "image/png", sha256: await hash(privateValues[4]), requestId: `${runId}_proof`, createdAt: T0 });
    return { g1, g2, bet, locator, proof, storageId, invite };
  });
  return { t, runId, actors, privateValues, ...ids };
}
