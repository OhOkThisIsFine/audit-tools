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

- **A partial withdrawal reports a complete item as rejected (2026-10-06, low).** The accepted pair can hold several entries for one work item. When `evictInvalidatedEntries` (`src/audit/cli/dispatch/hostHandoff.ts`) withdraws one entry and another still validates, the item stays complete, yet its withdrawal issue makes `recordHostResultOutcomes` record `rejected` as its last state. **Property:** an item's recorded state matches whether an accepted entry for it remains.

- **Conceptual perspective lanes read only the head of the call-site map (2026-10-05, low).** In the dogfood run each perspective lane read the first part of the bound read-only call-site map and nothing made it read further. **Property:** a lane's use of the call-site map does not depend on the lane choosing to read past the head.

- **The lock heartbeat only logs a stolen lock (2026-10-06, low).** `startLockHeartbeat` (`src/shared/io/fileLock.ts`) logs `lock_heartbeat_stolen` and returns, every tick; the interval keeps running and `fn()` is neither aborted nor told. P3 of the [mechanical implementation plan](../reviews/mechanical-implementation-plan-2026-10-07.md) replaces this protocol. **Property:** a holder that loses its lock stops its writes and learns of the loss.

- **`explain-task` takes the first token after the verb as the task id (2026-10-06, low).** `src/audit/cli/explainTaskCommand.ts` falls back to `argv[3]`, so `explain-task --root X T1` asks for task `--root`. **Property:** a flag is never read as the task id.

- **A fractional positive-integer flag becomes 0 (2026-10-06, low).** `normalizePositiveInteger` (`src/audit/cli/args.ts`) passes 0.5 and floors it to 0, so `--timeout 0.5` skips the default and sets a 0 ms timeout. **Property:** a value that floors to 0 is refused or falls back to the default.

- **`status` drops `not_applicable` obligations from its summary (2026-10-06, low).** `obligationStates` (`src/audit/cli/statusCommand.ts`) has no `not_applicable` key, so the counts do not sum to the obligation total. **Property:** every `ObligationStateSchema` value is counted.

- **`loopCoreClosure.mjs` drops directory imports from the importer graph (2026-10-06, low).** `buildImporterGraph` (`scripts/shared/loopCoreClosure.mjs`) maps a directory specifier only to a sibling .ts file, while `resolveSpecifier` in the same file also tries the directory's index.ts. **Property:** both functions resolve a specifier the same way.

- **The vitest shard duration baseline is stale, so duration sharding is off (2026-10-06, low).** `scripts/shared/vitest-shard-duration-baseline.json` lacks 259 tracked test files and lists 257 that no longer exist; `vitest-sequencer.mjs` then falls back to hash sharding for the whole run. **Property:** a test-file add or rename cannot silently disable duration sharding.

- **`bounded-call-single-source.test.ts` matches `advance(` in raw text (2026-10-05, low).** A comment that contains `advance(` trips the test. **Property:** the test matches calls, not comments or strings.

- **A repeated `--reviewed-by` keeps only its last value (2026-10-05, low).** `attest-loop-core-review.mjs` overwrites earlier values, so a two-reviewer attestation records one. **Property:** every given reviewer is recorded, or a repeat is refused.

- **The repo tool-input guard took a plain worktree sub-agent for an audit node (2026-10-05, low).** `.claude/hooks/tool-input-guard.mjs` refused a sub-agent that ran in a lap worktree and was not an audit lane. **Property:** the guard identifies an audit node from run state, not from the session's shape.

- **The stale-main guard reports a sync that already happened (2026-10-05, low).** `session-start-guards.mjs` writes `.claude/hooks/.state/stale-main.json` once at session start; `tool-input-guard.mjs` refuses the first source edit from that marker without counting again, so a session that pulled after start was told "HEAD is 13 commits behind" when HEAD equalled `origin/main`. **Property:** the edit-time refusal recounts `HEAD..<remote>/main` and fires only when it is still positive.

- **Test-command discovery knows only npm, Go and pytest (2026-10-06, low).** `discoverProjectCommands` (`src/shared/tooling/testCommand.ts`); every other ecosystem reaches the final gate's "Verification command required" pause. **Property:** discovery reads a declared command for any ecosystem with one, without a per-ecosystem fork in planning.

- **DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low,
  accepted).** The pair SHIPPED; its mechanism record is the single home —
  [`intent-gate-charter-slice-design-2026-07-23.md`](../reviews/intent-gate-charter-slice-design-2026-07-23.md).
  Accepted residuals (`charter_clarification` is sliced since 2026-10-04, and `systemic_challenge`'s
  whole-manifest edge is exact, not a residual — `dependencySlices.ts` states both):
  (b) under-stale, and NARROWER than the first draft of this entry
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


