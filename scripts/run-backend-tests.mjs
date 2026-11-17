import { spawnSync } from "node:child_process";

const env = {};
for (const name of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "CI", "TZ", "SystemRoot"]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
env.EXPO_NO_DOTENV = "1";
env.NODE_ENV = "test";
const args = process.argv.slice(2).filter((arg) => arg !== "--run");
const result = spawnSync(process.execPath, ["tests/run-isolated.mjs", ...args], {
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
