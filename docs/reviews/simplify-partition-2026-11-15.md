# Simplify sweep — codebase partition (2026-11-15)

<!-- review-routing: backlog-forward -->

A `/simplify` pass (reuse, simplification, efficiency, altitude — quality only, not bugs) over the
whole codebase, one part per chat. Base: `494d10df` (v0.55.20).

## Rules

- **Disjoint by construction.** Every tracked code file outside `tests/` and `.audit-tools/` belongs
  to exactly one part: the parts are tested in the order below and the first match wins. Verified
  with 0 unassigned files at the base commit.
- **Review scope** is the part's non-test source. A fix may change a test or a caller in another
  part only when the fix needs it; it never starts a cleanup there.
- **Out of scope:** `tests/**` as a review target, `.audit-tools/nightly/proposals/**` (unrun
  drafts), and non-code files (docs, schemas, skills, examples, spec, JSON config).
- Each chat works in its own worktree and lands through the normal gate. Its landing commit sets
  the row's Status to `landed` (a commit cannot name its own hash: `git log -L` on the row finds
  it). Parts land one at a time; a later part rebases onto the earlier landings.
- Each landing adds its leads for later parts to *Leads and skips* below, and its skips (what it
  chose not to do, why, and what would unblock it) to
  [`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md). A later chat
  reads the leads for its own part first.

## Parts

Lines are whole-file line counts at the base. "Churn" is added + deleted non-test lines over the
35 commits `ef848183..494d10df` (v0.55.17 – v0.55.20): newer code has more cleanup potential.

| Part | Rule (first match wins) | Files | Lines | Churn | Status |
| --- | --- | ---: | ---: | ---: | --- |
| P01 shared contracts | `src/shared/{types,validation,submission,intent,findings,steps,engine,mcp,reporting,parsing,reReview}/**` and the top-level files `src/shared/*` | 87 | 17,715 | 175 | landed |
| P02 shared infrastructure | the rest of `src/shared/**` (`analyzers`, `tooling`, `io`, `decompose`, `friction`, `graph`, `observability`, `measurement`) | 58 | 15,569 | 66 | landed |
| P03 audit orchestrator core | `src/audit/orchestrator/**` except the P04 names | 55 | 12,438 | 47 | landed |
| P04 audit orchestrator review and charter | `src/audit/orchestrator/` files that start with `designReview`, `charter`, `reviewPacket`, `intent`, `systemicChallenge`, `taskAffinityGraph`, `dependencySlices`, plus `selectiveDeepening/**` | 34 | 8,113 | 8 | open |
| P05 audit cli | `src/audit/cli/**` | 50 | 16,203 | 594 | open |
| P06 audit extractors | `src/audit/extractors/**` | 51 | 12,039 | 29 | open |
| P07 audit other | the rest of `src/audit/**` (`reporting`, `io`, `validation`, `types`, `systemic`, `contracts`, `decompose`, `clarification`, `supervisor`, top-level files) | 55 | 12,499 | 160 | open |
| P08 remediate steps | `src/remediate/steps/**` | 21 | 10,858 | 527 | open |
| P09 remediate other | the rest of `src/remediate/**` | 40 | 11,197 | 66 | open |
| P10 scripts shared | `scripts/shared/**` | 69 | 14,406 | 269 | open |
| P11 scripts other | the rest of `scripts/**` | 63 | 18,357 | 82 | open |
| P12 wrapper, hooks, entries, root config | `wrapper/**`, `.claude/hooks/**`, `.githooks/**`, `audit-code.mjs`, `remediate-code.mjs`, `eslint.config.js`, `vitest.config.ts`, `.dependency-cruiser.cjs` | 34 | 10,747 | 113 | open |

## Leads and skips

### From P01

Cross-part touches that P01 made because its fix needed them: `src/audit/reporting/workBlocks.ts`
(P07) now takes its owned files, role and highest severity from `deriveWorkBlockFacts`;
`tests/audit/continuity-score.test.ts` lost the tests of the deleted continuity scorer module.

Leads for later parts (not fixed, not verified as defects):

- **P04:** `BuildReviewPacketOptions.continuityScores` in `reviewPackets.ts` and the rest parameter
  of `orderReviewPackets` have no producer now that the continuity scorer is deleted. Two tests
  assert only that the scores cannot reorder packets.
- **P07:** the continuity scorer was the only reader found for `access_memory.json`. Check whether
  the artifact is now written but never read.
- **P09:** in `closeVerifyAnalyzerLeads.ts`, the spread of `persistedAnalyzerPolicy.analyzer_consent`
  is always undefined, because `loadAnalyzerPolicy` strips the field. The `overrides` half is live.
- **Any part:** `countBy` builds its counts on a plain `{}`, so a key such as `constructor` reads an
  inherited value. P01 kept the `Map` counters for custom lens names for that reason.

P01 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each.

### From P02

Cross-part touches: `src/shared/index.ts` lost the barrel line of the deleted
`graph/directedCycles.ts`. That module had no consumer after commit 3f73d24f.

Leads for later parts (not fixed, not verified as defects):

- **P05, P09:** about ten analyzer parsers repeat one "parse JSON, degrade to `[]`" prologue. A
  shared `parseJsonPayload` needs each parser's degrade report kept, so it is a design change.
- **P05, P09:** three callers supervise an owned process with the same term-then-kill sequence. One
  `superviseOwnedProcess` helper would serve them, but the timing is lock-adjacent.
- **Any part:** `package.json` is read by more than one reader in `tooling/`. A single reader must
  keep the array-valued edge in `repoConventions.ts`.

P02 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each.

### From P03

Cross-part touches: `selectiveDeepening/shared.ts` (P04) lost its byte-identical `priorityRank`;
`selectiveDeepening/index.ts` and `lensVerification.ts` (P04) now import it from
`auditTaskUtils.ts`.

A follow-up commit deleted `log_entries`, `LogEntry`, `step_duration_ms` and `degraded` from
`executorResult.ts`: no executor set them and nothing in `src/` read them, and their doc comments
told machine consumers to read them. The two type-only tests in
`tests/audit/observability-signals.test.ts` went with them. Settled by the philosophy brief
("delete legacy rather than carry it"); a dead field on a contract is not a test seam.

Leads for later parts (not fixed, not verified as defects):

- **P04:** `IMPORTANT_LENS_VERIFICATION_LENSES` in `selectiveDeepening/shared.ts` is the same set
  as the now-exported `SENSITIVE_LENSES` in `auditTaskUtils.ts`.
- **P04 (or a cross-part move):** `uniqueSorted` lives in `selectiveDeepening/shared.ts`. Six P03
  sites (`flowPlanning.ts`, `graphEnrichmentExecutor.ts` x2, `structureExecutors.ts`,
  `runtimeValidation.ts`, `autoFixExecutor.ts`) still write `[...new Set(x)].sort(...)` because a
  core file importing a deepening-strategy module is the wrong layer. Moving `uniqueSorted` to
  `src/shared` would let all of them use it.
- **P05:** the full fold re-derives a state the engine just derived, at least twice per drain
  step (`decideNextStep` in `runSingleAdvanceStep`, and the post-executor `{...bundle,
  audit_state}` that defeats the engine's WeakMap). Threading the derive cache through
  `AdvanceAuditOptions` crosses into `cli/nextStepHelpers.ts` and needs a clone before caching.
- **P05/P07:** `HostInputPauseInputs` flattens `externalAcquisition.*` into renamed fields that two
  callers map back across; a `Pick<AdvanceAuditOptions, ...>` would remove both mappings.
- **Shared:** `chunkByTaskBudget` → `src/shared/chunkByBudget.ts` re-reduces the growing chunk for
  every item (O(n^2) per block).

P03 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each.

P03 coverage gap: the efficiency reviewer did not read `scope.ts`, `structureExecutors.ts`,
`syntaxResolutionExecutor.ts`, `graphEnrichmentExecutor.ts`, `autoFixExecutor.ts`,
`unitBuilder.ts`, `runtimeCommand.ts`, `coverageElementBaseline.ts`, `runtimeValidation.ts`,
`flowPlanning.ts`, `edgeReasoning.ts`, `synthesisExecutors.ts`, `executors.ts` and
`localCommands.ts` line by line. The other three angles covered them.
