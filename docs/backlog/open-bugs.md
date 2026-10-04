# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

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

- **Selective-deepening convergence — live validation env-bound.** The pending-task partition and
  prompt-bound audit ingestion now single-source the identity of every deepening task
  (`src/audit/orchestrator/pendingTasks.ts`,
  `src/audit/cli/dispatch/hostHandoff.ts#ingestAuditHostResults`). Missing or mismatched host results
  remain pending rather than being rebound heuristically. **Still open:** confirmation on a real run
  that every `deepening:*` task converges in bounded rounds and the audit reaches synthesis without
  `force-synthesis`.
