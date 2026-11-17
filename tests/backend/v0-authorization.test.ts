import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { noPrivateValues } from "./assertions";
import { contractCases, invoke } from "./contract-cases";
import { CUTOFF, REVEAL, T0 } from "./fixture";
import { v0Fixture } from "./v0-fixture";

const policies = JSON.parse(readFileSync("tests/coverage/v0-public-policies.json", "utf8")) as Record<string, { kind: string; scope: string; authenticated: boolean }>;

describe("SEC1 actual V0 public authorization matrix", () => {
  it("[V0.policy-inventory] requires exact reviewed policies and valid fixtures for all canonical exports", () => {
    const inventory = JSON.parse(readFileSync("tests/coverage/public-exports.json", "utf8")) as { path: string; kind: string }[];
    const canonical = inventory.filter((entry) => entry.path.startsWith("v0") && entry.path !== "v0Runtime:attestation");
    expect(canonical.map((entry) => entry.path).sort()).toEqual(Object.keys(policies).sort());
    expect(Object.keys(contractCases).sort()).toEqual(Object.keys(policies).sort());
    for (const entry of canonical) {
      expect(policies[entry.path].kind).toBe(entry.kind);
      expect(contractCases[entry.path].kind).toBe(entry.kind);
    }
  });

  for (const [path] of Object.entries(policies).filter(([, p]) => p.authenticated)) {
    for (const role of ["anonymous", "revoked"] as const) {
      it(`[V0.auth.${path}.${role}] rejects an invalid session with valid business arguments`, async () => {
        const f = await v0Fixture();
        const token = role === "anonymous" ? "synthetic_anonymous" : f.actors.revoked.token;
        await expect(invoke(f, path, token)).rejects.toMatchObject({ data: { code: "AUTH_REQUIRED" } });
      });
    }
  }

  for (const [path] of Object.entries(policies).filter(([, p]) => ["group_membership", "bet_visibility", "subject_after_reveal", "proof_visibility", "safe_suggestions", "shared_membership"].includes(p.scope))) {
    for (const role of ["outsider", "unadmittedAlias", "new", "left"] as const) {
      it(`[V0.scope.${path}.${role}] denies the targeted G1 resource outside the active interval`, async () => {
        const f = await v0Fixture();
        await expect(invoke(f, path, f.actors[role].token)).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
      });
    }
  }

  for (const role of ["subject", "alias"] as const) {
    for (const path of ["v0Bets:get", "v0Bets:list", "v0Bets:history"]) {
      it(`[V0.subject.${path}.${role}] redacts the canonical subject and their verified alias`, async () => {
        const f = await v0Fixture();
        const value = await invoke(f, path, f.actors[role].token);
        noPrivateValues(value, f.privateValues);
        if (path === "v0Bets:get") {
          expect(value).toMatchObject({ view: "sealed", canVeto: true, serverTime: T0 });
          expect(Object.keys(value as object).sort()).toEqual(["serverTime", "groupId", "betId", "state", "cutoffAt", "revealAt", "card", "view", "canVeto"].sort());
        }
      });
    }
  }

  for (const role of ["creator", "friend"] as const) {
    it(`[V0.eligible.${role}] returns the real eligible view, never context or bearer credentials`, async () => {
      const f = await v0Fixture();
      const value = await f.t.query(api.v0Bets.get, { token: f.actors[role].token, locator: f.locator });
      expect(value).toMatchObject({ view: "bet", question: f.privateValues[0], options: f.privateValues.slice(1, 3), picks: [], myPick: null });
      expect(JSON.stringify(value)).not.toContain(f.privateValues[3]);
      expect(JSON.stringify(value)).not.toContain(f.actors[role].token);
      noPrivateValues(value.card, f.privateValues);
      const url = new URL(value.card.url);
      expect(url.origin).toBe("https://cards.e2e.invalid");
      expect(url.pathname).toBe(`/c/${f.locator}`);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    });
  }

  it("[V0.no-enumeration] makes foreign and unknown locators indistinguishable", async () => {
    const f = await v0Fixture();
    for (const locator of [f.locator, "a".repeat(64)]) {
      await expect(f.t.query(api.v0Bets.get, { token: f.actors.outsider.token, locator })).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE", message: "This action is not available." } });
    }
    expect(await f.t.run((ctx) => ctx.db.query("v0Memberships").withIndex("by_group_account", (q) => q.eq("groupId", f.g1).eq("accountId", f.actors.outsider.id)).collect())).toEqual([]);
  });

  it("[V0.server-reveal] uses server reveal time without a global legacy cutoff or a client now argument", async () => {
    const f = await v0Fixture();
    for (const [time, state, view] of [[CUTOFF - 1, "open", "sealed"], [CUTOFF, "open", "sealed"], [REVEAL - 1, "open", "sealed"], [REVEAL, "revealed", "bet"]] as const) {
      vi.setSystemTime(time);
      const value = await f.t.query(api.v0Bets.get, { token: f.actors.subject.token, locator: f.locator });
      expect(value).toMatchObject({ state, view, serverTime: time, cutoffAt: REVEAL });
      if (view === "sealed") noPrivateValues(value, f.privateValues);
      else expect(value).toMatchObject({ question: f.privateValues[0], canPick: false, canAnswer: true, canChallenge: false, answerDeadline: REVEAL + 86_400_000 });
    }
  });

  for (const at of [CUTOFF, REVEAL - 1, REVEAL, REVEAL + 1]) {
    it(`[V0.no-late-write.${at - CUTOFF}] enforces final-confirm admission at reveal rather than the superseded stored cutoff`, async () => {
      const f = await v0Fixture();
      vi.setSystemTime(at);
      await f.t.run(async (ctx) => {
        expect(Date.now()).toBe(at);
        const args = { token: f.actors.friend.token, betId: f.bet, option: 0, confidence: 0.5, requestId: `${f.runId}_request` };
        if (at < REVEAL) {
          expect(await ctx.runMutation(api.v0Bets.pick, args)).toEqual({ saved: true, option: 0, confidence: 0.5, updatedAt: at });
          expect(await ctx.db.query("v0Picks").collect()).toHaveLength(1);
          expect(await ctx.runQuery(api.v0Bets.get, { token: f.actors.friend.token, locator: f.locator })).toMatchObject({ state: "open", canPick: false, myPick: { option: 0, confidence: 0.5 } });
        } else {
          await expect(ctx.runMutation(api.v0Bets.pick, args)).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
          expect(await ctx.db.query("v0Picks").collect()).toEqual([]);
        }
        expect(await ctx.db.query("v0Ledger").collect()).toEqual([]);
      });
    });
  }

  for (const path of ["v0Bets:create", "v0Bets:pick", "v0Groups:proposeGoal", "v0Groups:confirmGoal"]) {
    it(`[V0.pending-policy.${path}] retains unapproved policy gates while final pick confirmation is explicitly approved`, async () => {
      const f = await v0Fixture();
      if (path === "v0Bets:pick") {
        expect(await invoke(f, path, f.actors.creator.token)).toEqual({ saved: true, option: 0, confidence: 0.5, updatedAt: T0 });
        expect(await f.t.run((ctx) => ctx.db.query("v0Picks").collect())).toHaveLength(1);
      } else {
        await expect(invoke(f, path, f.actors.creator.token)).rejects.toMatchObject({ data: { code: "POLICY_PENDING" } });
        expect(await f.t.run((ctx) => ctx.db.query("v0Picks").collect())).toEqual([]);
      }
      expect(await f.t.run((ctx) => ctx.db.query("v0Ledger").collect())).toEqual([]);
    });
  }

  it("[V0.no-foreign-board] keeps group balances separate from the other membership", async () => {
    const f = await v0Fixture();
    const first = await f.t.query(api.v0Groups.board, { token: f.actors.creator.token, groupId: f.g1 });
    const second = await f.t.query(api.v0Groups.board, { token: f.actors.creator.token, groupId: f.g2 });
    expect(first.rows.find((row) => row.accountId === f.actors.creator.id)?.points).toBe(1000);
    expect(second.rows.find((row) => row.accountId === f.actors.creator.id)?.points).toBe(50);
    expect(first.rows.some((row) => row.accountId === f.actors.outsider.id)).toBe(false);
    expect(second.rows.some((row) => row.accountId === f.actors.subject.id)).toBe(false);
  });
});
