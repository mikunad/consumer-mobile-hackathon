import { describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { deniedOrNeutral, noPrivateValues } from "../backend/assertions";
import { fixture, REVEAL, T0, type Fixture } from "../backend/fixture";

const reads = {
  "ext.card": (f: Fixture, token?: string) => f.t.query(api.ext.card, { token, betId: f.bet, now: T0 }),
  "chat.thread": (f: Fixture, token?: string) => f.t.query(api.chat.thread, { token, groupId: f.g1, now: T0 }),
  "chat.market": (f: Fixture, token?: string) => f.t.query(api.chat.market, { token, betId: f.bet, now: T0 }),
  "market.market": (f: Fixture, token?: string) => f.t.query(api.market.market, { token, betId: f.bet, now: T0 }),
  "market.people": (f: Fixture, token?: string) => f.t.query(api.market.people, { token, betId: f.bet }),
  "game.today": (f: Fixture, token?: string) => f.t.query(api.game.today, { token, now: T0, groupId: f.g1 }),
  "game.leaderboard": (f: Fixture) => f.t.query(api.game.leaderboard, { now: T0, groupId: f.g1 }),
  "reveal.dropResults": (f: Fixture, token?: string) => f.t.query(api.reveal.dropResults, { token, roundId: f.round }),
  "groups.get": (f: Fixture, token?: string) => f.t.query(api.groups.get, { token, groupId: f.g1 }),
  "ext.board": (f: Fixture, token?: string) => f.t.query(api.ext.board, { token: token ?? "synthetic_anonymous", roomId: f.g1 }),
};

describe("SEC1 private room read matrix", () => {
  for (const role of ["anonymous", "outsider", "alias", "revoked", "new", "left"] as const) {
    for (const [name, read] of Object.entries(reads)) {
      it(`[SEC1.read.${name}.${role}] rejects private room content for ${role}`, async () => {
        const f = await fixture(true);
        const token = role === "anonymous" ? undefined : f.actors[role].token;
        await deniedOrNeutral(() => read(f, token), [...f.privateValues, f.g1, f.bet, f.actors.friend.id, "Finn"]);
        const members = await f.t.run((ctx) => ctx.db.query("members").withIndex("by_group", (q) => q.eq("groupId", f.g1)).collect());
        expect(members).toHaveLength(3);
      });
    }
  }

  for (const [name, read] of Object.entries(reads)) {
    it(`[SEC1.subject.${name}] keeps the subject secret across ${name}`, async () => {
      const f = await fixture(true);
      await deniedOrNeutral(() => read(f, f.actors.subject.token), f.privateValues);
    });
  }

  for (const role of ["creator", "friend"] as const) {
    it(`[SEC1.eligible.${role}] gives an eligible member the private question`, async () => {
      const f = await fixture();
      const card = await f.t.query(api.ext.card, { token: f.actors[role].token, betId: f.bet, now: T0 });
      expect(card).toMatchObject({ access: "open", question: f.secret, options: f.options, room: { _id: f.g1 } });
    });
  }

  it("[SEC1.no-enrollment] never enrolls an outsider when a card is opened", async () => {
    const f = await fixture();
    await f.t.query(api.ext.card, { token: f.actors.outsider.token, betId: f.bet, now: REVEAL });
    const member = await f.t.run((ctx) => ctx.db.query("members").withIndex("by_group_user", (q) => q.eq("groupId", f.g1).eq("userId", f.actors.outsider.id)).unique());
    expect(member).toBeNull();
  });

  it("[SEC3.locked-fields] returns only allowlisted fields to a sealed viewer", async () => {
    const f = await fixture(true);
    const card = await f.t.query(api.ext.card, { token: f.actors.subject.token, betId: f.bet, now: T0 });
    expect(card.access).toBe("sealed");
    expect(Object.keys(card).sort()).toEqual(["access", "bettors", "friends", "revealAt", "room", "subject", "total", "who"].sort());
    noPrivateValues(card, f.privateValues);
  });

  it("[J5.1.future-clock] ignores a future client clock before reveal", async () => {
    const f = await fixture();
    const card = await f.t.query(api.ext.card, { token: f.actors.subject.token, betId: f.bet, now: REVEAL + 86_400_000 });
    expect(card.access).toBe("sealed");
    noPrivateValues(card, f.privateValues);
  });

  it("[J5.1.stale-clock] reveals by server time even when the client clock is stale", async () => {
    const f = await fixture();
    vi.setSystemTime(REVEAL);
    const card = await f.t.query(api.ext.card, { token: f.actors.subject.token, betId: f.bet, now: T0 - 86_400_000 });
    expect(card).toMatchObject({ access: "open", question: f.secret, revealed: true });
  });

  it("[SEC1.rename-alias] does not admit a display-name alias", async () => {
    const f = await fixture();
    await deniedOrNeutral(() => f.t.query(api.ext.card, { token: f.actors.alias.token, betId: f.bet, now: T0 }), [...f.privateValues, f.g1]);
  });

  it("[SEC1.revoked-session] invalidates an actually issued then removed session", async () => {
    const f = await fixture();
    const token = `synthetic_${f.runId}_issued_then_revoked`;
    const id = await f.t.run((ctx) => ctx.db.insert("sessions", { userId: f.actors.friend.id, token, device: f.runId }));
    expect(await f.t.query(api.ext.card, { token, betId: f.bet, now: T0 })).toMatchObject({ access: "open", question: f.secret });
    await f.t.run((ctx) => ctx.db.delete(id));
    expect(await f.t.query(api.ext.card, { token, betId: f.bet, now: T0 })).toEqual({ access: "none" });
  });
});
