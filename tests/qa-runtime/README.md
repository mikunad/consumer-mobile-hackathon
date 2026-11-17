# Isolated official backend binding

This test-only harness runs the official Convex OSS backend with the repository's actual registered V0 handlers. Phone auth keeps its fixed HTTPS Twilio URL and its real retry, verification, replay and session policies. A local CONNECT/TLS transport supplies synthetic provider responses; it does not replace those handlers. Nothing here authorizes a production deployment or provides native UI, physical-device, real-provider or full-V0 readiness evidence.

## Pins and prerequisites

`binary-pins.json` pins the official release URL, upstream commit, archive digest and extracted executable digest separately for Linux x64 and Darwin arm64. The Darwin archive digest matched the official GitHub release API and downloaded bytes; the extracted executable was hashed on Linux, not executed on macOS. Do not pass an archive digest as `expectedBinarySHA256`, and do not use the Linux executable hash on a Mac.

Download the Darwin arm64 asset before applying egress denial, without using deployment credentials:

```sh
mkdir -p "$HOME/.capy/work"
TOOLCHAIN="$(mktemp -d "$HOME/.capy/work/qt-XXXXXX")"
curl --disable --fail --location --proto '=https' --tlsv1.2 \
  'https://github.com/convex/convex-backend/releases/download/precompiled-2026-10-22-1447815/convex-local-backend-aarch64-apple-darwin.zip' \
  --output "$TOOLCHAIN/backend.zip"
printf '9caa539df14dff09317c1f1c22714ed77640e2e4a18ef630bc368fe8c6bb65df  %s\n' "$TOOLCHAIN/backend.zip" | shasum -a 256 --check
unzip -p "$TOOLCHAIN/backend.zip" convex-local-backend > "$TOOLCHAIN/convex-local-backend"
printf 'a19fa79daa71902491ac2fef6af7fb8e6137f68fa0600f24ec86915a1c6c3614  %s\n' "$TOOLCHAIN/convex-local-backend" | shasum -a 256 --check
chmod 700 "$TOOLCHAIN/convex-local-backend"
```

Stop if either digest differs. Extraction is not runtime verification. macOS still needs a real backend startup, actual HTTPS trust-path verification, an erased simulator and verified PF isolation before native credit is possible.

Use installed repository dependencies, Node 24, OpenSSL 3, and a writable short canonical scratch parent outside the repository. The complete scratch path plus 45 bytes must be shorter than 104 bytes because the backend executor uses a Unix socket. Resolve macOS `/var` or `/tmp` symlinks before constructing the fresh scratch path. No dependency installation, download or network-enabled setup belongs inside an isolated run.

`run.mjs` pins backend revision `7450eed9f957261ab4bcd19cf19cb42506823c32` and independently compares every actual canonical backend file with that commit before execution. Native revision `00e5cf219c0d4329d806867f4dcf6aaec54a986d` is an owner-supplied input, not executed by this Linux lane. Evidence records the candidate, before/after product digests, private fixture-overlay digest and all executed harness hashes. Environment attestation alone does not prove a Git checkout; native build/config provenance is separate.

## Portable lifecycle

`bootOfficialBackend` in `bootstrap.mjs`, typed by `bootstrap.d.mts`, requires an absolute repository root, fresh short external directory, executable plus its expected hash, exact manifest run ID, supported fixture-set ID, independent backend revision/config version and a mandatory `verifyIsolation` callback. It calls that callback before startup and again before seeding. The callback must independently verify current host isolation; a boolean, environment marker or fabricated receipt is not sufficient for native use.

The fixed numeric-loopback ports are:

| Service | Port |
| --- | --- |
| Official backend | 3210 |
| Official site/card fallback | 3211 |
| Guarded QA gateway | 8199 |
| Strict provider CONNECT fixture | 43128 |
| Provider TLS fixture | 43129 |

The bootstrap copies only `convex/` into private scratch, adds INTERNAL fixture controls and a scratch-only empty cron schedule, creates an empty local database, and pushes with the installed official Convex CLI. It generates local admin credentials, pepper and CA private keys privately. Child environments are allowlisted; inherited deployment/provider credentials are not forwarded. Provider settings are visibly synthetic constants, and `SSL_CERT_FILE` verifies a fresh CA for `verify.twilio.com`; there is no insecure TLS bypass. The CONNECT fixture accepts only that exact host/port, tunnels only to its local TLS server, and validates TLS SNI, Host, fixed Twilio paths, synthetic auth, request fields and reserved fixture actors.

The native launch owner must assemble the following sequence in its own wrapper. Bundle the TypeScript binding/adapter using the installed esbuild; no root package or product configuration change is necessary.

1. Before changing global PF, independently establish and log that the runner is dedicated, ephemeral and exclusive to this job, with safe bounded owned-state restoration. Capability, UID, empty PF state or a caller boolean does not establish exclusivity; refuse the lane if the trusted controller cannot prove it. Verify independent native/backend/config pins, establish real PF egress denial, then create and erase a fresh simulator. Obtain a receipt plus its independent trusted verifier using the launch/provisioning contract. Revalidate current isolation in `verifyIsolation` rather than trusting the receipt alone.
2. Construct and validate the frozen manifest using the shared adapter manifest parser. Its only application activation values remain `CALLED_IT_QA_RUN_ID` and `CALLED_IT_QA_MANIFEST_BASE64`; do not add a phone, OTP, session token, provider credential or routing source origin.
3. Boot the official backend with the executable hash for the actual platform. Keep its handle private. Do not print, serialize or expose its privileged closures to the app or gateway.
4. Build `officialBackendBinding` with `backendOrigin: local.origin`, the pinned public-function allowlist, `backendSourceRevision`, `fixtureSetID`, `verifyIsolation`, `seedFreshFixture: async (runID, set) => { await local.seedFreshFixture(runID, set); }`, and `dispose: async () => { await local.close(); }`. The binding validates actual imported registration objects and queries the real backend attestation before seeding; source/deployment/config/local-contract mismatches fail closed. Business requests use an unauthenticated official HTTP client with user tokens only in business arguments, never the admin client.
5. Create the guarded adapter in `simulator-runtime` mode with raw manifest bytes, independently pinned expectations, required functions and the real provisioning receipt/verifier. Only this mode can listen. The Linux proof uses `plumbing-unit` mode and cannot listen.
6. If the separately approved bounded card overlay is needed, activate it as described below before serving card-returning requests. Start the gateway only after receipt, attestation and isolation checks succeed. Sign in through actual UI/phone handlers; no session is seeded.
7. Always dispose the adapter, close the local backend and remove private state in a `finally` block. `close()` is idempotent, closes TLS/CONNECT servers, removes scratch after confirmed backend termination and returns redacted diagnostics. The default and composed runtime mode is `processGroupMode: "supervised"`: the backend inherits the registered wrapper's process group, and cleanup signals only that owned backend PID, with bounded TERM/KILL waits. It never signals the controller's whole group. The controller must independently verify/reap all registered-group descendants, including executors, before releasing PF; local cleanup alone cannot establish that. Only the namespace-isolated Linux proof explicitly selects `"independent"`, which starts/kills its own separate backend process group. Register any minted session tokens with `local.markSensitive` before retaining diagnostics. The wrapper owns simulator and PF teardown and must verify those independently.

The bootstrap has no generic remote target, no public fixture endpoint and no exported admin client/key. Both privileged fixture functions are INTERNAL and the gateway allowlist excludes them. `seedFreshFixture` permits exactly one matching run/set against an empty account database. `inspectFixture` is a private diagnostic closure, not an application route.

## Receipt-gated composition entry

`activateProvisionedQARuntime` in `activation.ts` is the concrete owner entry. It imports the actual `createLiveProvisioningController` from `tests/simulator-provisioner/controller.ts`, supplies `{ contextPath, expected, expectedHarnessSources, expectedSourceCardOrigin }`, and wires the returned `verify` and `assertLiveIsolation` into the composition. In addition to the common pins below, this entry requires `contextPath`, `receiptPath` and independently pinned `expectedHarnessSources`. It takes no caller verifier/isolation override, supplies no fallback and records the expected controller source map and exact source-card origin in provenance. The controller uses its context's original harness directory to find the pinned Python scripts, so bundling does not relocate that lookup.

The lower-level `activateOfficialQARuntime` composes the same lifecycle with mandatory externally supplied `ProvisioningVerifier` and throwing `verifyIsolation: () => Promise<void>` closures; it remains useful for isolated composition tests. Neither entry assumes a controller CLI or a stable verification-ID format. A fabricated unit receipt/verifier or self-asserted flag is not an acceptable runtime dependency. Importing the real controller is not evidence that its checks have passed. The controller remains responsible for dedicated/ephemeral/exclusive-runner proof, live global-PF lease enforcement and owned descendant/simulator cleanup before isolation release.

The input contains:

- The exact raw `manifestBytes`, independently retained `manifestSHA256`, and independent `expected: ExpectedRun`. Raw bytes are copied once before asynchronous work, never re-encoded or augmented.
- Independent `nativeBuild` and `backendBuild` records, each with `sourceRevision`, `artifactPath`, `artifactSHA256` and `buildID`. The native path is the real built host executable; the backend path is the pinned official platform executable. Build records must come from the owner/controller, not be synthesized from the manifest. Both actual executable files are hashed and their revisions must match the independent expectations.
- The pinned `backendSourceSHA256` using the same relative-path/source-byte digest as `run.mjs`, the actual executed `overlaySourceSHA256`, and `entrySHA256`. The last hash is of the module file that contains the running composition: when esbuild bundles it, pin the final `.mjs` bundle bytes, not `activation.ts`. Hash the final artifact after bundling; do not embed its own hash into that artifact.
- The separate exact `sourceCardOrigin: "https://cards.qa-runtime.invalid"`, the pinned public `allowlist`, absolute canonical `root` and fresh short `directory`. The concrete entry takes `receiptPath`; only the lower-level composition takes a receipt path/verifier under `provisioning`. The actual controller request/context must use this exact source origin too; another `.invalid` origin from a template is not interchangeable. Optional `path` selects the preinstalled toolchain; it does not permit downloads or credentials.

For example, the owner's ESM wrapper can import `activateProvisionedQARuntime`, load the controller's exact bytes/records and call it with those inputs plus `contextPath`, `receiptPath` and `expectedHarnessSources`. Bundle that wrapper with installed esbuild (`bundle: true`, `platform: "node"`, `format: "esm"`, `packages: "external"`) into a private external directory, keep the existing pinned `node_modules` resolvable there (a private symlink is sufficient), hash the finished bundle independently, and pass that hash as data when invoking the wrapper. The bundled entry includes the actual TypeScript controller; the separately pinned Python source map still refers to the original harness. No download or app/native manifest field is added for any of these separate owner pins.

Admission verifies pins and the actual receipt before boot. The entry selects supervised process ownership, initializes the real binding (which independently queries the official backend's source/deployment/config attestation), and obtains the exact QA attestation through the guarded gateway handler using the official client and exact run/raw-hash headers. It activates the strict routing overlay with that actual response and the trusted verifier **before** calling `createQAAdapter.listen()`. Build/source/overlay/entry bytes and live isolation are rechecked immediately before and after listen. No gateway listener opens before routing is authorized; the private backend/provider loopback listeners necessarily start earlier under the verified isolation lease.

The returned handle exposes only origins, a frozen non-secret fixture catalog, bounded provenance, `close()` and a `stopped` promise; it exposes no admin client, provider, seeding or diagnostic-control functions. `close()` attempts all local cleanup even if one resource fails, is idempotent, and reports unproved cleanup rather than treating it as successful. `RuntimeActivationBlocked` reports a fixed phase and cleanup status without forwarding arbitrary error text or credentials. Manifest expiry closes local resources automatically. Each real business dispatch rechecks the mandatory live-isolation closure; failure denies dispatch and starts local shutdown. The trusted controller must still supervise the complete process group and the simulator independently—`stopped.cleanupComplete` describes only this entry's local cleanup, not safe PF restoration or native/UI success.

The composition and bootstrap ownership unit suites deliberately mock the backend, provider, process signals and listener and use fabricated provenance. They prove ordering, exact-byte admission, no detached launcher in supervised mode, positive-PID-only bounded cleanup, expiry, isolation failure and fail-closed resource handling. They perform no real process/kernel/PF/native activation and cannot prove runner exclusivity or actual descendant termination.

## Bounded card URL overlay

The real business handler permits only an HTTPS card source, while the frozen native QA manifest deliberately permits only explicit numeric-loopback HTTP destinations. `routing.ts` bridges only this approved synthetic mismatch; it does not alter business authorization or privacy policy.

Create `createBoundedCardRouting` with the validated manifest context, exact separate source pin `https://cards.qa-runtime.invalid`, and the SHA256 of the actual executed `routing.ts` bytes. Pass it as `routingOverlay` to the binding. After adapter creation, query the guarded QA attestation using the actual run/hash request headers, then call `overlay.activate({ receiptPath, verify, attestation })` with the real trusted provisioning verifier. Record `overlay.provenance()` alongside source/config/build pins. Activation checks the exact local V0 attestation, run, raw manifest hash and independently verified receipt. It does not replace ongoing OS-isolation verification.

Rewriting is disabled before activation and after manifest expiry. Only the canonical `card.url` on get/create results or each list/history item is eligible. The original must exactly match the pinned HTTPS source plus `/c/<64 lowercase hex>`; foreign origins, credentials, ports, query, fragment, encoding, normalization and extra paths are rejected. Only the origin changes to the already validated manifest `cardOrigin`; the locator and all other fields remain unchanged. There is no recursive rewrite, fetch proxy or redirect.

The routing unit tests use explicitly fake receipt/verifier fixtures. They prove bounded behavior, not simulator erasure, PF, native transport or real overlay activation. Never promote those fixtures to runtime evidence. Credit a real activation only as synthetic-loopback QA plus a routing overlay, not production HTTPS, physical-device transport or install-return behavior.

## Fixture catalog

Every supported set starts with the same minimal baseline: four accounts and verified-phone rows, no sessions, G1 with creator/friend/subject, G2 with creator/friend/outsider, memberships older than bets, an open subject bet, a voided unavailable bet and friend board points 17/4. These points are read-only fixture values, not earned-scoring evidence.

| Role | Reserved synthetic phone | Alias |
| --- | --- | --- |
| friend | +12025550101 | QA Finn |
| outsider | +12025550102 | QA Oli |
| subject | +12025550103 | QA Sage |
| creator | +12025550104 | QA Cora |

The exact manifest run-ID spelling appears in `SECRET_QUESTION_<runID>`, `PRIVATE_OPTION_A_<runID>`, `PRIVATE_OPTION_B_<runID>` and `PRIVATE_CONTEXT_<runID>`. Locators are actual SHA256 values for `<runID>:bet-a` and `<runID>:unavailable`. The yes/no and over/under sets use their real format options instead of the private-option strings. Sealed/unavailable assertions must prove those values are absent, not just take a screenshot.

Supported IDs are `synthetic-v0-subject-locked`, `synthetic-v0-subject-veto`, `synthetic-v0-host-handoff`, `synthetic-v0-account-switch`, `synthetic-v0-unknown-conversation`, `synthetic-v0-controls`, `synthetic-v0-preferences`, `synthetic-v0-board-g1`, `synthetic-v0-board-g2`, `synthetic-v0-friend-yes-no`, `synthetic-v0-friend-over-under`, `synthetic-v0-friend-this-that`, and `synthetic-v0-unavailable`. Naming a set selects baseline/format inputs; it does not certify the named UI journey. Existing pick RPC is now final immutable confirmation under the explicit policy override. Create/scoring and other operations remain `POLICY_PENDING` where their remaining approvals are missing; that response never counts as functional success.

## Linux handler proof and checks

From the repository root, supply a fresh external evidence directory and the separately downloaded pinned Linux x64 executable:

```sh
env -i PATH="$PATH" HOME="$HOME" node tests/qa-runtime/run.mjs \
  --binary "$HOME/.capy/work/cons13-local/toolchain/convex-local-backend" \
  --output "$HOME/.capy/work/qa-runtime-FRESH-UNIQUE-ID"
```

The runner creates a fresh user/network namespace with only loopback, verifies no IPv4/IPv6 default routes, and invokes actual handlers through official HTTP clients and the guarded in-process adapter. It checks independent real-backend and gateway attestations, exact fixture identity and empty-session baseline, INTERNAL-control exclusion, rejection of an untrusted provider certificate, four actual synthetic phone-auth flows, retries/wrong-code/replay, identity, sealed/outsider/unavailable privacy, group boards and no writes after remaining creator `POLICY_PENDING`.

`confirmation-fixture.mjs` adds seven reserved synthetic bets in a private fixture overlay, without modifying canonical product bytes. `confirmation-scenarios.mjs` runs four pairs of overlapping HTTP calls with the outer SDK queue disabled: same/different keys and payloads each persist one logical pick with the required conflicts or stable receipts. It also discards an actual successful response before retry, checks immutable choice/confidence, independent bettors, authorization/block/void/rejoin before replay, before/after-reveal admission, unchanged group balances and no ledger credit. These are actual overlapping client HTTP intervals, not observed engine OCC retry events. Exact-millisecond reveal boundaries remain in-memory assertions; the real HTTP lane records observed server times instead.

The runner intentionally does not activate routing: native-card-origin compatibility remains explicitly blocked. Its manifest is only a plumbing contract input with a placeholder simulator, not a native activation. Evidence retains `nativeUIExecuted=false`, `simulatorProvisioned=false`, `nativeTransportCredit=false`, `realProviderExecuted=false` and `fullV0Ready=false`. A passing evidence file is insufficient unless the command exits zero, private state is removed, and the source/harness hashes remain unchanged.

NaN and both infinities are valid Convex wire values, not valid confidence inputs. The native codec test checks their exact `$float` encoding and exclusion from the actual control range; this real-backend lane separately sends all three through the official HTTP client and requires `INVALID_INPUT` with unchanged fixture counts. These negatives are not Swift/backend transport or confirmation-success evidence; the separate confirmation checks provide their own limited successful-handler evidence.

Run focused verification without inherited deployment credentials:

```sh
env -i PATH="$PATH" HOME="$HOME" node node_modules/eslint/bin/eslint.js tests/qa-runtime
env -i PATH="$PATH" HOME="$HOME" node node_modules/typescript/bin/tsc \
  --ignoreConfig --noEmit --strict --skipLibCheck --target ESNext --module preserve \
  --moduleResolution bundler --lib ESNext,DOM --types node --allowJs \
  tests/qa-runtime/activation.ts tests/qa-runtime/activation.test.ts tests/qa-runtime/bootstrap.test.ts \
  tests/qa-runtime/binding.ts tests/qa-runtime/routing.ts tests/qa-runtime/routing.test.ts \
  tests/qa-runtime/vitest.config.ts tests/qa-runtime/bootstrap.d.mts
env -i PATH="$PATH" HOME="$HOME" CI=1 QA_ADAPTER_TEST_ISOLATED=network-namespace-v1 \
  unshare --user --map-root-user --net node node_modules/vitest/vitest.mjs run \
  --config tests/qa-runtime/vitest.config.ts
```

These commands do not build or drive native UI. The portable bootstrap/binding are reusable on macOS, but the `unshare` runner is Linux-only. Native launch orchestration, actual trusted receipt generation, current PF verification, build/config provenance and simulator/UI assertions belong to the launch owner.
