import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ConvexError, convexToJson, jsonToConvex, type JSONValue, type Value } from "convex/values";
import { AdapterBlocked, InvalidManifest, assertManifestLive, canonicalUUID, parseManifest, type ExpectedRun } from "./manifest";
import { allowedPath, assertBinding, type FunctionArguments, type FunctionKind, type InitializeRun, type RunBinding, type RunResources } from "./dispatcher";
import { verifyProvisioning, type ProvisioningVerifier } from "./evidence";

export const MAX_BODY_BYTES = 786_432;
export const MAX_RESPONSE_BYTES = 1_048_576;
export const MAX_BINARY_BYTES = 512 * 1024;
const routes = new Map<string, FunctionKind>([["/api/query", "query"], ["/api/mutation", "mutation"], ["/api/action", "action"]]);
const initializedRuntimeRuns = new Set<string>();
const messages: Record<string, string> = {
  AUTH_REQUIRED: "Sign in again.", FORBIDDEN: "This request is not available.", NOT_AVAILABLE: "This request is not available.",
  INVALID_INPUT: "Check your request.", RATE_LIMITED: "Please wait before trying again.", CONFLICT: "Refresh before trying again.",
  IDEMPOTENCY_CONFLICT: "Refresh before trying again.", POLICY_PENDING: "The group rules are awaiting approval.",
  PROVIDER_UNAVAILABLE: "This service is temporarily unavailable.", UNKNOWN: "The request could not be completed.",
};

class RejectedRequest extends Error {
  constructor(readonly status: number, readonly code = "INVALID_INPUT") { super("Rejected isolated QA request"); }
}

function response(status: number, value: JSONValue): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new RejectedRequest(500, "UNKNOWN");
  return new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function failure(status: number, code: string): Response {
  const message = messages[code] ?? messages.UNKNOWN;
  return response(status, { status: "error", errorMessage: message, errorData: convexToJson({ code, message }), logLines: [] });
}

function safeUDFCode(error: ConvexError<Value>): string {
  let data: unknown = error.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { data = { code: data }; }
  }
  const code = data && typeof data === "object" && "code" in data ? (data as { code: unknown }).code : undefined;
  return typeof code === "string" && Object.hasOwn(messages, code) ? code : "UNKNOWN";
}

function boundedTree(value: unknown): void {
  let count = 0;
  let binaryBytes = 0;
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number) => {
    if (++count > 20_000 || depth > 32) throw new RejectedRequest(400);
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) throw new RejectedRequest(400);
    seen.add(node);
    if (node instanceof ArrayBuffer) {
      binaryBytes += node.byteLength;
      if (binaryBytes > MAX_BINARY_BYTES) throw new RejectedRequest(413);
      seen.delete(node);
      return;
    }
    for (const [key, item] of Object.entries(node)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new RejectedRequest(400);
      walk(item, depth + 1);
    }
    seen.delete(node);
  };
  walk(value, 0);
}

async function readRequestBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new RejectedRequest(413);
  if (!request.body) throw new RejectedRequest(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RejectedRequest(413);
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  if (length !== null && Number(length) !== size) throw new RejectedRequest(400);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const parsed: unknown = JSON.parse(text);
    boundedTree(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof RejectedRequest) throw error;
    throw new RejectedRequest(400);
  }
}

function requestArguments(body: unknown): { path: string; args: FunctionArguments } {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).sort().join("\0") !== "args\0format\0path") throw new RejectedRequest(400);
  const envelope = body as { path: unknown; args: unknown; format: unknown };
  if (typeof envelope.path !== "string" || !allowedPath(envelope.path) || envelope.format !== "convex_encoded_json" ||
      !Array.isArray(envelope.args) || envelope.args.length !== 1) throw new RejectedRequest(400);
  let args: Value;
  try { args = jsonToConvex(envelope.args[0] as JSONValue); } catch { throw new RejectedRequest(400); }
  if (!args || typeof args !== "object" || Array.isArray(args) || args instanceof ArrayBuffer || Object.hasOwn(args, "now")) throw new RejectedRequest(400);
  boundedTree(args);
  return { path: envelope.path, args: args as FunctionArguments };
}

export type AdapterOptions = {
  mode: "simulator-runtime" | "plumbing-unit";
  manifestBytes: Uint8Array;
  expected: ExpectedRun;
  initializeRun: InitializeRun;
  requiredFunctions: readonly { path: string; kind: FunctionKind }[];
  provisioning?: { path: string; verify: ProvisioningVerifier };
  now?: () => number;
};

export async function createQAAdapter(options: AdapterOptions) {
  if (options.mode === "simulator-runtime" && options.now !== undefined) throw new AdapterBlocked();
  const now = options.now ?? Date.now;
  const context = parseManifest(options.manifestBytes, options.expected, now());
  const runtime = options.mode === "simulator-runtime";
  if (!["simulator-runtime", "plumbing-unit"].includes(options.mode) || typeof options.initializeRun !== "function" ||
      !options.requiredFunctions?.length || !options.requiredFunctions.some(({ path }) => path !== "v0Runtime:attestation")) throw new AdapterBlocked();
  if (runtime) {
    if (Object.entries(process.env).some(([key, value]) => value && /(?:KEY|SECRET|TOKEN|PASSCODE|CONVEX.*(?:URL|DEPLOY)|TWILIO|APNS)/i.test(key))) throw new AdapterBlocked();
    if (!options.provisioning) throw new AdapterBlocked();
    await verifyProvisioning({ ...options.provisioning, manifest: context, now: now() });
    const identity = canonicalUUID(context.manifest.runID);
    if (initializedRuntimeRuns.has(identity)) throw new AdapterBlocked();
    initializedRuntimeRuns.add(identity);
  }
  const resources: RunResources = Object.freeze({ runID: context.manifest.runID, storage: new Map(), outbox: [] });
  let initialized: RunBinding | undefined;
  try {
    initialized = await options.initializeRun(Object.freeze({ manifest: context.manifest, resources }));
    assertBinding(initialized, context.manifest, runtime);
    for (const entry of options.requiredFunctions) {
      if (!allowedPath(entry.path) || !initialized.dispatcher.has(entry.kind, entry.path)) throw new AdapterBlocked();
    }
  } catch {
    try {
      if (typeof initialized?.dispose === "function") await initialized.dispose().catch(() => undefined);
    }
    finally { resources.storage.clear(); resources.outbox.length = 0; }
    throw new AdapterBlocked();
  }
  const binding = initialized;
  let disposed = false;
  let listening = false;
  const controllers = new Set<AbortController>();

  const handle = async (request: Request): Promise<Response> => {
    try {
      if (disposed) throw new AdapterBlocked();
      assertManifestLive(context.manifest, now());
      const url = new URL(request.url);
      const kind = routes.get(url.pathname);
      if (request.method !== "POST" || !kind || url.origin !== context.apiOrigin || url.search || url.hash || url.username || url.password ||
          request.headers.get("host") !== new URL(context.apiOrigin).host) throw new RejectedRequest(404, "NOT_AVAILABLE");
      if (["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "proxy-authorization", "authorization", "cookie"].some((name) => request.headers.has(name))) throw new RejectedRequest(403, "NOT_AVAILABLE");
      const origin = request.headers.get("origin");
      if (origin && ![context.apiOrigin, context.cardOrigin].includes(origin)) throw new RejectedRequest(403, "NOT_AVAILABLE");
      const run = request.headers.get("x-calledit-qa-run-id");
      try {
        if (!run || canonicalUUID(run) !== canonicalUUID(context.manifest.runID) || request.headers.get("x-calledit-qa-manifest-sha256") !== context.sha256) throw new RejectedRequest(403, "NOT_AVAILABLE");
      } catch { throw new RejectedRequest(403, "NOT_AVAILABLE"); }
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "") ||
          request.headers.has("content-encoding")) throw new RejectedRequest(415);
      const { path, args } = requestArguments(await readRequestBody(request));
      if (!binding.dispatcher.has(kind, path)) throw new RejectedRequest(404, "NOT_AVAILABLE");
      if (path === "v0Runtime:attestation") {
        if (kind !== "query" || Object.keys(args).length) throw new RejectedRequest(400);
        return response(200, { status: "success", logLines: [], value: convexToJson({
          app: "called-it", contractVersion: "v0.2", schemaVersion: "v0.2", environment: "local",
          sourceSha: context.manifest.backendSourceRevision, deploymentId: context.manifest.deploymentID,
          configVersion: context.manifest.configVersion, testAdapters: true, qaRunID: context.manifest.runID, qaManifestSHA256: context.sha256,
        }) });
      }
      if (request.signal.aborted) throw new AdapterBlocked();
      const controller = new AbortController();
      controllers.add(controller);
      const abort = () => controller.abort();
      request.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 5_000);
      let cancelled: (() => void) | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          cancelled = () => reject(new AdapterBlocked());
          controller.signal.addEventListener("abort", cancelled, { once: true });
          if (request.signal.aborted || controller.signal.aborted) controller.abort();
        });
        const value = await Promise.race([binding.dispatcher.dispatch(kind, path, args, controller.signal), timeout]);
        try {
          boundedTree(value);
          assertManifestLive(context.manifest, now());
          return response(200, { status: "success", value: convexToJson(value), logLines: [] });
        } catch { throw new RejectedRequest(500, "UNKNOWN"); }
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        if (cancelled) controller.signal.removeEventListener("abort", cancelled);
        controllers.delete(controller);
      }
    } catch (error) {
      if (error instanceof RejectedRequest) return failure(error.status, error.code);
      if (error instanceof ConvexError) return failure(560, safeUDFCode(error));
      if (error instanceof AdapterBlocked || error instanceof InvalidManifest) return failure(503, "UNKNOWN");
      return failure(500, "UNKNOWN");
    }
  };

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const controller of controllers) controller.abort();
    try { await binding.dispose(); }
    catch { throw new AdapterBlocked(); }
    finally { resources.storage.clear(); resources.outbox.length = 0; }
  };

  const listen = async () => {
    if (!runtime || disposed || listening) throw new AdapterBlocked();
    assertManifestLive(context.manifest, now());
    const port = Number(new URL(context.apiOrigin).port);
    const server = createServer({ maxHeaderSize: 8_192 }, (incoming, outgoing) => {
      void serve(incoming, outgoing, context.apiOrigin, handle).catch(() => {
        if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ status: "error", errorMessage: messages.UNKNOWN, logLines: [] }));
      });
    });
    server.headersTimeout = 5_000;
    server.requestTimeout = 10_000;
    server.keepAliveTimeout = 1_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
          server.removeListener("error", reject);
          listening = true;
          resolve();
        });
      });
    } catch { await dispose(); throw new AdapterBlocked(); }
    return Object.freeze({
      origin: context.apiOrigin,
      close: async () => {
        try { await dispose(); }
        finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(new AdapterBlocked()) : resolve())); }
      },
    });
  };

  return Object.freeze({ handle, listen, dispose, mode: options.mode });
}

async function serve(incoming: IncomingMessage, outgoing: ServerResponse, origin: string, handle: (request: Request) => Promise<Response>) {
  if (incoming.socket.remoteAddress !== "127.0.0.1" || incoming.method !== "POST" || !routes.has(incoming.url ?? "")) {
    outgoing.writeHead(404).end();
    return;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of incoming) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) { outgoing.writeHead(413).end(); return; }
    chunks.push(chunk);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
  }
  const body = new Uint8Array(Buffer.concat(chunks));
  const request = new Request(origin + incoming.url, { method: incoming.method, headers, body: body.length ? body : undefined });
  const result = await handle(request);
  outgoing.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  outgoing.end(Buffer.from(await result.arrayBuffer()));
}
