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

- **A stopped `npm test` leaves its vitest tree alive on Windows (2026-11-16, low).** The host
  stopped a background `npm test`; `run-vitest-gate.mjs` (which runs vitest through `spawnSync`)
  and its vitest workers kept running, because Windows does not end child processes with their
  parent. The next `npm run build` then refused (`guard-no-suite-running.mjs`: "1 vitest run(s) …
  in flight") until `taskkill /PID <gate pid> /T /F`. **Property:** when the process that started a
  suite ends, the suite's process tree ends with it.

- **Two git-spawning tests time out under full-suite load on this machine (2026-11-16, low).**
  `runGateCase` (`tests/shared/vitest-gate-false-red.test.ts`) gives its child gate a 10 s
  `spawnSync` deadline; the submodule case of `tests/audit/scope-index-staleness.test.ts` hits the
  30 s test timeout. Two full runs passed, then four failed in a row (4–9 cases, file time 30 s →
  400 s); both files pass alone, and clean `1fae5792` fails the same way, so the cause is machine
  state, not a tree. `%TEMP%` held 1.48M directories; deleting the 1.43M older than 7 days restored
  a green run (the gate file fell from 400 s to 24 s). Each run still adds ~670 under each
  `audit-tools-test-{state,analyzer-cache,binary-cache}` prefix and never removes them.
  **Property:** a test's child deadline comes from a measurement under full-suite load, and a test
  removes the temp directories it creates.

- **File-lock checks are cooperative, not an atomic write fence (2026-10-06, low).** Heartbeat loss now latches, and the shared locked JSON stores recheck ownership before writing. Other state-changing lock users may still lack a check, and a check plus rename is not one atomic operation. P3 of the canonical implementation plan is a separate protocol decision. **Property:** evaluate a remaining caller only when an actual stale-write path warrants work; do not treat the heartbeat or a pre-write check as an atomic guarantee.

- **Test-command discovery lacks some ecosystem declarations (2026-10-06, low).** `discoverProjectCommands` (`src/shared/tooling/testCommand.ts`); repositories using unsupported build systems such as Gradle or Make still reach the final gate's "Verification command required" pause. **Property:** discovery reads a declared command for any ecosystem with one, without a per-ecosystem fork in planning.

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


