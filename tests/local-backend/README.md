# Isolated real Convex HTTP contract lane

This is a limited real-backend lane, not native E2E or production proof. It uses
the installed official Convex client and a hash-pinned official OSS backend.
No provider credentials, deployment keys, production URLs or external routes
enter the worker. It requires Linux user/network namespaces and `ip`.

## Binary and invocation

Official release: `precompiled-2026-10-22-1447815`, asset
`convex-local-backend-x86_64-unknown-linux-gnu.zip`, from the matching release at
`https://github.com/convex/convex-backend/releases`. Verified archive SHA256:
`7be627d8a8c9175b66a55cf6c4ab63c5f6bde1c412f59fbbe93f64a24a11bd13`.
The extracted `convex-local-backend` SHA256 is
`044eedfe569b1550d5003683aec7fceb4dcee3f82abf00ab9baf1c10d3ca0b4c`.
The runner refuses any other binary; obtain it before entering the denied-network
worker. Never substitute an unverified executable or fall back to a remote URL.

```sh
env -i PATH="$PATH" HOME="$HOME" node tests/local-backend/run.mjs \
  --binary "$HOME/.capy/work/toolchain/convex-local-backend" \
  --output "$HOME/.capy/work/real-rpc-new-run"
```

Output must be a new directory outside the repository. It records backend,
binary, fixture and harness hashes, SDK/Node/OS, assertion IDs and actual HTTP
envelopes. Random local-only admin credentials stay in memory and are redacted
from retained logs. Fixture actors and proof bytes are entirely synthetic.

## Actual execution and boundaries

The runner starts an unshared user/network namespace, enables only loopback,
checks IPv4/IPv6 have no default route, and binds `127.0.0.1:3210/3211`. It copies
only source into private scratch, adds `qaRpc.ts` there, and replaces copied crons
with an empty scheduler. No root source, env file or live credential is copied.
Only that local scratch deployment is pushed. Teardown kills the process,
verifies repository product-source hashes, rejects a root fixture endpoint and
removes its scratch database/storage/home.

The 18 checks cover real attestation, exact bytes at 0/1/257/512 KiB, structured/
JSON-string/null Convex UDF error data, a retired handler, SDK/HTTP typed value
serialization, and a concurrent mutation race using the production `once`
helper. Actual `v0Proof:upload/list/read`, `v0Controls:leave` and `v0Auth:revoke`
prove private PNG round trips/idempotence/bounds and outsider/leave/revocation
denial. Valid PNGs include CRCs, compressed pixel data and optional padding.

The pinned backend actually returned HTTP200 UDF-error envelopes; the installed
SDK also recognizes HTTP560. Native scripted560 unit replies are compatibility
inputs, not observations of this backend. Fixture routes exercise protocol and
the actual transaction helper, not invented business success. Canonical proof
checks are real product handlers, but most V0 journeys are not exercised here.
No Swift request, UI, SMS/APNs delivery, Messages card/forwarding, signed storage,
distributed install or production backend has run in this lane. `fullV0Ready`
is always false.
