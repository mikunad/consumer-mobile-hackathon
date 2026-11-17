import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const digest = (value) => createHash("sha256").update(value).digest("hex");

export function buildEvidence(report, metadata, fixtures, inventory, bindings) {
  const executions = report.testResults.flatMap((suite) => suite.assertionResults.map((assertion) => ({
    id: assertion.fullName.match(/\[([^\]]+)\]/)?.[1] ?? null,
    file: suite.name.replace(`${metadata.repositoryRoot}/`, ""),
    status: assertion.status === "passed" ? "passing" : assertion.status === "failed" ? "failing" : "blocked",
    durationMs: assertion.duration ?? null,
    errors: assertion.failureMessages ?? [],
  })));
  const seen = new Set();
  for (const execution of executions) {
    if (!execution.id || seen.has(execution.id)) throw new Error("Missing or duplicate assertion execution ID");
    seen.add(execution.id);
  }
  const byId = new Map(executions.map((a) => [a.id, a]));
  const requiredIds = new Set(inventory.cases.flatMap((c) => c.assertions.map((a) => a.id)));
  for (const id of Object.keys(bindings)) if (!requiredIds.has(id)) throw new Error(`Binding references unknown requirement assertion ${id}`);
  const cases = inventory.cases.map((item) => {
    const assertions = item.assertions.map((required) => {
      const ids = bindings[required.id] ?? [];
      const evidence = ids.map((id) => byId.get(id));
      const status = evidence.some((a) => a?.status === "failing") ? "failing" : evidence.length > 0 && evidence.every((a) => a?.status === "passing") ? "passing" : "blocked";
      return { ...required, status, reason: status === "blocked" ? required.reason : null, executionIds: ids, fixtureRunIds: fixtures.filter((f) => ids.some((id) => f.testName.includes(`[${id}]`))).map((f) => f.runId) };
    });
    return { id: item.id, title: item.title, status: assertions.some((a) => a.status === "failing") ? "failing" : assertions.every((a) => a.status === "passing") ? "passing" : "blocked", assertions };
  });
  return {
    schemaVersion: 1,
    ...metadata,
    status: executions.some((a) => a.status === "failing") ? "failing" : !report.success || executions.length === 0 || cases.some((c) => c.status !== "passing") ? "blocked" : "passing",
    gates: { fullV0Ready: cases.every((c) => c.status === "passing") && metadata.nativeBuild !== null && metadata.backendDeployment !== null && metadata.operatorProof !== null, noSkippedAsGreen: !executions.some((a) => a.status === "blocked") },
    suites: report.testResults.map((s) => ({ file: s.name.replace(`${metadata.repositoryRoot}/`, ""), status: s.status, message: s.message ?? null })),
    counts: { executions: executions.length, passing: executions.filter((a) => a.status === "passing").length, failing: executions.filter((a) => a.status === "failing").length, blockedCases: cases.filter((c) => c.status === "blocked").length, failingCases: cases.filter((c) => c.status === "failing").length, passingCases: cases.filter((c) => c.status === "passing").length },
    executions,
    fixtures,
    cases,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [input, metadataPath, fixturePath, output] = process.argv.slice(2);
  if (!input || !metadataPath || !fixturePath || !output) throw new Error("Need Vitest report, run metadata, fixture JSONL and output path");
  const report = JSON.parse(readFileSync(input, "utf8"));
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const fixtures = readFileSync(fixturePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const inventory = JSON.parse(readFileSync(new URL("../coverage/inventory.json", import.meta.url), "utf8"));
  const bindings = JSON.parse(readFileSync(new URL("../coverage/bindings.json", import.meta.url), "utf8"));
  const evidence = buildEvidence(report, metadata, fixtures, inventory, bindings);
  writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ manifest: output, status: evidence.status, ...evidence.counts }));
}
