# Privacy, safety and support: owner review draft

**Not a published privacy policy or a legal assurance.** The baseline has hosted AI and server-stored game data; it is not a “no data collected” app. Final V0 adds phone identity, push and optional proof media. The operator, contact details, providers, purposes/retention/consent and deletion implementation require verification and owner approval before publication.

## Data and label inventory to reconcile against the final candidate

| Data / flow | Evidence or intended V0 behavior | Proposed ASC review, not a final declaration |
|---|---|---|
| Phone number, verified auth subject, display name | V0 requires provider-verified identity; selected provider is not established here | Contact info (phone/name as collected), identifiers (user ID), linked to user, app functionality; confirm provider sharing and logs |
| Session and group/conversation links | Backend session plus shared host/extension Keychain and device-local/account-scoped mappings | User/device identifiers as actually collected; session secrets never in analytics, locators or notifications |
| Questions/options, typed context, suggestions and past bets | User-generated game content in Convex; baseline `convex/ai.ts` calls hosted Anthropic and has an OpenAI branch, not on-device inference | Other user content, gameplay content, usage/product interaction as applicable; linked to user; evaluate app functionality and any secondary AI training purpose separately |
| Confidence/picks, outcomes/challenges, points/streak/history/goal | Server-maintained per-group gameplay | Gameplay content / product interaction as applicable; linked to account; no financial info just because points exist |
| Optional proof photos/audio | V0 optional proof must have storage authorization, deletion and purpose strings appropriate to actual capture/picker APIs | Photos/videos and audio data if uploaded; linked to user; don't claim all photos/library or chat are read |
| Push token, schedule/timezone, notification preferences | Host registers for APNs; backend routes reminders/recaps | Device identifiers and other relevant data based on actual collection; neutral notification payloads; provider/environment separation |
| Safety reports, blocked users/topics, no-bets, deletion and security events | Required safety/control features; exact service/log retention pending | User content, user IDs, diagnostics if collected; access-limited support/security purpose; no blanket retention promise |
| Diagnostics, crash reports, analytics, SDK data | Native release inventory and ASC/Xcode privacy report not yet inspected | Declare actual collection including third parties; do not assume “none”, “not linked” or “no tracking” from absence of one SDK |

Inventory includes server/provider logs, storage backups and AI inputs/outputs, not only client SDKs. Confirm all sharing, geography, retention, access and training terms with actual provider configuration/contracts; do not infer from a configured environment-variable name. Do not copy production records to inspect this. The legacy staged chat/export narrative must not survive as a false provenance or consent claim in V0.

## Publication draft structure

Owner must supply bracketed facts and reconcile every sentence with tested behavior before publishing at the approved policy URL:

> **Who operates Called It.** [Legal/operator name] operates this invited-group game. Contact [monitored privacy/support address]. Effective date: [approved date].
>
> **What you choose to share.** We process [verified phone identity and account fields], group membership, predictions, picks/confidence, results and [actual optional proof/context]. Called It does not read your Messages history. You choose when to send a card through Messages; the app does not send messages automatically.
>
> **Where data goes.** Game data is processed by [actual backend/storage providers and purposes]. If you choose hosted suggestions, [actual AI provider] receives [exact fields] for [approved purpose and retention]. This is a hosted service, not on-device inference. [Actual prior permission mechanism and withdrawal controls].
>
> **Visibility.** Eligible invited group members can see the game content that server permissions allow. Before reveal, the subject's view is locked. Cards contain neutral shared information, but recipients may forward or capture what they receive. Do not put sensitive personal information into game text or proof. [Explain exact static/result-card exposure and approved consent].
>
> **Choices and deletion.** [Exact tested path] offers no-bets-about-me, blocked topics, quiet veto, report/block, leave and account/data deletion. [Actual deletion scope, completion time, backup/log retention and legally required exceptions]. Deleting app data does not remove Messages already delivered to other people's devices or their screenshots.
>
> **Retention and uses.** [Actual per-category retention, scheduled erasure, backups, logs, provider policies]. [Explicit separately approved optional secondary model-tuning use, or state it is not performed only after verified].

No blanket “encrypted end-to-end”, “never stored”, “never shared”, “immediately erased everywhere”, “anonymous” or regulatory compliance claim is established. HTTPS and Keychain do not make Convex/hosted AI processing end-to-end encrypted. An iMessage transport property is not a guarantee about backend data.

## Required behavior before external beta

- **Hosted AI permission:** Apple 5.1.2(i) requires clear disclosure of third-party sharing and explicit permission before personal data goes to AI. Confirm consent for the subject/member data, not only the creator's button tap. Server must honor decline/withdrawal and blocked topics. Templates and manual creation must remain usable without undisclosed sharing. No silent training reuse: storing content to tune V1 is a distinct purpose requiring owner/legal decision and appropriate consent, not a hidden default.
- **UGC safety:** Apple 1.2 requires filtering objectionable content, a report mechanism with timely response, blocking abusive users and published contact details. A prompt saying “be nice,” subject veto or leaving the group alone does not establish those safeguards. Confirm enforcement for manual text, AI output and optional media; test blocked-user effects and report receipt. Owner names the real moderation operator/escalation route and response policy; do not invent a turnaround commitment.
- **Account deletion:** User can initiate full account deletion in app, not only logout/deactivation or an email request. Test revocation on every device, removal of phone/auth linkage and provider accounts as applicable, context/picks/proof/suggestions, memberships and push tokens, plus stated history/ledger anonymization policy. Delete storage objects and derivatives, stop future reminders, enforce old-card access denial and document backup/log expiry honestly. Preserve only approved legally required records and explain them. No production deletion is authorized in this track.
- **No-bets/topics/leave/veto:** All V0 controls are within the specified two taps from the extension; veto is quiet. Membership exit cancels/voids affected open state and suppresses pushes. Test aliases, rejoin intervals, stale devices and revoked tokens. These are release gates, not optional metadata copy.
- **Money:** Points have no purchase, redemption, cash wagering or individual prize payout. Shared goals are points-only until separately approved funding/legal/distribution work exists. Do not put gift-card/Whop/dinner entitlement claims in invitations, screenshots or reviewer notes.

## Support page draft

Owner-approved public URL must work without login and include the real operator/contact, supported iOS/iMessage requirements, extension enablement steps verified on the candidate, account access help, abuse/privacy/deletion routes and incident guidance. Do not request OTPs, session tokens, phone-number lists or private chat exports in reports. Ask for app build, synthetic repro and redacted screenshot only. Explain that notification permission is optional, cards are manually sent, Android/SMS only receive neutral fallback and App Store/TestFlight install paths can differ. Do not promise automatic restoration of a tapped bet after install until proved.

References: [Review guidelines 1.2 and 5.1.2](https://developer.apple.com/app-store/review/guidelines/), [Apple account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/), [App privacy details](https://developer.apple.com/app-store/app-privacy-details/). Reviewed November 16, 2026; final owner/legal approval is still required.
