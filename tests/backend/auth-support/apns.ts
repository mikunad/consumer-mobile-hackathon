import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientHttp2Session, OutgoingHttpHeaders } from "node:http2";
import { afterEach, vi } from "vitest";

export const syntheticConnect = vi.fn();

type Response = { status?: number; body?: string; disconnect?: boolean; requestError?: boolean };
export type PushCapture = { authority: string; headers: OutgoingHttpHeaders; body: string };
const connections: SyntheticConnection[] = [];

class SyntheticConnection extends EventEmitter {
  closed = false;
  destroyed = false;
  constructor(readonly authority: string, readonly captures: PushCapture[], readonly reply: (capture: PushCapture) => Response) {
    super();
    connections.push(this);
  }
  setTimeout() {}
  close() { this.closed = true; }
  destroy() { this.destroyed = true; }
  request(headers: OutgoingHttpHeaders) {
    const request = new EventEmitter() as EventEmitter & { setEncoding: () => void; close: () => void; end: (body: string) => void };
    request.setEncoding = () => {};
    request.close = () => {};
    request.end = (body) => {
      const capture = { authority: this.authority, headers, body };
      this.captures.push(capture);
      const response = this.reply(capture);
      queueMicrotask(() => {
        if (response.disconnect) this.emit("goaway");
        else if (response.requestError) request.emit("error", new Error("Synthetic APNs request failure"));
        else {
          request.emit("response", { ":status": response.status ?? 200 });
          if (response.body) request.emit("data", response.body);
          request.emit("end");
        }
      });
    };
    return request;
  }
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.destroy();
  syntheticConnect.mockReset();
});

export function fakeApns(reply: (capture: PushCapture) => Response = () => ({ status: 200 })) {
  const captures: PushCapture[] = [];
  syntheticConnect.mockImplementation((authority: string) => {
    if (!["https://api.sandbox.push.apple.com", "https://api.push.apple.com"].includes(authority)) throw new Error("Synthetic APNs transport rejected an unexpected destination");
    return new SyntheticConnection(authority, captures, reply) as unknown as ClientHttp2Session;
  });
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  vi.stubEnv("V0_APNS_ENABLED", "true");
  vi.stubEnv("V0_APNS_CONFIG_VERSION", `synthetic-${crypto.randomUUID()}`);
  vi.stubEnv("V0_APNS_PROVIDER", "apns");
  vi.stubEnv("V0_APNS_KEY_ID", "SYNTHKEY01");
  vi.stubEnv("V0_APNS_TEAM_ID", "SYNTHTEAM1");
  vi.stubEnv("V0_APNS_TOPIC", "invalid.synthetic.calledit");
  vi.stubEnv("V0_APNS_ENVIRONMENT", "sandbox");
  vi.stubEnv("V0_APNS_PRIVATE_KEY", privateKey.export({ format: "pem", type: "pkcs8" }).toString());
  return { captures, connect: syntheticConnect, publicKey };
}
