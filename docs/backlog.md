# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Quota-aware dispatch pre-wall pacing — SHIPPED as the token-budget gate (2026-06-30); live validation env-bound.**
  Was: 4 concurrent workers walled the account 5-hour cap with no proactive pacing. Root cause (verified, see
  `docs/reviews/quota-prewall-pacing-diagnosis-2026-06-30.md`): the proactive `/usage` endpoint WORKS and its
  `remaining_pct` reached the scheduler, but `applyQuotaSourceAdjustment` only reacted at 0.1/0.3 cliff bands →
  at 0.6 it dispatched full concurrency → parallel burn → simultaneous wall. Fix (design of record
  `spec/dispatch-token-budget-gate.md`): the everything-agnostic **token-budget dispatch gate** —
  (A/B, v-pending) concurrency governed ONLY by (1) IDE/provider subagent allowance + (2) token budget; invented
  caps (first_contact/fallback/cliffs) deleted; per-`(pool,window-label)` learned tokens-per-percent slope
  (windows scale differently), budget = MIN across a pool's own windows, partitioned across pools;
  (C) the per-target budget view (remaining %, budget, in-flight/upcoming tokens, reset) surfaced to the
  orchestrating host in the dispatch step; (D) quota-death = retryable pause — a session-limit worker death
  pauses its pool until the parsed reset (no thrash), strands remaining nodes as a retryable `quota_paused`
  terminal (kept pending, not failed), and PRESERVES their worktrees; a later next-step resumes clean.
  **Still open (env-bound):** live validation on a real rate-limited multi-worker run — can't be exercised
  without hitting the wall. The cold-start calibration slope + the resume path especially want a live check.
  Relates to [[claude-usage-endpoint-body-shape]] / [[claude-quota-credential-resolution]] /
  [[cross-provider-quota-matrix]] / [[quota-dispatch-vision]].

- **Friction detection — M-QUOTA escalation chain WIRED (remediate); live validation still env-bound.**
  The `recordLimit → escalate → strand → quota_escalation friction` chain is now fed end-to-end on the named
  remediate driver path. `createRollingDispatcher` gained a generic `recordRateLimit` write hook (fired at the
  `rate_limited` observation point BEFORE the `isPacketEscalated` read) plus a `rateLimit:{channel,text}` field on
  `RollingDispatchResult` carrying the worker ERROR/STATUS evidence (populated by `providerNodeDispatch`).
  `driveRollingImplementDispatch` constructs ONE retained `HostSessionQuotaSource` (onEscalation →
  `captureStepBoundaryFriction(quota_escalation)` with the driver's artifactsDir/runId) and threads the SAME
  instance through `buildConfirmedPools` (pool sizing) AND `driveRollingDispatch → createRollingDispatcher`
  (recordRateLimit + isPacketEscalated). Deterministic wiring unit-tested in `tests/shared/rollingDispatch.test.mjs`
  (same-packet account wall escalates past the bound → early strand before pools exhaust → onEscalation fires).
  **Still open (env-bound):** (1) live validation on a real rate-limited multi-worker run; (2) audit-side parity
  (`src/audit/orchestrator/rollingDispatch.ts` `runRollingDispatch` + `quotaPool.ts`) — the shared primitive now
  supports the hooks, audit just needs to thread a retained source.
  **Done-as-designed, not deferred:** the A-8 hybrid path (`HybridSpillCoordinator`, `nextStep.ts` ~1765-1790)
  intentionally does NOT route through `onEscalation` — it has its own already-working bounded rate-limited/settle
  mechanism (DC-4), so its `HostSessionQuotaSource` only feeds `buildConfirmedPools` sizing by design, confirmed
  by an in-code comment. No follow-up needed here.
  Fits the dispatch capability-tiered driver track. [[meta-audit-friction-must-be-tool-enforced]]
- **Selective-deepening tasks never converge — packet result task_id ≠ assigned `deepening:*` id.** Workers returned packet-style task_ids instead of the assigned `deepening:finding:*`, so merge-and-ingest never matched results to tasks and looped. The prompt-side fix (explicit task_id binding in `buildTaskSections`) is in place but **needs live validation** — can't be verified without a real deepening-capable run. Recovery until validated: quarantine orphan pending `deepening:*` tasks to let synthesis run.
- **Selective-deepening loop #2 — steward result idempotency_key collision — ✅ FIXED (2026-07-01, not yet live-validated).** Distinct from the task_id-mismatch loop above. `idempotencyKey` collapsed every selective-deepening round of a `{unit_id,lens,pass_id}` coordinate onto the bare `'deepening'`/`'steward'` discriminator, so a regenerated round's clean result was dropped as a replay at `ledger.ts:182` and the loop never converged. Fixed by folding `task_id` into `buildResultContentDiscriminator`'s `deepening`/`steward` branch (`src/shared/contentKey.ts`) — each round's distinct task_id now yields a distinct discriminator (⇒ distinct idempotencyKey, persists), while a genuine same-task_id replay still reproduces the same discriminator (⇒ INV-2 no-op preserved). Call sites updated: `ledger.ts` `stampLedgerKeys`, `resultBaseline.ts` `deriveLiveResultKeys`. New tests: `content-key-seam.test.mjs` (deepening/steward round-vs-replay), `ledger.test.mjs` (two distinct-task_id rounds both persist; same-task_id replay still no-ops). Full suites green (audit 3368/0, remediate 2103/0). **Remaining:** live validation on a real deepening-capable run (can't be exercised by unit tests alone). Full diagnosis: `.audit-tools/audit/deepening-loop-diagnosis.md` (gitignored, local only).
  - **TRAP (historical, confirmed 2026-06-30 pre-fix — still relevant if this class of bug regresses):** host-side unblock attempts do NOT work and actively corrupt gitignored run-state. Marking `status:complete` in `audit_tasks.json` is ignored (next-step regenerates deepening tasks in-memory each call); writing `partial_completion_terminal.stranded_ids` is overwritten by the next dispatch emission; appending clean results with unique idempotency keys DID clear the obligation but cascaded `planning_artifacts` stale and a subsequent regeneration truncated `audit_tasks.json`. **Lesson: there is NO host-side unblock for this class of loop — the fix must be the idempotency-discriminator code change (now shipped), then a clean re-run.** A recovery affordance the tool SHOULD still expose: a supported `--force-synthesis` / partial-coverage escape that resyncs `artifact_metadata` and drives synthesis from the intact ledger without hand-editing artifacts.

- **Dead-code gate — SHIPPED (knip default-mode).** Rule + rationale now in `CLAUDE.md` → Conventions &
  invariants ("Dead-code release gate — default-mode knip, not `--production`"). One manual
  `--production` tested-but-unwired sweep ran 2026-06-27 (~26 confirmed dead + deleted); re-run when
  worthwhile. [[deterministic-analyzers-own-vs-acquire]]

- **remediate-code: stale-unfinished-run hijack + auto-discovery-should-contextualize — ✅ FIXED (v0.31.3).**
  (1) A `--guidance-file` (like `--input`) now trips the `input_conflict` gate against a run already past
  intake: `NextStepOptions.guidanceFileSupplied` is threaded from `index.ts` into `buildPreIntakeObligations`'s
  `input_conflict` derive (`src/remediate/steps/nextStep.ts`), so a new guidance source stops for an explicit
  resume-vs-restart choice instead of silently resuming (and executing) the old, unrelated run.
  (2) The single-candidate `confirm_auto_discovered_input` gate is now a discovered-sources MANIFEST
  (`src/remediate/steps/intakeResolver.ts`): it lists EVERY existing default candidate
  (`InputResolution.allExisting`) with provenance (type/mtime/finding-count), is SKIPPED entirely when the
  host supplied an explicit source (`intake.conversationStart` from `--guidance-file`, or `--input`) — which
  broke the decline→re-offer loop — and a `{status:"declined"}` ack now routes to `collect_starting_point`
  (ask for an explicit `--input`) rather than re-offering the declined candidate. Tests:
  `intake-resolver.test.ts` (guidance skips gate / declined routes / manifest lists all),
  `next-step-resume-gates.test.ts` (guidance trips input_conflict). **Residual (small):** the "silently
  proceeded past a branch-switch error" symptom is now largely averted (the conflict gate stops before the
  resume/branch-switch), but a loud-abort on any branch-switch failure during a resume is not independently
  enforced — revisit only if it resurfaces. [[guidance-discovery-contextualizes]]
- **remediate-code: `accept-node` dirty-main-tree cherry-pick collision — ✅ FIXED (v0.31.3).**
  Was: a node whose touched path collides with unrelated uncommitted WIP in the MAIN tree failed the
  cherry-pick with the opaque "local changes would be overwritten by merge", replayed identically on every
  auto-retry, and routed to human triage without naming the actionable cause. Fix
  (`src/remediate/steps/dispatch.ts`): `dirtyMainTreeCollisions(root, branch)` intersects the branch's edited
  files with `git status --porcelain`; `acceptNodeWorktree` runs it up front (after rebase, before the
  expensive verify) and, on a hit, quarantines the node's committed work (like every sibling error path) and
  returns a precise directive — "main tree has uncommitted changes to `<path>` — commit or stash it before
  merging". Test: `dispatch-worktree.test.ts` (surfaces collision as actionable directive, work preserved,
  main WIP untouched).
- **Consent-gate for proposed analyzers — confirmed no gap; LLM-proposal channel deferred.** 2026-07-01
  verification: (1) `admitSpawn` (`src/audit/extractors/analyzers/acquisitionEngine.ts`) already gates
  EVERY `defaultRun: false` candidate — including `jscpd` (`defaultRun: false` in
  `src/audit/extractors/analyzers/candidates.ts`, shipped 2026-07-01 as the second acquired
  ecosystem-specific analyzer alongside eslint/semgrep, proving the own-vs-acquire pattern generalizes) —
  behind a non-empty `consentToken`; confirmed, no gap.
  (2) There is no runtime path for an LLM to propose a brand-new analyzer id beyond the static
  `EXTERNAL_ANALYZER_CANDIDATES` array (`src/audit/extractors/analyzers/registry.ts`) — out of scope
  this round; if a future proposal channel is built, it must route through the same `admitSpawn`
  chokepoint, never bypass it. (3) Latent (not currently exercised) hazard: `SessionConfig`'s persisted
  schema (`ExternalAcquisitionConfig` in `src/shared/types/sessionConfig.ts`) does not structurally
  strip `external_acquisition.consent_token` on write/serialize — harmless today (nothing persists
  `SessionConfig` verbatim to a shared/committed artifact), but if a future proposal-channel writer ever
  round-trips `SessionConfig` through a persisted file, the token would leak. Flag for whoever builds
  that channel: strip or redact `consent_token` before any such persistence.

## Forward tracks

- **Last-writer-wins seams → default LWW, but compare-on-conflict (the owner, 2026-07-02).** Policy idea:
  wherever a write is last-writer-wins, keep LWW as the cheap default but, when a write would clobber a
  *newer* non-mergeable result, compare a monotonic marker and keep the newer/better rather than the
  race winner. **Scope today is narrow:** the correctness-critical data seams are already NOT LWW — the
  audit bundle / remediate `state.json` are mutex-serialized with reload + merge-time ownership
  re-validation (a superseded peer abandons, never overwrites), and results are append-only + dedup'd.
  The one true LWW seam is the **cosmetic** shared `steps/current-*` latest-pointer
  (`src/shared/io/stepContractWriter.ts` — nothing correctness-critical reads it; peers use the returned
  per-agent `prompt_path` / stdout). Concrete change if pursued: stamp each step with an
  `emitted_at`/generation and make the shared-pointer write a locked read-compare-write that only
  overwrites when strictly newer, so the pointer deterministically reflects the actually-latest step
  under concurrency. Low value (cosmetic) but a clean general guard for any future LWW seam. Relates to
  [[multi-ide-concurrent-runs-design]], [[enforce-robustness-in-tooling-not-host-discretion]].

- **Parallel dispatch over OVERLAPPING files — make it the tool's job, and the target design (the owner, 2026-07-02).**
  Today the decomposition avoids implement-time cherry-pick collisions by partitioning modules onto
  DISJOINT file scopes (e.g. five external analyzers forced into ONE serial `candidates.ts` module). That
  disjoint-file rule is a HOST-remembered crutch, not a tool guarantee — it must move into the remediator,
  and more importantly the crutch is not the goal. The goal: contracts precise enough that we CAN dispatch
  agents in parallel even when they edit the same file. Concretely — (a) contract-level per-file edit-region
  ownership (each node declares the exact region/anchor it appends to or edits, so two nodes on `candidates.ts`
  are provably non-conflicting), and (b) a merge that tolerates disjoint hunks in the same file (cherry-pick /
  3-way apply per node, not whole-file ownership). Under that, the analyzer work is N parallel nodes, not one
  serial node. NOTE (settled this session): the constraint never applied to contract *drafting* — the per-module
  shards are disjoint output files and source reads are read-only, so parallel drafting on overlapping source is
  already safe; the rule only ever mattered at implement/merge. Relates to [[remediator-must-decompose-and-boundary-enforce]],
  [[decomposition-colocate-source-and-tests]], [[enforce-robustness-in-tooling-not-host-discretion]].
- **Multi-agent COOPERATIVE runs — ✅ SHIPPED (2026-07-02).** Arbitrary agents/IDEs/providers now
  contribute to the SAME audit/remediation: start an audit in one IDE, run `/audit-code` in a second and it
  JOINS, taking unclaimed tasks; symmetric peers, no primary/secondary, no collisions. Design of record:
  [`spec/multi-ide-concurrent-runs-design.md`](../spec/multi-ide-concurrent-runs-design.md). All slices
  landed: **0** revert the wrong isolation draft; **1** audit `bundle-mutation` mutex + lock-split (executor
  runs outside the coarse lock, heartbeat + merge-time ownership re-validation); **2** audit task-POOL
  claiming (`prepareDispatchArtifacts` `claimMany`s disjoint `task_id`s in `task-claims.json`, `poolId=runId`
  idempotency, releases deferred + terminal claims, dedup backstop); **3** per-agent step slot
  (`steps/<agentId>/` + shared latest copy; dispatch runId already auto-isolates per-run files); **4**
  remediate `phase:main` mutex serializing the serial phases (planning/triage/close) while implement stays
  pooled, `phase_busy` cooperative-wait. Reusable primitives: `ClaimRegistry.claimMany/clear` + configurable
  `staleMs`, `claimWithBackoff`/`withClaimHeartbeat` (`src/shared/quota/claimLease.ts`). Resolves the durable
  trap [[concurrent-nextstep-staleness-cascade-wipe]] (concurrent next-step/merge-and-ingest now mutually
  exclude on the mutex). **Remaining (env-bound):** live validation with two real IDEs driving one repo.
- **Spec-doc rewrite pass — SHIPPED (2026-07-02).** All six flagged docs rewritten against real source:
  1. `spec/audit/dependency-map.md`, `spec/audit/artifact-contract.md`, `spec/audit/executor-catalog.md`
     — rewritten to the real 31-entry `ARTIFACT_DEFINITIONS`, the real `ARTIFACT_DEPENDS_ON_MAP` (canonical
     upstream direction, matching the source table's own keying), and the real 21-entry
     `EXECUTOR_REGISTRY` (incl. noting `friction_capture_executor` is unreachable and `agent` is a legacy
     placeholder). Two invariant tests (`staleness.test.mjs` F1 inv-6, `git-history-mining.test.mjs` F6
     fail-10) parsed the doc's old per-artifact `### \`x\`` / `Downstream:` bullet format — updated their
     parsers to the new upstream-direction table format, same assertions.
  2. `spec/contract-authoring-determinism-design.md` — S1,S3-S7 marked SHIPPED with real citations; S7's
     wrong `fileAnchors.ts` citation replaced with the real chokepoints
     (`mergeAndIngestCommand.ts`/`designFindingGrounding.ts`); S8 3/4 sub-fixes marked shipped, "Gate it"
     confirmed still open (`runDesignReviewAutoComplete`, `structureExecutors.ts:227`, no empty-findings
     guard).
  3. `spec/audit-workflow-design.md` — this doc is explicitly a target-design doc, not a status log (own
     preamble disclaims shipped/unshipped tracking), so only genuine design-record errors were fixed, not
     "not yet built" gaps: the "workers emit findings inline; skill writes to disk" claim (3 locations) was
     corrected to the real, deliberately-chosen write-to-disk mechanism (inline-emit was tried and reverted
     — it silently dropped results, per a code comment in `packetPrompt.ts`). The other 8 flagged items
     (Gate 1 interactivity, provider-pool→lens wiring, `buildCacheablePrompt`, etc.) are legitimate
     not-yet-built target content, left as-is per the doc's own policy.
  4. `spec/remediation-workflow-design.md` — same target-design policy. Added a cross-reference noting
     `spec/self-scaling-pipeline-design.md` supersedes the "both paths run the [full] pipeline" section
     with the sanctioned lean-fast-path exception (`leanFastPath.ts`); corrected two wrong citations
     (`applyClarificationResolution` → `applyPlanClarificationResolution`;
     `MAX_AUTO_RETRIES` → `MAX_AUTO_RETRIES_CONTRACT`/`_INFRA`). `risk_preview`/`impl_preview_acknowledged.json`
     left as legitimate not-yet-built target content.
  Full suites green (audit + remediate, 2103+/0 remediate; audit node:test all green), `check` clean.

- **remediate-code installer/generator for `.agent/skills/remediate-code/SKILL.md` parity with audit-code
  (2026-07-01 doc-review, R10-D12).** `.agent/skills/remediate-code/SKILL.md` is byte-identical to
  `skills/remediate-code/SKILL.md` today by coincidence only — nothing generates or enforces sync for it,
  unlike audit-code's real multi-host installer (`wrapper/audit-code-wrapper-install-hosts.mjs`, ~1200
  lines: per-host asset rendering for codex/opencode/vscode/antigravity/copilot, verify checks, install
  manifest, isolated-verify test harness). Extending that pattern to remediate-code is a substantial build,
  not a quick fix — scope it as its own session using `audit-code-wrapper-install-hosts.mjs` as the
  reference implementation. Until then the duplication is harmless but silent-drift-prone; a manual sync
  check is the interim mitigation.

- **Dead-code / unused-export as an ACQUIRED audit analyzer (knip) — slices 1-3 SHIPPED (2026-07-02).**
  Slices 1+2 (knip candidate/parser grounded against `node_modules/knip/dist/reporters/json.js`'s real
  `--reporter json` shape; generic `getExternalSignalPaths` + task-tagging join, no separate merge-point wiring
  needed) shipped 2026-07-01.
  **Slice 3 — corrected premise, shipped as a smaller fix than originally scoped.** The 2026-07-01 attempt
  (below) assumed graph context never reaches the worker and needs new obligation-ordering/plumbing; a
  2026-07-02 re-trace found that premise false on the real primary dispatch path: `buildPacketPrompt`
  (`src/audit/cli/dispatch/packetPrompt.ts`) already renders packet-level graph context (`entrypoints`/
  `key_edges`/`boundary_files`/`quality`) via `renderPacketGraphContext` — the earlier attempt had targeted
  `renderWorkerPrompt`/`WorkerTask`, a separate envelope-bootstrap mechanism not used for packet content at
  all. The REAL gap was narrower: workers only ever saw a generic `external_analyzer_signal` tag + boilerplate
  "raises priority" rationale (`taskBuilder.ts`), never the actual lead (symbol/line/rule/summary) — that
  extraction already existed (`fileAnchors.ts`'s `analyzer_signal` anchor logic) but was wired only for
  isolated-large-file packets. Fix: extracted the path-scoped sub-logic into
  `analyzerSignalAnchorsForPath` (`src/audit/orchestrator/fileAnchors.ts`) and render it as a new
  "External analyzer signals for this task" section in `buildTaskSections`
  (`src/audit/cli/dispatch/packetPrompt.ts`) for any tagged task in any packet, threaded from
  `bundle.external_analyzer_results` at `dispatch.ts`'s existing call site — no new obligation, no new
  artifact read. Tests: `dispatch-helpers.test.mjs` (renders for tagged+matching, omits for untagged /
  no-match).
  **2026-07-01 attempt on option (b) reverted (historical — the false-premise part, kept for the lesson):**
  a contract-pipeline module survived 7 judge/critique repair rounds but its core premise didn't hold against
  real source: `renderWorkerPrompt(task: WorkerTask)` is synchronous/pure with a single call site
  (`materializeReviewRun`, `src/audit/cli/reviewRun.ts:167`), and `WorkerTask` has no `file_paths`/tags field
  to key a graph-context lookup off of. The lesson generalizes: always verify which of several dispatch-prompt
  mechanisms is actually the LIVE one before scoping a fix around it.
  [[deterministic-analyzers-own-vs-acquire]] [[graph-signals-thin-substrate-extraction-persist]]
- **Borrow-level leads from the `affaan-m/ecc` evaluation (2026-06-28) — 1 & 3 CLOSED (2026-07-02), 2 remains.**
  ecc itself is not adoptable/applicable (agent-config distribution OS, wrong domain/stack — see `ecc-evaluation.md`
  on user Desktop), but a deeper pass surfaced three idea/reference-level leads, none requiring vendoring:
  1. **Windows spawn-safety hardening — ✅ verified already-safe (2026-07-02), no change needed.** CVE-2024-27980:
     the cmd.exe shim caret-escapes shell metachars (`quoteForShellInterpreterCmd`, `src/shared/tooling/exec.ts:191`)
     and sets `windowsVerbatimArguments` only when spawning cmd.exe directly (`spawnLoggedCommand.ts:301`), so
     config-derived args (e.g. `input.repoRoot`) can't inject — no vulnerable path found. Tree-kill: the cancel/
     timeout path already `taskkill /pid <pid> /T /F`s the whole tree on win32 (`spawnLoggedCommand.ts:116` `killTree`).
  3. **Hook bypass coverage — ✅ FIXED (2026-07-02).** Was: `.claude/hooks/pre-commit-gate.mjs` detected `git commit`
     but let `git -c core.hooksPath=… commit`, `git -c core.hooksPath= commit`, and `--no-verify`/`-n` through — each
     disables the hook, making the green-at-every-commit gate a no-op. Fix: once a commit is detected the gate now
     rejects (exit 2) any statement containing `--no-verify`/`-n` or `core.hooksPath`, before the slow `npm run check`.
     Test: `shared-core-invariants.test.mjs` INV-shared-core-16 (spawns the hook against 4 bypass payloads → exit 2;
     2 benign → exit 0). Repo-internal (hook + test, not in published package) — commit+push only, no npm publish.
  2. **Worktree shared-dep sync (STILL OPEN)** — ecc2's `sync_shared_dependency_dirs` (`ecc2/src/worktree/mod.rs`)
     mechanizes node_modules sync into fresh worktrees; directly addresses [[worktree-tests-miss-integration-guards]] /
     fresh-worktree-no-node_modules. Borrow-idea for our per-node remediation worktree setup.
- **Codebase-wide churn / context / enforce-in-tooling pass — remainder.** Run one perspective over the whole
  codebase: hunt (a) **unnecessary churn** — anywhere we recompute / re-derive / re-dispatch more than the actual
  delta demands; (b) **unnecessary context** — anywhere we ship more than needed into a prompt or step; (c)
  **enforce-via-tooling prevention** — anywhere a correctness property held by host/maintainer discretion could be made
  impossible-to-get-wrong at the abstraction. The 2026-06-27 pass shipped its actionable findings (auth-session
  O(auth×files)→O(files), E1/E3/E2 write-scope + executor-registry + incomplete-coverage gates, C2 incremental
  graph-build, X1 prompt-render trim) and closed X-cluster state-projection as not-worth-it; full record in
  [`docs/reviews/churn-context-enforce-pass-2026-06-27.md`](reviews/churn-context-enforce-pass-2026-06-27.md).
  **Remaining:** C3/C5/C6/E4/E5 are low-value / need design intent — unscheduled. Re-run the lens broadly when
  worthwhile. (the owner, 2026-06-24.)

- **Schema-enforced generation everywhere possible — make malformed output impossible, not merely repairable.**
  Every structured-contract emission in the project — every dispatch path, every emitting agent, both orchestrators —
  should use the provider's strongest available output-constraint mechanism (forced tool-call / JSON-schema-constrained
  generation / structured output) so the schema is enforced at emit time and the malformed-output class is prevented at
  the source; where a provider cannot enforce a schema, that path degrades to the layered repair seam as fallback —
  prevention first, repair as backstop. Provider-agnostic: discover the capability per backend, never hardcode. The
  emit-time seam is present (`discoverOutputConstraintCapability`, `enforceSchemaAtEmit`, degrade-to-`runEmitValidateRepair`,
  one-validator re-validate floor); the semantic-validity gate (CE-009) hard-rejects a `total_lines` that diverges from
  disk past both an absolute floor and a ratio. **Open: CE-004** — the always-on conversation host (`claude-code`)
  advertises *no* API-level constraint mechanism, so on the primary path this reduces to the repair floor (no emit-time
  prevention) — env-bound on a provider gaining a constraint endpoint; plus broader semantic-validity checks beyond
  `total_lines` (fabricated paths / out-of-range spans already gated; more are candidates). (the owner, 2026-06-24.)

- **Tool-enforced dispatch broker with a capability-tiered driver — rolling dispatch the host can't get wrong.**
  Desired end-state:
  (1) **A tool-enforced dispatch broker as the single chokepoint.** One gated primitive set — read quota, estimate
  per-task tokens (deterministic + local, per standing policy — never API token-counting), dispatch-an-auditor
  (refuses if it would exceed slots / rate / token budget), await-next-completion. No dispatcher can over-dispatch
  because the broker is the only door and it counts. Enforcement layer, independent of who drives.
  (2) **A capability-tiered driver, Y-primary.** Where the host supports agent nesting, the orchestrator dispatches a
  single thin *dispatcher agent* (Y) that runs the rolling loop through the broker tools and spawns auditors up to the
  gated limit — Y performs **no judgment**, only picks the next task and refills slots. Spin Y only above a task-count
  threshold. Where the host can't nest, the top host drives directly through the *same* broker, which releases the next
  slot only on a completion callback (slot-pull). The broker is the constant; the driver tiers by host capability.
  (3) **Classify capable agent hosts off the cold-start floor.** A host that runs parallel subagents (Claude Desktop /
  `claude-code` / `vscode-task`) must get agent-host concurrency, never the hosted-API first-contact cap.
  Enforcement (broker), driving (Y / slot-pull), and judgment (repair + staleness seams) are separate layers; when a
  judgment call costs a dispatch it flows through the same broker. The single-source classifier (`classifyProvider`),
  broker primitive (`computeDispatchCapacity` never-over-dispatch caps), `HostSessionQuotaSource` channel-isolated
  recordLimit + bounded escalation, and driver SELECTION + prompt rendering (`selectDispatchDriver`,
  `renderDispatchDriverInstruction`, single-sourced across both orchestrators) are **shipped**. **Open (env-bound):**
  live Y-dispatcher validation (needs a nested-agent host + a live run) + proactive pre-wall quota-aware pacing.
  (the owner, 2026-06-24.) See the enforcement/driving/judgment separation principle in memory.

- **Deterministic analyzers: own-vs-acquire — build the agnostic acquisition engine, don't expand a fixed bundle.**
  A fixed bundle of analyzers fails the everything-agnostic test (it privileges whatever ecosystems we bundled
  for). The ideal end-state is a mechanism that **acquires and runs the right ecosystem-native mature tool on the
  fly** — also cheaper to own than a pile of per-language integrations (generalizes the two-tier dependency policy:
  don't hand-roll a Ruby analyzer, shell out to the mature one). Concretely:
  (1) **Own only truly-agnostic extractors** — signals with no ecosystem tool: git-history mining (shipped) and
  text/git-based secret scanning (acquired via gitleaks, shipped).
  (2) **Acquire everything ecosystem-specific on demand** (eslint, jscpd shipped 2026-07-01; osv-scanner,
  clippy, rubocop, hadolint, actionlint, type-coverage shipped 2026-07-02 as v0.31.0 — clippy/rubocop
  fixture-only here, live spawn unvalidated; mutation testing remains a gap): detect ecosystem
  deterministically → capability-probe the runner (`npx`/`pipx`/`cargo`/`bundle`/…) → run ephemerally → normalize
  through the existing adapter seam → degrade-to-empty when runtime/tool is absent. The build is the *engine*; each
  tool is a registry entry + one normalizing adapter. jscpd (duplication detection) is the proof-of-generalization
  case for the npx/pipx runners: registered via the same `EXTERNAL_ANALYZER_CANDIDATES`/npx/`defaultRun:false` shape
  as eslint/semgrep, with zero changes to `acquisitionEngine.ts`. osv-scanner is the proof-of-generalization case for
  the `binary` runner: a *second*, independent binary distribution shape from gitleaks — its release assets are the
  raw executable, not an archive — which required (and got) one small, real engine generalization rather than a
  workaround: `BinarySpec.archived?: boolean` (`binaryAcquisition.ts`, default `true` for back-compat) skips the
  `tar` extraction step and writes the SHA256-verified bytes directly as the cached executable. Confirms the binary
  path isn't gitleaks-shaped either. clippy (`cargo`) and rubocop (`bundle`) exercised the two former-unexercised
  runner families as of v0.31.0 (fixture-validated; hadolint used a `checksumsAsset` fn generalization for its
  per-asset `.sha256` files).
  (3) **Selection/safety gate without a maintained allowlist** — enforcement is mechanical run-safety written once
  (capability-probe, pin versions, sandboxed/read-only, degrade-to-empty, report-skipped-never-silently); a small
  value-curated DEFAULT set (high-likelihood × high-leverage × low-overhead — eslint/semgrep/gitleaks/git-mining/…)
  runs without asking; the LLM proposes ecosystem-appropriate tools for the repo; anything beyond the defaults needs
  per-run user consent (ephemeral, nothing persisted) — confirmed already-covered by the existing `admitSpawn` gate,
  see the consent-gate backlog entry above. No exhaustive allowlist to curate.
  (the owner, 2026-06-24.)

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
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built and green (4 hosts);
  the provider-matrix in-process dispatch e2e (`tests/audit/provider-matrix-dispatch-e2e.test.mjs`, gate
  `RUN_PROVIDER_MATRIX_E2E=1`) runs the same bounded round-trip through every discovered provider (codex +
  openai-compatible/NIM live-verified 2026-06-28; opencode skipped when not installed) — adding a backend needs no new
  test. **Remaining:** the release-time manual GUI checklist ([`host-validation.md`](../spec/host-validation.md)) for
  the GUI-only hosts (Antigravity/OpenCode).
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned subtasks
  (can't be unit-tested; user-owned). Folds into the A7 checklist.
- **Gated live e2es** skip without creds: `RUN_PROVIDER_MATRIX_E2E=1` (in-process audit dispatch across all
  available providers — codex + openai-compatible/NIM live-verified 2026-06-28), `RUN_NIM_E2E=1` (hybrid-spill +
  remediate rolling), `AUDIT_TOOLS_LIVE_QUOTA=1`, `RUN_AUTONOMY_E2E=1` (autonomy capstone a9 — still
  NIM-hardcoded; candidate for the same provider-matrix generalization).
- **Provider `queryLimits`** deferred — an absent method and a `null` return are handled identically, so stubs
  change nothing; revisit if a provider gains a real proactive rate-limit endpoint.
- **headroom proxy — final opt-in validation before global flip.** Proxy runs natively on Windows (optimize mode
  enabled; `headroom.exe proxy --port 8787` via scheduled task `HeadroomProxy`, hidden restart-loop VBS; `127.0.0.1:8787`
  livez/health 200, `/v1/messages` forwards intact). Traps captured in project memory
  ([[headroom-proxy-broken-windows-no-rust-core]]): MCP-server-locks-install on reinstall, `vcvars` env required for the
  source build, every upgrade rebuilds from source. **Still pending (user-owned):** the one opt-in session confirming
  contract JSON survives the proxy's compression before flipping the GLOBAL `ANTHROPIC_BASE_URL` (use the
  `claude-headroom.cmd` Desktop launcher).
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

- **Remediate-code worktree branches strand commits off main.** Remediate runs on isolated git worktree branches; landed work accumulates on `remediation/<runId>` and the host is left checked out there. By DEFAULT those branches are never auto-merged — the base branch is left untouched for review. Any doc or code fix applied inside a remediate run never reaches main unless explicitly merged. Effect: the doc-review nightly routine (which reviews main) keeps re-surfacing the same findings indefinitely. **Opt-in fix (B5, shipped):** select the `merge-to-base` closing action at the confirm step — the tool then `--no-ff` merges `remediation/<runId>` into your launch branch at close (aborts safely on conflict). Otherwise, after a run that touches docs/code you want on main, merge `remediation/<runId>` manually before the next nightly run.

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
- **One test runner: vitest** (all three areas — `tests/audit`, `tests/shared`, `tests/remediate`; the
  node:test split was retired 2026-07-02). Run a single file with `npx vitest run <path>`. `node:assert/strict`
  is still permitted as an assertion lib (runs under vitest) for the control-flow assertions
  (`assert.throws`/`rejects`/`doesNotThrow`/`doesNotReject`) that have no clean `expect` equivalent; value
  assertions are `expect`. Framework-consistency is guarded by `shared-tests-invariants` (INV-shared-tests-02),
  `audit-infra-architecture` (ARC-843ce274-2). Vitest `testTimeout` is raised to 120s in `vitest.config.ts`
  because audit integration tests spawn real subprocesses (node:test had no per-test timeout).
- **Don't mask the test exit code.** `npm test > out; echo done` reports the *trailing* command's exit, not the
  suite's — and piping through `grep`/`rm` in the same Bash call races the output file, so a real failure reads
  as "green." Capture the suite's own status: `npm test > out 2>&1 && echo PASS || echo "FAIL=$?"`.
  (Mis-reading a masked exit shipped a release whose CI then failed.)
- **Global `-g` install defers `postinstall`** (npm allow-scripts) → the host-integration deploy silently
  skips; finish with `npm i -g --allow-scripts=audit-tools` or `node "$(npm root -g)/audit-tools/scripts/postinstall.mjs"`.
- **A global junction to a LIVE working tree silently shadows a registry install.** If the global
  `audit-tools` is a `Junction` → the working tree (from a prior `npm link`), `npm i -g audit-tools`
  does NOT replace it, and bins run your working-tree dist; invoking a bin *through* the junction path
  can also produce odd artifacts (seen: `remediate-code --version` silent via junction, correct when the
  same dist ran direct). Fix: `npm rm -g audit-tools` FIRST, then reinstall, and verify
  `(Get-Item <globaldir>).LinkType` is empty before trusting the smoke. (See [[audit-code-global-bin-traps]].)
- **The Bash tool mangles Windows backslash paths** (`C:\a\b` → `C:ab`) → use forward slashes or the
  PowerShell tool for absolute-path commands.
- **PowerShell**: assign `foreach` output to a var before piping to `ConvertTo-Json`; `-Filter` is not regex
  (use `Where-Object -match`); single-element arrays unwrap in `ConvertTo-Json` (bracket-wrap the payload).
- **When you delete a *shipped* file, grep the smoke/verify scripts** for a `requiredPackagedPaths`-style list
  (the packaged-smoke gate asserts specific tarball files).
- **Async typecheck hook = stale-dist false alarm** after a shared-source edit (it runs `tsc` before the
  central rebuild); the authoritative gate is `npm run check` after `npm run build`.
- **Prefer a dependency-injection seam over module mocking** in tests. Under vitest, `vi.spyOn`/`vi.mock`
  and fake timers (`vi.useFakeTimers({ toFake: [...] })`) are available, but the codebase's established
  pattern is injectable deps (`WorkerRunDeps`, `createWriteStream`/`spawn` seams) — keep using those.
- **Test-migration codemod trap (2026-07-02):** the one-shot node:test→vitest codemod's import-replace regex
  used `[^;]*?` which matches across newlines, so a `import … from "node:test"` string appearing inside a
  JSDoc **header comment** (example run-commands, prose) got matched — eating the comment's `*/` terminator
  and the real import line ("Unterminated block comment" at EOF, or a missing runner import). Any future bulk
  text rewrite of imports must anchor to line starts / exclude comment spans.
- **Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/
  module_decomposition, not just a targeted one.** A remediate-code contract run (2026-07-01, knip
  slice-3 graph-context module) needed 6 adversarial repair rounds before converging; every accepted
  counterexample was real, but at least 3 of the 6 rounds (CE-004 wrong adapter shape, CE-005/CE-006
  broken retry composition + an entirely separate already-shipped sibling pipeline the draft never
  referenced, CE-007–CE-010 a quality-field bug plus its own over-narrow justification) trace back to
  one root cause: the single upfront Explore pass before authoring the contract was scoped to "the two
  target files," not to "does equivalent logic already exist somewhere else in this codebase." The
  sibling pipeline (`buildPacketGraphContext`) was the single biggest lever in the whole repair history
  and a wider search would have surfaced it in the first round instead of the third. **A 7th round the
  next session still didn't catch the deciding issue:** even after finding and reusing
  `buildPacketGraphContext`, no round independently re-verified the target function's OWN type signature
  (`WorkerTask`) against source — the contract accumulated increasingly precise derivation/path-matching/
  failure-mode detail on top of a premise (`WorkerTask` carries `file_paths`/tags) that was never true,
  and it took an implement-phase worker's own from-scratch grounding check to catch it. Lesson: before
  writing goal_spec/context_bundle/module_decomposition for a remediation contract, explicitly search
  for prior art doing something similar ANYWHERE in the repo (not just near the literal target files),
  AND independently re-verify the target symbol's own type/shape against source at least once per
  contract, not just the surrounding derivation logic — the cost of one broader Explore call or one
  grep is far lower than a full adversarial repair round or an implement-time revert.
- **Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.** A
  delegated "delete N dead symbols + their tests" sweep (2026-06-30) spawned a deletion agent that itself spawned 3
  grandchild agents, all editing overlapping test files concurrently — they raced the parent's verification AND the
  main session's hand-fixes (file-modified-since-read churn, a half-reverted symbol re-applied after a `git checkout`,
  one agent bailed mid-task, one hit a weekly limit). Net: hours of reconciliation (re-reverts, a meta-guard fix,
  cascade-dead cleanup) for what one serial pass would have done cleanly. Rule: for a broad mechanical sweep over a
  shared file set, run it as ONE serial agent (or partition by NON-overlapping files), never an uncoordinated fan-out;
  and never hand-edit the same files while a background agent is live on them — wait for genuine quiescence (poll
  mtimes) or a completion signal first.
- **Never pass `isolation: "worktree"` to the Agent tool when dispatching a remediate-code/audit-code implement
  node.** The tool's own dispatch plan already creates and names the node's worktree
  (`.audit-tools/worktrees/remediate-<block-id>-<run-id>`); adding the Agent tool's OWN `isolation: "worktree"`
  spawns a second, unrelated git worktree (under `.claude/worktrees/agent-<id>`) and the subagent edits source
  files there instead of the tool-designated one — `accept-node`'s cherry-pick then sees no diff. Recovery is a
  manual `git diff`-then-`git apply` from the wrong worktree into the right one. Just point the Agent at the
  tool-given worktree path as its working directory; do not add isolation on top.
