import { createServer as createHttpServer } from "node:http";
import { Buffer } from "node:buffer";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export const fixtureProviderSettings = Object.freeze({
  TWILIO_ACCOUNT_SID: "AC" + "1".repeat(32), TWILIO_AUTH_TOKEN: "2".repeat(32),
  TWILIO_VERIFY_SERVICE_SID: "VA" + "3".repeat(32), V0_OTP_PROVIDER: "twilio_verify", V0_OTP_PROVIDER_ENABLED: "true",
});

export const actors = Object.freeze({
  friend: { phone: "+12025550101", alias: "QA Finn" }, outsider: { phone: "+12025550102", alias: "QA Oli" },
  subject: { phone: "+12025550103", alias: "QA Sage" }, creator: { phone: "+12025550104", alias: "QA Cora" },
});

export async function startProviderTransport({ directory, environment, proxyPort = 43128, tlsPort = 43129 }) {
  const execute = (args) => execFileSync("openssl", args, { cwd: directory, env: environment, stdio: "pipe" });
  for (const name of ["trusted", "untrusted"]) {
    execute(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=CalledIt isolated ${name} fixture CA`, "-keyout", `${name}-ca.key`, "-out", `${name}-ca.pem`, "-addext", "basicConstraints=critical,CA:TRUE"]);
    execute(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=verify.twilio.com", "-keyout", `${name}-server.key`, "-out", `${name}-server.csr`]);
    writeFileSync(resolve(directory, "extensions.cnf"), "subjectAltName=DNS:verify.twilio.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n", { mode: 0o600 });
    execute(["x509", "-req", "-in", `${name}-server.csr`, "-CA", `${name}-ca.pem`, "-CAkey", `${name}-ca.key`, "-CAcreateserial", "-days", "1", "-out", `${name}-server.pem`, "-extfile", "extensions.cnf"]);
  }
  const credentials = (name) => ({ key: readFileSync(resolve(directory, `${name}-server.key`)), cert: readFileSync(resolve(directory, `${name}-server.pem`)) });
  const stats = { connects: 0, deniedConnects: 0, starts: 0, checks: 0, invalidCodes: 0, tlsErrors: [], unexpectedRequests: 0 };
  const pending = new Map();
  const sockets = new Set();
  const track = (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const tls = createHttpsServer(credentials("untrusted"), async (request, response) => {
    const deny = () => { stats.unexpectedRequests++; response.writeHead(403).end(); };
    if (request.socket.remoteAddress !== "127.0.0.1" || request.socket.servername !== "verify.twilio.com" || request.headers.host !== "verify.twilio.com" || request.method !== "POST" ||
        request.headers.authorization !== `Basic ${Buffer.from(`${fixtureProviderSettings.TWILIO_ACCOUNT_SID}:${fixtureProviderSettings.TWILIO_AUTH_TOKEN}`).toString("base64")}` || request.headers["content-type"] !== "application/x-www-form-urlencoded") return deny();
    let body = "";
    for await (const chunk of request) { body += chunk.toString(); if (body.length > 2048) return deny(); }
    const input = new URLSearchParams(body);
    const base = `/v2/Services/${fixtureProviderSettings.TWILIO_VERIFY_SERVICE_SID}/`;
    let item;
    if (request.url === base + "Verifications") {
      const phone = input.get("To");
      if (![...Object.values(actors).map((actor) => actor.phone), "+12025550199"].includes(phone) || input.get("Channel") !== "sms" || input.get("RiskCheck") !== "enable") return deny();
      stats.starts++;
      const sid = "VE" + createHash("sha256").update(`${phone}:${stats.starts}`).digest("hex").slice(0, 32);
      item = { sid, to: phone, status: "pending" };
      pending.set(sid, item);
    } else if (request.url === base + "VerificationCheck") {
      stats.checks++;
      const prior = pending.get(input.get("VerificationSid"));
      if (!prior || input.get("Code") !== "000000") { stats.invalidCodes++; response.writeHead(404).end(); return; }
      item = { ...prior, status: "approved" };
    } else return deny();
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ...item, account_sid: fixtureProviderSettings.TWILIO_ACCOUNT_SID, service_sid: fixtureProviderSettings.TWILIO_VERIFY_SERVICE_SID, channel: "sms" }));
  });
  tls.on("connection", track);
  tls.on("tlsClientError", (error) => { stats.tlsErrors.push(error.code ?? "TLS_REJECTED"); });
  const proxy = createHttpServer((_request, response) => { stats.deniedConnects++; response.writeHead(403).end(); });
  proxy.on("connection", track);
  proxy.on("connect", (request, socket, head) => {
    if (request.url !== "verify.twilio.com:443" || socket.remoteAddress !== "127.0.0.1") { stats.deniedConnects++; socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    stats.connects++;
    const upstream = connect({ host: "127.0.0.1", port: tlsPort });
    track(upstream);
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  try {
    await Promise.all([tls, proxy].map((server, index) => new Promise((accept, reject) => {
      server.once("error", reject);
      server.listen(index === 0 ? tlsPort : proxyPort, "127.0.0.1", () => { server.removeListener("error", reject); accept(); });
    })));
  } catch {
    for (const socket of sockets) socket.destroy();
    await Promise.all([tls, proxy].map((server) => new Promise((accept) => server.close(accept))));
    throw new Error("Private fixture transport ports are unavailable");
  }
  return {
    stats, caPath: resolve(directory, "trusted-ca.pem"), proxyOrigin: `http://127.0.0.1:${proxyPort}`,
    caSHA256: createHash("sha256").update(readFileSync(resolve(directory, "trusted-ca.pem"))).digest("hex"),
    trustFixtureCertificate() { tls.setSecureContext(credentials("trusted")); },
    async close() { for (const socket of sockets) socket.destroy(); await Promise.all([tls, proxy].map((server) => new Promise((accept) => server.close(accept)))); pending.clear(); },
  };
}
