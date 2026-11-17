import type { Value } from "convex/values";
import { AdapterBlocked, canonicalUUID, type Manifest } from "./manifest";

export type FunctionKind = "query" | "mutation" | "action";
export type AllowedFunction = Readonly<{ path: string; kind: FunctionKind }>;
export type FunctionArguments = Record<string, Value>;

export type RegisteredExport = ((...args: never[]) => unknown) & {
  isPublic?: boolean;
  isInternal?: boolean;
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
};

export type Invocation = Readonly<AllowedFunction & {
  args: FunctionArguments;
  registration: RegisteredExport;
  signal: AbortSignal;
}>;

const publicDispatchers = new WeakSet<object>();

export function allowedPath(path: string): boolean {
  if (path === "v0Runtime:attestation") return true;
  return /^v0[A-Z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9]*$/.test(path) &&
    !/(?:legacy|internal|fixture|seed|clock|debug|admin|test|:reset)/i.test(path);
}

export function createPublicDispatcher(options: {
  modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  allowlist: readonly AllowedFunction[];
  invoke: (invocation: Invocation) => Promise<Value>;
}) {
  if (!options?.modules || !options.allowlist?.length || typeof options.invoke !== "function") throw new AdapterBlocked();
  const registrations = new Map<string, Readonly<AllowedFunction & { registration: RegisteredExport }>>();
  for (const entry of options.allowlist) {
    if (!entry || !allowedPath(entry.path) || !["query", "mutation", "action"].includes(entry.kind) || registrations.has(entry.path)) throw new AdapterBlocked();
    const [module, name] = entry.path.split(":");
    const moduleExports = options.modules[module];
    if (!Object.hasOwn(options.modules, module) || !moduleExports || !Object.hasOwn(moduleExports, name)) throw new AdapterBlocked();
    const exported = moduleExports[name] as RegisteredExport | undefined;
    const kinds = [exported?.isQuery, exported?.isMutation, exported?.isAction];
    const index = ["query", "mutation", "action"].indexOf(entry.kind);
    if (typeof exported !== "function" || exported.isPublic !== true || exported.isInternal === true ||
        kinds.filter((marker) => marker === true).length !== 1 || kinds[index] !== true) throw new AdapterBlocked();
    registrations.set(entry.path, Object.freeze({ ...entry, registration: exported }));
  }
  if (registrations.get("v0Runtime:attestation")?.kind !== "query") throw new AdapterBlocked();
  const dispatcher = Object.freeze({
    has(kind: FunctionKind, path: string) { return registrations.get(path)?.kind === kind; },
    async dispatch(kind: FunctionKind, path: string, args: FunctionArguments, signal: AbortSignal) {
      const registered = registrations.get(path);
      if (!registered || registered.kind !== kind || !allowedPath(path)) throw new AdapterBlocked();
      return options.invoke(Object.freeze({ ...registered, args, signal }));
    },
    publicFunctions: Object.freeze([...registrations.values()].map(({ path, kind }) => Object.freeze({ path, kind }))),
  });
  publicDispatchers.add(dispatcher);
  return dispatcher;
}

export type RunResources = Readonly<{
  runID: string;
  storage: Map<string, ArrayBuffer>;
  outbox: Value[];
}>;

export type RunBinding = Readonly<{
  execution: "real-handlers" | "plumbing-stub";
  runID: string;
  backendSourceRevision: string;
  fixtureSetID: string;
  freshDatabase: true;
  outboundNetworkDenied: true;
  dispatcher: ReturnType<typeof createPublicDispatcher>;
  dispose: () => Promise<void>;
}>;

export type InitializeRun = (context: Readonly<{ manifest: Manifest; resources: RunResources }>) => Promise<RunBinding>;

export function assertBinding(binding: RunBinding, manifest: Manifest, runtime: boolean): void {
  if (!binding || canonicalUUID(binding.runID) !== canonicalUUID(manifest.runID) ||
      binding.backendSourceRevision !== manifest.backendSourceRevision || binding.fixtureSetID !== manifest.fixtureSetID ||
      binding.freshDatabase !== true || binding.outboundNetworkDenied !== true || typeof binding.dispose !== "function" ||
      !binding.dispatcher || !publicDispatchers.has(binding.dispatcher) || !binding.dispatcher.has("query", "v0Runtime:attestation") ||
      !["real-handlers", "plumbing-stub"].includes(binding.execution) || (runtime && binding.execution !== "real-handlers")) throw new AdapterBlocked();
}
