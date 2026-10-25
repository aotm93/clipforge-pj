---
name: Hydrate settings before startup writes
description: Asynchronous SQLite hydration must finish before mount-time defaults can persist.
type: bugfix
---

**Why**

The locale initializer used to persist a default settings snapshot while the initial SQLite GET was still running. That PUT contained empty provider keys and could replace the saved configuration. Overlapping PUTs could also finish out of order.

**How to apply**

Use createSqliteStorage for every persisted user store (settings, brand, characters, products, and templates), not only the settings store. Wait for Zustand persist hydration before applying automatic locale. Reject pre-read writes in createSqliteStorage, serialize subsequent writes, and maintain a browser fallback after successful reads and edits. Keep Electron userData and appId stable across releases. Report storage failures without printing keys or settings values. Verify delayed hydration and a new renderer origin against the same database.



**Provider and custom-model migrations**

When adding or changing AI platform keys, endpoints, or custom models, update Settings migrations additively. Introduce the new provider/default fields without replacing the existing settings object; preserve saved API keys, base URLs, custom model IDs, provider associations, and model capability values. Make migration idempotent so repeated hydration or app upgrades cannot clear or duplicate user configuration. Add regression tests that start with populated legacy settings, migrate across the version boundary, and verify all existing credentials and custom endpoints remain unchanged while new defaults are added.
**Related**

[[electron-sqlite-runtime]]
