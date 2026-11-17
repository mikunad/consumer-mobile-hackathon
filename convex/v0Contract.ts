import type { Id } from "./_generated/dataModel";
import type { approvedPolicy } from "./v0GamePolicy";

export type Account = { id: Id<"v0Accounts">; displayName: string };
export type Session = { token: string; expiresAt: number; account: Account };
export type BetFormat = "yes_no" | "over_under" | "this_that";
export type BetState = "open" | "locked" | "revealed" | "provisional" | "finalized" | "voided";
export type GroupSummary = { id: Id<"v0Groups">; name: string; timezone: string; alias: string; points: number; streak: number };
export type CardLocator = { url: string; caption: string; accessibilityLabel: string; subjectAlias: string; bettorCount: number; bettorInitials: string[] };
export type Goal = { id: Id<"v0Goals">; label: string; targetPoints: number; confirmedBy: Id<"v0Accounts">[]; state: "proposed" | "confirmed"; progressPoints: number };
export type BetView = {
  serverTime: number;
  groupId: Id<"v0Groups">;
  betId: Id<"v0Bets">;
  state: BetState;
  cutoffAt: number;
  revealAt: number;
  card: CardLocator;
} & (
  | { view: "sealed"; canVeto: boolean }
  | { view: "unavailable" }
  | { view: "bet"; question: string; format: BetFormat; options: string[]; line?: number; canPick: boolean; canAnswer: boolean; canChallenge: boolean; answerDeadline?: number; challengeDeadline?: number; outcome?: number; provisionalOutcome?: number; myPick: { option: number; confidence: number; riskPoints?: number } | null; picks: { accountId: Id<"v0Accounts">; alias: string; option: number; confidence: number; riskPoints?: number }[] }
);
export type Suggestion = { subjectId: Id<"v0Accounts">; question: string; format: BetFormat; options: string[]; line?: number; source: "template" | "history" | "hosted_ai" };
export type ProofRef = { id: Id<"v0Proofs">; contentType: "image/jpeg" | "image/png" | "audio/mp4"; createdAt: number };
export type PrivateProof = ProofRef & { bytes: ArrayBuffer };
export type Turn = { id: Id<"v0Turns">; groupId: Id<"v0Groups">; localDate: string; creatorId: Id<"v0Accounts">; subjectId: Id<"v0Accounts">; status: "assigned" | "passed" | "created" | "expired"; assignedAt: number; passAt: number; canPass: boolean };
export type Recap = { id: Id<"v0Recaps">; groupId: Id<"v0Groups">; startsAt: number; endsAt: number; rows: { accountId: Id<"v0Accounts">; alias: string; points: number }[]; policy: PolicyStatus };
export type NotificationPreferences = { enabled: boolean };
export type NotificationTap = { kind: "turn" | "reveal" | "result" | "recap"; groupId?: Id<"v0Groups">; locator?: string };
export type PolicyStatus = { status: "pending"; version: string; approved: typeof approvedPolicy; missing: string[] } | { status: "approved"; version: string };
export const contractVersion = "v0.2";
