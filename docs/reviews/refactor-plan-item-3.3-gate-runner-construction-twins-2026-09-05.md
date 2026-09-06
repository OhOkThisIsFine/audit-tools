# Refactoring Plan: Item 3.3 - Gate Runner Construction Twins

## Item Overview & Current State

- **Item:** 3.3 Gate Runner Construction Twins
- **Files Involved:**
  - src/remediate/steps/nextStep.ts
- **Key Symbols:** runReviewApprovalGate, runPlanningReviewGate, ReviewDecisionRecord, writeJsonFile, archiveConsumedInputs
- **Prior Sweep & Verification Findings:**
  Both functions duplicate the construction of ReviewDecisionRecord literals, serializing them, and archiving consumed input files.
  However, Path A and Path B have distinct correlation lifecycles and return types. Extraction must be strictly scoped to record persistence/archiving helpers, without merging gate control flows.

---

## 1. Architectural Rationale & Boundary Analysis

### 1.1 What is actually twinned (verified against source)

There are **three** `ReviewDecisionRecord` construction sites in `src/remediate/steps/nextStep.ts`, not two.
Two are the catalog-cited twins; the third is the autonomous branch inside Path A and must be covered by the
same helper or the duplication survives:

| Site | Symbol | plan_id source | approved_ids | declined |
|---|---|---|---|---|
| A1 — autonomous branch | `runReviewApprovalGate`, autonomous arm | `randomRunId("path-a-review")` (fresh per call) | `auto.approved_ids` from `buildAutonomousReviewDecision` | `[]` (leftovers stay LIVE by design, COR-227a02ae) |
| A2 — interactive consume branch | `runReviewApprovalGate`, `gateOpen` consume arm | `request.plan_id` (regenerated run-unique request) | `decision.approved_ids` from `applyReviewResolution` | `decision.declined` |
| B — planning point | `runPlanningReviewGate`, consume arm | `request.plan_id` (live plan's own id, INV-RSM-RESOLUTION-CORRELATE) | `decision.approved_ids` | `decision.declined` |

All three literals share the identical shape — `schema_version: REVIEW_DECISION_SCHEMA_VERSION`,
`plan_id`, `approved_ids`, `declined`, `created_at: new Date().toISOString()` — followed immediately by
`await writeJsonFile(decisionPath, record)` (`writeJsonFile` is the shared atomic JSON writer in
`src/shared/io/json.ts`; it is already single-sourced and is **not** changed by this refactor).

The consumed-input archive loop is byte-identical in A2 and B:

```ts
for (const p of [resolutionPath, requestPath]) {
  if (existsSync(p)) {
    await withFsRetry(() => rename(p, `${p}.consumed-${Date.now()}`));
  }
}
```

(`withFsRetry` and `existsSync`/`rename` imports already exist in `nextStep.ts`; no import changes needed.)

### 1.2 Why a persistence/archiving-only extraction is the right shape

- The duplicated logic is **mechanical persistence**, not policy: stamping a schema version + timestamp,
  serializing atomically, and renaming consumed inputs so the gate cannot re-halt. None of it depends on
  which path's correlation lifecycle produced the decision.
- The thing that *varies* — the `plan_id` source and the approved/declined sets — is already computed
  by each caller before the literal. A helper taking `(planId, approvedIds, declined)` as parameters
  captures 100% of the commonality with zero policy leakage.
- `archiveConsumedInputs` (named in this plan's key-symbol list) **does not exist yet** — the loop is
  currently inlined at both sites. Creating it as a module-private helper gives the archive lifecycle
  one name, one suffix literal (`.consumed-`), and one retry wrapper. The `.stale-` and `.refused-`
  archive paths (`refuseUnknownIdResolution`, stale cross-run resolution arms) use different suffixes
  and single-file shapes and stay inline — see non-goals.

### 1.3 Boundary: what must NOT be merged (load-bearing differences)

1. **Firing predicates.** Path A computes `gateOpen` (`survivors.length > 0 && !existsSync(decisionPath) &&
   !contractArtifactExists(artifactsDir, "goal_spec")`) at intake with no state; Path B is fired by
   `handlePlanning` (`state.plan && !existsSync(reviewDecisionPath(artifactsDir))`) at the planning point.
   Merging them would couple intake file-pre-state logic to planning state logic.
2. **Autonomous branch.** Only `runReviewApprovalGate` has the `autonomous` arm (never halts, leftover
   re-emit via `emitAutonomousLeftoverDeliverable`, `declined: []`). Path B has no autonomous mode.
3. **Return contracts.** Path A returns `ReviewGateProceed | ReviewGateHalt` (approved/declined split for
   the coverage ledger + pipeline seeding at its `handlePendingIntake` / `handleReadyIntakeContractPipeline`
   call sites); Path B returns `RemediationStep | null` and applies declined nodes directly as recorded
   `ignored` terminal dispositions + `store.saveState`. Unifying returns forces both call chains to change.
4. **plan_id provenance.** Path A mints `randomRunId("path-a-review")` per request; Path B correlates on the
   live plan's own `plan_id` (`state.plan?.plan_id ?? randomRunId("path-b-review")` fallback). The helper
   receives the already-chosen id; it must not choose.
5. **Decision replay.** Only Path A replays (`approvedIds` set keying, COR-227a02ae fallback to declined-set
   exclusion). Path B consumes once and marks items. Untouched.
6. **Stale-resolution / refusal control flow.** The `isResolutionForRequest` mismatch arm (`.stale-` archive +
   `writeJsonFile(requestPath, request)` re-halt) and the `refuseUnknownIdResolution` call look similar but
   return different halt wrappers per gate and carry different comments. Extracting them couples the halt
   contracts — explicitly out of scope.
7. **Sibling gates.** `runPlanAmbiguityGate` and the mid-run clarification resolver repeat the same
   `.consumed-` archive loop over *their own* request/resolution paths. They are the natural next adopter
   of `archiveConsumedInputs` but are **not** migrated in this item — one item, one gate pair, no drive-by
   blast-radius expansion. (Optionally listed as a follow-up.)

### 1.4 Proposed helper surface (module-private, same file, beside the path helpers)

```ts
function buildReviewDecisionRecord(
  planId: string,
  approvedIds: string[],
  declined: Array<{ finding_id: string; reason: string }>,
): ReviewDecisionRecord

async function writeReviewDecisionRecord(
  decisionPath: string,
  record: ReviewDecisionRecord,
): Promise<void>   // thin writeJsonFile wrapper; single-sources the persistence call

async function archiveConsumedInputs(paths: string[]): Promise<void>
  // existsSync-guarded withFsRetry(rename → `.consumed-${Date.now()}`) loop
```

All three stay **module-private** (no export, no `shared/` move): both call sites live in `nextStep.ts`,
and exporting persistence helpers invites cross-module coupling for a two-callsite dedup. If the ambiguity
gate later adopts `archiveConsumedInputs`, it is already in scope without any export.

---

## 2. Blast Radius & Affected Files

### 2.1 Directly changed

- **`src/remediate/steps/nextStep.ts`** (only production file):
  - `ReviewDecisionRecord` — unchanged shape; gains one constructor helper beside it.
  - `runReviewApprovalGate` — A1 + A2 literal+write sites replaced with helper calls (~14 lines → ~6).
  - `runPlanningReviewGate` — B literal+write+archive sites replaced with helper calls (~12 lines → ~4).
  - New: `buildReviewDecisionRecord`, `writeReviewDecisionRecord`, `archiveConsumedInputs` (module-private,
    placed with `reviewRequestPath` / `reviewDecisionPath` path helpers).

### 2.2 Callers (read, do not change)

Per graph trace (`trace_path`, inbound):
- `runReviewApprovalGate` ← `handlePendingIntake`, `handleReadyIntakeContractPipeline` (via `execute`).
  Path-A intake call at the `runReviewApprovalGate(root, artifactsDir, filter.survivors, …)` site also feeds
  `persistReviewFilterDispositions`, `findingRiskEvidence(gate.approved)`, and the approved-only seed swap —
  all downstream of the returned `proceed`, unaffected by a persistence-only extraction.
- `runPlanningReviewGate` ← `handlePlanning` (via `execute`), gated on `!existsSync(reviewDecisionPath(…))`.
- `writeJsonFile` (`src/shared/io/json.ts`) — 53 callers repo-wide; **not modified**. The refactor only
  reduces two of its call sites to go through a wrapper; its atomic-write semantics are untouched.

### 2.3 Tests that observe the affected artifacts (must stay green, no edits expected)

- `tests/remediate/next-step-review-gate.test.ts` — asserts `review_request.json` shape, halt/proceed,
  `review_decision.json` content, seed/approved-findings paths. Exercises Path A through `decideNextStep`.
- `tests/remediate/cp-node-1-regressions.test.ts` — reads `review_decision.json`.
- `tests/remediate/n-r13-document-phase-dissolved.test.ts` — reads `review_decision.json`.
- `tests/remediate/integration-pipeline.test.ts` — reads `review_decision.json`.
- Any suite asserting `.consumed-` archive side effects (rename of request/resolution after consume).

### 2.4 Explicitly out of blast radius

- `src/shared/io/json.ts`, `src/remediate/review/reviewGate.ts` (`buildReviewRequest`,
  `applyReviewResolution`, `isResolutionForRequest`, `screenResolutionIds`), `autonomousGate.ts`,
  `finalGate.ts`, `contractPipeline.ts` — no changes.
- `ReviewDecisionRecord` JSON shape on disk (`schema_version`, `plan_id`, `approved_ids`, `declined`,
  `created_at`) — byte-identical before/after; `discardOnSchemaVersionMismatch` replay paths unaffected.
- Coverage: `check_index_coverage` for `src/remediate/steps/nextStep.ts`, `src/shared/io/json.ts`,
  `tests/remediate/next-step-review-gate.test.ts` reports `no_recorded_issue` (generation current), so
  graph callers above are trusted subject to the standard best-effort caveat.

---

## 3. Specific Code Modifications (Symbol-Located)

### 3.1 — New helpers, located beside `reviewDecisionPath` (near `ReviewDecisionRecord`)

Place immediately after the `reviewDecisionPath` / `ambiguityDecisionPath` path helpers and before
`extractAuditFindings`, so all review-gate persistence vocabulary sits together:

- **`buildReviewDecisionRecord(planId, approvedIds, declined)`** — constructs the literal:
  `schema_version: REVIEW_DECISION_SCHEMA_VERSION`, `plan_id: planId`, `approved_ids: approvedIds`,
  `declined`, `created_at: new Date().toISOString()`. Takes the declined array by value (callers pass
  `decision.declined` / `[]`); no cloning — matches current pass-through semantics exactly.
- **`writeReviewDecisionRecord(decisionPath, record)`** — `await writeJsonFile(decisionPath, record)`.
  Thin by design: its value is naming the persistence point, so a future schema bump or ledger hook has
  one call site to find. (Alternative — inline `writeJsonFile` at the three sites and only extract the
  builder — is acceptable and one line shorter per site; prefer the wrapper so the literal and its
  persistence can never drift apart again.)
- **`archiveConsumedInputs(paths)`** — the exact loop currently inlined:
  `existsSync` guard → `withFsRetry(() => rename(p, \`${p}.consumed-${Date.now()}\`))` per path.
  Parameter is `readonly string[]`; callers pass `[resolutionPath, requestPath]` preserving the current
  resolution-first order.

### 3.2 — `runReviewApprovalGate`, autonomous arm (site A1)

Replace:

```ts
const record: ReviewDecisionRecord = {
  schema_version: REVIEW_DECISION_SCHEMA_VERSION,
  plan_id: randomRunId("path-a-review"),
  approved_ids: auto.approved_ids,
  declined: [],
  created_at: new Date().toISOString(),
};
await writeJsonFile(decisionPath, record);
```

with:

```ts
await writeReviewDecisionRecord(
  decisionPath,
  buildReviewDecisionRecord(randomRunId("path-a-review"), auto.approved_ids, []),
);
```

Nothing else in the arm changes — leftover computation, `emitAutonomousLeftoverDeliverable`, and the
`proceed` return stay inline.

### 3.3 — `runReviewApprovalGate`, interactive consume arm (site A2)

Replace the literal + write + archive block:

```ts
const record: ReviewDecisionRecord = { … plan_id: request.plan_id, approved_ids: decision.approved_ids, declined: decision.declined, … };
await writeJsonFile(decisionPath, record);
// Archive the consumed inputs so the gate cannot re-halt.
for (const p of [resolutionPath, requestPath]) { … }
```

with:

```ts
await writeReviewDecisionRecord(
  decisionPath,
  buildReviewDecisionRecord(request.plan_id, decision.approved_ids, decision.declined),
);
// Archive the consumed inputs so the gate cannot re-halt.
await archiveConsumedInputs([resolutionPath, requestPath]);
```

Keep the `// Archive the consumed inputs so the gate cannot re-halt.` comment at the call site — it
documents *why* the archive exists at this point in the control flow, which is caller context, not
helper internals.

### 3.4 — `runPlanningReviewGate`, consume arm (site B)

Same replacement as 3.3 (identical code shape):

```ts
await writeReviewDecisionRecord(
  decisionPath,
  buildReviewDecisionRecord(request.plan_id, decision.approved_ids, decision.declined),
);
// Archive the consumed inputs so the gate cannot re-halt.
await archiveConsumedInputs([resolutionPath, requestPath]);
```

The declined-→-`ignored` disposition loop and `store.saveState` below it are untouched.

### 3.5 — What is deliberately NOT touched (with reason)

- `refuseUnknownIdResolution` — already the shared id-join pre-screen; both gates call it. No change.
- `.stale-` archive arms (`rename(resolutionPath, …stale-…)`) — single-file, different suffix, coupled to
  per-gate re-halt wrappers. No change.
- `runPlanAmbiguityGate` + mid-run clarification resolver `.consumed-` loops — same pattern, different
  gates; adoption is a follow-up item, not this one.
- No import changes (`existsSync`, `rename`, `withFsRetry`, `writeJsonFile` all already imported).
- No type export changes (`ReviewDecisionRecord` stays module-private).

---

## 4. Step-by-Step Implementation Sequence

1. **Add the three helpers** beside `reviewDecisionPath` (location per §3.1). No caller changes yet;
   typecheck to prove the helpers compile in isolation.
2. **Migrate site A1** (autonomous arm of `runReviewApprovalGate`, §3.2). Typecheck.
3. **Migrate site A2** (interactive consume arm of `runReviewApprovalGate`, §3.3), keeping the
   archive comment. Typecheck.
4. **Migrate site B** (`runPlanningReviewGate` consume arm, §3.4), keeping the archive comment. Typecheck.
5. **Grep-verify no residue**: search `nextStep.ts` for `schema_version: REVIEW_DECISION_SCHEMA_VERSION`
   (expect exactly one hit — inside `buildReviewDecisionRecord`) and for `.consumed-${Date.now()}`
   (expect exactly one hit — inside `archiveConsumedInputs`, plus the intentionally out-of-scope
   ambiguity/clarification sites, which must be visually confirmed as the *other* gates' loops).
6. **Run the verification plan** (§5). If any gate test fails, revert the migration step that introduced
   it (steps 2–4 are independently revertible — each is a local literal→call swap).

Estimated scope: ~+20 lines helpers, ~−25 lines across three sites; single file; no test edits.

---

## 5. Verification & Regression Test Plan

### 5.1 — Static checks

- `tsc` clean (repo typecheck) after each migration step.
- ESLint on `src/remediate/steps/nextStep.ts` (if the repo lint covers it) — no new warnings.
- Residue greps from step 5 above, recorded in the commit message or PR note.

### 5.2 — Targeted suites (must be green, unmodified)

- `tests/remediate/next-step-review-gate.test.ts` — primary gate contract: halt shape, request tiers,
  decision content, approved-only seeding. Covers sites A1/A2 through `decideNextStep`.
- Path-B planning coverage: whichever suite drives `handlePlanning` with a document/conversation intake
  through `runPlanningReviewGate` to `review_decision.json` + `ignored` dispositions (identify by running
  the `tests/remediate` filter for `review_decision` / planning-gate cases; at minimum the suites listed
  in §2: `cp-node-1-regressions`, `n-r13-document-phase-dissolved`, `integration-pipeline`).
- Archive-lifecycle assertions: any test asserting `review_request.json` / `review_resolution.json` are
  renamed to `.consumed-*` after consume and the gate does not re-halt on the next `decideNextStep` call
  (idempotency: decision file consumed directly on re-entry).

### 5.3 — Behavioral equivalence argument (what the tests prove)

- **Decision bytes identical**: helpers stamp the same `schema_version` constant and `toISOString()`
  timestamp shape; `approved_ids`/`declined` are passed through, not transformed. Tests reading
  `review_decision.json` assert the same content as before.
- **Archive side effects identical**: same paths, same order (resolution first), same `existsSync` guard,
  same `withFsRetry(rename)` and `.consumed-${Date.now()}` suffix. Re-halt-impossible behavior preserved.
- **Control flow untouched**: firing predicates, halt/proceed shapes, autonomous policy, replay keying,
  and disposition writes are not in the migrated lines — verified by diff review (the diff should show
  only literal→call swaps plus helper definitions).

### 5.4 — Full-suite gate

- Run the `tests/remediate` directory (or the repo's standard suite gate per `CLAUDE.md`) green before
  commit. If the repo uses a green-stamp / verify ledger, record through it.
- Flake protocol: a failing gate test re-runs solo before being called a regression (shared-dir
  hermeticity is the known suspect in this area).

### 5.5 — Follow-up (not this item)

- Adopt `archiveConsumedInputs` in `runPlanAmbiguityGate` and the mid-run clarification resolver if this
  item lands cleanly (separate item; expands call sites from 2 to 4 with zero helper changes).
- Consider whether `writeReviewDecisionRecord` should own a run-log event (currently only the autonomous
  leftover emit logs); no behavior change proposed here.
