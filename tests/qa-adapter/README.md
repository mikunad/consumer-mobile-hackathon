# External QA adapter factory

This is test-only transport/provisioning plumbing, not a deployed server or a
working native/backend E2E lane. No business implementation or provider behavior
is supplied. `fixtures.ts` contains explicitly labelled plumbing stubs used only
by unit tests. A missing actual dispatcher/fixture setup fails `AdapterBlocked`;
there is no success fallback.

## What is implemented

- `manifest.ts` validates the exact frozen native QA manifest: at most 16 KiB
  UTF-8 JSON, exact required fields/types, UUID run/simulator, independent 40-hex
  native/backend revisions, deployment/config/fixture pins, one-hour maximum
  validity, and numeric `http://127.0.0.1:<1024..65535>` origins only. It hashes
  the original bytes, not parsed/re-encoded JSON. Independent `ExpectedRun` pins
  must come from the provisioner/build record, not be inferred from the manifest.
- `dispatcher.ts` binds an explicit allowlist to actual imported public Convex
  registrations and their query/mutation/action markers. Internal, legacy,
  fixture/reset/clock/debug/admin/test-control paths are rejected. A dispatcher
  must be created by that registry, not supplied as an arbitrary `has()` object.
  `v0Auth:redeemPair` is an action. The invoke callback must run the real registered
  handler through the backend/convex-test runtime, not call `_handler` directly.
- `adapter.ts` handles only POST `/api/query`, `/api/mutation`, `/api/action` at
  the pinned origin/Host. It requires the run/hash headers and rejects proxies,
  foreign Origin, cookies/admin Authorization, client `now`, unsupported codecs,
  malformed bodies and unallowlisted/wrong-kind functions. Requests are bounded
  at 768 KiB, responses at 1 MiB, JSON depth at 32, values at 20,000 nodes and
  aggregate ArrayBuffer content at 512 KiB. No request/response arguments,
  credentials or backend logs are printed.
- Request bodies use the installed official `jsonToConvex` on exactly
  `{path,args:[convexToJson(args)],format:"convex_encoded_json"}`. Results use
  official `convexToJson`; there is no copied `$bytes`/Int64/float decoder or
  game/auth policy. Structured Convex UDF failures use HTTP 560. Only known safe
  error codes and fixed neutral messages survive; private messages, extra data,
  stack traces and log lines are not forwarded. Unknown failures are generic.
- Only exact `v0Runtime:attestation` query with empty args receives the special
  frozen QA attestation: v0.2/local, manifest backend/deployment/config pins,
  `testAdapters:true`, run ID and SHA256 of raw manifest bytes. No general fake
  query/mutation/action endpoint is added.

## Required runtime dependencies — currently blocked

`createQAAdapter()` requires explicit `mode`. `plumbing-unit` permits in-process
stub tests but **cannot listen on a socket**. `simulator-runtime` requires all of:

1. A current manifest and independent expected pins from the exact native/backend
   builds and dedicated simulator. Runtime lifetime uses real server time; the
   unit clock option is rejected in runtime mode. Inherited provider/deployment
   credentials must be absent.
2. An externally recorded provisioning receipt plus its backing artifacts and a
   **separate trusted provenance verifier**, described below. Manifest booleans
   alone are insufficient. The factory does not create/erase simulators, inspect
   Messages, configure a sandbox/firewall or prove outbound denial itself.
3. An `initializeRun({manifest,resources})` callback that creates a fresh isolated
   database/fixtures/storage/outbox, denies all outbound provider access and
   returns a `RunBinding` with `execution:"real-handlers"`, exact run/backend/
   fixture pins, the validated public dispatcher and a cleanup callback.
   `requiredFunctions` must include the actual functions needed by the fixture
   set, including at least one business function. Empty/unknown/unavailable
   bindings and `execution:"plumbing-stub"` cannot start a runtime server.
4. The canonical real business exports and matching fixture setup. This slice
   does not implement the pending business APIs, fake their behavior, accept a
   display-name identity or provide OTP/APNs/LLM/storage provider replacements.
   The binding owner must use the real exported handlers, their schema/argument
   validation and their own explicit isolated provider seams. A `convex-test`
   binding is real handler execution but is still not a real-backend HTTP lane.

Each initialization receives fresh `resources.storage` and `resources.outbox`;
teardown clears them and invokes the binding's own database/storage/job cleanup.
A runtime run ID cannot be reinitialized in the same process, including after a
failed initialization. Do not restart an adapter with a fresh database under a
stale activation; get new external provisioning evidence/run instead. External
provisioning must also prevent stale reuse across processes. An invoker must
honor AbortSignal; timeout/cancellation is blocked, not proof that an underlying
transaction was rolled back.

After dependencies are real, call `createQAAdapter({...})`, then `.listen()`.
The only listener is `127.0.0.1` at the manifest's explicit API port, never `0`,
`localhost`, `::`, a public interface or a fallback port. `.close()` disposes the
run. There is deliberately no CLI that starts a stub server and no deployment.
Card-origin `/c/` fallback hosting/install continuity is not implemented here.

## External provisioning receipt

This adapter-local receipt is separate from the frozen native manifest and is
never injected into the app or exposed by HTTP. The caller supplies an absolute,
non-symlink receipt path, at most 32 KiB, containing exactly:

```ts
{
  version: 1,
  runID, simulatorUDID, nativeSourceRevision, backendSourceRevision, fixtureSetID,
  hostBundleID: "com.mikunad.calledit.qa.host",
  extensionBundleID: "com.mikunad.calledit.qa.host.messages",
  manifestSHA256,
  recordedAt, // epoch milliseconds, current run only
  artifacts: [
    { kind: "simulator-created", file, sha256 },
    { kind: "simulator-erased", file, sha256 },
    { kind: "empty-state-verified", file, sha256 },
    { kind: "outbound-denied", file, sha256 }
  ]
}
```

All pins must match the manifest. Artifact files must be nonempty regular files
beside the receipt, no symlinks/traversal, at most 1 MiB each, with matching hashes.
They must be actual external simulator-create/erase/empty-state and enforced
outbound-denial records, never personal history or credentials. Hash checks
establish integrity only, **not truth of the recorded commands**. A trusted
operator/provisioner verifier receives those artifacts and must approve their
provenance with a bounded verification ID. No default verifier auto-approves them.
The unit tests use conspicuously marked fabricated artifacts and a fake verifier;
they are not usable device/provisioning evidence.

## Checks and evidence boundaries

From the repository root:

```sh
node tests/qa-adapter/run.mjs
node node_modules/typescript/bin/tsc --project tests/qa-adapter/tsconfig.json
node node_modules/eslint/bin/eslint.js tests/qa-adapter
```

The test launcher allowlists environment variables, creates a temporary test home
and runs Vitest in a Linux network namespace without egress routes. Tests never
listen on a TCP socket; the official ConvexHttpClient uses its injected fetch to
route requests directly to the Request/Response handler. Global fetch fails by
default. No provider, production deployment, simulator, phone or remote build is
used. The repository root test configuration is not modified by this slice.

Assertion groups: `QA-MANIFEST-*`, `QA-DISPATCH-*`, `QA-EVIDENCE-*`, `QA-HTTP-*`,
`QA-SERIALIZATION-*`, `QA-ERROR-*`, `QA-LIFETIME-*`. These check guards, actual
SDK wire/value encoding (including 512 KiB ArrayBuffer), safe HTTP UDF errors,
fresh resource lifecycle and blocked missing dependencies. They do not execute
auth/game business handlers: only the actual runtime export's registration is
inspected, and the frozen special attestation is intentionally generated locally.
No passing plumbing test proves native UI, signed shared storage, real handler
policies, actual backend HTTP serialization, provider delivery, Messages privacy/
transport or after-install return. Those remain separate blocked lanes.
