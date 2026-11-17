import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const MAX_MANIFEST_BYTES = 16_384;
export const QA_HOST_BUNDLE = "com.mikunad.calledit.qa.host";
export const QA_EXTENSION_BUNDLE = "com.mikunad.calledit.qa.host.messages";

export class AdapterBlocked extends Error {
  constructor() {
    super("QA adapter BLOCKED: verified provisioning, fixture and real-handler dependencies are required");
    this.name = "AdapterBlocked";
  }
}

export class InvalidManifest extends Error {
  constructor() {
    super("Invalid or expired isolated QA manifest");
    this.name = "InvalidManifest";
  }
}

export type Manifest = Readonly<{
  version: 1;
  runID: string;
  simulatorUDID: string;
  nativeSourceRevision: string;
  backendSourceRevision: string;
  deploymentID: string;
  configVersion: string;
  fixtureSetID: string;
  apiOrigin: string;
  cardOrigin: string;
  issuedAt: number;
  expiresAt: number;
  erasedSimulator: true;
  syntheticDataOnly: true;
  outboundNetworkDenied: true;
}>;

export type ExpectedRun = Readonly<Pick<Manifest,
  "runID" | "simulatorUDID" | "nativeSourceRevision" | "backendSourceRevision" |
  "deploymentID" | "configVersion" | "fixtureSetID" | "apiOrigin" | "cardOrigin"
>>;

const fields = ["version", "runID", "simulatorUDID", "nativeSourceRevision", "backendSourceRevision", "deploymentID", "configVersion", "fixtureSetID", "apiOrigin", "cardOrigin", "issuedAt", "expiresAt", "erasedSimulator", "syntheticDataOnly", "outboundNetworkDenied"].sort();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const revision = /^[a-f0-9]{40}$/;
const boundedID = /^[A-Za-z0-9._:-]{1,128}$/;

export function canonicalUUID(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new InvalidManifest();
  return value.toUpperCase();
}

export function loopbackOrigin(value: unknown): string {
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(value)) throw new InvalidManifest();
  let url: URL;
  try { url = new URL(value); } catch { throw new InvalidManifest(); }
  const port = Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1024 || port > 65535 ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new InvalidManifest();
  return url.origin;
}

export function assertManifestLive(manifest: Manifest, now = Date.now()): void {
  if (!Number.isFinite(now) || now < manifest.issuedAt || now > manifest.expiresAt) throw new InvalidManifest();
}

export function parseManifest(rawInput: Uint8Array, expected: ExpectedRun, now = Date.now()) {
  const raw = Buffer.from(rawInput);
  if (!raw.length || raw.length > MAX_MANIFEST_BYTES) throw new InvalidManifest();
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidManifest();
    value = parsed as Record<string, unknown>;
  } catch { throw new InvalidManifest(); }
  if (Object.keys(value).sort().join("\0") !== fields.join("\0") || value.version !== 1 ||
      value.erasedSimulator !== true || value.syntheticDataOnly !== true || value.outboundNetworkDenied !== true ||
      typeof value.nativeSourceRevision !== "string" || !revision.test(value.nativeSourceRevision) ||
      typeof value.backendSourceRevision !== "string" || !revision.test(value.backendSourceRevision) ||
      typeof value.configVersion !== "string" || !boundedID.test(value.configVersion) ||
      typeof value.fixtureSetID !== "string" || !boundedID.test(value.fixtureSetID) ||
      typeof value.issuedAt !== "number" || !Number.isFinite(value.issuedAt) ||
      typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) ||
      value.expiresAt < value.issuedAt || value.expiresAt - value.issuedAt > 3_600_000) throw new InvalidManifest();
  const runID = canonicalUUID(value.runID);
  const simulatorUDID = canonicalUUID(value.simulatorUDID);
  if (value.deploymentID !== `qa-${runID}` && value.deploymentID !== `qa-${runID.toLowerCase()}`) throw new InvalidManifest();
  if (canonicalUUID(expected.runID) !== runID || canonicalUUID(expected.simulatorUDID) !== simulatorUDID ||
      value.nativeSourceRevision !== expected.nativeSourceRevision || value.backendSourceRevision !== expected.backendSourceRevision ||
      value.deploymentID !== expected.deploymentID || value.configVersion !== expected.configVersion || value.fixtureSetID !== expected.fixtureSetID ||
      loopbackOrigin(value.apiOrigin) !== loopbackOrigin(expected.apiOrigin) ||
      loopbackOrigin(value.cardOrigin) !== loopbackOrigin(expected.cardOrigin)) throw new InvalidManifest();
  const manifest = Object.freeze(value as Manifest);
  assertManifestLive(manifest, now);
  return Object.freeze({
    manifest,
    sha256: createHash("sha256").update(raw).digest("hex"),
    apiOrigin: loopbackOrigin(manifest.apiOrigin),
    cardOrigin: loopbackOrigin(manifest.cardOrigin),
  });
}

export type ValidatedManifest = ReturnType<typeof parseManifest>;
