import { ConvexError } from "convex/values";
import type { BetFormat } from "./v0Contract";

export type Candidate = {
  question: string;
  format: BetFormat;
  options: [string, string];
  line?: number;
};

export type CandidatePolicy = {
  blockedTopics: readonly string[];
  contextLine?: unknown;
};

const unsafeTopics = [
  /\b(health|medical|medication|medicine|diagnos\w*|disease\w*|illness\w*|sick\w*|symptom\w*|cancer|diabet\w*|hospital\w*|surgery|injur\w*|disab\w*|pregnan\w*|fertility|miscarriage|abortion|periods?|menstrua\w*)\b/,
  /\b(mental|depress\w*|antidepress\w*|anxiet\w*|anxious|panic|trauma\w*|suicid\w*|self\s*harm|overdos\w*|therapy|therapist|adhd|ocd|autis\w*|bipolar|addict\w*|rehab|sober|sobriety|alcohol\w*|drunk\w*|hangover|drugs?|cocaine|opioid\w*|nicotine|cigarette\w*|vap\w*)\b/,
  /\b(weight|weigh\w*|diet\w*|calori\w*|bmi|obes\w*|fat|skinny|thin|pounds?|lbs|kilograms?|body|bodies|appearance|looks?|ugly|prett\w*|beaut\w*|attractiv\w*|hot|hotter|hottest|handsome|cute|acne|bald\w*|hair\w*|skin|cosmetic\w*|plastic\s+surgery|eating\s+disorder\w*)\b/,
  /\b(money|financ\w*|debt\w*|broke|bankrupt\w*|poverty|poor|rent|evict\w*|foreclos\w*|unemploy\w*|laid\s+off|fired|salary|pay\w*|afford\w*|borrow\w*|loans?|owes?|owed|repay\w*|credit\w*|bills?|gambl\w*|wager\w*)\b/,
  /\b(relationship\w*|romance|romantic|dating|dates?|boyfriend|girlfriend|partner|spouse|husband|wife|wives|marriage|married|divorc\w*|break\s*up\w*|dumped|cheat\w*|affair\w*|heartbreak\w*|rejection|crush|ghost\w*|ex|exes|hook\s*up\w*|sleep\s+with|sex\w*|virgin\w*|nude\w*|porn\w*|erect\w*|genital\w*)\b/,
  /\b(abuse\w*|assault\w*|violen\w*|kill\w*|murder\w*|weapon\w*|threat\w*|harass\w*|bully\w*|humiliat\w*|sham\w*|worthless|stupid|idiot|loser|hate\w*|slur\w*|racis\w*|racist|homophob\w*|transphob\w*|nigg\w*|fagg\w*|retard\w*|bitch\w*|cunt\w*|fuck\w*|shit\w*|dox\w*|stalk\w*)\b/,
  /\b(religio\w*|race|racial|ethnic\w*|immigra\w*|citizenship|politic\w*|gay|lesbian|bisexual|transgender|closet\w*|outing|bereave\w*|grief|grieving|funeral|death|dead|die|died|arrest\w*|prison|jail|criminal\w*)\b/,
  /\b(chat\s*(logs?|history|export)|messages?\s+(show|prove|say)|according\s+to\s+(the\s+)?(chat|messages?|photos?)|evidence\s+(shows?|proves?))\b/,
];

function reject(): never {
  throw new ConvexError({ code: "INVALID_INPUT", message: "Choose a different, lighthearted topic and two short choices." });
}

function text(value: unknown, limit: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > limit * 2) reject();
  const normalized = value.normalize("NFKC");
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized)) reject();
  const result = normalized.trim().replace(/\s+/gu, " ");
  if ((!allowEmpty && !result) || result.length > limit) reject();
  return result;
}

function searchable(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function validateCandidate(candidate: unknown, { blockedTopics, contextLine }: CandidatePolicy): Candidate {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) reject();
  const input = candidate as Record<string, unknown>;
  const question = text(input.question, 180);
  if (!searchable(question)) reject();
  const format = input.format;
  if (format !== "yes_no" && format !== "over_under" && format !== "this_that") reject();
  if (!Array.isArray(input.options) || input.options.length !== 2) reject();
  const options: [string, string] = [text(input.options[0], 60), text(input.options[1], 60)];
  if (searchable(options[0]) === searchable(options[1]) || options.some((option) => !searchable(option))) reject();
  if (format === "over_under") {
    if (typeof input.line !== "number" || !Number.isFinite(input.line)) reject();
  } else if (input.line !== undefined) reject();
  const context = contextLine === undefined ? "" : text(contextLine, 280, true);
  if (!Array.isArray(blockedTopics) || blockedTopics.length > 64) reject();
  const topics = blockedTopics.map((topic) => searchable(text(topic, 80)));
  if (topics.some((topic) => !topic)) reject();
  const content = [question, ...options, context].map(searchable).join(" ");
  if (unsafeTopics.some((pattern) => pattern.test(content))) reject();
  if (topics.some((topic) => content.includes(topic))) reject();
  if (/[<>]|https?:\/\/|www\.|\b\S+@\S+\.\S+|(?:\+?\d[\s().-]*){8,}/iu.test([question, ...options, context].join(" "))) reject();
  return format === "over_under"
    ? { question, format, options, line: input.line as number }
    : { question, format, options };
}
