# Read-only distribution preflight

Observed November 16, 2026. Baseline: `capy/imessage-ext` at `d23f9e7e8799988505a2d6bf5c6c1981716aa6d9`; isolated track branch `capy/release-v0-distribution`. No Apple session, keychain, profile or backend was accessed. Files can establish configuration intent, not actual account readiness.

| Item | What is known | Required read-only proof / owner |
|---|---|---|
| Paid Apple Developer Program | Unknown | Account Holder shows active paid membership, legal entity, team ID, expiry and any agreement action needed. Personal Team install is insufficient. |
| Roles and agreements | Unknown | Existing account shows app-scoped role, Certificates/Identifiers/Profiles access separately, agreements status; only Account Holder signs legal agreements. No request for Admin by default. |
| App Store Connect record | Unknown | Existing record's Apple ID, bundle ID, SKU, platform, provider/team and editable status. Do not create it during preflight. |
| Host/extension IDs | Repo specifies `com.mikunad.calledit.messages` and `com.mikunad.calledit.messages.ext` | Compare both explicit App IDs in selected team, native Release settings and eventual signature. These are not final approved IDs yet. |
| Team | Repo hardcodes `6555P5TAV6`, automatic signing | Compare account membership and actual signing metadata. A literal team ID proves neither paid enrollment nor authority. |
| Certificates/profiles | Unknown, not inferred from filenames | Existing identity fingerprint and private-key availability as boolean; profile UUID/hash/type/expiry, App ID prefix, team, distribution cert fingerprint, entitlement summary for both targets. No private key export or full profile dump. |
| Shared App Group | No entitlement declaration in baseline project | Verify registered App Group assigned to both IDs and allowed by both profiles; inspect signatures; then host→extension session-sharing/revocation test. |
| Shared Keychain | Baseline extension stores in its own default group; no explicit shared group | Pin allowed group and keychain prefix in both profiles/signatures and explicit runtime access group. Never inspect actual session contents. |
| APNs | No baseline push entitlement/config proof | Host Push capability, production profile/entitlement, provider key/cert authorization summary, topic equals final host bundle ID, production endpoint, token/environment routing, nonsecret key ID/team references. No P8 content/token dump or push send in preflight. |
| Card association / support | New native contract pins card/API hosts and support URL; baseline has no verified website association | Compare host associated-domain entitlement and profile authorization to final card host; separately verify approved AASA hosting/association and real TestFlight install-return. Owner supplies a live HTTPS support page; no URL or hosting created by this track. |
| URLs/config | Baseline host and extension hardcode the legacy backend origins | Native owner injects/pins correct approved environment; integrator attests deployment. Reading source does not establish running production version. |
| Assets | Host 1024 icon and iMessage icon sets/files exist | Validate compiled icons, alpha/dimensions, iPad support (baseline device family 1,2), current screenshots and rights on final candidate; presence isn't approval. |

## Access route

At the single machine-list check, Mikun's MBP14 (`machine_01M7G62FACB4DZFRN45F9GW5F1`) was **offline**, last connected `2026-11-16T05:37:08.370Z` (November 15, 21:37:08 PT), with permission `ask`. Reconnect that Mac, then approve the read-only device agent/fresh worktree. Use its linked `/Users/mikunad/consumer-mobile-hackathon` folder and existing signed-in account; do not switch its working branch or inspect personal Messages. No polling and no cloud interactive Apple login while that paired device is the approved route.

App Store Connect discovery found no registered server/integration; exact `appstore` discovery returned no listing. Broader results were unrelated build tools, not an account connection. No plugin, account or credential was requested. Prefer the existing user's read-only account session on the reconnected Mac. If an API route is later selected, the Captain must approve the specific minimum app/role scope and credential need first. No inherited deployment key is used to probe availability.

## Mac operator checklist (not run)

- Record OS, `xcodebuild -version`, `xcodegen --version`, selected developer directory and app-scoped account/team observations. Do not record unrelated account lists or email/phone contents.
- With permission, summarize only matching distribution identity metadata and whether its private key is available. Parse only selected profiles locally. Record hashes and allowlisted metadata, not raw `security cms` output, keychain item lists, UDIDs, signing passwords or certificates/private keys.
- Compare existing profile entitlements for exact host/extension App IDs, group and Keychain access, APNs production, disabled debugging and TestFlight distribution. Record which capability is missing/expired; never regenerate or enable it during this read-only phase.
- Read ASC app record, app access/agreements, TestFlight state, compliance and metadata completeness. Evidence must name observation time, operator, team/app ID and redacted source. A denied screen is an access blocker, not proof the app/account does not exist.
- Stop for Captain approval before profile/certificate/App ID changes, provider setup, uploads, beta submission, invitations, phone installation or real notification sends.

## Current official references

Checked November 16, 2026; recheck the pinned Xcode's `xcodebuild -help` and account UI before execution.

- [Apple distribution](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases): paid program and local export versus upload.
- [Roles](https://developer.apple.com/help/app-store-connect/reference/role-permissions/): account authority and legal agreements.
- [App Store profiles](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/): explicit IDs and distribution profiles.
- [App Groups](https://developer.apple.com/help/account/identifiers/register-an-app-group/) and [capabilities](https://developer.apple.com/help/account/identifiers/enable-app-capabilities/): assignment and profile regeneration implications.
- [Shared Keychain](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps): explicit access groups and distinct App Group behavior.
- [APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns): production versus sandbox, topic and best-effort delivery.
- [External testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/): review, groups and invited distribution.
- [Convex production](https://docs.convex.dev/production/overview): staging separation, schema/function/scheduler compatibility.
