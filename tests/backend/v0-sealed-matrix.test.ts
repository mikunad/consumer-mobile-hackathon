import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { publicApiPolicy } from "../../convex/v0ApiPolicy";
import { contractCases, invoke } from "./contract-cases";
import { v0Fixture } from "./v0-fixture";

const policies = JSON.parse(readFileSync("tests/coverage/v0-public-policies.json", "utf8")) as Record<string, unknown>;
const sealedRoles = ["anonymous", "revoked", "outsider", "unadmittedAlias", "new", "left", "subject", "alias"] as const;
const eligibleRoles = ["creator", "friend"] as const;
const eligibleQuestionReads = ["v0Bets:get", "v0Bets:list"];

function text(value: unknown): string {
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  if (value instanceof Error) return `${String(value)} ${text((value as { data?: unknown }).data)}`;
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (value !== null && typeof value === "object") return Object.entries(value).map(([key, entry]) => `${key} ${text(entry)}`).join(" ");
  return String(value);
}

async function response(path: string, token: string, f: Awaited<ReturnType<typeof v0Fixture>>) {
  try {
    return text(await invoke(f, path, token));
  } catch (error) {
    expect(String(error)).not.toMatch(/(?:TypeError|ReferenceError|Could not find|ArgumentValidationError)/);
    return text(error);
  }
}

describe("SEC1 sealed-bet sentinel matrix over every canonical V0 export", () => {
  it("[SEC1.matrix-inventory] covers exactly the reviewed canonical exports", () => {
    expect(Object.keys(contractCases).sort()).toEqual(Object.keys(policies).sort());
    for (const path of eligibleQuestionReads) expect(policies[path]).toBeDefined();
  });

  it("[SEC1.policy-source] keeps the backend policy declaration in step with every registered public export", () => {
    const inventory = JSON.parse(readFileSync("tests/coverage/public-exports.json", "utf8")) as { path: string }[];
    expect(Object.keys(publicApiPolicy).sort()).toEqual(inventory.map((entry) => entry.path).sort());
    for (const [path, policy] of Object.entries(publicApiPolicy)) {
      expect(policy === "retired").toBe(!path.startsWith("v0") && path !== "hosting:serve");
    }
  });

  for (const path of Object.keys(policies)) {
    for (const role of sealedRoles) {
      it(`[SEC1.sealed.${path}.${role}] returns no sealed question, option, context or proof before reveal`, async () => {
        const f = await v0Fixture();
        const token = role === "anonymous" ? "synthetic_anonymous" : f.actors[role].token;
        const body = await response(path, token, f);
        for (const sentinel of f.privateValues) expect(body).not.toContain(sentinel);
        expect(body).not.toContain(token);
      });
    }

    for (const role of eligibleRoles) {
      it(`[SEC1.eligible.${path}.${role}] returns the question only from bet reads and never context or proof before reveal`, async () => {
        const f = await v0Fixture();
        const body = await response(path, f.actors[role].token, f);
        const [question, optionA, optionB, context, proof] = f.privateValues;
        expect(body).not.toContain(context);
        expect(body).not.toContain(proof);
        expect(body).not.toContain(f.actors[role].token);
        for (const sentinel of [question, optionA, optionB]) expect(body.includes(sentinel)).toBe(eligibleQuestionReads.includes(path));
      });
    }
  }
});
