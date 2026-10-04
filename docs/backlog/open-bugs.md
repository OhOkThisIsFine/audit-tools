# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **The attestation gate judges an edit to itself with the edited copy (2026-10-04, medium).** `check:loop-core-attestations` runs in `verify:checks` from the pull request's own tree, so its membership predicate (`.claude/hooks/loop-core-patterns.mjs`) and the checker are the versions under judgment. Since 2026-10-04 the gate's four files are loop-core and admins are bound, so a narrowing that keeps the gate files listed is caught. Not caught: one change that removes the gate files from the list together with their ledger entries, that makes the checker pass, or that unwires it (`package.json` `verify:checks`, `.github/workflows/ci.yml`, `scripts/shared/loopCoreClosureData.mjs`) — each is judged by the copy it edits. **Property:** a required check judges a change to the gate with a copy the change cannot edit.

- **CI orchestration shards time out at 300s with the spawned `audit-code next-step` still alive, on a
  DIFFERENT test each time (2026-09-04, high, friction: tool_should_decide).** Two `audit-code-test-suite` runs on
  `main` the same day failed identically and in different places: `tests/audit/next-step-narrative.test.ts`
  on shard 1/4 (`e197ea2c`) and `tests/audit/audit-code-completion-present.test.ts` on shard 3/4
  (`001d45f1`). Both report `Test timed out in 300000ms`, and shard 1 additionally reports the global-setup
  teardown catching a surviving child: `1 child process spawned by this run is STILL RUNNING: node
  audit-code.mjs next-step`. The full suite is green locally on the same tree (496 files, run three times),
  so the signal is CI-runner-specific and the varying test file says the cause is a shared resource or a
  runner-speed floor, not any one test. The cost is the expensive kind: `ci` goes green while
  `audit-code-test-suite` goes red on the same commit, so "is main green" has two answers and the red one
  is the one everybody learns to skip. **Property:** an orchestration test that spawns the real CLI either
  completes within a bound the slowest supported runner meets, or fails naming what it waited on — a bare
  300s timeout with a live child names nothing.

- **Nothing checks a code comment against the code it describes (2026-08-31, medium, friction:
  tool_should_decide).** Documentation is gated by `check:doc-code-citations`; comments are gated by
  nothing, so a comment that names a symbol, an enumeration or a workflow shape drifts silently and
  is found only when a doc-review lane happens to read the code to check a DOC. **Property:** a
  comment that names a symbol, a workflow shape or an enumeration the code owns is reconciled
  against it mechanically, or it does not state one.

- **The TASK draw's coherence eligibility is still disjunctive and has never been measured for
  collapse (2026-08-19, medium).** The findings draw moved to `shared_file AND same_lens`;
  `TASK_DRAW_COHERENCE_POLICY` keeps `weighted_score_threshold` deliberately, because no measurement
  of `buildTaskCoherencePartition`'s components on a real graph exists. **Property:** the task draw's
  eligibility is either measured and shown not to collapse, or aligned with the findings draw's — it
  is not left disjunctive on the grounds that nobody looked.

- **A comprehensive remaining test-replica sweep is unverified.** Bounded production-path replacements and meaningful mutation checks were completed during the September 30 work. They do not establish that every remaining test replica has been found. Review specific suspected replicas through the actual production interface; preserve independent oracles and useful fixtures.

- **Vitest worker RPC starvation — the false-RED exit is CLOSED at the gate; the >60s blocking
  worker is unlocated (recharacterized 2026-08-07; was "full-suite exits 1 while every test
  passes", 2026-08-06).** The exit-code half is a non-issue through the sanctioned path:
  `npm test`/CI route through `scripts/shared/run-vitest-gate.mjs` (since `605fe61e`), which converts
  exit-1 + 0-failed + the `[vitest-worker]: Timeout calling "onTaskUpdate"` stderr marker into a loud
  PASS — the 2026-08-06 red exits were raw `npx vitest run` invocations that bypass it. What stays open
  is the starvation itself: the worker-side birpc reply timeout is a hard 60s
  (`rpc.-pEldfrD.js` onTimeoutError), so the error means ONE continuous ≥60s sync stretch in some <!-- doc-citation-exempt: vitest worker bundle chunk -->
  worker. `audit-code-completion-*.test.ts` is ruled out as sole cause — a solo run does not reproduce and
  an event-loop stall probe recorded ZERO stalls during a full run in which the error fired. Candidate
  sweep: [`reviews/rpc-starvation-candidates-2026-08-07.md`](../reviews/rpc-starvation-candidates-2026-08-07.md)
  — its one confirmed instance (sync full-CLI `next-step` children in
  `next-step-pipeline-dispatch.test.ts`) was converted to async spawn; gate-script spawns in
  `tests/shared/*-gate.test.ts` are the next leads. **Re-hit 2026-08-31:** the final
  pre-release and released-tree `npm test` runs each recorded 6,119 passed / 0 failed,
  then emitted the same `onTaskUpdate` timeout; `run-vitest-gate.mjs` correctly
  rendered REPORTER-TRANSPORT PASS both times. This satisfies the recurrence trigger:
  instrument the remaining synchronous gate-script spawns next. ⚠ Standing trap from
  the reverted 2026-08-06 attempt: `projects:`
  at the TOP LEVEL of `vitest.config.ts` is silently ignored and voids the whole test config
  (false GREEN); any config split must nest under `test.projects` and prove both exit
  polarities. **Property:** no test worker blocks its event loop ≥60s continuously; until then
  the vitest-gate tolerance is the guard, and raw `npx vitest run` full runs still read red.

- **Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).** Each
  adversarial round spawns FRESH agents that re-grep the same call-site map from scratch (~135k
  subagent tokens per round, much of it identical recon), because continuing a prior reviewer
  preserves its context but forfeits the independence the round exists for.
  **Property to hold:** no review round re-derives a mechanical fact another round already established,
  and no round judges anything it authored — the verified map is a read-only, provenanced input artifact
  each round receives labelled as prior recon it did not author, and cannot write back to (updates go
  through a separate recon step, so it cannot absorb a reviewer's assumptions and then be handed to the
  next round as fact).
  **Already refuted, do not re-propose:** that independence of VERDICT and independence of INPUT are in
  tension — they are not, and the framing is why the obvious fix looked wrong. A round must not judge
  work it authored; being handed a factual map it did not produce does not compromise that, so
  re-deriving from scratch was never carrying independence, only paying for redundant derivation.
  ⚠ Sharing an agent SESSION across rounds is likewise wrong and forfeits exactly what the round is for.

- **Top gate optimization — the suite-side tail is subprocess wall, not isolation overhead (measured
  2026-07-06).** It sits in a few audit integration files, so
  `pool:'threads'` / `isolate:false` will not help — the lever is the sharding already shipped, plus
  possibly splitting the 100s+ files across more shards (verify per-file: many tests spawn/mutate fs, so
  isolation-off risks bleed). Live numbers are in `.audit-tools-profile/*-history.ndjson`, never here.

- **Selective-deepening convergence — live validation env-bound.** The pending-task partition and
  prompt-bound audit ingestion now single-source the identity of every deepening task
  (`src/audit/orchestrator/pendingTasks.ts`,
  `src/audit/cli/dispatch/hostHandoff.ts#ingestAuditHostResults`). Missing or mismatched host results
  remain pending rather than being rebound heuristically. **Still open:** confirmation on a real run
  that every `deepening:*` task converges in bounded rounds and the audit reaches synthesis without
  `force-synthesis`.
