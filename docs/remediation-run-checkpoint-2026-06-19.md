# Remediation run checkpoint — remaining-specs quick-wins + self-contained DCs (2026-06-19)

Branch: `remediation/remaining-specs-quickwins-and-self-contained-dcs` (base `d57c2e5f`, untouched).
Run id: `remaining-specs-quickwins-and-self-contained-dcs`.

## What completed cleanly

The whole **design + contract pipeline** ran to convergence:
- intake → goal_spec → context_bundle → module_decomposition → module_contracts →
  seam_reconciliation → finalized_module_contracts → conceptual_critique →
  test_validator_plan → contract_assessment → **adversarial critic → counterexample
  → judge → repair → re-converge** (2 passes; judge `approved`).
- The adversarial loop surfaced **6 real design holes** (CE-001..006) and the repair
  hardened all six (F-7 JSONL bounded accessor; F-2 SHA-reuse via server-time+databaseId;
  DC-4 resume-safe idempotent ingest; DC-1a vacuous-universal; PB-1 non-dispatch spawn
  callers; F-6 packet-vs-unit boundary single-sourcing).
- Review gate: user approved all 9 (Concrete tier).
- Implementation DAG: 9 nodes (IMPL-F2/F3/F5/F6/F7/PB1/DC3/DC1/DC4), one dep edge
  IMPL-F7 → IMPL-DC4.

## Implementation status (rolling, worktree-isolated)

4 of 9 workers ran; **all 4 produced verified-green changes in their worktrees**, but
**0 merged** — the tool's accept gate blocked every one.

| Node | Worker | Verify (worker, in-worktree) | Accept/merge | Where the diff lives |
|---|---|---|---|---|
| IMPL-F2 | done | green (`npm run check`; release-waiter test 7/7) | FAILED | quarantine ref `refs/remediation-quarantine/…/CP-BLOCK-IMPL-F2` |
| IMPL-F3 | done | green (check; quota test 4/4) | FAILED | quarantine ref `…/CP-BLOCK-IMPL-F3` |
| IMPL-F5 | done | green (build; phase-plan 43/43) | FAILED | quarantine ref `…/CP-BLOCK-IMPL-F5` |
| IMPL-F6 | done | green (check; f6 boundary 12/12) | not yet | worktree (uncommitted) |
| IMPL-F7 / PB1 / DC3 / DC1 / DC4 | NOT RUN | — | — | — |

### Worker diffs (verified-green)
- **F2**: `scripts/release-and-publish.mjs`, new `scripts/release-run-selector.mjs`, `tests/audit/release-waiter.test.mjs`. Selects publish run by head-SHA + server-side createdAt-after-push + databaseId-max (no tag-name/SHA-alone/local-clock). Addresses CE-002.
- **F3**: `src/audit/cli/quotaCommand.ts`, `tests/audit/quota-command.test.mjs`. quota command parses handshake flags → `buildDispatchPool` estimate (reuses dispatch parsing; roster>scalar; absent→cached fallback).
- **F5**: `tests/remediate/phase-plan.test.ts` (TEST-ONLY). Per-describe-scoped state; production unchanged.
- **F6**: `src/audit/validation/auditResults.ts` + new `src/audit/validation/unitBoundary.ts` (single-source unit boundary) consumed by `submitPacketCommand.ts`, `validateResultCommand.ts`, `mergeAndIngestCommand.ts`, `auditStep.ts`, `validateResultsCommand.ts`, `workerRunCommand.ts`; `tests/audit/f6-unit-boundary-evidence.test.mjs` (12) + 2 existing tests updated. Addresses CE-006.

## Why nothing merged — two tool defects + one real seam

1. **Empty declared write scope.** Every `state.plan.blocks[].touched_files` is `null`.
   The accept-time write-scope gate (`src/remediate/dispatch/amendmentClaim.ts`,
   `rollingSession.ts:computeAcceptScope`) rejects any edit not in the declared scope and
   does **not** auto-grant unowned files from a worker self-report. Root cause: the
   **implementation-DAG phase never populated per-node `output_files`/`files_likely_touched`**
   (the DAG skeleton doesn't ask for them, and derive doesn't pull `file_scope` from
   `module_decomposition`). So scope derived empty → all source edits "out of declared scope".
2. **Verify command authoring.** The DAG's `targeted_commands` were host-guessed
   (wrong test paths, missing the `tsx/esm` loader). Patched to repo npm scripts, but the
   **full-suite** form then failed because `tests/remediate/next-step-implement-dispatch.test.ts`
   spawns git worktrees and dies with `$GIT_DIR too big` when run **inside** a worktree.
   Verify must run only each node's **specific** test (build-free `node --import tsx/esm --test <file>`
   for audit, `npx vitest run <file>` for remediate), never the whole suite.
3. **Real 3-way seam.** F6, F7, DC4 all make additive edits to
   `src/audit/cli/mergeAndIngestCommand.ts`. Worktrees branch off a common base, so the
   2nd/3rd to merge hit a cherry-pick + ownership conflict the rolling model can't
   auto-reconcile (needs rebase-chaining or hand-merge). The seam_reconciliation only
   declared F7↔DC4; F6's boundary single-sourcing pulled the same file into the seam.

## Decision (taken): fix the tool defects first, then re-run

### Fixes applied (branch `fix/rolling-implement-writescope-verify-seam`)
- **Defect 1 — write-scope gate** (`cfc6597`, green). The accept-time gate only
  routed the worker's self-reported `amended_files` through the unowned-grant path;
  with no self-report nothing was granted, so the (empty) declared scope rejected
  every edit. Rewrote it to adjudicate the node's ACTUAL git edits: unowned → grant
  (extend-into-unowned), owned-by-sibling → seam-block. Extracted pure
  `adjudicateWriteScope` (git-free, unit-tested) + normalised paths to repo-relative
  (latent ownership bug). Dropped the distrusted self-report input.
- **Defect 2 — per-node verify** (`32a0a67`, green). Verify ran host-authored
  `targeted_commands` (wrong paths; full-suite-in-worktree → `$GIT_DIR too big`).
  Now DERIVED post-commit from the branch's touched test files
  (`deriveVerifyCommandsFromBranch` / pure `verifyCommandsForEdits`): always
  `npm run check`, then only this node's own tests with the repo's runners
  (node:test via tsx loader, `vitest run`), never the whole suite. Host drivers omit
  the param (→ derive); `[]` skips, explicit overrides. Dropped dead `computeTargeted`.

Full remediate suite green at each commit (1672 passing).

### Defect 3 — seam / overlap (remaining, now contained)
`createWorktree` already branches off **HEAD** (dispatch.ts:552), so the rolling
driver already rebase-chains *dependency-ordered* nodes (a node dispatched after its
dep merges branches off the advanced HEAD). The `IMPL-F7→IMPL-DC4` edge already
serialises those two. Residual gap, two parts:
- (a) **declared** file-scope overlap across nodes (e.g. F7/DC4 on
  `mergeAndIngestCommand.ts`) should add dependency edges at seam-reconciliation so
  the branch-off-HEAD chaining serialises them (partly covered by my manual dep edge).
- (b) **runtime-emergent** overlap (F6's boundary single-sourcing touched
  `mergeAndIngestCommand.ts`, undeclared) → on a cherry-pick conflict, rebase the
  node's branch onto the current remediation HEAD and re-verify; only a true hunk
  conflict routes to triage. (Today a conflict just fails to triage.)

### Re-run plan
With defects 1+2 fixed, re-running the remediation lands the non-overlapping nodes
cleanly; the `mergeAndIngest` trio (F6/F7/DC4) needs defect 3(b) (or a decomposition
that serialises them) to land without manual reconciliation.

## If resuming via the tool: corrected per-node verify commands
- F2: `node --import tsx/esm --test tests/audit/release-waiter.test.mjs`
- F3: `node --import tsx/esm --test tests/audit/quota-command.test.mjs`
- F5: `npm run build` + `npx vitest run tests/remediate/phase-plan.test.ts`
- F6: `node --import tsx/esm --test tests/audit/f6-unit-boundary-evidence.test.mjs`
- (un-run F7/PB1/DC3/DC1/DC4: dictate an exact test path per worker; declare it + source files in `touched_files` before accept; rebase-chain F7→DC4 and fold F6 so the `mergeAndIngestCommand.ts` seam is edited once per merged state.)
