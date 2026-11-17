import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AdapterBlocked, canonicalUUID, QA_EXTENSION_BUNDLE, QA_HOST_BUNDLE, type ValidatedManifest } from "./manifest";

const artifactKinds = ["simulator-created", "simulator-erased", "empty-state-verified", "outbound-denied"] as const;
type ArtifactKind = typeof artifactKinds[number];
type EvidenceArtifact = Readonly<{ kind: ArtifactKind; file: string; sha256: string }>;

export type ProvisioningReceipt = Readonly<{
  version: 1;
  runID: string;
  simulatorUDID: string;
  nativeSourceRevision: string;
  backendSourceRevision: string;
  fixtureSetID: string;
  hostBundleID: typeof QA_HOST_BUNDLE;
  extensionBundleID: typeof QA_EXTENSION_BUNDLE;
  manifestSHA256: string;
  recordedAt: number;
  artifacts: readonly EvidenceArtifact[];
}>;

export type ProvisioningVerifier = (evidence: Readonly<{
  receipt: ProvisioningReceipt;
  artifacts: ReadonlyMap<ArtifactKind, Uint8Array>;
}>) => Promise<Readonly<{ approved: true; verificationID: string }>>;

async function boundedRegularFile(path: string, limit: number): Promise<Buffer> {
  if (!isAbsolute(path) || await realpath(path) !== resolve(path)) throw new AdapterBlocked();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new AdapterBlocked();
    const bytes = await handle.readFile();
    if (!bytes.length || bytes.length > limit) throw new AdapterBlocked();
    return bytes;
  } finally { await handle.close(); }
}

export async function verifyProvisioning(options: {
  path: string;
  manifest: ValidatedManifest;
  verify: ProvisioningVerifier;
  now: number;
}) {
  try {
    if (!options.path || typeof options.verify !== "function") throw new AdapterBlocked();
    const bytes = await boundedRegularFile(options.path, 32_768);
    const receipt = JSON.parse(bytes.toString("utf8")) as ProvisioningReceipt;
    const fields = ["version", "runID", "simulatorUDID", "nativeSourceRevision", "backendSourceRevision", "fixtureSetID", "hostBundleID", "extensionBundleID", "manifestSHA256", "recordedAt", "artifacts"].sort();
    const { manifest, sha256 } = options.manifest;
    if (!receipt || Object.keys(receipt).sort().join("\0") !== fields.join("\0") || receipt.version !== 1 ||
        canonicalUUID(receipt.runID) !== canonicalUUID(manifest.runID) || canonicalUUID(receipt.simulatorUDID) !== canonicalUUID(manifest.simulatorUDID) ||
        receipt.nativeSourceRevision !== manifest.nativeSourceRevision || receipt.backendSourceRevision !== manifest.backendSourceRevision ||
        receipt.fixtureSetID !== manifest.fixtureSetID || receipt.hostBundleID !== QA_HOST_BUNDLE || receipt.extensionBundleID !== QA_EXTENSION_BUNDLE ||
        receipt.manifestSHA256 !== sha256 || !Number.isFinite(receipt.recordedAt) || receipt.recordedAt > options.now ||
        receipt.recordedAt < manifest.issuedAt - 3_600_000 || !Array.isArray(receipt.artifacts) || receipt.artifacts.length !== artifactKinds.length) throw new AdapterBlocked();
    const artifacts = new Map<ArtifactKind, Uint8Array>();
    for (const artifact of receipt.artifacts) {
      if (!artifact || Object.keys(artifact).sort().join("\0") !== "file\0kind\0sha256" || !artifactKinds.includes(artifact.kind) || artifacts.has(artifact.kind) ||
          !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(artifact.file) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new AdapterBlocked();
      const content = await boundedRegularFile(join(dirname(options.path), artifact.file), 1_048_576);
      if (createHash("sha256").update(content).digest("hex") !== artifact.sha256) throw new AdapterBlocked();
      artifacts.set(artifact.kind, content);
    }
    const verified = await options.verify(Object.freeze({ receipt: Object.freeze(receipt), artifacts }));
    if (verified?.approved !== true || !/^[A-Za-z0-9._:-]{1,128}$/.test(verified.verificationID)) throw new AdapterBlocked();
    return Object.freeze({ verificationID: verified.verificationID });
  } catch { throw new AdapterBlocked(); }
}
