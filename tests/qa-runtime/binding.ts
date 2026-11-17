import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import * as v0Auth from "../../convex/v0Auth";
import * as v0Bets from "../../convex/v0Bets";
import * as v0Controls from "../../convex/v0Controls";
import * as v0Groups from "../../convex/v0Groups";
import * as v0Notifications from "../../convex/v0Notifications";
import * as v0Proof from "../../convex/v0Proof";
import * as v0Runtime from "../../convex/v0Runtime";
import * as v0Suggestions from "../../convex/v0Suggestions";
import { createPublicDispatcher, type AllowedFunction, type InitializeRun } from "../qa-adapter/dispatcher";
import { AdapterBlocked } from "../qa-adapter/manifest";
import { CARD_RESULT_PATHS, type BoundedCardRouting } from "./routing";

const modules = { v0Auth, v0Bets, v0Controls, v0Groups, v0Notifications, v0Proof, v0Runtime, v0Suggestions };

export function officialBackendBinding(options: {
  backendOrigin: string;
  allowlist: readonly AllowedFunction[];
  backendSourceRevision: string;
  fixtureSetID: string;
  seedFreshFixture: (runID: string, fixtureSetID: string) => Promise<void>;
  dispose: () => Promise<void>;
  verifyIsolation: () => Promise<void>;
  routingOverlay?: BoundedCardRouting;
}): InitializeRun {
  const target = new URL(options.backendOrigin);
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(options.backendOrigin) || target.port === "0" || Number(target.port) < 1024) throw new AdapterBlocked();
  const client = new ConvexHttpClient(options.backendOrigin, { logger: false, skipConvexDeploymentUrlCheck: true, fetch: async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== options.backendOrigin || !["/api/query", "/api/mutation", "/api/action"].includes(url.pathname) || url.search || url.hash || url.username || url.password || request.headers.has("authorization")) throw new AdapterBlocked();
    return fetch(request, { redirect: "error", signal: AbortSignal.timeout(10000) });
  } });
  return async ({ manifest }) => {
    if (manifest.backendSourceRevision !== options.backendSourceRevision || manifest.fixtureSetID !== options.fixtureSetID || typeof options.verifyIsolation !== "function") throw new AdapterBlocked();
    await options.verifyIsolation();
    const attestation = await client.query(makeFunctionReference<"query">("v0Runtime:attestation"), {});
    if (attestation.app !== "called-it" || attestation.contractVersion !== "v0.2" || attestation.schemaVersion !== "v0.2" || attestation.environment !== "local" ||
        attestation.sourceSha !== options.backendSourceRevision || attestation.deploymentId !== manifest.deploymentID || attestation.configVersion !== manifest.configVersion || attestation.testAdapters !== false) throw new AdapterBlocked();
    await options.seedFreshFixture(manifest.runID, manifest.fixtureSetID);
    const dispatcher = createPublicDispatcher({ modules, allowlist: options.allowlist, invoke: async ({ kind, path, args, signal }) => {
      if (signal.aborted) throw new AdapterBlocked();
      await options.verifyIsolation();
      if (signal.aborted) throw new AdapterBlocked();
      let value: Value;
      if (kind === "query") value = await client.query(makeFunctionReference<"query">(path), args) as Value;
      else if (kind === "mutation") value = await client.mutation(makeFunctionReference<"mutation">(path), args, { skipQueue: true }) as Value;
      else value = await client.action(makeFunctionReference<"action">(path), args) as Value;
      return options.routingOverlay && CARD_RESULT_PATHS.has(path) ? options.routingOverlay.rewrite(path, value) : value;
    } });
    return { execution: "real-handlers", runID: manifest.runID, backendSourceRevision: options.backendSourceRevision, fixtureSetID: options.fixtureSetID, freshDatabase: true, outboundNetworkDenied: true, dispatcher, dispose: options.dispose };
  };
}
