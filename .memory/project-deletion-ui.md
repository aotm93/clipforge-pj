---
name: Keep project deletion visible and compatible with Electron
description: Project cards need a persistent delete action and an application dialog for destructive confirmation.
type: decision
---

**Why**

The project list hid its trash icon behind desktop hover styles, making deletion difficult to discover. The application runs in both browsers and Electron, so confirmation and errors should use the shared application UI. The existing project DELETE endpoint already cascades related database rows and removes the project's upload and output directories.

**How to apply**

Keep a labeled delete button visible on every project card at desktop and mobile sizes. Confirm the project name and deletion scope in the shared Dialog component. Prevent duplicate submissions and dialog dismissal while deletion is pending. Remove project and work entries only after a successful response; retain the dialog with a retryable error after failure. Reuse the existing DELETE endpoint.

**Related**

[[electron-sqlite-runtime]]
