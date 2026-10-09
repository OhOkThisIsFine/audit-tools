# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **Two audit tests time out under full-suite load and pass alone (2026-10-08, medium).** On `38bba3cf`, `npm test` failed only `tests/audit/analyzer-run-consent.test.ts` ("late formatting opt-in…", 60 s budget) and `tests/audit/next-step-integrity-reintake.test.ts` ("same-line-count pending source edit…", 120 s budget); `run-vitest-gate.mjs` reported LOAD-ONLY for both, so no suite stamp exists for a clean tree. **Property:** each test's runtime stays within its budget under the full suite, so a clean tree can earn a green stamp.

- **The session-start "commits BEHIND origin/main" warning measures the main checkout, not the session's worktree (2026-10-06, medium).** `.claude/hooks/session-start-guards.mjs` runs `git rev-list --count HEAD..<remote>/main` in `ROOT` (`CLAUDE_PROJECT_DIR`), so a session in a linked worktree that is level with main still reads "N commit(s) BEHIND — sync before writing code" (false twice in one lap; `git log HEAD..origin/main` was empty). The same file already reads the payload `cwd` for its worktree checks. **Property:** the warning counts the HEAD of the tree the session works in.

- **The shipped TOML parser carries two high advisories (2026-10-06, high).** `package-lock.json` resolves the production dependency `smol-toml` to 1.6.1, and `npm audit --omit=dev` reports GHSA-7w5x-hrqm-74c2 (malformed-document denial of service, fixed in 1.7.1) and GHSA-r4xh-jqrq-34v2 (quadratic `parse()`, fixed in 1.9.0). `parseTomlSafe` (`src/audit/extractors/graphManifestEdges/toml.ts`) parses every audited repository's Cargo and pyproject manifests with it, synchronously. The source-reviewed fix design is P0 of the [canonical implementation plan](../reviews/audit-tools-canonical-implementation-plan-2026-10-07.md); its patch bytes were never published. **Property:** the lock resolves `smol-toml` >= 1.9.0, `npm audit --omit=dev` reports no advisory for it, and both manifest adapters keep their edges.

- **A step contract lists every pending result path (2026-10-05, medium).** The prompt half is fixed: the wait section is a count, and a carried report follows the step's own task. The step JSON still grows with the run: in the paused 2026-10-05 run each `current-step.json` holds 100–126 KB, almost all `access.write_paths` (470 result paths from the ready-inspection workload). **Property:** a step contract's size is bounded by its own task, not by the run's pending-work count; the write grant covers the bound results without one entry per pending item.

- **Inspection coverage claims are accepted on the host's word (2026-10-05, medium).** A Sonnet batch claimed full coverage of two files it never opened, and the contract checks accepted it; `file_coverage` is checked for line counts only. **Property:** an accepted result's coverage of a file is backed by evidence the tool checks against that file's content, so an unread file cannot pass as covered.

- **Charter packets are sized by accident, not by the charter question (2026-10-05, medium).** The structural and revealed packets held only the two `projectTestAdmission` test files of 1,244 files, while the stated packet was 3.3 MB (215 excerpts) and both stated lanes read only the core documents. **Property:** each charter packet holds a bounded, content-selected sample of the files its question covers, and its size is bounded.

- **A commit gate reports its refusals one class at a time (2026-10-05, medium, friction: tool_should_decide).** `attest-loop-core-review.mjs` refused first on sites-pinned, then on the generated backlog index, and the sites-pinned leg names one file per run; each fix changed the tree, so one loop-core commit needed four full suites. `npm run staged:legs` before the first suite finds both. **Property:** one gate run reports every refusal it would raise for the staged tree.

- **`SchemaVersionMismatchError` tells the operator to delete state it cannot regenerate (2026-10-06, medium).** `src/shared/io/schemaVersion.ts` always says "Delete <artifact> from the artifacts directory to regenerate it", but `throwOnSchemaVersionMismatch` is the path for costly or authored state that is not discarded. **Property:** the message for a non-regenerable artifact names a migration or preservation route, never deletion.

- **`check-backlog-budget --update-baseline` grandfathers new violators (2026-10-06, medium).** `evaluateBacklog` (`scripts/check-backlog-budget.mjs`) adds every over-budget or mechanism-prescribing entry to the next baseline, and `planBaselineUpdate` carries those lists verbatim, so a new violator enters the amnesty list with no `--raise-ceiling`. **Property:** `--update-baseline` can only remove keys from the entry lists.

- **The attestation gate judges an edit to itself with the edited copy (2026-10-04, medium).** `check:loop-core-attestations` runs in `verify:checks` from the pull request's own tree, so its membership predicate (`.claude/hooks/loop-core-patterns.mjs`) and the checker are the versions under judgment. Since 2026-10-04 the gate's four files are loop-core and admins are bound, so a narrowing that keeps the gate files listed is caught. Not caught: one change that removes the gate files from the list together with their ledger entries, that makes the checker pass, or that unwires it (`package.json` `verify:checks`, `.github/workflows/ci.yml`, `scripts/shared/loopCoreClosureData.mjs`) — each is judged by the copy it edits. **Property:** a required check judges a change to the gate with a copy the change cannot edit.

- **A loop-core commit needs a second full suite before it can land (2026-10-04, medium, friction: tool_should_decide).** `attest-loop-core-review.mjs` binds the suite stamp to `git write-tree` before it stages its own ledger, but `scripts/land.mjs` and `.claude/hooks/push-gate.mjs` look the stamp up by `<sha>^{tree}`, which carries that ledger. So the stamp that vouched for the attested tree never matches the commit, and each loop-core landing re-runs the whole suite on identical source. **Property:** a stamp that covers the attested tree also covers the commit that adds only the attestation ledger to it.

- **The constitutional-doc commit gate refuses a diff confined to a generated region (2026-10-04, low, friction: tool_should_decide).** `spec/audit/dependency-map.md` holds `BEGIN/END GENERATED spec-mirror` tables that `scripts/shared/generate-spec-mirrors.mjs` owns and `check:spec-mirrors` reconciles; a dependency-map change regenerates a row, and the commit gate then demands an owner-decision override for prose nobody wrote. **Property:** the gate judges only the hand-written part of a constitutional doc; a generated region is judged by its generator's check.

- **A code comment that states a workflow SHAPE or a prose ENUMERATION is checked by nothing
  (2026-08-31, medium, friction: tool_should_decide).** Since 2026-10-04 `check:comment-code-citations`
  resolves every backticked path and symbol in a source comment; its guard-reach row lists what it
  cannot reach. A shape or an enumeration names no single identifier, and a name the same file's code
  spells is not looked up (the 2026-08-31 `continuityScore` header). **Property:** a comment that
  states a workflow shape or an enumeration the code owns is reconciled against it mechanically, or it
  does not state one.

- **The TASK draw's coherence eligibility is still disjunctive and has never been measured for
  collapse (2026-08-19, medium).** The findings draw moved to `shared_file AND same_lens`;
  `TASK_DRAW_COHERENCE_POLICY` keeps `weighted_score_threshold` deliberately, because no measurement
  of `buildTaskCoherencePartition`'s components on a real graph exists. **Property:** the task draw's
  eligibility is either measured and shown not to collapse, or aligned with the findings draw's — it
  is not left disjunctive on the grounds that nobody looked.

- **Selective-deepening convergence — live validation env-bound.** The pending-task partition and
  prompt-bound audit ingestion now single-source the identity of every deepening task
  (`src/audit/orchestrator/pendingTasks.ts`,
  `src/audit/cli/dispatch/hostHandoff.ts#ingestAuditHostResults`). Missing or mismatched host results
  remain pending rather than being rebound heuristically. **Still open:** confirmation on a real run
  that every `deepening:*` task converges in bounded rounds and the audit reaches synthesis without
  `force-synthesis`.
