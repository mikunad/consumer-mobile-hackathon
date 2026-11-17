# Authorized three-phone distribution evidence

Status: **not executed**. This is an operator plan for the E2E owner's all-V0 case suite, not replacement tests. Simulator/Revyl host launch, screenshots from an older build and Personal Team installation cannot pass this gate. No personal chats, phone reinstall, real send, provider notification, Apple upload or tester invitation is authorized by this document.

## Setup gate

Captain approves three dedicated QA iPhones/accounts, synthetic content, recipients, isolated backend, distribution channel and operator window. Creator Cora, friend Finn and subject Sage each use a distinct QA iMessage/verified app account. Use a separate synthetic outsider conversation/account and app-absent recipient where possible; add a fourth dedicated device if simultaneous outsider proof needs it. Never use a personal thread as the outsider fixture. A new app-absent install on an approved spare is preferable to reinstalling anyone's phone; either needs explicit permission.

Operator records device/OS aliases (no UDIDs/phone numbers), installed host+extension bundle/version/build and IPA hash/source/backend/config/schema/rules/test revision, TestFlight build/approval state and date. Confirm all three use the same release candidate. Create two synthetic groups to test independent boards and unknown-chat isolation. Session and OTP values never enter evidence. UI automation may only address dedicated QA Messages; do not browse a person's messages or rely on preexisting contacts/history.

Before external approval, device installation/transport evidence can only be **provisional internal-channel evidence**, explicitly labeled. Final TestFlight external install/return behavior is a separate post-review proof; do not pretend a direct development install tests the Store/TestFlight pathway. This ordering does not authorize an early upload.

## Operator assertions

| Cases | Action and pass condition | Evidence |
|---|---|---|
| J1, R1 | Open extension, create/insert/manual Send neutral first card; all three resolve same authorized group/board; unknown chat never inherits prior group | Timed first warm send (<60s), screenshots and sanitized backend group assertion |
| J2, R5 | App-absent recipient follows **actual TestFlight** invite/install, verifies phone and returns to the original tapped bet without second extension sign-in | Uncut synthetic install-to-original-bet recording, exact taps and build; failure is blocked, no manual-reopen substitution for full V0 |
| J3, J6 | Test each two-choice format, edit confidence until cutoff, tap-to-saved pick <10s, suggestions <3s and safe/subject-hidden, turn rotation/noon pass | Timings plus backend saved-state assertions and suite case IDs; no fake-time hook in distributed client |
| J4, SEC3, R2 | Subject transcript, static card/image, URL preview, notification, VoiceOver/accessibility and offline/restart/suspend snapshots never reveal question/options/context/proof before server reveal; friend sees only authorized content | Synthetic sentinels, payload/accessibility scans plus recipient screenshots. Rubbing/clock tampering is not server authorization. |
| J5, R4 | Subject answers after reveal, manually sends result update belonging to original bet/session; all three see correct result; challenge/timeout and final ledger match approved rules | Compare original/update payload locators/session, actual transcript placement (including moved-to-bottom), final assertion IDs |
| J7 | Independent boards, approved confidence/streak formula, points-only group goal; weekly recap fixed day and neutral | Backend result oracle and actual lifecycle/provider evidence; no cash/prize CTA |
| J8, J9, SEC1, R3 | Quiet veto, no-bets/topics/report/block/leave/delete; forwarding initial/update/board/result card to outsider grants no access or membership; new/rejoined/left accounts respect membership intervals | Sanitized denials, controls within two taps, stale URL/token denial, no secret-bearing group announcement |
| R5 | Unsupported/SMS and app-absent fallback stays neutral and useful; cannot become a legacy-web privacy bypass | Dedicated recipient screenshot; label unsupported test infrastructure as blocked, not passed |

## Notification matrix (N1–N3)

For turn, noon pass, reveal, answer timeout/challenge finalization and weekly recap, first assert scheduled intents/idempotency in deterministic backend tests. Physical release smoke uses **production APNs for TestFlight**, even when the approved backend is staging. Match provider topic to host ID, environment to device registration and event to authorized user/group/bet. APNs acceptance isn't delivery and delivery isn't a saved pick or an iMessage send.

On dedicated QA phones cover foreground, background, normally terminated and user-force-quit behavior separately; permission allowed, denied and provisional where applicable; lock screen with previews shown/hidden; offline/reconnect; expired notification; token refresh; sign-out/user switch; leave/delete/veto; multiple-device routing and invalid-token suppression. Each notification remains neutral and cold-open reauthorizes the original eligible bet. It may open the host; do not claim it can open a particular Messages thread automatically. Manual gameplay remains usable when notifications are denied. Record observed best-effort delay, not an exact delivery-time promise.

No accelerated release clocks or test outbox provider endpoints in the submitted app. For long lifecycle windows, use deterministic test evidence plus approved real-schedule physical observations, keeping them distinct. Missing permission/provider/device cases are blocked.

## Evidence record and cleanup

Each result includes case ID, status (`passed`, `failed`, `blocked`), assertion, candidate identifiers/hashes, backend/schema/config/rules/test revisions, QA run namespace, operator/device aliases, UTC times, observed latency and sanitized artifact reference. A screenshot without assertion/source/build identity is illustrative only. No tokens, real phone contacts, personal chat, OTP, private key or raw profile content. No automatic public upload/PR proof activation; operator and Captain approve any public-safe assets separately.

E2E owner supplies canonical IDs/assertion results and ensures every V0 criterion is covered. Release operator supplies signed binary/install/channel/transport observations. Rerun affected evidence after candidate changes. Teardown only approved synthetic staging namespace/device registrations after target assertion; never reset real groups, revoke personal sessions or delete personal Messages.
