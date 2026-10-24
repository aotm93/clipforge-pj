# No hardcoded secrets
Source code must not contain passwords, API keys, tokens, or connection URLs with credentials. Read them from the environment, a function parameter, or the config module.

# Comments explain why, not what
A comment states a reason, a constraint, a workaround, or a non-obvious invariant. A comment that restates what the next line plainly does is a violation.

# Errors are not swallowed
A `catch` block must handle the error, report it, or re-raise it. An empty catch block, or one whose body is only a comment, is a violation.

# No partial implementations
Implement features fully. A comment that says "for now", "simplified", or "later", or a stub body, is a violation. If a part genuinely cannot be done, say so in your reply instead of stubbing it.

# Do not run destructive commands that erase uncommitted work
Do not use `git reset --hard`, `git checkout -- .`, `git clean -fd`, or similar commands that discard untracked or uncommitted changes.

# No explicit any types
paths: **/*.ts, **/*.tsx
Do not use the explicit TypeScript `any` type. Use a specific type, a generic, `unknown` with narrowing, or another type-safe alternative.

# Exported functions declare return types
paths: src/**/*.ts
Every exported function must declare its return type explicitly. Do not rely on inferred return types for exported functions.

# No TODOs or placeholders
Do not leave `TODO`, `FIXME`, placeholder text, placeholder values, or visibly unfinished implementation markers in changed files.

# Use the version-specific Next.js APIs
source: AGENTS.md:2
paths: files that use Next.js APIs
This is NOT the Next.js you know. Use the APIs, conventions, and file structure of the version installed in this project; do not apply assumptions from other Next.js versions.
