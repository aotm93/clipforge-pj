---
name: Hydrate settings before startup writes
description: Asynchronous SQLite hydration must finish before mount-time defaults can persist.
type: bugfix
---

**Why**

The locale initializer used to persist a default settings snapshot while the initial SQLite GET was still running. That PUT contained empty provider keys and could replace the saved configuration. Overlapping PUTs could also finish out of order.

**How to apply**

Wait for Zustand persist hydration before applying automatic locale. Reject pre-read writes in createSqliteStorage, serialize subsequent writes, and maintain a browser fallback after successful reads and edits. Keep Electron userData and appId stable across releases. Report storage failures without printing keys or settings values. Verify delayed hydration and a new renderer origin against the same database.

**Related**

[[electron-sqlite-runtime]]
