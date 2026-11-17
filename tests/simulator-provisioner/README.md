# Fresh cloud Mac simulator provisioner

Test-only source. No Mac/PF mutation, simulator, Messages launch, phone action or
remote build has been executed by this child. Linux unit results are not kernel
or native behavior evidence. The first actual cloud command should be the bounded
**enforcement probe**, not the full UI lane.

Parent-reported capability baseline: build `01M7KBX2SZK3PVFVPTHYRNFDNP`,
2026-11-16 23:43:55 UTC, macOS 26.6.2 / Xcode 27, effective UID 501,
`sudo -n pfctl -s info` / `-sr` succeeded, PF disabled with zero states, root
`anchor "com.apple/*"`; sandbox-exec exists. ALTQ warnings were nonfatal. Those
reads establish capability only. This implementation does not assume another
account, an external responder/DNS service, dylib injection or launcher sandbox
inheritance.

## Exact cloud commands

First prepare a fresh private absolute request JSON and choose the actual runner
controller candidate PIDs from the Mac's actual owner ancestry. Root independently
validates the pinned agent and connected vsock endpoints; names or empty TCP
output never admit. Do not invent PIDs or preserve any external IP connection.
Supply `controlPulsePath` as described below. `request.example.json` is a
**non-runnable template** until its pins/paths/PIDs are replaced.

From the repository root on the approved fresh cloud Mac:

```sh
printf 'TRUSTED_PRELAUNCH nonce=%s sourceManifestSHA256=%s contextSHA256=%s\n' \
  "$LAUNCH_NONCE" "$SOURCE_MANIFEST_SHA256" "$TRUSTED_LAUNCH_SHA256"
/usr/bin/python3 -E -s tests/simulator-provisioner/provision.py \
  --request /absolute/qa-run-request.json \
  --output /absolute/new-enforcement-probe-directory \
  --trusted-launch-context /absolute/parent-proof/launch-context.json \
  --trusted-launch-sha256 "$TRUSTED_LAUNCH_SHA256" \
  --enforcement-probe
```

This installs only a run-owned global PF child anchor/enable reference, verifies
the fixed provider vsock management channel, literal loopback TCP/UDP, actual IPv4/IPv6 kernel
drops and a uniquely attributable blocked system-resolver query, then restores
owned isolation. It never creates/boots a simulator or emits a native manifest or
provisioning receipt. Independent cleanup must be read even if the probe fails.
It ignores build-artifact paths because it makes no native/build claim.

A read-only inspection alternative is the same command with `--inspect-only`
instead. That also validates the actual independent built artifacts and never
loads PF rules.

After the enforcement probe actually passes and the parent supplies its existing
backend/runtime argv wrappers plus a built `.xctestrun` containing the new driver:

```sh
/usr/bin/python3 -E -s tests/simulator-provisioner/provision.py \
  --request /absolute/qa-run-request.json \
  --output /absolute/new-full-runtime-directory \
  --trusted-launch-context /absolute/parent-proof/launch-context.json \
  --trusted-launch-sha256 "$TRUSTED_LAUNCH_SHA256" \
  --backend-command /absolute/backend.argv.json \
  --runtime-command /absolute/native-scenarios.argv.json \
  --xctestrun /absolute/built/CalledItMessages_iphonesimulator.xctestrun \
  --fixture-phone +12025550101
```

The fixture phone is UI-test input only; choose the binding owner's actual
reserved actor. It is never an app configuration/manifest field. UI types code
`000000` over the actual native transport. There is no token or OTP injection.

## Request and owner integration

The request has exactly `runID`, `nativeSourceRevision`, `backendSourceRevision`,
`fixtureSetID`, `configVersion`, `runtimeID`, `deviceTypeID`, `apiPort`, `cardPort`,
`lifetimeSeconds`, `appPath`, `nativeBuildRecord`, `backendBuildRecord`,
`controlPIDs`, `sourceCardOrigin`. Pins must be actual independent 40-lowercase-hex
build revisions; runtime/device IDs must exist on that Mac. Current coordinated
ports are official backend 3210, API gateway 8199 and card site 3211.
`sourceCardOrigin` is exactly `https://cards.qa-runtime.invalid` (no alternate,
trailing slash or normalization) for
the parent-owned strict routing overlay. It is recorded in provenance/context,
never added to the frozen native manifest or used as a redirect/fetch endpoint.

Each independent build record has exactly `sourceRevision`, `artifactPath`,
`artifactSHA256`, `buildID`. The native artifact path is the actual host
executable. Built host/extension bundle IDs, QA channel, fixtureMode=false,
App Group, source revision, executable and Info.plist hashes, SDK/build versions
are independently checked; installed host/extension executable hashes must match.
Inputs/output paths must be absolute, non-symlink and fresh where required.

Each owner command file is a JSON argv array whose first entry is an absolute
real executable (resolve symlinks first). Shell/sudo identity wrappers and secret
arguments are not supported. Use a small explicit Python/Node executable wrapper,
not shell text. This provisioner does **not** invent the backend binder's CLI.
Both owner wrappers receive only the explicit clean environment plus
`CALLED_IT_PROVISIONER_CONTEXT`, pointing to `context.json`, which contains the
request, exact UDID, manifest/receipt paths and hashes, and lease expiry.

The backend wrapper must start and supervise the real official backend/provider
fixture/gateway/site at the coordinated loopback ports, read the real receipt via
the adapter's **separate trusted provenance verifier**, and stay alive. The
provisioner supplies no auto-approval verifier, stub handlers or provider delivery
claim. The native wrapper runs parent-selected actual scenario assertions and
returns nonzero on any blocked/failed dependency. Wrappers must keep descendants
in their registered process group, supervise/await them and never daemonize.
No dependency download or other nonlocal connection may be needed after lease
activation. Generic owner stdout/stderr is not captured, to avoid logging
credentials; owner wrappers must provide their own public-safe result artifacts.

## Mandatory trusted-launch provenance

PF capability is not permission. Every mutating entry requires the parent-pinned
`--trusted-launch-context` and its exact raw-byte SHA256. A generic/local/paired
entry, an `exclusive:true` input, hardware traits or an arbitrary provisioning
receipt cannot authorize mutation. The parent supplies these nonsecret captures;
the harness does not manufacture an admission claim or invent a signing API.

The version-2 design separates immutable prelaunch inputs from facts that only
exist after the tool starts a VM. The trusted parent retains the actual
`mobile.build` input/result, returned build/operation IDs and resulting logs
outside the archive. It matches those to this job's unique nonce and raw-byte
source-manifest/context hashes. It never stages an invented or prior build ID,
expected boot UUID, postlaunch result or supposed platform signature. Version-1
contexts and those additional plan fields are rejected.

The context JSON has **exactly** these fields:

```json
{
  "version": 2,
  "runID": "<canonical uppercase run UUID>",
  "launchNonce": "<new canonical uppercase random UUIDv4, distinct from runID>",
  "reviewedAuthority": {"file": "reviewed-authority.json", "sha256": "<raw-file SHA256>"},
  "launchPlan": {"file": "launch-plan.json", "sha256": "<raw-file SHA256>"},
  "sourceManifest": {"file": "source-manifest.json", "sha256": "<raw-file SHA256>"}
}
```

The angle-bracket values are descriptions, not runnable pins. All SHA256 values
are 64 lowercase hexadecimal characters. Referenced files are bounded regular
non-symlink basenames beside that context. Use the actual reviewed authority
snapshot at Captain Drive `handoffs/CONS-13/remote-runner-isolation.json`;
its embedded readable provider source must hash to
`24c2eacdef14a2d9ae80a3aa7a83851d209ef4b8b379f9df479890f9305fadd5`.
This provider/route guarantee is necessary but is not a per-job witness by itself.

The source manifest has **exactly** `version:2`, `runID`, `launchNonce`,
`files:{"repository/relative/path":sha256}` and
`configurationFiles:{"repository/relative/path":sha256}`. Both UUIDs must match
the context. `files` must cover every actual `.py`/`.ts` file in this harness,
all files in `launch_provenance.REQUIRED` (including the UI launcher), the reviewed
bootstrap/discovery/command sources and the actual archived configuration inputs.
`configurationFiles` is a nonempty subset of `files` with identical hashes,
separate from the harness files, identifying those actual configuration inputs.
Do not satisfy it with an unrelated inert file. Every listed file is rehashed
under the real repository root; no arbitrary source root, traversal or inferred
revision is accepted. Seal the templates and code that derive runtime controller
PIDs from actual observations; do not prefill a future PID, boot or job identity.
Coverage of the launcher/configuration inputs is part of the parent's source
review, not something a file digest can infer.

The launch plan has **exactly** these fields:

```json
{
  "version": 2,
  "kind": "trusted-parent-prelaunch-plan",
  "runID": "<same run UUID>",
  "launchNonce": "<same new UUIDv4>",
  "sourceManifestSHA256": "<raw source-manifest file SHA256>",
  "issuedAt": 0,
  "expiresAt": 0,
  "scope": {
    "tool": "mobile.build",
    "platform": "ios",
    "source": "workspace",
    "provider": "revyl-remote-builds",
    "guest": "one-clean-single-use-private-vm",
    "cache": "compilation-only",
    "entry": "archived-build-commands"
  }
}
```

Replace the zero timestamps with actual epoch milliseconds: issuance may be at
most two hours old and five seconds ahead, expiry must be future and no later
than two hours after issuance. The exact scope is mandatory; local/paired/shared,
upload-only, runtime-cache and boolean-exclusivity substitutes are rejected. The
reviewed route runs the repository-root workspace archive's build commands on
one clean, private Revyl VM; it does not authorize execution on another Mac.

Before PF mutation the nonroot provisioner reads `kern.bootsessionuuid` and
writes `runner-launch-chain.json`. The independent root guard rehashes the
immutable inputs, reads the **actual current** boot UUID itself, then writes and
fsyncs a single-use witness at
`/private/var/run/calledit-qa-launches/<launchNonce>.json`. Its directory is
root-owned/non-user-writable and its file is root-owned/read-only, so deleting
the archived context or output folder cannot reset consumption. Re-consumption
fails. The root guard also writes `runner-authorized.json` before any PF query or
mutation, and includes that authorization in `lease-ready.json`.

The stable authorization chain has exactly `version:2`, `authorityScope` (the
plan's exact `scope`), `runID`, `launchNonce`, `contextSHA256`,
`sourceManifestSHA256`, `launchPlanSHA256`, `harnessSHA256`, `guardSHA256`,
`configurationSHA256`, `reviewedAuthoritySHA256`, `providerReadableSHA256` and
`guestBootSessionUUID`, plus `controlProfileSHA256` and
`controlInspectorSourceSHA256`. Returned authorizations add `chainSHA256` and `checkedAt`.
`harnessSHA256` seals the repository-relative `.py`/`.ts` source map;
`guardSHA256` seals the `REQUIRED` subset; `configurationSHA256` seals the
`configurationFiles` map. These three hashes and `chainSHA256` use UTF-8 JSON
with recursively sorted keys, no whitespace and no final newline. Raw artifact
hashes instead cover the exact file bytes, including any newline.

The root witness has exactly `version:2`, `chain` (that stable chain),
`chainSHA256`, `rootGuard:{pid,uid:0,birth,capsuleDirectory,capsuleInfoSHA256}`
(observed normalized `ps lstart`, protected capsule directory/info seal)
and `consumedAt`. The live verifier re-reads the current boot and all seals,
checks this witness against the exact root lease PID/birth and pre-lease
timestamp, then retains all live kernel/broker/device checks. Its status adds
`rootLaunchWitnessSHA256`. Process approvals and independently erased-device
records belong to that exact live guard/run directory. Receipt binding remains
transitive through the actual `lease-ready.json` hash, embedded authorization,
same live guard/device, and the hashed kernel proof; the frozen native manifest
and outer provisioning receipt schemas are unchanged. Kernel proof must postdate
this specific lease. A previous boot's witness or a previous lease's proof is
not accepted as current evidence.

This is a trusted-launcher/operator boundary, **not** cryptographic platform
attestation: a guest cannot independently authenticate a malicious privileged
operator or distinguish an exact archive copied to another Mac without an
external attestation service, which this design does not invent. The parent must
use only the reviewed actual tool route, reserve each nonce for one launch in
its independent tool record, reject cross-job reuse and retain the actual
returned IDs/log linkage. Guest root consumption prevents reuse within that VM;
it is not a cross-VM nonce registry. Neither a caller's booleans nor a receipt
under test establishes that boundary. Missing/unbound chains fail closed even
on a Mac with working sudo/PF. No staged plan by itself proves PF enforcement,
safe restoration, simulator freshness or Messages/UI execution.

## Gateway verifier/controller interface

`controller.ts` exports:

```ts
createLiveProvisioningController({
  contextPath,
  expected,
  expectedHarnessSources,
  expectedSourceCardOrigin: "https://cards.qa-runtime.invalid",
}) // => { verify: ProvisioningVerifier, assertLiveIsolation: () => Promise<void> }
```

`expected` is the existing adapter's independently supplied `ExpectedRun`.
`expectedHarnessSources` is the trusted archived map of basename -> SHA256 for
the actual `.py`/`.ts` guard sources, `vsock-profile.json` and `control-sockets.c`,
never copied from a receipt under test. The sole C basename maps only to
`tests/mac-enforcement/control-sockets.c`; all others map only to this directory.
No arbitrary `../`, relocation or extension is accepted. `harnessSHA256` uses
those fixed repository-relative names, identically in Python and TypeScript.
The parent can capture the source map before launch with
`python3 tests/simulator-provisioner/status.py --fingerprint-only`, then bind it
to the actual observed archive/source manifest. Both callbacks query the real
root lease process/birth, live PF root/child trees and empty state table,
heartbeat, platform launch chain, actual blocked DNS packet, independently
erased fresh-device record and current source hashes. A file-only live flag or
Linux plumbing fixture cannot pass. The verification callback additionally
checks all four receipt artifacts and actual raw-manifest/source/origin pins.

Use `verify` as the existing adapter's explicitly selected trusted provenance
verifier and the mandatory `assertLiveIsolation` closure for the composition
owner's lifetime checks. The adapter still performs its own receipt integrity
validation. No default verifier approves arbitrary artifacts, and no binding
CLI or business fixture is fabricated here.

## Enforcement and lifecycle

Node never hashes and later reopens workspace `status.py` for execution. Its fixed
stdlib-only isolated read-only root bootstrap verifies the immutable nonce witness,
capsule closure, independent harness digest and root control evidence, then executes
only private capsule status code. The immutable control witness binds the owner UID,
exact run directory/inode and current owner process; status independently checks that
UID and derives only that workload's home before any run-owned device access. It
does not infer a root or another user's simulator home from writable ready JSON.
All regular readers (Python, both inline bootstraps and Node) open nonblocking and
then strictly fstat regular type/size before reading; FIFO regressions use bounded
subprocesses rather than hanging a test runner.

Before load, root re-queries unchanged unowned root/filter/translation/state/anchor
baselines. Canonical expected owned rules come from the private policy's `pfctl -n
-v` dry run, never an adopted post-load snapshot. After load and across enable, a
strict recursive-tree diff must prove that the **only** insertion is this exact
final owned anchor with those exact rules; every unowned node remains unchanged.
Unsupported/truncated recursive serialization blocks before admission. Cleanup
performs the same unowned-baseline proof before any removal and observes baseline
restoration again afterward; foreign quick paths are never blessed as active state.

1. `lease.py` is an independent root process in its own session, started through
   the isolated root capsule bootstrap below. It independently validates live vsock management, requires
   the observed disabled-PF/empty-state baseline and supported root ordering,
   verifies/logs the mandatory trusted launch chain, rejects unreviewed nested
   filtering/translation, parses its rules with `pfctl -n`, and loads only its last-sorted
   `com.apple/zzzz_calledit_<run>` child, and obtains its own `pfctl -E` token.
2. There are **zero external IP pass rules**, including for the controller.
   Only literal 127.0.0.1/::1 on lo0 passes statelessly. All other IP
   inbound/outbound traffic, every UID and privileged broker included, is denied;
   new inbound state cannot create an egress fast path.
   Unexpected PF states or changed root/nested/owned filtering, translation or
   anchor order abort the run. Unreviewed existing child/nested rules are refused
   before mutation, not overwritten.
3. `netprobe.py` requires independent current root-helper vsock observations before
   and after denial probes and real loopback
   echoes. TEST-NET/documentation IPv4/IPv6 TCP/UDP attempts must increment their
   own destination/protocol-specific kernel drop counters. No-route, EPERM or a
   timeout alone is unproven. No external responder is contacted/required.
4. The system resolver is invoked with a unique nonce under IANA example.com.
   A nonce-filtered PFLOG capture must contain that exact query as `block out`,
   and the live DNS-deny counter must advance. Cached NXDOMAIN, resolver failure
   or an absent packet is blocked, never proof. PFLOG is created only if absent
   and removed only if this run created it; capture persists only the exact owned
   nonce, not unrelated DNS/history. Unsupported PFLOG/tcpdump behavior fails.
5. Only then does the provisioner create a new named simulator, explicitly erase
   it, register its actual metadata/UDID with the independent lease, and boot.
   It checks real system-app inventory, empty run-owned Messages/Contacts counts,
   no prior QA activation, exact OS build, then installs the real built app and
   embedded extension. No existing simulator or personal database is reused.
6. Four hashed actual backing records feed the existing adapter receipt contract:
   simulator-created, simulator-erased, empty-state-verified, outbound-denied.
   The exact frozen native manifest is emitted only under the live verified
   lease, with expiry shortened to fit that lease. Manifest booleans are outputs
   of the command/kernel checks, not accepted input overrides.
7. `job.py` waits for independent registration/approval before exec. The lease
   verifies each new process group's actual UID, parent, group and birth before
   approving it. Parent death, missing heartbeat, changed kernel policy or the
   monotonic deadline triggers stop-before-release cleanup. At most eight jobs
   are accepted. Authoritative process snapshots track descendants; identity-query
   failures never grant permission to signal. Escaped or unattributed surviving
   descendants retain isolation instead of trusting a wrapper exit. Every external
   command has a timeout; the missing-heartbeat
   threshold is eight seconds plus bounded command/cleanup time.
8. Cleanup stops only registered workload groups and the exact verified run-owned
   simulator, then re-queries the complete expected root/filter/translation/state/
   anchor baseline and final live management identity **before** flushing only
   the owned anchor's **rules** and releasing only its
   `-E` reference with `-X`. No global state flush, `pfctl -d`, root-policy rewrite,
   arbitrary process kill or other simulator erase occurs. Unproven workload or
   device termination retains isolation and records administrative cleanup needs.
   Actual rules, PF status/state, anchor inventory and PFLOG presence are queried
   again after cleanup and recorded, including an inert namespace if the kernel
   retains it. `completed.json` is written only after observed successful cleanup.

TCP rule planning/inspection functions remain only for existing read-only design
tests/diagnostics. No mutating entry selects that profile or falls back to it.
Connected provider vsock is an intentional management channel, **not** proof
that arbitrary non-IP sockets or covert channels are denied. A changed management
identity/endpoint or stale pulse blocks the run; no new IP exception is added.

## Fixed vsock profile and root execution boundary

Seal `vsock_control.py`, `root_capsule.py`, `vsock-profile.json` and the unchanged
SDK-compiled inspector source `tests/mac-enforcement/control-sockets.c` along with
the existing full closure. The profile JSON must also appear in
`configurationFiles`. The fixed profile is
`revyl-tart-vsock8080-no-ip-v1`: the C SHA256 is
`c0ddc25f00b9d99675d52fed1618e938ee28a8ed34715c7846f36eb44e379a99`,
agent SHA256 is
`5dcc2c8043f79604896d60f91dffe6e98bf39d75ad1555b8dbbb8b6ba8bfe043`,
resolved agent path is `/opt/homebrew/Cellar/tart-guest-agent/0.14.1/bin/tart-guest-agent`,
and actual SDK27 must identify family40/kind7/stream1. These are reviewed source/
binary identities, not a signature, reproducible-build or platform-attestation
claim. Guest CID, ephemeral ports, PIDs and births are always observed afresh.

The runtime request adds `controlPulsePath`: an absolute regular mode0600 file
in the workload owner's private mode0700 directory. Its exact JSON is
`{version:1,runID,launchNonce,sequence,observedAt}`, with nonnegative integer
sequence and epoch-ms time. The operator first prints/flushed that nonce-tagged
record to real stdout, then atomically replaces the pulse file every2s. Root
requires freshness under8s and monotonic progression. This is **local liveness
only**, never launch authority or proof that the parent received the output.
The runtime lease request's exact raw SHA256 and pulse path are recorded in the
immutable control witness. Archive the reviewed code/configuration that derives
this actual request; do not prefill future runtime identities.

`root_capsule.pinned_bootstrap(contextPath, contextSHA256)` reads raw context and
manifest with their exact pins, reads/hash-checks `root_capsule.py`, parses it
with `ast.parse`, and extracts the one constant `ROOT_BOOTSTRAP` string without
importing/executing those bytes. The trusted operator/process must similarly
extract any bootstrap literal from already verified bytes, never obtain one by
importing an unchecked mutable module. `start_lease` invokes:

```text
sudo -n /usr/bin/python3 -I -S -c <verified fixed ROOT_BOOTSTRAP literal>
  <original absolute repository root> <context path> <raw context SHA256>
  <raw manifest SHA256> <private output directory> <actual owner PID>
  <runID> <bounded seconds> <actual caller UID>
```

The inline root program uses stdlib only. Before any workspace code is imported
or executed with privilege, it verifies those pins, every referenced proof file,
and every source/config/profile byte, then copies the closure into an exclusive
root-owned `/private/var/run/calledit-qa-capsules/<nonce>/` directory. Copies and
metadata become read-only; directories are root-only. Isolated Python executes
only that capsule's `lease.py` and imports only its private closure plus stdlib.
`capsule-info.json` binds the original source root, context/manifest pins and copy
map. Root launch/live checks rehash **both** originals and private copies.
The context and all referenced authority/plan/manifest bytes are also copied to
private `root-authority/`; root validates those immutable bytes and independently
requires the current originals to match. Root observations have an authoritative
mode0400 copy under `root-records/` before a workload-owned copy is published.
Protected status reads private ready/device records and requires any public copy
to match; writable ready JSON never supplies new policy/device authority.
The root-launch witness adds `rootGuard.capsuleDirectory` and
`rootGuard.capsuleInfoSHA256`; `lease-ready` records `leaseProgram`/`rootCapsule`.
PF's generated input file also stays in the protected capsule, never a
workload-writable policy path.

Root separately copies the reviewed C source into exclusive
`/private/var/run/calledit-qa-helpers/<nonce>/`, resolves the actual clang/SDK
through absolute `/usr/bin/xcrun`, and validates their root-owned,
non-nonroot-writable path components. Unsupported ownership/ACL/path conditions
fail closed rather than assuming an installed Xcode path is trustworthy. The
compiler runs with only absolute system PATH, root HOME, private TMPDIR and C
locale; no caller toolchain, SDK, loader or include-path environment survives.
Arguments are fixed `clang -isysroot <actual SDK> -Wall -Wextra -Werror -O2
 -MD -MF <private dependency file> -MT calledit-helper <private C copy>
 -o <private helper> -lproc`. Before compilation, `clang -M` (not `-MM`) obtains
the complete include closure, including system headers. Every resolved header,
logical path namespace and SDK/compiler resource path must be root-owned with
no nonroot-writable mode or grant ACL. Every raw dependency hash is sealed,
rechecked across compilation, and compared to the actual `-MD` compile closure
**before the generated helper can execute**. Unknown escaping/continuations,
out-of-root dependencies, omitted source, changed or unsafe headers fail closed.
Compiler/linker binaries and actual SDK link stubs are checked too. It records actual compiler hash/
version, SDK version/settings hashes, argv/environment and compiled binary SHA.
The helper and `control-witness.json` are root-owned/read-only in a root-only
directory. They remain inert audit state until this single-use VM is discarded.

That immutable control witness binds `rootLaunchWitnessSHA256`, launch-chain
SHA, boot/run/nonce, root guard PID, actual request hash/pulse path, profile/source/
compiler/SDK/helper seals and baseline observations. `lease-ready.controlRuntime`
and `controlRuntimeSHA256` are copies, **not** authority: status/probe independently
stat/read/hash the root-only witness and binary before invoking the helper.
Only one exact fixed helper path derived from the nonce is accepted.

Root derives the owner ancestry independently, checks all requested PIDs belong
to it, identifies the unique pinned actual agent, and obtains two SDK-typed
per-FD snapshots around the actual kernel vsock table. Every connected agent FD
must be stream vsock8080 to hostCID2 with matching kernel tuple; listener-only,
empty TCP, query errors, unstable births, truncation, unknown agent binaries or
changed ancestry/FD/endpoints fail. Checks occur before mutation, after enable,
every bounded watchdog interval, before release and after restoration. Neither
netprobe nor status relies on old TCP rules/counters.

`lease-ready.recordedAt` follows observed activation and management checks.
After stop-before-release and final current kernel/management checks,
`lease-cleanup.enforcementReleaseStartedAt` is recorded immediately before the
first owned deny removal/reference release; `recordedAt` follows cleanup. No
release bound is invented if cleanup blocked first; `enforcementLastObservedAt`
instead records the last actual enforced-state observation. Unknown pre-release
policy/state or incomplete load/enable/PFLOG ownership retains resources and
blocks. Post-release failures report actual remaining state, never pretend
already removed rules/ref remain active.

Even successful local enforcement/restoration reports only
`local-gates-pass-parent-tool-continuity-pending` with
`parentToolContinuityVerified:false`. The parent's separate offline verifier
must validate promptly retained actual tool-log pulses across the exact root
enforcement window. Only after independent source review may the parent run
one fresh bounded enforcement/restoration attempt. No simulator/UI or broader
readiness conclusion follows from this profile or these design tests.

Cleanup separates `resourceRestorationFailures` from `runEvidenceFailures`.
Dead/stale management fails the run, but does not prevent proven-safe owned
restoration after workloads are gone and kernel/owned-resource baselines match.
Such restored-but-failed runs still exit nonzero, keep nonempty `failures`, and
cannot publish `completed.json`. Uncertain workload/kernel/resource ownership
still blocks removal. Records report the actual remaining state, not a blanket
claim that a failed run retained active isolation.

## Separate native UI driver

`drive.py` makes a NEW external `.xctestrun`, preserving the original build file
and selecting only `ProvisioningDriveTests` on the exact UDID. Its test-runner
activation is the real frozen manifest; the actual host receives only the normal
two launch activation fields. The driver signs in through actual phone/code UI,
launches real MobileSMS, composes only to reserved +12025550198/+12025550199,
opens the actual embedded Called It extension and checks matching attested
run/manifest/shared-session diagnostics. It never taps Send, selects prior
threads/contacts, signs into Apple or substitutes a fake Messages/host wrapper.
Unknown system selectors, missing extension support or shared Keychain capability
fail with specific assertion IDs and a run-owned xcresult.

This prepares a synthetic compose/capability surface, not an existing delivered
message/card or every scenario fixture. The parent still owns actual business
fixture/conversation/card setup and assertion selection. Production HTTPS/card
transport, SMS/APNs delivery, physical forwarding/privacy, distribution and
install-return remain separate blocked lanes.

## Local checks and evidence boundaries

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s tests/simulator-provisioner -p 'test_*.py' -v
node --test tests/simulator-provisioner/controller.test.mjs
node node_modules/typescript/bin/tsc --project tests/simulator-provisioner/tsconfig.json
```

Units use explicitly fabricated command/process/PF/receipt inputs; they perform
no Mac/PF/phone action and are not simulator proof. Read `blocked.json`,
`lease-blocked.json`, `lease-cleanup.json`, `network-probe-stderr.txt` and the UI
xcresult for actual cloud failures. Global enforcement remains unexecuted until
the parent runs the command above. A successful preflight or passing units cannot
be promoted to outbound, UI, provider, signing or full-V0 readiness evidence.


Current local assertion inventory: Python `SIM-AUTH-01..10`, `SIM-GUARD-01..08`,
`SIM-EGRESS-01..09`, `SIM-GATE-01`, `SIM-LEASE-01..14`, `SIM-RECEIPT-01..02`,
`SIM-UI-01..02`, `SIM-STATUS-01..02`, `SIM-CLEANUP-01`, `SIM-VSOCK-01..08`,
`SIM-CAPSULE-01..03`, `SIM-READER-01`, `SIM-PFTREE-01`, `SIM-SDK-01..02`
(64 methods), plus Node `SIM-CONTROLLER-01..08`. The separate native driver uses
`SIM-PROVISION-UI-01..16`; those native assertions are source-only until the actual
Mac UI lane runs. Unit receipt/process/packet inputs are deliberately fabricated
and cannot be reported as real platform, kernel, simulator or Messages evidence.
