import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { expectedRun, manifestBytes, manifestFixture, NOW } from "./fixtures";
import { InvalidManifest, loopbackOrigin, parseManifest } from "./manifest";

describe("QA manifest plumbing, not simulator evidence", () => {
  it("QA-MANIFEST-01 hashes raw bytes and preserves exact source/config pins", () => {
    const manifest = manifestFixture();
    const raw = manifestBytes(manifest);
    const accepted = parseManifest(raw, expectedRun(manifest), NOW);
    expect(accepted.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(accepted.manifest.nativeSourceRevision).not.toBe(accepted.manifest.backendSourceRevision);
    expect(parseManifest(Buffer.concat([raw, Buffer.from("\n")]), expectedRun(manifest), NOW).sha256).not.toBe(accepted.sha256);
  });

  it("QA-MANIFEST-02 rejects missing/unknown/wrong-typed fields and malformed encodings", () => {
    const manifest = manifestFixture();
    for (const key of Object.keys(manifest)) {
      const missing = { ...manifest } as Record<string, unknown>;
      delete missing[key];
      expect(() => parseManifest(manifestBytes(missing), expectedRun(manifest), NOW)).toThrow(InvalidManifest);
    }
    for (const invalid of [{ ...manifest, token: "SYNTHETIC_PRIVATE" }, { ...manifest, erasedSimulator: 1 }, { ...manifest, syntheticDataOnly: false }, { ...manifest, outboundNetworkDenied: false }, { ...manifest, version: "1" }]) {
      expect(() => parseManifest(manifestBytes(invalid), expectedRun(manifest), NOW)).toThrow(InvalidManifest);
    }
    for (const raw of [Buffer.alloc(0), Buffer.alloc(16_385, 0x20), Buffer.from([0xff]), Buffer.from("{}"), Buffer.from("[]"), Buffer.from("null")]) {
      expect(() => parseManifest(raw, expectedRun(manifest), NOW)).toThrow(InvalidManifest);
    }
  });

  it("QA-MANIFEST-03 rejects stale/future/overlong activation and mismatched external pins", () => {
    const manifest = manifestFixture();
    for (const patch of [{ issuedAt: NOW + 1 }, { expiresAt: NOW - 1 }, { expiresAt: NOW + 3_600_001 }, { nativeSourceRevision: "A".repeat(40) }, { fixtureSetID: "contains spaces" }, { deploymentID: "production" }]) {
      expect(() => parseManifest(manifestBytes({ ...manifest, ...patch }), expectedRun(manifest), NOW)).toThrow(InvalidManifest);
    }
    for (const [key, value] of Object.entries(expectedRun(manifest))) {
      const expected = { ...expectedRun(manifest), [key]: typeof value === "string" ? "mismatch" : value };
      expect(() => parseManifest(manifestBytes(manifest), expected, NOW)).toThrow(InvalidManifest);
    }
    expect(() => parseManifest(manifestBytes(manifest), expectedRun(manifest), Number.NaN)).toThrow(InvalidManifest);
  });

  it("QA-MANIFEST-04 permits numeric loopback with explicit safe port only", () => {
    for (const valid of ["http://127.0.0.1:1024", "http://127.0.0.1:65535/"]) expect(loopbackOrigin(valid)).toMatch(/^http:\/\/127\.0\.0\.1:/);
    for (const invalid of ["http://localhost:43127", "http://127.1:43127", "http://2130706433:43127", "http://127.0.0.1:80", "http://127.0.0.1:0", "http://127.0.0.1:65536", "https://127.0.0.1:43127", "http://[::1]:43127", "http://127.0.0.1:43127/path", "http://127.0.0.1:43127?x=1", "http://user:pass@127.0.0.1:43127", "https://reliable-kookabura-33.convex.cloud"]) {
      expect(() => loopbackOrigin(invalid)).toThrow(InvalidManifest);
    }
  });
});
