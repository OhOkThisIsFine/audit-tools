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

- **A6 completeness follow-up: ✓ landed on `main` `07f387d` (UNPUBLISHED, 2026-06-19).** The merged A6
  deleted all JSON schemas but left 6 contracts as plain TS interfaces; converted them to zod single-source
  (`RemediationOutcome{,Status,sReport}`, `IntentCheckpoint`, `AuditState`, `AuditScopeManifest`,
  `FlowCoverageManifest`, `AnalyzerCapabilityRecord`) + prereq schemas + `OUTCOME_KEYS` derived. Behavior-
  identical (z.infer), so a republish is OPTIONAL — rolls into the next `release:patch` whenever one ships.
  Details: memory `a6-zod-single-source-done`.
- **PUBLISH: ✓ `audit-tools@0.28.2` LIVE on npm** (`latest`, OIDC CI run `27801269989`, tokenless). Carries
  the dogfood's 3 rolling-dispatch fixes + F5–F8 (below). Global bins reinstalled + postinstall run; both
  `--version` → 0.28.2. (0.28.1 = prior win32 audit fix + NIM e2e.) Go-forward release path:
  `env -u CLAUDECODE npm run release:patch:publish`.
- **ONE remaining Ethan-only npm action (needs his 2FA — I can't):** deprecate the old names (redirect):
  `npm deprecate auditor-lambda "Merged into 'audit-tools' (v0.28.0+). Install: npm i -g audit-tools"` — same
  for `remediator-lambda` and `@audit-tools/shared`. Non-blocking (cosmetic redirect for old installs).

- **DOGFOOD remediate-code on its own backlog: ✓ DONE (2026-06-18).** Full record:
  `docs/dogfood-remediation-findings-2026-06-18.md`. Drove `remediate-code` end-to-end (full contract pipeline +
  adversarial critic→judge→repair + rolling implement). **Found+fixed 3 bugs (the rolling implement path was
  100% broken on Windows):** win32 verify-shim (`6a551b28`), stale-branch reset (`c9575b7f`), orphaned-dir reset
  (`e29cec16`). **Landed F5–F8 THROUGH the tool** (accept-node verify+merge → cherry-picks `bca2850c`/`3ecb492d`/
  `c5005289`): parseJsonLoose balance-scan + response_format default-on/degrade; OBL-CO-01 explicit
  POSITIVE:/NEGATIVE: labels; INV-CO-12 seam_adjustments corpus; validate-artifact envelope unwrap. Discovered 6
  backlog items already-shipped (pruned). Durable lesson: memory `rolling-implement-windows-and-writescope-findings`.

## Immediate next: the go-forward program

**Open dogfood frictions to fix (highest-value next, all in `docs/backlog.md` Known-friction):**
- Write-scope gate runs AFTER `accept-node` cherry-picks → reports post-hoc, doesn't prevent; and the
  host-declared `file_scope` is a guess the rolling worker can't amend (a too-narrow scope blocks a correct fix).
- `accept-outcome` sidecar + triage discard the verify command output (triage flies blind on `outcome:error`).
- `--input` after intake → hard input_conflict; `accept-node` needs `--run-id` though the prompt shows only `--id`.

**Remaining accepted program** (`docs/backlog.md` → "Accepted go-forward program"):
- **A7 (REFRAMED)** — validate the host install/integration machinery across all hosts (Codex, OpenCode,
  Antigravity), not just Claude Code.
- Deferred: **A2** (falsifiable finding-quality oracle), **A9/A10** (autonomy acceptance + multi-process).
- **A8 loose end:** the {host-subagent + NIM} HYBRID spill topology (FINDING-020 capstone) + a live
  cross-provider spill run. See `docs/a8-rolling-cutover-plan.md`. (audit-code NIM e2e already DONE in 0.28.1.)

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
