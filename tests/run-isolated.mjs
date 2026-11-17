import { spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outputFlag = args.indexOf("--output");
const output = resolve(outputFlag >= 0 ? args.splice(outputFlag, 2)[1] : mkdtempSync(resolve(tmpdir(), "calledit-evidence-")));
if (output.startsWith(`${root}/`) || output === root) throw new Error("Evidence must be outside the repository");
mkdirSync(output, { recursive: true });
if (existsSync(resolve(output, "vitest.json"))) throw new Error("Output already has a report; choose a fresh run directory");
const home = mkdtempSync(resolve(tmpdir(), "calledit-test-home-"));
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  TMPDIR: home,
  CI: "1",
  NODE_ENV: "test",
  E2E_ISOLATED: "network-namespace-v1",
  E2E_ARTIFACT_DIR: output,
};
const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: root, env, encoding: "utf8" }).trim();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const backendFiles = git("ls-files", "convex").split("\n").filter(Boolean).sort();
const testFiles = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? testFiles(resolve(dir, entry.name)) : [resolve(dir, entry.name)]) : [];
const testSourceDigest = hash([...testFiles(resolve(root, "tests")), ...testFiles(resolve(root, "native-imessage/Tests")), ...testFiles(resolve(root, "native-imessage/UITests")), ...testFiles(resolve(root, "native-imessage/TestSupport")), resolve(root, "vitest.config.ts")].sort().map((path) => path.replace(`${root}/`, "") + "\n" + readFileSync(path, "utf8")).join("\n"));
const metadata = {
  runId: `e2e_${randomUUID().replaceAll("-", "")}`,
  candidateSha: git("rev-parse", "HEAD"),
  backendSourceSha: git("log", "-1", "--format=%H", "--", "convex"),
  backendSourceDigest: hash(backendFiles.map((path) => path + "\n" + readFileSync(resolve(root, path), "utf8")).join("\n")),
  backendSchemaDigest: hash(readFileSync(resolve(root, "convex/schema.ts"), "utf8") + (existsSync(resolve(root, "convex/v0Schema.ts")) ? readFileSync(resolve(root, "convex/v0Schema.ts"), "utf8") : "")),
  testDiffDigest: hash(git("diff", "--", "tests", "vitest.config.ts", "native-imessage/Tests", "native-imessage/UITests", "native-imessage/TestSupport")),
  testSourceDigest,
  invocation: ["node", "tests/run-isolated.mjs", ...process.argv.slice(2)],
  repositoryRoot: root,
  target: "convex-test in-memory; denied-network Linux namespace",
  startedAt: new Date().toISOString(),
  os: { platform: process.platform, release: release(), architecture: process.arch, node: process.version },
  dependencyVersions: Object.fromEntries(["vitest", "convex-test", "convex", "@edge-runtime/vm"].map((name) => [name, JSON.parse(readFileSync(resolve(root, "node_modules", name, "package.json"), "utf8")).version])),
  backendDeployment: null,
  rulesVersion: null,
  nativeBuild: null,
  providerRunIds: [],
  operatorProof: null,
};
writeFileSync(resolve(output, "run.json"), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
writeFileSync(resolve(output, "fixtures.jsonl"), "", { mode: 0o600 });
const vitest = realpathSync(resolve(root, "node_modules/vitest/vitest.mjs"));
const guard = `const fs = require('node:fs'); const routes = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\\n'); if(routes.length !== 1) throw Error('Network namespace has routes'); const r = require('node:child_process').spawnSync(process.execPath, ${JSON.stringify([vitest, "run", "--config", resolve(root, "vitest.config.ts"), "--reporter=default", "--reporter=json", `--outputFile.json=${resolve(output, "vitest.json")}`, ...args])}, {stdio:'inherit',env:process.env}); if(r.error) throw r.error; process.exit(r.status ?? 1);`;
const result = spawnSync("unshare", ["--user", "--map-root-user", "--net", process.execPath, "-e", guard], { cwd: root, env, stdio: "inherit" });
if (result.error) throw result.error;
let evidenceOK = false;
try {
  metadata.finishedAt = new Date().toISOString();
  metadata.exitCode = result.status;
  writeFileSync(resolve(output, "run.json"), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
  const report = JSON.parse(readFileSync(resolve(output, "vitest.json"), "utf8"));
  console.log(JSON.stringify({ output, tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests }));
  const evidence = spawnSync(process.execPath, [resolve(root, "tests/tools/evidence.mjs"), resolve(output, "vitest.json"), resolve(output, "run.json"), resolve(output, "fixtures.jsonl"), resolve(output, "evidence.json")], { cwd: root, env, stdio: "inherit" });
  if (evidence.error || evidence.status !== 0) throw new Error("Evidence manifest failed");
  evidenceOK = report.numTotalTests > 0;
} catch {
  console.error("No complete assertion report; execution is blocked, not passed");
}
process.exit(evidenceOK ? result.status ?? 1 : 1);
