import { createHash } from "node:crypto";
import type { Value } from "convex/values";
import { AdapterBlocked, assertManifestLive, canonicalUUID, type ValidatedManifest } from "../qa-adapter/manifest";
import { verifyProvisioning, type ProvisioningVerifier } from "../qa-adapter/evidence";

export const SYNTHETIC_CARD_SOURCE_ORIGIN = "https://cards.qa-runtime.invalid";
export const CARD_RESULT_PATHS: ReadonlySet<string> = new Set(["v0Bets:get", "v0Bets:list", "v0Bets:history", "v0Bets:create"]);

function dictionary(value: Value): Record<string, Value | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof ArrayBuffer || Object.getPrototypeOf(value) !== Object.prototype) throw new AdapterBlocked();
  return value as Record<string, Value | undefined>;
}

export function createBoundedCardRouting(options: {
  context: ValidatedManifest;
  sourceOrigin: string;
  overlaySourceSHA256: string;
}) {
  if (options.sourceOrigin !== SYNTHETIC_CARD_SOURCE_ORIGIN || !/^[a-f0-9]{64}$/.test(options.overlaySourceSHA256)) throw new AdapterBlocked();
  const { context } = options;
  const config = Object.freeze({ version: 1, sourceOrigin: options.sourceOrigin, destinationOrigin: context.cardOrigin, manifestSHA256: context.sha256, overlaySourceSHA256: options.overlaySourceSHA256 });
  const configSHA256 = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  let activation: Readonly<{ verificationID: string; configSHA256: string; overlaySourceSHA256: string; activationSHA256: string }> | undefined;

  const activate = async (proof: { receiptPath: string; verify: ProvisioningVerifier; attestation: Value }) => {
    assertManifestLive(context.manifest);
    const value = dictionary(proof.attestation);
    const expected: Record<string, Value> = {
      app: "called-it", contractVersion: "v0.2", schemaVersion: "v0.2", environment: "local", sourceSha: context.manifest.backendSourceRevision,
      deploymentId: context.manifest.deploymentID, configVersion: context.manifest.configVersion, testAdapters: true,
      qaRunID: context.manifest.runID, qaManifestSHA256: context.sha256,
    };
    if (Object.keys(value).sort().join("\0") !== Object.keys(expected).sort().join("\0") ||
        Object.entries(expected).some(([key, item]) => key === "qaRunID" ? canonicalUUID(value[key]) !== canonicalUUID(item) : value[key] !== item)) throw new AdapterBlocked();
    const verified = await verifyProvisioning({ path: proof.receiptPath, verify: proof.verify, manifest: context, now: Date.now() });
    activation = Object.freeze({ verificationID: verified.verificationID, configSHA256, overlaySourceSHA256: options.overlaySourceSHA256,
      activationSHA256: createHash("sha256").update(JSON.stringify({ ...config, verificationID: verified.verificationID, attestation: expected })).digest("hex") });
    return activation;
  };

  const rewriteOne = (input: Value): Value => {
    const result = dictionary(input);
    const card = dictionary(result.card ?? null);
    const url = card.url;
    const prefix = config.sourceOrigin + "/c/";
    if (typeof url !== "string" || !url.startsWith(prefix)) throw new AdapterBlocked();
    const locator = url.slice(prefix.length);
    if (!/^[a-f0-9]{64}$/.test(locator) || url !== prefix + locator) throw new AdapterBlocked();
    return { ...result, card: { ...card, url: config.destinationOrigin + "/c/" + locator } };
  };

  return Object.freeze({
    activate,
    provenance: () => activation,
    rewrite(path: string, value: Value): Value {
      if (!activation || !CARD_RESULT_PATHS.has(path)) throw new AdapterBlocked();
      assertManifestLive(context.manifest);
      if (path === "v0Bets:list" || path === "v0Bets:history") {
        if (!Array.isArray(value)) throw new AdapterBlocked();
        return value.map(rewriteOne);
      }
      return rewriteOne(value);
    },
  });
}

export type BoundedCardRouting = ReturnType<typeof createBoundedCardRouting>;
