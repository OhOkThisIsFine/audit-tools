# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **The push gate lets a source-only `HEAD` refspec push `main` (2026-10-01, medium).** On `main`, `git push origin HEAD`, `git push origin @` and `git push --set-upstream origin HEAD` exit 0 through `.claude/hooks/push-gate.mjs`; `origin main`, `HEAD:main` and a bare `git push` are refused. The #12 rewrite resolves HEAD's branch only when no ref is named. **Property:** a source-only refspec resolves to its same-named branch before the protected-branch check. Red test: on `main`, `git push origin HEAD` → exit 2. Evidence: [`chatgpt-work-evaluation-2026-10-01.md`](../reviews/chatgpt-work-evaluation-2026-10-01.md).
- **Architecture-discovery tasks bypass the staleness DAG (2026-10-01, medium).** Planning writes architecture-discovery tasks into `audit_tasks.json` from `design_assessment`, `charter_register`, `systemic_challenge`, `charter_clarification` and `audit_results`, but `spec/audit/dependency-map.md` declares none of them as its dependencies; freshness rests on the side comparator `architectureDiscoveryWorkChanged`. Precedent for the right shape: `requeue_tasks.json` declares `audit_results.jsonl`. **Property:** every input a stored task is derived from is a declared dependency of the artifact that holds it. Red test: change `design_assessment` → `computeStaleArtifacts` marks `audit_tasks.json` stale.
- **A loop-core change can reach `main` without an attestation (2026-10-01, medium).** The attestation is enforced only by the per-clone `.githooks`. A cloud-agent branch commit and a GitHub squash merge both skip them, `main` has no required check, and CI runs no attestation step — #14 landed this way. Also `src/audit/cli/nextStepCommand.ts` and `src/audit/cli/semanticReviewStep.ts`, which compose the workload, are outside `LOOP_CORE_PATTERNS`. **Property:** a loop-core change that lands on `main` is attested at a boundary every landing path crosses, and workload composition counts as loop-core.
- **Remediate plan review: the round cap counts the plan's whole life (2026-10-01, medium).** The 8-round cap shared by critique and judge never resets, also not at approval, so a later `needs_repair` on an approved plan blocks at once. #14 removed stall detection and any owner disposition of a judge-accepted counterexample; judge approval, `residual_risk` decisions and `cancel` still exit. The value 8 has no measurement. **Property:** the bound applies per review cycle or detects a stall, and an operator disposition of a judge-accepted counterexample is recordable.
- **A clarification that re-adds an in-scope file wedges the plan (2026-10-01, medium).** `applyClarificationScopeAdditions` re-sorts `allowed_files`; `executionPlanRevision` hashes author order, so the revision changes and `assertApprovedRuntimePlan` throws `plan_repair_required` at the next prepare. **Property:** a clarification that adds no new path leaves the plan revision identical. Red test: approved `["b.ts","a.ts"]` plus clarified `["a.ts"]` → the authority check passes.
- **Audit prompts still say "subagent" and the loader still talks to audit-tools developers (2026-10-01, medium; re-opens O49 and O03, closed by #12 with the defect present).** About 15 audit-side sites, including `DISPATCH_PROMPT_HANDOFF_NOTE` in `src/shared/prompts.ts`, name a mechanism instead of the independence property, and only a remediate test asserts absence. `skills/audit-code/audit-code.prompt.md` still tells every third-party audit how to develop audit-tools and keeps "read the JSON only far enough". **Property:** one shared independence wording with no mechanism noun in both drivers, and no developer-only line in the shipped loader. Red test: both drivers' prompts `not.toMatch(/sub-?agent/i)`.
- **`dispatch/lens-definitions.json` ships with no reader (2026-10-01, medium).** Nothing in `src/` reads it since `buildTaskSections` was removed in `467b1e8f`, so its worker lens guidance is never delivered; only presence checks name it (the packaged smoke, `package.json` `files`, a guard-reach row). It is a third home for lens prose beside `LENS_REGISTRY` and `LENS_DESCRIPTIONS`, and knip does not scan JSON. **Property:** lens guidance has one source and reaches the packet prompt, or the asset and its rows are deleted.
- **The nightly helper does not own a worktree for a repository-reading lane (2026-10-01, medium).** Settled answer `f78305ac08246ae5` (2026-09-24): the dispatch helper creates and tears down its own throwaway worktree, and `docs/nightly-routine.md` states only that guarantee. Not landed: `scripts/shared/mcp-dispatch-lane.mjs` runs in `opts.cwd`. **Property:** a repository-reading lane always runs in a helper-owned worktree that is removed afterwards. Mark the ledger with `answer.mjs --done` when it ships.
- **A settled nightly answer overtaken by a later decision has no stated handling, so the run decides alone (2026-09-23, medium, friction: ambiguous_direction).** `docs/nightly-routine.md` says a recorded `subject_key` is settled, is never re-raised, and that a run executes the unambiguous work its answer implies. It says nothing about an answer whose text names something a LATER owner decision retired. Subject `1fb2934333c59d31`, settled 2026-09-17, ends "Lane choice stays with llm-relay"; llm-relay was retired 2026-09-22. The 2026-09-23 run implemented the answer's substance and dropped that clause on its own judgment — the right call, but host discretion standing in for a contract, which is the thing this repository bans. Re-asking is equally wrong: the subject is settled and the rule that keeps a settled subject settled is load-bearing. **Property:** the routine states what a run does when a settled answer conflicts with a later decision — it executes the compatible remainder, records the dropped clause and the decision that overtook it in `applied`, and never silently reinstates the retired thing nor re-raises the settled subject. <!-- retired-infrastructure-exempt: llm-relay — historical defect; replaced by agent-dispatch -->








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



- **Self-audit dogfood loop: fixing the tool mid-run invalidates the run (2026-07-16,
  ambiguous-direction, low-medium).** The defect was found BY the run, and committing its fix changed
  the audited tree → staleness correctly marked the planning chain stale and restarted from
  `charter_extraction`. Semantics are right (the dependency DAG is truth); the open sliver is that an
  active run should announce which upstream change invalidated it instead of silently re-planning.
  **SPEC — keep the cascade, ANNOUNCE it. Do not narrow staleness to make dogfooding cheaper.** The
  regression to first-planning-step is correct: the audited tree changed, so the planning derived from it
  is genuinely invalid, and the dependency graph is the source of truth. Any mechanism that spares a
  self-audit run from its own cascade would be special-casing the tool's convenience against the
  correctness rule the whole design rests on.
  What is actually wrong is that a large, expensive, correct action happens SILENTLY and looks like
  malfunction. The run should state that it was invalidated, by which upstream artifacts, and what it is
  therefore re-deriving — one message, at the moment it happens.
  **Property to hold:** an expensive automatic recovery explains itself at the moment it triggers. A user
  who cannot tell a correct cascade from a wedge will eventually defeat the cascade.




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
