import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Value } from "convex/values";
import { AdapterBlocked, parseManifest } from "../qa-adapter/manifest";
import { createBoundedCardRouting, SYNTHETIC_CARD_SOURCE_ORIGIN } from "./routing";

const folders: string[] = [];
afterEach(async () => { for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture() {
  const now = Date.now();
  const manifest = { version: 1, runID: "11111111-2222-4333-8444-555555555555", simulatorUDID: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", nativeSourceRevision: "a".repeat(40), backendSourceRevision: "b".repeat(40), deploymentID: "qa-11111111-2222-4333-8444-555555555555", configVersion: "routing-unit", fixtureSetID: "synthetic-v0-subject-locked", apiOrigin: "http://127.0.0.1:8199", cardOrigin: "http://127.0.0.1:3211", issuedAt: now - 1000, expiresAt: now + 60000, erasedSimulator: true, syntheticDataOnly: true, outboundNetworkDenied: true } as const;
  const context = parseManifest(Buffer.from(JSON.stringify(manifest)), manifest);
  const routing = createBoundedCardRouting({ context, sourceOrigin: SYNTHETIC_CARD_SOURCE_ORIGIN, overlaySourceSHA256: "c".repeat(64) });
  const folder = await mkdtemp(join(tmpdir(), "qa-routing-unit-")); folders.push(folder);
  const artifacts = [];
  for (const kind of ["simulator-created", "simulator-erased", "empty-state-verified", "outbound-denied"]) {
    const bytes = Buffer.from("UNIT STUB ONLY, NOT SIMULATOR EVIDENCE: " + kind);
    const file = kind + ".txt"; await writeFile(join(folder, file), bytes);
    artifacts.push({ kind, file, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const receiptPath = join(folder, "receipt.json");
  await writeFile(receiptPath, JSON.stringify({ version: 1, runID: manifest.runID, simulatorUDID: manifest.simulatorUDID, nativeSourceRevision: manifest.nativeSourceRevision, backendSourceRevision: manifest.backendSourceRevision, fixtureSetID: manifest.fixtureSetID, hostBundleID: "com.mikunad.calledit.qa.host", extensionBundleID: "com.mikunad.calledit.qa.host.messages", manifestSHA256: context.sha256, recordedAt: now, artifacts }));
  const attestation: Value = { app: "called-it", contractVersion: "v0.2", schemaVersion: "v0.2", environment: "local", sourceSha: manifest.backendSourceRevision, deploymentId: manifest.deploymentID, configVersion: manifest.configVersion, testAdapters: true, qaRunID: manifest.runID, qaManifestSHA256: context.sha256 };
  const verify = vi.fn(async () => ({ approved: true as const, verificationID: "UNIT-STUB-NOT-DEVICE-PROOF" }));
  return { context, routing, proof: { receiptPath, attestation, verify } };
}

describe("bounded routing overlay units with fake provenance, not runtime activation", () => {
  it("QA-ROUTING-01 requires trusted receipt verification and the exact run/hash attestation", async () => {
    const f = await fixture();
    const value = { card: { url: `${SYNTHETIC_CARD_SOURCE_ORIGIN}/c/${"a".repeat(64)}` } };
    expect(() => f.routing.rewrite("v0Bets:get", value)).toThrow(AdapterBlocked);
    await expect(f.routing.activate({ ...f.proof, attestation: { ...(f.proof.attestation as object), testAdapters: false } })).rejects.toThrow(AdapterBlocked);
    await expect(f.routing.activate({ ...f.proof, verify: async () => { throw new Error("unverified fixture"); } })).rejects.toThrow(AdapterBlocked);
    const provenance = await f.routing.activate(f.proof);
    expect(f.proof.verify).toHaveBeenCalledTimes(1);
    expect(provenance.configSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(provenance.activationSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(provenance.overlaySourceSHA256).toBe("c".repeat(64));
  });

  it("QA-ROUTING-02 changes only the origin in every known canonical card location", async () => {
    const f = await fixture(); await f.routing.activate(f.proof);
    for (const view of ["sealed", "unavailable", "bet"]) {
      const value = { view, groupId: "opaque-group", betId: "opaque-bet", canVeto: view === "sealed", serverTime: 123, card: { url: `${SYNTHETIC_CARD_SOURCE_ORIGIN}/c/${"a".repeat(64)}`, caption: "Secret bet on Sage", accessibilityLabel: "Neutral", bettorCount: 2 }, untouched: { array: [1, null, "https://unrelated.invalid"], bytes: new ArrayBuffer(2) } };
      const expected = { ...value, card: { ...value.card, url: `http://127.0.0.1:3211/c/${"a".repeat(64)}` } };
      const before = structuredClone(value);
      expect(f.routing.rewrite("v0Bets:get", value)).toEqual(expected);
      expect(f.routing.rewrite("v0Bets:create", value)).toEqual(expected);
      expect(f.routing.rewrite("v0Bets:list", [value])).toEqual([expected]);
      expect(f.routing.rewrite("v0Bets:history", [value])).toEqual([expected]);
      expect(value).toEqual(before);
      if (view !== "bet") expect(Object.keys(expected)).not.toContain("question");
    }
  });

  it("QA-ROUTING-03 rejects malformed/foreign/encoded/normalized URLs without redirect or recursive rewriting", async () => {
    const f = await fixture(); await f.routing.activate(f.proof);
    for (const url of [
      `https://production.example/c/${"a".repeat(64)}`, `https://user:pass@cards.qa-runtime.invalid/c/${"a".repeat(64)}`,
      `${SYNTHETIC_CARD_SOURCE_ORIGIN}:443/c/${"a".repeat(64)}`, `${SYNTHETIC_CARD_SOURCE_ORIGIN}/c/${"a".repeat(64)}?x=1`,
      `${SYNTHETIC_CARD_SOURCE_ORIGIN}/c/${"a".repeat(64)}#x`, `${SYNTHETIC_CARD_SOURCE_ORIGIN}/c/${"A".repeat(64)}`,
      `${SYNTHETIC_CARD_SOURCE_ORIGIN}/c/%61${"a".repeat(63)}`, `${SYNTHETIC_CARD_SOURCE_ORIGIN}/extra/../c/${"a".repeat(64)}`,
      `${SYNTHETIC_CARD_SOURCE_ORIGIN}/c/${"a".repeat(64)}/`, `${SYNTHETIC_CARD_SOURCE_ORIGIN}/c/${"a".repeat(63)}`,
    ]) expect(() => f.routing.rewrite("v0Bets:get", { card: { url } })).toThrow(AdapterBlocked);
    expect(() => f.routing.rewrite("v0Unexpected:get", { nested: { card: { url: `${SYNTHETIC_CARD_SOURCE_ORIGIN}/c/${"a".repeat(64)}` } } })).toThrow(AdapterBlocked);
    expect(() => f.routing.rewrite("v0Bets:get", { nested: { card: { url: `${SYNTHETIC_CARD_SOURCE_ORIGIN}/c/${"a".repeat(64)}` } } })).toThrow(AdapterBlocked);
    expect(() => f.routing.rewrite("v0Bets:list", { card: { url: "x" } })).toThrow(AdapterBlocked);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
