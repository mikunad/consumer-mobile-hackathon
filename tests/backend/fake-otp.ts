import { vi } from "vitest";

export const syntheticPhone = "+12025550190";
export const syntheticOtherPhone = "+12025550191";
export const syntheticCode = "246810";
export const syntheticAccountSid = `AC${"a".repeat(32)}`;
export const syntheticServiceSid = `VA${"b".repeat(32)}`;
export const syntheticVerificationSid = `VE${"c".repeat(32)}`;

type ProviderReply = { status?: number; body?: unknown; raw?: string; outage?: boolean };
type ProviderCall = { path: "Verifications" | "VerificationCheck"; body: URLSearchParams; authorization: string | null; redirect?: RequestRedirect };

export function fakeOtp() {
  vi.stubEnv("V0_PHONE_PEPPER", "synthetic-phone-pepper-for-isolated-auth-tests-only");
  vi.stubEnv("V0_OTP_PROVIDER", "twilio_verify");
  vi.stubEnv("V0_OTP_PROVIDER_ENABLED", "true");
  vi.stubEnv("TWILIO_ACCOUNT_SID", syntheticAccountSid);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "d".repeat(32));
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", syntheticServiceSid);
  const calls: ProviderCall[] = [];
  const replies: ProviderReply[] = [];
  const phones = new Map<string, string>();
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const prefix = `https://verify.twilio.com/v2/Services/${syntheticServiceSid}/`;
    const path = String(url).slice(prefix.length);
    if (!String(url).startsWith(prefix) || !["Verifications", "VerificationCheck"].includes(path) || init?.method !== "POST") {
      throw new Error("Synthetic OTP transport rejected an unexpected destination");
    }
    const body = new URLSearchParams(String(init.body));
    calls.push({ path: path as ProviderCall["path"], body, authorization: new Headers(init.headers).get("authorization"), redirect: init.redirect });
    const next = replies.shift();
    if (next?.outage) throw new Error("Synthetic provider outage");
    const phone = path === "Verifications" ? body.get("To")! : phones.get(body.get("VerificationSid")!)!;
    if (path === "Verifications") phones.set(syntheticVerificationSid, phone);
    const response = {
      sid: syntheticVerificationSid,
      account_sid: syntheticAccountSid,
      service_sid: syntheticServiceSid,
      channel: "sms",
      to: phone,
      status: path === "Verifications" || body.get("Code") !== syntheticCode ? "pending" : "approved",
    };
    return new Response(next?.raw ?? JSON.stringify(next && "body" in next ? next.body : response), {
      status: next?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    calls,
    fetch,
    reply: (reply: ProviderReply) => replies.push(reply),
    body: (overrides: Record<string, unknown> = {}) => ({ sid: syntheticVerificationSid, account_sid: syntheticAccountSid, service_sid: syntheticServiceSid, channel: "sms", to: syntheticPhone, status: "approved", ...overrides }),
  };
}
