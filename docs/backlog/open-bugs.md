# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **`commitFold`'s applied-entry unlink swallows non-ENOENT, so Windows can re-consume an
  already-applied submission (2026-08-28, medium).** The applied branch runs
  `unlink(staged.stagingPath).catch(() => {})` (`src/audit/cli/foldTransaction.ts`): an EBUSY/EPERM
  (e.g. an AV scan holding the file) leaves the staging file on disk while the `accepted` ledger
  event records. The next fold's `recoverStagedSubmissions` then restores that file to its bound
  path and the fold re-consumes it; only iterative lanes (`systemic_challenge`) are guarded by the
  content-hash register. Pre-existing before the CX-02 resumable-commit fix (`69613c68`); surfaced
  by the 3-lens refute panel over that fix. **Property:** an applied entry either deletes its
  staging file or fails the commit — a swallowed unlink error can never leave a consumed submission
  in a recoverable location.

- **Commits created by `git cherry-pick` / `git merge` / `git rebase` bypass every pre-commit gate
  leg, the loop-core attestation, and the constitutional-doc gate (2026-08-28, medium).** The gate
  is a PreToolUse hook matching `git commit` command text, so any OTHER commit-creating verb lands
  ungated — observed live: a `git cherry-pick` of a loop-core WIP commit onto a branch sailed
  through with no legs run and no attestation demanded. On a branch that is survivable (the gates
  re-run when the work reaches `main` by ordinary commit), but a cherry-pick or merge INTO `main`
  would land loop-core or constitutional content with zero mechanical review. **Property:** the
  gate keys on commits being CREATED (whatever verb creates them), or the uncovered verbs are
  refused on `main`, or the reach registry states the uncovered half as data.

- **The loop-core attest preflight judges the STAGED tree with WORKING-TREE checks, so an unstaged
  edit elsewhere reds an attestation whose commit would be green (2026-08-28, medium, friction:
  false_red).** `attest-loop-core-review.mjs` refuses to bind when `check:guard-reach` fails, but
  that check reads the working tree — observed: an UNSTAGED guard-registry row naming a
  not-yet-tracked test file (both belonging to a LATER commit) refused the attestation of a staged
  set that contained neither, forcing a commit reorder. The refusal text says "the staged tree
  would be rejected", and for that staged tree it was false. **Property:** the preflight evaluates
  the tree the attestation binds to — the staged tree — never the working tree around it.

- **The suite's added-root-entry teardown check is not hermetic against a CONCURRENT session in the
  shared checkout, and it reds a commit whose own tests all passed (2026-08-27, medium, friction:
  false_red).** The pre-commit `test:doc-contract` leg reported 24 of 24 tests passed and then failed
  in `tests/helpers/global-setup.ts` teardown with "This run ADDED 1 entry to the repo root:
  `_scope-probe.mts`". That file was neither written nor read by the staged change — a docs-only
  commit — and it was already GONE from the tree moments later, so a second live session in this same
  checkout created and removed it inside the gate's own test window. The check diffs the root before
  and after the run, so any foreign write during that window is attributed to the run. The existing
  trap note frames this class as self-inflicted (editing the tree during your own gate); this is the
  other source, and it cannot be fixed by the committing session freezing its own edits.
  **Property:** the teardown attributes a root entry to the run only when the run could have created
  it — scope it to the runner's own process tree, or reconcile against a baseline captured under the
  same lock, so a concurrent session's transient file cannot red an unrelated commit.

- **`shell-trap-guard`'s PowerShell here-string rule did not fire on two Bash-tool commits and then
  fired on a third near-identical one (2026-08-27, medium).** Three `git commit -m @'…'@` calls went
  through the Bash tool in one session with the same here-string construct. The first two were NOT
  blocked by the here-string rule and reached the pre-commit gate (which stopped them for unrelated
  reasons); the third was blocked with the here-string message and its `commit -F` remedy. The
  remedy works and is correct. What is unexplained is the inconsistency: a guard that admits a
  mangled-commit-message construct twice and refuses it once is a guard whose reach cannot be relied
  on, and the two admitted commands would have landed a truncated message had the other gates not
  intervened. No mechanism is claimed here — the observation is the finding. **Property:** the rule
  is deterministic over the command text, with a contract test pinning the admitted and refused
  forms, so its reach is a property of the input rather than of the attempt.

- **The rendered decision queue and its tracked snapshot can outlive the ledger that settles them,
  and nothing gates the disagreement (2026-08-27, medium, friction: tool_should_decide).**
  `docs/nightly-inbox.md` and the tracked `.audit-tools/nightly/open-items.json` both still present
  six propositions as open, plus a banner reading "11 answered items not yet marked done", while
  `node scripts/nightly/answer.mjs --list` reports zero open and zero pending. `109d101a` rendered
  the queue; `b91057c5` and `f41d2442` then landed the answers and neither re-rendered either
  artifact. `render-inbox.mjs` has no `--check`, and no gate reconciles the rendered queue or the
  snapshot against the ledger, so the drift is silent and every doc gate stays green. The
  `SessionStart` hook reads the ledger and so surfaced nothing — the damage falls on a human or an
  agent who opens the inbox and works six settled items. **Property:** the rendered queue and its
  snapshot are derived artifacts with a freshness gate, so neither can assert an item is open that
  the ledger records as done.
  **The predicted damage happened the same day, and it is confirmed.** A lap read the six from the
  snapshot and put four to the owner, though all six had been settled and COMPLETED hours earlier
  (`f41d2442`), every edit landed. One of the answers given, if applied, would have REVERTED a
  completed decision — so the cost is not only wasted attention. Nothing stale was applied, and the
  ledger was already right. `start-lap` has been repointed at `answer.mjs --list` as the authority,
  closing the path actually walked; the snapshot's own freshness gate is still the fix.

- **The critique-driven contract repair step renders the judge-repair template (2026-08-22, medium).** The contract-repair step for `finalized_module_contracts` has two triggers, but its rendered prompt is always the judge-repair one: it says 'The adversarial judge rejected the current contract' and lists Required Inputs (`obligation_ledger`, `contract_assessment_report`, `counterexample`, `judge_report`) that do not exist on the critique-driven trigger, whose only inputs are the conceptual design critique and the artifact itself. Hit 2026-08-22 on the first-draw remediation run (`Contract Repair: finalized_module_contracts`); the worker burned turns hunting inputs the tool never bound. **Property:** a repair step names its actual trigger and lists only inputs that exist for that trigger.

- **Remediation intake drops a finding with no `evidence` array, and the audit systemic-challenge lane emits findings without one (2026-08-22, medium).** Intake's no-evidence branch records only a `droppedNoEvidence` disposition in review_filter_dispositions.json and never surfaces the finding; the review gate therefore never showed MNT-c2dc7f9c (high severity, high confidence: the wrapper pair duplicates ~2,400 lines), so an operator could neither confirm nor decline the drop. The audit side's systemic-challenge lane mints findings with no evidence array, so every such finding is unremediatable by construction. **Property:** a finding the intake drops is surfaced at the review gate as a disposition the operator confirms, and a systemic-lane finding carries evidence (or an explicit grounding class the intake admits) so the pipeline can remediate it.

- **The contract-pipeline phase cut unions the drafted `neighbor_needs` into the finalized contracts' dependency graph, so symmetric coordination prose overrides every declared token edge (2026-08-22, high).** Finalization preserves the draft's `neighbor_needs` verbatim (`deriveFinalizedModuleContracts`, src/remediate/contractPipeline/derive.ts) and `phaseCutModulesFromContracts` (src/remediate/contractPipeline/phaseCut.ts) builds `depends_on` as the UNION of those mentions with the `artifact:` producer/consumer token edges — but `neighbor_needs` are symmetric coordination notes (A names B and B names A), so the union graph has cycles, and the tier derivation resolves a back-edge to "no added depth" (fail-toward-later) instead of failing. On the 2026-08-22 first-draw run this placed token consumers at EARLIER phases than their producers (5(P7) -> 148(P1), 1274(P10) -> 278(P8), 2(P11) -> 1296(P4), every seam-prep shard after its consumers), reported `has_cycle: true`, and the conceptual-design critique could not converge (cdc-01/cdc-02 re-raised twice; cdc-07 diagnosed the scheduler reading a prose-shaped graph). Removing `neighbor_needs` from the finalized contracts (moving the content into `seam_adjustments` as non-edge notes) produced an acyclic cut honoring every token edge and the critique converged — despite the phaseCut comment stating finalized contracts drop the field. **Property:** implementation ordering derives from the `artifact:` producer/consumer graph alone; drafted `neighbor_needs` never enter the finalized contracts' dependency graph (tokens win, or finalization drops the field), and a cycle in the declared graph is a validation error, not a silently dropped edge.

- **The contract-pipeline adversarial judge can demand what the finalized-contract schema cannot express, and its convergence guard then blocks the run on the host (2026-08-22, high).** The judge's `repair_directive.instruction` is free text acted on by a `contract_repair` of `finalized_module_contracts`, but finalization forbids dropping, merging, renaming, or inventing modules (`validateFinalizedContractsMatchDraft`-shaped gate, src/remediate/validation/contractPipelineGates.ts) and the finalized module-contract schema admits only `inputs`/`outputs`/`invariants`/`side_effects`/`validation_boundary`/`failure_modes` plus prose `seam_adjustments` — no machine-readable dependency or per-block write-scope field (src/remediate/validation/contractPipeline.ts). A directive such as "add the owning impl block for a finding the intake dropped" or "promote ordering to a dedicated dependency field; express sole-editorship as structured per-block scope data" (the 2026-08-22 first-draw second verdict, six accepted counterexamples) is therefore unsatisfiable at that stage: the judge re-accepts the same counterexamples, `evaluateJudgeGate` fires its non-convergence escalation (src/remediate/steps/contractPipeline.ts), and the run blocks awaiting an owner resolution the pipeline has no recorded verb for. The same verdict declared token-derived ordering authoritative over approved-findings.json's persisted block edges (a second ordering graph the tool keeps, able to disagree with the contracts') and flagged the four-owner `owned_files` for fileLock.ts that the contracts had already narrowed in prose. **Property:** every demand the judge can accept is expressible in the artifact its repair targets (a structured `depends_on` / write-scope field the scheduler and ingestion read, or the judge is bounded to the schema), an intake-dropped finding is either remediated or explicitly waived by a recorded host decision the judge respects, and one graph (the contracts') is the source of truth for ordering — never two that can disagree.

- **The DAG-derived write scope omits the companion files a fix needs, so the host hand-widens
  `touched_files` (2026-08-23, high, friction: tool_should_decide).** In the first-draw run 8 of 30
  work items stopped with `needs_clarification` asking for exactly this: the test file a "pin X with
  direct tests" node must CREATE, the zod source a generated JSON schema mirrors, the shared module a
  "one core, two draws" extraction needs, the manifest a dependency swap touches. P38 did not cover it
  because the DAG author never listed those outputs. A clarification answer cannot widen scope (the
  resolution only re-opens the item with context), so `state.plan.blocks[].touched_files` was edited
  by hand before each re-mint. **Property:** a node whose obligations are tests / snapshots / generated
  artifacts / new shared modules declares those paths as `output_files` (validator-enforced) or the
  planner derives them; the clarification contract carries an explicit scope delta; the host never
  edits the plan.

- **An empty dispatch frontier THROWS instead of pausing (2026-08-23, high, friction:
  tool_should_decide).** With every dispatchable block resolved and the rest `needs_clarification`
  (or one `blocked` item holding a phase barrier), `next-step` died with "Cannot prepare an empty
  remediation host workload" (`prepareRemediationHostHandoff`) — three times in one run. Recovery
  was hand-setting `state.status` to `waiting_for_clarification` / `waiting_for_triage` so the tool's
  own obligation consumed the resolution. **Property:** an empty frontier with unanswered
  clarifications emits `collect_clarifications`, with blocked dependents emits `collect_triage`, and
  never an exception; a worker's lane-corruption report is a distinct outcome from a genuine block.

- **The Implementation DAG prompt does not state the one-invocation rule for `targeted_commands`
  (2026-08-23, medium, friction: tool_should_decide).** The worker emitted `npm run build && npm run
  check` on 23 nodes; the promotion gate rejected the whole DAG twice (`MAX_DAG_REGENERATION_ATTEMPTS`
  = 2, one more would have blocked the pipeline) for a defect the tool can normalize by splitting on
  `&&`. **Property:** a mechanically-normalizable violation never spends a regeneration attempt — the
  tool splits, or the prompt states the rule and the validator reports a targeted repair.

- **The per-item required tests and the host landing gate do not include the tree-wide guard
  suites or the cheap release gates, and every landing's evidence is Windows-local (2026-08-23,
  medium).** Three remediation landings reddened CI after green per-item runs: a hand-restated
  `.audit-tools` literal caught only by `tests/shared/audit-tools-path-guard.test.ts` (`1e7a4a54`
  fixed it), a case-folding assertion true only on a case-insensitive volume (`011c6ae0`), and an
  intra-`src/shared` import cycle the reviewer graded minor that `check:depgraph` refuses
  (`b5963957`). **Property:** a landing runs the repository's guard suites and the cheap release gates
  (`check:depgraph`, `check:deadcode`, `check:lint`) for the areas it touches, and the host treats
  Linux CI as the real signal per commit.

- **The systemic-challenge lane prompt withholds the banked findings it asks the adversary to beat (2026-08-21, medium).** The prompt states only a COUNT of prior improvements, and `systemicChallengeLoop` computes newness by exact identity over adversary-minted ids. An adversary therefore cannot tell what it must not repeat, and a paraphrase registers as new: round 3 of the 2026-08-21 lap re-emitted round 2's `mapWithConcurrency` item under a fresh id, and the lane raised both halves as findings itself. **Property:** the adversary sees the banked set, and convergence dedups on content rather than on a worker-minted id. Related: the no-ceiling entry — together they are why that lap's loop had to be stopped by a hand-written empty submission.

- **Conceptual-review DEPTH is still modelled as durable when it must be per-run (2026-08-21, owner directive, medium).** The analyzer-consent half of this entry is CLOSED: a grant now binds one run and rides the scoped consent token, only declines persist, and `AnalyzerConsentDecisionSchema` is a one-member enum so a grant has no durable shape. The review-depth half is NOT, and is stated here rather than left implied by a closed sibling: the intent checkpoint reuses a prior `design_review.conceptual_depth`, so the design-review step announces `Reusing intent from <timestamp> ... conceptual depth deep` to an operator who never chose it. Owner, 2026-08-21: **these are per-run choices and should not be persisted — a user may not want the same settings every audit.** **Property:** a review-depth answer binds the run that was asked, and the next run asks again.

- **Promotion and close residuals from the CP-NODE-3/15 reviews (low, one entry).** (a) The
  friction shortfall gate reads `readdir(...).catch(() => [])`, and `archiveFrictionRecords`
  degrades to `[]` on the same failure — a friction directory that exists but cannot be
  LISTED yields zero on both sides and the records are destroyed ungated (errno-blind, the
  CP-NODE-5 class at lower stakes). **Property:** an unlistable directory refuses the delete,
  same as an unarchivable file. (b) With the coarse-backstop terminal branch retired, the
  guarantee that a `needs_clarification` item never survives into `runClosePhase` is owned
  solely by the force-close backstop in `src/remediate/phases/close.ts` — verify it holds
  there and pin it (the retired branch's residual, named in the CP-NODE-15 classification).
  (c) The tool-owned gate spawns its suites SYNCHRONOUSLY (`runTracked` returns a value) while
  `phase.lock` is held, blocking the event loop so the lock heartbeat starves and the hold is
  exposed to stale-lock reclaim — the CP-NODE-5 lock-hazard class; pre-existing, and the
  one-lock restructure lengthens the hold with (non-spawning) pre-intake. **Property:** a held
  lock's heartbeat survives the longest spawn under it.
  (d) The stderr/run-log pairing pin's residual doors, probed: migrating ONE diagnostic to
  `console.log` and deleting its event stays green (the in-family survivors satisfy the
  vacuity guard — widen the family or key on the `[remediate-code]` prefix), and the pin
  silently mandates event-BEFORE-write ordering — a legitimate write-then-log pairing would
  false-red with a misleading message; state the mandate in the comment and failure text.

- **next-step discards a rejected submission's classified issues (2026-08-20, medium,
  friction: tool_should_decide).** `buildImplementDispatchStep` consumes
  `ingestRemediationHostResults` and, when `accepted_count` is 0, falls through to
  prepare + re-emit without surfacing `issues` anywhere — stdout carries only the
  re-emitted step. Hit live: a result rejected `submission_contract_invalid`
  ("commit_evidence must bind the workload baseline to a distinct full commit id" —
  a stale baseline in the host's result file) was invisible, and diagnosing it took
  a direct probe of the ingest function. The ingest half reports-and-continues
  (CP-NODE-6's fix), but its only production caller drops the report on exactly the
  path where nothing advanced. **Property:** every classified ingest issue reaches
  the operator through the surface that triggered the ingest — the step contract,
  stdout, or the step prompt — never only a discarded return value.

- **Host-handoff residuals from the CP-NODE-6 landing (low, one entry).** (a) A malformed
  FRONTIER block at prepare raises a classified aggregate naming the thrower, but still a
  THROW — the bounded-step-instead-of-throw half needs `src/remediate/steps/nextStep.ts`
  plumbing; and the
  free-form path (`normalizeExtractedPlan`) applies no path normalization, so free-form
  `src\a.ts`-style entries hit that refusal persistently. (b) Audit-side
  `withAcceptedResultsLock` covers the accepted-results pair only: ingest reads the
  workload/result-map/task-bindings trio before the lock; prepare writes task-bindings
  entirely outside it. **Property:** one serialization covers the whole binding set.
  (c) The heartbeat/stale-reclaim logger seam has no production adopter. (e)
  `describeRequiredTestFailure` inlines up to 8KB per
  failure into the dispatch prompt — bound the excerpt. (f) `recover-ingest` exits 1
  whenever issues exist even when work WAS accepted — distinguish accepted-with-issues.
  (g) The ENOBUFS/ETIMEDOUT discriminator is win32-verified only (off-platform timeout
  degrades to `spawn_error`, still a refusal); the external-signal branch is posix-only
  and untested; the stale-scan predicate deliberately over-approximates (owned at the
  comment). (h) The prepare-time digest-mismatch throw is unclassified and has no
  sanctioned repair verb: when the state legitimately moves under a live binding (hit
  2026-08-20 — the coarse backstop's item mutation changed prompt-embedded retry
  context, so the re-derived workload digest no longer matched), prepare throws a raw
  "no longer matches" and the only repair is hand-deleting `host_handoff` and
  re-preparing. **Property:** a digest mismatch whose cause is state movement under the
  binding is classified and offers a sanctioned re-bind, not a raw throw.

- **Analyzer-boundary residuals from the CP-NODE-1 review (low).** (a) Six
  `normalizeGenericExternalResults` call sites in the adapter layer pass no repo root,
  so eslint/semgrep/npmAudit/coverageSummary/clippy/rubocop adapters still persist
  absolute paths — `toRepoRelativeAnalyzerPath` is exported and adoption is cheap. (b)
  The sibling analyzer cache under the user's home holds executable npm packages
  created with default modes; the privilege-boundary reasoning now written into the
  binary-acquisition module applies verbatim. (c) Three end-to-end CLI suites drive
  real acquisition with no cache dir pinned, so they write to the real home directory —
  same family as `tests/remediate/postinstall.test.ts` and
  `tests/remediate/postinstall-contract.test.ts` (9 failures at hand-back, both green
  alone: they install an OpenCode global command + permission scopes into home-based
  config). Property: a suite's verdict must not depend on the real user home
  directory's state — single-point fix is pinning the relevant home-rooted paths in
  the vitest setup helper `state-dir-setup.mjs`, never per-suite discretion. (d) The
  bare-string consent token is retired only additively; the scoped grant has no
  production producer until the caller-side node lands.

- **Staleness third-state residuals from the CP-NODE-10 review (low).** The `partial`
  presence classification exempts the nine map-declared leaves, including the
  pipeline's primary machine contract, so a truncated leaf body is caught only through
  its dependents; the stale-artifact set's subclass discriminator is dropped by
  `Set.prototype.union` and `structuredClone` (no caller does either today); and the
  producer-side affinity hash in the artifact-metadata module is unguarded, so a
  malformed body dies loudly at restamp.

- **Emission-scaffold and gate residuals from the CP-NODE-12/13 reviews (low).** The
  loop-core path patterns do not cover `src/shared/steps/`, so the one write-and-log
  site for the host-facing step contract sits outside the attestation gate (a one-line
  pattern addition plus a guard-reach data sync, safety-monotone). The drain's
  re-derivation half is pinned as a unit property of the obligation-state memo, not a
  drain-level one, and nothing keys continuation on the deferred set — the drain-level
  assertion needs a deferred-nonempty fixture that does not exist. The cycle-break
  mediator check requires that SOME member depends on the designated node where the
  prompt says BOTH sides must; the promotion gate reads its cross-gate payloads twice;
  and the stale prompt-schema copy's content pin covers the schema block only.

- **Charter and route residuals from the CP-NODE-18/19 reviews (low).**
  `spec/audit/artifact-contract.md` and a test NAME in the charter-packets suite still
  say the pre-bump charter-register version (one-token fixes; dated review records
  under docs/reviews stay untouched). The stamped-delta type collapse is unfinished —
  the required-on-the-register type and the extraction module's own identity type both
  survive, along with a missing barrel export. A subsystem present with an empty
  members array gets no clarification note although the message would be true, and
  refusals print undifferentiated from routine remediator-routed skips. On the route
  side, a routes module importing a shared router from a sibling has no framework
  marker so its real routes are dropped (documented at the gate, leads-not-verdicts),
  and route registration inside `.vue`/`.svelte`/`.astro` script blocks is now skipped
  by the source-extension gate.

- **Drift-guard residuals from the CP-NODE-25 review (low).** The schema guard's
  anti-inert floor is a bare greater-than-zero check, so coverage can drop from eight
  structural sites to one and still report green — pin the site set, not the count.
  The rank guard's canonical-file exemption is inert (it asserts existence, not
  membership in the walked set) and its rank-literal regex is key-order-locked, so a
  re-inlined table in any other order goes undetected. The retirement guard's failure
  message asserts a resolution fact its probe did not establish for codes outside its
  known set (fail-direction is safe). The `statSync` beside the now-uncaught
  `readdirSync` is still uncaught, so a file that disappears mid-walk kills the guard.

- **`fixture-generator-drift-guard` is not hermetic (low, friction).** All three cases
  failed on a missing built entry point that existed on disk throughout, and the suite
  passes alone and on re-run — consistent with a concurrent dist clean/rebuild rather
  than a regression. Property: a guard suite's verdict must not depend on another
  process's build timing.

- **A scoped wave item that coins an invariant id in `src/` is structurally unable to
  satisfy the id-glossary gate (2026-08-20, medium, friction: tool_should_decide).**
  `docs/glossary-ids.md` is outside every module's `file_scope`, the gate scans `src/` for
  `INV-*` ids, and the pre-commit gate does not run the glossary test — so the red lands
  silently and is discovered by the NEXT item's worker (happened twice in one session:
  `INV-SSP-DEFERRED-SET-REPORTED` at CP-NODE-10, `INV-CCI-NO-DELTA-ID-PARSING` at
  CP-NODE-18). **Property:** either workload preparation includes `docs/glossary-ids.md` in
  any scope whose contract declares a new invariant id, or the glossary gate joins the
  per-item required commands, or new ids stay out of `src/` comments by convention (the gate
  scans `src/` only — CP-NODE-9 adopted this deliberately).

- **The remediate-side submission ledger has no reader — `accepted_via_recovery` marks are
  write-only (2026-08-19, low-medium).** recover-ingest appends distinguishability events to the
  submission ledger NDJSON under the artifacts dir, but no remediate surface reads them: not
  `remediation-report.md`, not `remediation-outcomes.json`, not `validate-artifacts` (the only
  reader is the audit-side bundle loader). **Property:** a recovered run must be distinguishable
  from a clean one in a rendered surface, not only in raw NDJSON — surface recovered items at the
  close-phase report. [[write-only-data-looks-authoritative]]

- **The pre-commit round-trip journal is not bound to the HEAD it was captured under, so crash
  recovery can time-travel the tree backward (2026-08-19, high).** Observed live: a `git rebase` call's
  gate took the round-trip path (a background task's untracked log made the tree diverge), the hook
  died before its `finally` restore (killed mid-`npm run check` — the hook-timeout class the journal
  exists for), the rebase then moved HEAD — and the NEXT invocation's `recoverInterruptedRoundTrip`
  restored the journaled PRE-REBASE worktree and index over the new commit. The one file the old trees
  lacked survived as an orphan, and compiling it against the reverted schema manufactured a phantom
  type error that read as "remote main is red" and nearly shipped a wrong-headed forward "repair" of a
  green commit. **Property:** a journal records the HEAD (and index tree) it was captured under, and
  recovery REFUSES — announced, journal quarantined — when current HEAD differs; additionally the
  round-trip has no business materializing snapshots for history-MOVING commands (`rebase`, `merge`,
  `am`, …) whose own execution rewrites the tree it would restore.

- **The TASK draw's coherence eligibility is still disjunctive and has never been measured for
  collapse (2026-08-19, medium).** The findings draw moved to `shared_file AND same_lens`;
  `TASK_DRAW_COHERENCE_POLICY` keeps `weighted_score_threshold` deliberately, because no measurement
  of `buildTaskCoherencePartition`'s components on a real graph exists. **Property:** the task draw's
  eligibility is either measured and shown not to collapse, or aligned with the findings draw's — it
  is not left disjunctive on the grounds that nobody looked.

- **`runCommand` buffers child output unboundedly (2026-08-13, medium).**
  `runCommand` (`src/audit/orchestrator/runtimeCommand.ts`) does `stdout += String(chunk)` and truncates only
  after `close`, so a verbose suite can exhaust memory or throw a `RangeError` from inside a stream
  `data` listener — **uncaught**, killing the process with no recoverable state (the awaiting caller
  never sees it). Same defect class as the coherence-trace blowup, one layer over. **Property:**
  accumulate a bounded ring of trailing lines, never the whole stream.

- **`shell-trap-guard` misses `git stash push <pathspec>` eating uncommitted work (2026-08-12, medium).**
  The guard DENIES a `git checkout --`/`git restore` that would eat unstaged edits, but a pathspec'd
  `stash push` removes them just as silently (hit live: it swept a 200k-line uncommitted retirement
  edit of the named file into the stash; recovered by `stash pop`). **Property:** any git verb that
  removes unstaged edits from the working tree gets the same deny-once as `checkout --`/`restore`.

- **Contract-pipeline fan-out names a mechanism the host may not have (2026-08-08, medium).**
  `module_contract_drafting` says "dispatch ONE sub-agent PER MODULE"; where in-process subagents are
  unavailable the only route is a shell-out lane the tool neither knows nor sizes for (2 of 9 such
  dispatches died mid-output; only the step's presence check caught it). **Property:** a fan-out step
  states what it NEEDS (N independent contexts, no shared authorship), not a mechanism; an
  absent-after-dispatch shard reports as TRANSPORT failure, not a refusal. Uncovered half: nothing
  carries the Stop-gate kill-switches into a shell-out child, so it hangs.

- **Sweep the test tree for tests that re-implement their subject (2026-08-08, medium).** One live
  instance found and fixed in `c791df49` (see git log). **Why no gate catches it:** such a test is
  green, typechecks, has no unused exports, and coverage counts the replica's lines — knip, eslint and
  the red-green rule all pass a test that pins nothing. **The tell:** a function declared in a test file
  that mirrors production control flow (a `for` over step kinds, a switch over cases) instead of calling
  into `src/`. **Property:** every test either calls production code or is deleted; where a replica
  exists because the subject is undrivable, fix the *untestability* (inject the dependency), not the
  test. Scope: `tests/**`, starting with the harness-heavy audit suites. [[test-must-reach-the-code-it-claims]]

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
  `tests/shared/*-gate.test.ts` are the next leads. ⚠ Standing trap from the reverted 2026-08-06 attempt: `projects:`
  at the TOP LEVEL of `vitest.config.ts` is silently ignored and voids the whole test config
  (false GREEN); any config split must nest under `test.projects` and prove both exit
  polarities. **Property:** no test worker blocks its event loop ≥60s continuously; until then
  the vitest-gate tolerance is the guard, and raw `npx vitest run` full runs still read red.

- **Remediation pause/recovery is not durable (2026-08-03, medium).** A plan-only stop left
  `.audit-tools/remediation/state.json` at `status: implementing`; the host work and its worktree
  had to be found and reconciled manually, while the worktree survived only because the operator
  knew its path. The primary record is
  [`graph-derived-findings-remediation-process-review-2026-08-03.md`](../reviews/graph-derived-findings-remediation-process-review-2026-08-03.md).
  **Property:** `plan_only`, pause, cancel, and resume persist the work item, workload binding,
  worktree outcome, and exact continuation action; resume must not re-run or discard accepted work.

- **Graph heuristics are promoted to findings without a semantic lead boundary (2026-08-03, medium).**
  Generic cut-edge detection labels ordinary test/asset/manifest bridges as systemic fragility; absolute
  co-change counts overstate broad migration commits; and whole-document file co-mentions masquerade as
  declared module boundaries. The sixteen declined items are the negative/corroboration corpus. **Property:**
  deterministic graph output is a generation/provenance-bound lead, not an approved finding, until semantic
  confirmation; report promotion must preserve producer, source hash, and evidence lineage.

- **Tool-owned gate reds are unattributed — foreign live-tree dirt pauses the run (2026-07-30,
  shrunk 2026-08-20; was "Phase-boundary gate false abandonment", HIGH).** The mutation half is
  RETIRED and test-pinned: a red gate now persists the failing command and a bounded output tail
  to `final-gate.json` and emits a resumable `final_gate_red` pause — no item status, phase, or
  state write; the coarse reattempt/terminate machinery is deleted (it wiped 21 resolutions on
  2026-08-20 when an unrelated landed commit reddened the live-tree suite; the 2026-07-30
  abandonment of 13 items was the same class). What stays open: the gate runs on the LIVE tree
  and computes no attribution, so dirt or breakage the run did not cause still pauses it — now
  bounded, classified, and resumable, but reported as the run's red rather than as environment.
  Primary records:
  [`meta-review-remediation-run-2026-07-30.md`](../reviews/meta-review-remediation-run-2026-07-30.md).
  **Property (residual):** a gate red is attributed to run-touched paths where possible, so a
  foreign red reports as environment, not as the run's failure.

- **Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong
  implementation (2026-07-24, medium, friction: ambiguous-direction).** The partial-wave entry said
  "M dispatched-but-in-flight" and asserted entanglement with the claim-lease machinery; the primary
  record ([`re-dogfood-2026-07-21.md`](../reviews/re-dogfood-2026-07-21.md) #14 + the run-state section)
  says the tasks were **undispatched** — never granted. Reading the backlog entry first produced a
  claim-liveness discriminator that was wrong and had to be replaced after existing tests refuted it.
  Same family as [[backlog-prose-decays-verify-against-head]] but sharper: the decay was not staleness
  but a paraphrase that changed the mechanism. Property: an entry that reinterprets an incident must
  quote or link the primary record's own words for the mechanism, not restate them.

- **⬇ Live-run watch (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a
  malformed-JSON result file — result validity must be checked mechanically, never trusted from
  the worker's claim.** The merge correctly rejected it, but the failure surfaced only as an
  unexplained same-packet re-grant. Properties: (a) results are parse- and
  AuditResult-contract-checked at result-write or pre-merge; (b) the merge's "missing or invalid"
  names WHICH per task (file absent vs parse error vs contract mismatch). Record:
  [`re-dogfood-friction-2026-07-22.md`](../reviews/re-dogfood-friction-2026-07-22.md) #12.

- **Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).** Step 2
  ran 4 adversarial rounds; each spawned FRESH agents that re-grepped the same `tokens_per_pct` /
  `admit` / `reconcile` call-site map from scratch (~135k subagent tokens per round, much of it
  identical recon). Continuing a prior reviewer preserves its context but forfeits independence,
  which is the whole point of the round — so the two goals are in tension and the fix is not "reuse
  the agent". **Property to hold:** a review round receives the verified call-site map as INPUT
  (cheap, mechanical, produced once) and spends its budget on judgment, not rediscovery — while still
  reaching its own verdict.
  **SPEC — the tension is false: it conflates independence of VERDICT with independence of INPUT.** What
  a review round must not do is judge work it authored. Being handed a factual call-site map it did not
  produce does not compromise that — the agent is still fresh and the verdict is still its own. Re-deriving
  the map from scratch was never carrying independence; it was carrying redundant derivation, and paying
  ~135k tokens per round for it.
  **Resolution:** the verified map is a read-only, provenanced input artifact. Each round receives it
  labelled as prior verified recon it did not author, and cannot write back to it — updates go through a
  separate recon step, so the map cannot silently absorb a reviewer's assumptions and then be handed to
  the next reviewer as fact. Rounds spend their budget on judgment.
  **Property to hold:** no review round re-derives a mechanical fact another round already established,
  and no round judges anything it authored. ⚠ Sharing an agent SESSION across rounds is the wrong version
  of this and forfeits exactly what the round is for.

- **A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main.**
  The idea: revert each site of a change individually and require each reversion to turn the suite red,
  so "every changed site is pinned by a test" stops being a claim the author makes about their own work.
  A prototype (`assert-sites-pinned.mjs`) existed on an unmerged branch, reachable from NO ref at HEAD. <!-- doc-citation-exempt: prototype on an unmerged branch, reachable from no ref -->
  The independent review that exercised it named both fail-open shapes
  ([`account-metering-round2-independent-review-2026-07-19.md`](../reviews/account-metering-round2-independent-review-2026-07-19.md),
  *The evidence apparatus is itself fail-open*): it measured *"the suite went red"*, not *"a test
  asserting THIS behavior went red"*; and a hand-written site list declared 7 sites against ≥11
  substantive hunks, so "all N pinned" was literally true and materially misleading.
  Nothing stands in for it at HEAD — the loop-core gate checks attestation existence, staged-tree
  binding and verdict only, and `--checked` is free text with a ≥20-char floor — so "red-green
  validated" in an attestation is still the author's word about their own work.
  **Properties to hold:** each site binds to the NAME(s) of the test(s) expected to fail, and the site
  list is DERIVED from the diff so an omitted hunk is impossible.
  ⚠ **OWNER DECISION 2026-07-25 — BUILD it, with a DIFF-DERIVED site list**, closing the denominator
  hole. ⚠ The second property is NOT thereby solved: expected-failing test names are still
  author-supplied, so a naive build relocates the claim instead of removing it. Derive the name binding
  (e.g. from a baseline coverage/ownership map), or the gate measures "the suite went red" again — the
  exact fail-open it exists to catch. Until then its output is not admissible as attestation evidence.

- **Friction walk (determinations-execution lap, 2026-07-29):** (1) **ambiguous-direction:** none —
  the 16 nightly-ledger answers were executable as written; the two left unexecuted (premise probe
  `ea4e616f`, guard-reach-as-declared-data `ec64d159`) are full-lap builds awaiting a design pass,
  not ambiguities, and stay visible via `answer.mjs --list`. (2) **tool-should-decide (small):**
  the Bash tool's `$TMPDIR` is unset under Git Bash on win32, so `> "$TMPDIR/x.log"` degrades to
  `/x.log` → permission denied; `/tmp` works. (3) **inefficient-feeding:** none new — the offload
  tier path carried 9 subagents (six doc edits, condensation draft, adversarial verify, loop-core
  review) with zero lane-side failures. (4) **tool-should-decide (small,
  cost: one burned tag v0.34.40):** a doc edit has no edit-time surface naming the TESTS that
  assert its content — `nightly-routine.md`'s approved lane swap was green through every local
  doc gate and failed release CI on `nightly-routine-prompt-gate.test.ts`, which pinned the
  retired helper invocation verbatim. Grep tests for a doc's path/content before shipping a
  contract-bearing doc edit; the durable fix would be a declared doc→test consumer map.

- **Friction walk (duplicated-guard lap, 2026-07-25):** (1) **inefficient-feeding (medium):** the
  triage's per-entry `Paths:` are MODEL-INVENTED for entries whose prose names no file —
  <!-- doc-citation-exempt: deliberate does-not-exist narrative — the entry records these paths as fabrications -->
  `src/scheduler/populate.ts`, `src/review/mapCache.ts`, `src/pinning-gate.ts` and others do not exist —
  so a path column that reads like evidence is a routing guess. Two of the three entries worked this lap
  had to be located by grep anyway. Property: a generated triage should emit a path only when it can be
  resolved against the tree, and mark the rest `unresolved`. (2) **tool-should-decide (low):** the
  backlog seek-index and the HANDOFF roadmap are two separate generators, each with its own commit-gate
  refusal, so a single backlog edit costs two blocked commits to learn both are stale. One `npm run
  regen:docs` (or one gate naming both) would make it one round-trip. (3) **ambiguous-direction:** none
  this lap.

- **Implementation workers are never given the contract they must satisfy (2026-08-09, high).** The
  implement-node prompt carries the DAG node's `description` and obligation ids but NOT the text of
  `finalized_module_contracts`. A host worker can therefore implement a locally plausible interface
  that contradicts an already-approved module contract. Build and targeted tests may stay green because
  the divergence is CONFORMANCE, not local correctness. Properties: the emitted host work item
  carries (or references by path) the contract for the module it implements, and a conformance check
  sits between "host result received" and "accepted", since a foundation divergence propagates to every node that
  imports it. Auditor-agnostic rule exactly — it worked only when the DAG author happened to restate
  every declared value in the node description. [[enforce-robustness-in-tooling-not-host-discretion]]

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

- **Friction walk (niggle-fix lap, 2026-08-07):**
  (1) **tool-should-decide (low):** a host worker landed sound edits but wrote no bound result, so the
  verify stage never ran and the driver re-verified by hand. A work item whose commit exists but whose
  result is missing should surface as explicit partial progress, never disappear as null.
  (2) **tool-should-decide (low):** both implement agents left ~16 stray `*.log` files in the repo
  ROOT despite prompts directing output elsewhere — the recorded offloaded-diff-scope class
  ([[parallel-dispatch-bounded-current-verified]]); driver swept them before commit. The
  `*.log` ignore rule now keeps such a log from reddening `check:doc-code-citations`, but it
  also removes `git status` as the signal that surfaced this — a stray log is now invisible.
  (3) **ambiguous-direction: none** — the two backlog entries stated their properties precisely
  enough that both fixes landed against them verbatim.
  (4) **tool-should-decide (low, observed post-fix):** the closeout-challenge gate cannot
  attribute tree dirt, so a CONCURRENT session's uncommitted WIP in the shared checkout re-fired
  the challenge after each of this session's commits (new stateKey, same foreign dirt) and spent
  the full cap on paths this session never touched. Property: the gate's dirty-tree evidence
  should exclude (or at least mark) paths whose dirt predates the session or is named deliberate
  in HANDOFF — same attribution principle as the phase-boundary-gate entry above.

- **Friction walk (loop-core `.ts`-conversion tranche lap, 2026-07-28):**
  (1) **tool-should-decide (medium):** the closeout-challenge Stop gate fired twice MID-LAP while 15
  background agents were live on the tree — it reads uncommitted paths as an unclean close and cannot
  see in-flight background work, so a deliberate wait state consumed both of the session's challenges
  before the real closeout. The gate needs a live-background-work signal before spending a challenge.
  (Reproduced identically on the 2026-07-28 conversion fleet lap: both challenges again spent on
  deliberate mid-fleet pauses, zero left for the actual close.)
  (2) **inefficient-feeding (low):** `.audit-tools/nightly/open-items.json` was STALE at
  presentation — all 17 surfaced items already answered and done in the ledger; the
  [[queue-items-must-be-rechecked-at-presentation]] class, since mechanized (premise probes +
  live-ledger partition).

- **Friction walk (nightly-determinations lap, 2026-07-26):**
  (1) **inefficient-feeding (medium):** `.audit-tools/nightly/open-items.json` is a single 659-line /
  26k-token document that exceeds the Read cap, so enumerating it needs a hand-written `node -e`. Worse,
  it is STALE by construction — `answer.mjs --list` correctly reported zero open while the file still
  listed all 22, because answering writes to `.claude/nightly-decisions.json` and never reconciles the
  queue file. **Property:** the queue's on-disk form is enumerable in one bounded read AND reflects the
  settled ledger, or the two disagree and the file is the one an agent finds first.
  (2) **tool-should-decide (medium):** an ANSWERED determination is free prose with no machine-readable
  work shape, so executing 22 of them meant re-reading each item's evidence to rediscover the target
  file and edit. The item already knows its `path` and its options; the answer should carry the
  actionable target, not require a second derivation from the eli5 text.

- **Friction walk (touched_files load-gate lap, 2026-07-25):** (1) **tool-should-decide (medium):** a
  fixture helper ending in `as RemediationState` (`tests/remediate/helpers/nextStepHarness.ts`)
  makes `check:tests` inert for that fixture — it hid blocks missing a REQUIRED contract field from the
  gate added to catch exactly that. Property: a fixture must not be able to cast away a contract's
  required keys — `satisfies`, or a builder that cannot omit them.

- **Friction walk (fourth backlog-clearance lap, 2026-07-24):** (1) **tool-should-decide (medium):**
  the backlog budget baseline is bound to the LIVE file, so
  ratcheting mid-lap and then deleting more entries turns `backlog-budget-unit.test.ts` RED in a way
  that reads as a code regression — it cost a full-suite investigation here. Either ratchet only at
  commit time (a hook), or have the test compare against the COMMITTED file rather than the worktree.
  (2) **ambiguous-direction (HIGH — nearly cost the whole task):** the sweep was first sized at "222
  errors / 131 files" and deferred as multi-hour. Both numbers were wrong: `tsc` continuation lines were
  counted as filenames (real: 50 files), and `allowJs` erased 28 errors outright. Eight parallel agents
  cleared it in ~7 minutes. A mis-parsed tool report inflated the estimate 2.6× and the inflated estimate
  was then used to justify NOT doing the work. Parse a tool's output with its actual grammar before
  sizing anything from it. ⚠ Related measurement trap: `tsc` reports only ONE missing property per object
  literal, so an error count is a LOWER BOUND — every batch found 10-20% more once siblings unmasked.

- **Friction walk (second backlog-clearance lap, 2026-07-24):** (1) **ambiguous-direction (medium):**
  a backlog entry can name a fix whose PREMISE is sound and whose CONSEQUENCE is unshippable — the
  per-node token estimate entry described the defect correctly and the fix it prescribed would have
  regressed the run. An entry should state the property, not the mechanism, precisely because the
  mechanism is the part that does not survive contact ([[backlog-item-states-invariant-not-fix-mechanism]]).
  (2) **inefficient-feeding (low):** a background `npm test … | tail -N` writes NOTHING to its output
  file until the whole run ends, because `tail` buffers to EOF — so a long suite cannot be progress-
  monitored and looks hung. Redirect to a file and grep it instead of piping through `tail`.

- **Untracked-exclusion scope rule — residuals only (each low-severity, documented at the code
  site).** Shipped 2026-07-10: `buildFileDisposition` runs an `untracked` scope rule, so untracked
  litter cannot enter the auditable scope. Still live: a `renderHostScratchNote`/`hostScratchDir`
  pair (`src/shared/prompts.ts`, `src/shared/io/auditToolsPaths.ts`) has ZERO callers — only
  definitions plus a re-export in `src/shared/index.ts`, which knip's default mode counts as a
  consumer — so it reaches no prompt. Wire it into the prompt below, or delete it. Residuals:
  - (a) **Submodule / nested-repo contents are now excluded as `untracked`** (parent `ls-files` lists only the
    gitlink). Consistent with citation grounding, but a silent scope change for repos with first-party
    submodules. Ideal fix = `--recurse-submodules` in BOTH the disposition rule and the grounding corpora
    (`findingGrounding.enumerateTrackedFilePaths`, M-B3 `enumerateRepoTreePaths`) as ONE atomic change —
    never one side alone.
  - (b) **`file_disposition` now depends on git index state, which the dependency DAG doesn't track**
    (`dependencyMap.ts` keys it to `repo_manifest.json` only). An index-only change (committing a
    previously-untracked file) won't re-stale a persisted disposition until repo_manifest churns.
    ⬇ Live-run watch: after committing files mid-run-continuity, confirm they enter scope on the next audit.
  - (c) **Scope-rule guard decisions are invisible at the intent checkpoint** — `computeScopePreDigest` reads
    only per-file entries; a skipped rule (`root_untracked`/`share_exceeded`/git-absent fallback) never
    surfaces to the operator despite the summary existing for exactly that purpose.
  - (e) The audit `renderEdgeReasoningDispatchPrompt` (`src/audit/cli/prompts.ts`) single-agent
    dispatch carries no scratch-dir note — one bounded agent writing one results file, so it is the
    lowest-risk path; add one if it ever litters.

- **External shared-logic audit V1–V7 residuals** (each deliberate, low-severity, documented at the code
  site):
  - **(from V3) postinstall agent-scope legacy-wildcard migration gap.** Both postinstall scripts preserve
    an EXISTING legacy agent-scope bash `'*':'allow'` in an already-deployed
    `~/.config/opencode/opencode.json` on upgrade (the wrapper/install path DOES migrate it → `'ask'`;
    pinned deliberate by remediate's COR-fc1f12a6 tests). Full closure: mirror the wrapper's
    `withoutManagedBroadBashWildcard` migration into `scripts/{audit,remediate}/postinstall.mjs`.
  - **(from V5) path-guard blind spots.** `tests/shared/audit-tools-path-guard.test.ts` cannot see
    template-literal construction (no live occurrence today) and its allowlist honesty check is
    substring-only. Tighten if a violation ever sneaks past. Also low: `validateArtifacts`'s unused
    `root="."` default now yields an absolute (not relative) report path — no live call site hits it.

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

- **`goal_id` is read verbatim off the LLM envelope, so its format is unvalidated (re-verified at HEAD
  2026-07-25).** The rest of ID minting is routed through the one registry:
  obligation ids now mint through `obligationId`/`moduleSlug` in
  `src/remediate/contractPipeline/idRegistry.ts` (the encoder and its phase/write-scope decoders were two
  identical implementations plus a "MUST stay in lockstep" comment), and uniqueness is the shared
  `mintUniqueId`. What is left: `goal_id` is not minted at all — it is read verbatim off the LLM envelope
  (`derive.ts`), so its FORMAT is unvalidated. **Property to hold:** an id the tool relies on is either
  minted by the registry or validated on the way in.

- **`StepArtifactSchema` is `.strict()` but `writeStepContract` injects `agent_id`.** `steps.ts` declares
  the audit step contract strict while `stepContractWriter.ts` stamps a per-process `agent_id` onto the
  written JSON, so parsing an emitted contract with its own schema fails. Readers work around it by
  reading raw JSON. **Property to hold:** a contract the tool writes parses with the schema the tool
  declares for it.

- **systemic_challenge findings ids are adversary-invented and round-colliding.** Rounds 3 and 4
  both minted SC-001..004 for different findings (host prefixed r4- to avoid accumulator clobber);
  convergence also rested on host prompt-craft (8/7/4/8→0 only after hardened dispatch framing).
  **Property to hold:** the tool namespaces challenge ids per round; the round prompt itself
  carries a covered-themes digest and an explicit variation bar.
  Reproduced in full 2026-08-08 (O7 in the run record below).

- **The systemic_challenge loop has no ceiling — its only exit is a dry signal the host may have to
  fabricate.** `MAX_DRAIN_STEPS` bounds the deterministic drain; this loop has none, and
  `src/audit/orchestrator/state.ts` blocks planning until a round returns nothing-new. A fresh
  no-memory adversary structurally cannot judge "nothing new"; observed yield varied by host execution,
  not demonstrated exhaustion. **Property to hold:** a round ceiling ends the loop without a false dry signal, and a
  host-forced stop is recordable as such. Run record O7.

- **`ensure` writes opencode.json with unstable key order.** Pure key-reorder diff (edit-permission
  map) on every ensure — a generated config violating the stable content-derived ordering invariant,
  dirtying every tree it touches. **Property to hold:** generated host configs are byte-stable
  under repeated ensure.

- **Steward verification metadata is undeliverable through the host-result envelope (hit
  2026-08-18).** The `deepening:steward` prompt instructs the host to return `findings: []` plus
  `verification.followup_tasks`, but `parseHostResult` enforces exactly seven envelope keys and
  `toAuditResult` maps no `verification` field — the channel exists only in the retired
  worker-result contract (`workerSchemas.ts`), so `buildVerificationFollowupTasks` can never see
  host-submitted suggestions. Same class as the approved P35 (step prompts must not instruct what
  the tool cannot deliver); fold into that build or carry `verification` through the envelope.
  **Property to hold:** every instruction a step prompt emits has a deliverable channel the
  ingest actually reads.

- **The report renderer emits control characters from finding prose raw (hit 2026-08-18).** A
  worker summary containing a JSON-escaped backspace (a mangled regex \b word boundary) is stored
  safely in audit-findings.json but rendered as the raw 0x08 byte into audit-report.md, where
  check:control-bytes correctly reds CI. Scrubbed by hand this lap. **Property to hold:** the
  render step sanitizes C0 control characters out of worker-authored strings (or re-escapes them
  as text), so a contract-valid finding can never produce a tracked file the byte gate refuses.

- **A killed `next-step` wedges `phase.lock` for every later call (2026-08-24, remediation run,
  medium).** `PHASE_LOCK_TIMEOUT_MS = 0` makes the phase acquirer try once and return `phase_busy`
  without ever entering the wait loop — but the stale-steal path (`STALE_LOCK_MS`, dead-owner
  token check) lives inside that loop, so a `phase.lock` whose holder died (observed: a
  `next-step` killed by a 2-minute shell timeout) is never stolen and every later `next-step`
  bounces forever; the host had to verify the owner pid dead and delete the lock by hand.
  **Property to hold:** a zero-timeout acquirer still runs the stale-steal check once, so a
  dead-holder lock never needs a hand deletion.

- **Host-widened scope on a live-bound block wedges `next-step` (2026-08-23, remediation run,
  medium).** `state.host_handoff` pins the dispatched workload by `workload_sha256`; widening a
  bound block's `touched_files` (the sanctioned hand recipe for a scope clarification) changes the
  canonical workload, so `prepareRemediationHostHandoff` fails closed with "Trusted remediation
  host workload no longer matches the persisted state binding" and the run cannot advance. The host
  repair was to delete `state.host_handoff` so prepare re-minted the binding at the current HEAD —
  a hand edit of fail-closed state. **Property to hold:** the tool offers a sanctioned re-bind for
  a host-widened frontier block (or the clarification flow itself carries the widening), so a scope
  answer never requires hand-editing the binding.

- **A provenance plane with no producer is still exported, advertised and documented (2026-08-27, from the philosophy audit, medium).** `src/shared/types/executionRecord.ts` defines `ExecutionRecordV1Alpha1` and its Zod schema and `src/shared/index.ts` exports both, but no tracked producer or consumer calls the schema. `src/shared/types/runLedger.ts` and `src/audit/supervisor/runLedger.ts` define the run ledger and `loadRunLedger` reads it, while `src/audit/cli/statusCommand.ts` and `src/audit/supervisor/operatorHandoff.ts` advertise it — and no tracked writer ever creates it, so the loader's empty result is indistinguishable from a run that recorded nothing. `src/shared/observability/runLog.ts` is not a replacement: it can be disabled, no-ops when no path is configured, deliberately swallows append failures, and does not carry every ledger field. A third case rides along: `allowed_mcp_tools` is declared in audit's step schema in `src/audit/cli/steps.ts` and covered by producer tests, but has no reader after emission, and the single value any caller supplies is named nowhere else in tracked source — an installed host asset could still consume it, so inspect the deployed assets before deleting. **Property:** every exported or emitted contract has a live producer and a live consumer, or it is retired at one explicit versioned boundary together with the specs, status fields and operator-handoff text that advertise it. A status field derived from best-effort telemetry says so, and no absent ledger field is synthesized to fill the old shape.

- **Three persisted contracts are read back without the schema that defines them (2026-08-27, from the philosophy audit, medium).** Each is a canonical read whose authority is split across a TypeScript interface, a partial hand validator and a permissive predicate, so a malformed value is accepted and fails on a later invocation instead. (1) Remediation state: `validateState` in `src/remediate/state/store.ts` checks `status` plus status-conditional field presence and the result is then cast, and the store passes no `validate` hook to `createLockedJsonStore`, so the read side is stricter than the write side and every mutate/replace persists unvalidated. The state carries no contract version. (2) The contract-pipeline envelope: `readContractArtifact` in `src/remediate/contractPipeline/artifactStore.ts` casts parsed JSON with no check at all, and `isEnvelope` tests only that three keys are present — nothing binds `artifact_name` to the name that was requested or recomputes `content_hash` over the payload, while `src/remediate/steps/contractPipeline.ts` then reads that unverified hash as the judge and critique identity. (3) The submission ledger: `readSubmissionLedger` in `src/shared/submission/submissionLedger.ts` classifies a torn line and a foreign contract version per line, but past the version check an event's `kind` and required fields are never validated — a current-version line of any shape becomes an event. Downstream, recovery acceptance in `src/remediate/steps/dispatch/hostHandoff.ts` deduplicates by asking whether an event's free-text `message` contains the landed commit. **Property:** one schema per persisted contract, parsed at every canonical read and through the store's own write hook, past the version gate as well as at it; identity is bound to the location the value was read from, verified against the payload rather than trusted as a field, and never re-parsed out of prose.

- **The pre-split design-review lane is still polled beside the two current judgment types (2026-08-27, from the philosophy audit, medium).** `GATE_LANES.design_review_legacy` is live in `src/audit/cli/laneSubmissions.ts`, accepted by `src/audit/cli/laneValidators.ts`, and polled ahead of the contract and conceptual lanes by `src/audit/cli/nextStepHelpers.ts`, which sets the old `reviewed` flag and records the lane outcome. `src/audit/orchestrator/state.ts` then reads that one flag as satisfying BOTH modern obligations — guarded only by artifact staleness — and `src/audit/orchestrator/structureExecutors.ts` carries it forward across a structure refresh, so a single pre-split verdict stands in for two different judgments for as long as the artifact stays fresh. **Property:** only contract review and conceptual review exist, and a resumed pre-split artifact directory either leaves both modern obligations unmet and forces a rerun, or is invalidated by a persisted state version at load — never translated. Fixtures, quarantine/merge behaviour and the operator's rerun message move with the lane in the same change. The exposure is every resumed pre-split directory, not only audits visibly in flight.

- **The N-R13 status invariant asserts its own literal, and the status vocabulary exists in three
  unlinked copies (2026-08-27, low-medium).** The first describe block of
  `tests/remediate/n-r13-document-phase-dissolved.test.ts` builds a local `validStatuses` array and
  asserts it does not contain `"documenting"` — a tautology over a literal the test itself wrote, so
  a `documenting` status reintroduced into `RemediationState` would pass it silently. Its other
  three blocks (planning transitions straight to implementing, the removed CLI verb, the removed
  dispatch exports) do reach real code. The reason the block reads that way is the second half:
  the vocabulary has no single source. `src/remediate/state/store.ts` declares the union inline on
  `RemediationState.status`, then hand-mirrors it as the module-private `KNOWN_STATUSES` set the
  load gate rejects unknown states with; the test writes a third copy. Nothing joins the three, so
  the load gate and the type can drift apart with no red build.
  **Property:** one exported runtime declaration of the status vocabulary, with the type derived
  from it and both the load gate and the invariant test reading it — so the N-R13 assertion is made
  against the shipped value rather than a restatement of it. Trace:
  [`n-r13-and-lean-fast-path-trace-2026-08-25.md`](../reviews/n-r13-and-lean-fast-path-trace-2026-08-25.md).

- **The dispatch boundary strips every per-node field the contract pipeline writes onto a promoted
  finding but `FindingSchema` does not declare (2026-08-27, medium).**
  `promoteImplementationDagToExtractedPlan` (`src/remediate/steps/contractPipeline.ts`) writes
  `concrete_change`, `preconditions`, `expected_changes`, and `addresses_counterexamples` onto each
  promoted finding. `FindingSchema` (`src/shared/types/finding.ts`) is a bare `z.object` declaring
  none of them, so zod's default strip removes all four at the `FindingSchema.parse` inside
  `buildFindingAssignments` (`src/remediate/steps/dispatch/hostHandoff.ts`) — and that parse result
  IS the per-item payload handed to the host, the last hop before the implementer prompt.
  `targeted_commands`, which IS declared, survives the same parse, so the loss is silent and
  field-selective rather than a visibly broken payload. `tests/remediate/contract-pipeline.test.ts`
  pins the producer for `preconditions` and `expected_changes`, so the producer half is guarded and
  the consumer half is not; no code reads any of the four off a finding, because their only intended
  consumer is the host payload the parse empties. The implementer works from `summary`/`evidence`
  without the node's stated precondition or expected change.
  **Property:** a field the pipeline computes onto a finding reaches its consumer or is not computed
  — it is declared on the finding contract, or the producer and the tests pinning it go. Same class
  as the write-only remediate submission-ledger entry, at a different boundary.
  [[write-only-data-looks-authoritative]] Trace:
  [`n-r13-and-lean-fast-path-trace-2026-08-25.md`](../reviews/n-r13-and-lean-fast-path-trace-2026-08-25.md).

- **The two evidence-bearing terminal dispositions have no producer — `verified_already_fixed` and
  `refuted` are unreachable in any real run (2026-08-27, medium, from
  [`reviews/wave2-dispositions-2026-08-20.md`](../reviews/wave2-dispositions-2026-08-20.md)).**
  `resolveDisposition` (`src/remediate/state/itemStatus.ts`) reaches those two members ONLY through
  `RemediationItemState.disposition_override`, and `buildRemediationOutcomesReport`
  (`src/remediate/phases/close.ts`, called by `runClosePhase`) downgrades either to a `blocked`
  outcome unless the item carries a complete file/line/mechanism triple (`isCompleteEvidence`,
  INV-ISC-EVIDENCE-EMITTED). But the three item fields that gate reads —
  `disposition_override`, `evidence`, `recorded_by_module` — have no production writer: every
  literal that sets one lives under `tests/remediate`. Nor can a host supply one. The remediation
  host-result and host-decision envelopes are closed key sets checked by `hasExactKeys`
  (`src/shared/submission/hostHandoffCore.ts`) in `src/remediate/steps/dispatch/hostHandoff.ts`; a
  decision's `outcome.status` admits only `resolved_no_change` / `blocked` /
  `needs_clarification`, and its one evidence channel is a free-text string array on the first of
  those — never the structured triple `EvidenceSchema` (`src/shared/types/remediationOutcome.ts`)
  demands, and never either disposition. So both members, the `mechanismContradictsOutcome` check
  that guards them, and three persisted state fields are unreachable in production; the only route
  from a worker's determination to run state is hand-transcribing a markdown document no code
  reads, which is what the cited record is. Same class as the steward-verification-metadata entry
  (an instruction with no channel the ingest reads), one layer deeper: here the destination fields
  exist and nothing writes them. **Property:** every disposition the outcomes writer can emit has a
  producer that can reach it — a module records the triple at its own phase, or the host envelope
  carries it and ingestion binds it — so no run's terminal accounting depends on a hand-written
  document.

- **The closeout render record cannot name the session that wrote it, on a premise that is false (2026-08-27, medium, from [../reviews/closeout-generation-failure-2026-08-26.md](../reviews/closeout-generation-failure-2026-08-26.md)).** The render record under `.claude/hooks/.state/closeout-render/` binds to worktree CONTENT (`worktreeTree`), but its SESSION ownership rests on a timestamp: `.claude/hooks/closeout-challenge-gate.mjs` compares the record's `rendered_at` against the session registry's `registered_at`, so only a render that PREDATES this session is refused. A concurrent session's render — written after this one started — reads as this session's own, and the tree comparison catches it only when the content differs. The stated reason for the timestamp, that the renderer cannot read a session id, does not hold: `scripts/render-closeout.mjs` reads `CLAUDE_SESSION_ID`, which nothing in this harness sets, so the recorded `session_id` is always null; the environment does carry `CLAUDE_CODE_SESSION_ID`, and its value is exactly the filename of that session's record in the registry directory `readSessionRegistry` (`scripts/shared/sessionRegistry.mjs`) resolves from the hook payload. Second half of the same defect: the record is ONE repo-global file, so even a correctly-named id is last-writer-wins across concurrent sessions. **Property:** a closeout render record identifies the session that produced it, and the Stop gate accepts only a record this session wrote — never another session's render that happens to share the tree, and never on a name the environment does not supply. The false premise has a second copy, as data in the gate-scripts `uncovered` field of `scripts/guard-reach-data.mjs`; it moves in the same change. `tests/shared/closeout-render.test.ts` is the home for the pin.

- **An analysis record can identify work and reach no work queue, and every gate stays green while
  it happens (2026-08-27, medium, from the orphan-routing lap).** Seven `docs/reviews/` records
  dated 2026-08-20 or later were cited by nothing tracked — over 1,500 lines of identified,
  prioritized work that no queue knew about, including a whole philosophy audit challenging four
  standing decisions and an eight-gap workflow analysis with its own acceptance benchmark. Nothing
  could have caught it: no gate reconciles `docs/reviews/` against `docs/backlog/`, and
  `docs/documentation-philosophy.md` states no rule for routing a review's recommendations into a
  queue. The failure is silent by construction — the reviews are well-formed, the backlog is
  well-formed, and the only thing missing is the edge between them. Routing the seven took a lap of
  agent time that a gate would have made unnecessary. **Property:** a tracked analysis record that
  identifies work is reachable from a work queue, mechanically — not by whoever wrote it
  remembering to file the entries. **The obvious gate is the wrong one, and the uncovered half must
  be stated with whatever lands:** "every review is cited from somewhere" is detectable but WRONG,
  because a dogfood log, a measurement record and a completed triage legitimately carry no forward
  work and would each be a false red — and a false red gets the gate disabled, which is worse than
  no gate. Whether a record identifies work is a semantic judgment, the same unscriptable class the
  record-update gate's semantic half already declares. So the mechanism is either an explicit
  routing declaration the author writes once (a record states its disposition: work routed, or no
  forward work), or a periodic sweep with a declared cadence — never an existence check over the
  whole directory.

- **The masked-exit guard reaches SUITE commands only, so a rejected `git push` reads as exit 0
  (2026-08-27, medium, friction: tool_should_decide).** `shell-trap-guard.mjs` refuses a
  test-or-verify command piped into a filter, because the pipeline reports the FILTER's status and a
  red suite comes back green. Its `SUITE_CMD` matcher lists npm/pnpm/yarn test-and-run forms, `npx
  vitest`, `vitest run` and `node --test` — and nothing else. `git push origin main 2>&1 | tail -3`
  is therefore admitted, and it produced exactly the failure the rule exists to prevent: the push was
  refused as non-fast-forward, the hint text scrolled past in the captured tail, and the reported exit
  status was 0. The false green is worse here than on a suite: an agent that believes a push landed
  stops verifying, and the pipeline-ownership rule then reads as satisfied while the work sits only
  in the local branch. The same hole covers every other status-bearing git verb — `commit`, `rebase`,
  `merge`, `tag` — and the `pipefail` / `PIPESTATUS` escape the rule already honours would cover
  them unchanged. **Property:** the masked-exit refusal is keyed to whether a command's EXIT STATUS
  is load-bearing, not to whether it is a test runner — so a state-changing command piped into a
  filter is refused the same way a suite is, with the same two escapes.

- **Synchronous child processes reachable from the audit fold carry NO timeout, so one hung binary
  can outlive the lock heartbeat (2026-08-28, medium, friction: tool_should_decide).** The
  artifact-tree lock re-stamps its own mtime on a `setInterval` heartbeat and is considered stale at
  30s, so a synchronous stretch that blocks the event loop past that window lets a second process
  steal a lock the first still believes it holds. Several fold-reachable paths can produce one:
  `runTracked` (`src/audit/orchestrator/localCommands.ts`) passes `options.timeout` straight through
  to `execCommandSync` (`src/shared/tooling/exec.ts`) and every caller leaves it `undefined`, so a
  hung `tsc` or `eslint` blocks indefinitely; `enumerateTrackedFilePaths`
  (`src/shared/validation/findingGrounding.ts`) runs `git ls-files -z` through `spawnSync` with a
  64 MB buffer and no timeout, reached inside the hold from `stampToolComputedGrounding`
  (`src/audit/cli/auditStep.ts`); and the disposition extractor's VCS-ignore and untracked rules
  default to `spawnSync` (`src/audit/extractors/disposition.ts`). The
  analyzer candidate walk is synchronous too but is already safe, bounded at 5,000 entries. This is
  a PRE-EXISTING hazard, not one CX-02 introduces — those children already run inside today's hold —
  but CX-02 lengthens the window, and the CX-02 record wrongly reassured that every folded-in
  operation is async or awaited. **Property:** no synchronous child process reachable while an
  artifact-tree lock is held may run unbounded — every such spawn carries a timeout shorter than the
  stale-lock window, so the holder can never be declared stale while it is still working.
