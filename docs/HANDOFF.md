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

- **PUBLISH: ✓ DONE.** `audit-tools@0.28.0` is **live on npm** (`latest` tag, both bins). Bootstrapped via a
  one-time authenticated **local** `npm publish --ignore-scripts` (Ethan's 2FA) because the OIDC CI publish
  cannot create a brand-new package name — npm requires a trusted publisher configured on an EXISTING package,
  so the first publish needs real auth. Global bins swapped: old `auditor-lambda`/`remediator-lambda` removed
  `-g`, `audit-tools` installed `-g`, postinstall run (host assets deployed to ~/.claude, ~/.codex, …);
  `audit-code`/`remediate-code --version` → `0.28.0`. CI publish fix landed `256c4905`
  (`npm publish --ignore-scripts`).
- **TWO remaining Ethan-only npm actions (both need his 2FA / browser auth — I can't):**
  1. **Deprecate the old names** (redirect): `npm deprecate auditor-lambda "Merged into 'audit-tools' (v0.28.0+).
     Install: npm i -g audit-tools"` — same for `remediator-lambda` and `@audit-tools/shared`.
  2. **Configure npm trusted publishing on the now-existing `audit-tools` package** (owner `OhOkThisIsFine`,
     repo `audit-tools`, workflow `publish-package.yml`) so FUTURE releases publish tokenlessly via CI/`/ship`
     with provenance. Until then, a CI publish of a new version will 404 again — bootstrap is local-only.

## Immediate next: the go-forward program

**After publish lands, dogfood `remediate-code` on the rest of the backlog** (Ethan's stated plan: reach a
publishable single-package milestone → publish → use the tool on itself). Remaining program items
(`docs/backlog.md` → "Accepted go-forward program"):
- **A7 (REFRAMED)** — validate the host install/integration machinery across all hosts (Codex, OpenCode,
  Antigravity), not just Claude Code.
- Deferred: **A2** (falsifiable finding-quality oracle), **A9/A10** (autonomy acceptance + multi-process
  coordination — revisit when A8 multi-process gets concrete).
- **A8 loose ends:** audit-code NIM e2e ✓ **DONE (2026-06-18)** — `tests/audit/nim-rolling-audit-e2e.test.mjs`
  (gated `RUN_NIM_E2E=1` + `NVIDIA_API_KEY`) drives the REAL `runDeterministicForNextStep` over live NIM,
  validated green; it found+fixed two real bugs in the audit in-process dispatch path: a **colon-in-packet-id
  sidecar crash** (audit packet ids embed `:`, invalid on Windows → errored every packet on win32; now uses the
  `artifactNameForId` FS-safe stem) and an **all-invalid-ingest crash** (`mergeAndIngest`'s hard block now
  absorbed into a no-progress pass so the fold blocks cleanly). Regression tests in
  `tests/audit/rolling-audit-dispatch.test.mjs`. REMAINING A8: the {host-subagent + NIM} HYBRID spill topology
  (FINDING-020 capstone) + a live cross-provider spill run. See `docs/a8-rolling-cutover-plan.md`.

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
