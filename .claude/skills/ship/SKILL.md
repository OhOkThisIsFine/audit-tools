---
name: ship
description: Land and publish audit-tools work end-to-end — verify green, commit, push, publish changed packages, verify live on npm, reinstall + finish global bins. Use when work is complete and should ship without handing steps back.
---

# Ship — full land-and-publish pipeline

Run the whole flow; never park at the push/publish boundary. Repo root = the audit-tools checkout. Remote `audit-tools`, branch `main` (not origin, not master).

## 1. Preflight gate

- Fresh worktree → `npm install` first (otherwise tsc resolves `@audit-tools/shared` against a stale `dist/` → fake "missing export" errors).
- `npm run build -w @audit-tools/shared && npm run build && npm run check` from repo root — zero errors.
- Tests with CLAUDECODE unset (set = one audit-code provider test fails): Bash tool, `env -u CLAUDECODE npm test`.
- Failing test → rerun alone before calling it a regression; EBUSY/EPERM = flake suspect first.

## 2. Commit + push

- Review `git status`. Exclude stray run artifacts (`tmp*.json`, `result.json`, `canary-results.json`, worker payloads). Unexplained foreign working-tree edits → partial-stage around them and ask — may be a concurrent session in this checkout.
- Conventional commit message. Push `main` to the `audit-tools` remote.

## 3. Publish changed packages

- Repo root: `npm run release:changed:patch:publish` (or `:minor:` / `:major:` variant). Front-loads `verify:release` for every changed package, then publishes shared-first. CLAUDECODE unset here too.
- CRLF trap: the clean-tree guard fails from a CRLF worktree → renormalize to LF first.
- Watch CI: `gh run list --limit 5`, then `gh run watch <id>`. Local Windows-green ≠ Linux-CI-green (Win skips, host-local gitignored files, Node TS-stripping) — release CI is the real signal.
- Failed publish → recoverable: `gh release delete <tag> --cleanup-tag`, forward-bump, retry.

## 4. Verify live

- `npm view @audit-tools/shared version`, `npm view auditor-lambda version`, `npm view remediator-lambda version` — must match the bumps (pre-release `-` versions land on the `next` dist-tag).

## 5. Reinstall global bins

- `npm i -g auditor-lambda remediator-lambda`.
- allow-scripts trap: npm defers postinstall on `-g` install (bin updates, host-integration deploy silently skipped) → finish with `npm approve-scripts <pkg>` or run the package's `scripts/postinstall.mjs` manually.
- Smoke: `audit-code --version` + `remediate-code --version`. MODULE_NOT_FOUND = dangling npm-link junction to a deleted worktree.

## 6. Close out

- Update the project memory state file (versions, release commits); refresh the handoff note if mid-stream work remains.
- Report: published versions, CI run links, suite counts.
