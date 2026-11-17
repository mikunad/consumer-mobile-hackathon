import { makeFunctionReference } from "convex/server";
import { makePng } from "../fixtures/png.mjs";
import { REVEAL } from "./fixture";
import type { v0Fixture } from "./v0-fixture";

export type V0Fixture = Awaited<ReturnType<typeof v0Fixture>>;
type Kind = "query" | "mutation" | "action";
type Input = (f: V0Fixture, token: string) => Record<string, unknown>;
type Case = { kind: Kind; args: Input };
const request = (f: V0Fixture) => `${f.runId}_request`;
export const pngBytes = () => makePng();

export const contractCases: Record<string, Case> = {
  "v0Auth:requestCode": { kind: "action", args: (f) => ({ phone: f.actors.friend.phone, requestId: request(f) }) },
  "v0Auth:verifyCode": { kind: "action", args: (f) => ({ phone: f.actors.friend.phone, code: "123456", deviceId: f.runId, requestId: request(f) }) },
  "v0Auth:redeemPair": { kind: "action", args: (f) => ({ code: "a".repeat(64), deviceId: f.runId, requestId: request(f) }) },
  "v0Auth:me": { kind: "query", args: (_f, token) => ({ token }) },
  "v0Auth:revoke": { kind: "mutation", args: (f, token) => ({ token, allDevices: true, requestId: request(f) }) },
  "v0Auth:createPair": { kind: "mutation", args: (f, token) => ({ token, requestId: request(f) }) },
  "v0Groups:create": { kind: "mutation", args: (f, token) => ({ token, name: `QA ${f.runId}`, timezone: "America/Los_Angeles", requestId: request(f) }) },
  "v0Groups:invite": { kind: "mutation", args: (f, token) => ({ token, groupId: f.g1, phone: f.actors.outsider.phone, requestId: request(f) }) },
  "v0Groups:invitations": { kind: "query", args: (_f, token) => ({ token }) },
  "v0Groups:accept": { kind: "mutation", args: (f, token) => ({ token, inviteId: f.invite, requestId: request(f) }) },
  "v0Groups:members": { kind: "query", args: (f, token) => ({ token, groupId: f.g1 }) },
  "v0Groups:linkConversation": { kind: "mutation", args: (f, token) => ({ token, groupId: f.g1, conversationKey: `${f.runId}_conversation`, requestId: request(f) }) },
  "v0Groups:resolveConversation": { kind: "query", args: (f, token) => ({ token, conversationKey: `${f.runId}_conversation` }) },
  "v0Groups:unlinkConversation": { kind: "mutation", args: (f, token) => ({ token, conversationKey: `${f.runId}_conversation`, requestId: request(f) }) },
  "v0Groups:turn": { kind: "query", args: (f, token) => ({ token, groupId: f.g1 }) },
  "v0Groups:passTurn": { kind: "mutation", args: (f, token) => ({ token, groupId: f.g1, requestId: request(f) }) },
  "v0Groups:recap": { kind: "query", args: (f, token) => ({ token, groupId: f.g1 }) },
  "v0Groups:board": { kind: "query", args: (f, token) => ({ token, groupId: f.g1 }) },
  "v0Groups:proposeGoal": { kind: "mutation", args: (f, token) => ({ token, groupId: f.g1, label: "Shared puzzle night", targetPoints: 100, requestId: request(f) }) },
  "v0Groups:confirmGoal": { kind: "mutation", args: (f, token) => ({ token, groupId: f.g1, requestId: request(f) }) },
  "v0Bets:get": { kind: "query", args: (f, token) => ({ token, locator: f.locator }) },
  "v0Bets:list": { kind: "query", args: (f, token) => ({ token, groupId: f.g1 }) },
  "v0Bets:history": { kind: "query", args: (f, token) => ({ token, groupId: f.g1 }) },
  "v0Bets:create": { kind: "mutation", args: (f, token) => ({ token, groupId: f.g1, subjectId: f.actors.subject.id, question: "Will Sage suggest a picnic game before reveal?", contextLine: "A synthetic picnic", format: "yes_no", options: ["Yes", "No"], cutoffAt: REVEAL, revealAt: REVEAL, source: "manual", requestId: request(f) }) },
  "v0Bets:pick": { kind: "mutation", args: (f, token) => ({ token, betId: f.bet, option: 0, confidence: 0.5, requestId: request(f) }) },
  "v0Bets:veto": { kind: "mutation", args: (f, token) => ({ token, betId: f.bet, requestId: request(f) }) },
  "v0Bets:answer": { kind: "mutation", args: (f, token) => ({ token, betId: f.bet, option: 0, requestId: request(f) }) },
  "v0Bets:challenge": { kind: "mutation", args: (f, token) => ({ token, betId: f.bet, requestId: request(f) }) },
  "v0Proof:upload": { kind: "action", args: (f, token) => ({ token, betId: f.bet, contentType: "image/png", bytes: pngBytes(), requestId: request(f) }) },
  "v0Proof:list": { kind: "query", args: (f, token) => ({ token, betId: f.bet }) },
  "v0Proof:read": { kind: "action", args: (f, token) => ({ token, proofId: f.proof }) },
  "v0Controls:get": { kind: "query", args: (_f, token) => ({ token }) },
  "v0Controls:update": { kind: "mutation", args: (f, token) => ({ token, noBets: false, blockedTopics: ["synthetic topic"], hostedAiConsent: false, requestId: request(f) }) },
  "v0Controls:alias": { kind: "mutation", args: (f, token) => ({ token, groupId: f.g1, alias: "QA friend", requestId: request(f) }) },
  "v0Controls:leave": { kind: "mutation", args: (f, token) => ({ token, groupId: f.g1, requestId: request(f) }) },
  "v0Controls:deleteAccount": { kind: "mutation", args: (f, token) => ({ token, requestId: request(f) }) },
  "v0Controls:report": { kind: "mutation", args: (f, token) => ({ token, groupId: f.g1, betId: f.bet, reason: "Synthetic QA report", requestId: request(f) }) },
  "v0Controls:block": { kind: "mutation", args: (f, token) => ({ token, accountId: f.actors.subject.id, requestId: request(f) }) },
  "v0Suggestions:get": { kind: "action", args: (f, token) => ({ token, groupId: f.g1, subjectId: f.actors.subject.id, contextLine: "A synthetic picnic", useHostedAi: false }) },
  "v0Notifications:register": { kind: "mutation", args: (f, token) => ({ token, deviceToken: "ab".repeat(32), environment: "sandbox", requestId: request(f) }) },
  "v0Notifications:unregister": { kind: "mutation", args: (f, token) => ({ token, requestId: request(f) }) },
  "v0Notifications:preferences": { kind: "query", args: (_f, token) => ({ token }) },
  "v0Notifications:setPreferences": { kind: "mutation", args: (f, token) => ({ token, enabled: false, requestId: request(f) }) },
};

export async function invoke(f: V0Fixture, path: string, token: string, overrides: Record<string, unknown> = {}) {
  const entry = contractCases[path];
  if (!entry) throw new Error(`No reviewed valid fixture for ${path}`);
  const args = { ...entry.args(f, token), ...overrides };
  if (entry.kind === "query") return await f.t.query(makeFunctionReference<"query">(path), args);
  if (entry.kind === "mutation") return await f.t.mutation(makeFunctionReference<"mutation">(path), args);
  return await f.t.action(makeFunctionReference<"action">(path), args);
}
