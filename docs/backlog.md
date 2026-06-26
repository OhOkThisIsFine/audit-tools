# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **`.gitignore` `**/friction/` swallowed the SOURCE dir `src/shared/friction/` — FIXED AT THE GENERATOR 2026-06-26.** Root cause was `ALWAYS_IGNORE_PATTERNS` in `src/shared/io/gitignoreArtifacts.ts` rendering an unanchored `` `**/${FRICTION_CAPTURE_DIRNAME}/` `` (= `**/friction/`) into the tool-managed `.gitignore` block — so it regenerated on every `ensure`/postinstall and re-shadowed the source tree (a file-level edit alone could not stick). Fixed by anchoring to `` `.audit-tools/**/${FRICTION_CAPTURE_DIRNAME}/` `` (the friction sidecar only ever lives under the artifact tree). `tests/shared/gitignore-artifacts.test.mjs` now asserts the anchor + the no-source-shadowing invariant. General rule: tool-managed ignore patterns for runtime artifact dirs MUST be anchored to `.audit-tools/`, never bare `**/<name>/`. (The remaining `**/<name>/` audit of other patterns: `.audit-code/` is fine — distinct name with no source collision.)
- **Make the loop cheaper — route low-risk changes to a lean engine; the heavyweight contract pipeline is overkill for trivial fixes (Ethan, 2026-06-26).** The full `/remediate-code` contract pipeline (~17 phases / ~40 next-steps, independent critique+counterexample+judge rounds, per-validate envelope re-wrap, CE-006 gate reloops) is right for risky changes (lap-1 accept-node earned it — 6 real CEs) but gross overkill for trivial mechanical fixes (lap-2's four ~1-file changes ran the whole ceremony). **Root gap:** `leanFastPath` (`src/remediate/steps/leanFastPath.ts`) only auto-routes **structured_audit (Path A)** input and caps at ≤5 findings/≤5 files/all-high-confidence/none-systemic/no-architecture-lens; a `document`/conversational/backlog input ALWAYS takes the full pipeline (`shouldEnterContractPipeline`, `contractPipeline.ts:369`). So every backlog-driven fix — however trivial — pays full freight. **Direction:** (1) extend lean routing to document/conversational source_type (synthesize a lean plan from the host's bounded intake when it passes the lean gate); (2) add a host-facing change-tier signal — `changeClassification.ts` already classifies change-vs-addition + touched-symbols but is consumed ONLY as a verify gate (`validatePairedObligations`), never as a ROUTING gate; wire a risk/size tier (single-file-local / no-seam / no-concurrency / non-architecture) that routes to lean even for document input; (3) consider raising or making configurable the ≤5-file lean cap (a 6-file trivial cluster like lap-2b falls back to full today). Keep the reliable parts on the lean path (real implement, per-change tests, whole-repo green gate, ship) — drop only the design ceremony. Until shipped, the host risk-tiers and runs trivial clusters leanly (see project memory [[risk-tier-loop-laps-cheap-vs-heavy]]). (Ethan-loop, 2026-06-26.)
- **P0 REGRESSION in 0.30.16 (lap-1 accept-node fix) — over-broad new-file enumeration + data-loss on fail-loud; BREAKS multi-file remediation (discovered lap 2, 2026-06-26).** The 0.30.16 `commitWorktree` CE-004 enumeration (`git ls-files --others --ignored --exclude-standard`) is repo-wide, so it catches INCIDENTAL tooling churn a worker produces by running `npm`/vitest in its worktree (observed: `node_modules/.bin/esbuild`) — not just authored source. Since that path is outside the node's `write_paths` and not source-extension, the new "fail loudly" logic refuses the commit. **All 4 lap-2 nodes were rejected this way** (`accept-outcome-*.json` outcome:error, "Worker created a new file OUTSIDE its declared write scope: node_modules/.bin/esbuild"), so `merge-implement-results` merged 0 / rejected 4. **Two fixes required:** (1) **scope the new-file enumeration to the repo's SOURCE tree** — never enumerate under `node_modules/`, `dist/`, `.audit-tools/`, or other infra-ignored dirs (the CE-004 intent was to catch a gitignore-shadowed SOURCE file like `src/shared/friction/`, NOT node_modules/build output); restrict to paths under the node's `write_paths` (or tracked source roots) before the source-extension/fail-loud decision. (2) **DATA-LOSS: the fail-loud commit-refusal path drops the worktree WITHOUT quarantining the worker's uncommitted source edits** — all 4 verified implementations were destroyed (node branches 0 commits ahead, worktrees gone). On any commit refusal, the worker's real edits must be preserved (quarantine the dirty worktree / stash a patch) before removal, exactly like the verify-fail/merge-fail paths call `quarantineFailedNodeCommit`. Generalizes [[enforce-robustness-in-tooling-not-host-discretion]] — a guard that destroys good work on a false positive is worse than the bug it guards. (Ethan-loop, 2026-06-26.)
- **Contract-pipeline host-friction inventory — autonomous-loop lap 1 (2026-06-26).** Full walk of every point where the tool made the HOST decide, fed an ambiguous direction, or ordered/fed work inefficiently, for a SINGLE bounded one-file bug (accept-node). Logged in the three categories Ethan named; each is a "fix in tooling, never host-remembers" item. **(A) Ambiguous backend direction → host had to pick:** (A1) round-1 conceptual critique returned `approved_with_concerns` while marking 4 items **`severity:blocking`** — the pipeline PROCEEDED (only `rejected` triggers repair), so the host had to manually fold blocking concerns into the test plan; a blocking item in a non-rejected verdict is contradictory and the tool should route it to repair (or forbid the combo). (A2) the **judge phase isn't marked MANDATORY-independent** (unlike critique/critic), so the host decides whether to delegate; memory says delegate the judge too — the tool should state it. (A3) the contract said the merged-base check is "`npm run check` / tsc" — **which one is unpinned**, so host+worker chose; the contract should pin the exact command. **(B) Decision the tool should have made FOR the host:** (B1) whole-backlog intake forced an `AskUserQuestion` phase-cut (the headline auto-phasing gap — see forward track); (B2) `implementation_dag` skeleton offered 8 nodes (one per obligation) and left merge-vs-split to the host — for a 1-module/1-file change the tool should derive 1 node from the decomposition; (B3) advisory critique items (CD-201/202/203) had **no structural slot** — the host had to smuggle them into test assertions to make implementation honor them; the tool needs a first-class "advisory-must-shape-implementation" carrier; (B4) `created_at` ISO timestamps were **host-invented** (`2026-06-26T00:00:00Z`) on every artifact because the host has no clock — the tool should stamp these; (B5) the remediation commit landed on a branch off main and the host had to manually checkout+merge (known [[audit-tools-worktree-traps]] strand-trap; tool should offer/auto the main merge). **(C) Inefficient order / feeding:** (C1) the capability handshake (`--host-can-dispatch-subagents --host-max-concurrent 4 --host-context-tokens/--host-output-tokens`) had to be **re-passed on all ~40 next-step calls** — it should persist from the first handshake; (C2) `goal_spec`/`context_bundle`/`module_decomposition`/`seam_reconciliation`/`finalized_contracts` were all host-authored boilerplate for a one-file fix the tool could mostly pre-derive deterministically; (C3) unchanged obligations forced a **full re-author of their test-plan assertions on every repair round** (no diff-carry of unchanged obligations); (C4) the **obligation SET differs across phases** — `OBL-…-contract` was absent from the 7-item test-plan skeleton but REQUIRED in the implementation_dag, so the host missed it → rejection; (C5) every next-step reprints `previous remediation-report.md will be overwritten` + a stale `worktree remove failed (exit 128)` line — repetitive noise. **(D) Fixable gate/RMW frictions:** (D1) CE-006 negative-scoping gate reports only AFTER write → `test_validator_plan` re-emitted 3× (each forcing a `contract_assessment` re-derive); surface the expected changed-symbol anchors per obligation IN the skeleton. (D2) `implementation_dag` rejection ARCHIVES the file → a follow-up `Edit` failed "file does not exist" → full rewrite (recurring RMW-after-validate trap); a rejected artifact should stay in place or the message should give the archive path. (D3) validate-artifact in-place envelope re-wrap means the on-disk file ≠ what the host wrote (write-plain-then-it-wraps hazard). **(E) 3rd PROOF mechanical emitters captured 0 events** despite ~40 next-steps / 2 repair rounds / 3 gate reloops / 1 archival — reinforces the per-event-reconciliation direction in the friction-detection entry below. (Ethan-loop, 2026-06-26.)
- **N-B3 source-grounding gate empty-`git ls-files` edge — FIXED 2026-06-26.** `validateContractCitationGrounding` now distinguishes the two reasons `enumerateRepoTreePaths` can return empty, via a new `isInsideGitWorkTree(repoRoot)` probe (`git rev-parse --is-inside-work-tree`): git unavailable / not a repo → ERROR (fail-closed, as before); a VALID git work tree with zero tracked files (fresh/never-committed repo) → WARNING + `treeReadable:true` → callers (which block only on `severity:error`) degrade to PASS-WITH-WARNING instead of hard-blocking a legitimately new repo. Covered by `tests/remediate/contract-pipeline-adversarial.test.ts` (empty-but-valid repo → 0 errors + 1 warning; non-repo → fail-closed).


_SHIPPED (autonomous-loop lap 1, 2026-06-26) — `accept-node` new-file-drop + merged-base-green hardening (`src/remediate/steps/dispatch.ts` + `rollingSession.ts`). The naive two-mode fix in the original bug report was reshaped by 2 source-grounded adversarial repair rounds (converged at a true round-3 fixpoint) into: (CE-004) enumerate worker-created new files via `git ls-files --others --ignored --exclude-standard` (a diff/`git add -A` can't see untracked+ignored), (CE-003) force-add only SOURCE-extension files under the node's declared write_paths else FAIL LOUDLY (never commit a generated `.tsbuildinfo`/`.d.ts`), (CE-002) run the merged-base cross-package check `npm run check` in the MAIN checkout (the worktree's `@audit-tools/*` junction resolves to main → unfaithful), (CE-001+CE-005+CD-201) serialize the base-mutating section under a DISTINCT base-branch lock acquired exactly ONCE inside `acceptNodeWorktree` — NOT the non-reentrant per-run `rolling-session.lock` `advanceHostRolling` already holds — capturing the base HEAD OID and on a red check `git reset --hard <oid>` + scoped clean + self-quarantine (base bit-identical; siblings keep a green base). Full suite green on merged main._

_SHIPPED 0.30.14 — three 0.30.13-discovered bugs remediated: (B1) validate-artifact envelope in-place-RMW hash loop → `envelopeSemanticHash` always recomputes from payload + the stored `semantic_hash` is dropped (`artifactStore.ts`); (B2) shared-barrel `src/shared/index.ts` modeled as an owned seam via `touched_files` + ownershipScheduler/registry guard on `canonicalizeFilePath`; (B3) contract-text-only repairs → `validateContractCitationGrounding` requires cited file:symbol to exist in the working tree (`git ls-files`, reuses the relocated `groundDesignFinding`), run at the pre-critic boundary + promotion backstop. Note B3's empty-`git ls-files` fail-closed edge is the open follow-up above._
- **Friction DETECTION is mechanical-only — no LLM judgement reviews the run, so semantic/process friction goes uncaptured.** Capture is fed by exactly two instrumented call sites (`intentCheckpointGate.ts` semantic-gate, `emitValidateRepair.ts` repair seam) plus the opt-in `agent-feedback.jsonl` worker channel; nothing applies LLM judgement over the conversation/run to *find* friction. **Partially fixed (2026-06-25):** (1) dropped `empty set → trivially disposed` — the close-out now always blocks until ≥1 open observation is written; (2) added `open_observations[]` field + named dimensions (`gate_reloops`, `integration_guard_failures`, `rescopes`, `surprises`, `manual_interventions`, `other`) to the friction record contract — host MUST reflect and write ≥1 entry or the run stays blocked; (3) mechanical events remain seeds/prior, not the whole input; (4) applied to BOTH orchestrators via shared `decideFrictionTriage` + `buildFrictionTriageBlock`. **Remaining:** the prompt relies on host recall/reflection over the run's history — the host CAN write "no friction" as a valid observation and bypass. True LLM-judgement-over-transcript friction detection would require the backend to have access to the conversation transcript (it doesn't), or a per-run log the host appends to. The named-dimensions prompt is the maximum tool-enforcement possible without transcript access. (Ethan, 2026-06-25.) **2nd PROOF 2026-06-26 (forward-tracks foundations-phase run):** the close-out recall-prompt UNDER-CAPTURED — the host logged 4 observations, then on user challenge found ~6 MORE real ones (CE-006 gate-grind was ~6 round-trips across two full regenerations not "4 times"; a contract repair re-loops the entire back-half of the pipeline incl. a no-diff full test-plan regen; obligation-id renumbering defeats id-stable diff-review; validate/lint silently wraps+archives artifacts so read-modify-write is unsafe; inline `node -e` generators break on shell quoting; intake rescope is forced every run by the unshipped track-#1 auto-phasing). The named-dimensions blocking prompt did NOT prevent under-capture because nothing forces a transcript/run-log WALK — recall alone satisfies the gate. **A host-kept journal does NOT fix this** (instruction to "log as you go" is the same host-discretion anti-pattern — won't be followed). **Refined enforceable direction (Ethan, 2026-06-26): the backend already OBSERVES most of this at its own step boundary — no transcript needed.** Nearly every friction recalled this run was a backend-side event: a phase re-emitting the SAME gate errors N× (`test_validator_plan` fired ~6× across two regens), a judge `needs_repair` repair round + full back-half re-derive, an artifact rejected/archived (`implementation_dag` referential-integrity), an obligation-ledger renumber, a `validate-artifact` failure, a `resolved_no_change` node merge. Two instrumented sites (`intentCheckpointGate`, `emitValidateRepair`) is the gap — these all pass through `next-step`/`accept-node`/`validate-artifact`. Fix = (1) **auto-capture at the step boundary** (zero host discretion): append a friction event on every phase re-emit, artifact reject/archive, repair round, post-repair re-derive, and no-change merge — facts the backend already computes; (2) **close-out becomes per-event RECONCILIATION, not recall** — surface the backend-counted event list and force the host to disposition EACH (keep/annotate/dismiss-with-reason), exactly like the remediation review-gate (tool surfaces, host judges); a blanket "no friction" is impossible because the tool already knows the phase fired 3× and demands the explanation — and that anchoring is what makes the host actually walk the run; (3) keep the always-present **free-form channel** for transcript-only friction the backend can't see (shell-quoting, artifact-wrap surprise, host confusion), now the minority and primed by the per-event pass. This converts "review the entire conversation" (unenforceable prose) into "account for these N events the tool counted" (enforced + reconcilable). **SUBSTRATE SHIPPED 0.30.13** (N-FRICTION, `/remediate-code` on this item): the single shared backend-observed step-boundary **chokepoint** now exists — `src/shared/friction/stepBoundaryCapture.ts` (`captureStepBoundaryFriction` + a CE-006 **structured percent-encoded collision-free** `stepBoundaryEventId`, open/extensible 7-fact catalogue) — and the two live emitters (`intentCheckpointGate` lock-across-judge fallback, `emitValidateRepair` repair seam) now route through it; per-event reconciliation triage (`decideFrictionTriage`/`buildFrictionTriageBlock`) was already single-sourced across both orchestrators. **REMAINING (deliberate intermediate state, flagged in handoff):** the remaining named step-boundary facts (phase re-emit, artifact reject/archive, post-repair re-derive, no-change merge) + the M-QUOTA bounded-escalation are NOT yet wired to the now-existing chokepoint — that deep instrumentation is follow-up consumer wiring against the emitter (not build-free verifiable in one node). Until wired, those facts still rely on host recall. **EMITTERS + CE-004/CE-010 SHIPPED 0.30.14** (this run): the remaining step-boundary emitters are now wired to the chokepoint — `phase_reemit` (coarse reattempt, `nextStep.ts`), `post_repair_rederive` (judge needs_repair re-derive, `contractPipeline.ts`), `no_change_merge` + `artifact_rejected` (`dispatch.ts`), and `coverage_total_lines_mismatch` (audit ingest) — AND the emit path now takes the shared `withFileLock(frictionLockPath)` and read-MERGEs the record so a late emit can't clobber host `dispositions[]`/`open_observations[]` (CE-004 lock + CE-010 merge-preserve, new `src/shared/friction/frictionRecord.ts`). **PROOF the gap persists meanwhile:** the 0.30.14 close-out friction record captured **0 mechanical events** despite a very friction-heavy run, because the RUNNING global bin predates these emitters — so close-out still fell back entirely to host recall (8 hand-written `open_observations`). The emitters live in the just-published bin; the next run will exercise them.
- **Selective-deepening tasks never converge — packet result task_id ≠ assigned `deepening:*` id.** Repro
  (run `20260622T023504252Z_audit_tasks_completed_001`): workers returned packet-style task_ids (e.g.
  `flow:...:reliability:packet-3-…`) instead of the assigned `deepening:finding:e0e34e19f3`, so merge-and-ingest
  never matched results to tasks and looped. **Partially fixed (2026-06-25):** (1) explicit task_id binding added
  to deepening task sections in `buildTaskSections` ("your AuditResult.task_id MUST be exactly X — do NOT use
  the packet_id"); (2) lens backfill in merge-and-ingest before validation; (3) no-spawn constraint added to
  packet prompt; (4) `packetResultPath` added to `write_paths` so hosts enforcing the pre-approval list don't
  block the packet file write. **Needs live validation** — the prompt-side fix (1) should prevent the convergence
  loop but can't be verified without a real deepening-capable run. Recovery until validated: quarantine orphan
  pending `deepening:*` tasks to let synthesis run. (Ethan, 2026-06-22; partial fix 2026-06-25.)
- **Dispatch is not aware of the host's own session/usage quota — hits the wall instead of adapting.** **Partially fixed (2026-06-25):** (3) limit-message worker result is now a non-consuming re-queue (`rate_limited` outcome) — both `rollingAuditDispatch.ts` and `providerNodeDispatch.ts` call `detectRateLimitFromChannel("error", stderrText)` after each worker and return `rate_limited` when matched; the rolling engine drops the provider and re-queues the packet (CE-003 channel isolation: only error/status channels checked, never the result file). **Remaining:** (1) `HostSessionQuotaSource` (fully implemented in `src/shared/quota/hostSessionQuotaSource.ts`) is NOT yet wired into dispatch — fixed-window tracking, per-packet attribution, bounded re-limit escalation, and auto-pause/resume are available but have zero call sites; (2) pre-wall throttling (pace concurrency before the session wall is hit, not just recover after) requires wiring the host session as a first-class `QuotaSource` in the scheduler. The `rate_limited` re-queue fixes the wasted-packet problem; the full quota-aware scheduling requires the `HostSessionQuotaSource` wiring. (Ethan, 2026-06-22; partial fix 2026-06-25.) **WIRING SHIPPED 0.30.13** (N-QUOTA, `/remediate-code` on this item): `HostSessionQuotaSource` is now registered first-class via a `BuildQuotaSourceOptions.hostSession` field **PREPENDED** in `buildQuotaSource` (own-key precedence via the exact-`providerModelKey` gate — answers first for its own key, passes through for others; no `QuotaSource` interface change), emits a **graduated `remaining_pct`** from its fixed-window usage (replacing the binary open/paused constant) so `scheduleWave` LOW(0.3)/CRITICAL(0.1) bands fire **pre-wall**, `isPaused()` no longer nulls the escalation tracker on auto-resume (livelock now escalates), `recordLimit` is fed from the worker ERROR/STATUS channel, and `rollingDispatch` consults `isEscalated()` to strand escalated packets (INV-QD-07 preserved). Wired across audit `quotaPool.ts` + remediate `dispatch.ts`. **REMAINING:** the capability-tiered *driver* (Y-dispatcher vs slot-pull selection) on top of this is still the broker-driver forward track below.

## Forward tracks

- **Replace the contract-pipeline repair cap (magic constant) with convergence-based termination (Ethan, 2026-06-26).** The judge→repair loop currently stops after a fixed N=2 repair iterations ("Repair Cap Reached"), then forces accepted-but-unrepaired counterexamples forward as residual risks covered by implementation nodes. The fixed count is an arbitrary magic number: a run where round 3 surfaces a *genuinely new* accepted counterexample (e.g. the 0.30.13-successor run: round-1 batch → CE-006 → C-001 → CE-010, each a new real defect) is cut off mid-convergence purely by the constant, not because the design converged. Desired: terminate on actual convergence — keep repairing while each counterexample round yields a *new* accepted CE not already addressed; stop when a round produces **no new accepted counterexample** (true fixpoint), or escalate to the user with the outstanding CE when progress stalls/oscillates (same CE re-accepted, or repair introduces a new CE of equal severity). A hard upper bound can remain as a runaway backstop, but it must be the exception path (loud, escalated), not the normal terminator. Note: when the cap fires, the accepted CE's fix is still specified in the judge `repair_directive` and carried into an implementation node — so the gap is *contract-artifact convergence churn*, not an unfixed defect; the win is letting the contract actually converge (and surfacing real non-convergence to the user) instead of declaring done at an arbitrary count. (Generalizes *enforce-robustness-in-tooling* + the loop-until-dry pattern.)


- **Remediator must mechanically decompose + boundary-enforce arbitrary multi-goal scope — stop forcing the host to phase by hand (Ethan, 2026-06-24, VERIFIED recurring).** When `/remediate-code` is pointed at a large multi-item input (e.g. the whole backlog), the contract pipeline produces a correct reconciled design but then expects the host to execute all tracks as ONE run; the independent design-critique repeatedly returns *blocking over-scoping* and the host has to manually re-scope to a phase. This keeps happening and shouldn't — it is the tool's core job, not the host's. The remediator must, by construction: (1) break an arbitrary number of goals/changes into well-defined, well-bounded tasks; (2) **strongly define the boundaries between tasks and write boundary tests that mechanically enforce them** (not prose `seam_adjustments` notes — review concern C-002: edit-order DAGs asserted in prose over shared files like `staleness.ts`/`dispatch.ts` are a host-discretion anti-pattern + latent merge-break); (3) separate the bounded tasks into **parallel work units with mechanical scheduling dependencies** (block A blocks-on block B) so the wave scheduler honors ordering without the host remembering; (4) derive phasing itself (foundations → consumers → review/slivers) from the dependency DAG rather than emitting one monolithic run the critique then rejects. Generalizes *enforce-robustness-in-tooling, never host discretion* and the *no monolithic change* / failure-isolation principles. Consumer modules (F1/F3/F4/F5/F6) shipped 0.30.5; the **foundations O1/O2/O3 are also shipped** (merged `cd089066`, content-key seam + append-only idempotent ledger + friction triage + repair seam, with tests — verified 2026-06-25, see `.audit-tools/phase-status-investigation.md`); the prior "foundations remain unshipped" claim was stale handoff drift. The rolling-dispatch same-file merge-serialization fix (a)+(c) shipped 2026-06-25 (file-ownership-disjoint scheduling + cross-node seam-signature guard; (b) no-op-satisfied was already shipped). The full module map, reconciled seams, and verified design invariants (CE-001…006, FC blocking concerns) are the canonical design doc [`backlog-remediation-design.md`](backlog-remediation-design.md).
  - **Boundary-enforcement substrate HARDENED 2026-06-26** (foundations-phase remediate run, 5 commits `6133d666`…`bb7f87fa` on main; full suites green — remediate 1919, audit+shared 3269, 0 fail). Shipped: (1) `touched_files` now **first-class + REQUIRED** on `RemediationBlockSchema` + `validateRemediationBlock` (empty array allowed, omitted rejected) so the declared write-scope is a guaranteed seam, not optional; (2) **CE-003** deterministic partial-capacity admission — `admitSubWaveUnderCapacity` returns the block_id-ordered PREFIX (reproducible, not a ClaimRegistry race); (3) **CE-006/CE-007** claim-retaining dispositions — `NodeClaimDisposition` + `isReleasingDisposition` single-source, `redispatchInFlight` retains the file claim across triage-retry/redispatch; (4) **CE-008** `mergeBlocksSharingFiles`/`groupFindingsByFileOverlap`/`splitBlocksByContextBudget` comparisons pinned to `canonicalizeFilePath` so plan-time merge and schedule-time disjointness agree cross-platform; (5) **CE-005** `classifyProvider` collapsed to ONE `{hostClass,concurrencyFloor,driverMechanism}` struct with the separable floor-constant exports removed (floor mechanically un-re-derivable); plus convergence guard tests locking all dispatch through the broker+boundary. Most other substrate (OwnershipRegistry, broker primitive, `emitValidateRepair`/schema-enforced-emit, `HostSessionQuotaSource`) was verify-before-fix already-present.
  - **STILL OPEN — the headline auto-phasing.** The tool does not yet, by construction, take an arbitrary N-goal input and auto-derive the foundations→consumers→review **phase cut** itself: this run's foundations-only scope was chosen by the host at intake (an `AskUserQuestion`), not derived from the dependency DAG. The mechanical decompose + boundary-enforce + scheduling-dep primitives now exist and are enforced; wiring them into automatic phase-cut derivation (so a whole-backlog input is sliced into ordered green-at-every-commit phases without a host decision) remains the unshipped core of this track. (Ethan, 2026-06-26.)

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

_The 2026-06-22 forward-track batch shipped 2026-06-23 in `backlog-actionable-2026-06-23`:
autonomous audit→remediate→PR capstone (unattended mode + fail-closed non-destructiveness
allowlist gate), the external deterministic analyzers behind the adapter seam (ast-grep /
semgrep-dataflow / CodeQL-SARIF, degrade-to-empty), cross-provider quota real-shape
validation, mandatory independent-critic dispatch, and tool-emitted friction-capture
close-out in both orchestrators. Durable design captured in memory + CLAUDE.md._

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
