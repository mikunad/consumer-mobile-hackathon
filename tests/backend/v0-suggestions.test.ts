import { describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { hash } from "../../convex/v0Policy";
import { validateCandidate } from "../../convex/v0Safety";
import { CUTOFF, REVEAL, T0 } from "./fixture";
import { v0Fixture } from "./v0-fixture";

type Fixture = Awaited<ReturnType<typeof v0Fixture>>;

function suggestions(f: Fixture) {
  return { token: f.actors.creator.token, groupId: f.g1, subjectId: f.actors.subject.id, contextLine: "", useHostedAi: false };
}

function manual(f: Fixture) {
  return {
    token: f.actors.creator.token, groupId: f.g1, subjectId: f.actors.subject.id,
    question: "Will they suggest a song before the reveal?", contextLine: "A friendly music evening.",
    format: "yes_no" as const, options: ["Yes", "No"], cutoffAt: REVEAL, revealAt: REVEAL,
    source: "manual" as const, requestId: `${f.runId}_create`,
  };
}

async function historyBet(f: Fixture, question: string, patch: Partial<Omit<Doc<"v0Bets">, "_id" | "_creationTime">> = {}) {
  return await f.t.run(async (ctx) => ctx.db.insert("v0Bets", {
    groupId: f.g1, creatorId: f.actors.creator.id, subjectId: f.actors.subject.id,
    createdAt: T0 - 30_000, cutoffAt: T0 - 20_000, revealAt: T0 - 10_000,
    question, contextLine: "Friendly synthetic music context.", format: "yes_no", options: ["Yes", "No"],
    source: "manual", state: "finalized", locator: await hash(`${f.runId}:${question}:${crypto.randomUUID()}`), ...patch,
  }));
}

describe("actual V0 suggestions, shared safety and manual-create validation", () => {
  it("[V0.suggestions.safe-template-shape] returns three to five safe two-choice suggestions without chat/provider provenance", async () => {
    const f = await v0Fixture();
    const contextLine = "Only a synthetic puzzle evening.";
    const result = await f.t.action(api.v0Suggestions.get, { ...suggestions(f), contextLine });
    expect(result.processing).toBe("templates_and_group_history");
    expect(result.readsChat).toBe(false);
    expect(result.suggestions.length).toBeGreaterThanOrEqual(3);
    expect(result.suggestions.length).toBeLessThanOrEqual(5);
    for (const candidate of result.suggestions) {
      expect(candidate.subjectId).toBe(f.actors.subject.id);
      expect(candidate.options).toHaveLength(2);
      expect(new Set(candidate.options).size).toBe(2);
      expect(candidate.source).toBe("template");
      expect(["yes_no", "over_under", "this_that"]).toContain(candidate.format);
      expect(() => validateCandidate(candidate, { blockedTopics: [], contextLine })).not.toThrow();
      expect(Object.keys(candidate).sort()).toEqual((candidate.format === "over_under" ? ["subjectId", "source", "question", "format", "options", "line"] : ["subjectId", "source", "question", "format", "options"]).sort());
    }
    const serialized = JSON.stringify(result);
    for (const privateValue of [...f.privateValues, f.actors.creator.token, contextLine]) expect(serialized).not.toContain(privateValue);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("[V0.suggestions.context-ranking] uses typed safe context without pretending to have read Messages", async () => {
    const f = await v0Fixture();
    const result = await f.t.action(api.v0Suggestions.get, { ...suggestions(f), contextLine: "They are practicing a drawing." });
    expect(result.suggestions[0].question.toLowerCase()).toContain("drawing");
    expect(result.suggestions[0].source).toBe("template");
    expect(result.readsChat).toBe(false);
  });

  for (const role of ["subject", "alias", "outsider", "unadmittedAlias", "left", "new", "revoked"] as const) {
    it(`[V0.suggestions.denied-role.${role}] denies self-subject and ineligible requester scopes`, async () => {
      const f = await v0Fixture();
      await expect(f.t.action(api.v0Suggestions.get, { ...suggestions(f), token: f.actors[role].token })).rejects.toMatchObject({ data: { code: role === "revoked" ? "AUTH_REQUIRED" : "NOT_AVAILABLE" } });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  }

  it("[V0.suggestions.history-scope-provenance] reuses only eligible revealed finalized same-subject history once", async () => {
    const f = await v0Fixture();
    const safe = "Will they recommend a new puzzle before the reveal?";
    await historyBet(f, safe);
    await historyBet(f, safe);
    await historyBet(f, "PRIVATE_FOREIGN_GROUP_HISTORY", { groupId: f.g2, subjectId: f.actors.otherSubject.id, creatorId: f.actors.outsider.id });
    await historyBet(f, "PRIVATE_OTHER_SUBJECT_HISTORY", { subjectId: f.actors.friend.id });
    await historyBet(f, "PRIVATE_PREJOIN_HISTORY", { createdAt: T0 - 120_000, cutoffAt: T0 - 100_000, revealAt: T0 - 90_000 });
    await historyBet(f, "PRIVATE_UNREVEALED_HISTORY", { cutoffAt: CUTOFF, revealAt: REVEAL });
    await historyBet(f, "PRIVATE_VOIDED_HISTORY", { state: "voided" });
    await historyBet(f, "Will they have money trouble before the reveal?");
    const result = await f.t.action(api.v0Suggestions.get, suggestions(f));
    expect(result.suggestions.filter((candidate) => candidate.question === safe)).toHaveLength(1);
    expect(result.suggestions.find((candidate) => candidate.question === safe)?.source).toBe("history");
    expect(result.suggestions.every((candidate) => candidate.subjectId === f.actors.subject.id)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|money trouble/);
    expect(new Set(result.suggestions.map((candidate) => candidate.question)).size).toBe(result.suggestions.length);
  });

  it("[V0.suggestions.history-membership-window] gives a newly active member templates but no pre-join history", async () => {
    const f = await v0Fixture();
    const history = "Will they choose a puzzle before the reveal?";
    await historyBet(f, history);
    vi.setSystemTime(T0 + 2);
    const result = await f.t.action(api.v0Suggestions.get, { ...suggestions(f), token: f.actors.new.token });
    expect(result.suggestions.every((candidate) => candidate.source === "template")).toBe(true);
    expect(result.suggestions.some((candidate) => candidate.question === history)).toBe(false);
  });

  it("[V0.suggestions.blocked-history-creator] excludes history whose creator is blocked without blocking safe templates", async () => {
    const f = await v0Fixture();
    const question = "Will they suggest a cooperative game before the reveal?";
    await historyBet(f, question, { creatorId: f.actors.friend.id });
    await f.t.mutation(api.v0Controls.block, { token: f.actors.creator.token, accountId: f.actors.friend.id, requestId: `${f.runId}_block` });
    const result = await f.t.action(api.v0Suggestions.get, suggestions(f));
    expect(result.suggestions.some((candidate) => candidate.question === question)).toBe(false);
    expect(result.suggestions.length).toBeGreaterThanOrEqual(3);
  });

  it("[V0.suggestions.cross-group-subject] rejects a target outside the requested group and keeps eligible G2 history separate", async () => {
    const f = await v0Fixture();
    await historyBet(f, "PRIVATE_G1_ONLY_HISTORY");
    await expect(f.t.action(api.v0Suggestions.get, { ...suggestions(f), groupId: f.g2 })).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
    const result = await f.t.action(api.v0Suggestions.get, { ...suggestions(f), groupId: f.g2, subjectId: f.actors.otherSubject.id });
    expect(result.suggestions.every((candidate) => candidate.subjectId === f.actors.otherSubject.id)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_G1_ONLY_HISTORY");
  });

  for (const role of ["subject", "creator"] as const) {
    it(`[V0.suggestions.blocked-topics.${role}] applies subject and requester preferences to every result`, async () => {
      const f = await v0Fixture();
      await f.t.mutation(api.v0Controls.update, { token: f.actors[role].token, noBets: false, blockedTopics: ["song"], hostedAiConsent: false, requestId: `${f.runId}_topics` });
      const result = await f.t.action(api.v0Suggestions.get, suggestions(f));
      expect(result.suggestions.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(result).toLowerCase()).not.toContain("song");
    });
  }

  it("[V0.suggestions.no-safe-template] fails closed rather than returning fewer than three or ignoring blocked context", async () => {
    const f = await v0Fixture();
    await f.t.mutation(api.v0Controls.update, { token: f.actors.subject.token, noBets: false, blockedTopics: ["they"], hostedAiConsent: false, requestId: `${f.runId}_all` });
    await expect(f.t.action(api.v0Suggestions.get, suggestions(f))).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("[V0.suggestions.no-bets-and-block] enforces no-bets and actor blocks through the public action", async () => {
    const f = await v0Fixture();
    await f.t.mutation(api.v0Controls.update, { token: f.actors.subject.token, noBets: true, blockedTopics: [], hostedAiConsent: false, requestId: `${f.runId}_no_bets` });
    await expect(f.t.action(api.v0Suggestions.get, suggestions(f))).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
    await f.t.mutation(api.v0Controls.update, { token: f.actors.subject.token, noBets: false, blockedTopics: [], hostedAiConsent: false, requestId: `${f.runId}_allow` });
    await f.t.mutation(api.v0Controls.block, { token: f.actors.subject.token, accountId: f.actors.creator.id, requestId: `${f.runId}_block` });
    await expect(f.t.action(api.v0Suggestions.get, suggestions(f))).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
  });

  it("[V0.suggestions.hosted-unavailable-fallback] returns safe templates even with consent/activation while the actual provider adapter is unavailable", async () => {
    const f = await v0Fixture();
    await f.t.mutation(api.v0Controls.update, { token: f.actors.creator.token, noBets: false, blockedTopics: [], hostedAiConsent: true, requestId: `${f.runId}_consent` });
    vi.stubEnv("V0_HOSTED_AI_ENABLED", "true");
    vi.stubEnv("V0_HOSTED_AI_PROVIDER", "anthropic");
    vi.stubEnv("V0_HOSTED_AI_CONFIG_VERSION", "synthetic-offline-only");
    const result = await f.t.action(api.v0Suggestions.get, { ...suggestions(f), useHostedAi: true });
    expect(result.processing).toBe("templates_and_group_history");
    expect(result.suggestions).toHaveLength(5);
    expect(result.suggestions.every((candidate) => candidate.source === "template")).toBe(true);
    expect(result.readsChat).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("[V0.suggestions.hosted-without-consent] never contacts a hosted provider when consent is absent", async () => {
    const f = await v0Fixture();
    vi.stubEnv("V0_HOSTED_AI_ENABLED", "true");
    vi.stubEnv("V0_HOSTED_AI_PROVIDER", "anthropic");
    vi.stubEnv("V0_HOSTED_AI_CONFIG_VERSION", "synthetic-offline-only");
    const result = await f.t.action(api.v0Suggestions.get, { ...suggestions(f), useHostedAi: true });
    expect(result.processing).toBe("templates_and_group_history");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("[V0.suggestions.quota-reset] enforces the real per-account quota and resets at the server window boundary", async () => {
    const f = await v0Fixture();
    for (let index = 0; index < 12; index++) await f.t.action(api.v0Suggestions.get, suggestions(f));
    await expect(f.t.action(api.v0Suggestions.get, suggestions(f))).rejects.toMatchObject({ data: { code: "RATE_LIMITED" } });
    expect(await f.t.run((ctx) => ctx.db.query("v0RateLimits").withIndex("by_key", (q) => q.eq("key", `suggestions:${f.actors.creator.id}`)).unique())).toMatchObject({ count: 12 });
    vi.setSystemTime(T0 + 60_000);
    expect((await f.t.action(api.v0Suggestions.get, suggestions(f))).suggestions.length).toBeGreaterThanOrEqual(3);
    expect(await f.t.run((ctx) => ctx.db.query("v0RateLimits").withIndex("by_key", (q) => q.eq("key", `suggestions:${f.actors.creator.id}`)).unique())).toMatchObject({ count: 1 });
  });

  for (const format of ["yes_no", "over_under", "this_that"] as const) {
    it(`[V0.manual.safe-pending.${format}] validates safe manual input without inventing approved lifecycle or economics`, async () => {
      const f = await v0Fixture();
      const args = { ...manual(f), format, ...(format === "over_under" ? { line: 1.5 } : {}) };
      await expect(f.t.mutation(api.v0Bets.create, args)).rejects.toMatchObject({ data: { code: "POLICY_PENDING" } });
      expect(await f.t.run((ctx) => ctx.db.query("v0Bets").collect())).toHaveLength(1);
      expect(await f.t.run((ctx) => ctx.db.query("v0Picks").collect())).toEqual([]);
      expect(await f.t.run((ctx) => ctx.db.query("v0Ledger").collect())).toEqual([]);
    });
  }

  const unsafe = [
    ["health", { question: "Will they need medical treatment?" }],
    ["appearance", { question: "Will they complain about their weight?" }],
    ["money", { question: "Will they have debt trouble?" }],
    ["relationship", { question: "Will their relationship break up?" }],
    ["harassment", { question: "Will they humiliate a friend?" }],
    ["fake-chat-source", { question: "According to the messages, will they recommend a book?" }],
    ["unsafe-context", { contextLine: "They have medical problems." }],
    ["unsafe-option", { options: ["A puzzle", "Debt"] }],
    ["html", { question: "Will they share <script> today?" }],
    ["contact", { contextLine: "Contact +12025550101 for the answer." }],
    ["control-character", { question: "Will they\u200bsuggest a song?" }],
    ["unicode-topic", { question: "Ｗｉｌｌ ｔｈｅｙ ｈａｖｅ ｄｅｂｔ ｔｒｏｕｂｌｅ？" }],
    ["three-options", { options: ["A", "B", "C"] }],
    ["duplicate-normalized-options", { options: ["Café", "Cafe\u0301"] }],
    ["unexpected-line", { line: 1.5 }],
    ["long-context", { contextLine: "a".repeat(281) }],
  ] as const;
  for (const [name, patch] of unsafe) {
    it(`[V0.manual.safety.${name}] rejects unsafe manual edits before the pending-policy gate`, async () => {
      const f = await v0Fixture();
      const args = { ...manual(f), ...patch, options: "options" in patch ? [...patch.options] : manual(f).options };
      await expect(f.t.mutation(api.v0Bets.create, args)).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });
      expect(await f.t.run((ctx) => ctx.db.query("v0Bets").collect())).toHaveLength(1);
    });
  }

  it("[V0.manual.preferences] enforces subject no-bets and both actors' blocked topics at creation", async () => {
    const f = await v0Fixture();
    for (const role of ["subject", "creator"] as const) {
      await f.t.mutation(api.v0Controls.update, { token: f.actors[role].token, noBets: false, blockedTopics: ["song"], hostedAiConsent: false, requestId: `${f.runId}_block_${role}` });
      await expect(f.t.mutation(api.v0Bets.create, manual(f))).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });
      await f.t.mutation(api.v0Controls.update, { token: f.actors[role].token, noBets: false, blockedTopics: [], hostedAiConsent: false, requestId: `${f.runId}_clear_${role}` });
    }
    await f.t.mutation(api.v0Controls.update, { token: f.actors.subject.token, noBets: true, blockedTopics: [], hostedAiConsent: false, requestId: `${f.runId}_none` });
    await expect(f.t.mutation(api.v0Bets.create, manual(f))).rejects.toMatchObject({ data: { code: "NOT_AVAILABLE" } });
  });

  it("[V0.safety.actual-normalization] uses the actual shared validator for normalization, two outcomes and over-under line requirements", () => {
    expect(validateCandidate({ question: "　Will   they suggest a song?　", format: "yes_no", options: [" Yes ", "No"] }, { blockedTopics: [] })).toEqual({ question: "Will they suggest a song?", format: "yes_no", options: ["Yes", "No"] });
    for (const candidate of [
      { question: "Will they play a game?", format: "multi", options: ["A", "B"] },
      { question: "How many songs?", format: "over_under", options: ["Over", "Under"] },
      { question: "How many songs?", format: "over_under", options: ["Over", "Under"], line: Number.POSITIVE_INFINITY },
      { question: "Will they play a game?", format: "yes_no", options: [" ", "No"] },
    ]) expect(() => validateCandidate(candidate, { blockedTopics: [] })).toThrow();
  });
});
