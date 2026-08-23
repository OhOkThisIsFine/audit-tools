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
signal (Linux CI is). CI runs the full suite **sharded across parallel jobs** (~2× faster) as the real
gate, so the local preflight is a quick fast-fail, not the full run.

- Fresh worktree → `npm install` first (otherwise tsc resolves `audit-tools/shared` against a stale `dist/` → fake "missing export" errors).
- `npm run build && npm run check` from repo root — zero errors.
- Fast local checks, Bash tool:
  `npx vitest run --changed` (only tests touching your uncommitted edits) +
  `npm run smoke:packaged-audit-code && npm run smoke:packaged-remediate-code` +
  `npm run check:doc-manifest` (0.1s — ANY new/renamed tracked `*.md` anywhere in the repo, not just
  `docs/**`, unregistered in `scripts/doc-manifest-data.mjs`; the pre-commit gate already runs this
  whenever the staged set touches markdown, so running it here is fast feedback, not the only gate;
  burned v0.34.17) +
  `npm run check:lint` (14s — `tsc` does NOT flag an unused DESTRUCTURED binding or a
  newly-dead import, so `build && check` goes green while eslint fails; burned v0.39.7).
  These are for FAST FEEDBACK only — nothing here is load-bearing, because the release script's
  pre-tag gate now runs the whole `verify:checks` and refuses to tag if any of it is red.
- Want the belt-and-suspenders full local run anyway? `npm run verify:release`
  (= `verify:checks` + full vitest + both linked-install smokes) — but the sharded CI gate re-runs it
  authoritatively either way.
- Failing test → rerun alone before calling it a regression; EBUSY/EPERM = flake suspect first (the smokes
  pack a tarball and are Windows-flaky on temp-dir EPERM/EBUSY).

## 2. Commit + push

- Review `git status`. Exclude stray run artifacts (`tmp*.json`, `*result.json`, worker payloads). Unexplained foreign working-tree edits → partial-stage around them and ask — may be a concurrent session in this checkout.
- Conventional commit message. Push `main` to the `audit-tools` remote.
- **Lap-worktree ship (one command, no primary-worktree dance).** Laps run on a `claude/<lap>` linked
  worktree, not the primary `main` checkout. You do NOT need to FF the primary worktree or rebuild its stale
  `dist/`. Push the lap branch's landed work onto `main` (`git push audit-tools HEAD:main`, a fast-forward),
  then run the release **from the lap worktree itself** — `scripts/release-and-publish.mjs` admits any
  branch whose HEAD already equals `origin/main` (`evaluateReleaseBranch()`), pushes the bump commit onto
  the remote `main` via `HEAD:refs/heads/main`, and never touches the primary worktree. The `ensureCleanWorktree()`
  CRLF/clean-tree guard and the `verify:checks` pre-tag gate still run. No `--root`/branch flag is needed —
  if the lap HEAD hasn't been fast-forwarded onto `origin/main` first, the guard refuses (fix the sync, don't
  add a flag).

## 3. Publish (single package)

- Repo root: `npm run release:patch:publish` (or `:minor:` / `:major:`).
  `scripts/release-and-publish.mjs` runs the full non-test gate before tagging (`npm run verify:checks` — a tag is
  the one unrecoverable-cheaply step, so it fails BEFORE `vX.Y.Z` exists rather than after), bumps, tags `vX.Y.Z`, pushes, creates
  the GitHub Release (triggers OIDC trusted-publishing `publish-package.yml`). That workflow runs the gate as
  parallel jobs — `gate`, whose steps are generated from `package.json`:

<!-- BEGIN gate-enumeration — generated from package.json by scripts/check-gate-enumeration.mjs -->

`verify:checks` = `check:control-bytes` + `check:version-gates` + `check:guard-reach` + `check:ci-trigger-paths` + `check:offload-lanes` + `check:loop-core-patterns` + `check:constitutional-doc-paths` + `check:runtime-artifact-names` + `check:executor-producers` + `check:deadcode` + `check:lint` + `check:dup` + `check:depgraph` + `check:doc-manifest` + `check:doc-links` + `check:doc-code-citations` + `check:gate-enumeration` + `check:philosophy-brief` + `check:nightly-routine-prompt` + `check:handoff-roadmap` + `check:backlog-index` + `check:memory-citations` + `check:backlog-budget` + `check:backlog-status` + `check:backlog-line-numbers` + `check:tests` + `build` + `verify:hosts` + `verify:remediate-hosts` + `pack:smoke` + `smoke:packaged-audit-code` + `smoke:packaged-remediate-code`

<!-- END gate-enumeration -->

  plus a `test` matrix (vitest sharded 4 ways) — and only the `publish` job
  (`needs: [gate, test]`)
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

## Release pipeline shape (reference)

`.github/workflows/publish-package.yml`. Triggered by publishing a GitHub Release (tagged `vX.Y.Z`) or
manual `workflow_dispatch`. Uses npm Trusted Publishing (OIDC) — no tokens. Pre-release (`-` in version)
→ `next` dist-tag, else `latest`. CI: parallel `gate` (`verify:checks`) and `test` (4-way sharded
`vitest run`) jobs → `publish` (needs both). The `publish` job requests `id-token: write` for the npm
OIDC exchange, pins the Node + npm versions declared in the workflow, rebuilds `dist/` for packing,
previews the tarball with `npm pack --dry-run`, publishes with public access + provenance, verifies the
published version resolves from the registry, and uploads `*-npm-logs` artifacts on failure.

Bump/tag scripts: `release:patch` / `:minor` / `:major` (bump + commit + tag), or the `:publish`
variants (also push + create GitHub Release + wait for CI).

The manual halves stay in `docs/audit-pkg/release.md`: per-host validation checklists, manual
`workflow_dispatch` usage, trusted-publisher configuration, troubleshooting (incl. the
`AUDIT_CODE_VERBOSE=1` smoke-debug tip and the smokes' `npm_config_*`/token isolation note).

## Pipeline profiling (always-on)

Profiling is a **standing feature** of every test + release run, single-sourced in
`scripts/shared/profile.mjs` (never a manual flag). Ledgers land in `.audit-tools-profile/` (gitignored);
under GitHub Actions each profile also appends a markdown table to the job summary.

- **Gate:** `verify:checks` runs its sub-steps through `scripts/shared/profile-run.mjs` (profiled npm-script runner, fail-fast preserved) → `.audit-tools-profile/verify-checks-latest.json` + `-history.ndjson` per step (the `check`/`build` double-`tsc`, host verifies, packaged smokes are each timed).
- **Suite:** `scripts/shared/vitest-timing-reporter.mjs` is wired into `vitest.config.ts` `reporters` → per-area (audit/shared/remediate) subtotals + 10 slowest files, `.audit-tools-profile/vitest-latest.json` (shard runs write `vitest-shard<X>of<Y>-latest.json` — the suffix goes on the
  profile name, not the file suffix).
- **Release:** `release-and-publish.mjs` writes a `release` phase profile (pre-tag gate / bump+tag / push+release / await-run / await-npm) and, from the completed publish run's job/step API, a `publish-ci` profile (per-job wall + critical-path vs. summed). So the CI half self-profiles on every release.

`*-history.ndjson` is the trend line — diff the latest record against prior runs to catch a time regression.

## 6. Close out

- Update the project memory state file (version, release commit/run); refresh `docs/HANDOFF.md` if mid-stream work remains.
- Report: published version, CI run link, suite counts.
