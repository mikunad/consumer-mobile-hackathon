import type { Doc } from "./_generated/dataModel";
import type { BetState } from "./v0Contract";

export const approvedPolicy = {
  version: "v0-policy.2",
  economics: "reward_only",
  confidenceMin: 0.01,
  confidenceMax: 1,
  confidencePointScale: 100,
  pickLock: "final_confirmation",
  pickAdmissionEnd: "reveal",
  defaultRevealHour: 20,
  challengeDurationMs: 60 * 60_000,
  unansweredDurationMs: 24 * 60 * 60_000,
} as const;

export function answerDeadlineFor(bet: Doc<"v0Bets">) {
  return bet.revealAt + approvedPolicy.unansweredDurationMs;
}

export function challengeDeadlineFor(bet: Doc<"v0Bets">) {
  if (bet.answeredAt === undefined || !Number.isFinite(bet.answeredAt) || bet.answeredAt > Date.now() || bet.answeredAt < bet.revealAt || bet.answeredAt >= answerDeadlineFor(bet) || ![0, 1].includes(bet.provisionalOutcome ?? -1)) return undefined;
  return bet.answeredAt + approvedPolicy.challengeDurationMs;
}

export function stateAt(bet: Doc<"v0Bets">, now: number): BetState {
  if (bet.state === "voided" || bet.state === "finalized" || bet.state === "provisional") return bet.state;
  if (now >= answerDeadlineFor(bet)) return "voided";
  if (now < bet.revealAt) return "open";
  return "revealed";
}

export function nextDefaultRevealAt(timezone: string, now: number): number | null {
  if (!Number.isFinite(now)) return null;
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const localAsUtc = (time: number) => {
    const parts = formatter.formatToParts(time);
    const part = (name: string) => Number(parts.find((entry) => entry.type === name)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  };
  const local = new Date(localAsUtc(now));
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), approvedPolicy.defaultRevealHour);
  for (let day = 0; day < 3; day++) {
    const target = today + day * 24 * 60 * 60_000;
    let candidate = target;
    for (let attempt = 0; attempt < 4; attempt++) {
      const observed = localAsUtc(candidate);
      if (observed === target && candidate > now) return candidate;
      candidate += target - observed;
    }
  }
  return null;
}
