# Called It native app

The Swift host app embeds the real Messages extension. `Shared/` contains the v0.2 transport, configuration, session and DTO code. `App/` owns phone-code sign-in and push registration; `Extension/` owns private card views and manual Messages drafts. There is no web-account pairing requirement or legacy token migration.

## Configuration

Generate the project with XcodeGen before building. Debug/QA use `Configuration/QA.xcconfig`; distribution uses `Configuration/Release.xcconfig`. Both intentionally have no default endpoint. Supply nonsecret deployment pins through ignored `*.local.xcconfig` files or build settings:

- `CALLED_IT_API_URL`, `CALLED_IT_WEB_URL`, and their `CALLED_IT_EXPECTED_API_HOST` / `CALLED_IT_EXPECTED_CARD_HOST` matches.
- `CALLED_IT_BUILD_CHANNEL` (`qa` or `release`), `CALLED_IT_ENVIRONMENT` (`local`, `staging`, or `production`), `CALLED_IT_SOURCE_REVISION` (native artifact), `CALLED_IT_EXPECTED_BACKEND_SOURCE_REVISION`, `CALLED_IT_EXPECTED_BACKEND_DEPLOYMENT_ID`, `CALLED_IT_EXPECTED_BACKEND_CONFIG_VERSION`.
- `CALLED_IT_APP_GROUP`, `CALLED_IT_KEYCHAIN_GROUP`, and the configured HTTPS `CALLED_IT_SUPPORT_URL`.

In xcconfig files, encode an HTTPS value as `https:/$()/example.invalid` so `//` is not treated as a comment. Placeholder values are not a runnable backend. Runtime checks reject missing configuration, origin mismatches, wrong attestation pins and production attestation in QA. Authenticated traffic is never redirected. Only the v0 API namespace is allowed; no device clock override is sent.

Release has separate manual host and extension profiles through `CALLED_IT_HOST_PROFILE` / `CALLED_IT_EXTENSION_PROFILE`, and a separately supplied `CALLED_IT_DEVELOPMENT_TEAM`. The configured App Group/Keychain identifiers remain subject to signing verification. Both targets share the explicit Keychain access group; only the host requests APNs and associated-domain capabilities. Distribution uses production APNs even when its backend is staging. Do not enable automatic provisioning to bypass an unverified profile.

## Simulator compile

```sh
xcodegen generate
xcodebuild -project CalledItMessages.xcodeproj -scheme CalledItMessages \
  -configuration QA -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

An unsigned simulator compile proves neither shared-Keychain access nor Messages transport. Use a clean, explicitly authorized QA simulator for interaction tests. Never run the historical screenshot driver against personal Messages or a live endpoint.

`CalledItCoreTests` compiles shared non-UI runtime code with `Tests/` and `TestSupport/`. `CalledItUITests` uses `UITests/` and `TestSupport/`; fixture helpers are not application sources. Tests run in QA, never as part of a Release archive. The E2E owner supplies their assertions and isolated fixtures separately.

## Privacy and routing

Card URLs use only the configured HTTPS origin and `/c/<opaque locator>`. Shared ink templates contain the approved subject alias and neutral bettor initials/count, never question, options, context or proof. Static/forwarded copies remain recipient-owned. Card locators are navigation, not invitation grants.

Conversation routing is account/device-scoped and confirmed with the server. Unknown conversations have no last-room fallback. A selected message session is bound only after its card is authorized, and updates are keyed by that bet rather than the current unrelated selection. Picks, veto and answers do not send messages. A user must explicitly prepare and Send a neutral card update.

The host preserves an installed-app locator during sign-in. It tells people to return to the original message after an install; automatic deferred-install return is not promised. Invited membership requires explicit acceptance, and older cards remain unavailable after joining or rejoining.

## Implementation status

The current branch is an integration checkpoint, not a release candidate. It has native adapters/screens for auth, invitations, bets, confidence picks, quiet veto, answer/challenge, optional authenticated image/audio proof, board/history/goal, creator-turn/pass, weekly recap, notification preferences/tap routing and privacy controls. Policy-dependent creation/goals/turn passing stay disabled while rules are pending. Economics aren't calculated locally. Provider access, attested nonproduction deployment, current assertive tests, visual inspection, signed capabilities and physical transport are separate verification gates.

The native confidence control is 1–100 and sends the canonical normalized confidence value, never a points debit. Correct calls earn confidence points times the server's streak bonus; wrong calls earn zero without reducing points. Choice/confidence are local drafts until final Confirm pick. A matching server receipt or persisted myPick confirms and permanently locks only that bettor's choice; other eligible members can still confirm before reveal. A lost response triggers read/retry resolution, not a local success or unlocked edit. Reveal defaults to the next group-local 8 PM with overrides; cutoffAt equals that explicit reveal timestamp, with no independent cutoff control or grace period. Answer/challenge views use server deadlines for the approved 24-hour unanswered timeout and one-hour challenge window. Remaining streak/adjudication/group rules are still pending.
