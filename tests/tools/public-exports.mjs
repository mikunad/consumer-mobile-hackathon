import ts from "typescript";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

export function publicExports(root) {
  const exports = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name === "_generated") continue;
      const path = resolve(dir, item.name);
      if (item.isDirectory()) { walk(path); continue; }
      if (!item.name.endsWith(".ts") || item.name.endsWith(".d.ts")) continue;
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
          const kind = declaration.initializer.expression.getText(source);
          if (["query", "mutation", "action", "httpAction"].includes(kind)) exports.push({ path: `${relative(resolve(root, "convex"), path).replace(/\.ts$/, "").replaceAll("\\", "/")}:${declaration.name.text}`, kind });
        }
      }
    }
  };
  walk(resolve(root, "convex"));
  return exports.sort((a, b) => a.path.localeCompare(b.path));
}

if (process.argv.includes("--write")) {
  const policies = JSON.parse(readFileSync(new URL("../coverage/v0-public-policies.json", import.meta.url), "utf8"));
  const inventory = publicExports(process.cwd()).map((entry) => {
    const policy = policies[entry.path];
    if (entry.path.startsWith("v0") && entry.path !== "v0Runtime:attestation" && (!policy || policy.kind !== entry.kind)) throw new Error(`Review auth/role/privacy policy and valid fixtures for ${entry.path} before updating inventory`);
    return { ...entry, requiredPolicy: entry.kind === "httpAction" ? "neutral-install-landing-no-private-reads" : entry.path === "v0Runtime:attestation" ? "anonymous-neutral-attestation" : policy ? policy.scope : "legacy-disable-or-apply-full-v0-policy", ...(policy ? { policy: policy.rule, minimumAssertions: policy.minimumAssertions } : {}), verification: "blocked-runtime-policy-matrix" };
  });
  writeFileSync(new URL("../coverage/public-exports.json", import.meta.url), JSON.stringify(inventory, null, 2) + "\n");
  console.log(JSON.stringify({ publicExports: inventory.length, runtimeVerification: "blocked" }));
}
