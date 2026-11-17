"use node";
import { action } from "./v0Legacy";
import { api } from "./_generated/api";
import { v, ConvexError } from "convex/values";

type Draft = { question: string; kind: "yesno" | "overunder"; line?: number };

const SYSTEM = `You write bets for "Called It", a social prediction market played live by a room of friends (today: a YC consumer mobile hackathon in San Francisco).
From the notes or transcript you are given, draft exactly 6 bets that:
- resolve by ~8 PM tonight from something everyone in the room can observe,
- are fun, specific, and never embarrassing, mean, or about sensitive topics,
- use only two formats: "yesno" (a yes/no question) or "overunder" (a numeric question with a line ending in .5, e.g. 3.5),
- are short (under 90 characters) and phrased as a question.
Reply with JSON only: {"bets":[{"question":"...","kind":"yesno"},{"question":"...","kind":"overunder","line":4.5}]}`;

function clean(raw: unknown): Draft[] {
  const list = (raw as { bets?: unknown[] })?.bets ?? [];
  return list
    .map((b) => b as { question?: unknown; kind?: unknown; line?: unknown })
    .filter((b) => typeof b.question === "string" && (b.kind === "yesno" || b.kind === "overunder"))
    .map((b) => {
      if (b.kind === "overunder") {
        const n = Number(b.line);
        const line = Number.isFinite(n) ? Math.floor(n) + 0.5 : 2.5;
        return { question: String(b.question).slice(0, 140), kind: "overunder" as const, line };
      }
      return { question: String(b.question).slice(0, 140), kind: "yesno" as const };
    })
    .slice(0, 6);
}

function parseJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(text.slice(start, end + 1));
}

export const draftBets = action({
  args: { passcode: v.string(), text: v.string() },
  handler: async (_ctx, { passcode, text }): Promise<Draft[]> => {
    if (!process.env.ADMIN_PASSCODE || passcode !== process.env.ADMIN_PASSCODE) throw new ConvexError("Wrong passcode");
    const notes = text.trim().slice(0, 20000);
    if (notes.length < 10) throw new ConvexError("Paste some notes or a transcript first");
    const anthropic = process.env.ANTHROPIC_API_KEY;
    const openai = process.env.OPENAI_API_KEY;
    if (anthropic) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropic, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.AI_MODEL ?? "claude-sonnet-4-5",
          max_tokens: 1200,
          system: SYSTEM,
          messages: [{ role: "user", content: notes }],
        }),
      });
      if (!res.ok) throw new ConvexError("AI request failed (" + res.status + "): " + (await res.text()).slice(0, 200));
      const body = (await res.json()) as { content: { type: string; text?: string }[] };
      return clean(parseJson(body.content.map((c) => c.text ?? "").join("")));
    }
    if (openai) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + openai, "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.AI_MODEL ?? "gpt-4.1-mini",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: notes },
          ],
        }),
      });
      if (!res.ok) throw new ConvexError("AI request failed (" + res.status + "): " + (await res.text()).slice(0, 200));
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      return clean(parseJson(body.choices[0].message.content));
    }
    throw new ConvexError("No AI key set. Add ANTHROPIC_API_KEY or OPENAI_API_KEY in Convex env vars.");
  },
});

const STAGED_CHAT = `[thai thursdays] jill: ok but drunken noodle is a personality
[thai thursdays] febe: you ordered it 9 weeks in a row
[thai thursdays] jill: and i will order it 10
[thai thursdays] mikun: omw (from bed)
[thai thursdays] febe: mikun "omw" means 25 min minimum
[group pics] 6 of 8 group photos from last month: jill is the one taking the selfie
[thai thursdays] jill: i'm doing dry november btw
[thai thursdays] febe: it's november 15th
[thai thursdays] mikun: i have a hackathon demo at 7, if i say "agent" once more somebody stop me
[thai thursdays] jill: you said agent 14 times at dinner last week
[thai thursdays] febe: karaoke saturday? jill picks the song again?
[thai thursdays] jill: it's always mr brightside and it's always perfect`;

type Idea = { subject: string; kind: "yesno" | "overunder" | "multi"; question: string; line?: number; options?: string[]; why: string };

export const suggest = action({
  args: { token: v.string(), groupId: v.id("groups") },
  handler: async (ctx, { token, groupId }): Promise<Idea[]> => {
    const data = await ctx.runQuery(api.chat.thread, { token, groupId, now: Date.now() });
    if (!data) throw new ConvexError("Join this group first");
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new ConvexError("No AI key set");
    const friends = data.members.filter((m) => m._id !== data.me._id).map((m) => m.name);
    if (!friends.length) return [];
    const system = `You draft friendly-roast bets for "Called It", a private friend-group betting game. The user shared a chat export and some photos (below). Draft 6 bets about these friends ONLY: ${friends.join(", ")}. Each bet must resolve by tonight or this week, be playful and never mean, never about bodies, money trouble, health, dating, or anything sensitive. Formats: "yesno", "overunder" (MUST include a numeric "line" field ending in .5, and don't put the number in the question; e.g. question "Minutes @mikun arrives after saying omw", line 22.5), "multi" (exactly two short options). Each needs a one-line "why" that cites the shared material (e.g. "9 messages in 'thai thursdays' mention it"). Phrase questions with @name. Reply with JSON only: {"bets":[{"subject":"jill","kind":"multi","question":"...","options":["A","B"],"why":"..."}]}`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.AI_MODEL ?? "claude-sonnet-4-5", max_tokens: 1500, system, messages: [{ role: "user", content: STAGED_CHAT }] }),
    });
    if (!res.ok) throw new ConvexError("AI request failed (" + res.status + ")");
    const body = (await res.json()) as { content: { text?: string }[] };
    const raw = parseJson(body.content.map((c) => c.text ?? "").join("")) as { bets?: Idea[] };
    return (raw.bets ?? [])
      .filter((b) => typeof b.question === "string" && friends.includes(String(b.subject).replace(/^@/, "").toLowerCase()) && ["yesno", "overunder", "multi"].includes(b.kind))
      .filter((b) => b.kind !== "multi" || (Array.isArray(b.options) && b.options.length === 2))
      .map((b) => ({
        subject: String(b.subject).replace(/^@/, "").toLowerCase(),
        kind: b.kind,
        question: String(b.question).slice(0, 140),
        line: b.kind === "overunder" ? Math.floor(Number(b.line) || Number(String(b.question).match(/(\d+(?:\.\d+)?)/)?.[1]) || 2) + 0.5 : undefined,
        options: b.kind === "multi" ? b.options!.map((o) => String(o).slice(0, 28)) : undefined,
        why: String(b.why ?? "").slice(0, 120),
      }))
      .slice(0, 6);
  },
});
