import { verify as verifySignature } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { classifyApnsResponse, sendApnsRequest } from "../../convex/v0Apns";
import { queueNotification, type NotificationInput } from "../../convex/v0Notifications";
import { fakeApns } from "./auth-support/apns";
import { expectCode } from "./auth-support/errors";
import { v0Fixture } from "./v0-fixture";

vi.mock("node:http2", async () => ({ connect: (await import("./auth-support/apns")).syntheticConnect }));

type Fixture = Awaited<ReturnType<typeof v0Fixture>>;
const pushToken = "a".repeat(64);
const register = (f: Fixture, token = f.actors.friend.token, deviceToken = pushToken, requestId = "register", environment: "sandbox" | "production" = "sandbox") => f.t.mutation(api.v0Notifications.register, { token, deviceToken, environment, requestId });
const enqueue = (f: Fixture, overrides: Partial<NotificationInput> = {}) => f.t.run((ctx) => queueNotification(ctx, { key: "synthetic-notification", accountId: f.actors.friend.id, groupId: f.g1, betId: f.bet, kind: "reveal", ...overrides }));

async function claimDevice(f: Fixture) {
  await register(f);
  const id = await enqueue(f);
  expect(id).not.toBeNull();
  const leases = await f.t.mutation(internal.v0Notifications.claimBatch, {});
  expect(leases).toHaveLength(1);
  const lease = leases[0];
  const plan = await f.t.query(internal.v0Notifications.deliveryPlan, { ...lease, environment: "sandbox" });
  expect(plan).toHaveLength(1);
  return { id: id!, lease, input: { ...lease, ...plan[0], environment: "sandbox" as const } };
}

describe("actual V0 notification registration and suppression", () => {
  it("[N3.registration-unique] normalizes tokens, deduplicates requests/devices and transfers a token to its current owner", async () => {
    const f = await v0Fixture();
    expect(await register(f, f.actors.subject.token, pushToken.toUpperCase(), "subject-push")).toEqual({ registered: true });
    expect(await register(f, f.actors.subject.token, pushToken, "subject-push")).toEqual({ registered: true });
    const first = await f.t.run((ctx) => ctx.db.query("v0PushTokens").unique());
    expect(first).toMatchObject({ token: pushToken, accountId: f.actors.subject.id, deviceId: f.actors.subject.deviceId });
    await expectCode(register(f, f.actors.subject.token, "b".repeat(64), "subject-push"), "IDEMPOTENCY_CONFLICT");
    await register(f, f.actors.subject.token, "b".repeat(64), "rotate");
    const rotated = await f.t.run((ctx) => ctx.db.query("v0PushTokens").unique());
    expect(rotated!._id).toBe(first!._id);
    expect(rotated!.updatedAt).toBeGreaterThan(first!.updatedAt);
    await register(f, f.actors.alias.token, "b".repeat(64), "same-token-new-device");
    expect(await f.t.run((ctx) => ctx.db.query("v0PushTokens").unique())).toMatchObject({ accountId: f.actors.subject.id, deviceId: f.actors.alias.deviceId });
    await register(f, f.actors.outsider.token, "b".repeat(64), "new-owner");
    expect(await f.t.run((ctx) => ctx.db.query("v0PushTokens").unique())).toMatchObject({ accountId: f.actors.outsider.id, deviceId: f.actors.outsider.deviceId });
    await register(f, f.actors.subject.token, "b".repeat(64), "separate-environment", "production");
    expect(await f.t.run((ctx) => ctx.db.query("v0PushTokens").collect())).toHaveLength(2);
  });

  for (const [name, token] of [["short", "ab"], ["odd", "a".repeat(33)], ["nonhex", "g".repeat(64)], ["long", "a".repeat(514)], ["whitespace", ` ${pushToken}`]] as const) {
    it(`[N3.registration-invalid-${name}] rejects malformed device tokens without writing registrations`, async () => {
      const f = await v0Fixture();
      await expectCode(register(f, f.actors.friend.token, token), "INVALID_INPUT");
      expect(await f.t.run((ctx) => ctx.db.query("v0PushTokens").collect())).toEqual([]);
    });
  }

  it("[N3.registration-device-limit] enforces the current 32-device bound without deleting existing registrations", async () => {
    const f = await v0Fixture();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 32; i++) await ctx.db.insert("v0PushTokens", { accountId: f.actors.friend.id, deviceId: `synthetic-other-${i}`, token: i.toString(16).padStart(64, "0"), environment: "sandbox", updatedAt: Date.now() });
    });
    await expectCode(register(f), "RATE_LIMITED");
    expect(await f.t.run((ctx) => ctx.db.query("v0PushTokens").collect())).toHaveLength(32);
  });

  it("[N3.unregister-device] unregisters only the caller's device and rejects a revoked caller", async () => {
    const f = await v0Fixture();
    await register(f, f.actors.subject.token, pushToken, "first");
    await register(f, f.actors.alias.token, "b".repeat(64), "second");
    expect(await f.t.mutation(api.v0Notifications.unregister, { token: f.actors.subject.token, requestId: "unregister" })).toEqual({ registered: false });
    expect(await f.t.run((ctx) => ctx.db.query("v0PushTokens").unique())).toMatchObject({ deviceId: f.actors.alias.deviceId });
    await expectCode(register(f, f.actors.revoked.token, "c".repeat(64), "revoked"), "AUTH_REQUIRED");
    await expectCode(f.t.query(api.v0Notifications.preferences, { token: f.actors.revoked.token }), "AUTH_REQUIRED");
  });

  it("[N3.preferences-toggle] disabling clears unsent work/devices, preserves sent audit state and requires fresh registration after enabling", async () => {
    const f = await v0Fixture();
    expect(await f.t.query(api.v0Notifications.preferences, { token: f.actors.friend.token })).toEqual({ enabled: true });
    await register(f);
    const pending = await enqueue(f);
    const sent = await enqueue(f, { key: "synthetic-sent" });
    await f.t.run((ctx) => ctx.db.patch(sent!, { state: "sent", sentAt: Date.now() }));
    expect(await f.t.mutation(api.v0Notifications.setPreferences, { token: f.actors.friend.token, enabled: false, requestId: "off" })).toEqual({ enabled: false });
    expect(await f.t.query(api.v0Notifications.preferences, { token: f.actors.friend.token })).toEqual({ enabled: false });
    const state = await f.t.run(async (ctx) => ({ pending: await ctx.db.get(pending!), sent: await ctx.db.get(sent!), tokens: await ctx.db.query("v0PushTokens").collect() }));
    expect(state.pending).toBeNull();
    expect(state.sent?.state).toBe("sent");
    expect(state.tokens).toEqual([]);
    expect(await enqueue(f, { key: "suppressed" })).toBeNull();
    await expectCode(register(f, f.actors.friend.token, pushToken, "disabled"), "FORBIDDEN");
    await f.t.mutation(api.v0Notifications.setPreferences, { token: f.actors.friend.token, enabled: true, requestId: "on" });
    expect(await f.t.run((ctx) => ctx.db.query("v0PushTokens").collect())).toEqual([]);
    expect(await register(f, f.actors.friend.token, pushToken, "fresh-register")).toEqual({ registered: true });
  });

  for (const control of ["preferences", "leave", "delete", "revoke", "block", "veto"] as const) {
    it(`[N3.suppress-after-${control}] rechecks authorization after claiming and never sends stale work`, async () => {
      const provider = fakeApns();
      const f = await v0Fixture();
      const { id, lease, input } = await claimDevice(f);
      if (control === "preferences") await f.t.mutation(api.v0Notifications.setPreferences, { token: f.actors.friend.token, enabled: false, requestId: "disable" });
      if (control === "leave") await f.t.mutation(api.v0Controls.leave, { token: f.actors.friend.token, groupId: f.g1, requestId: "leave" });
      if (control === "delete") await f.t.mutation(api.v0Controls.deleteAccount, { token: f.actors.friend.token, requestId: "delete" });
      if (control === "revoke") await f.t.mutation(api.v0Auth.revoke, { token: f.actors.friend.token, allDevices: true, requestId: "revoke" });
      if (control === "block") await f.t.mutation(api.v0Controls.block, { token: f.actors.friend.token, accountId: f.actors.subject.id, requestId: "block" });
      if (control === "veto") await f.t.mutation(api.v0Controls.update, { token: f.actors.subject.token, noBets: true, blockedTopics: [], hostedAiConsent: false, requestId: "veto" });
      expect(await f.t.mutation(internal.v0Notifications.authorizeDevice, input)).toBeNull();
      expect(await f.t.action(internal.v0Apns.deliverLease, lease)).toEqual({ status: "complete", environment: "sandbox" });
      expect(await f.t.mutation(internal.v0Notifications.finishAttempt, { ...lease, environment: "sandbox" })).toBe("stale");
      expect(provider.captures).toEqual([]);
      expect(await f.t.run((ctx) => ctx.db.get(id))).toBeNull();
    });
  }

  it("[N1.outbox-idempotency] stores one logical event and rejects a reused key for a different recipient or kind", async () => {
    const f = await v0Fixture();
    const first = await enqueue(f);
    expect(first).not.toBeNull();
    expect(await enqueue(f)).toBe(first);
    await expectCode(enqueue(f, { accountId: f.actors.creator.id }), "IDEMPOTENCY_CONFLICT");
    await expectCode(enqueue(f, { kind: "result" }), "IDEMPOTENCY_CONFLICT");
    expect(await enqueue(f, { key: "synthetic-outsider", accountId: f.actors.outsider.id })).toBeNull();
    expect(await enqueue(f, { key: "synthetic-left", accountId: f.actors.left.id })).toBeNull();
    expect(await f.t.run((ctx) => ctx.db.query("v0Outbox").collect())).toHaveLength(1);
  });
});

describe("actual V0 worker and APNs action through synthetic HTTP/2", () => {
  it("[N3.worker-not-activated] leaves due work untouched when no APNs activation is configured", async () => {
    const f = await v0Fixture();
    await register(f);
    const id = await enqueue(f);
    expect(await f.t.action(internal.v0Notifications.deliverPending, {})).toEqual({ status: "unavailable", reason: "not_activated", processed: 0, sent: 0, retried: 0, failed: 0 });
    expect(await f.t.run((ctx) => ctx.db.get(id!))).toMatchObject({ state: "pending", attempts: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  for (const [name, value] of [["V0_APNS_PRIVATE_KEY", "synthetic-not-a-key"], ["V0_APNS_KEY_ID", "bad"], ["V0_APNS_TEAM_ID", "bad"], ["V0_APNS_TOPIC", "bad"], ["V0_APNS_ENVIRONMENT", "wrong"], ["V0_APNS_PROVIDER", "wrong"]] as const) {
    it(`[N3.apns-invalid-config-${name}] fails closed before claiming or opening transport`, async () => {
      const provider = fakeApns();
      vi.stubEnv(name, value);
      const f = await v0Fixture();
      await register(f);
      const id = await enqueue(f);
      expect(await f.t.action(internal.v0Apns.availability, {})).toEqual({ ready: false, reason: "invalid_configuration" });
      expect(await f.t.action(internal.v0Notifications.deliverPending, {})).toEqual({ status: "unavailable", reason: "invalid_configuration", processed: 0, sent: 0, retried: 0, failed: 0 });
      expect(await f.t.run((ctx) => ctx.db.get(id!))).toMatchObject({ state: "pending", attempts: 0 });
      expect(provider.connect).not.toHaveBeenCalled();
    });
  }

  it("[N3.worker-neutral-payload][N1.worker-duplicate] invokes the real worker once, signs APNs auth and serializes only neutral fields", async () => {
    const provider = fakeApns();
    const f = await v0Fixture();
    await register(f, f.actors.subject.token, pushToken, "sandbox");
    await register(f, f.actors.alias.token, "b".repeat(64), "production", "production");
    const id = await enqueue(f, { accountId: f.actors.subject.id });
    expect(await f.t.action(internal.v0Notifications.deliverPending, {})).toEqual({ status: "processed", reason: "ready", processed: 1, sent: 1, retried: 0, failed: 0 });
    expect(await f.t.action(internal.v0Notifications.deliverPending, {})).toEqual({ status: "processed", reason: "ready", processed: 0, sent: 0, retried: 0, failed: 0 });
    expect(provider.captures).toHaveLength(1);
    const capture = provider.captures[0];
    expect(capture.authority).toBe("https://api.sandbox.push.apple.com");
    expect(JSON.parse(capture.body)).toEqual({ aps: { alert: { title: "Called It", body: "Open Called It for an update." }, sound: "default" }, kind: "reveal", groupId: f.g1, locator: f.locator });
    for (const secret of [...f.privateValues, f.actors.subject.token, f.actors.subject.phone, "Sage"]) expect(capture.body).not.toContain(secret);
    expect(capture.body).not.toMatch(/question|options|context|proof|accountId|session|deviceToken|phoneHash/);
    expect(capture.headers).toMatchObject({ ":method": "POST", ":path": `/3/device/${pushToken}`, "apns-topic": "invalid.synthetic.calledit", "apns-push-type": "alert", "apns-expiration": "0" });
    const jwt = String(capture.headers.authorization).replace(/^bearer /, "");
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: "SYNTHKEY01" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: "SYNTHTEAM1", iat: Math.floor(Date.now() / 1000) });
    expect(verifySignature("sha256", Buffer.from(`${header}.${claims}`), { key: provider.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);
    const stored = await f.t.run(async (ctx) => ({ row: await ctx.db.get(id!), now: Date.now() }));
    expect(stored.row).toMatchObject({ state: "sent", attempts: 1, sentAt: stored.now });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("[N3.duplicate-lease] authorizes each device once even when the real adapter is invoked repeatedly on one lease", async () => {
    const provider = fakeApns();
    const f = await v0Fixture();
    const { lease, input } = await claimDevice(f);
    await f.t.action(internal.v0Apns.deliverLease, lease);
    await f.t.action(internal.v0Apns.deliverLease, lease);
    expect(await f.t.mutation(internal.v0Notifications.authorizeDevice, input)).toBeNull();
    expect(provider.captures).toHaveLength(1);
    expect(await f.t.mutation(internal.v0Notifications.finishAttempt, { ...lease, environment: "sandbox" })).toBe("sent");
    expect(await f.t.mutation(internal.v0Notifications.finishAttempt, { ...lease, environment: "sandbox" })).toBe("stale");
    const receipts = await f.t.run((ctx) => ctx.db.query("v0Requests").withIndex("by_key", (q) => q.eq("accountId", f.actors.friend.id).eq("scope", `notifications.delivery:${lease.id}`)).collect());
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0].result).attempts).toEqual([{ attempt: 1, status: "sent", code: "accepted", at: await f.t.run(async () => Date.now()) }]);
  });

  it("[N1.concurrent-workers] concurrent real worker actions claim one logical event once in convex-test", async () => {
    const provider = fakeApns();
    const f = await v0Fixture();
    await register(f);
    const id = await enqueue(f);
    const results = await Promise.all([f.t.action(internal.v0Notifications.deliverPending, {}), f.t.action(internal.v0Notifications.deliverPending, {})]);
    expect(results.reduce((count, result) => count + result.processed, 0)).toBe(1);
    expect(results.reduce((count, result) => count + result.sent, 0)).toBe(1);
    expect(provider.captures).toHaveLength(1);
    expect(await f.t.run((ctx) => ctx.db.get(id!))).toMatchObject({ state: "sent", attempts: 1 });
  });

  it("[N3.duplicate-device-result] a repeated callback cannot overwrite a successful receipt or invalidate its token", async () => {
    const f = await v0Fixture();
    const { lease, input } = await claimDevice(f);
    expect(await f.t.mutation(internal.v0Notifications.authorizeDevice, input)).not.toBeNull();
    await f.t.mutation(internal.v0Notifications.recordDeviceResult, { ...input, outcome: { status: "sent", code: "accepted" } });
    await f.t.mutation(internal.v0Notifications.recordDeviceResult, { ...input, outcome: { status: "invalid_token", code: "bad_device_token" } });
    expect(await f.t.run((ctx) => ctx.db.query("v0PushTokens").unique())).toMatchObject({ token: pushToken });
    expect(await f.t.mutation(internal.v0Notifications.finishAttempt, { ...lease, environment: "sandbox" })).toBe("sent");
  });

  it("[N3.worker-backoff] retries provider outages with real exponential delays and fails after six attempts", async () => {
    const provider = fakeApns(() => ({ status: 503, body: "malformed-provider-body" }));
    const f = await v0Fixture();
    await register(f);
    const id = await enqueue(f);
    for (let attempt = 1; attempt <= 6; attempt++) {
      expect(await f.t.action(internal.v0Notifications.deliverPending, {})).toEqual({ status: "processed", reason: "ready", processed: 1, sent: 0, retried: attempt < 6 ? 1 : 0, failed: attempt === 6 ? 1 : 0 });
      const row = await f.t.run((ctx) => ctx.db.get(id!));
      expect(row).toMatchObject({ attempts: attempt, state: attempt < 6 ? "pending" : "failed" });
      if (attempt < 6) {
        const backoff = 30_000 * 2 ** (attempt - 1);
        const receipt = await f.t.run((ctx) => ctx.db.query("v0Requests").withIndex("by_key", (q) => q.eq("accountId", f.actors.friend.id).eq("scope", `notifications.delivery:${id}`)).unique());
        expect(row!.availableAt - JSON.parse(receipt!.result).attempts.at(-1).at).toBe(backoff);
        vi.setSystemTime(row!.availableAt - 1);
        expect(await f.t.mutation(internal.v0Notifications.claimBatch, {})).toEqual([]);
        vi.setSystemTime(row!.availableAt);
      }
    }
    expect(provider.captures).toHaveLength(6);
    expect(new Set(provider.captures.map((capture) => capture.headers["apns-id"])).size).toBe(1);
    expect(new Set(provider.captures.map((capture) => capture.headers["apns-collapse-id"])).size).toBe(1);
    expect((await f.t.action(internal.v0Notifications.deliverPending, {})).processed).toBe(0);
  });

  it("[N3.partial-device-retry] does not resend a successful device while retrying another device", async () => {
    let secondDeviceAttempts = 0;
    const provider = fakeApns((capture) => capture.headers[":path"] === `/3/device/${"b".repeat(64)}` && secondDeviceAttempts++ === 0 ? { status: 429 } : { status: 200 });
    const f = await v0Fixture();
    await register(f, f.actors.subject.token, pushToken, "first");
    await register(f, f.actors.alias.token, "b".repeat(64), "second");
    const id = await enqueue(f, { accountId: f.actors.subject.id });
    expect(await f.t.action(internal.v0Notifications.deliverPending, {})).toMatchObject({ processed: 1, retried: 1, sent: 0 });
    const pending = await f.t.run((ctx) => ctx.db.get(id!));
    vi.setSystemTime(pending!.availableAt);
    expect(await f.t.action(internal.v0Notifications.deliverPending, {})).toMatchObject({ processed: 1, sent: 1, retried: 0 });
    expect(provider.captures.map((capture) => capture.headers[":path"])).toEqual([`/3/device/${pushToken}`, `/3/device/${"b".repeat(64)}`, `/3/device/${"b".repeat(64)}`]);
  });

  it("[N3.stale-lease-recovery] reclaims an abandoned lease only at expiry and rejects stale authorization/finalization", async () => {
    const f = await v0Fixture();
    const { id, lease, input } = await claimDevice(f);
    expect(await f.t.mutation(internal.v0Notifications.authorizeDevice, input)).not.toBeNull();
    vi.setSystemTime(lease.leaseUntil - 1);
    expect(await f.t.mutation(internal.v0Notifications.claimBatch, {})).toEqual([]);
    vi.setSystemTime(lease.leaseUntil);
    const reclaimed = await f.t.mutation(internal.v0Notifications.claimBatch, {});
    expect(reclaimed).toEqual([{ id, attempt: 2, leaseUntil: Date.now() + 120_000 }]);
    expect(await f.t.mutation(internal.v0Notifications.authorizeDevice, input)).toBeNull();
    expect(await f.t.mutation(internal.v0Notifications.finishAttempt, { ...lease, environment: "sandbox" })).toBe("stale");
    expect(await f.t.run((ctx) => ctx.db.get(id))).toMatchObject({ state: "delivering", attempts: 2, leaseUntil: reclaimed[0].leaseUntil });
    expect(await f.t.mutation(internal.v0Notifications.authorizeDevice, { ...input, ...reclaimed[0] })).not.toBeNull();
  });

  it("[N3.adapter-release-lease] releases an unattempted lease without spending its retry budget when configuration disappears", async () => {
    fakeApns();
    const f = await v0Fixture();
    const { id, lease } = await claimDevice(f);
    vi.stubEnv("V0_APNS_ENABLED", "false");
    expect(await f.t.action(internal.v0Apns.deliverLease, lease)).toEqual({ status: "unavailable" });
    expect(await f.t.mutation(internal.v0Notifications.releaseLease, lease)).toBeNull();
    expect(await f.t.run((ctx) => ctx.db.get(id))).toMatchObject({ state: "pending", attempts: 0, availableAt: lease.leaseUntil - 120_000 + 30_000 });
    expect(await f.t.mutation(internal.v0Notifications.claimBatch, {})).toEqual([]);
  });

  it("[N3.invalid-device-cleanup] removes malformed, orphaned and revoked-device registrations before claiming", async () => {
    const f = await v0Fixture();
    await f.t.run(async (ctx) => {
      for (const [deviceId, token] of [[f.actors.friend.deviceId, "not-hex"], ["no-live-session", pushToken]]) await ctx.db.insert("v0PushTokens", { accountId: f.actors.friend.id, deviceId, token, environment: "sandbox", updatedAt: Date.now() });
      await ctx.db.insert("v0PushTokens", { accountId: f.actors.revoked.id, deviceId: f.actors.revoked.deviceId, token: "b".repeat(64), environment: "sandbox", updatedAt: Date.now() });
    });
    const friend = await enqueue(f);
    const revoked = await enqueue(f, { key: "revoked-device", accountId: f.actors.revoked.id });
    expect(await f.t.mutation(internal.v0Notifications.claimBatch, {})).toEqual([]);
    expect(await f.t.run((ctx) => ctx.db.query("v0PushTokens").collect())).toEqual([]);
    expect(await f.t.run((ctx) => ctx.db.get(friend!))).toMatchObject({ state: "failed", attempts: 0 });
    expect(await f.t.run((ctx) => ctx.db.get(revoked!))).toMatchObject({ state: "failed", attempts: 0 });
  });

  for (const response of [{ status: 400, body: '{"reason":"BadDeviceToken"}' }, { status: 410, body: '{"reason":"Unregistered"}' }]) {
    it(`[N3.apns-invalid-token-${response.status}] records the actual APNs result and deletes the matching registration`, async () => {
      const provider = fakeApns(() => response);
      const f = await v0Fixture();
      await register(f);
      const id = await enqueue(f);
      expect(await f.t.action(internal.v0Notifications.deliverPending, {})).toMatchObject({ processed: 1, failed: 1, retried: 0 });
      expect(provider.captures).toHaveLength(1);
      expect(await f.t.run((ctx) => ctx.db.query("v0PushTokens").collect())).toEqual([]);
      expect(await f.t.run((ctx) => ctx.db.get(id!))).toMatchObject({ state: "failed" });
    });
  }

  for (const refresh of ["rotated-registration", "older-invalidation"] as const) {
    it(`[N3.apns-preserve-${refresh}] never deletes a newer token snapshot because of an old invalidation`, async () => {
      const f = await v0Fixture();
      const { input } = await claimDevice(f);
      expect(await f.t.mutation(internal.v0Notifications.authorizeDevice, input)).not.toBeNull();
      if (refresh === "rotated-registration") await register(f, f.actors.friend.token, "b".repeat(64), "rotate");
      await f.t.mutation(internal.v0Notifications.recordDeviceResult, { ...input, outcome: { status: "invalid_token", code: "unregistered", ...(refresh === "older-invalidation" ? { invalidatedAt: input.updatedAt - 1 } : {}) } });
      const token = await f.t.run((ctx) => ctx.db.query("v0PushTokens").unique());
      expect(token).not.toBeNull();
      expect(token!.token).toBe(refresh === "rotated-registration" ? "b".repeat(64) : pushToken);
    });
  }

  it("[N3.owner-change-before-send] rejects an old delivery plan after the token transfers to another account", async () => {
    const f = await v0Fixture();
    const { lease, input } = await claimDevice(f);
    await register(f, f.actors.outsider.token, pushToken, "switch-owner");
    expect(await f.t.mutation(internal.v0Notifications.authorizeDevice, input)).toBeNull();
    expect(await f.t.mutation(internal.v0Notifications.finishAttempt, { ...lease, environment: "sandbox" })).toBe("failed");
    expect(await f.t.run((ctx) => ctx.db.query("v0PushTokens").unique())).toMatchObject({ accountId: f.actors.outsider.id });
  });

  for (const change of ["refresh", "environment", "near-expiry", "revoked-session"] as const) {
    it(`[N3.authorize-${change}] checks the current registration, environment, lease and session immediately before send`, async () => {
      const f = await v0Fixture();
      const { input } = await claimDevice(f);
      if (change === "refresh") await register(f, f.actors.friend.token, "b".repeat(64), "refresh");
      if (change === "near-expiry") vi.setSystemTime(input.leaseUntil - 2999);
      if (change === "revoked-session") await f.t.run((ctx) => ctx.db.patch(f.actors.friend.session, { revokedAt: Date.now() }));
      expect(await f.t.mutation(internal.v0Notifications.authorizeDevice, { ...input, ...(change === "environment" ? { environment: "production" as const } : {}) })).toBeNull();
      const token = await f.t.run((ctx) => ctx.db.query("v0PushTokens").unique());
      if (change === "revoked-session") expect(token).toBeNull();
      else expect(token).not.toBeNull();
      if (change === "refresh") expect(token!.token).toBe("b".repeat(64));
    });
  }

  for (const [name, body] of [["malformed", "{"], ["topic-mismatch", '{"reason":"DeviceTokenNotForTopic"}']] as const) {
    it(`[N3.apns-worker-rejection-${name}] records permanent APNs rejection without treating it as an invalid device token`, async () => {
      const provider = fakeApns(() => ({ status: 400, body }));
      const f = await v0Fixture();
      await register(f);
      await enqueue(f);
      expect(await f.t.action(internal.v0Notifications.deliverPending, {})).toMatchObject({ processed: 1, failed: 1, retried: 0, sent: 0 });
      expect(provider.captures).toHaveLength(1);
      expect(await f.t.run((ctx) => ctx.db.query("v0PushTokens").unique())).toMatchObject({ token: pushToken });
    });
  }

  it("[N3.apns-environment-mismatch] refuses a direct request for a mismatched configured environment before opening HTTP/2", async () => {
    const provider = fakeApns();
    expect(await sendApnsRequest({ token: pushToken, userInfo: { kind: "turn" }, providerToken: "synthetic-unused-provider-token", topic: "invalid.synthetic.calledit", environment: "production", notificationId: "synthetic-notification-id", collapseId: "synthetic-collapse", connectionKey: "synthetic-connection" })).toEqual({ status: "retry", code: "provider_error" });
    expect(provider.connect).not.toHaveBeenCalled();
  });

  for (const [name, status, body, expected] of [
    ["malformed-error", 400, "{", { status: "permanent", code: "rejected" }],
    ["topic-mismatch", 400, '{"reason":"DeviceTokenNotForTopic"}', { status: "permanent", code: "rejected" }],
    ["auth-rejected", 403, '{"reason":"InvalidProviderToken"}', { status: "permanent", code: "rejected" }],
    ["null-error", 400, "null", { status: "permanent", code: "rejected" }],
    ["malformed-gateway", 502, "not-json", { status: "retry", code: "provider_error" }],
    ["missing-status", 0, "", { status: "retry", code: "provider_error" }],
    ["nonfinite-status", Number.NaN, "", { status: "retry", code: "provider_error" }],
    ["unregistered-timestamp", 410, '{"timestamp":12345}', { status: "invalid_token", code: "unregistered", invalidatedAt: 12345 }],
    ["unregistered-bad-timestamp", 410, '{"timestamp":"not-a-timestamp"}', { status: "invalid_token", code: "unregistered" }],
  ] as const) {
    it(`[N3.apns-response-${name}] classifies malformed or mismatched provider responses without trusting response content`, () => {
      expect(classifyApnsResponse(status, body)).toEqual(expected);
    });
  }

  for (const [name, response, expected] of [
    ["disconnect", { disconnect: true }, { status: "retry", code: "network_error" }],
    ["request-error", { requestError: true }, { status: "retry", code: "network_error" }],
    ["oversized", { status: 400, body: "x".repeat(8193) }, { status: "retry", code: "provider_error" }],
  ] as const) {
    it(`[N3.apns-transport-${name}] routes real adapter transport errors into retryable receipts`, async () => {
      const provider = fakeApns(() => response);
      const f = await v0Fixture();
      const { lease } = await claimDevice(f);
      expect(await f.t.action(internal.v0Apns.deliverLease, lease)).toEqual({ status: "complete", environment: "sandbox" });
      const receipt = await f.t.run((ctx) => ctx.db.query("v0Requests").withIndex("by_key", (q) => q.eq("accountId", f.actors.friend.id).eq("scope", `notifications.delivery:${lease.id}`)).unique());
      expect(JSON.parse(receipt!.result).attempts[0]).toMatchObject(expected);
      expect(provider.captures).toHaveLength(1);
    });
  }
});
