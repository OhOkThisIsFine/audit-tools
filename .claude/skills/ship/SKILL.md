---
name: ship
description: Land and publish audit-tools work end-to-end — verify green, commit, push, publish the single audit-tools package, verify live on npm, reinstall + finish the global bins. Use when work is complete and should ship without handing steps back.
---

# Ship — full land-and-publish pipeline

Run the whole flow; never park at the push/publish boundary. Repo root = the audit-tools checkout.
Remote `audit-tools`, branch `main` (not origin, not master).

**ONE package** (`audit-tools`), shipping both bins `audit-code` + `remediate-code`. Imports use the
`audit-tools/shared` subpath export — never a separate `@audit-tools/shared` workspace dep.

## 1. Preflight gate (fast local fast-fail — CI is the authoritative full gate)

The full vitest suite is ~93% of the gate and takes minutes on Windows, which is *not* the authoritative
signal (Linux CI is). CI now runs the full suite **sharded across parallel jobs** (~2× faster) as the real
gate, so the local preflight is a quick fast-fail, not the full run.

- Fresh worktree → `npm install` first (otherwise tsc resolves `audit-tools/shared` against a stale `dist/` → fake "missing export" errors).
- `npm run build && npm run check` from repo root — zero errors.
- Fast local checks, Bash tool:
  `npx vitest run --changed` (only tests touching your uncommitted edits) +
  `npm run smoke:packaged-audit-code && npm run smoke:packaged-remediate-code`.
- Want the belt-and-suspenders full local run anyway? `npm run verify:release`
  (= `verify:checks` + full vitest) — but the sharded CI gate re-runs it authoritatively either way.
- Failing test → rerun alone before calling it a regression; EBUSY/EPERM = flake suspect first (the smokes
  pack a tarball and are Windows-flaky on temp-dir EPERM/EBUSY).

## 2. Commit + push

- Review `git status`. Exclude stray run artifacts (`tmp*.json`, `result.json`, `canary-results.json`, worker payloads). Unexplained foreign working-tree edits → partial-stage around them and ask — may be a concurrent session in this checkout.
- Conventional commit message. Push `main` to the `audit-tools` remote.
- **Lap-worktree ship (one command, no primary-worktree dance).** Laps run on a `claude/<lap>` linked
  worktree, not the primary `main` checkout. You do NOT need to FF the primary worktree or rebuild its stale
  `dist/`. Push the lap branch's landed work onto `main` (`git push audit-tools HEAD:main`, a fast-forward),
  then run the release **from the lap worktree itself** — `scripts/release-and-publish.mjs` now admits any
  branch whose HEAD already equals `origin/main` (`evaluateReleaseBranch()`), pushes the bump commit onto
  the remote `main` via `HEAD:refs/heads/main`, and never touches the primary worktree. The `ensureCleanWorktree()`
  CRLF/clean-tree guard and the `npm run check` pre-tag gate still run. No `--root`/branch flag is needed —
  if the lap HEAD hasn't been fast-forwarded onto `origin/main` first, the guard refuses (fix the sync, don't
  add a flag).

## 3. Publish (single package)

- Repo root: `npm run release:patch:publish` (or `:minor:` / `:major:`).
  `scripts/release-and-publish.mjs` runs a fast local pre-tag gate (`npm run check` only — the full `verify:release`
  already ran in this skill's preflight and runs again authoritatively in CI), bumps, tags `vX.Y.Z`, pushes, creates
  the GitHub Release (triggers OIDC trusted-publishing `publish-package.yml`). That workflow runs the gate as
  parallel jobs — `gate` (`verify:checks`: check + deadcode + doc-manifest + build + host verifies + both
  `smoke:*`) plus a `test` matrix (vitest sharded 4 ways) — and only the `publish` job (`needs: [gate, test]`)
  uploads. The release script then waits for the whole run + npm propagation. **Trusted publishing is
  configured + working** — no tokens, no local bootstrap.
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
