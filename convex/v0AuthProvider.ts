import { fail } from "./v0Policy";

export function requireOtpProvider() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (
    process.env.V0_OTP_PROVIDER !== "twilio_verify" ||
    process.env.V0_OTP_PROVIDER_ENABLED !== "true" ||
    !accountSid || !/^AC[0-9a-fA-F]{32}$/.test(accountSid) ||
    !authToken || !/^[0-9a-fA-F]{32}$/.test(authToken) ||
    !serviceSid || !/^VA[0-9a-fA-F]{32}$/.test(serviceSid)
  ) fail("PROVIDER_UNAVAILABLE", "Phone sign-in is not configured.");
  return { accountSid, authToken, serviceSid };
}

async function verifyRequest(path: "Verifications" | "VerificationCheck", body: URLSearchParams) {
  const config = requireOtpProvider();
  let response: Response;
  let data: unknown;
  try {
    response = await fetch(`https://verify.twilio.com/v2/Services/${config.serviceSid}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) data = await response.json();
  } catch {
    fail("PROVIDER_UNAVAILABLE", "Phone sign-in is temporarily unavailable.");
  }
  if (!response.ok) {
    if (path === "VerificationCheck" && response.status === 404) fail("INVALID_INPUT", "That code is invalid or expired.");
    if (response.status === 429) fail("RATE_LIMITED", "Please wait before trying again.");
    fail("PROVIDER_UNAVAILABLE", "Phone sign-in is temporarily unavailable.");
  }
  if (!data || typeof data !== "object") fail("PROVIDER_UNAVAILABLE");
  const result = data as Record<string, unknown>;
  if (
    typeof result.sid !== "string" || !/^VE[0-9a-fA-F]{32}$/.test(result.sid) ||
    result.account_sid !== config.accountSid || result.service_sid !== config.serviceSid ||
    result.channel !== "sms"
  ) fail("PROVIDER_UNAVAILABLE", "Phone sign-in is temporarily unavailable.");
  return { sid: result.sid, to: result.to, status: result.status };
}

export async function startVerification(phone: string) {
  const result = await verifyRequest("Verifications", new URLSearchParams({ To: phone, Channel: "sms", RiskCheck: "enable" }));
  if (result.to !== phone || result.status !== "pending") fail("PROVIDER_UNAVAILABLE", "Phone sign-in is temporarily unavailable.");
  return result.sid;
}

export async function checkVerification(phone: string, code: string, providerId: string) {
  const result = await verifyRequest("VerificationCheck", new URLSearchParams({ VerificationSid: providerId, Code: code }));
  if (result.to !== phone || result.sid !== providerId) fail("PROVIDER_UNAVAILABLE", "Phone sign-in is temporarily unavailable.");
  if (result.status !== "approved") fail("INVALID_INPUT", "That code is invalid or expired.");
}
