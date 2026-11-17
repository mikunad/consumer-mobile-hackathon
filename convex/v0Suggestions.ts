import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation } from "./_generated/server";
import type { Suggestion } from "./v0Contract";
import { activeMember, canReadBet, fail, isBlocked, rateLimit, requireMember, requireSession } from "./v0Policy";
import { validateCandidate, type Candidate } from "./v0Safety";

type Input = {
  token: string;
  groupId: Id<"v0Groups">;
  subjectId: Id<"v0Accounts">;
  contextLine: string;
  useHostedAi: boolean;
};

type Prepared = { suggestions: Suggestion[]; hostedAiConsented: boolean };

const prepareRef = makeFunctionReference<"mutation", Input, Prepared>("v0Suggestions:prepare");
const input = { token: v.string(), groupId: v.id("v0Groups"), subjectId: v.id("v0Accounts"), contextLine: v.string(), useHostedAi: v.boolean() };

const templates: Candidate[] = [
  { question: "Will they suggest a song before the reveal?", format: "yes_no", options: ["Yes", "No"] },
  { question: "Which activity will they suggest first before the reveal?", format: "this_that", options: ["A puzzle", "A board game"] },
  { question: "Will they share a fun fact before the reveal?", format: "yes_no", options: ["Yes", "No"] },
  { question: "How many songs will they suggest before the reveal?", format: "over_under", options: ["Over", "Under"], line: 1.5 },
  { question: "Will they suggest playing a game before the reveal?", format: "yes_no", options: ["Yes", "No"] },
  { question: "Will they finish a drawing before the reveal?", format: "yes_no", options: ["Yes", "No"] },
  { question: "Will they spot a dog before the reveal?", format: "yes_no", options: ["Yes", "No"] },
  { question: "Will they recommend a book before the reveal?", format: "yes_no", options: ["Yes", "No"] },
];

function unavailableHostedAiAdapter(deadlineAt: number): never {
  if (Date.now() >= deadlineAt) fail("PROVIDER_UNAVAILABLE", "Suggestions took too long. Use a safe template instead.");
  return fail("PROVIDER_UNAVAILABLE", "Hosted suggestions are not available. Use a safe template instead.");
}

export const prepare = internalMutation({
  args: input,
  handler: async (ctx, args): Promise<Prepared> => {
    const { account } = await requireSession(ctx, args.token);
    await requireMember(ctx, args.groupId, account._id);
    if (account._id === args.subjectId) fail("NOT_AVAILABLE");
    const [subject, subjectMembership] = await Promise.all([
      ctx.db.get(args.subjectId),
      activeMember(ctx, args.groupId, args.subjectId),
    ]);
    if (!subject || subject.deletedAt !== undefined || subject.noBets || !subjectMembership || await isBlocked(ctx, account._id, subject._id)) fail("NOT_AVAILABLE");
    const blockedTopics = Array.from(new Set([...subject.blockedTopics, ...account.blockedTopics]));
    validateCandidate({ question: "Is this a friendly prediction?", format: "yes_no", options: ["Yes", "No"] }, { blockedTopics: [], contextLine: args.contextLine });
    await rateLimit(ctx, `suggestions:${account._id}`, 12, 60_000);
    const suggestions: Suggestion[] = [];
    const seen = new Set<string>();
    const add = (candidate: unknown, source: "template" | "history", contextLine: string) => {
      try {
        const valid = validateCandidate(candidate, { blockedTopics, contextLine });
        const key = JSON.stringify(valid);
        if (!seen.has(key)) {
          seen.add(key);
          suggestions.push({ ...valid, subjectId: subject._id, source });
        }
      } catch (error) {
        if (!(error instanceof ConvexError)) throw error;
      }
    };
    const history = await ctx.db.query("v0Bets").withIndex("by_group", (q) => q.eq("groupId", args.groupId)).order("desc").take(24);
    const now = Date.now();
    for (const bet of history) {
      if (suggestions.length >= 2) break;
      if (bet.subjectId !== subject._id || bet.state !== "finalized" || bet.revealAt > now) continue;
      if (!(await canReadBet(ctx, bet, account._id)) || !(await canReadBet(ctx, bet, subject._id))) continue;
      const creator = await ctx.db.get(bet.creatorId);
      if (!creator || creator.deletedAt !== undefined) continue;
      try {
        validateCandidate(bet, { blockedTopics, contextLine: bet.contextLine });
      } catch (error) {
        if (!(error instanceof ConvexError)) throw error;
        continue;
      }
      add(bet, "history", args.contextLine);
    }
    const words = new Set(args.contextLine.toLowerCase().match(/[a-z]{3,}/g) ?? []);
    const ranked = templates.map((candidate, index) => ({ candidate, index, score: (candidate.question.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((word) => words.has(word)).length }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    for (const { candidate } of ranked) {
      if (suggestions.length >= 5) break;
      add(candidate, "template", args.contextLine);
    }
    if (suggestions.length < 3) fail("NOT_AVAILABLE", "No safe suggestions are available for these settings. Try a different context.");
    return {
      suggestions,
      hostedAiConsented: account.hostedAiConsentAt !== undefined && Number.isFinite(account.hostedAiConsentAt) && account.hostedAiConsentAt <= now,
    };
  },
});

export const get = action({
  args: input,
  handler: async (ctx, args): Promise<{ suggestions: Suggestion[]; processing: "templates_and_group_history"; readsChat: false }> => {
    const deadlineAt = Date.now() + 2500;
    const prepared = await ctx.runMutation(prepareRef, args);
    const activated = process.env.V0_HOSTED_AI_ENABLED === "true"
      && process.env.V0_HOSTED_AI_PROVIDER === "anthropic"
      && !!process.env.V0_HOSTED_AI_CONFIG_VERSION;
    if (args.useHostedAi && prepared.hostedAiConsented && activated) {
      try {
        unavailableHostedAiAdapter(deadlineAt);
      } catch (error) {
        if (!(error instanceof ConvexError) || typeof error.data !== "object" || error.data === null || !("code" in error.data) || error.data.code !== "PROVIDER_UNAVAILABLE") throw error;
      }
    }
    return { suggestions: prepared.suggestions, processing: "templates_and_group_history", readsChat: false };
  },
});
