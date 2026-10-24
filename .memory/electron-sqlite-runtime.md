---
name: Match SQLite verification to the Electron ABI
description: Local database integration checks need a runtime matching the installed better-sqlite3 binary.
type: decision
---

**Why**

The installed better-sqlite3 binary can be built for Electron's Node ABI 146 while the system Node uses ABI 127. Starting Next with the system Node then causes database endpoints to return errors with ERR_DLOPEN_FAILED.

**How to apply**

Check process.versions.modules when database initialization reports an ABI mismatch. Use the installed electron.exe with ELECTRON_RUN_AS_NODE=1 when it matches the native binary. For deletion integration checks, point APP_DATA_DIR at an independent temporary directory so real projects remain untouched. Avoid rebuilding the shared native dependency solely for a test if the matching runtime is already available.

**Related**

[[project-deletion-ui]]
