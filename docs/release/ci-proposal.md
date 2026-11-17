# CI proposal for the integration owner

Proposal only; this track does not edit root workflows, packages or native project wiring. Do not turn this into automatic proof upload, signing, production deploy or Apple submission. Candidate and physical gates are conjunctive: a green Linux unit lane is not release readiness.

## Unprivileged pull-request lane

Run with no deployment/provider/signing credentials, outbound provider network denied and isolated synthetic fixtures. Install from the integrator-owned lockfile using the repository's chosen package manager; current baseline has package-lock, not bun.lock. Run configured lint, typecheck, all backend security/journey/state/scheduler assertions and release tool tests:

```sh
python3 -m unittest discover -s release -p 'test_*.py' -v
python3 -m py_compile release/candidate.py release/test_candidate.py
uvx ruff check --target-version py310 release/
```

The explicit Ruff target preserves the documented Python 3.10 minimum; `datetime.UTC` is Python 3.11+, so automatic modernization to that alias is inappropriate here. No lint rules are disabled by the target flag. The example config must fail validation; do not turn missing values into permissive defaults. Integrator supplies the actual root lint/backend test script names. Baseline lacks lint configuration; `expo lint` may install/generate it, so do not run that auto-setup as an unattended read-only check. Root owner must configure it deliberately. No test command may call `deploy:convex` or inherit the production key. Pin release tests to the candidate revision and include negative tests for profile mismatch, sandbox APNs, fixture flag, endpoint mismatch, missing shared groups and credential stripping.

## Controlled Mac test lane

After reconnect/access approval, run only on a dedicated clean QA simulator/worktree, pinned Xcode/XcodeGen and test environment. Native/E2E owners provide real assertive XCTest/XCUITest targets, fixture transport and safe target guard. Test host auth/settings and actual Messages extension (not merely the Expo host). Fail on skipped/unavailable acceptance infrastructure; preserve sanitized xcresult/case IDs privately. Do not automate personal Messages or install/reinstall physical phones from CI.

## Manual signed-candidate lane

Protected manual dispatch only after Captain gate, from the exact clean coordinated SHA, using existing installed profiles/identity on the approved Mac. No `-allowProvisioningUpdates`, auto-signing fallback, API key injection, upload, build-number rewrite or test hooks. Run `candidate.py archive`, `export` and `inspect`; retain private binary/manifest hashes. Keep raw signing/export artifacts private (IPAs embed profiles); publish only sanitized metadata on explicit approval. Pin XcodeGen too: generated project output must come from the same reviewed spec/toolchain.

The gate record must require the full V0 E2E manifest, physical QA and Apple/privacy metadata evidence as separate inputs. It must not accept a missing file, empty suite, skipped assertion, old build or manual screenshot driver as success. No event-triggered production deployment, external invitation or Apple submission belongs in this proposal.
