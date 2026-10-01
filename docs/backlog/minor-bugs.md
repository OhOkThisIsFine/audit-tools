# Minor open bugs (low severity)

> The LOW-severity tail of [`open-bugs.md`](open-bugs.md), split out 2026-08-28 when that file
> reached its 120,000-byte ceiling and every new entry had to be paid for by condensing another.
>
> Same rules, same lifecycle, same sweeps — this is a size split, not a lower standard. An entry
> here is still a fixable defect that is fixed in tooling and DELETED once it ships. Severity is
> the only thing that decides which file an entry lives in, so re-tagging one moves it.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **The barrel-spy recognizer misses a relative barrel import (2026-10-01, low).** #12 deleted trap T44, but `scanBarrelSpies` matches only the `audit-tools/shared` specifier; a relative namespace import of `src/shared/index.ts` is the same barrel and returns `[]`. **Property:** every spelling of the barrel is recognized, or the uncovered half is stated in [`durable-traps.md`](durable-traps.md).
- **Charter blind-lane results carry no inputs declaration, and the handoff names the wrong step (2026-10-01, low).** Since #14 a charter step also carries a scoped-inspection workload; only a prompt sentence keeps blind readers apart from it. `ensureSemanticReviewRunUnlocked` always writes the semantic-review pause handoff, also when a charter step is current. **Property:** a blind-lane result carries a validated inputs declaration, and the handoff names the emitted step.
- **`CLAUDE.md` drifted from #14 (2026-10-01, low).** It does not say host results are now ingested before the engine runs (`ingestAvailableInspectionResults`), and its remediate state diagram puts `waiting_for_clarification` beside planning, though only implementing and triage reach it. **Property:** `CLAUDE.md` describes where ingestion runs and the reachable state edges.
- **The question-philosophy gate challenged the first lap-approval question (2026-10-01, low).** In a lap opened in an app-made worktree, the first `AskUserQuestion` with header `Lap plan` was refused by `.claude/hooks/question-philosophy-gate.mjs`, whose header exempts exactly that question. The cause is not established; the exemption keys on the lap record's mtime against the session's `registered_at`. **Property:** the first lap-approval question of a lap this session opened always passes.
- **A memory note can red an unrelated commit (2026-10-01, low).** #14 deleted a remediate test file cited by a note in the local memory store that a cloud agent cannot see; the next local commit touching docs was refused by `check:memory-citations` until the note was fixed. **Property:** a commit gate refuses only on what the commit can change, or names the external store as the cause and the fix.
- **`answer.mjs --done` leaves the nightly inbox stale (2026-10-01, low, friction: tool_should_decide).** Marking a settled answer done changes `.claude/nightly-decisions.json`, but `docs/nightly-inbox.md` is not re-rendered, so the commit gate refuses until `node scripts/nightly/render-inbox.mjs` runs by hand. **Property:** every ledger write re-renders the inbox, as `writeOpenItems` already does.
- **Empty repo-root files named backtick and node.id appeared during vitest/build runs, producer
  unlocated (2026-08-29, low, friction: tool_should_decide).** Both zero bytes, timestamped during
  targeted vitest invocations in a live session, deleted by hand; the suite's added-root-entry
  teardown attributed nothing. The redirect-artifact CLASS is a known durable trap — what is new
  is an apparent in-repo producer during test/build spawns. A lead, not a verdict: watch for
  recurrence before hunting.












- **CP-NODE-10 residuals (2026-08-19, low, one entry):** (1) the staleness third-state (`partial`)
  check exempts the 9 map-declared leaves — including `audit-findings.json` — so a truncated leaf
  body is caught only via dependents (choice-vs-forced split documented at
  `classifyArtifactPresence`); (2) `StaleArtifactSet`'s `instanceof` discriminator is dropped by
  `Set.prototype.union`/`structuredClone` (no caller does either today); (3)
  `computeArtifactMetadata`'s producer-side affinity hash is unguarded — a malformed affinity body
  dies loudly at restamp (pre-existing, loud, not a livelock).







- **DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low,
  accepted).** The pair SHIPPED; its mechanism record is the single home —
  [`intent-gate-charter-slice-design-2026-07-23.md`](../reviews/intent-gate-charter-slice-design-2026-07-23.md).
  Accepted residuals:
  (a) over-stale: `charter_clarification` / `systemic_challenge` keep WHOLE-ARTIFACT
  `repo_manifest` edges (`dependencyMap.ts`; `DEPENDENCY_SLICE_PROJECTIONS` registers
  `charter_register.json` alone) — a member slice was REFUTED for challenge at HEAD (it consumes the
  total file count and grounds against the complete path set) and clarification's consumption is
  unverified; they still re-fire on unrelated manifest churn (cheap steps). Slicing them needs a
  verified consumption trace first. (b) under-stale, and NARROWER than the first draft of this entry
  claimed: `charterReadFileSlice` compares content for consensus members ∪ every `isDocIntentFile`
  path (`doc_only` status **OR** `.md/.markdown/.adoc/.rst/.txt` — single-sourced at
  `buildStructureDecomposition.ts` so it can never be narrower than the decomposition's own doc
  universe; pinned by `tests/audit/dependency-slices.test.ts`), PLUS the complete sorted path list,
  so every add / delete / rename fires regardless of classification. What stays outside is a
  content-only edit to a file that is neither a consensus member nor doc-extensioned nor `doc_only`
  — e.g. spec prose living inside a `.ts` the Stated pass reads. Widen `charterReadFileSlice` if a
  live run shows it. (c) over-cost: a revert pair (intent A→B judged, then B→A) re-pays one judge
  round — verdicts are materialized into the baseline (`intentEquivalenceExecutor.ts`), never cached
  per-pair.

- **A spec row's category prefix is load-bearing enough to manufacture work — and one was false
  (2026-07-28, low, RESOLVED; the open half is the class).** `spec/audit/artifact-contract.md` gave a
  TRANSIENT host submission (`intent-equivalence-verdict.json`) the same `Durable host input:` prefix as <!-- doc-citation-exempt: transient host submission, written and deleted at runtime -->
  a registered staleness-DAG leaf, so nightly `docs-3` correctly inferred "register it for consistency"
  and collided with DD-9's deliberate no-verdict-pair-cache retirement. Fixed by relabelling the row and
  making the durable row state its registry+DAG membership explicitly; endpoint traces in
  `docs/reviews/intent-equivalence-verdict-endpoint-trace-2026-07-28.md`.
  **Open property (the class, not this instance):** a category prefix in a normative table is read as
  a contract, so two files sharing one must share its lifecycle. Nothing enforces that. Worth a check
  only if a second instance appears — one occurrence is not yet a pattern.

- **⬇ Live-run watch (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25):
  completion cleanup removes the friction dir before the session stop-gate's close-out walk runs
  against it.** Ordering property: the close-out walk is part of run completion — cleanup preserves
  (or the close step completes) the friction record before archiving. Record:
  [`re-dogfood-friction-2026-07-22.md`](../reviews/re-dogfood-friction-2026-07-22.md) #13.
  ⚠ **Three findings from the reverted attempt — a naive "exempt friction/ from the rm" does NOT work
  and introduces a regression.** (1) The audit half's completion cleanup is `promoteFinalAuditReport`
  (`src/audit/io/artifacts.ts`, called only from `nextStepHelpers.ts`), NOT
  `cleanupStaleArtifactsDir` — the latter runs at the START of
  the next advance, so patching it changes nothing at completion. (2) The remediate half's stop-gate is
  MARKER-gated: `.claude/hooks/friction-stop-gate.mjs` requires a recent `state.json` before it reads
  `.audit-tools/audit/friction/` at all, and a fully-green close deletes `state.json` — so preserving the record alone
  still leaves the gate skipping the area. (3) Preserving `.audit-tools/audit/friction/` across cleanups REGRESSES the
  audit side, where the run id is the hardcoded literal `"run"` (`nextStepHelpers.ts`,
  `executorRunners.ts`, `operatorHandoff.ts`): every run shares one `friction/run.json`, so a
  prior run's complete record permanently satisfies both the blocking close-out and the hook's
  `anyComplete` check. A real fix must address the run-id collision first.

- **LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS
  (2026-07-21, low).** This run's challenge arrived as "round 10" with 11 prior improvements from
  earlier sessions' artifacts. Verify intended (cross-run loop state vs per-run reset). Record:
  [`re-dogfood-2026-07-21.md`](../reviews/re-dogfood-2026-07-21.md).

- **A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).** After the design-review passes, the drain re-extracting 11 stale artifacts (repo_manifest/graph over 1250 components / 8466 edges, invalidated by a docs commit) exceeded a 2-minute command timeout with no heartbeat — forcing a blind retry at a longer timeout to see if it was wedged or working. Property to hold: a long deterministic drain should emit a progress/phase heartbeat so a caller can distinguish "working" from "wedged" without a retry. Minor; the retry succeeded.

- **Auditor severity calibration: 0 of 9 self-audit criticals survived mechanism verification
  (2026-08-06, lead, low).** 3 refuted / 6 downgraded — record in
  [`reviews/dogfood-run-2026-08-06.md`](../reviews/dogfood-run-2026-08-06.md). Open question:
  should synthesis demand mechanism-grounded (not flow-existence) evidence for `critical`?
