# Native assertion lanes

Source pins: native `dcfdd43a05215d48b97b1294db285c27c875036b`, backend
`ebc47bbc8e42c63c3b23f9c8d148318e06ec2acc`. Source coverage is not execution
evidence. Read the run's actual XCTest result before claiming a pass. These
tests do not prove signed Keychain sharing, native/backend HTTP interoperability,
Messages transport, provider delivery, or distribution install-return.

## Actual source membership

`CalledItCoreTests` is hostless: real `Shared/`, `Tests/`, `TestSupport/` and
`App/HostAuthenticationModel.swift`, with empty `TEST_HOST`/`BUNDLE_LOADER`.
`CalledItUITests` compiles `UITests/` and `TestSupport/` against the real host.
Native owns project/config changes. Scheme `CalledItMessages`, configuration QA;
host `com.mikunad.calledit.qa.host`, embedded extension
`com.mikunad.calledit.qa.host.messages`. Neither test bundle is an application.
Release app targets do not compile test/support sources.

The obsolete Cards/Links/Config and `CALLEDIT_QA_*` tests are preserved under
`tests/baseline/native/`, outside target membership. Integration reintroduced
three of those files; this checkpoint restores their archival boundary without
changing their historical assertions. They reference removed implementations.

## Real model and safety assertions

| Source | Assertion groups and implementation exercised |
|---|---|
| `RuntimeConfigurationTests.swift` | `NATIVE-CONFIG-*`, `NATIVE-ATTEST-*`: explicit typed config, independent native/backend pins, exact HTTPS origins and matching v0.2 attestation; ordinary config rejects HTTP/test adapters |
| `CardLocatorTests.swift` | `NATIVE-LOCATOR-*`: actual opaque locator parsing/round trip, wrong origins/credentials/query/fragment/encoded path rejection, persisted-value revalidation |
| `SharedSessionAndLinksTests.swift` | `NATIVE-SESSION-*`, `NATIVE-LINK-*`, `NATIVE-CLEAR-*`: expiry/environment validation, account/conversation separation, no last-room fallback, targeted state cleanup |
| `NativeBetTests.swift` | `NATIVE-LOCK-*`, `NATIVE-FORMAT-*`, `NATIVE-PICK-*`, `NATIVE-VARIANT-*`: actual DTO variants, no private keys on sealed/unavailable responses even when null, exactly two outcomes, finite O/U line, bounded confidence |
| `ClockNotificationAndProofTests.swift` | `NATIVE-CLOCK-*`, `NATIVE-NOTIFY-*`, `NATIVE-PROOF-*`: monotonic countdown without local reveal authorization, neutral notification routes, actual `$bytes` and 512 KiB media bound |
| `NativeQAGateTests.swift` | `NATIVE-QA-*`: pure runner safety gate, raw manifest digest, exact fields, loopback/lifetime/run/simulator validation and credential rejection; fabricated unit inputs are not provisioning proof |

The native owner fixed the previously source-backed strict DTO and pending-route
gaps. Tests retain those expectations. Model fixtures use reserved `.invalid`
URLs and UUID-namespaced UserDefaults suites; deletion is confined to the suite
created by that test. Unit Keychain configuration strings are never used for
Keychain access and do not assert registered capabilities.

## Actual transport and host-auth units

`APITransportTests.swift` has 14 methods and `HostAuthenticationModelTests.swift`
has 12. Together their source declares 154 distinct assertion IDs.

Transport calls the production overload
`API.run(_:_:_:configuration:session:)`, including its real recursive Convex
encoder, attestation, no-redirect delegate and envelope/DTO decoder. Each unit
uses an ephemeral session and a session-local `NativeRPCTransportStub` URLProtocol;
no global registration/swizzle or alternate decoder exists. A unique `.invalid`
origin identifies each script. Unknown requests fail locally, never fall back to
network. Production convenience loads Config before delegating; preflight tests
correctly supply the explicit injected configuration.

Assertion groups `NATIVE-TRANSPORT-*`, `NATIVE-RPC-WIRE-*`, `BYTES-*`, `ERROR-*`,
`SUCCESS-*`, `ATTEST-*` and `ISOLATION-*` check method/path/header/body, exact SDK
`format:"convex_encoded_json",args:[encodedArgs]`, query/mutation/action kinds,
fresh attestation, typed bytes through 512 KiB, safe structured/string/null UDF
errors, malformed success, proxy HTML/non-UDF failures, wrong origins/MIME,
offline failure and mismatched attestation. `v0Auth:redeemPair` is an action;
proof upload/read use the real action paths. Nested upload collections stress
the encoder only and are not accepted backend schema fixtures. A synthetic 302
status is rejected; this is not a live URLProtocol redirect-callback test.
Synthetic HTTP560 checks SDK compatibility. The separate real OSS-backend lane
observed HTTP200 error envelopes; neither lane alone proves Swift-to-backend HTTP.

Host units inject all three actual dependencies: `PhoneAuthenticating`, a
configuration closure and `SessionPersisting`. The production defaults stay
unchanged. Memory protocol spies do not touch Bundle.main, Keychain, App Group,
provider or networking. `NATIVE-HOST-*` covers normalized phone/code flow, busy
release, safe provider/transport failures, real SharedSession encoding,
expiry/environment rejection, AUTH_REQUIRED cleanup versus POLICY_PENDING
preservation, and revoke. `NATIVE-HOST-SUCCESS-13..17` preserves an anonymous
incoming locator through first sign-in/reload. `NATIVE-HOST-SWITCH-01..08`
separately removes the previous account's private state and pending-card flag.
These are model call/representation assertions, not secure persistence proof.

## UI contract and blocked prerequisites

Frozen contract: Captain handoff `handoffs/release-v0/qa-launch-contract.md`.
Only `CALLED_IT_QA_RUN_ID` and `CALLED_IT_QA_MANIFEST_BASE64` activate QA. The
runner hashes at most 16,384 raw JSON bytes, validates exact fields and independent
source/deployment/config/fixture/simulator pins, and permits only explicit
`http://127.0.0.1:<1024..65535>` origins. Tokens/phones/OTPs are not app config.
Release locators remain HTTPS. Manifest booleans are not erasure/egress proof.

An external provisioner must create/erase a dedicated simulator, record clean
state/OS/UDID/install inventory and enforced outbound denial, and open the actual
extension in a synthetic conversation. Tests never launch/browse Messages, read
history, pair or send. They activate MobileSMS only after it is already prepared.
The host shares validated activation through the fixed QA App Group; extension
revalidation and exact run/hash attestation are mandatory.

`tests/qa-adapter/` currently implements only guarded factory/plumbing. Its 22
unit tests do not bind business handlers or create trusted simulator evidence;
plumbing mode cannot listen. A real binding, fixture-specific routes/data, card
origin hosting and external provisioner remain missing. Backend production
card generation requires HTTPS while the QA manifest requires loopback HTTP;
that routing adaptation must be explicit, not silently alter real handler policy.

Each UI method requires its exact `synthetic-v0-*` fixture set. The question must
be `SECRET_QUESTION_<manifest runID>`; private choices use
`PRIVATE_OPTION_A_<runID>`/`PRIVATE_OPTION_B_<runID>`. The generic in-memory backend
fixture uses different sentinels and is not this UI binding. No fake success may
replace current POLICY_PENDING create/pick/answer/challenge/goal behavior.
Board values 17/4 test rendering only, not an approved score formula.

Actual runtime IDs are `qa.runtime.*`, `auth.*`, `navigation.*`, `bet.*`,
`settings.*`, `board.row.*`. UI checks cover subject lock/veto, both options,
save/edit acknowledgement and timing, active polling/accessible reveal, unknown
conversation selection, host session handoff/account switch, controls and board
isolation. Session-binding/artwork observation, suspended reveal, app-absent
transport and actual install-return retain explicit BLOCKED failures until their
real observation contracts exist. Do not skip or remove them to claim a green UI
lane. All UI methods are unexecuted at this source checkpoint.

## Core execution

On an authorized fresh simulator, without provider/deployment credentials:

```sh
cd native-imessage
xcodegen generate
xcodebuild test -project CalledItMessages.xcodeproj -scheme CalledItMessages \
  -configuration QA -destination "platform=iOS Simulator,id=$QA_SIMULATOR_UDID" \
  -only-testing:CalledItCoreTests -resultBundlePath "$ARTIFACTS/native-core.xcresult"
```

Record exact native/test/backend revisions, simulator/OS/toolchain and XCTest
counts/results. Compile-only output is not assertion evidence. UI requires
independently provisioned activation and exactly one matching method/fixture;
core-only execution must not launch a Messages UI test.
