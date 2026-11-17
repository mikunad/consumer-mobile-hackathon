# V0 schema transition

This source change is additive. It does not deploy, migrate, seed, reset or delete an existing deployment. The V0 tables use the `v0` prefix, and the old tables retain their existing validators. Existing data is retained but the old public APIs fail closed. The prior server-clock protections remain in source history and are not replaced by caller-controlled clocks.

Legacy usernames, tokens, membership records and global points are not proof of verified phone identity or explicit invitation consent. Do not copy them into V0 accounts or group ledgers. A member must verify their phone and accept a phone-targeted invitation. Rejoining creates a new history interval. Economic policy is pending; no automatic balance conversion, score, settlement or goal activation occurs.

Before any authorized rollout, rehearse against an isolated backend containing synthetic legacy and V0 data. Verify old validators still accept the retained snapshot, all old public routes are retired, new account/session/invitation guards reject forged identity, and the candidate's contract/schema/config/source/deployment pins match the observation. The in-memory test suite does not establish deployment transaction, HTTP or migration behavior.

Use a separately recorded source revision and deployment receipt for the backend; a native artifact revision is not the backend revision. `v0Runtime:attestation` reports explicitly provisioned nonsecret metadata, not cryptographic evidence. Provider activation is separate and defaults off. No test seed, time override or mocked identity endpoint is part of this schema.

Rollback must preserve the retired legacy surface and server-clock privacy guard. Do not restore a historical main revision that re-enables unverified reads or writes. Rehearse rollback with a pinned privacy-preserving candidate and a synthetic snapshot before approval; retained old tables are not permission to reactivate old clients. No staging or production migration/rollback has been executed by this change.
