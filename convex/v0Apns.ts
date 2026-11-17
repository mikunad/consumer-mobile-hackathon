"use node";

import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import type { NotificationTap } from "./v0Contract";
import type { ApnsAvailability, ApnsOutcome, DeviceAuthorization, NotificationLease, PushEnvironment } from "./v0Notifications";

type Configuration = { key: KeyObject; keyId: string; teamId: string; topic: string; environment: PushEnvironment; version: string };
type DeviceSnapshot = { tokenId: Id<"v0PushTokens">; updatedAt: number };
type DeviceInput = NotificationLease & DeviceSnapshot & { environment: PushEnvironment };
type RequestInput = { token: string; userInfo: NotificationTap; providerToken: string; topic: string; environment: PushEnvironment; notificationId: string; collapseId: string; connectionKey: string };

let cachedProviderToken: { key: string; token: string; issuedAt: number } | undefined;
let cachedConnection: { key: string; client: ClientHttp2Session } | undefined;

const planRef = makeFunctionReference<"query", NotificationLease & { environment: PushEnvironment }, DeviceSnapshot[]>("v0Notifications:deliveryPlan");
const authorizeRef = makeFunctionReference<"mutation", DeviceInput, DeviceAuthorization | null>("v0Notifications:authorizeDevice");
const recordRef = makeFunctionReference<"mutation", DeviceInput & { outcome: ApnsOutcome }, null>("v0Notifications:recordDeviceResult");

function configuration(): Configuration | null {
  if (process.env.V0_APNS_ENABLED !== "true" || !process.env.V0_APNS_CONFIG_VERSION || process.env.V0_APNS_PROVIDER !== "apns") return null;
  const keyId = process.env.V0_APNS_KEY_ID ?? "";
  const teamId = process.env.V0_APNS_TEAM_ID ?? "";
  const topic = process.env.V0_APNS_TOPIC ?? "";
  const environment = process.env.V0_APNS_ENVIRONMENT;
  const privateKey = process.env.V0_APNS_PRIVATE_KEY ?? "";
  if (!/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(topic) || topic.length > 200 || !["sandbox", "production"].includes(environment ?? "") || privateKey.length > 16_384) return null;
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return { key, keyId, teamId, topic, environment: environment as PushEnvironment, version: process.env.V0_APNS_CONFIG_VERSION };
  } catch {
    return null;
  }
}

export function createProviderToken(key: KeyObject, keyId: string, teamId: string, now: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) })).toString("base64url");
  const message = `${header}.${claims}`;
  return `${message}.${sign("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

export function classifyApnsResponse(status: number, body: string): ApnsOutcome {
  if (!Number.isInteger(status) || status < 100 || status > 599) return { status: "retry", code: "provider_error" };
  if (status === 200) return { status: "sent", code: "accepted" };
  let response: { reason?: unknown; timestamp?: unknown } = {};
  try { response = JSON.parse(body); } catch { response = {}; }
  if (status === 410) return { status: "invalid_token", code: "unregistered", ...(typeof response?.timestamp === "number" && Number.isFinite(response.timestamp) && response.timestamp >= 0 ? { invalidatedAt: response.timestamp } : {}) };
  if (status === 400 && response?.reason === "BadDeviceToken") return { status: "invalid_token", code: "bad_device_token" };
  if (status === 429) return { status: "retry", code: "rate_limited" };
  if (status >= 500 || status < 100) return { status: "retry", code: "provider_error" };
  return { status: "permanent", code: "rejected" };
}

export function sendApnsRequest(input: RequestInput, open: (authority: string, options: { minVersion: "TLSv1.2" }) => ClientHttp2Session = connect): Promise<ApnsOutcome> {
  if (open === connect) {
    const active = configuration();
    if (!active || active.environment !== input.environment || active.topic !== input.topic) return Promise.resolve({ status: "retry", code: "provider_error" });
  }
  return new Promise((resolve) => {
    let client: ClientHttp2Session | undefined;
    let request: ReturnType<ClientHttp2Session["request"]> | undefined;
    let settled = false;
    const disconnected = () => finish({ status: "retry", code: "network_error" });
    const finish = (outcome: ApnsOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.removeListener("error", disconnected);
      client?.removeListener("goaway", disconnected);
      request?.close();
      if (open !== connect || outcome.status === "retry") {
        client?.destroy();
        if (cachedConnection?.client === client) cachedConnection = undefined;
      }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ status: "retry", code: "timeout" }), 2000);
    try {
      if (open === connect && cachedConnection?.key === input.connectionKey && !cachedConnection.client.closed && !cachedConnection.client.destroyed) client = cachedConnection.client;
      else {
        client = open(input.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com", { minVersion: "TLSv1.2" });
        if (open === connect) {
          cachedConnection?.client.close();
          cachedConnection = { key: input.connectionKey, client };
          client.on("error", () => { if (cachedConnection?.client === client) cachedConnection = undefined; });
          client.setTimeout(60_000, () => { client?.close(); if (cachedConnection?.client === client) cachedConnection = undefined; });
        }
      }
      client.on("error", disconnected);
      client.on("goaway", disconnected);
      request = client.request({
        ":method": "POST", ":path": `/3/device/${input.token}`, authorization: `bearer ${input.providerToken}`,
        "apns-topic": input.topic, "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": "0",
        "apns-id": input.notificationId, "apns-collapse-id": input.collapseId, "content-type": "application/json",
      });
      let status = 0;
      let body = "";
      request.setEncoding("utf8");
      request.on("response", (headers) => { status = Number(headers[":status"]); });
      request.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 8192) finish({ status: "retry", code: "provider_error" });
      });
      request.on("error", () => finish({ status: "retry", code: "network_error" }));
      request.on("end", () => finish(classifyApnsResponse(status, body)));
      request.end(JSON.stringify({
        aps: { alert: { title: "Called It", body: "Open Called It for an update." }, sound: "default" },
        kind: input.userInfo.kind,
        ...(input.userInfo.groupId ? { groupId: input.userInfo.groupId } : {}),
        ...(input.userInfo.locator ? { locator: input.userInfo.locator } : {}),
      }));
    } catch {
      finish({ status: "retry", code: "network_error" });
    }
  });
}

export const availability = internalAction({
  args: {},
  handler: async (): Promise<ApnsAvailability> => {
    if (process.env.V0_APNS_ENABLED !== "true" || !process.env.V0_APNS_CONFIG_VERSION) return { ready: false, reason: "not_activated" };
    return configuration() ? { ready: true, reason: "ready" } : { ready: false, reason: "invalid_configuration" };
  },
});

export const deliverLease = internalAction({
  args: { id: v.id("v0Outbox"), attempt: v.number(), leaseUntil: v.number() },
  handler: async (ctx, lease): Promise<{ status: "complete"; environment: PushEnvironment } | { status: "unavailable" }> => {
    const selected = configuration();
    if (!selected) return { status: "unavailable" };
    const plan = await ctx.runQuery(planRef, { ...lease, environment: selected.environment });
    let attempted = false;
    for (const device of plan) {
      const current = configuration();
      if (!current || current.version !== selected.version || current.environment !== selected.environment || current.topic !== selected.topic) return attempted ? { status: "complete", environment: selected.environment } : { status: "unavailable" };
      const input = { ...lease, ...device, environment: current.environment };
      const authorized = await ctx.runMutation(authorizeRef, input);
      if (!authorized) continue;
      const digest = createHash("sha256").update(`${lease.id}:${device.tokenId}:${device.updatedAt}`).digest("hex");
      const notificationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      const connectionKey = `${current.version}:${current.environment}:${current.topic}:${current.teamId}:${current.keyId}`;
      if (!cachedProviderToken || cachedProviderToken.key !== connectionKey || Date.now() - cachedProviderToken.issuedAt >= 50 * 60_000 || cachedProviderToken.issuedAt > Date.now()) cachedProviderToken = { key: connectionKey, token: createProviderToken(current.key, current.keyId, current.teamId, Date.now()), issuedAt: Date.now() };
      attempted = true;
      const outcome = await sendApnsRequest({ ...authorized, providerToken: cachedProviderToken.token, topic: current.topic, environment: current.environment, notificationId, collapseId: digest, connectionKey });
      await ctx.runMutation(recordRef, { ...input, outcome });
    }
    return { status: "complete", environment: selected.environment };
  },
});
