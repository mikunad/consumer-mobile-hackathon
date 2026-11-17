import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQAAdapter } from "./adapter";
import { verifyProvisioning, type ProvisioningReceipt } from "./evidence";
import { AdapterBlocked, parseManifest, QA_EXTENSION_BUNDLE, QA_HOST_BUNDLE } from "./manifest";
import { expectedRun, manifestBytes, NOW, plumbingFixture } from "./fixtures";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

async function receiptFixture() {
  const f = plumbingFixture();
  const folder = await mkdtemp(join(tmpdir(), "qa-adapter-evidence-unit-"));
  folders.push(folder);
  const manifest = parseManifest(f.options.manifestBytes, f.options.expected, NOW);
  const artifacts: ProvisioningReceipt["artifacts"][number][] = [];
  for (const kind of ["simulator-created", "simulator-erased", "empty-state-verified", "outbound-denied"] as const) {
    const content = Buffer.from(`UNIT STUB ONLY, NO SIMULATOR OR EGRESS PROOF: ${kind}`);
    const file = `${kind}.txt`;
    await writeFile(join(folder, file), content, { mode: 0o600 });
    artifacts.push({ kind, file, sha256: createHash("sha256").update(content).digest("hex") });
  }
  const receipt: ProvisioningReceipt = {
    version: 1, runID: f.manifest.runID, simulatorUDID: f.manifest.simulatorUDID,
    nativeSourceRevision: f.manifest.nativeSourceRevision, backendSourceRevision: f.manifest.backendSourceRevision,
    fixtureSetID: f.manifest.fixtureSetID, hostBundleID: QA_HOST_BUNDLE, extensionBundleID: QA_EXTENSION_BUNDLE,
    manifestSHA256: manifest.sha256, recordedAt: NOW - 500, artifacts,
  };
  const path = join(folder, "receipt.json");
  await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
  const verify = vi.fn(async () => ({ approved: true as const, verificationID: "UNIT-STUB-NOT-DEVICE-PROOF" }));
  return { f, folder, manifest, receipt, path, verify };
}

describe("recorded provisioning verifier plumbing; all artifacts here are explicit unit stubs", () => {
  it("QA-EVIDENCE-01 requires recorded files plus a separate trusted provenance verifier", async () => {
    const f = await receiptFixture();
    await expect(verifyProvisioning({ path: f.path, manifest: f.manifest, now: NOW, verify: f.verify })).resolves.toEqual({ verificationID: "UNIT-STUB-NOT-DEVICE-PROOF" });
    expect(f.verify).toHaveBeenCalledTimes(1);
    await expect(verifyProvisioning({ path: f.path, manifest: f.manifest, now: NOW, verify: undefined as unknown as typeof f.verify })).rejects.toThrow(AdapterBlocked);
    await expect(verifyProvisioning({ path: f.path, manifest: f.manifest, now: NOW, verify: async () => { throw new Error("unverified"); } })).rejects.toThrow(AdapterBlocked);
  });

  it("QA-EVIDENCE-02 rejects mismatched run/hash/bundles and missing/tampered backing artifacts", async () => {
    const f = await receiptFixture();
    for (const patch of [{ runID: "00000000-0000-4000-8000-000000000000" }, { manifestSHA256: "0".repeat(64) }, { hostBundleID: "com.mikunad.calledit.messages" }, { artifacts: [] }, { recordedAt: NOW + 1 }]) {
      await writeFile(f.path, JSON.stringify({ ...f.receipt, ...patch }));
      await expect(verifyProvisioning({ path: f.path, manifest: f.manifest, now: NOW, verify: f.verify })).rejects.toThrow(AdapterBlocked);
    }
    await writeFile(f.path, JSON.stringify(f.receipt));
    await writeFile(join(f.folder, f.receipt.artifacts[0].file), "tampered synthetic artifact");
    await expect(verifyProvisioning({ path: f.path, manifest: f.manifest, now: NOW, verify: f.verify })).rejects.toThrow(AdapterBlocked);
    expect(f.verify).not.toHaveBeenCalled();
  });

  it("QA-EVIDENCE-03 rejects artifact traversal and symlinks instead of reading unrelated files", async () => {
    const f = await receiptFixture();
    await writeFile(f.path, JSON.stringify({ ...f.receipt, artifacts: [{ ...f.receipt.artifacts[0], file: "../elsewhere" }, ...f.receipt.artifacts.slice(1)] }));
    await expect(verifyProvisioning({ path: f.path, manifest: f.manifest, now: NOW, verify: f.verify })).rejects.toThrow(AdapterBlocked);
    const linked = join(f.folder, "linked.json");
    await symlink(f.path, linked);
    await expect(verifyProvisioning({ path: linked, manifest: f.manifest, now: NOW, verify: f.verify })).rejects.toThrow(AdapterBlocked);
    expect(f.verify).not.toHaveBeenCalled();
  });

  it("QA-EVIDENCE-04 cannot promote a plumbing stub binding into a runtime server", async () => {
    const f = await receiptFixture();
    const now = Date.now();
    const live = { ...f.f.manifest, issuedAt: now - 1_000, expiresAt: now + 60_000 };
    const bytes = manifestBytes(live);
    const context = parseManifest(bytes, expectedRun(live), now);
    await writeFile(f.path, JSON.stringify({ ...f.receipt, manifestSHA256: context.sha256, recordedAt: now - 500 }));
    await expect(createQAAdapter({ ...f.f.options, now: undefined, manifestBytes: bytes, expected: expectedRun(live), mode: "simulator-runtime", provisioning: { path: f.path, verify: f.verify } })).rejects.toThrow(AdapterBlocked);
    expect(f.verify).toHaveBeenCalledTimes(1);
  });
});
