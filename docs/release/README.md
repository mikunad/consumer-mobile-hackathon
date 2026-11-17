# External TestFlight release runbook

Status: **NO-GO**. This is a release toolkit, not an attestation that V0 works or a permission to distribute. Ship the existing Swift host and embedded Messages extension, not the legacy Expo app. External invited friend groups require every V0 criterion; Linq is excluded.

## Authority and gates

The release operator obtains a recorded Captain approval for each consequential phase. Approval to write code does not authorize merging, production deployment/data changes, account/capability changes, phone reinstall, upload, Beta App Review submission, tester invitations or notification publication. No script here performs those actions. Never enable automatic distribution or public TestFlight links by default.

| Gate | Current state | Evidence required to turn green |
|---|---|---|
| Product rules | Unverified | Approved scoring, streak, timing, challenge, creator and shared-goal rules; no cash wagering or individual prize CTA |
| Apple access | Blocked | Paid membership/team, role and agreements observed in the actual accounts; final app record and identifiers |
| Native signing | Blocked | Correct host/extension profiles, shared-session entitlements, production APNs and exact signed artifact inspection |
| Backend | Unverified | Pinned deployment/source/config, reviewed migrations, backward compatibility and rollback rehearsal |
| Full V0 | Unverified | All nine journeys, security and notification assertions on the final candidate; no skipped criterion treated as passed |
| Privacy/UGC | Unverified | Approved accurate disclosures, AI permission, report/block/respond, account/data deletion, live support/policy URLs |
| Physical QA | Blocked | Authorized dedicated three-phone proof including install-to-original-bet and actual transport |
| Apple external beta | Not started | Captain-approved upload, processing/compliance, Beta App Review approval, then separately approved invitations |

See [preflight](preflight.md), [metadata](metadata.md), [privacy/support drafts](privacy-support-drafts.md), [backend promotion](backend-rollout.md), [physical QA](physical-qa.md) and [CI proposal](ci-proposal.md). No gate is green merely because a local inspection command exits zero.

## Offline release tooling

Requires Python 3.10+; signed operations require the approved Mac with pinned Xcode and XcodeGen, existing distribution identity/private key and installed profiles. No tool downloads profiles or uses `-allowProvisioningUpdates`. Run `xcodebuild -help` on that pinned toolchain to verify its `app-store-connect` export options before first use. Commands have not been exercised on macOS yet.

1. Integrator assembles the coordinated candidate, preserving the PR3 server-clock fix. Record the full clean source SHA, backend source/config and rule versions. Do not build from an uncommitted workspace or infer deployed state from Git.
2. Copy `release/candidate.example.json` to a **private location outside Git**, fill every null from verified evidence and record the Captain approval reference. The example deliberately fails validation. Config contains only nonsecret references, UUIDs, certificate fingerprints and approved origins, never tokens, P8 contents or signing passwords. Build channel (`qa|release`) is independent of backend environment (`local|staging|production` in native). This App Store candidate tool accepts only staging/production backends and requires the **release** channel for signed actions. Use separate configs and build numbers for staging and production. TestFlight always uses production APNs; its backend may be approved staging, never fixture adapters.
3. Native owner must wire the contract below before archiving. These scripts cannot repair native/project configuration. Existing baseline hardcoded endpoints and literal Info.plist versions will fail inspection. Obtain a saved JSON **value** from the integrator's `v0Runtime:attestation` only through an authorized environment read; record its observation time/origin and deployment receipt separately. The tool compares exact app/environment/deployment/source/schema/contract/config and `testAdapters=false`; it never fetches a backend itself.
4. Execute locally after archive authorization, using new private output directories outside the repository:

```sh
python3 -m unittest discover -s release -p 'test_*.py' -v
python3 release/candidate.py validate --config "$PRIVATE_CONFIG"
python3 release/candidate.py attest --config "$PRIVATE_CONFIG" --attestation "$PRIVATE_ATTESTATION"
python3 release/candidate.py archive --config "$PRIVATE_CONFIG" --attestation "$PRIVATE_ATTESTATION" \
  --output "$PRIVATE_ARCHIVE_OUTPUT"
python3 release/candidate.py export --config "$PRIVATE_CONFIG" \
  --attestation "$PRIVATE_ATTESTATION" \
  --artifact "$PRIVATE_ARCHIVE_OUTPUT/CalledIt.xcarchive" --output "$PRIVATE_EXPORT_OUTPUT"
python3 release/candidate.py inspect --config "$PRIVATE_CONFIG" \
  --attestation "$PRIVATE_ATTESTATION" \
  --artifact "$PRIVATE_EXPORT_OUTPUT/export/CalledItMessages.ipa" --output "$PRIVATE_INSPECTION_OUTPUT"
```

Use the actual single IPA filename produced by export; do not guess it. Archive/export are local only. The tool exports only committed native sources into a temporary build directory, strips inherited provider/deploy credentials from subprocesses, pins toolchain/build/settings and maps both provisioning profiles. It verifies signatures and actual signer fingerprint, profile hashes/type/expiry/team/App ID, allowed entitlements, both versions and runtime configuration. It rejects extra extensions, debug signing, fixture assets, recognizable private keys, local endpoints and unpinned Convex origins. Sanitized `inspection.json` records executable/profile/IPA/config/attestation hashes and Git tree inventory digests. Matching saved metadata is not proof of live deployed code; the independent integrator receipt and observation remain required.

The endpoint/secret scan is defense in depth, **not proof of the absence of all test hooks, secrets or network calls**. Source review and artifact/source safety tests remain mandatory. Repeatable pinned inputs are the goal; signing timestamps and toolchain output mean archives are not promised byte-identical. Actual profile authorization, install and push registration must still work on QA devices. Raw provisioning/CMS output and private keys must never enter reports or CI logs. Failures intentionally omit raw subprocess logs; debug on the authorized Mac without publishing account/signing output.

## Native-owner build contract (pending integration)

Both targets' Release Info.plists must resolve the following from build settings, and runtime must consume these values rather than hardcoded fallbacks:

| Info.plist key | Build setting / type |
|---|---|
| `CalledItAPIURL` | `$(CALLED_IT_API_URL)` string |
| `CalledItWebURL` | `$(CALLED_IT_WEB_URL)` string |
| `CalledItExpectedAPIHost` | `$(CALLED_IT_EXPECTED_API_HOST)` derived from validated API origin, not independently entered |
| `CalledItExpectedCardHost` | `$(CALLED_IT_EXPECTED_CARD_HOST)` derived from validated web/card origin |
| `CalledItBuildChannel` | `$(CALLED_IT_BUILD_CHANNEL)` string: qa or release; App Store/TestFlight candidate requires release |
| `CalledItReleaseEnvironment` | `$(CALLED_IT_ENVIRONMENT)` string: staging or production |
| `CalledItSourceRevision` | `$(CALLED_IT_SOURCE_REVISION)` full **native artifact** SHA |
| `CalledItExpectedBackendSourceRevision` | `$(CALLED_IT_EXPECTED_BACKEND_SOURCE_REVISION)` full backend SHA, independent of native SHA |
| `CalledItExpectedBackendDeploymentID` | `$(CALLED_IT_EXPECTED_BACKEND_DEPLOYMENT_ID)` nonsecret selected deployment ID |
| `CalledItExpectedBackendConfigVersion` | `$(CALLED_IT_EXPECTED_BACKEND_CONFIG_VERSION)` expected backend config version |
| `CalledItAppGroup` | `$(CALLED_IT_APP_GROUP)` verified shared App Group from candidate config |
| `CalledItKeychainGroup` | `$(CALLED_IT_KEYCHAIN_GROUP)` verified shared Keychain group from candidate config |
| `CalledItSupportURL` | `$(CALLED_IT_SUPPORT_URL)` owner-approved public HTTPS support URL, validated separately from card/API origins |
| `CalledItAPNsEnvironment` | `$(CALLED_IT_APNS_ENVIRONMENT)` production for TestFlight, including staging-backed candidates |
| `CalledItFixtureMode` | Boolean false, never a runtime test toggle |
| `CFBundleVersion` | `$(CURRENT_PROJECT_VERSION)` |
| `CFBundleShortVersionString` | `$(MARKETING_VERSION)` |

Host `PROVISIONING_PROFILE_SPECIFIER` must resolve `$(CALLED_IT_HOST_PROFILE)` and extension `$(CALLED_IT_EXTENSION_PROFILE)` in Release. Both need the approved App Group and explicit shared Keychain access group; the host needs `aps-environment=production` and `applinks:<validated card host>` in its associated-domain entitlement. Archive injects those group settings, production APNs, the derived host pins and `CALLED_IT_DEVELOPMENT_TEAM` as well as `DEVELOPMENT_TEAM`. A valid associated-domain entitlement is not proof of a reachable/valid AASA association; verify that separately at the authorized environment/device gate. Session-sharing behavior needs tests; matching entitlements alone do not prove it. App ID prefix and Team ID are separately pinned because they need not be the same for every account history. Runtime must reject missing config, test hooks and invalid environments, and compare expected backend environment/source/deployment/config against attestation before using it. Release fixture mode stays false even against staging. No root/native/package changes are owned by this release track.

## After all technical gates pass

Prepare the private evidence packet: config hash; inspection manifest; host/extension/source/backend/schema/config/rules/test versions; CI and E2E run IDs; physical operator record; privacy/UGC/deletion proof; final metadata; Apple account/profile preflight. Invalidate affected evidence after any code/backend/config change. Keep secrets and personal data out of the packet.

Ask the Captain for the upload gate. An authorized operator then uploads the exact inspected IPA (no build-number rewriting), waits for Apple processing, resolves compliance and submits the first external build for Beta App Review with automatic tester notification disabled. Apple review timing is external; there is no same-day availability promise. After approval, verify build identity/status and ask for the invitation gate before emailing the selected external groups. An internal group must exist before an external group under Apple's current workflow. An internal-only upload cannot later serve external testers. Never replace this with Personal Team/ad-hoc installation proof.

Monitor only approved QA/release telemetry. On privacy/identity/ledger failure, stop new invitations and ask the Captain for containment: approved backend kill switches, disable distribution or expire the beta, and a compatible hotfix. Expiring a build does not retract delivered Messages snapshots or repair backend state.
