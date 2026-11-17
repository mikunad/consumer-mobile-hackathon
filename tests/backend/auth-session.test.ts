import { describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { hash, phoneHash } from "../../convex/v0Policy";
import { queueNotification } from "../../convex/v0Notifications";
import { expectCode } from "./auth-support/errors";
import { fakeOtp, syntheticCode, syntheticOtherPhone, syntheticPhone, syntheticVerificationSid } from "./fake-otp";
import { v0Fixture } from "./v0-fixture";

const minute = 60_000;
const start = (f: Awaited<ReturnType<typeof v0Fixture>>, requestId = "auth-start", phone = syntheticPhone) => f.t.action(api.v0Auth.requestCode, { phone, requestId });
const verify = (f: Awaited<ReturnType<typeof v0Fixture>>, requestId = "auth-start", overrides: Partial<{ phone: string; code: string; deviceId: string }> = {}) => f.t.action(api.v0Auth.verifyCode, { phone: syntheticPhone, code: syntheticCode, deviceId: "synthetic-new-device", requestId, ...overrides });

describe("actual V0 verified phone actions", () => {
  for (const [name, input] of [
    ["phone", { phone: "2025550190", requestId: "invalid" }],
    ["empty-request", { phone: syntheticPhone, requestId: "" }],
    ["long-request", { phone: syntheticPhone, requestId: "x".repeat(129) }],
  ] as const) {
    it(`[SEC5.otp-invalid-start-${name}] validates input before reserving or sending a challenge`, async () => {
      const provider = fakeOtp();
      const f = await v0Fixture();
      await expectCode(f.t.action(api.v0Auth.requestCode, input), "INVALID_INPUT");
      expect(provider.fetch).not.toHaveBeenCalled();
      expect(await f.t.run((ctx) => ctx.db.query("v0OtpAttempts").collect())).toEqual([]);
    });
  }

  for (const [name, input] of [["nonnumeric-code", { code: "abcdef" }], ["short-code", { code: "123" }], ["long-code", { code: "1".repeat(11) }], ["empty-device", { deviceId: " " }], ["long-device", { deviceId: "x".repeat(129) }]] as const) {
    it(`[SEC5.otp-invalid-check-${name}] rejects malformed verification without consuming provider quota`, async () => {
      const provider = fakeOtp();
      const f = await v0Fixture();
      await start(f);
      await expectCode(verify(f, "auth-start", input), "INVALID_INPUT");
      expect(provider.fetch).toHaveBeenCalledTimes(1);
      expect(await f.t.run((ctx) => ctx.db.query("v0OtpAttempts").unique())).toMatchObject({ attempts: 0 });
    });
  }

  it("[SEC2.otp-provider-disabled] refuses unconfigured sign-in without reserving an attempt or using transport", async () => {
    const f = await v0Fixture();
    await expectCode(start(f), "PROVIDER_UNAVAILABLE");
    expect(await f.t.run((ctx) => ctx.db.query("v0OtpAttempts").collect())).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("[SEC2.otp-start-idempotency] reserves a ten-minute hashed challenge and sends once per request", async () => {
    const provider = fakeOtp();
    const f = await v0Fixture();
    const now = Date.now();
    const first = await start(f);
    expect(first).toEqual({ requestId: "auth-start", expiresAt: now + 10 * minute });
    expect(await start(f)).toEqual(first);
    await expectCode(start(f, "auth-start", syntheticOtherPhone), "IDEMPOTENCY_CONFLICT");
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(provider.calls[0].body)).toEqual({ To: syntheticPhone, Channel: "sms", RiskCheck: "enable" });
    expect(provider.calls[0].redirect).toBe("error");
    expect(provider.calls[0].authorization?.startsWith("Basic ")).toBe(true);
    const attempts = await f.t.run((ctx) => ctx.db.query("v0OtpAttempts").collect());
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ phoneHash: await phoneHash(syntheticPhone), attempts: 0, providerId: syntheticVerificationSid });
    expect(JSON.stringify(attempts)).not.toContain(syntheticPhone);
    expect(JSON.stringify(attempts)).not.toContain(syntheticCode);
  });

  it("[SEC2.otp-wrong-code][SEC5.otp-check-quota] persists five failed checks and blocks a sixth before the provider", async () => {
    const provider = fakeOtp();
    const f = await v0Fixture();
    await start(f);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await expectCode(verify(f, "auth-start", { code: "111111" }), "INVALID_INPUT");
      expect(await f.t.run((ctx) => ctx.db.query("v0OtpAttempts").unique())).toMatchObject({ attempts: attempt });
    }
    await expectCode(verify(f), "RATE_LIMITED");
    expect(provider.fetch).toHaveBeenCalledTimes(6);
    const state = await f.t.run(async (ctx) => ({ sessions: await ctx.db.query("v0Sessions").collect(), limits: await ctx.db.query("v0RateLimits").collect() }));
    const digest = await phoneHash(syntheticPhone);
    expect(state.sessions).toHaveLength(10);
    expect(state.limits.find((row) => row.key === "otp:check:global")?.count).toBe(5);
    expect(state.limits.find((row) => row.key === `otp:check:phone:${digest}`)?.count).toBe(5);
  });

  it("[SEC2.otp-expiry] rejects the exact expiry boundary and a challenge for another phone before provider verification", async () => {
    const provider = fakeOtp();
    const f = await v0Fixture();
    const requested = await start(f);
    await expectCode(verify(f, "auth-start", { phone: syntheticOtherPhone }), "INVALID_INPUT");
    vi.setSystemTime(requested.expiresAt);
    await expectCode(verify(f), "INVALID_INPUT");
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(await f.t.run((ctx) => ctx.db.query("v0OtpAttempts").unique())).toMatchObject({ attempts: 0 });
  });

  it("[SEC2.otp-replay] consumes related provider challenges once, stores only a token hash, and rejects replay", async () => {
    const provider = fakeOtp();
    const f = await v0Fixture();
    await start(f, "first");
    vi.setSystemTime(Date.now() + 30_000);
    await start(f, "second");
    const session = await verify(f, "first");
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);
    const stored = await f.t.run(async (ctx) => ({ attempts: await ctx.db.query("v0OtpAttempts").collect(), sessions: await ctx.db.query("v0Sessions").withIndex("by_account", (q) => q.eq("accountId", session.account.id)).collect() }));
    expect(stored.sessions).toHaveLength(1);
    expect(session.expiresAt - stored.sessions[0].createdAt).toBe(30 * 24 * 60 * minute);
    expect(stored.attempts.every((row) => row.consumedAt === stored.sessions[0].createdAt)).toBe(true);
    expect(stored.sessions[0].tokenHash).toBe(await hash(session.token));
    expect(JSON.stringify(stored)).not.toContain(session.token);
    await expectCode(verify(f, "first"), "CONFLICT");
    await expectCode(verify(f, "second"), "CONFLICT");
    expect(provider.fetch).toHaveBeenCalledTimes(3);
  });

  it("[SEC2.otp-expiry-during-provider] rechecks expiry after an approved provider response arrives late", async () => {
    const provider = fakeOtp();
    const f = await v0Fixture();
    const requested = await start(f);
    provider.fetch.mockImplementationOnce(async () => {
      vi.setSystemTime(requested.expiresAt);
      return new Response(JSON.stringify(provider.body()), { status: 200 });
    });
    await expectCode(verify(f), "INVALID_INPUT");
    const state = await f.t.run(async (ctx) => ({ attempt: await ctx.db.query("v0OtpAttempts").unique(), sessions: await ctx.db.query("v0Sessions").collect() }));
    expect(state.attempt).toMatchObject({ attempts: 1 });
    expect(state.attempt!.consumedAt).toBeUndefined();
    expect(state.sessions).toHaveLength(10);
  });

  for (const kind of ["start", "check"] as const) {
    it(`[SEC5.otp-global-${kind}-bound] rejects an exhausted global budget before calling the provider`, async () => {
      const provider = fakeOtp();
      const f = await v0Fixture();
      if (kind === "check") await start(f);
      await f.t.run((ctx) => ctx.db.insert("v0RateLimits", { key: `otp:${kind}:global`, windowStart: Date.now(), count: kind === "start" ? 1000 : 5000 }));
      await expectCode(kind === "start" ? start(f) : verify(f), "RATE_LIMITED");
      expect(provider.fetch).toHaveBeenCalledTimes(kind === "start" ? 0 : 1);
      const attempts = await f.t.run((ctx) => ctx.db.query("v0OtpAttempts").collect());
      expect(attempts).toHaveLength(kind === "start" ? 0 : 1);
      if (kind === "check") expect(attempts[0].attempts).toBe(0);
    });
  }

  it("[SEC5.otp-start-bounds] persists failed provider starts, enforces cooldown and five starts per hour", async () => {
    const provider = fakeOtp();
    const f = await v0Fixture();
    provider.reply({ outage: true });
    await expectCode(start(f, "outage-0"), "PROVIDER_UNAVAILABLE");
    await expectCode(start(f, "too-soon"), "RATE_LIMITED");
    await expectCode(start(f, "outage-0"), "CONFLICT");
    for (let i = 1; i < 5; i++) {
      vi.setSystemTime(Date.now() + 30_000);
      provider.reply({ status: 503 });
      await expectCode(start(f, `outage-${i}`), "PROVIDER_UNAVAILABLE");
    }
    vi.setSystemTime(Date.now() + 30_000);
    await expectCode(start(f, "sixth"), "RATE_LIMITED");
    expect(provider.fetch).toHaveBeenCalledTimes(5);
    expect(await f.t.run((ctx) => ctx.db.query("v0OtpAttempts").collect())).toHaveLength(5);
    const digest = await phoneHash(syntheticPhone);
    expect(await f.t.run((ctx) => ctx.db.query("v0RateLimits").withIndex("by_key", (q) => q.eq("key", `otp:start:phone:${digest}`)).unique())).toMatchObject({ count: 5 });
    vi.setSystemTime(Date.now() + 60 * minute);
    expect(await start(f, "new-hour")).toMatchObject({ requestId: "new-hour" });
  });

  it("[SEC5.otp-phone-check-bounds] carries failed checks across fresh challenges and blocks the eleventh check", async () => {
    const provider = fakeOtp();
    const f = await v0Fixture();
    for (let challenge = 0; challenge < 3; challenge++) {
      if (challenge) vi.setSystemTime(Date.now() + 30_000);
      const request = `challenge-${challenge}`;
      await start(f, request);
      if (challenge === 2) {
        await expectCode(verify(f, request), "RATE_LIMITED");
      } else {
        for (let i = 0; i < 5; i++) await expectCode(verify(f, request, { code: "000000" }), "INVALID_INPUT");
      }
    }
    expect(provider.calls.filter((call) => call.path === "VerificationCheck")).toHaveLength(10);
    expect((await f.t.run((ctx) => ctx.db.query("v0OtpAttempts").collect())).map((row) => row.attempts)).toEqual([5, 5, 0]);
  });

  for (const phase of ["start", "check"] as const) {
    for (const [name, overrides] of [
      ["account", { account_sid: `AC${"e".repeat(32)}` }],
      ["service", { service_sid: `VA${"e".repeat(32)}` }],
      ["channel", { channel: "call" }],
      ["recipient", { to: syntheticOtherPhone }],
      ["malformed-sid", { sid: "not-a-provider-id" }],
      ...(phase === "check" ? [["challenge", { sid: `VE${"e".repeat(32)}` }]] as const : [["status", { status: "approved" }]] as const),
    ] as const) {
      it(`[SEC2.otp-${phase}-mismatch-${name}] fails closed on a mismatched provider response`, async () => {
        const provider = fakeOtp();
        const f = await v0Fixture();
        if (phase === "check") await start(f);
        provider.reply({ body: provider.body({ status: phase === "start" ? "pending" : "approved", ...overrides }) });
        await expectCode(phase === "start" ? start(f) : verify(f), "PROVIDER_UNAVAILABLE");
        const state = await f.t.run(async (ctx) => ({ attempts: await ctx.db.query("v0OtpAttempts").collect(), sessions: await ctx.db.query("v0Sessions").collect() }));
        expect(state.attempts).toHaveLength(1);
        expect(state.attempts[0].attempts).toBe(phase === "check" ? 1 : 0);
        expect(state.attempts[0].consumedAt).toBeUndefined();
        expect(state.sessions).toHaveLength(10);
      });
    }
  }

  for (const [name, reply, code] of [
    ["network", { outage: true }, "PROVIDER_UNAVAILABLE"],
    ["malformed-json", { raw: "{" }, "PROVIDER_UNAVAILABLE"],
    ["null-json", { body: null }, "PROVIDER_UNAVAILABLE"],
    ["not-found", { status: 404 }, "INVALID_INPUT"],
    ["provider-throttle", { status: 429 }, "RATE_LIMITED"],
    ["provider-outage", { status: 503 }, "PROVIDER_UNAVAILABLE"],
  ] as const) {
    it(`[SEC2.otp-check-${name}] returns a safe coded error and durably consumes one check`, async () => {
      const provider = fakeOtp();
      const f = await v0Fixture();
      await start(f);
      provider.reply(reply);
      await expectCode(verify(f), code);
      expect(await f.t.run((ctx) => ctx.db.query("v0OtpAttempts").unique())).toMatchObject({ attempts: 1 });
      expect(await f.t.run((ctx) => ctx.db.query("v0Sessions").collect())).toHaveLength(10);
    });
  }

  it("[SEC2.verified-stable-identity] restores the same account on another device without admitting a same-name account", async () => {
    fakeOtp();
    const f = await v0Fixture();
    await start(f, "stable-1", f.actors.subject.phone);
    const first = await verify(f, "stable-1", { phone: f.actors.subject.phone });
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.actors.subject.id, { displayName: "Renamed synthetic identity" });
      await ctx.db.patch(f.actors.unadmittedAlias.id, { displayName: "Renamed synthetic identity" });
    });
    const firstAttempt = await f.t.run((ctx) => ctx.db.query("v0OtpAttempts").unique());
    vi.setSystemTime(firstAttempt!.createdAt + 30_000);
    await start(f, "stable-2", f.actors.alias.phone);
    const second = await verify(f, "stable-2", { phone: f.actors.alias.phone, deviceId: "synthetic-another-device" });
    expect(first.account.id).toBe(f.actors.subject.id);
    expect(second.account.id).toBe(first.account.id);
    expect(second.account.displayName).not.toBe(first.account.displayName);
    expect(second.token).not.toBe(first.token);
    expect((await f.t.query(api.v0Auth.me, { token: second.token })).groups.map((group) => group.id)).toEqual([f.g1]);
    expect((await f.t.query(api.v0Auth.me, { token: f.actors.alias.token })).account.id).toBe(first.account.id);
    const unadmitted = await f.t.query(api.v0Auth.me, { token: f.actors.unadmittedAlias.token });
    expect(unadmitted.account.displayName).toBe(second.account.displayName);
    expect(unadmitted.account.id).not.toBe(second.account.id);
    expect(unadmitted.groups).toEqual([]);
    await expectCode(f.t.query(api.v0Groups.members, { token: f.actors.unadmittedAlias.token, groupId: f.g1 }), "NOT_AVAILABLE");
    const invitation = await f.t.run(async (ctx) => ctx.db.insert("v0Invites", { groupId: f.g1, inviterId: f.actors.creator.id, phoneHash: await phoneHash(f.actors.subject.phone), createdAt: Date.now(), expiresAt: Date.now() + minute }));
    await expectCode(f.t.mutation(api.v0Groups.accept, { token: f.actors.unadmittedAlias.token, inviteId: invitation, requestId: "name-is-not-admission" }), "NOT_AVAILABLE");
    expect(await f.t.run((ctx) => ctx.db.get(invitation))).not.toHaveProperty("acceptedAt");
  });

  for (const kind of ["unknown", "revoked", "expired", "future", "inverted", "deleted"] as const) {
    it(`[SEC2.session-${kind}] rejects an invalid session with AUTH_REQUIRED`, async () => {
      const f = await v0Fixture();
      const actor = f.actors.friend;
      await f.t.run(async (ctx) => {
        if (kind === "revoked") await ctx.db.patch(actor.session, { revokedAt: Date.now() });
        if (kind === "expired") await ctx.db.patch(actor.session, { expiresAt: Date.now() });
        if (kind === "future") await ctx.db.patch(actor.session, { createdAt: Date.now() + minute });
        if (kind === "inverted") await ctx.db.patch(actor.session, { expiresAt: Date.now() - minute, createdAt: Date.now() });
        if (kind === "deleted") await ctx.db.patch(actor.id, { deletedAt: Date.now() });
      });
      await expectCode(f.t.query(api.v0Auth.me, { token: kind === "unknown" ? "synthetic-unknown-token" : actor.token }), "AUTH_REQUIRED");
    });
  }
});

describe("actual V0 pairing action and session invalidation", () => {
  it("[SEC5.pair-malformed-and-global-bound] rejects malformed codes and exhausted global budget without minting a session", async () => {
    const f = await v0Fixture();
    for (const code of ["short", "A".repeat(64), "f".repeat(63)]) await expectCode(f.t.action(api.v0Auth.redeemPair, { code, deviceId: "synthetic-device", requestId: "malformed" }), "INVALID_INPUT");
    expect(await f.t.run((ctx) => ctx.db.query("v0RateLimits").collect())).toEqual([]);
    await f.t.run((ctx) => ctx.db.insert("v0RateLimits", { key: "pair:redeem:global", windowStart: Date.now(), count: 1000 }));
    await expectCode(f.t.action(api.v0Auth.redeemPair, { code: "e".repeat(64), deviceId: "synthetic-device", requestId: "global-bound" }), "RATE_LIMITED");
    expect(await f.t.run((ctx) => ctx.db.query("v0Sessions").collect())).toHaveLength(10);
  });

  it("[SEC2.pair-one-use] stores a hashed pair code and mints one same-account session through redeemPair action", async () => {
    const f = await v0Fixture();
    const pair = await f.t.mutation(api.v0Auth.createPair, { token: f.actors.subject.token, requestId: "pair-create" });
    expect(pair.code).toMatch(/^[a-f0-9]{64}$/);
    expect(pair.expiresAt).toBe(Date.now() + 5 * minute);
    const stored = await f.t.run((ctx) => ctx.db.query("v0Pairs").unique());
    expect(stored).toMatchObject({ codeHash: await hash(pair.code), sessionId: f.actors.subject.session });
    expect(JSON.stringify(stored)).not.toContain(pair.code);
    await expectCode(f.t.mutation(api.v0Auth.createPair, { token: f.actors.subject.token, requestId: "pair-create" }), "CONFLICT");
    const request = { code: pair.code, deviceId: "synthetic-paired-device", requestId: "pair-redeem" };
    const session = await f.t.action(api.v0Auth.redeemPair, request);
    expect(session.account.id).toBe(f.actors.subject.id);
    expect((await f.t.query(api.v0Auth.me, { token: session.token })).groups.map((group) => group.id)).toEqual([f.g1]);
    await expectCode(f.t.action(api.v0Auth.redeemPair, request), "CONFLICT");
    await expectCode(f.t.action(api.v0Auth.redeemPair, { ...request, requestId: "pair-replay" }), "CONFLICT");
    expect(await f.t.run((ctx) => ctx.db.query("v0Sessions").withIndex("by_account", (q) => q.eq("accountId", f.actors.subject.id)).collect())).toHaveLength(3);
  });

  for (const lifetime of [5 * minute, 12_345]) {
    it(`[SEC2.pair-strict-expiry-${lifetime}] caps pairing by its source session and rejects the exact expiry`, async () => {
      const f = await v0Fixture();
      await f.t.run((ctx) => ctx.db.patch(f.actors.friend.session, { expiresAt: Date.now() + lifetime }));
      const pair = await f.t.mutation(api.v0Auth.createPair, { token: f.actors.friend.token, requestId: "expiring-pair" });
      expect(pair.expiresAt).toBe(Date.now() + lifetime);
      vi.setSystemTime(pair.expiresAt);
      await expectCode(f.t.action(api.v0Auth.redeemPair, { code: pair.code, deviceId: "new-device", requestId: "expired" }), "INVALID_INPUT");
      expect(await f.t.run((ctx) => ctx.db.query("v0Pairs").unique())).not.toHaveProperty("consumedAt");
    });
  }

  for (const invalidation of ["revoked", "deleted"] as const) {
    it(`[SEC2.pair-origin-${invalidation}] checks the originating session/account again at action redemption`, async () => {
      const f = await v0Fixture();
      const pair = await f.t.mutation(api.v0Auth.createPair, { token: f.actors.friend.token, requestId: "source-pair" });
      await f.t.run(async (ctx) => {
        if (invalidation === "revoked") await ctx.db.patch(f.actors.friend.session, { revokedAt: Date.now() });
        else await ctx.db.patch(f.actors.friend.id, { deletedAt: Date.now() });
      });
      await expectCode(f.t.action(api.v0Auth.redeemPair, { code: pair.code, deviceId: "new-device", requestId: "invalid-source" }), "AUTH_REQUIRED");
      expect(await f.t.run((ctx) => ctx.db.query("v0RateLimits").withIndex("by_key", (q) => q.eq("key", "pair:redeem:global")).unique())).toMatchObject({ count: 1 });
    });
  }

  it("[SEC5.pair-durable-code-quota] persists ten invalid action redemptions and blocks the eleventh", async () => {
    const f = await v0Fixture();
    const code = "e".repeat(64);
    const request = { code, deviceId: "synthetic-guess-device", requestId: "guess" };
    for (let i = 0; i < 10; i++) await expectCode(f.t.action(api.v0Auth.redeemPair, { ...request, requestId: `guess-${i}` }), "INVALID_INPUT");
    await expectCode(f.t.action(api.v0Auth.redeemPair, { ...request, requestId: "guess-eleven" }), "RATE_LIMITED");
    const codeHash = await hash(code);
    expect(await f.t.run((ctx) => ctx.db.query("v0RateLimits").withIndex("by_key", (q) => q.eq("key", `pair:redeem:code:${codeHash}`)).unique())).toMatchObject({ count: 10 });
    expect(await f.t.run((ctx) => ctx.db.query("v0Sessions").collect())).toHaveLength(10);
  });

  it("[SEC5.pair-device-start-bounds] bounds guesses across codes and pair creation per account", async () => {
    const f = await v0Fixture();
    for (let i = 0; i < 20; i++) await expectCode(f.t.action(api.v0Auth.redeemPair, { code: i.toString(16).padStart(64, "0"), deviceId: "guess-device", requestId: `guess-${i}` }), "INVALID_INPUT");
    await expectCode(f.t.action(api.v0Auth.redeemPair, { code: "f".repeat(64), deviceId: "guess-device", requestId: "guess-21" }), "RATE_LIMITED");
    const deviceHash = await hash("guess-device");
    expect(await f.t.run((ctx) => ctx.db.query("v0RateLimits").withIndex("by_key", (q) => q.eq("key", `pair:redeem:device:${deviceHash}`)).unique())).toMatchObject({ count: 20 });
    for (let i = 0; i < 10; i++) expect((await f.t.mutation(api.v0Auth.createPair, { token: f.actors.friend.token, requestId: `pair-${i}` })).code).toMatch(/^[a-f0-9]{64}$/);
    await expectCode(f.t.mutation(api.v0Auth.createPair, { token: f.actors.friend.token, requestId: "pair-eleven" }), "RATE_LIMITED");
    expect(await f.t.run((ctx) => ctx.db.query("v0Pairs").collect())).toHaveLength(10);
  });

  for (const allDevices of [false, true]) {
    it(`[SEC2.revoke-${allDevices ? "all-devices" : "one-device"}][N3.revoke-${allDevices}] invalidates selected sessions, pairs, push registrations and conversation links`, async () => {
      const f = await v0Fixture();
      for (const [index, actor] of [f.actors.subject, f.actors.alias].entries()) {
        await f.t.mutation(api.v0Notifications.register, { token: actor.token, deviceToken: (index ? "b" : "a").repeat(64), environment: "sandbox", requestId: `push-${index}` });
        await f.t.mutation(api.v0Groups.linkConversation, { token: actor.token, groupId: f.g1, conversationKey: "synthetic-conversation", requestId: `link-${index}` });
        await f.t.mutation(api.v0Auth.createPair, { token: actor.token, requestId: `pair-${index}` });
      }
      const outbox = await f.t.run((ctx) => queueNotification(ctx, { key: "synthetic-revoke-event", kind: "reveal", accountId: f.actors.subject.id, groupId: f.g1, betId: f.bet }));
      expect(outbox).not.toBeNull();
      expect(await f.t.mutation(api.v0Auth.revoke, { token: f.actors.subject.token, allDevices, requestId: "revoke" })).toEqual({ revoked: true });
      await expectCode(f.t.query(api.v0Auth.me, { token: f.actors.subject.token }), "AUTH_REQUIRED");
      if (allDevices) await expectCode(f.t.query(api.v0Auth.me, { token: f.actors.alias.token }), "AUTH_REQUIRED");
      else expect((await f.t.query(api.v0Auth.me, { token: f.actors.alias.token })).account.id).toBe(f.actors.subject.id);
      const state = await f.t.run(async (ctx) => ({ tokens: await ctx.db.query("v0PushTokens").collect(), links: await ctx.db.query("v0ConversationLinks").collect(), pairs: await ctx.db.query("v0Pairs").collect(), item: await ctx.db.get(outbox!) }));
      expect(state.tokens.map((row) => row.deviceId)).toEqual(allDevices ? [] : [f.actors.alias.deviceId]);
      expect(state.links.map((row) => row.deviceId)).toEqual(allDevices ? [] : [f.actors.alias.deviceId]);
      expect(state.pairs.filter((row) => row.consumedAt !== undefined)).toHaveLength(allDevices ? 2 : 1);
      expect(state.item === null).toBe(allDevices);
      await expectCode(f.t.mutation(api.v0Notifications.register, { token: f.actors.subject.token, deviceToken: "c".repeat(64), environment: "sandbox", requestId: "after-revoke" }), "AUTH_REQUIRED");
    });
  }

  it("[SEC2.account-switch][N3.account-switch] explicit sign-out then sign-in never carries the old conversation or push owner", async () => {
    fakeOtp();
    const f = await v0Fixture();
    const old = f.actors.friend;
    const deviceToken = "d".repeat(64);
    await f.t.mutation(api.v0Notifications.register, { token: old.token, deviceToken, environment: "sandbox", requestId: "old-push" });
    await f.t.mutation(api.v0Groups.linkConversation, { token: old.token, groupId: f.g1, conversationKey: "same-local-chat", requestId: "old-link" });
    await f.t.mutation(api.v0Auth.revoke, { token: old.token, allDevices: false, requestId: "sign-out" });
    await start(f, "new-owner");
    const next = await verify(f, "new-owner", { deviceId: old.deviceId });
    expect(next.account.id).not.toBe(old.id);
    expect((await f.t.query(api.v0Auth.me, { token: next.token })).groups).toEqual([]);
    expect(await f.t.query(api.v0Groups.resolveConversation, { token: next.token, conversationKey: "same-local-chat" })).toBeNull();
    await expectCode(f.t.query(api.v0Groups.resolveConversation, { token: old.token, conversationKey: "same-local-chat" }), "AUTH_REQUIRED");
    await f.t.mutation(api.v0Notifications.register, { token: next.token, deviceToken, environment: "sandbox", requestId: "new-push" });
    const registrations = await f.t.run((ctx) => ctx.db.query("v0PushTokens").collect());
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({ accountId: next.account.id, deviceId: old.deviceId });
    expect(await f.t.run((ctx) => ctx.db.query("v0ConversationLinks").collect())).toEqual([]);
  });
});
