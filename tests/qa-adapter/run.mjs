import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const home = mkdtempSync(resolve(tmpdir(), "calledit-adapter-unit-"));
try {
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, CI: "1", NODE_ENV: "test", QA_ADAPTER_TEST_ISOLATED: "network-namespace-v1" };
  const vitest = realpathSync(resolve("node_modules/vitest/vitest.mjs"));
  const args = [vitest, "run", "--config", resolve("tests/qa-adapter/vitest.config.ts"), ...process.argv.slice(2)];
  const program = `const fs=require('node:fs');if(fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').length!==1)throw Error('No egress namespace required');const result=require('node:child_process').spawnSync(process.execPath,${JSON.stringify(args)},{env:process.env,stdio:'inherit'});if(result.error)throw result.error;process.exit(result.status??1)`;
  const result = spawnSync("unshare", ["--user", "--map-root-user", "--net", process.execPath, "-e", program], { env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(home, { recursive: true, force: true }); }
