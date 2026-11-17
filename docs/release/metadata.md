# TestFlight metadata and reviewer worksheet

**Draft only. Do not paste into App Store Connect until final-candidate verification and owner approval.** No verified contact, public policy/support URL, reviewer identity or final Apple app record is available in this track. Placeholders below are release blockers, not dummy contact values to publish.

| Field | Draft / source needed |
|---|---|
| Name / locale | Called It; proposed English (US), owner confirms name availability/rights and supported locales |
| Apple ID / SKU / bundle / provider | Pending observed ASC record and final approved host ID; extension ID verified separately |
| Version / build | Exact candidate config; both host and extension must match; each upload has a new explicit build number |
| Beta app description | Conditional draft below; final behaviors must match all V0 evidence |
| What to Test | Exercise phone-code sign-in and shared extension session, same group across phones, create/send, confidential subject view, confidence picks/cutoff, reveal/settle/challenge, leaderboard/recap and all privacy controls; report case/build and synthetic repro, never private chat screenshots |
| Feedback email | **Owner supplies a monitored address**; also invitation reply-to; no fabricated contact |
| Privacy policy URL | **Owner-approved public HTTPS URL required**; test without login, including mobile layout and linked in app |
| Support URL / contact | **Owner-approved public HTTPS URL and monitored contact required**; app and UGC support route tested |
| Marketing URL | Optional; omit unless owner supplies an accurate live page |
| Beta review contact | **Owner supplies authorized first/last name, phone, email** through private review metadata, not public Git |
| Review sign-in required | Yes, current target requires verified phone identity; dedicated reviewer access plan must work without personal accounts, inaccessible SMS or expiring invitations |
| Review username/password or alternate access | **Pending actual selected phone-auth provider and Apple-usable reviewer flow**; do not invent credentials or ship a production auth bypass |
| Review notes / attachments | Conditional procedure below; attach only current synthetic screenshots and exact build/backend evidence privately after gate |
| Category / rights | Owner selects accurate category and confirms content/asset rights; no real-money gambling claims |
| Age rating | Complete current Apple questionnaire: UGC/AI content, user interaction, controls and simulated betting themes must be truthfully assessed. No preselected age or Kids Category claim. Owner confirms eligibility policy and regions. |
| Encryption / export compliance | Inventory native Security/Keychain, URLSession HTTPS and all third-party crypto. Owner answers Apple's questionnaire; exemption/documentation and `ITSAppUsesNonExemptEncryption` are **not determined here**. Never set false merely to skip prompts. |
| Privacy labels / manifests | Complete data/partner inventory below; not “Data Not Collected.” Validate required-reason APIs, SDK manifests and archive privacy report on the actual binary. |
| Host icon | Baseline includes `AppIcon.appiconset/icon-1024.png`; check final compiled catalog, no alpha/rights issues and actual home-screen rendering |
| iMessage icons | Baseline includes iPhone/iPad and 1024×768 marketing assets; check final compiled catalogs and Messages drawer on supported devices |
| Screenshots / previews | Current build, synthetic accounts only: host sign-in/settings, neutral card, friend pick, locked subject, reveal/result, board/controls; supported iPhone/iPad sizes per ASC requirements. Existing demo screenshots are not current release proof. No upload/proof automation enabled by this track. |
| External groups | Invite-only named friend groups after approval, no public link. Internal group prerequisite observed/created only at authorized setup gate; automatic notify testers remains disabled until invitation gate. |

## Conditional beta description

> Called It is a points-only game for invited iMessage friend groups. Create a two-choice prediction about a consenting friend and send its card yourself. Friends choose a side and confidence; the person it's about sees a locked view until reveal. Settle together, challenge an answer and follow your group's leaderboard and shared goal. There is no cash wagering or individual cash prize. Suggestions use templates and, when you give permission, a hosted AI service with the context you choose to provide. Called It does not read your Messages history or send messages for you.

This describes the approved target, **not the baseline implementation**. Remove no required V0 behavior to make the description true; complete the feature and proof. Do not call hosted inference on-device. Do not imply push edits/sends Messages automatically or that points fund dinner/gift cards.

## Reviewer procedure draft

1. Install the exact external-beta host+extension. Use the supplied dedicated reviewer auth/invitation procedure (pending verified provider and usable access); no personal chat access is requested. Open the host, sign in once and observe that the extension shares the session.
2. Use the dedicated synthetic iMessage group with creator/friend/subject accounts and supplied synthetic content. Explain any three-device requirement and provide accessible supporting proof; a video is not a replacement for an operable reviewer account.
3. Open Called It from the Messages drawer, create a safe two-choice prediction, insert the card and manually tap Send. Verify membership is explicitly accepted, never granted by forwarding the card.
4. Open as subject before reveal: locked view and one-tap quiet veto. As an eligible friend, place/edit confidence until cutoff. All static captions, URLs, fallback and notifications remain neutral.
5. Use normal release-supported schedule/settings to demonstrate reveal, subject answer, optional proof, challenge/timeout and final score. **No reviewer time override, fixture API, admin passcode or secret test endpoint may ship in the release app.** Review walkthrough duration depends on approved product windows; supply that information accurately.
6. Show group-separated history/goal, all two-tap privacy controls, UGC report/block/support, leave and in-app account/data deletion on sacrificial synthetic accounts. Describe what deletion cannot retract from previously delivered iMessage snapshots.
7. Verify notification permission denial still permits manual use; show neutral production-APNs delivery and authorized bet routing. Reviewer instructions must distinguish host navigation from manually returning to Messages.

Owner must fill precise taps, account roles, invitation steps, expected timings, endpoints and reviewer service availability from actual final evidence. No guaranteed install-return claim until tested on actual TestFlight distribution. Apple's first external Beta App Review and processing are outside the team's control.

References: [Test information](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information/), [App privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/), [Age rating](https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/), [Export compliance](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/).
