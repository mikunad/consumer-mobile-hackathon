import { readFileSync } from "node:fs";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import { fixture, T0, type Fixture } from "./fixture";
import { noPrivateValues } from "./assertions";

type Validator = { type: string; tableName?: string; value?: unknown };
type Field = { optional: boolean; fieldType: Validator };
type Registered = { exportArgs: () => string };
const modules = import.meta.glob<Record<string, Registered>>("../../convex/**/*.ts");
const exports = JSON.parse(readFileSync("tests/coverage/public-exports.json", "utf8")) as { path: string; kind: "query" | "mutation" | "action" | "httpAction" }[];
const tables = ["users", "groups", "members", "rounds", "bets", "sessions", "pairs", "snapshots", "reactions", "stakes", "ticks", "assets"] as const;

async function state(f: Fixture) {
  return f.t.run(async (ctx) => Promise.all(tables.map((table) => ctx.db.query(table).collect())));
}

function argument(validator: Validator, f: Fixture, role: string, key: string): unknown {
  if (validator.type === "object") return Object.fromEntries(Object.entries(validator.value as Record<string, Field>).filter(([name, field]) => !field.optional || (name === "token" && role !== "anonymous")).map(([name, field]) => [name, argument(field.fieldType, f, role, name)]));
  if (validator.type === "id") {
    const ids: Record<string, string> = { users: f.actors.friend.id, groups: f.g1, rounds: f.round, bets: f.bet, snapshots: f.snapshot };
    if (!ids[validator.tableName!]) throw new Error(`Retirement fixture needs an explicit ${validator.tableName} ID`);
    return ids[validator.tableName!];
  }
  if (validator.type === "string") {
    if (key === "token") return role === "anonymous" ? "" : f.actors[role as keyof typeof f.actors].token;
    if (key === "betId") return f.bet;
    if (key === "roomId") return f.g1;
    return `synthetic_${f.runId}`;
  }
  if (validator.type === "number") return key === "now" ? T0 : 1;
  if (validator.type === "boolean") return false;
  if (validator.type === "null") return null;
  if (validator.type === "literal") return validator.value;
  if (validator.type === "array") return [];
  if (validator.type === "union") return argument((validator.value as Validator[])[0], f, role, key);
  if (validator.type === "any") return null;
  throw new Error(`Unsupported retirement argument validator ${validator.type}`);
}

describe("Canonical checkpoint: retired public APIs fail closed", () => {
  for (const entry of exports.filter((entry) => !entry.path.startsWith("v0") && entry.kind !== "httpAction")) {
    for (const role of ["anonymous", "creator", "friend", "subject", "outsider", "alias", "revoked", "new", "left"]) {
      it(`[RETIRE.${entry.path}.${role}] returns NOT_AVAILABLE before touching state`, async () => {
        const f = await fixture(true);
        const [modulePath, name] = entry.path.split(":");
        const load = modules[`../../convex/${modulePath}.ts`];
        expect(load).toBeTypeOf("function");
        const registered = (await load())[name];
        const validator = JSON.parse(registered.exportArgs()) as Validator;
        const args = argument(validator, f, role, "") as Record<string, unknown>;
        const before = await state(f);
        const call = entry.kind === "query" ? f.t.query(makeFunctionReference<"query">(entry.path), args) : entry.kind === "mutation" ? f.t.mutation(makeFunctionReference<"mutation">(entry.path), args) : f.t.action(makeFunctionReference<"action">(entry.path), args);
        let rejected = false;
        try {
          await call;
        } catch (error) {
          rejected = true;
          expect(error).toMatchObject({ data: { code: "NOT_AVAILABLE" } });
          noPrivateValues(String(error), f.privateValues);
        }
        expect(rejected).toBe(true);
        expect(await state(f)).toEqual(before);
      });
    }
  }

  for (const role of ["anonymous", "creator", "friend", "subject", "outsider", "alias", "revoked", "new", "left"] as const) {
    it(`[STATIC.hosting:serve.${role}] serves a neutral install landing and retires legacy content`, async () => {
      const f = await fixture();
      const text = "Called It · Get the app and open the original card in Messages";
      await f.t.run(async (ctx) => {
        const storageId = await ctx.storage.store(new Blob([text], { type: "text/html" }));
        await ctx.db.insert("assets", { path: "/index.html", storageId, contentType: "text/html", deployId: f.runId });
      });
      let landing: string | undefined;
      for (const path of ["/", `/c/${"a".repeat(64)}`, `/c/${"b".repeat(64)}`, `/bet/${f.bet}`, "/unregistered-proof.png"]) {
        const response = await f.t.fetch(path, { method: "GET", headers: role === "anonymous" ? {} : { Authorization: `Bearer ${f.actors[role].token}` } });
        const body = await response.text();
        const supported = path === "/" || path.startsWith("/c/");
        expect(response.status).toBe(supported ? 200 : 410);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        if (supported) {
          expect(response.headers.get("Content-Type")).toContain("text/html");
          expect(body).toContain("Get the app");
          expect(body).toContain("<button disabled>");
          expect(body).toContain("verified TestFlight invitation");
          expect(body).toContain("tap the original card");
          expect(body).not.toContain("<a href=");
          expect(body).not.toContain(text);
          expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
          expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
          landing ??= body;
          expect(body).toBe(landing);
        } else {
          expect(response.headers.get("Content-Type")?.toLowerCase()).toContain("text/plain");
          expect(body).toBe("This legacy web page is no longer available.");
        }
        noPrivateValues(body, f.privateValues);
        expect(body).not.toContain(f.runId);
      }
    });
  }

  it("[V0.runtime-neutral] exposes only neutral unconfigured metadata with no test switch", async () => {
    const f = await fixture();
    const result = await f.t.query(api.v0Runtime.attestation, {});
    expect(result).toEqual({ app: "called-it", contractVersion: "v0.2", schemaVersion: "v0.2", environment: "unconfigured", sourceSha: null, deploymentId: null, configVersion: null, testAdapters: false });
    noPrivateValues(result, f.privateValues);
  });
});
