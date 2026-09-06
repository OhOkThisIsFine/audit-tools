# Refactoring Plan: Hotspot #7 - Decomposing hostHandoff.ts

## Hotspot Overview & Current State

- **Hotspot:** `src/remediate/steps/dispatch/hostHandoff.ts` (Hotspot Rank #7, Score: 1,520; 2,740 lines total, Max CC: 80).
- **Primary function hotspot:** `ingestRemediationHostResults` (~375 lines, CC 80). It is the single most complex function in the remediate lane.
  - Note: the duplication-and-complexity catalog (§Phase 2) describes it as "500 lines". Source is ground truth: the body spans the workload-read gate through the final `return { accepted_count, … }`, roughly 375 lines of dense branching. The CC 80 figure is confirmed by the shape of the code (see phase inventory below).
- **Key symbols (actual, verified against source):**
  - `ingestRemediationHostResults` — the monolith under decomposition (exported).
  - `parseResult` / `ParsedHostResult` / `AcceptedHostResult` — the contract gate (existing; the stub's `validateHostResultBundle` does not exist yet and is the proposed Phase-1 extract name).
  - `corroborateHostResult` / `CorroboratedHostResult` and `corroborateNoChangeClaim` — the git/test corroboration layer (existing; together with `rerunRequiredTests` they form the proposed Phase-2 `executeHostVerificationReruns`).
  - `StateStore` (`src/remediate/state/store.ts`, owned by callers in `src/remediate/steps/nextStep.ts`) — the stub's `RemediationStore` does not exist as a symbol; no new store abstraction is proposed (see §1 rationale).
  - `RemediationHostDecision` / `RemediationHostResult` (private interfaces) — the stub's `HostExecutionResult` does not exist; the nearest real type is the `AcceptedHostResult` union (`{ ok: true, kind: "landed" } | { ok: true, kind: "decision" }`) plus the `CorroboratedHostResult` verdict. The plan reuses these rather than inventing a parallel vocabulary.
- **Symbol-name correction (load-bearing):** a repo-wide grep for `RemediationStore|HostExecutionResult|validateHostResultBundle` returns zero hits in `src/`; the only hit for the third name is the catalog's own proposal (`docs/reviews/duplication-and-complexity-catalog-2026-09-05.md`, Phase 2: `validateHostResultBundle`, `executeHostVerificationReruns`, `commitRemediationStateUpdates`). This plan adopts exactly those three proposed names for the extracts and does not introduce `RemediationStore` or `HostExecutionResult` as new types. Rationale is in §1.
- **Prior Sweep & Verification Findings:** the monolith interleaves result-bundle validation, automated verification test reruns, and ledger mutation/state commits. Refactoring must preserve fail-closed early returns and idempotent state recording across a security-critical boundary.
- **Graph/coverage evidence:** `search_graph` resolves `ingestRemediationHostResults` to `src/remediate/steps/dispatch/hostHandoff.ts` as the sole definition; inbound `trace_path` finds 4 callers; outbound `trace_path` finds 84 callees (58 shown before truncation). `check_index_coverage` on `hostHandoff.ts`, `nextStep.ts`, and this plan reports `no_recorded_issue` for all three paths (best-effort signal, generation matches). All behavioral claims below were verified by direct source read, not by graph alone.

---

## 1. Architectural Rationale & Boundary Analysis

### 1.1 Why three phases

`ingestRemediationHostResults` currently performs three logically sequential jobs in one function body with shared mutable locals (`issues`, `completed`, `resultIds`, `landedFiles`, `recordedRecoveryMarks`, `nextState`):

1. **Phase 1 — Validation (pure-ish, no I/O beyond reads):** parse state (`parseCurrentState`), resolve boundary paths (`resolveBoundaryPaths`), clone state (`structuredClone`), read the workload file (`readSubmissionDocument`), report producer defects advisoryly (`planBlockIssues`), enforce the git-backed binding gate (`trusted_binding_missing`), re-derive and digest-check the workload (`parseWorkload`), apply the legacy-scope in-memory view (`effectiveBoundWorkload`), and compute the schedulable frontier (`hostDependencyLevels` → `eligibleIds`).
2. **Phase 2 — Reruns / corroboration (I/O-heavy, side-effect-free on state):** per work item — pending filter, eligibility check, `scanBoundSubmission` + `parseResult` contract gate, `canCorroborate` attestation-only refusal, then either the no-change path (`corroborateNoChangeClaim` + `rerunRequiredTests`) or the landed path (`corroborateHostResult`, which itself sequences `gitCommitExists` → `gitCommitIsAncestor` → `gitCommitIsOrphaned` (recovery waiver) → landed-HEAD ancestry → `gitChangedFilesOfCommit` exact-match → write-scope → `run_start_dirty` overlap → `rerunRequiredTests`), plus the recovery-ledger mark protocol (`readSubmissionLedger` / `appendSubmissionEvent`, `recovery_unrecorded` fail-closed).
3. **Phase 3 — State commit (pure mutation of the clone):** apply decision outcomes (`resolved_no_change` / `blocked` / `needs_clarification` + `clarifications` array maintenance), apply landed acceptances (`status = "resolved"`, `landedFiles` accumulation), fold `applied_edit_surface`, derive `pendingWorkItemIds`, run the final-drain migration (`migrateLegacyDirectoryScopesAfterFinalDrain` + `delete nextState.host_handoff`), and compute `state_changed`.

The three phases have different failure semantics (Phase 1 fails the whole ingest closed; Phase 2 fails per-item closed and accumulates issues; Phase 3 is infallible given Phase 2 verdicts) and different test needs (Phase 1: fixture/state-table tests; Phase 2: git-fixture + fake-verdict tests; Phase 3: pure state-transition tests with no git at all). Splitting on these seams drops each function's CC into the teens and makes each phase independently characterizable.

### 1.2 The typed ingest context

The extracts share a read-mostly context object rather than six separate `let` locals closed over by one body. Proposed shape (new, file-local interface in `hostHandoff.ts`):

```ts
interface HostIngestContext {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly state: CurrentRemediationHostState;      // parsed, never mutated
  readonly nextState: CurrentRemediationHostState;  // the structuredClone; mutated ONLY in Phase 3
  readonly workload: RemediationHostWorkload;       // canonical parsed workload
  readonly effectiveWorkload: RemediationHostWorkload; // legacy-scope view actually iterated
  readonly eligibleIds: ReadonlySet<string>;        // level-0 frontier block ids
  readonly canCorroborate: boolean;                 // git root or persisted binding present
  readonly requiredTestVerdicts: RemediationRequiredTestVerdicts | null; // null = normal lane
  readonly recovery: boolean;                       // params.recovery !== undefined
}
```

Plus two accumulator types that flow Phase 2 → Phase 3:

```ts
type HostItemVerdict =
  | { readonly kind: "accept_landed"; readonly workItem: RemediationHostWorkItem; readonly result: RemediationHostResult; readonly changedFiles: readonly string[]; readonly usedRecovery: boolean }
  | { readonly kind: "accept_decision"; readonly workItem: RemediationHostWorkItem; readonly result: RemediationHostDecision }
  | { readonly kind: "refuse"; readonly issue: RemediationHostIngestIssue };

interface HostIngestAccumulators {
  readonly issues: RemediationHostIngestIssue[];       // starts with planBlockIssues output
  readonly completed: string[];                        // accepted work-item ids, in workload order
  readonly resultIds: Set<string>;                     // duplicate-result_id guard (Phase 2 only)
  readonly landedFiles: Set<string>;                   // accepted edit surface (Phase 3 only)
  recordedRecoveryMarks: SubmissionLedgerEvent[] | null; // lazy-loaded, Phase 2 only
}
```

Rules that preserve current semantics:

- **Fail-closed is structural, not remembered.** Every refusal path pushes a classified `RemediationHostIngestIssue` and `continue`s (per-item) or returns the zero-acceptance summary (whole-ingest gates). The extracts must not convert any refusal into a throw except the two existing whole-ingest throws (none exist inside the ingest today — all gates return summaries; keep it that way).
- **Idempotency is preserved by keeping three mechanisms intact:** (a) the `resultIds` set dedupes duplicate `result_id`s within one ingest; (b) the recovery mark identity `(run_id, submission_id, landed-commit-in-message)` check makes ledger appends converge on retry; (c) re-ingest of an already-resolved item is a no-op via the `pendingItems.length === 0 → continue` filter, which must stay the first check in the per-item loop.
- **No module-level mutable state.** The context and accumulators are constructed fresh per `ingestRemediationHostResults` call and passed by parameter. The normal-lane / recovery-lane distinction stays a parameter (`recovery?: { requiredTestVerdicts }`), so the no-spawn-under-lock property (recovery lane never spawns; missing verdict ⇒ `spawn_error` refusal) remains mechanical.
- **No store abstraction is introduced.** `RemediationStore` does not exist; persistence stays where it is — `StateStore.mutate` in `recoverIngestHostResults` and `store.saveState` in `buildImplementDispatchStep` (both in `nextStep.ts`). The ingest remains a pure function of `(params) → summary + nextState`; callers decide what to persist. This keeps the blast radius to one file plus its two call sites.

### 1.3 What does NOT move

`parseResult`, `corroborateHostResult`, `corroborateNoChangeClaim`, `rerunRequiredTests`, `runRequiredTest`, `precomputeRecoveryTestVerdicts`, `parseWorkload`, `parseWorkItem`, `planBlockIssues`, `effectiveBoundWorkload`, `hostDependencyLevels`, `migrateLegacyDirectoryScopesAfterFinalDrain`, and all git probes (`gitCommitExists`, `gitCommitIsAncestor`, `gitCommitIsOrphaned`, `gitChangedFilesOfCommit`, `gitChangedFilesSince`) keep their signatures. Only their call sites relocate into the three new phase functions. The shared submission core (`scanBoundSubmission`, `parseWorkloadEnvelope`, ledger primitives) is untouched.

## 2. Blast Radius & Affected Files

### 2.1 Production code

| File | Impact |
|---|---|
| `src/remediate/steps/dispatch/hostHandoff.ts` | **Primary.** Add `HostIngestContext`, `HostItemVerdict`, `HostIngestAccumulators` types; add `validateHostResultBundle`, `executeHostVerificationReruns`, `commitRemediationStateUpdates`; shrink `ingestRemediationHostResults` to an orchestrator (~60 lines). No export-list change except the three new functions if tests need them (prefer file-local + export for testability; see §5). |
| `src/remediate/steps/nextStep.ts` | **Call-site review only.** `buildImplementDispatchStep` and `recoverIngestHostResults` call `ingestRemediationHostResults` with an unchanged signature — no edit required unless the orchestrator's params type changes (it must not). `currentHostBoundaryState` untouched. |
| `src/remediate/index.ts` | **None.** Re-exports `recoverIngestHostResults` only; unaffected. |
| `src/shared/submission/*` | **None.** `scanBoundSubmission`, envelope parsing, ledger append/read are consumed, not modified. |

### 2.2 Callers (inbound trace, verified)

- `src/remediate/steps/nextStep.ts → buildImplementDispatchStep` (normal lane: ingest, then `store.saveState` on `state_changed`).
- `src/remediate/steps/nextStep.ts → recoverIngestHostResults` (recovery lane: `precomputeRecoveryTestVerdicts` unlocked, then `store.mutate` + ingest with `recovery: { requiredTestVerdicts }`, plus the `tree_moved_between_phases` HEAD guard).
- `src/remediate/index.ts` (re-export of the verb) and `src/remediate/steps/nextStep.ts → execute` (dispatch routing) — structural, no behavior.

### 2.3 Tests

- `tests/remediate/host-handoff.test.ts` — main ingest contract suite (prepare/ingest round-trips, issue codes).
- `tests/remediate/host-handoff-corroboration.test.ts` — git corroboration, no-change falsification, recovery-mode acceptance incl. ledger-mark dedupe.
- `tests/remediate/backend-independent-planning.test.ts` — references `ingestRemediationHostResults` (graph hit; verify no signature dependence).
- Audit-lane suites (`tests/audit/host-handoff*.test.ts`, `tests/shared/host-handoff-core.test.ts`) exercise the twin boundary and shared core — regression-only, expect zero impact.

### 2.4 Risks

1. **Fail-open regression** — the highest risk. Any refusal path accidentally dropped or reordered during extraction admits an attestation-only or out-of-scope result. Mitigation: exhaustive issue-code preservation checklist (§5.2) plus a pre-refactor characterization run.
2. **Ordering drift** — issues array order and `completed` order are workload order today; tests may assert sequences. The extracts must iterate `effectiveWorkload.work_items` in order and preserve push order.
3. **Recovery-ledger double-mark** — the lazy `recordedRecoveryMarks` load + `(run, item, landed-commit)` identity check must move verbatim into Phase 2.
4. **Legacy scope recovery** — `effectiveBoundWorkload` and the final-drain `migrateLegacyDirectoryScopesAfterFinalDrain` must run at exactly the same points (pre-loop and post-loop respectively).

## 3. Specific Code Modifications (Symbol-Located)

All locations are symbols in `src/remediate/steps/dispatch/hostHandoff.ts` unless noted. No line numbers — symbols are the anchors.

### 3.1 Add `HostIngestContext`, `HostItemVerdict`, `HostIngestAccumulators` interfaces

(new, placed directly above `ingestRemediationHostResults`). Carries the shared inputs (§1.2) so the three phases take one context parameter instead of six threaded arguments. `nextState` is the sole mutable member and is written only by `commitRemediationStateUpdates`.

### 3.2 Extract `validateHostResultBundle(ctx-inputs) → { ctx } | { earlySummary }`

Move, verbatim and in order: the `readSubmissionDocument(paths.workloadPath)` missing/malformed gate (codes `workload_missing` / `workload_invalid` when `state.host_handoff` exists, else zero-issue early return); the advisory `issues.push(...planBlockIssues(paths.root, state))`; the git-backed `trusted_binding_missing` gate; the `parseWorkload` → `workload_invalid` accumulation (not replacement); `effectiveBoundWorkload(state, workload)`; `eligibleIds` from `hostDependencyLevels(state)[0]`; `canCorroborate` computation (`state.host_handoff !== undefined || isGitRepo(paths.root)`); `requiredTestVerdicts` selection (`params.recovery?.requiredTestVerdicts ?? null`). Returns either the populated `HostIngestContext` (+ pre-seeded `issues`) or a finished `RemediationHostIngestSummary` for the two whole-ingest early exits.

### 3.3 Extract `executeHostVerificationReruns(ctx, acc) → Promise<void>`

Move the entire `for (const workItem of effectiveWorkload.work_items)` verification body up to (but excluding) state mutation: pending filter; `eligibleIds` refusal (`submission_contract_invalid`); `scanBoundSubmission` with `parseResult` adapter and `remediationScanMessages`; `resultIds` duplicate guard; the `parsed.kind === "decision"` branch's verification half (`canCorroborate` refusal, `corroborateNoChangeClaim` with the `excusedPaths` ground-truth set, `rerunRequiredTests` + `requiredTestIssue`) ending in an `accept_decision` verdict; the landed branch's `canCorroborate` refusal, `corroborateHostResult` call, and `usedRecovery` ledger-mark protocol (`readSubmissionLedger` lazy load, identity check, `appendSubmissionEvent`, `recovery_unrecorded` refusal) ending in an `accept_landed` or `refuse` verdict. Emits one `HostItemVerdict` per iterated item into an ordered array; performs zero writes to `nextState`.

### 3.4 Extract `commitRemediationStateUpdates(ctx, acc, verdicts) → Omit<summary,"state">`-plus-state assembly

Move the verdict-application code: decision-outcome application to `nextState.items` (`resolved_no_change` with `host_result_evidence`, `blocked` with `failure_reason`, `needs_clarification` with `clarifications` dedupe + default `scope_of_fix` category); landed acceptance (`status = "resolved"`, timestamp handling, `landedFiles` accumulation); `applied_edit_surface` fold; `pendingWorkItemIds` derivation from `effectiveWorkload`; final-drain `migrateLegacyDirectoryScopesAfterFinalDrain` + `delete nextState.host_handoff`; `state_changed = completed.length > 0 || drained`. Assembles the final `RemediationHostIngestSummary`.

### 3.5 Shrink `ingestRemediationHostResults` to an orchestrator

Keep the exported signature (including the `recovery?: { requiredTestVerdicts }` option and the `UnsupportedRetiredRemediationState` return) byte-identical. New body: `parseCurrentState` → `resolveBoundaryPaths` → `structuredClone` → `validateHostResultBundle` (return early summary if gated) → construct accumulators → `await executeHostVerificationReruns` → `return commitRemediationStateUpdates`. Target: under ~60 lines, CC ≤ 4.

### 3.6 Explicit non-changes

`StateStore` usage in `nextStep.ts` (`buildImplementDispatchStep`, `recoverIngestHostResults`), `prepareRemediationHostHandoff`, `remediationSubmissionBinding`, `precomputeRecoveryTestVerdicts`, and every helper named in §1.3 are not modified.

## 4. Step-by-Step Implementation Sequence

1. **Baseline green.** Run build + typecheck + lint + `tests/remediate/host-handoff.test.ts` + `tests/remediate/host-handoff-corroboration.test.ts` on a clean tree; record the suite stamp per repo process.
2. **Characterization lock.** Add (or confirm existing coverage of) one test per fail-closed gate in §5.2 that asserts the exact issue code for a crafted bad input. These tests must pass before and after with zero message changes.
3. **Add types + Phase-1 extract (`validateHostResultBundle`).** Move code per §3.2; orchestrator calls it and returns early summaries unchanged. Run the two suites + typecheck.
4. **Add Phase-2 extract (`executeHostVerificationReruns`).** Move the verification body per §3.3, returning verdicts; orchestrator still applies them inline at this step (temporary). Run suites — this isolates verification-move regressions from commit-move regressions.
5. **Add Phase-3 extract (`commitRemediationStateUpdates`).** Move verdict application per §3.4; orchestrator becomes the §3.5 thin form. Run suites.
6. **Dead-code sweep.** Remove any now-unused locals/imports in `hostHandoff.ts`; confirm `tsc` + `eslint` clean and no `TODO`/debug residue.
7. **CC + diff review.** Confirm `ingestRemediationHostResults` ≤ ~60 lines / CC ≤ 4 and each extract CC ≤ ~20; review the full diff for ordering or message drift.
8. **Full verification per §5.3**, then ship per repo process (no commit in this planning step).

## 5. Verification & Regression Test Plan

### 5.1 Pre-existing suites (must stay green, byte-identical expectations)

- `tests/remediate/host-handoff.test.ts` — prepare/ingest round-trips, workload binding, eligibility, decision outcomes.
- `tests/remediate/host-handoff-corroboration.test.ts` — landed corroboration (ancestry, exact file match, write scope, dirt overlap, test reruns), no-change falsification, recovery waiver + ledger dedupe.
- `tests/remediate/backend-independent-planning.test.ts` — ingest reference surface.
- `tests/shared/host-handoff-core.test.ts` + `tests/audit/host-handoff*.test.ts` — shared-core/audit-twin regression (expect zero impact; failures here mean the shared core was touched by accident).

### 5.2 Fail-closed gate checklist (each gate: crafted input → exact `code` + `check`)

`workload_missing`, `workload_invalid` (missing + malformed), `trusted_binding_missing` (binding gate, landed-no-corroboration, no-change-no-corroboration), `submission_contract_invalid` (ineligible item), scan issues (`missing`/`malformed`/`contractInvalid`/`duplicate` via `remediationScanMessages`), `result_envelope` / `identity_binding` / `write_scope` / `commit_evidence` / `test_evidence` / `obligation_evidence` / `worktree_evidence` / `landing_attestation` / `outcome_shape` (via `parseResult`), `commit_missing` / `baseline_not_ancestor` / `commit_not_landed` / `changed_files_mismatch` / `run_start_dirty_overlap` / `required_test_failed` / `required_test_timed_out` / `required_test_output_overflow` (via `corroborateHostResult` + `rerunRequiredTests`), `no_change_corroboration` paths, `recovery_unrecorded`, `tree_moved_between_phases` (recovery verb in `nextStep.ts`), `dependency_missing` / `block_contract_invalid` (advisory `planBlockIssues`).

### 5.3 New tests to add with the refactor

- **Phase isolation:** Phase-3 pure-transition tests (decision + landed verdict application, `clarifications` dedupe, final-drain migration, `state_changed` semantics) with no git fixture.
- **Idempotency:** double-ingest of the same workload converges (second ingest: zero acceptances, items already non-pending skipped).
- **Recovery dedupe:** same landed commit re-ingested in recovery mode appends no second `accepted_via_recovery` event.
- **Ordering:** multi-item mixed accept/refuse ingest preserves workload-order `completed` and `issues` sequences.

### 5.4 Static gates

- `tsc` + `eslint` clean; complexity spot-check (orchestrator CC ≤ 4, extracts each CC ≤ ~20); `git diff` review confirming no issue-message string changed and no caller in `nextStep.ts` modified.
