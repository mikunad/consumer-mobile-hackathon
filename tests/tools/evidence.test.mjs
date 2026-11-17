import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildEvidence } from "./evidence.mjs";
import { publicExports } from "./public-exports.mjs";

const inventory = { cases: [{ id: "J1.1", title: "one case", assertions: [{ id: "J1.1.one.B", reason: "not implemented" }, { id: "J1.1.two.U", reason: "no simulator" }] }] };
const metadata = { repositoryRoot: "/repo", nativeBuild: null, backendDeployment: null, operatorProof: null };
const report = (status = "passed") => ({ success: status === "passed", testResults: [{ name: "/repo/tests/a.test.ts", status, assertionResults: [{ fullName: "suite [proof.one] enforces behavior", status, failureMessages: status === "failed" ? ["red assertion"] : [] }] }] });

test("a backend pass cannot satisfy missing native or physical proof", () => {
  const result = buildEvidence(report(), metadata, [], inventory, { "J1.1.one.B": ["proof.one"] });
  assert.equal(result.status, "blocked");
  assert.equal(result.cases[0].status, "blocked");
  assert.equal(result.cases[0].assertions[0].status, "passing");
  assert.equal(result.cases[0].assertions[1].status, "blocked");
  assert.equal(result.gates.fullV0Ready, false);
});

test("red assertions remain failing and missing assertions remain blocked", () => {
  const result = buildEvidence(report("failed"), metadata, [], inventory, { "J1.1.one.B": ["proof.one"] });
  assert.equal(result.status, "failing");
  assert.equal(result.cases[0].assertions[0].status, "failing");
  assert.equal(result.cases[0].assertions[1].status, "blocked");
});

test("a skipped assertion and a suite-load failure are never green", () => {
  assert.equal(buildEvidence(report("pending"), metadata, [], inventory, { "J1.1.one.B": ["proof.one"] }).cases[0].assertions[0].status, "blocked");
  assert.equal(buildEvidence({ success: false, testResults: [{ name: "/repo/tests/a.test.ts", status: "failed", message: "loader failed", assertionResults: [] }] }, metadata, [], inventory, {}).status, "blocked");
});

test("duplicate execution identifiers and unknown binding identifiers fail closed", () => {
  const duplicate = report();
  duplicate.testResults[0].assertionResults.push(duplicate.testResults[0].assertionResults[0]);
  assert.throws(() => buildEvidence(duplicate, metadata, [], inventory, {}), /duplicate/);
  assert.throws(() => buildEvidence(report(), metadata, [], inventory, { unknown: ["proof.one"] }), /unknown/);
});

test("every declared V0 criterion maps to explicit case and assertion identifiers", () => {
  const requirements = JSON.parse(readFileSync(new URL("../coverage/requirement-map.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../coverage/inventory.json", import.meta.url), "utf8"));
  assert.equal(new Set(manifest.cases.map((c) => c.id)).size, manifest.cases.length);
  const ids = manifest.cases.flatMap((c) => c.assertions.map((a) => a.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const requirement of requirements.requirements) {
    assert.ok(requirement.caseIds.length > 0);
    for (const id of requirement.caseIds) assert.ok(manifest.cases.some((c) => c.id === id && c.assertions.length > 0));
  }
  for (const id of ["SEC1", "SEC2", "SEC3", "SEC4", "SEC5", "N1", "N2", "N3", "R1", "R2", "R3", "R4", "R5"]) assert.ok(manifest.cases.some((c) => c.id === id));
  for (let journey = 1; journey <= 9; journey++) assert.ok(manifest.cases.some((c) => c.id.startsWith(`J${journey}.`)));
});

test("new public handlers require an explicit policy declaration", () => {
  const declared = JSON.parse(readFileSync(new URL("../coverage/public-exports.json", import.meta.url), "utf8"));
  assert.deepEqual(publicExports(process.cwd()), declared.map(({ path, kind }) => ({ path, kind })));
  for (const handler of declared) {
    assert.ok(handler.requiredPolicy);
    assert.notEqual(handler.verification, "passing");
  }
});

test("current acceptance bindings use canonical executions without crediting pending policy or another evidence layer", () => {
  const bindings = JSON.parse(readFileSync(new URL("../coverage/bindings.json", import.meta.url), "utf8"));
  const policies = JSON.parse(readFileSync(new URL("../coverage/v0-public-policies.json", import.meta.url), "utf8"));
  assert.ok(bindings["SEC1.public-export-policy.B"].includes("V0.policy-inventory"));
  for (const [id, executions] of Object.entries(bindings)) {
    assert.ok(id.endsWith(".B"));
    assert.ok(executions.length > 0);
    assert.equal(new Set(executions).size, executions.length);
    for (const execution of executions) {
      assert.ok(!execution.startsWith("V0.pending-policy.") && !execution.includes(".safe-pending."));
      assert.ok(!execution.startsWith("NATIVE-") && !execution.startsWith("RPC."));
    }
  }
  for (const [path, policy] of Object.entries(policies)) {
    if (policy.authenticated && policy.kind === "query") {
      for (const role of ["anonymous", "revoked"]) assert.ok(bindings["SEC1.read-matrix.B"].includes(`V0.auth.${path}.${role}`));
    }
    if (["group_membership", "bet_visibility", "subject_after_reveal", "proof_visibility", "safe_suggestions", "shared_membership"].includes(policy.scope)) {
      for (const role of ["new", "left"]) assert.ok(bindings["SEC1.membership-interval.B"].includes(`V0.scope.${path}.${role}`));
    }
  }
});
