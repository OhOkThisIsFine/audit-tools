---
name: ship
description: Land and publish audit-tools work end-to-end — verify green, commit, push, publish the single audit-tools package, verify live on npm, reinstall + finish the global bins. Use when work is complete and should ship without handing steps back.
---

# Ship — full land-and-publish pipeline

Run the whole flow; never park at the push/publish boundary. Repo root = the audit-tools checkout.
Remote `audit-tools`, branch `main` (not origin, not master).

**ONE package** (`audit-tools`), shipping both bins `audit-code` + `remediate-code`. Imports use the
`audit-tools/shared` subpath export — never a separate `@audit-tools/shared` workspace dep.

## 1. Preflight gate

- Fresh worktree → `npm install` first (otherwise tsc resolves `audit-tools/shared` against a stale `dist/` → fake "missing export" errors).
- `npm run build && npm run check` from repo root — zero errors.
- Tests with CLAUDECODE unset (set = one audit-code provider test fails): Bash tool, `env -u CLAUDECODE npm test`.
  (`npm test` = build + node:test shared+audit + vitest remediate.)
- Failing test → rerun alone before calling it a regression; EBUSY/EPERM = flake suspect first.

## 2. Commit + push

- Review `git status`. Exclude stray run artifacts (`tmp*.json`, `result.json`, `canary-results.json`, worker payloads). Unexplained foreign working-tree edits → partial-stage around them and ask — may be a concurrent session in this checkout.
- Conventional commit message. Push `main` to the `audit-tools` remote.

## 3. Publish (single package)

- Repo root, CLAUDECODE unset: `env -u CLAUDECODE npm run release:patch:publish` (or `:minor:` / `:major:`).
  `scripts/release-and-publish.mjs` front-loads `verify:release` (check + test + 4 smokes), bumps, tags `vX.Y.Z`,
  pushes, creates the GitHub Release (triggers OIDC trusted-publishing `publish-package.yml`), then waits for the
  CI run + npm propagation. **Trusted publishing is configured + working** — no tokens, no local bootstrap.
- CRLF trap: the clean-tree guard fails from a CRLF worktree → renormalize to LF first.
- The smokes pack ONE tarball; Windows-flaky on temp-dir EPERM/EBUSY — re-run a smoke before calling it a regression.
- Local Windows-green ≠ Linux-CI-green — the release CI run is the real signal.
- Failed publish → recoverable: `gh release delete vX.Y.Z --cleanup-tag`, forward-bump, retry.

## 4. Verify live

- `npm view audit-tools version` — must match the bump (the release script already waits on registry propagation;
  pre-release `-` versions land on the `next` dist-tag).

## 5. Reinstall global bin

- `npm i -g audit-tools`.
- allow-scripts trap: npm defers postinstall on `-g` install (host-integration deploy to ~/.claude, ~/.codex,
  ~/.config/opencode, ~/.gemini silently skipped) → finish by running the global package's `scripts/postinstall.mjs`
  manually (`node "$(npm root -g)/audit-tools/scripts/postinstall.mjs"`) or `npm i -g --allow-scripts=audit-tools`.
- Smoke: `audit-code --version` + `remediate-code --version`. MODULE_NOT_FOUND = dangling npm-link junction to a deleted worktree.

## 6. Close out

- Update the project memory state file (version, release commit/run); refresh `docs/HANDOFF.md` if mid-stream work remains.
- Report: published version, CI run link, suite counts.
