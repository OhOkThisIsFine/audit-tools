# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **The nightly clean-tree rule does not say which writes it blocks (2026-08-22, low, friction: ambiguous_direction).** `docs/nightly-routine.md` says a dirty tree means the run "applies **nothing**". But the same run must still write its own tracked output — `.audit-tools/nightly/open-items.json`, `docs/nightly-inbox.md`, the leg-3 proposal records, and the regenerated `docs/HANDOFF.md` live-state block, which the commit gate independently REQUIRES to be current. The 2026-08-22 run had to decide for itself that emitting the queue is not an "apply", which is the host-discretion shape the repo bans. **Property:** the rule names the blocked class (doc edits derived from the review) and the always-written class (the routine's own generated output), so no run has to judge it.

- **The backlog triage sweep needs a second manual invocation to reach its real coverage (2026-08-22, low, friction: tool_should_decide).** `scripts/shared/triage-backlog.mjs` errored on 22 of 96 entries in one pass — the lane returned no parseable JSON object, or output that missed the triage schema. Its documented recovery is a plain re-run, which re-queues exactly the failures; that second run recovered 20 of the 22. The recovery works, but it is the operator's to remember, and a run that stops after one pass writes a coverage stamp reporting 74/96 as if that were the ceiling. **Property:** the sweep retries its own transport-level failures within one invocation before writing the stamp, so the stamp reports the coverage the tool can actually reach.
- **The critique-driven contract repair step renders the judge-repair template (2026-08-22, medium).** The contract-repair step for `finalized_module_contracts` has two triggers, but its rendered prompt is always the judge-repair one: it says 'The adversarial judge rejected the current contract' and lists Required Inputs (`obligation_ledger`, `contract_assessment_report`, `counterexample`, `judge_report`) that do not exist on the critique-driven trigger, whose only inputs are the conceptual design critique and the artifact itself. Hit 2026-08-22 on the first-draw remediation run (`Contract Repair: finalized_module_contracts`); the worker burned turns hunting inputs the tool never bound. **Property:** a repair step names its actual trigger and lists only inputs that exist for that trigger.

- **Remediation intake drops a finding with no `evidence` array, and the audit systemic-challenge lane emits findings without one (2026-08-22, medium).** Intake's no-evidence branch records only a `droppedNoEvidence` disposition in review_filter_dispositions.json and never surfaces the finding; the review gate therefore never showed MNT-c2dc7f9c (high severity, high confidence: the wrapper pair duplicates ~2,400 lines), so an operator could neither confirm nor decline the drop. The audit side's systemic-challenge lane mints findings with no evidence array, so every such finding is unremediatable by construction. **Property:** a finding the intake drops is surfaced at the review gate as a disposition the operator confirms, and a systemic-lane finding carries evidence (or an explicit grounding class the intake admits) so the pipeline can remediate it.

- **No native way to draw a subset of a large findings file into a remediation run (2026-08-22, low, friction: tool_should_decide).** The first draw of the 2,712-finding self-audit (all 40 high + the 3 top-risk medium findings) had to be built outside the tool: a hand-filtered copy fails `work_blocks must project exactly one block per coherence component`, the tool's own `projectAuditFindingsReportSubset` is unreachable from `--input`, and the intent checkpoint's `filters` cannot express 'the findings the top risks name'. **Property:** the operator can name a draw (a severity set and/or finding ids) at intake and the tool projects it with the same function the review gate uses.

- **The contract-pipeline phase cut unions the drafted `neighbor_needs` into the finalized contracts' dependency graph, so symmetric coordination prose overrides every declared token edge (2026-08-22, high).** Finalization preserves the draft's `neighbor_needs` verbatim (`deriveFinalizedModuleContracts`, src/remediate/contractPipeline/derive.ts) and `phaseCutModulesFromContracts` (src/remediate/contractPipeline/phaseCut.ts) builds `depends_on` as the UNION of those mentions with the `artifact:` producer/consumer token edges — but `neighbor_needs` are symmetric coordination notes (A names B and B names A), so the union graph has cycles, and the tier derivation resolves a back-edge to "no added depth" (fail-toward-later) instead of failing. On the 2026-08-22 first-draw run this placed token consumers at EARLIER phases than their producers (5(P7) -> 148(P1), 1274(P10) -> 278(P8), 2(P11) -> 1296(P4), every seam-prep shard after its consumers), reported `has_cycle: true`, and the conceptual-design critique could not converge (cdc-01/cdc-02 re-raised twice; cdc-07 diagnosed the scheduler reading a prose-shaped graph). Removing `neighbor_needs` from the finalized contracts (moving the content into `seam_adjustments` as non-edge notes) produced an acyclic cut honoring every token edge and the critique converged — despite the phaseCut comment stating finalized contracts drop the field. **Property:** implementation ordering derives from the `artifact:` producer/consumer graph alone; drafted `neighbor_needs` never enter the finalized contracts' dependency graph (tokens win, or finalization drops the field), and a cycle in the declared graph is a validation error, not a silently dropped edge.

- **The contract-pipeline adversarial judge can demand what the finalized-contract schema cannot express, and its convergence guard then blocks the run on the host (2026-08-22, high).** The judge's `repair_directive.instruction` is free text acted on by a `contract_repair` of `finalized_module_contracts`, but finalization forbids dropping, merging, renaming, or inventing modules (`validateFinalizedContractsMatchDraft`-shaped gate, src/remediate/validation/contractPipelineGates.ts) and the finalized module-contract schema admits only `inputs`/`outputs`/`invariants`/`side_effects`/`validation_boundary`/`failure_modes` plus prose `seam_adjustments` — no machine-readable dependency or per-block write-scope field (src/remediate/validation/contractPipeline.ts). A directive such as "add the owning impl block for a finding the intake dropped" or "promote ordering to a dedicated dependency field; express sole-editorship as structured per-block scope data" (the 2026-08-22 first-draw second verdict, six accepted counterexamples) is therefore unsatisfiable at that stage: the judge re-accepts the same counterexamples, `evaluateJudgeGate` fires its non-convergence escalation (src/remediate/steps/contractPipeline.ts), and the run blocks awaiting an owner resolution the pipeline has no recorded verb for. The same verdict declared token-derived ordering authoritative over approved-findings.json's persisted block edges (a second ordering graph the tool keeps, able to disagree with the contracts') and flagged the four-owner `owned_files` for fileLock.ts that the contracts had already narrowed in prose. **Property:** every demand the judge can accept is expressible in the artifact its repair targets (a structured `depends_on` / write-scope field the scheduler and ingestion read, or the judge is bounded to the schema), an intake-dropped finding is either remediated or explicitly waived by a recorded host decision the judge respects, and one graph (the contracts') is the source of truth for ordering — never two that can disagree.

- **A transition that ends the call drops the fold's carried advisories (2026-08-22, low).** After e72a06bb, a fold's validation warnings and classified ingest issues survive the result-ingestion transition and reach the NEXT emission within the same `next-step` call — but a transition that ENDS the call still drops them: the carry is fold-local state on the ctx ref and is never persisted, so nothing survives into the next call. Advisory-only (the ledger record is unaffected); what is lost is the prompt statement of what the ledger already recorded. **Property:** every classified ingest issue and validation warning is stated on exactly one emitted step, whichever call emits it.

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

- **A release version bump trips the path-A seed-drift alarm (2026-08-23, low, friction:
  tool_should_decide).** `package.json` changed only its `version` and the contract pipeline blocked
  until the seed was deleted (option 3). **Property:** drift in a non-finding field never raises the
  alarm, or the alarm carries a one-command "accept this drift" path.

- **The step prompt's "Result status requiring attention" lists MISSING results with the same shape
  as rejections (2026-08-23, low).** A host parser had to special-case "no result file exists".
  **Property:** missing and rejected are distinct machine-readable statuses (or absent items are not
  listed).

- **The per-item required tests and the host landing gate do not include the tree-wide guard
  suites or the cheap release gates, and every landing's evidence is Windows-local (2026-08-23,
  medium).** Three remediation landings reddened CI after green per-item runs: a hand-restated
  `.audit-tools` literal caught only by `tests/shared/audit-tools-path-guard.test.ts` (`1e7a4a54`
  fixed it), a case-folding assertion true only on a case-insensitive volume (`011c6ae0`), and an
  intra-`src/shared` import cycle the reviewer graded minor that `check:depgraph` refuses
  (`b5963957`). **Property:** a landing runs the repository's guard suites and the cheap release gates
  (`check:depgraph`, `check:deadcode`, `check:lint`) for the areas it touches, and the host treats
  Linux CI as the real signal per commit.

- **Dispatch-lane children still answer the Stop "closeout challenge" despite
  `AUDIT_TOOLS_CHILD_SESSION=1` (2026-08-23, low).** Implementer and reviewer children ended with
  "Closeout challenge addressed…" prose; once it displaced a reviewer's final JSON verdict and the host
  had to retry the review. **Property:** the closeout-challenge gate honors the child marker.

- **The phase-boundary repository gate re-runs on EVERY `next-step` at the boundary (2026-08-23,
  low).** `phase_boundary_gate` (build + vitest, 2–5 min) ran on each of several consecutive
  `next-step` calls while the run sat at phase 1. **Property:** the gate runs once per boundary and
  its verdict is cached against the tree hash.

- **Reviewer minors carried from the first-draw landings (2026-08-23, low).** Same-lens dedupe
  absorption fix has no regression test (`src/shared/findings/dedupe.ts`); `collectPathARefusals`
  duplicates the promoter's Path-A membership logic and `FINALIZED_MODULE_CONTRACT_FIELDS` is a third
  hand-written field list beside `derive.ts` (`src/remediate/contractPipeline/`); `renderMembers`'
  `includeBodies` knob in `scripts/shared/generate-filelock-export-surface.mjs` is a no-op;
  `hostHandoffCore.ts` exports `idsAreUnique`/`absoluteHostHandoffResultPath` with no production
  caller and `resultPathFor` in the remediate adapter re-derives `runDir` by slicing the workload path.
  **Property:** each is pinned or deleted; none blocks.

- **The friction close-out walk must be written twice under two different names (2026-08-21, low, friction: tool_should_decide).** The Stop backstop (`.claude/hooks/friction-stop-gate.mjs`) scans every `*.json` under `<artifacts>/friction` and accepts the run-id-keyed record, while the close step demands the walk specifically at `<artifacts>/friction/run.json`. A complete walk recorded against the real run id satisfies the backstop and still leaves the close gate reporting all three categories MISSING. **Property:** one run has one friction record path, and both gates read it.

- **The systemic-challenge lane prompt withholds the banked findings it asks the adversary to beat (2026-08-21, medium).** The prompt states only a COUNT of prior improvements, and `systemicChallengeLoop` computes newness by exact identity over adversary-minted ids. An adversary therefore cannot tell what it must not repeat, and a paraphrase registers as new: round 3 of the 2026-08-21 lap re-emitted round 2's `mapWithConcurrency` item under a fresh id, and the lane raised both halves as findings itself. **Property:** the adversary sees the banked set, and convergence dedups on content rather than on a worker-minted id. Related: the no-ceiling entry — together they are why that lap's loop had to be stopped by a hand-written empty submission.

- **Acquisition of `actionlint` fails on extract (2026-08-21, low).** `external_analyzer_acquisition.json` recorded `actionlint` as `not_resolved` with `extract failed: tar exit 128`, so the workflow linter silently never ran although `.github/workflows` exists. **Property:** a tool that resolves and then fails to unpack is distinguishable from one that is not applicable to the repo.

- **Analyzer consent and conceptual-review depth are modelled as DURABLE when they must be per-run (2026-08-21, owner directive, medium).** `persistAnalyzerConsent` (`src/shared/analyzerPolicy.ts`, called from `src/audit/cli/nextStepHelpers.ts`) writes `analyzer_consent` into `.audit-tools/audit/analyzer-policy.json` so a `granted` answer silently runs that analyzer "from now on", and the `analyzer_consent` step text states that persistence as the contract. The intent checkpoint reuses a prior `design_review.conceptual_depth` the same way (the design-review step announces `Reusing intent from <timestamp> ... conceptual depth deep`). Owner, 2026-08-21: **these are per-run choices and should not be persisted — a user may not want the same settings every audit.** Consequences: the offer stops being made, an operator who granted a network-egress analyzer once keeps granting it unseen, and a delegate advancing a run unattended must record a durable decision merely to proceed. **Property:** an analyzer-consent answer and a review-depth answer bind the run that was asked, and the next run asks again; nothing about either survives into a run whose operator did not choose it. Note this REVERSES the reading that promotion deleting `<!-- doc-citation-exempt: runtime artifact under the gitignored .audit-tools/ tree, not a tracked file -->
  `analyzer-policy.json` was itself a defect — under this directive the deletion is closer to the desired behaviour than the persistence is, and the durable store is what needs removing.

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
  <!-- doc-citation-exempt: runtime sidecar written under the artifacts dir, not a tracked file -->
  (d) `intent-interpretation.json` is a
  write-only sidecar — `unencodable_clauses` is surfaced "so the host can promote them" with
  zero readers — and the INV-S04 doc comment at `src/audit/orchestrator/intentInterpreter.ts`
  overstates the boundary its code enforces (raw clause substrings ride interpreted fields into
  the sidecar/run-log, which the charge's plan/prompt/workload scope permits). Align doc to
  scope; give the sidecar a reader or delete it. [[write-only-data-looks-authoritative]]
  (e) The stderr/run-log pairing pin's residual doors, probed: migrating ONE diagnostic to
  `console.log` and deleting its event stays green (the in-family survivors satisfy the
  vacuity guard — widen the family or key on the `[remediate-code]` prefix), and the pin
  silently mandates event-BEFORE-write ordering — a legitimate write-then-log pairing would
  false-red with a misleading message; state the mandate in the comment and failure text.

- **Writing the nightly queue desyncs HANDOFF's generated live-status block (2026-08-20, low,
  friction: tool_should_decide).** The block derives from the queue and the decision ledger, but the
  nightly run contract does not list regenerating it as a run step, so the desync is caught only
  afterwards by the Stop closeout gate (hit and repaired 2026-08-20 via
  `node scripts/shared/generate-handoff-roadmap.mjs`). **Property:** a run that writes the queue leaves
  `check:handoff-roadmap` green — the regeneration belongs to `writeOpenItems` or the run contract,
  not to the operator noticing.

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
  (c) The heartbeat/stale-reclaim logger seam has no production adopter. (d)
  `evaluateContractPipelineCrossGateOutcomes` / `evaluateContractPipelineCrossGates` are
  hand-maintained parallels; the drift test covers one 2-payload fixture — collapse the
  plain variant to a projection. (e) `describeRequiredTestFailure` inlines up to 8KB per
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

- **recover-ingest / recover-submission leave the last step contract on disk after mutating state
  (2026-08-19, low).** A recovery that resolves items (or clears `host_handoff`) leaves the last
  persisted step contract and prompt document — current-step.json plus current-prompt.md — as a
  live-looking instruction for work that no longer exists; next-step has
  `runWithBlockedStepBackstop` for the class. **Property:** any verb that mutates run state either
  refreshes or invalidates the persisted step contract.

- **`StateStore.mutate` cannot skip the write — a no-op recovery rewrites an identical state file
  (2026-08-19, low).** The locked store's `SKIP_WRITE` sentinel (`lockedJsonStore.ts`) is not
  plumbed through `StateStore.mutate`, so a nothing-to-recover run still replaces the file.
  **Property:** a mutation that returns the input unchanged writes nothing.

- **Recovery phase-binding residuals from the adversarial review (2026-08-19, low, one entry —
  three verified residuals):** (1) the two recovery phases are bound by HEAD, not state identity —
  a concurrent state writer between phases yields a spurious `required_test_failed` (safe
  degradation: refuse, never spawn, never accept); the symmetric fix is comparing the phase-1
  pending-id set / workload sha like HEAD is compared. (2) `recovery.requiredTestVerdicts` enforces
  table-SUPPLIED, not tests-RAN — an untyped JS caller can fabricate a table; a `typeof` narrow
  and/or minting the table type from `precomputeRecoveryTestVerdicts` would close it. (3)
  `gitCommitIsOrphaned` cannot see a detached HEAD in a LINKED worktree (`for-each-ref` does not
  enumerate it) — such a baseline misreports orphaned. All three documented in code comments at the
  guard sites.

- **recover-ingest's commander action branch is untested (2026-08-19, low).** The entry-point test
  reaches `recoverIngestHostResults`; `recoveredNothing`, the two `process.exit(1)` sites, and
  `resolveArtifactsDirOption` are covered only by a manual smoke log.

- **CP-NODE-10 residuals (2026-08-19, low, one entry):** (1) the staleness third-state (`partial`)
  check exempts the 9 map-declared leaves — including `audit-findings.json` — so a truncated leaf
  body is caught only via dependents (choice-vs-forced split documented at
  `classifyArtifactPresence`); (2) `StaleArtifactSet`'s `instanceof` discriminator is dropped by
  `Set.prototype.union`/`structuredClone` (no caller does either today); (3)
  `computeArtifactMetadata`'s producer-side affinity hash is unguarded — a malformed affinity body
  dies loudly at restamp (pre-existing, loud, not a livelock).

- **recover-ingest exits 1 when the only issues are `submission_missing` for genuinely-pending
  work items (2026-08-19, low).** An expected-pending item is not a recovery failure; the exit
  code should distinguish expected-pending from a real issue so operators can script on it.

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

- **The citation gate's verdict depends on transient untracked files (2026-08-19, low, friction:
  tool_should_decide).** The resolution universe deliberately includes untracked non-ignored files
  (staged-new files must resolve), but the bare-name EXTENSION-SKIP set is built from that same
  universe — so an untracked scratch log at the repo root added a new extension to the set and
  flipped an unrelated durable-traps doc line from skipped to failing: the release gate refused a
  tree whose identical docs had passed the commit gate minutes earlier. **Property:** the
  extension-skip set (and any rule that widens/narrows what gets CHECKED) derives from tracked +
  staged files only; untracked files may join the resolution universe as targets but must not
  change which citations are examined. [[a-gate-must-not-ask-the-local-disk]]

- **`writeOpenItems` accepts an item with no `subject_key` and persists it; the refusal lands two
  steps later in the HANDOFF generator (2026-08-14, re-hit 2026-08-19, low, friction:
  tool_should_decide).** `scripts/nightly/items.mjs` consumes `item.subject_key` for carry-forward
  and settled-lookup, and the writer validates probes exhaustively — four distinct refusals — yet
  never checks the field the whole durable-answer mechanism keys on. A missing `subject_key` is
  written to `.audit-tools/nightly/open-items.json`, and only `generate-handoff-roadmap.mjs` refuses
  it, as a BLOCKED COMMIT naming `items[N]` and HANDOFF rather than the item that is malformed. The
  writer already imports `subjectKey`, and every item carries the `subject` it is computed from.
  **Property:** the writer that reads a field either derives it or refuses at write, so the refusal
  names the real defect where it is introduced ([[validator-guards-every-field-caller-reads]]); a
  persisted item missing it is unreachable for [[settled-subject-slips-through-a-reword]] and cannot
  be re-asked correctly.

- **Modularity refinement is superlinear on one large component and unpinned at scale (2026-08-19,
  low).** Measured 78ms at 200 members → 726ms at 800, with Louvain's pass bound at `n + 8`; the
  promoted run's largest component was 33, so nothing exercises the tail. **Property:** refinement
  cost on the largest single component is bounded by a test, or the partition has a latent stall on a
  repo that produces one big eligible component.

- **The TASK draw's coherence eligibility is still disjunctive and has never been measured for
  collapse (2026-08-19, medium).** The findings draw moved to `shared_file AND same_lens`;
  `TASK_DRAW_COHERENCE_POLICY` keeps `weighted_score_threshold` deliberately, because no measurement
  of `buildTaskCoherencePartition`'s components on a real graph exists. **Property:** the task draw's
  eligibility is either measured and shown not to collapse, or aligned with the findings draw's — it
  is not left disjunctive on the grounds that nobody looked.

- **The HANDOFF empty-queue projection contract is full-suite-only, so the commit gates pass a red
  against it (2026-08-18, low, friction).** `handoff-roadmap.test.ts`'s live-tree case (an empty
  nightly queue leaves no hand-written "nightly" text in HANDOFF) is not run by the staged-triggered
  `check:handoff-roadmap` leg — a HANDOFF edit landed through a green pre-commit gate and green
  targeted suites, and only a voluntary full-suite run caught it before push. **Property:** every
  live-tree doc contract either runs in the gate leg that its trigger paths fire, or the gap is a
  declared `uncovered` in guard-reach — never discoverable only by the full suite.

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

- **Diff-based re-review loses the verdict it must diff against (2026-08-08, low).** Repairing
  `finalized_module_contracts` deletes `conceptual_design_critique.*` as stale, then the re-review step
  says "diff against your prior verdict" — which survives only as prose in the step prompt, unreadable
  to the independent reviewer that step demands. **Property:** an artifact a step tells the host to diff
  against is readable when that step runs.

- **`free_form_intent` clause splitter shreds prose on bare `;` (2026-08-08, low).** Splits inside
  parentheticals and `(a) …; (b) …` lists, so fragments are unencodable *because* they are fragments.
  **Property:** split on sentence boundaries; report a count plus pointer, not shredded prose.

- **Answering an intake question at the checkpoint does not clear `open_questions` (2026-08-08, low).**
  `decideNextStep` gates on `intake-summary.json` (`ready` + `open_questions[]`), so resolving at
  `confirm_intent` still routes to `collect_intake_clarifications` until the host edits the summary.
  **Property:** resolved at the checkpoint is resolved everywhere, or confirm names the gate's input.

- **Sweep the test tree for tests that re-implement their subject (2026-08-08, medium).** One live
  instance found and fixed in `c791df49` (see git log). **Why no gate catches it:** such a test is
  green, typechecks, has no unused exports, and coverage counts the replica's lines — knip, eslint and
  the red-green rule all pass a test that pins nothing. **The tell:** a function declared in a test file
  that mirrors production control flow (a `for` over step kinds, a switch over cases) instead of calling
  into `src/`. **Property:** every test either calls production code or is deleted; where a replica
  exists because the subject is undrivable, fix the *untestability* (inject the dependency), not the
  test. Scope: `tests/**`, starting with the harness-heavy audit suites. [[test-must-reach-the-code-it-claims]]

- **Regex-perf triage tail from the analyzer sweep (2026-08-07, low).** The verified-real subset of the
  sonarjs regex findings — six sites processing unbounded audited-repo content — needs per-pattern
  backtracking analysis (atomic groups / restructuring where real); the rest of the family was verified
  false-positive. Sites and triage in
  [`reviews/analysis-tools-plan-2026-08-07.md`](../reviews/analysis-tools-plan-2026-08-07.md) §4/§5.
  **Property:** no regex over audited-repo content is super-linear on adversarial input.

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

- **Contract-type coverage is derived from where TESTS live, not from the contract (2026-07-25, low,
  friction: inefficient-feeding).** `scripts/` is covered by no tsconfig, so a producer there cannot fail
  on a contract it never consults — that is how adding `reviewed_clean` swept `tests/**`, missed the
  `scripts/` producers, and failed release CI ([[lap-green-must-match-ci-evidence]]). AuditResult is
  closed by a per-type gate written by hand for it. **Property:** for every validated contract type, the
  set of construction sites is derivable FROM THE CONTRACT, not from test placement. Not yet designed —
  the doc-manifest data+refusal shape (`2adc716c`) is the precedent to follow, and a typecheck gate is
  NOT (a cast makes it inert, [[test-tree-typecheck-gate-and-its-cost]]).

- **Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong
  implementation (2026-07-24, medium, friction: ambiguous-direction).** The partial-wave entry said
  "M dispatched-but-in-flight" and asserted entanglement with the claim-lease machinery; the primary
  record ([`re-dogfood-2026-07-21.md`](../reviews/re-dogfood-2026-07-21.md) #14 + the run-state section)
  says the tasks were **undispatched** — never granted. Reading the backlog entry first produced a
  claim-liveness discriminator that was wrong and had to be replaced after existing tests refuted it.
  Same family as [[backlog-prose-decays-verify-against-head]] but sharper: the decay was not staleness
  but a paraphrase that changed the mechanism. Property: an entry that reinterprets an incident must
  quote or link the primary record's own words for the mechanism, not restate them.

- **DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low,
  accepted).** The pair itself SHIPPED (intent-equivalence gate wired as the
  `intent_equivalence_current` obligation — `src/audit/orchestrator/nextStep.ts` PRIORITY slot between
  `intent_checkpoint_current` and `charter_extraction_current` — with
  `artifact_metadata.intent_baseline` as the intent entry's revision authority; per-edge dependency
  slices for `charter_register.json` in `src/audit/orchestrator/dependencySlices.ts`; mechanism
  record: [`intent-gate-charter-slice-design-2026-07-23.md`](../reviews/intent-gate-charter-slice-design-2026-07-23.md)).
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

- **⬇ Live-run watch (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a
  malformed-JSON result file — result validity must be checked mechanically, never trusted from
  the worker's claim.** The merge correctly rejected it, but the failure surfaced only as an
  unexplained same-packet re-grant. Properties: (a) results are parse- and
  AuditResult-contract-checked at result-write or pre-merge; (b) the merge's "missing or invalid"
  names WHICH per task (file absent vs parse error vs contract mismatch). Record:
  [`re-dogfood-friction-2026-07-22.md`](../reviews/re-dogfood-friction-2026-07-22.md) #12.

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

- **A delegated step prompt can turn its executor into a second driver (2026-07-16,
  tool-should-decide, medium).** A host worker given one bounded `charter_extraction` prompt followed
  that prompt's embedded `next-step` command and advanced the workflow itself. The same happened in a
  later `systemic_challenge` round. The advance command belongs to the driver, not to the material a
  bounded executor receives. [[enforce-robustness-in-tooling-not-host-discretion]]
  **SPEC — the advance command goes in the DRIVER-facing artifact only, never in the worker-facing prompt.**
  Each step already emits two things: a machine step contract the driver consumes, and a prompt document
  the executor reads. The advance command belongs exclusively to the first. An executor handed a prompt
  with no advance command in it has nothing to obey — the failure stops being a matter of whether the
  worker follows instructions, which is the only way to fix it, since every attempted prompt-text
  mitigation has worked only for as long as someone remembered to write it. **Property to hold:** loop
  advancement is not expressible from the material a delegated executor is given. ⚠ Do not reach for an
  out-of-band control channel or an agent-identity check on the advance command — both are real designs,
  but they add a mechanism to defend a boundary that simply removing the text from one document already
  makes unreachable. Prefer the change that makes the process simpler.

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

- **A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).** After the design-review passes, the drain re-extracting 11 stale artifacts (repo_manifest/graph over 1250 components / 8466 edges, invalidated by a docs commit) exceeded a 2-minute command timeout with no heartbeat — forcing a blind retry at a longer timeout to see if it was wedged or working. Property to hold: a long deterministic drain should emit a progress/phase heartbeat so a caller can distinguish "working" from "wedged" without a retry. Minor; the retry succeeded.

- **Friction walk (niggle-fix lap, 2026-08-07):**
  (1) **tool-should-decide (low):** a host worker landed sound edits but wrote no bound result, so the
  verify stage never ran and the driver re-verified by hand. A work item whose commit exists but whose
  result is missing should surface as explicit partial progress, never disappear as null.
  (2) **tool-should-decide (low):** both implement agents left ~16 stray `*.log` files in the repo
  ROOT despite prompts directing output elsewhere — the recorded offloaded-diff-scope class
  ([[parallel-dispatch-bounded-current-verified]]); driver swept them before commit.
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

- **Friction walk (contract-sweep producer lap, 2026-07-26):** (1) **tool-should-decide (medium):**
  `scripts/` is a whole tracked tree covered by NO tsconfig — `tsconfig.json` includes `["src"]`,
  `tsconfig.test.json` includes `["src","tests"]` with `checkJs:false`. Nothing
  anywhere says "this tree is uncompiled and unchecked"; it is discoverable only by reading both
  configs and noticing an absence. Open property: the set of tracked source trees NOT reached by any
  typechecker should be stated mechanically, not inferred from what the include arrays omit.
  (2) **ambiguous-direction (low):** the backlog entry's own stopgap ("run `verify:checks`, not
  `check`, before pushing") steers the reader toward widening the pre-commit hook — the expensive wrong
  fix, since the legs that caught it repack the package. The cheap right fix was to validate at the
  construction site. A stopgap phrased as a habit reads as the intended remedy; entries should mark a
  stopgap as a stopgap.

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
  site).** Shipped 2026-07-10; the scratch-pollution bug is FIXED in tooling: `buildFileDisposition` now runs an `untracked`
  scope rule (one batched `git ls-files -z`; still-included files absent from the index → `excluded/untracked`,
  guards mirror the gitignore rule) so untracked litter can never enter the auditable scope. A
  `renderHostScratchNote`/`hostScratchDir` pair (`src/shared/prompts.ts`,
  `src/shared/io/auditToolsPaths.ts`) never shipped: ZERO callers, only definitions plus a re-export
  in `src/shared/index.ts` (knip's default mode counts a re-export as a consumer), so it reaches no
  prompt — wiring it into the prompt below, or deleting it, is in scope. The unsound bounded/aggregate exclusion representation was deleted
  outright (a missing disposition record reads as *included* downstream, so aggregation silently un-excluded
  exactly the matched files — per-file records are now mandatory, validator-enforced). Residuals:
  - (a) **Submodule / nested-repo contents are now excluded as `untracked`** (parent `ls-files` lists only the
    gitlink). Consistent with citation grounding (which also can't ground them), but a silent scope change for
    repos with first-party submodules. Ideal fix = `--recurse-submodules` in BOTH the disposition rule and the
    grounding corpora (`findingGrounding.enumerateTrackedFilePaths`, M-B3 `enumerateRepoTreePaths`) as one
    atomic change — never one side alone (re-opens the asymmetry).
  - (b) **`file_disposition` now depends on git index state, which the dependency DAG doesn't track**
    (`dependencyMap.ts` keys it to `repo_manifest.json` only). An index-only change (committing a
    previously-untracked file) won't re-stale a persisted disposition until repo_manifest churns.
    ⬇ Live-run watch: after committing files mid-run-continuity, confirm they enter scope on the next audit.
  - (c) **Scope-rule guard decisions are invisible at the intent checkpoint** — `computeScopePreDigest` reads
    only per-file entries; a skipped rule (`root_untracked`/`share_exceeded`/git-absent fallback) never
    surfaces to the operator despite the summary existing for exactly that purpose.
  - (e) The audit `renderEdgeReasoningDispatchPrompt` (`src/audit/cli/prompts.ts`, `edge_reasoning`
    branch of `nextStepCommand.ts`) single-agent dispatch carries no scratch-dir note (params lack
    run context; one bounded agent writing one results file — lowest-risk path, add if it ever litters).

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

- **Two run-id notions; friction record keyed both ways.** Step envelopes carried `run_id: null`
  all session (path resolves to `friction/run.json`) while host workload artifacts use timestamped run
  ids the shared friction substrate keys by — a substrate-keyed close-out walk was invisible to the
  present_report gate and had to be rewritten under "run". **Property to hold:** one run identity
  across step envelope, dispatch artifacts, and friction record.

- **Auditor severity calibration: 0 of 9 self-audit criticals survived mechanism verification
  (2026-08-06, lead, low).** 3 refuted / 6 downgraded — record in
  [`reviews/dogfood-run-2026-08-06.md`](../reviews/dogfood-run-2026-08-06.md). Open question:
  should synthesis demand mechanism-grounded (not flow-existence) evidence for `critical`?

- **`hostInputPause.ts` says analyzer consent lives in session config; it lives in
  `.audit-tools/audit/analyzer-policy.json` (2026-08-12, nightly, low).** `src/audit/orchestrator/hostInputPause.ts`
  documents `analyzerConsent` as "recorded per-candidate consent decisions (session config)". It
  cannot be: `SessionIntentV1Schema` is `.strict()` with exactly `review_mode` and `observability`.
  Consent persists via `AnalyzerPolicySchema` at `.audit-tools/audit/analyzer-policy.json`. The
  identical claim was corrected in `spec/mechanical-analyzer-layer-design.md` (`4d5987bf`); this is
  its code-comment sibling, left because the nightly's autonomy covers docs only.
  **Property to hold:** doc and code name the same persistence home for consent.

- **`check:memory-citations` cannot see a `[[name]]` cross-link, and 4 are already dangling
  (2026-08-14, nightly, low).** The gate matches only the `memory: <name>` prose form in tracked
  docs, so the OTHER citation form — the `[[name]]` links memories use to reference each other — is
  unchecked. Dangling at HEAD: `per-model-tiering` (from `unified-dispatch-routing-direction`),
  `publish-workflow-hardening` (`audit-tools-run-hazards`), `relax-dispatch-source-forcing` (three
  files), `review-gate-execution-status` (`remediate-extracted-plan-join-architecture`). This is the
  same failure the gate was built for — a pointer nobody can follow re-asserting a deleted design
  with the authority of a citation — and the memory-index header already warns the `[[…]]` half is
  ungated, which makes every prune a hand-audit. **Property to hold:** both citation forms are
  mechanically checked, so pruning a memory cannot silently strand a reference.

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

- **remediate-code step prompts drift from the validators that read their output (2026-08-19, low,
  friction: tool_should_decide).** Remaining instance (the `confirm_intent` `excluded_scope` shape
  is closed by P40's contract test, 2026-08-23; the `created_at` claim was REFUTED — the tool stamps
  it, so the sketches omit it correctly): the `synthesize_intake` prompt mandates checkpoint fields
  (`pre_draft_questions`, `closing_action`, `intent_interpretation`) the `.strict()`
  `IntentCheckpointSchema` does not admit, and the checkpoint read path is an unvalidated cast
  (`readOptionalJsonFile<IntentCheckpoint>` in `src/remediate/steps/nextStep.ts`) so prose strings
  crash `normalize()` deep in path matching. **Property:** a step prompt's schema sketch is derived
  from the same contract its reader enforces, and the checkpoint read path validates before use
  instead of casting.

- **The commit gate's doc-contract leg did not run check:doc-code-citations for a staged
  docs/backlog/durable-traps.md (2026-08-19, low) — verified NOT a trigger-set gap; the underlying
  premise dissolves on inspection.** `check:doc-code-citations` was reported red repo-wide over
  durable-traps.md's bare `` `server.log` `` citation. Re-run at HEAD: exits 0, "every one
  resolves" — and `git ls-tree` at the cited landing commit (`e38616f9`) shows no tracked `.log`
  file there either, so the bare-name rule's `trackedExtensions.has(ext)` guard has silently
  skipped this token all along, never failed it. That skip is not a fresh gap: it's the uncovered
  half `scripts/guard-reach-data.mjs`'s `check:doc-code-citations` row already states verbatim
  ("bare names whose extension no tracked file uses go unchecked"), and the row's `preCommit:
  'reach'` already unions `**/*.md` — so the doc-contract leg's trigger set does cover
  durable-traps.md; nothing narrower is in play. The separate, real 2026-08-19 incident (a stale
  glossary-ids.md citation invisible because it was never backticked) is already fixed by `fe48db4c`.
  The reworded token (this batch) sidesteps the loophole rather than leaving it live.
  **Property:** the extension-skip rule exists to exclude non-file tokens (`vi.spyOn`,
  `claude.exe`) but also hides genuinely file-shaped non-repo mentions like `server.log` — open
  question for the owner is whether that trade stays accepted as-is (reword such tokens out of
  backticks, as done here) or the rule should distinguish "no plausible non-file reading" before
  skipping; no trigger-set widening is needed either way.
