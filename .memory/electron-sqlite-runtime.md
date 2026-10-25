---
name: Match SQLite verification to the Electron ABI
description: Local database integration checks need a runtime matching the installed better-sqlite3 binary.
type: decision
---

**Why**

The installed better-sqlite3 binary can be built for Electron's Node ABI 146 while the system Node uses ABI 127. Starting Next with the system Node then causes database endpoints to return errors with ERR_DLOPEN_FAILED. A separate failure mode is a healthy projects route with empty settings/presenter screens: projects use SQLite directly, while Zustand stores can still be backed by renderer localStorage unless every persisted store uses createSqliteStorage.

**How to apply**

Check process.versions.modules when database initialization reports an ABI mismatch. Use the installed electron.exe with ELECTRON_RUN_AS_NODE=1 when it matches the native binary. For standalone packaging, materialize Next-traced native packages under .next/node_modules as independent copies with the Electron ABI, then verify those exact .node files in afterPack; never write through a symlink into project node_modules. For deletion integration checks, point APP_DATA_DIR at an independent temporary directory so real projects remain untouched. Avoid rebuilding the shared native dependency solely for a test if the matching runtime is already available.

**Related**

[[project-deletion-ui]]
