# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **A12 — single-package collapse: ✓ DONE + MERGED (2026-06-18, `main` `27c7a24e`).** The repo is now
  **ONE package `audit-tools`** (not a monorepo). `@audit-tools/shared` + `auditor-lambda` +
  `remediator-lambda` collapsed into one root package exposing both bins (`audit-code`, `remediate-code`),
  shared inlined. Green end-to-end: build + check clean; shared **724** / audit **2129** / remediate **1607**;
  all 4 smokes; `verify:release` exits 0 locally **and on Linux CI (dry-run green)**. Layout + import +
  publish facts: memory `a12-single-package-collapse-done`; plan/history `docs/a12-single-package-collapse-plan.md`.
  - **New reality (internalize before touching anything):** `src/{shared,audit,remediate}` →
    `dist/{shared,audit,remediate}`; imports use `audit-tools/shared` (exports self-reference + tsconfig
    `paths`), NEVER `@audit-tools/shared`. One `tsconfig.json`, one `npm run build`. Asset dirs at repo root.
    Tests: node:test `.mjs` (tests/shared, tests/audit) + vitest (tests/remediate). Plain `vX.Y.Z` release tags.
    One `ci.yml`/`publish-package.yml` job. `opencode.json` at root has both agent scopes.

- **PUBLISH TAIL (immediate next — finish the pipeline):**
  1. **First publish attempted + failed at the OIDC publish step ONLY** (run `27796284511`): Linux
     `verify:release` + `npm pack` all passed; `npm publish` got `404 PUT .../audit-tools — you do not have
     permission` = the new name has **no npm trusted publisher configured yet**. Ethan is enabling it on
     npmjs.com (owner `OhOkThisIsFine`, repo `audit-tools`, workflow `publish-package.yml`, no environment).
     The `v0.28.0` tag + GitHub Release exist; nothing published (npm still 404). **After Ethan enables trusted
     publishing, re-trigger with a fresh dispatch** (picks up the post-failure workflow fix; do NOT `gh run
     rerun` the old run — it predates the `--ignore-scripts` fix):
     `gh workflow run publish-package.yml -f dry_run=false --ref main` → publishes `audit-tools@0.28.0`.
     (Fixed `256c4905`: `npm publish --ignore-scripts` so retries don't re-run verify:release into the 10-min
     step timeout.)
  2. **After it's live on npm:** `npm deprecate auditor-lambda "moved to audit-tools"` (same for
     `remediator-lambda` and `@audit-tools/shared`) — redirect the old names.
  3. **Reinstall global bins** from the published package: `npm i -g audit-tools` (or `npm i -g .` from the
     repo), then run the postinstall / approve-scripts so host assets deploy. Verify `audit-code --version` /
     `remediate-code --version` → `0.28.0`.

## Immediate next: the go-forward program

**After publish lands, dogfood `remediate-code` on the rest of the backlog** (Ethan's stated plan: reach a
publishable single-package milestone → publish → use the tool on itself). Remaining program items
(`docs/backlog.md` → "Accepted go-forward program"):
- **A7 (REFRAMED)** — validate the host install/integration machinery across all hosts (Codex, OpenCode,
  Antigravity), not just Claude Code.
- Deferred: **A2** (falsifiable finding-quality oracle), **A9/A10** (autonomy acceptance + multi-process
  coordination — revisit when A8 multi-process gets concrete).
- **A8 loose ends:** audit-code NIM e2e (mirror of remediate's `nim-rolling-e2e`); the {host-subagent + NIM}
  HYBRID spill topology (FINDING-020 capstone). See `docs/a8-rolling-cutover-plan.md`.

## Working constraints (single-package)
- **Green at every commit:** `npm run build && npm run check` → zero errors. Commit hook enforces it.
- **CLAUDECODE** is set in-session; UNSET it for true-green test/gate runs (`env -u CLAUDECODE …`).
- **Tests:** `npm test` (build + node:test shared+audit + vitest remediate). vitest runs source-mode (no
  build) — `npx vitest run` from repo root (config restricts to `tests/remediate`).
- **verify:release** = check + test + 4 smokes (`scripts/{audit,remediate}/smoke-*`). The smokes pack ONE
  `audit-tools` tarball; Windows-flaky on temp-dir EPERM/EBUSY — re-run a smoke before calling it a regression.
- **Release/publish:** `scripts/release-and-publish.mjs <bump>` bumps + tags `vX.Y.Z` + GitHub Release →
  OIDC CI publishes. For a first/manual publish, `gh release create vX.Y.Z --target main`. Recover a bad
  attempt with `gh release delete vX.Y.Z --cleanup-tag` (or re-run the run after fixing the prereq).
- **Ship** via the `/ship` skill once the trusted-publisher prereq is in place and a milestone lands.
