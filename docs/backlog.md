# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Make the loop cheaper — SELF-SCALING pipeline: COMPLETE** (design of record: [`self-scaling-pipeline-design.md`](../spec/self-scaling-pipeline-design.md)). One pipeline self-scales via two dials on a shared intake risk/complexity signal: (A) **adversarial depth** — critique/counterexample scale from an inline light self-check (low) to full independent sub-agents (high), floor = LIGHT never zero; (B) **granularity / round-trips** — degenerate phases collapse by structure, round-trip count = f(complexity), optimistic-start + escalate-on-evidence. All slices shipped: 1 degenerate-phase-collapse + 2 shared signal + 3a adversarial-depth dial (`adversarialDepthForTier`, 0.30.23) + 3b lean-light-review gate (0.30.24) + 4a escalate-on-evidence (`decompositionRiskEvidence`/`escalateRiskSignal`) + **4b granularity collapse** (`roundTripGranularityForTier`: low ⇒ the framing phases {goal,context,decomposition} fold into ONE round-trip via `buildCollapsedFramingStep`; medium/high stay fine; best-effort — any omitted/invalid member re-emits fine-grained via `nextMissingContractPhase`; un-collapses on a 4a escalation since the dial is read per next-step off the post-escalation signal; tests `tests/remediate/granularity-collapse.test.ts`). Signal computed from intake-available data only, fail toward MORE scrutiny when uncertain; whole-repo green gate never scaled. _Nothing open on this track._
- **Data-loss on a GENUINE fail-loud commit-refusal — FIXED 2026-06-26.** The commit-refusal path in `acceptNodeWorktree` (e.g. the CE-003 generated-artifact-under-scope fail-loud) removed the worktree WITHOUT quarantining the worker's uncommitted source edits. New `quarantineUncommittedWorktreeEdits` stages-all (git add -A honours .gitignore, so the offending artifact + node_modules churn stay out) + a preservation commit on the node's ISOLATED branch (never cherry-picked into main), then points a durable `refs/remediation-quarantine` ref at it — wired into the `commit.error` path before `removeWorktree`. Test `dispatch-worktree.test.ts`: real src edit + offending generated artifact ⇒ fail-loud still refuses to land BUT the src edit is preserved under a quarantine ref, never in main HEAD. Generalizes [[enforce-robustness-in-tooling-not-host-discretion]].
- **Contract-pipeline host-friction inventory — points where the tool makes the HOST decide / feeds ambiguous direction / orders work inefficiently.** Each a "fix in tooling, never host-remembers" item. **(A) Ambiguous backend direction:** (A1) a conceptual critique returning `approved_with_concerns` while marking items `severity:blocking` PROCEEDS (only `rejected` triggers repair) — a blocking item in a non-rejected verdict is contradictory; route it to repair (or forbid the combo). (A2) the **judge phase isn't marked MANDATORY-independent** (unlike critique/critic), so the host decides whether to delegate — the tool should state it (memory: delegate the judge too). (A3) the merged-base check command ("`npm run check` / tsc") is **unpinned** — the contract should pin the exact command. **(B) Tool should decide FOR the host:** (B2) `implementation_dag` skeleton offers one node per obligation and leaves merge-vs-split to the host — for a 1-module/1-file change the tool should derive 1 node; (B3) advisory critique items have **no structural slot** — the host smuggles them into test assertions; needs a first-class "advisory-must-shape-implementation" carrier; (B4) `created_at` timestamps are **host-invented** (host has no clock) — the tool should stamp them; (B5) the remediation commit lands on a branch off main and the host must manually checkout+merge ([[audit-tools-worktree-traps]] strand-trap; tool should offer/auto the main merge). **(C) Inefficient order / feeding:** (C2) `goal_spec`/`context_bundle`/`module_decomposition`/etc. are host-authored boilerplate for a one-file fix the tool could mostly pre-derive; (C3) unchanged obligations force a **full re-author of their test-plan assertions every repair round** (no diff-carry). **(D) Gate/RMW frictions:** (D1) CE-006 negative-scoping gate reports only AFTER write → re-emit loops; surface the expected changed-symbol anchors per obligation IN the skeleton; (D3) validate-artifact in-place envelope re-wrap means the on-disk file ≠ what the host wrote (write-plain-then-it-wraps hazard).
- **Friction DETECTION is mechanical-only — semantic/process friction goes uncaptured; close-out recall UNDER-captures.** Proven repeatedly: the close-out named-dimensions recall prompt does not force a transcript/run-log WALK, so the host logs a few and misses many real frictions; "no friction" satisfies the gate. A host-kept journal does NOT fix this (same host-discretion anti-pattern). **Enforceable direction: the backend already OBSERVES most friction at its own step boundary — no transcript needed.** Nearly every friction is a backend-side event (a phase re-emitting the same gate errors N×, a judge repair round + back-half re-derive, an artifact rejected/archived, an obligation-ledger renumber, a no-change merge). Fix = (1) **auto-capture at the step boundary** (zero host discretion) for every such event; (2) **close-out becomes per-event RECONCILIATION not recall** — surface the backend-counted event list and force the host to disposition EACH (keep/annotate/dismiss-with-reason), like the review-gate; a blanket "no friction" is impossible because the tool already knows the phase fired N×; (3) keep an always-present **free-form channel** for transcript-only friction the backend can't see. The shared step-boundary chokepoint (`stepBoundaryCapture.ts`) + the named emitters + per-event reconciliation triage are shipped; **remaining: the M-QUOTA bounded-escalation event is not yet wired to the chokepoint, and a live run must confirm the emitters actually populate the close-out.** ROOT CAUSE found 2026-06-26: `HostSessionQuotaSource.recordLimit` (the method that drives the bounded escalation) has **ZERO production callers** — only the unit tests call it. So the *entire* `recordLimit → escalate → strand (rollingDispatch.ts:510 `isPacketEscalated`) → quota_escalation friction` chain is unwired end-to-end, not merely the friction tap: nothing records a host-session re-limit during the in-process rolling dispatch, so `isEscalated` is always false, the strand guard never fires, and there is no event to capture. The friction tap (`onEscalation → captureStepBoundaryFriction`) is the LAST link; before it, a correct fix must (1) call `recordLimit(packet.id, …)` at the rate-limit observation point in `createRollingDispatcher.handleResult` (`result.outcome === "rate_limited"`), which requires threading the SAME `HostSessionQuotaSource` instance through `buildConfirmedPools` → `driveRollingDispatch` → `createRollingDispatcher` (today buildConfirmedPools constructs a throwaway instance with no `onEscalation` and never exposes it); (2) derive `isPacketEscalated` from that instance; (3) route `onEscalation` to the chokepoint with the driver's artifactsDir/runId. Multi-seam integration gated on a live rate-limited multi-worker run to validate — fits the **dispatch capability-tiered driver** forward track (which owns the same instance-threading), not a blind batch landing. [[meta-audit-friction-must-be-tool-enforced]]
- **Selective-deepening tasks never converge — packet result task_id ≠ assigned `deepening:*` id.** Workers returned packet-style task_ids instead of the assigned `deepening:finding:*`, so merge-and-ingest never matched results to tasks and looped. The prompt-side fix (explicit task_id binding in `buildTaskSections`) is in place but **needs live validation** — can't be verified without a real deepening-capable run. Recovery until validated: quarantine orphan pending `deepening:*` tasks to let synthesis run.
- **Dispatch capability-tiered driver on top of the (shipped) host-quota wiring.** `HostSessionQuotaSource` is wired first-class into the scheduler (graduated `remaining_pct`, pre-wall LOW/CRITICAL bands, escalation-stranding) and the `rate_limited` non-consuming re-queue is in place. **Remaining:** the capability-tiered *driver* (Y-dispatcher vs slot-pull selection) on top of it — see the broker-driver forward track below.

## Forward tracks

- **Contract-pipeline repair cap → convergence-based termination — SHIPPED 2026-06-26.** The judge↔repair loop no longer stops at a fixed N=2 with proceed-with-residual-risk. `evaluateJudgeGate` diffs each new judge report's accepted counterexamples against the cumulative already-addressed set (`repairs[].accepted_ce_ids`): approved ⇒ proceed (fixpoint); a NEW accepted CE ⇒ repair (progress); every accepted CE already addressed with none new ⇒ **escalate** (a blocked user-decision step naming the outstanding CEs, routed through the friction chokepoint) instead of silently shipping residual risk; `MAX_CONTRACT_REPAIR_ITERATIONS` repurposed as a LOUD runaway backstop (2 ⇒ 8) that itself escalates. A deep-but-converging run is no longer cut mid-convergence; genuine non-convergence is surfaced. Tests: stall→blocked + deep-progress→keep-repairing (`contract-pipeline-adversarial.test.ts`); INV-03 rewritten (`remediate-pipeline-inv.test.ts`).


- **Remediator must mechanically decompose + boundary-enforce arbitrary multi-goal scope — stop forcing the host to phase by hand (Ethan, 2026-06-24, VERIFIED recurring).** When `/remediate-code` is pointed at a large multi-item input (e.g. the whole backlog), the contract pipeline produces a correct reconciled design but then expects the host to execute all tracks as ONE run; the independent design-critique repeatedly returns *blocking over-scoping* and the host has to manually re-scope to a phase. This keeps happening and shouldn't — it is the tool's core job, not the host's. The remediator must, by construction: (1) break an arbitrary number of goals/changes into well-defined, well-bounded tasks; (2) **strongly define the boundaries between tasks and write boundary tests that mechanically enforce them** (not prose `seam_adjustments` notes — review concern C-002: edit-order DAGs asserted in prose over shared files like `staleness.ts`/`dispatch.ts` are a host-discretion anti-pattern + latent merge-break); (3) separate the bounded tasks into **parallel work units with mechanical scheduling dependencies** (block A blocks-on block B) so the wave scheduler honors ordering without the host remembering; (4) derive phasing itself (foundations → consumers → review/slivers) from the dependency DAG rather than emitting one monolithic run the critique then rejects. Generalizes *enforce-robustness-in-tooling, never host discretion* and the *no monolithic change* / failure-isolation principles. Consumer modules (F1/F3/F4/F5/F6) shipped 0.30.5; the **foundations O1/O2/O3 are also shipped** (merged `cd089066`, content-key seam + append-only idempotent ledger + friction triage + repair seam, with tests — verified 2026-06-25, see `.audit-tools/phase-status-investigation.md`); the prior "foundations remain unshipped" claim was stale handoff drift. The rolling-dispatch same-file merge-serialization fix (a)+(c) shipped 2026-06-25 (file-ownership-disjoint scheduling + cross-node seam-signature guard; (b) no-op-satisfied was already shipped). The full module map, reconciled seams, and verified design invariants (CE-001…006, FC blocking concerns) are the canonical design doc [`backlog-remediation-design.md`](backlog-remediation-design.md).
  - **Boundary-enforcement substrate HARDENED 2026-06-26** (foundations-phase remediate run, 5 commits `6133d666`…`bb7f87fa` on main; full suites green — remediate 1919, audit+shared 3269, 0 fail). Shipped: (1) `touched_files` now **first-class + REQUIRED** on `RemediationBlockSchema` + `validateRemediationBlock` (empty array allowed, omitted rejected) so the declared write-scope is a guaranteed seam, not optional; (2) **CE-003** deterministic partial-capacity admission — `admitSubWaveUnderCapacity` returns the block_id-ordered PREFIX (reproducible, not a ClaimRegistry race); (3) **CE-006/CE-007** claim-retaining dispositions — `NodeClaimDisposition` + `isReleasingDisposition` single-source, `redispatchInFlight` retains the file claim across triage-retry/redispatch; (4) **CE-008** `mergeBlocksSharingFiles`/`groupFindingsByFileOverlap`/`splitBlocksByContextBudget` comparisons pinned to `canonicalizeFilePath` so plan-time merge and schedule-time disjointness agree cross-platform; (5) **CE-005** `classifyProvider` collapsed to ONE `{hostClass,concurrencyFloor,driverMechanism}` struct with the separable floor-constant exports removed (floor mechanically un-re-derivable); plus convergence guard tests locking all dispatch through the broker+boundary. Most other substrate (OwnershipRegistry, broker primitive, `emitValidateRepair`/schema-enforced-emit, `HostSessionQuotaSource`) was verify-before-fix already-present.
  - **Auto-phasing — phase-cut DERIVATION shipped 2026-06-26; downstream threading remains.** The tool now derives the foundations→consumers phase cut itself instead of leaning on a host re-scope at intake. New pure primitive `src/remediate/contractPipeline/phaseCut.ts`: `derivePhaseCut` assigns each module a tier = longest dependency chain (foundations = 0) over the module-dependency DAG — deterministic, cycle-safe (a cycle is flagged + tiered together, never dropped), out-of-scope edges ignored; `phaseCutModulesFromContracts` builds the DAG from the drafted module contracts' directional `neighbor_needs` (present by the critique phase ⇒ no schema change). Wired at the `critique` dispatch in `buildNextContractPipelineStep`: a genuine multi-phase cut is handed to the conceptual critique with an anti-over-scoping directive (assess design quality WITHIN the phasing, don't reject breadth — phases land incrementally, scheduler-enforced ordering). Tests `tests/remediate/phase-cut.test.ts`. **STILL OPEN:** persist the derived cut as a first-class artifact and thread the phase ordinals into the `implementation_dag` node `dependencies` (so `rollingDependencyLevels` honours the derived foundations→consumers ordering end-to-end) + a per-phase whole-repo green checkpoint surfaced to the user. The derivation is the unshipped-core that's now shipped; the downstream consumption is the remaining wire. (Ethan, 2026-06-26.)

- **Content-addressed, granular staleness — kill whole-artifact re-derive churn.** Staleness today is
  whole-artifact: changing one unit's intent re-stales an entire downstream artifact (e.g. the coverage
  matrix), which re-runs *all* of planning and re-touches *all* results, even for units that didn't change.
  Desired: staleness keyed at the granularity of the actual unit of work (per-unit / per-task, content-addressed
  by a stable content hash) so only the work whose inputs genuinely changed re-derives; unchanged work is skipped
  by construction, not re-run-then-deduped. This is the natural partner to the append-only results ledger
  (results keyed by content hash → an unchanged task keeps its result at zero recompute), but it stands alone as a
  general DAG-model change applying to every derived artifact, not just results. (Ethan, 2026-06-24.)
  - **SHIPPED 2026-06-25 — O3 re-dispatch + record/consume/supersession wired (per-result granular staleness now LIVE).**
    The seam is no longer unconsumed. Landed atomically: (1) **O3 drift re-keying** — `rekeyDriftedResults`
    (`resultBaseline.ts`) detects, at ingest, a base result whose live task-content signature drifted from its
    recorded baseline and promotes it to `emit_source:'redispatch', attempt:N` (persisted on `AuditResult`) so it
    earns a DISTINCT `idempotency_key` and `appendResultsToLedger` accepts the fresh findings instead of no-opping;
    (2) **record half** — the ingestion executor refreshes `result_baselines` for the just-ingested batch against
    live task content, persisted via `computeArtifactMetadata` (prefers the bundle's manifest, CE-007-gated);
    (3) **consume half** — `computeStaleResultTaskIds` + `state.ts`/`packetFilter.ts` treat a drifted task as
    not-complete so it re-dispatches (single-sourced across gate + dispatch); (4) **supersession** —
    `selectCurrentResults` (keyed on `task_id`, NOT one-to-many identity_key) collapses a base lineage to its
    highest attempt so a re-audit's dropped findings vanish from synthesis (applied at the synthesis call site;
    `mergeFindings` stays a pure merge). Converges: re-derive fires once, re-dispatch lands fresh findings, the
    baseline refresh silences the loop. Tests: `tests/audit/o3-redispatch-drift.test.mjs` (drift→rekey→append→
    supersede→converge, sibling non-collapse) + existing baseline/staleness/dedup suites green. **Still open:** the
    general DAG-model extension (per-file coverage-matrix elements, per-element baselines for every derived
    artifact) — `runPlanningExecutor` rebuilds+rewrites `coverage_matrix` whole, so that needs an incremental
    planning executor, not just a staleness gate. (Ethan, 2026-06-25.)
  - **Investigation 2026-06-25 — premise correction + the real blocker.** The per-element result-baseline seam
    (`src/audit/orchestrator/resultBaseline.ts`: `perElementStalenessVerdict`, `deriveLiveResultKeys`,
    `recordResultBaseline`, `isResultStaleAgainstBaseline`) is **fully built and tested but has ZERO production
    callers** — `result_baselines` is only *carried forward* in `artifactMetadata.ts:149`, never *recorded* on
    ingest nor *consumed* in `state.ts`. So per-result granular staleness does not run today; the premise that
    it "works as the ledger's partner" is false. **Why it was left unconsumed (the real blocker):** the obvious
    consumer — re-dispatch a task whose live task-content signature drifted from its baseline — is **semantically
    unsound until O3 lands the redispatch-attempt counter.** `task_id` and `idempotency_key` are both
    signature-STABLE (keyed on `{unit_id, lens, pass_id, path/source}`, NOT file content), so a content-drift
    re-dispatch returns a result with the SAME `idempotency_key` → `appendResultsToLedger` no-ops (INV-2) → the
    fresh findings are **dropped**, and the task would loop re-dispatching with no findings update until the
    baseline refresh silences it. For the consumer to actually replace stale findings, a drifted re-dispatch must
    carry `source: 'redispatch', attempt: N` (a DISTINCT idempotency_key so the ledger appends) — the
    `emitSourceFor`/seam comments already anticipate this ("Re-dispatch attempts are not yet stamped on results;
    when O3 adds an attempt counter it maps to `source: 'redispatch'`"). **Ordering, therefore:** (O3-redispatch)
    stamp drifted re-dispatches with an attempt counter → distinct idempotency_key → ledger appends fresh findings;
    THEN wire record-on-ingest (`refreshResultBaselines` over incoming results vs. live task content, persisted via
    `computeArtifactMetadata`) + consume-in-derive (a drifted result's task_id treated as not-complete so it
    re-dispatches, single-sourced across `state.ts` and `cli/dispatch/packetFilter.ts:buildPendingAuditTasks`).
    Record half refreshes the baseline even on a no-op ledger append so the loop converges. The general
    DAG-model extension (per-file coverage-matrix elements, per-element baselines for every derived artifact) is a
    SEPARATE, larger track on top of the wired result path — `coverage_matrix` is per-file
    (`CoverageFileRecord[]`) and `runPlanningExecutor` currently rebuilds + rewrites it whole, so per-element
    re-derivation also needs an incremental planning executor, not just a staleness gate. (Ethan, 2026-06-25.)

- **Codebase-wide review for churn / context / enforce-in-tooling — same lens, applied everywhere.** The
  append-only-ledger + granular-staleness + LLM-equivalence-gate work came from one perspective; run that same
  perspective over the *entire* codebase as a dedicated pass. Hunt for: (a) **unnecessary churn** — anywhere we
  recompute / re-derive / re-dispatch more than the actual delta demands (LLM judgment to gate expensive
  recompute is one tool among others); (b) **unnecessary context** — anywhere we ship or re-ship more than needed
  into a prompt or a step (diff-only / delta-only feeds are one strategy among others); (c) **enforce-via-tooling
  prevention** — anywhere a correctness property is currently held by host/maintainer discretion that could be
  made impossible-to-get-wrong at the abstraction so the issue never arises. Not limited to the named techniques —
  the goal is the perspective, applied broadly. (Ethan, 2026-06-24.)

- **Schema-enforced generation everywhere possible — make malformed output impossible, not merely repairable.**
  Strict output schemas already exist (e.g. the worker zod schemas) but are shipped to workers only as *advisory
  reference files*; nothing forces the provider to honor them at generation time, so malformed contracts get
  emitted and only caught after the fact. Desired end-state: every structured-contract emission in the project —
  every dispatch path, every emitting agent, both orchestrators — uses the provider's strongest available
  output-constraint mechanism (forced tool-call / JSON-schema-constrained generation / structured output) so the
  schema is enforced at emit time and the malformed-output class is prevented at the source. Apply it everywhere
  a provider supports it; where a provider cannot enforce a schema, that path degrades to the layered repair seam
  (above) as the fallback — prevention first, repair as backstop. Must stay provider-agnostic: discover the
  enforcement capability per backend, never hardcode it. (Ethan, 2026-06-24.)
  - **Emit-time seam VERIFIED already-present 2026-06-26** (foundations-phase run, M4-SCHEMA node = `resolved_no_change`): provider-agnostic capability discovery (`discoverOutputConstraintCapability` on the `FreshSessionProvider`, switches on provider KIND + operator config, no model table), strongest-at-emit via `enforceSchemaAtEmit`, degrade-to-`runEmitValidateRepair`, and the ONE-VALIDATOR re-validate floor all exist in `src/shared/providers/*` + `src/audit/contracts/schemaEnforcedEmit.ts` + `src/shared/repair/emitValidateRepair.ts`. **Still open:** CE-004 — the always-on conversation host (`claude-code`) advertises *no* API-level constraint mechanism, so on the primary path this reduces to the ONE-VALIDATOR repair floor (no emit-time prevention); and CE-009 — semantically-wrong-but-schema-valid output (e.g. `total_lines` ≠ actual) is not schema-catchable. Both recorded as acknowledged residual.

- **Tool-enforced dispatch broker with a capability-tiered driver — rolling dispatch the host can't get wrong.**
  Observed 2026-06-24 (Claude Desktop, a known capable host, not first contact): the host ran review packets in
  fixed waves with a barrier between them rather than rolling, and `max_concurrent_agents` sat at the cold-start
  floor of 3. Root cause is host-discretion-via-prose: the contract hands the host the *entire* packet plan plus a
  prose request to "maintain N concurrent, refill as each completes," with no structural gating — and `claude-code`
  is classified as a `hosted` provider that, reporting no active-subagent capacity, falls through to the hosted
  first-contact default instead of the agent-host concurrency. Desired end-state:
  (1) **A tool-enforced dispatch broker as the single chokepoint.** One gated primitive set — read quota, estimate
  per-task tokens (deterministic + local, per standing policy — never API token-counting), dispatch-an-auditor
  (refuses if it would exceed slots / rate / token budget), await-next-completion. No dispatcher can over-dispatch
  because the broker is the only door and it counts. This is the enforcement layer and it is independent of who
  drives.
  (2) **A capability-tiered driver, Y-primary.** Where the host supports agent nesting, the orchestrator dispatches
  a single thin *dispatcher agent* (Y) that runs the rolling loop through the broker tools and spawns auditors up to
  the gated limit — keeping the orchestrator's own context uncluttered. Y performs **no judgment**: it only picks the
  next task and refills slots; it reads quota via tools, never decides the limits. Spin Y only above a task-count
  threshold (below it the overhead isn't worth it). Where the host can't nest, the top host drives directly through
  the *same* broker, which releases the next slot only on a completion callback (slot-pull) — same enforcement,
  humbler driver. The broker is the constant; the driver tiers by host capability (everything-agnostic).
  (3) **Classify capable agent hosts off the cold-start floor.** A host that runs parallel subagents (Claude Desktop
  / `claude-code` / `vscode-task`) must get agent-host concurrency, never the hosted-API first-contact cap. The
  broker's cap comes from proper host classification + learned per-(provider, account, model) quota, not the hosted
  default constant.
  Enforcement (broker), driving (Y / slot-pull), and judgment (the repair + staleness seams) are separate layers:
  Y never judges; bounded judgment lives at its own named seams; and when a judgment call costs a dispatch it flows
  through the same broker like any auditor task. See the enforcement/driving/judgment separation principle in memory.
  (Ethan, 2026-06-24.)
  - **Single-source classifier SHIPPED 2026-06-26** (foundations-phase run, M5-BROKER node; CE-005). `classifyProvider` now returns ONE exported struct `{hostClass, concurrencyFloor, driverMechanism}` from `src/shared/quota/scheduler.ts`, and the separable floor constants (`DEFAULT_FIRST_CONTACT_CONCURRENCY` / `DEFAULT_AGENT_HOST_CONCURRENCY` / `agentHostFallbackConcurrency`) are **removed from the public surface** (now private module consts), so no call site can re-derive a concurrency floor — the floor comes only off the struct (capable agent hosts lifted to 8, cold-start 3). The broker primitive itself (`computeDispatchCapacity` never-over-dispatch caps, deterministic-local `estimateTokensFromBytes`, `HostSessionQuotaSource` channel-isolated recordLimit + bounded escalation) was verify-before-fix already-present and is now covered by `tests/remediate/quota-scheduler.test.ts` inv-1..9. **Still open:** the capability-tiered *driver* (Y-dispatcher vs slot-pull selection beyond mechanism-gating) and proactive pre-wall quota-aware pacing remain to wire onto this hardened classifier.

- **Deterministic analyzers: own-vs-acquire — build the agnostic acquisition engine, don't expand a fixed bundle.**
  A fixed bundle of analyzers fails the everything-agnostic test (it privileges whatever ecosystems we bundled
  for). The ideal end-state is a mechanism that **acquires and runs the right ecosystem-native mature tool on the
  fly** — also cheaper to own than a pile of per-language integrations (generalizes the two-tier dependency policy:
  don't hand-roll a Ruby analyzer, shell out to the mature one). Concretely:
  (1) **Own only truly-agnostic extractors** — signals with no ecosystem tool: git-history mining (its own track,
  below) and text/git-based secret scanning.
  (2) **Acquire everything ecosystem-specific on demand** (eslint, rubocop, clippy, mutation testing, hadolint,
  actionlint, type-coverage, jscpd, osv-scanner, …): detect ecosystem deterministically → capability-probe the
  runner (`npx`/`pipx`/`cargo`/`bundle`/…) → run ephemerally → normalize through the existing adapter seam →
  degrade-to-empty when runtime/tool is absent. The build is the *engine*; each tool is a registry entry + one
  normalizing adapter.
  (3) **Selection/safety gate without a maintained allowlist** — enforcement is mechanical run-safety written once
  (capability-probe, pin versions, sandboxed/read-only, degrade-to-empty, report-skipped-never-silently); a small
  value-curated DEFAULT set (high-likelihood × high-leverage × low-overhead — eslint/semgrep/gitleaks/git-mining/…)
  runs without asking; the LLM proposes ecosystem-appropriate tools for the repo; anything beyond the defaults needs
  per-run user consent (ephemeral, nothing persisted). No exhaustive allowlist to curate.
  (Ethan, 2026-06-24.)

- **Git-history mining as an owned, language-agnostic extraction source.** Mine `git log` (not the AST) for
  signals static analysis structurally cannot see: co-change coupling (files that change together = hidden coupling
  the dependency graph misses), churn × complexity hotspots (the real risk concentration), and author concentration
  / bus-factor. Language-agnostic by nature, purely mechanical, feeds architecture (coupling), maintainability
  (churn) and the risk register at once. A distinct extraction source (a new input, not just another analyzer behind
  the adapter seam) — hence its own track. (Ethan, 2026-06-24.)

- **Remaining deterministic-analyzer work (DEFERRED).** The external analyzers landed as
  fixture-validated **adapters** (parse + normalize + degrade-to-empty behind the seam); actually
  **spawning** a live native engine and wiring its real output is the acquisition engine specced under
  Forward tracks (own-vs-acquire) — the adapters are ready for it. **dead-code** stays deferred: a sound signal needs
  the full file universe (pure orphans emit zero edges) + entrypoint provenance — knip/ts-prune
  territory, not a hand-rolled edge query (the shipped `deletion_candidate` low-in-degree signal covers
  the cheap version). The graph-query heuristics (cycles / hub / orphans / deletion-test) and
  extraction-persisted complexity / duplication / seams remain DONE (`deriveGraphSignals` pure reader).
- **Cross-provider quota — LIVE-endpoint confirmation.** The per-provider mappings are validated against
  live-*shaped* fixtures and the capacity fold; confirming each source against its **real** endpoint
  (Claude/Codex live; Copilot/Antigravity gated→degrade) is environment-bound and still a recorded-
  evidence task, not a code gate. Per-provider recipes: [`cross-provider-quota-matrix.md`](../spec/cross-provider-quota-matrix.md).
  Red line: self-monitoring own-provider only, never IDE-GUI automation.

## Deferred / waiting

- **A2 finding-quality oracle** — the `score-audit` scorer is built; it needs operator-authored
  `corpus/<run-id>.labels.json` (hand-labeled real audit runs) before it can score precision/recall/hallucination.
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built; remaining is
  the release-time manual GUI checklist run ([`host-validation.md`](../spec/host-validation.md)) + a gated Codex
  live-dispatch e2e.
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned subtasks
  (can't be unit-tested; user-owned). Folds into the A7 checklist.
- **Gated live e2es** skip without creds: `RUN_NIM_E2E=1`, `AUDIT_TOOLS_LIVE_QUOTA=1`, `RUN_CODEX_E2E=1`,
  `RUN_AUTONOMY_E2E=1`.
- **Provider `queryLimits`** deferred — an absent method and a `null` return are handled identically, so stubs
  change nothing; revisit if a provider gains a real proactive rate-limit endpoint.
- **headroom proxy** — enable + validate the `headroom proxy` (auto-compresses tool-output traffic) in one
  opt-in session before any global env flip; delete the vestigial `DO_NOT_TOKEN_WRAP_NOTE` in `prompts.ts` if
  proxy traffic doesn't need it.
- **Narrow staleness on prose-heavy artifacts via bounded semantic judgment, not per-field proof.** Prose-heavy
  fields (design_spec narrative, rationales) feed downstream LLM prompts, so a cosmetic edit currently re-fires
  staleness and forces wasteful re-emit even when the meaning is unchanged. The desired narrowing is NOT a
  hand-maintained per-field rule that a maintainer must prove and re-prove safe every time a prompt changes — that
  is brittle and incomplete by construction. Instead: a bounded judgment that decides whether the *meaning* relevant
  to downstream consumers actually changed, fail-safe in one direction only — **uncertain ⇒ treat as changed ⇒
  re-derive** — so a wrong call can only cost churn, never silently retain stale state. Efficiency-only; defer until
  re-emit churn on these fields is measured as a real cost.

## Doc-set hygiene (enforced)

- **Canonical doc set is mechanically reconciled.** `scripts/check-doc-manifest.mjs`
  (in `verify:release`) fails the build if any tracked `docs/**/*.md` is absent from the
  routing table in [`doc-review-guidelines.md`](doc-review-guidelines.md), or a row points
  at a deleted file. A stray/dated doc can no longer accumulate silently — it must be
  registered (type + reason) or deleted. The doc-review routine adds the soft layer:
  existence-review every run + version/date/status strings are escalate-not-auto-bump
  (a doc whose only diffs are version bumps is a status doc → propose generate-or-retire).
  Durable design captures go to a canonical design doc or backlog/HANDOFF, **never** a
  dated `*-plan-of-record.md` in the tracked tree (the gate now rejects the latter).

## Durable traps (environment / tooling reference)

Standing gotchas worth keeping for any agent (strong or weak):

- **Remediate-code worktree branches strand commits off main.** Remediate runs on isolated git worktree branches; those branches are never auto-merged. Any doc or code fix applied inside a remediate run lives on a branch like `remediate-CP-BLOCK-IMPL-*` and never reaches main unless explicitly cherry-picked or merged. Effect: the doc-review nightly routine (which reviews main) keeps re-surfacing the same findings indefinitely. Symptom: same doc-review items reappear every run, including items you believe were already fixed. Fix: after a remediate run that touches docs or code you want on main, merge or cherry-pick the relevant commits before the next nightly run.

- **`.gitignore` artifact-tree re-include structure (don't flatten it).** The managed block ignores the
  `.audit-tools/` runtime tree at the CONTENTS level (`.audit-tools/*`, `.audit-tools/*/*`) and re-includes the
  tracked deliverables + `*/agent-feedback.jsonl` — never as a blanket `.audit-tools/` dir-ignore, because git
  cannot re-include a file under an excluded directory. Private ⇒ deliverables tracked; public ⇒ blanket-ignore.
  Single-sourced in `src/shared/io/gitignoreArtifacts.ts` (`renderGitignoreBlock`), idempotent against the
  committed block. If you ever see deliverables un-trackable, it's a stray blanket `.audit-tools/` line OUTSIDE
  the managed markers — delete it, the managed block owns the tree.
- **Tool-managed ignore patterns for runtime artifact dirs MUST be anchored to `.audit-tools/`**, never a
  bare `**/<name>/` — an unanchored glob (e.g. `**/friction/`) regenerates on every `ensure`/postinstall and
  can shadow a same-named SOURCE dir (`src/shared/friction/`), which a file-level edit can't fix. (`.audit-code/`
  is fine — distinct name, no source collision.)
- **CLAUDECODE** is set in-session → UNSET for true-green gate runs (`env -u CLAUDECODE …`; set = one
  audit-code provider test fails).
- **Fresh git worktree lacks `node_modules`** → `audit-tools/shared` resolves a stale `dist/` (spurious
  "no exported member") → run `npm install` in the worktree first.
- **`node --test` needs the tsx loader**: `node --import tsx/esm --test <file>` (bare `node --test` can't
  resolve `audit-tools/shared` via tsconfig `paths`). Same for `npm run test:single`.
- **Don't mask the test exit code.** `node --test … ; echo "exit=$?"` and `npm test > out; echo done` report
  the *trailing* command's exit, not the suite's — and piping through `grep`/`rm` in the same Bash call races
  the output file, so a real failure reads as "green." Capture the suite's own status: `npm test > out 2>&1 &&
  echo PASS || echo "FAIL=$?"`. (Mis-reading a masked exit shipped a release whose CI then failed.)
- **Global `-g` install defers `postinstall`** (npm allow-scripts) → the host-integration deploy silently
  skips; finish with `npm i -g --allow-scripts=audit-tools` or `node "$(npm root -g)/audit-tools/scripts/postinstall.mjs"`.
- **The Bash tool mangles Windows backslash paths** (`C:\a\b` → `C:ab`) → use forward slashes or the
  PowerShell tool for absolute-path commands.
- **PowerShell**: assign `foreach` output to a var before piping to `ConvertTo-Json`; `-Filter` is not regex
  (use `Where-Object -match`); single-element arrays unwrap in `ConvertTo-Json` (bracket-wrap the payload).
- **When you delete a *shipped* file, grep the smoke/verify scripts** for a `requiredPackagedPaths`-style list
  (the packaged-smoke gate asserts specific tarball files).
- **Async typecheck hook = stale-dist false alarm** after a shared-source edit (it runs `tsc` before the
  central rebuild); the authoritative gate is `npm run check` after `npm run build`.
- **`t.mock.module` is unusable** under the tsx/esm loader → use a dependency-injection seam instead.
