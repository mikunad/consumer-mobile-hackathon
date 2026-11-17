# Archived native baseline assertion suite — not a build input

Status: **source only; execution blocked**. Written against the native source at
`d23f9e7e8799988505a2d6bf5c6c1981716aa6d9`. This Linux workspace has neither Swift
nor Xcode/iOS SDKs. No native compilation, simulator launch, Messages send,
pairing, live backend call, screenshot or transport verification was performed.
These tests must not be reported as passing until an exact QA candidate runs them.

`UITests/MessagesDriveTests.swift` replaces the old optional-tap/screenshot driver.
It never launches Messages, searches contacts/history, obtains a pairing code or
taps the Messages Send button. Missing setup, IDs and unsupported paths fail the
test; there is no `XCTSkip`, optional success or screenshots-as-assertions path.

## Native owner: targets and real source membership

The native owner owns `project.yml`, configurations, shared implementations,
entitlements, accessibility and runtime injection. No wiring was changed here.

1. Provide `CalledItCoreTests`, an iOS simulator XCTest unit-test bundle in an
   explicit QA/Test configuration, with bundle ID
   `com.mikunad.calledit.qa.coretests`. For the **baseline regression sources**,
   compile `Tests/CardSerializationTests.swift`, `Tests/ConversationLinksTests.swift`,
   `Tests/NativeSafetyContractTests.swift`, `TestSupport/NativeQARun.swift` and the
   actual `Extension/**/*.swift` sources into the test bundle. All extension source
   membership is required today because `Cards` and `Links` are declared in
   `AppModel.swift`, which references the real controller and views. Link the iOS
   Messages/UIKit/SwiftUI/Security/CryptoKit frameworks. Do not compile `App/` or
   instantiate a production host; use a hostless test bundle (`TEST_HOST` and
   `BUNDLE_LOADER` empty). No product module is mocked or imported under an invented
   name. If hostless UIKit rendering is unsupported by the selected Xcode runner,
   the owner must supply an inert QA-only test host with the same isolation; that
   is a blocked wiring dependency, not permission to run the release app.
2. Add the real `Shared/**/*.swift` implementation to the unit target once its API
   is published. Shared config/locator/session/account tests must call that real
   implementation. The existing Cards/Links regressions are not a replacement for
   those pending tests. If source extraction changes those symbols, update the
   test call sites against the published API; do not add a test-local policy copy,
   conditional compilation that silently removes cases, or weaken expectations.
3. Provide `CalledItUITests` with `UITests/**/*.swift` and
   `TestSupport/NativeQARun.swift` only. Use QA host bundle
   `com.mikunad.calledit.qa.host`, embedded Messages extension
   `com.mikunad.calledit.qa.host.messages`, and runner bundle
   `com.mikunad.calledit.qa.uitests` (Xcode may append `.xctrunner`). UI tests must
   not link a replacement extension view tree into the runner.
4. Make the test scheme/configuration explicitly QA-only. Add neither test source,
   TestSupport, fixture adapters, fake OTP, diagnostic fields nor test routes to a
   Release/TestFlight artifact. A scheme test-plan check must prove their absence
   from the distributed candidate. Do not keep the old `PAIR_CODE` runner setting.

The fixed QA bundle names and card origin above are **requested owner contracts**,
not a claim these build variants already exist. Renaming them requires updating
the runner's exact allowlist, not accepting an arbitrary bundle through the env.

## Fail-closed provisioning and injection

Use only a newly created/erased dedicated simulator, no personal device, no Apple
account/history, and one synthetic conversation per run. An authorized external
Mac provisioner/operator must attest erasure, OS/UDID, installed bundle inventory,
and the actual synthetic conversation before running tests. An environment string
does not prove erasure or real transport. Do not attach this runner to a personal
Messages session, even if someone supplies matching environment values.

The scheme must forward these variables into the **test runner**, not merely the
shell or MobileSMS launch environment:

| Variable | Required value |
|---|---|
| `CALLEDIT_QA_ALLOW_EXECUTION` | `DEDICATED_CLEAN_SIMULATOR_ONLY` |
| `CALLEDIT_QA_RUN_ID` | fresh `e2e_` plus 8–64 lowercase alphanumeric/underscore characters |
| `CALLEDIT_QA_SIMULATOR_UDID` | the executing `SIMULATOR_UDID`, a valid UUID |
| `CALLEDIT_QA_ERASED_FOR_RUN` | the exact run ID, after the provisioner verified erasure |
| `CALLEDIT_QA_HOST_BUNDLE` | `com.mikunad.calledit.qa.host` |
| `CALLEDIT_QA_EXTENSION_BUNDLE` | `com.mikunad.calledit.qa.host.messages` |
| `CALLEDIT_QA_CARD_ORIGIN` | `https://calledit.qa.invalid` (reserved, never live hosting) |
| `CALLEDIT_QA_ENDPOINT` | explicit loopback adapter origin with a port; `http`/`https`, only `localhost`, `127.0.0.1`, `[::1]`; no credentials/path/query/fragment |
| `CALLEDIT_QA_CONVERSATION` | `CalledIt QA <exact run ID>` |
| `CALLEDIT_QA_SCENARIO` | the one selected UI case's scenario below |

Strip deployment/provider credentials and `PAIR_CODE` from the Mac runner's
environment. `NativeQARun` rejects inherited deployment/LLM/APNs/pair credentials,
nonloopback adapters, production bundle IDs and the existing live deployment.
It has no network API and does not create or reset data.

The native owner must inject the same resolved endpoint into **both** QA host and
extension (`Config.api` in the baseline), and the reserved QA card origin into
the real locator implementation. `Config.web` semantics await the owner's
runtime contract; it is not assumed to mean the card origin. There is no safe runtime override in
the baseline. The QA binaries must start inert and fail before networking unless
their compiled QA identity and explicit isolated configuration match. Enforce
loopback-only egress in the QA adapter/runtime; displaying a diagnostic label is
not an egress control. The runner checks the loaded runtime before any tap.
Passing environment to `XCUIApplication(MobileSMS)` does not configure an embedded
extension; the native owner must supply an actual QA-only shared-container/config
path with production keychain/app-group separation.

No backend endpoint names, seed/reset route, clock override or public OTP bypass
are introduced by these tests. The loopback adapter must implement the actual
published backend contract or record/replay its synthetic fixtures. Its server
owns reveal scheduling. Provision fixtures externally, never through production
routes. Auth uses synthetic numbers `+12025550101` (friend) and `+12025550102`
(outsider), code `000000`, only in the disabled-in-Release fake provider. No SMS
is sent, and no real pairing/phone identity is claimed.

## Actual-extension runtime and accessibility contract

Each UI test is a separate `-only-testing` invocation. The provisioner/operator
must already have the actual extension open in the prepared synthetic conversation
and the QA host installed; there is no asserted public API for opening an arbitrary
Messages conversation from the host. If this cannot be provided, mark the case
blocked. Do not replace it with a standalone host render. Tests query only
`calledit.extension.root` after the safety gate; they do not navigate the inbox.

Expose the root as an accessibility container retaining real children. Exact IDs
below must identify the **real controls/state**, never a mock screen. Dynamic
diagnostics use `accessibilityValue` (a fixed neutral label is fine). Do not put
credentials into any diagnostic. QA diagnostics are absent from Release.

| IDs | Required values/source |
|---|---|
| `qa.runtime.contract`, `.mode`, `.run`, `.simulator` | `calledit-native-qa-v1`, `QA`, exact run ID, actual simulator UUID |
| `qa.runtime.endpoint`, `.hostBundle`, `.extensionBundle`, `.cardOrigin` | actual resolved runtime config, not a copy of requested env values |
| `qa.runtime.conversation` | exact QA conversation registration; external provisioner must bind it to the actual device-local conversation identity (the extension cannot read a chat title/history) |
| `qa.runtime.networkPolicy`, `.livePairing` | enforced `loopback-only`, `disabled` |
| `qa.scenario`, `qa.actor.id` | provisioned scenario, actual stable account ID or `anonymous` |
| `qa.room.id`, `qa.bet.id`, `qa.bet.format`, `qa.bet.state` | actual view-model IDs/canonical format (`yes_no`, `over_under`, `this_that`); `sealed` or `revealed`; absent room is `none` |
| `qa.pending.bet`, `qa.selected.bet` | pending locator and actual selected-message bet, respectively |
| `qa.response.cardJSON` | actual last card response object before decoding; not a privacy pass/fail flag; synthetic QA data only |
| `qa.response.revealTransitionCount` | actual sealed-to-revealed transition count for this view |
| `qa.fixture.phase` (host) | actual isolated adapter phase; reveal scenarios transition within 25s without client clock overrides |
| `qa.links.writeCount` | observed mapping writes since scenario start |
| `qa.pick.option`, `.count`, `.user`, `.bet`, `.version` | readback from the isolated store after the real save; not optimistic UI state |
| `qa.mutations.veto`, `qa.outbox.transcriptCount`, `.pushCount`, `.sentCount` | actual adapter/transport observations since scenario start |
| `qa.draft.bet`, `.room`, `.insertCount`, `.reusesSelectedSession` | actual MSMessage selected/created for insertion; compare MSSession objects, not an invented MSSession UUID/property |
| `qa.draft.metadataJSON` | all actual MSMessage/template text fields: `url`, `summaryText`, `accessibilityLabel`, `caption`, `subcaption`, `trailingCaption`, `trailingSubcaption`, `imageTitle`, `imageSubtitle`; include JSON nulls, never a computed privacy verdict |
| `qa.preferences.noBets`, `.topics`, `qa.control.result`, `qa.board.room` | acknowledged persisted data or completed state from the adapter |

Expose those runtime fields in the QA host too. Required product control IDs:

- `calledit.bet.countdown`, `.lockedSurface`, `.question`, `.unavailable`, `.veto`,
  `.option.0`, `.option.1`, `.sendUpdate`, `.sendResult`, `.revealAccessible`.
- `calledit.pick.confidence` (real confidence slider), `.save`;
  `calledit.link.required`; `calledit.navigation.home`;
  `calledit.recent.bet.<bet ID>`; `calledit.draft.status` with `Draft ready`, not
  a sent claim. Post/update/result inserts a draft only; the suite never sends it.
- `calledit.auth.openHost`, `.phone`, `.requestCode`, `.code`, `.verify`;
  `calledit.account.signOut`. Auth controls are in the actual host; returning to
  Messages must share its entitled session without a second pairing screen.
- `calledit.controls.open`, `.noBets`, `.topics`, `.leave`, `.delete`, `.back`;
  `calledit.control.<name>.screen`; `calledit.control.noBets.toggle`;
  `calledit.control.topics.input`, `.save`;
  `calledit.control.leave.confirm`, `calledit.control.delete.confirm`.
  Current tests request in-extension controls; if the native design opens host
  settings instead, publish that real navigation contract and update the container
  assertions before claiming coverage. Do not add a test-only copy of settings.
- `calledit.board.open`, `.send`, `.points.<account ID>`.

## Synthetic scenario inventory and assertion IDs

All IDs come from `NativeQARun`: `<run>_g1`, `_g2`, `_bet_a`, `_bet_b`, `_friend`,
`_subject`, `_outsider`. The private question/options/context/proof/token markers
are synthetic strings derived from the same run, never copied user content.

| Scenario / tests | Assertions / coverage |
|---|---|
| Unit config and safety tests | `NATIVE-CONFIG-01`, `NATIVE-SAFETY-01..05`: actual API config must be QA-only; malformed safety gates reject |
| Unit initial/update/result/veto/board/fallback | `NATIVE-CARD-*`, `NATIVE-RESULT-01..02`, `NATIVE-VETO-*`, `NATIVE-BOARD-01..04`, `NATIVE-FALLBACK-01..03`: real MSMessage text fields/HTTPS opaque locator; result and board remain neutral; changed board names/scores cannot change shared pixels; install instruction exists |
| Unit conversation/session | `NATIVE-LINK-01..04`, `NATIVE-SESSION-01..02`: no last-room fallback, independent explicit links, new vs explicitly supplied MSSession objects |
| `subject_locked`, `subject_veto` | `NATIVE-LOCK-*`, `NATIVE-CONTROL-01..06`: use a pre-reveal This/That card with private sentinels, inspect locked tree + raw response, no opacity-only hiding; one-tap quiet veto |
| `friend_yesno`, `friend_overunder`, `friend_multi` | `NATIVE-FORMAT-*`, `NATIVE-PICK-*`: exactly two real options, authorized question, confidence save <10s after option tap, edit replaces one persisted pick. Options: Yes/No, Over 2.5/Under 2.5, private A/B sentinels |
| `unknown_conversation`, `mismatched_locator` | `NATIVE-CHAT-*`, `NATIVE-ROUTE-*`: preload a different last mapping, then an unknown conversation; also supply G2 + bet A from G1. Neither may link/render a foreign room |
| `host_handoff`, `account_switch` | `NATIVE-AUTH-*`, `NATIVE-ACCOUNT-*`: original pending bet survives host fake-provider sign-in; host/extension session shared; sign-out and outsider sign-in clear prior content/mappings and deny old bet |
| `same_bet_update`, `different_bet_update`, `different_bet_result` | `NATIVE-SESSION-03..09`, `NATIVE-RESULT-03..05`, `NATIVE-DRAFT-*`: selected A may update A, never B; fixture with selected A and navigation to settled B for result; real draft metadata inspected, insertion not delivery |
| `reveal_active`, `reveal_resume` | `NATIVE-REVEAL-*`, `NATIVE-RESUME-*`: start sealed; isolated server reveals within 25s; active refresh and background/reactivation, accessible reveal, no pick controls; no production test clock |
| `controls`, `preferences`, `leave_group`, `delete_account` | `NATIVE-CONTROL-07..10`, `NATIVE-PREFERENCES-*`, `NATIVE-ERASE-*`: control destinations in two taps, persisted preferences, confirmed leave/delete clear current content/access |
| `board_g1`, `board_g2` | `NATIVE-BOARD-05..13`: one account in two groups, independent read-only seeded board values (17 and 4), no foreign-room marker; neutral board draft. Values test rendering/scoping only, **not an approved scoring formula** |
| `app_absent`, `install_return` | `NATIVE-FALLBACK-04..05`, `NATIVE-INSTALL-01..02`: explicit **BLOCKED failing tests**, not simulated transport passes. Need an authorized install-inventory/fallback-selector contract and real Store/TestFlight original-card return evidence |

Shared account-scope and mismatched-session **model** tests await the owner's real
Shared API. UI contracts above cover those expectations separately. Backend
authorization, settlement/challenge math, notifications, membership/deletion
cascades and fixture accuracy need their own real handler/contract tests. Raw
response/transport diagnostics must be wired to actual I/O; labels alone are not
proof. Template pixel comparison does not prove VoiceOver, OS snapshots, APNs,
forwarding or physical rendering. Those require the dedicated QA transport lane.

The unit result fixture still uses the baseline `BetCard.kind` values
`yesno`/`overunder`/`multi` because those are real existing native API values, not
the future Shared contract. The UI contract requires canonical V0 formats; the
owner must migrate the real DTO/view-model and then the baseline unit call sites.
Neither source set claims the migration already works.

The canonical API handoff now requires `${V0_CARD_ORIGIN}/c/<random locator>` with
zero query/fragment. Serializer assertions follow that navigation contract, not
the baseline's `r`/`b` query encoding. Baseline Cards APIs cannot accept a locator
DTO yet; their call-site migration awaits the real native implementation. The
static `Get the app` assertion retains the user acceptance requirement. The
canonical neutral caption/accessibility copy and useful install instructions must
both be satisfied (possibly on separate fallback surfaces); any copy conflict
needs Captain resolution, not deleting the installation assertion.

## Execution after dependencies land (Mac only)

First provision and attest a fresh dedicated simulator and externally seed one
scenario through the isolated adapter. Record candidate SHA, backend/adapter
build, QA bundle versions, run ID, fixture IDs, simulator UDID/OS, case/assertion
IDs, timestamps and the resulting `.xcresult`. Supply the environment table using
the owner's QA test plan; the current scheme does not forward it.

After the native owner adds the requested QA scheme (name requested here:
`CalledItQA`), a unit invocation is:

```sh
cd native-imessage
xcodegen generate
xcodebuild test -project CalledItMessages.xcodeproj -scheme CalledItQA \
  -configuration QA -destination "platform=iOS Simulator,id=$CALLEDIT_QA_SIMULATOR_UDID" \
  -only-testing:CalledItCoreTests -resultBundlePath "$ARTIFACTS/native-unit.xcresult"
```

For UI, prepare the real extension, set exactly the matching scenario in the QA
test plan, then run one method (do not run all scenarios against one fixture):

```sh
xcodebuild test -project CalledItMessages.xcodeproj -scheme CalledItQA \
  -configuration QA -destination "platform=iOS Simulator,id=$CALLEDIT_QA_SIMULATOR_UDID" \
  -only-testing:CalledItUITests/MessagesDriveTests/testLockedSubjectCannotExposePrivateAccessibilityContent \
  -resultBundlePath "$ARTIFACTS/subject-locked.xcresult"
```

These commands depend on owner wiring; they do not work in the current baseline.
Run the same cases in accessible text sizes/VoiceOver/Reduce Motion under an
owner-supported test plan. No physical account/device sends are automated here.
App-absent fallback, supported after-install return and three-party transport need
separately authorized operator evidence on the exact signed candidate. A host-only
Revyl launch or an old screenshot cannot satisfy any of those cases.
