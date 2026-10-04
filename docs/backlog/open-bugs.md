# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **A loop-core change can reach `main` without an attestation (2026-10-01, medium).** `check:loop-core-attestations` judges every tree against the tracked ledger `.claude/loop-core-attestations.json` inside the `checks` job of `ci.yml`, which branch protection on `main` requires (strict). Two gaps remain. The gate's own files — `src/shared/loopCorePaths.ts`, `.claude/hooks/loop-core-patterns.mjs`, `scripts/check-loop-core-attestations.mjs` and `scripts/shared/loopCoreAttestationLedger.mjs` — are not loop-core, so an edit that narrows the pattern list or weakens the check lands with no attestation (the owner chose to leave this open). And protection does not bind admins (`enforce_admins` is off), so an admin's direct push bypasses the required check and is judged only after it lands. **Property:** no landing path puts unattested loop-core content on `main`, and a change to what the gate attests is itself attested.
- **The session-start worktree reaper sees only agent-dispatch worker sessions that are running (2026-10-02, medium, friction: tool_should_decide).** Medium because each miss deletes a live agent's directory. `.claude/hooks/session-start-guards.mjs` keeps a landed, clean, idle tree only when git shows work or `GET /session/status` on the agent-dispatch worker reports a non-idle session in it (12ba46d0). Two gaps remain, covered only by the idle floor `WORKTREE_IDLE_MS` (24 h, an owner decision of 2026-10-02 that accepts the risk past it). A worker session that is idle between turns (a job waiting for its orchestrator's next prompt) is not protected: the only record of it is the bridge job store, which keeps stale `running` records. A Codex, AGY or Claude session working in another linked worktree is not seen at all. **Property:** the reaper removes a tree only on a positive answer that no agent of any kind has it open or will resume in it.








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




- **Loop-core discovery retains a mixed-consumer limit.** Declared exclusions are checked, but modules shared between core and non-core consumers are not automatically classified as core solely from that mixed import graph. Keep the registry’s stated scope; require evidence before changing the closure rule.



- **Divergent attestation preflight can abstain.** A staged/worktree mismatch or unpredictable external state can prevent a verdict. Structured abstention preserves the safety boundary; it does not certify the tree or predict unavailable state.





- **Derived staleness sets retain their accessor contract.** Consumers must read the current derived sets through the supported accessor rather than retaining an obsolete view. Third-state and affinity regressions are covered; the accessor’s lifetime remains intentional.





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


- **External release and review lanes retain environment-dependent limits.** In-flight release waiting is implemented. A historical lane timeout is not proof of current availability, quota or capability; inspect the current lane result and preserve unavailable coverage explicitly.


- **Machine-wide green queries and external lane behavior remain externally owned.** Version-only suite-stamp preservation is covered by real tree-identity tests. Machine-side query routing and review-lane capability require their own current evidence; repository tests cannot certify them.







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
