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
- **Old-name deprecations: ✓ DONE (Ethan, via npm website, 2026-06-19).** `auditor-lambda` /
  `remediator-lambda` / `@audit-tools/shared` are deprecated → redirect to `audit-tools`. No npm actions
  outstanding.

- **DOGFOOD remediate-code on its own backlog: ✓ DONE (2026-06-18).** Full record:
  `docs/dogfood-remediation-findings-2026-06-18.md`. Drove `remediate-code` end-to-end (full contract pipeline +
  adversarial critic→judge→repair + rolling implement). **Found+fixed 3 bugs (the rolling implement path was
  100% broken on Windows):** win32 verify-shim (`6a551b28`), stale-branch reset (`c9575b7f`), orphaned-dir reset
  (`e29cec16`). **Landed F5–F8 THROUGH the tool** (accept-node verify+merge → cherry-picks `bca2850c`/`3ecb492d`/
  `c5005289`): parseJsonLoose balance-scan + response_format default-on/degrade; OBL-CO-01 explicit
  POSITIVE:/NEGATIVE: labels; INV-CO-12 seam_adjustments corpus; validate-artifact envelope unwrap. Discovered 6
  backlog items already-shipped (pruned). Durable lesson: memory `rolling-implement-windows-and-writescope-findings`.

## Immediate next

**Whole-backlog remediation: ✓ BUILT + MERGED to `main` (2026-06-20, `a71050fb`) — PUBLISH HELD per Ethan.**
`/remediate-code over docs/remaining-specs.md` — all 14 modules (DC-1..6, F-1, A-2/A-7/A-8/A-9/A-10, INV-1/2)
planned end-to-end (162 obligations, 148 test specs, 13 residual-risk counterexamples folded in), then BUILT via
dependency-ordered subagent dispatch waves (worktree-isolated, tool-owned accept/merge). FF-merged to `main`;
**fully green** (`npm run build && check`; node:test **2987 pass / 0 fail / 11 gated-skip**; vitest **1754 / 0**).
A-9 autonomy capstone **ran live** (a NIM key was present): audit→remediate→`complete`, all four assertions pass.
Readable plan: [`docs/remaining-specs-remediation-plan.md`](remaining-specs-remediation-plan.md). **npm NOT published**
(global bins still run 0.28.8); publish was held until the A-8 wiring lands + Ethan reviews the diff.
- **Closing-gate catch:** the run skipped its closing gate, so I ran the merged-branch suite myself and fixed the
  one merge-surfaced regression (DC-2's new `provider-confirmation.json` write → registered as a side-channel in
  the executor-writeset parity test, `a71050fb`). Each block was green in isolation; only the merge surfaced it.
- **Deliberate integration seams (NOT bugs) — finish before a release:**
  - **A-8 hybrid: ✓ DONE — remediate + audit + DC-4, shared infra (2026-06-20, branch `a8-hybrid-spill-wiring`,
    ~13 commits `2ea578d`..`7e0a2e7`, fully green — awaiting Ethan's review before FF-merge + publish).**
    Ethan-confirmed scope = **Full hybrid now** (memory `a8-hybrid-full-scope`). BOTH orchestrators' next-step now
    split the eligible frontier host-vs-NIM via the ONE shared `planHybridDispatch` (the coordinator claims each
    node; classification injected): remediate runs the NIM partition in-process + hands the host partition to the
    `accept-node` loop; audit reviews the NIM partition in-process + the host batch-reviews the coverage-driven
    complement. The dispatcher brain is now FULLY shared (quota fold, rolling engine, claim registry, A-8
    coordinator, split layer, NIM pool shape `buildConfiguredApiPool`, DC-4 settled-pool store) — only the per-node
    EXECUTION (review-ingest vs worktree-merge) + host-spawn mechanism stay per-tool (the work differs). **DC-4
    cross-cycle pause:** a backend pool that exhausts settles (persisted, shared store) → next cycle excludes it →
    stranded work falls to the host pool. **crit. 3 live run ✓ DONE** (gated `tests/remediate/hybrid-nim-e2e.test.ts`
    drove `decideNextStep` with `provider=claude-code` + live NVIDIA NIM: split a 4-node frontier, NIM fixed
    B-003/n3.mjs → HEAD, host got 3). **Plus: dispatchable sources GENERALIZED** (commit `46d35e6`) —
    `DispatchableSource {provider,endpoint,parameters,quota}` in `SessionConfig.sources[]`, any non-IDE backend is
    its own pool launching from its own config (memory `dispatchable-sources-generic`). Remaining (NOT blocking):
    audit full-cutover hermetic test; `nim-rolling-e2e` gamma = `task_7d35176d`; optional host-pool-roster unify.
    Full record: `docs/a8-rolling-cutover-plan.md` §Step 7.
  - **DC-4** injectable `discoverProviders` stub (hermetic default; live roster supplies net-new).
  - **A-2** scorer + fixture corpus built; real scoring needs operator-authored `corpus/<run-id>.labels.json`.
  - Gated live e2e skip without creds: INV-2 `AUDIT_TOOLS_LIVE_QUOTA=1`, A-7 `RUN_CODEX_E2E=1`, A-9 `RUN_AUTONOMY_E2E=1`.
- **Open follow-up tasks (spawned):** `task_847a8c7d` (A-8 wiring) — ✓ DONE (remediate + audit + DC-4, branch
  above); `task_7d35176d` (in-process per-node verify hardcodes `npm run check`, ignores node
  `targeted_commands`), `task_2092be69` (complete_redelivery stale-report gate).
- **Prior-run cleanup (not a bug):** the earlier quick-wins run's promoted outputs sit in
  `.audit-tools/prior-run-quickwins-2026-06-19.bak/` (moved to clear the stale-report gate short-circuit; memory
  `stale-remediation-report-complete-redelivery-trap`).

**Quick-wins (S) remediation: ✓ SHIPPED — `audit-tools@0.28.8` LIVE (2026-06-19, `main` `7ee727c1`, CI run 27857663331).**
F-2/F-3/F-5/F-6/F-7/PB-1 — each its own green commit; full suite green; FF-merged to `main`, published, global bins reinstalled (both `--version` → 0.28.8). Commit map + scope decisions: memory `remaining-specs-quickwins-remediation`. NOTE the tool bug found doing it (memory `ambiguity-step-deemed-inappropriate-drops-finding`, backlog Known-friction): the ambiguity step's `deemed_inappropriate` silently DECLINED 5/7 approved findings — recovered by hand-implementing on the branch. Fix-in-tooling is OPEN.

**2026-06-19 dogfood work: ✓ SHIPPED — current live = `audit-tools@0.28.5`.**
- `0.28.3` — `resume-list-dogfood-fixes` merged: 8 code-bug fixes + notes 1–3 (lens proposition table
  `0092405b`/`e88d1afa`; standardized per-finding block `0092405b`; up-front ambiguity gate `264b36da`
  + mid-run `needs_clarification` outcome `70d74a8d`).
- `0.28.4` — auditor↔remediator parity (`013438ab`): the finding-display block is single-sourced in
  `src/shared/reporting/findingDisplay.ts`, rendered by both the audit report and the remediator
  prompts (review-gate + implement worker). Drift-guard test dropped (`c365d379`) — the shared
  renderer IS the guarantee.
- `0.28.5` — `17799586`: the duplication-vs-extraction smell is encoded in the worker-facing lens
  guidance (`dispatch/lens-definitions.json`) for the maintainability / architecture / tests lenses
  (conceptual reviewer deliberately left broad).
Branch `resume-list-dogfood-fixes` can be deleted.

**Remaining go-forward program** — now fully specced + planned in the whole-backlog plan above
(`docs/remaining-specs-remediation-plan.md`): A2/A7/A8/A9/A10 + DC-1..6 + F-1 + INV-1/2.

**Open dogfood frictions (write-scope / input-resume): ✓ CLEARED earlier (2026-06-19, on this branch).**
- ✓ Write-scope now ENFORCED before the cherry-pick (the architecturally-significant one). Moved into
  `acceptNodeWorktree` → `enforceAcceptWriteScope`: after verify, before merge, so an out-of-scope edit never
  lands; a blocked node is `merged:false` → triage with the reason in its diagnostic. The worker's
  `amended_files` are adjudicated at accept time against an ephemeral `OwnershipRegistry` seeded from every
  block's declared scope (unowned → granted/widened = the surfaced amend path; sibling-owned → seam conflict).
  The redundant post-hoc merge-time gate was deleted; declared scope is single-sourced from the persisted
  dispatch plan. New gate tests in `host-rolling-dispatch.test.ts`.
- ✓ `--input` re-passed after intake now RESUMES (no `input_conflict`) when it matches the run's recorded intake
  source (`suppliedInputMatchesRun` in `nextStep.ts`); a different input still trips the gate. Backend fix, not
  loader guidance. Test in `next-step-lifecycle.test.ts`.
- ✓ (prior PR #9) `accept-outcome` sidecar persists the failing command + output; rolling-dispatch prompt shows
  `accept-node --id <BLOCK_ID> --run-id <runId>`.

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
