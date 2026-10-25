---
name: Windows build fails on TLS interception and icon heap limits
description: Local machine TLS interception breaks electron-builder downloads; icon-tool needs a larger Node heap.
type: decision
---

**Why**

The machine sits behind TLS interception: Node fetch to GitHub releases fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` and curl fails revocation checks, so `pnpm dist` aborts during better-sqlite3 prebuilt download. Separately, electron-builder's bundled icon-tool.js crashes with `JavaScript heap out of memory` at default heap.

**How to apply**

Preferred: export the local proxy/enterprise root certificate (e.g. from the Windows cert store, "受信任的根证书颁发机构") and point Node at it with `NODE_EXTRA_CA_CERTS=<path-to-pem>` — this keeps certificate verification enabled. Only if that is unavailable, a temporary `NODE_TLS_REJECT_UNAUTHORIZED=0` scoped to that single build command can be used, never persisted to scripts or CI. For the icon OOM, run electron-builder with `NODE_OPTIONS=--max-old-space-size=8192`. `pnpm dist` alone will abort mid-pipeline on this machine; run `next build` / `bundle:standalone` / `electron-builder` as separate steps with the env vars applied.

**Related**

[[electron-sqlite-runtime]]
