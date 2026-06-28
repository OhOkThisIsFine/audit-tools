# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Contract-pipeline host-friction inventory — points where the tool makes the HOST decide / feeds ambiguous direction / orders work inefficiently.** Each a "fix in tooling, never host-remembers" item. **(A) Ambiguous backend direction — ALL SHIPPED (A3 pinned: `mergedBaseCheckArgv` in `src/remediate/steps/gateCommands.ts` derives the merged-base check from the gate's `check`-layer argv; no hardcoded `npm run check`).** **(B) Tool should decide FOR the host:** (B2) **SHIPPED** — `buildImplementationDagScaffold` now groups a finalized module's obligations into ONE DAG node (a `module` field threaded onto each design_spec-sourced obligation at derive time; obligations with no module home fall back to one node each), so a 1-module change derives 1 node instead of N the host must merge; coverage preserved; (B3) **SHIPPED** — advisory conceptual-critique items now have a first-class carrier: `ImplementationDagScaffoldNode.addressed_critique_items` (blank slot per node) + `advisoryCritiqueItems()` reader surfaces them in the implementation-DAG skeleton prompt; (B4) **SHIPPED** — `created_at` is now tool-stamped (`stampToolCreatedAt` in `contractPipeline/artifactStore.ts`, injected at `ingestContractArtifacts` + the `validate-artifact` self-check before validation); dropped from every host-facing contract-pipeline schema. NOTE: the lean-light-review verdict (`nextStep.ts`) still asks the host for `created_at` — separate artifact/read-path, not yet stamped; (B5) **SHIPPED** — opt-in `merge-to-base` closing action kills the [[audit-tools-worktree-traps]] strand-trap: `ensureRemediationBranchCheckedOut` records the launch branch in a `remediation-base-branch.json` sidecar on first creation; `executeClosingAction` (close.ts) checks out that base and runs `git merge --no-ff remediation/<runId>` (one revertable merge commit), aborts+restores the remediation branch on any conflict (base untouched), skips with a manual-merge note when no base was recorded. Default posture unchanged — the action must be selected at the confirm step. **(C) Inefficient order / feeding:** (C2) `goal_spec`/`context_bundle`/`module_decomposition`/etc. are host-authored boilerplate for a one-file fix the tool could mostly pre-derive (→ subsumed by T1); (C3) **SHIPPED** — test-plan diff-carry: `captureTestPlanCarry` (`contractPipeline/testPlanCarry.ts`) snapshots each authored spec's identity (`name`+`scope_anchors`) + assertions keyed by obligation_id on ingest; `buildTestValidatorPlanScaffold(ledger, prior)` pre-fills assertions for every obligation whose premise is unchanged, blanks a renamed/re-scoped one (fail-safe toward re-author). **(D) Gate/RMW frictions:** (D1) **SHIPPED** — per-spec `scope_anchors` in the test-plan skeleton; (D3) **SHIPPED** — host-authored INPUT path separated from the tool-derived envelope path. The host now writes its plain payload to `<name>.input.json` (`contractInputFilePath`) and reads upstreams from the same input files — the host's world is entirely plain `.input.json`, it never sees an envelope. `ingestContractArtifacts` reads the input, validates, and derives the canonical content-hash envelope at `<name>.json` (`contractArtifactFilePath`, tool-owned bookkeeping for the staleness DAG); the on-disk file the host wrote is never mutated in place. Ingest is idempotent via semantic-projection hash (the persistent input file is not re-ingested unless its meaning changed — no re-fired snapshots). `archiveContractArtifact` now preserves the host input (the LLM emission) AND clears the canonical envelope so the completion gate re-fires. `detectStaleArtifacts` hardened against a partial envelope. Every host-facing path (the prompt artifactPaths, the scaffold self-checks, the cyclic-seam prompt + its manual-rewrite hatch) points at the input path.
- **Friction DETECTION is mechanical-only — semantic/process friction goes uncaptured; close-out recall UNDER-captures.** Proven repeatedly: the close-out named-dimensions recall prompt does not force a transcript/run-log WALK, so the host logs a few and misses many real frictions; "no friction" satisfies the gate. A host-kept journal does NOT fix this (same host-discretion anti-pattern). **Enforceable direction: the backend already OBSERVES most friction at its own step boundary — no transcript needed.** Nearly every friction is a backend-side event (a phase re-emitting the same gate errors N×, a judge repair round + back-half re-derive, an artifact rejected/archived, an obligation-ledger renumber, a no-change merge). Fix = (1) **auto-capture at the step boundary** (zero host discretion) for every such event; (2) **close-out becomes per-event RECONCILIATION not recall** — surface the backend-counted event list and force the host to disposition EACH (keep/annotate/dismiss-with-reason), like the review-gate; a blanket "no friction" is impossible because the tool already knows the phase fired N×; (3) keep an always-present **free-form channel** for transcript-only friction the backend can't see. The shared step-boundary chokepoint (`stepBoundaryCapture.ts`) + the named emitters + per-event reconciliation triage are shipped; **remaining: the M-QUOTA bounded-escalation event is not yet wired to the chokepoint, and a live run must confirm the emitters actually populate the close-out.** ROOT CAUSE found 2026-06-26: `HostSessionQuotaSource.recordLimit` (the method that drives the bounded escalation) has **ZERO production callers** — only the unit tests call it. So the *entire* `recordLimit → escalate → strand (rollingDispatch.ts:510 `isPacketEscalated`) → quota_escalation friction` chain is unwired end-to-end, not merely the friction tap: nothing records a host-session re-limit during the in-process rolling dispatch, so `isEscalated` is always false, the strand guard never fires, and there is no event to capture. The friction tap (`onEscalation → captureStepBoundaryFriction`) is the LAST link; before it, a correct fix must (1) call `recordLimit(packet.id, …)` at the rate-limit observation point in `createRollingDispatcher.handleResult` (`result.outcome === "rate_limited"`), which requires threading the SAME `HostSessionQuotaSource` instance through `buildConfirmedPools` → `driveRollingDispatch` → `createRollingDispatcher` (today buildConfirmedPools constructs a throwaway instance with no `onEscalation` and never exposes it); (2) derive `isPacketEscalated` from that instance; (3) route `onEscalation` to the chokepoint with the driver's artifactsDir/runId. Multi-seam integration gated on a live rate-limited multi-worker run to validate — fits the **dispatch capability-tiered driver** forward track (which owns the same instance-threading), not a blind batch landing. [[meta-audit-friction-must-be-tool-enforced]]
- **Selective-deepening tasks never converge — packet result task_id ≠ assigned `deepening:*` id.** Workers returned packet-style task_ids instead of the assigned `deepening:finding:*`, so merge-and-ingest never matched results to tasks and looped. The prompt-side fix (explicit task_id binding in `buildTaskSections`) is in place but **needs live validation** — can't be verified without a real deepening-capable run. Recovery until validated: quarantine orphan pending `deepening:*` tasks to let synthesis run.
- **Dispatch capability-tiered driver on top of the (shipped) host-quota wiring.** `HostSessionQuotaSource` is wired first-class into the scheduler (graduated `remaining_pct`, pre-wall LOW/CRITICAL bands, escalation-stranding) and the `rate_limited` non-consuming re-queue is in place. **Remaining:** the capability-tiered *driver* (Y-dispatcher vs slot-pull selection) on top of it — see the broker-driver forward track below.

- **Unwired-but-tested extractor is invisible dead code (friction, 2026-06-27).** F6 git-history mining shipped with
  a full extractor + 27 passing unit tests but was NEVER called by an executor — green tests + green build, yet the
  feature did nothing in a real run (caught only by reading the executor). Unit tests at the seam don't prove the seam
  is *invoked*. Enforceable direction: a mechanical guard that flags an exported extractor entry-point
  (`build*`/`mine*Artifact` in `src/audit/extractors/`) with zero non-test importers — an instance of the deferred
  dead-code detection (knip/ts-prune territory, see *own-vs-acquire* / [[graph-signals-thin-substrate-extraction-persist]]).
  Until then: when adding an extractor, the wiring into `runStructureExecutor` (or its executor) is part of "done", not a
  follow-up.

## Forward tracks

- **Precise `calls`/import edges via pure-JS `web-tree-sitter` (WASM) — candidate, deferred.** Our graph extraction
  (`src/audit/extractors/graph.ts`) resolves imports/calls by **regex**, which is approximate. A real AST pass would
  give precise `calls` edges. The OS-agnostic, no-native-build way (fits our two-tier dep policy + everything-agnostic
  principle) is **`web-tree-sitter` (WASM grammars)** as a new extractor behind the existing `GraphEdge` contract —
  borrow the *idea*, not a native toolchain. Surfaced by the 2026-06-28 evaluation of `safishamsi/graphify` (a Python
  tree-sitter knowledge-graph tool — not adoptable wholesale: native grammar wheels, Python stack, violates
  no-native-build). Secondary borrows from that eval: god-node/betweenness "surprise" signals, an
  EXTRACTED/INFERRED/AMBIGUOUS confidence ladder. Eval report: `graphify-evaluation.md` (saved to user Desktop).
  Efficiency/precision-only; defer until regex edge imprecision is a measured cost.
  ([[graph-signals-thin-substrate-extraction-persist]])
- **Codebase-wide review for churn / context / enforce-in-tooling — same lens, applied everywhere.** The
  append-only-ledger + granular-staleness + LLM-equivalence-gate work came from one perspective; run that same
  perspective over the *entire* codebase as a dedicated pass. Hunt for: (a) **unnecessary churn** — anywhere we
  recompute / re-derive / re-dispatch more than the actual delta demands (LLM judgment to gate expensive
  recompute is one tool among others); (b) **unnecessary context** — anywhere we ship or re-ship more than needed
  into a prompt or a step (diff-only / delta-only feeds are one strategy among others); (c) **enforce-via-tooling
  prevention** — anywhere a correctness property is currently held by host/maintainer discretion that could be
  made impossible-to-get-wrong at the abstraction so the issue never arises. Not limited to the named techniques —
  the goal is the perspective, applied broadly. (Ethan, 2026-06-24.) **PASS RUN 2026-06-27** — full
  findings in [`docs/reviews/churn-context-enforce-pass-2026-06-27.md`](reviews/churn-context-enforce-pass-2026-06-27.md).
  Shipped this pass: auth-session heuristic O(auth×files)→O(files) (moved to `accumulateCrossFileEdges`,
  single index sweep). **E1 ✅ SHIPPED (2026-06-27)** — the accept-time write-scope gate is now
  UNCONDITIONAL: `AcceptNodeWorktreeParams.scope` is REQUIRED (was optional → `if (params.scope)` could
  silently skip the gate), so a production caller can never skip it; `computeAcceptScope` no longer returns
  `undefined` on a plan-read failure — it falls back to `{ allBlockScopes: [] }` (empty registry owns nothing
  → every edit unowned-and-granted, no false block, while the git-probe fail-closed path still fires), so the
  enforcement is the type and the always-run gate, not host/state discretion. Lifecycle tests that don't
  exercise scope pass `{ allBlockScopes: [] }` (sound no-op). **E3 ✅ SHIPPED (2026-06-27, v0.30.43)** —
  executor-registry coverage is now a LOAD-TIME invariant: `assertExecutorRegistryCoversPriority()`
  (`src/audit/orchestrator/nextStep.ts`) throws at module load on a missing OR ambiguous PRIORITY→executor
  mapping, so the silent `selected_executor: null` "configuration gap" dead-end step is impossible. All
  PRIORITY ids covered today → zero behavior change; a future PRIORITY addition without a registry entry
  fails loudly at load. Test mirrors the property (`orchestration.test.mjs`). **E2 ✅ SHIPPED (2026-06-28, v0.30.44)** —
  `mergeImplementResultsIntoState` accounts each silently-omitted assigned finding (`incomplete_coverage_attempts`)
  and blocks it at the cap (2) → triage, so an incomplete worker result converges instead of re-dispatching forever;
  `implementResultCoversFindings`/`resolveCoveredFindingIds` made alias-aware (`collapseItemResults` already covered the
  duplicate + unknown-id cases). **C2 ✅ SHIPPED (2026-06-28, v0.30.45)** — incremental graph-build (per-file edge
  cache; see the deleted granular-staleness track). **Remaining: X-cluster** — prompts re-inline content already in the
  machine contract (remediate badge body, full `Finding[]` in state, synthesis/packet/quarantine renders) → one "packet
  carries minimal contract + sidecar pointers" design lap (verify worker sidecar-read first).
  Low-value/needs-design-intent (C3,C5,C6,E4,E5) not scheduled. **X-cluster RESOLVED (2026-06-28)** —
  adversarial verification FALSIFIED the "minimal dispatch contract + sidecar pointers" premise: workers
  do not read JSON sidecars (the dispatch contract grants source reads but never instructs a sidecar read),
  and the full `Finding` is genuinely consumed at outcomes-write time (`close.ts:191` stores it verbatim
  into `remediation-outcomes.json`). Of the 12 fields flagged as "dead in state", only 3 are truly unread
  (`likelihood`, `reproduction`, `executable_anchor`); the other 9 are LIVE (dedup ranking/merge,
  leanFastPath gate, reviewNecessity, autonomousGate, intent checkpointFilter, close report, dispatch
  grounding). So the X2 state-projection is **closed as not-worth-it** (a 3-optional-field trim doesn't earn
  the carry-forward-key + outcomes round-trip complexity). The genuine win — **X1 prompt-render trim** —
  shipped: `renderFindingBadgeBody` gained a `showAdvisoryMeta` opt (gates the worker-irrelevant
  `systemic`/`impact`/`likelihood` lines), set false in the implement-dispatch call, and the Contract
  Pipeline Traceability section (pure provenance: goal/obligation ids + a non-runnable copy of
  targeted_commands) was removed from the implement prompt with its now-dead helpers. Zero worker-behavior
  change; the runnable per-node commands still emit (build-free subset) in `perNodeVerificationSection`.

- **Schema-enforced generation everywhere possible — make malformed output impossible, not merely repairable.**
  Strict output schemas already exist (e.g. the worker zod schemas) but are shipped to workers only as *advisory
  reference files*; nothing forces the provider to honor them at generation time, so malformed contracts get
  emitted and only caught after the fact. Desired end-state: every structured-contract emission in the project —
  every dispatch path, every emitting agent, both orchestrators — uses the provider's strongest available
  output-constraint mechanism (forced tool-call / JSON-schema-constrained generation / structured output) so the
  schema is enforced at emit time and the malformed-output class is prevented at the source. Apply it everywhere
  a provider supports it; where a provider cannot enforce a schema, that path degrades to the layered repair seam
  (above) as the fallback — prevention first, repair as backstop. Must stay provider-agnostic: discover the
  enforcement capability per backend, never hardcode it. The emit-time seam is **present** (provider-agnostic
  `discoverOutputConstraintCapability`, strongest-at-emit `enforceSchemaAtEmit`, degrade-to-`runEmitValidateRepair`,
  ONE-VALIDATOR re-validate floor). **CE-009 SHIPPED (#14, 2026-06-27)** — the semantic-validity gate now catches the
  canonical schema-valid-but-wrong case: a `total_lines` that diverges from disk past BOTH an absolute floor (>2 lines)
  AND a ratio (>5%) is a hard-reject routed to re-dispatch (the worker's file view materially disagrees with disk → its
  findings' line refs are grounded against a stale/wrong version); small mismatches keep the S7 advisory warning.
  `isSignificantLineCountDivergence` single-sources the threshold (`src/audit/validation/auditResults.ts`). **Still
  open:** **CE-004** — the always-on conversation host (`claude-code`) advertises *no* API-level constraint mechanism,
  so on the primary path this reduces to the ONE-VALIDATOR repair floor (no emit-time prevention) — env-bound on a
  provider gaining a constraint endpoint; and broader semantic-validity checks beyond `total_lines` (fabricated paths,
  out-of-range spans are already gated; more are candidates). (Ethan, 2026-06-24; CE-009 slice 2026-06-27.)

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
  The single-source classifier + broker primitive are **shipped** (`classifyProvider` returns ONE
  `{hostClass, concurrencyFloor, driverMechanism}` struct, floor constants off the public surface;
  `computeDispatchCapacity` never-over-dispatch caps; `HostSessionQuotaSource` channel-isolated recordLimit +
  bounded escalation). **Driver SELECTION + prompt rendering SHIPPED (#13, 2026-06-27)** — `selectDispatchDriver`
  resolves Y-dispatcher vs slot-pull (vs in-process) off the single classification + the live frontier size and slot
  count (`DISPATCH_Y_DISPATCHER_MIN_ITEMS` threshold; a small frontier or single slot drives slot-pull, a large
  frontier on a capable agent host delegates the rolling loop to a dedicated dispatcher subagent);
  `renderDispatchDriverInstruction` single-sources the host instruction so audit + remediate can't drift, and both
  orchestrators' rolling dispatch prompts now render the tool-chosen driver instead of a static "maintain N concurrent"
  line. **Still open (env-bound):** live Y-dispatcher validation (needs a nested-agent host + a live run) and
  proactive pre-wall quota-aware pacing. (Ethan, 2026-06-24; driver-selection slice 2026-06-27.)

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

- **Git-history mining — ✅ SHIPPED (wired 0.30.34).** Mines `git log` (not the AST) for signals static analysis
  structurally cannot see. The extractor (`src/audit/extractors/gitHistory.ts`) + shared miner (`src/shared/git.ts`
  `mineGitHistory`) existed and were unit-tested, but were **never wired into an executor** — `runStructureExecutor`
  now mines git history end-to-end: co-change coupling lands in its OWN `graph_bundle.graphs.co_change` bucket
  (`GIT_CO_CHANGE_CATEGORY`, deliberately NOT `references` — `allGraphEdges` skips it so temporal coupling never
  feeds cycle/hub/seam detection), `git-history` is recorded in `analyzers_used` (and `buildEnrichedGraph` now unions
  rather than replaces provenance so enrichment can't drop it), churn/authorship risk signals merge via
  `mergeAnalyzerRiskSignals`, and the churn × complexity compound — `risk_concentration`, the real risk
  concentration — is derived by `deriveRiskConcentration` (informational; never touches `risk_score`). Persisted as
  the first-class `git_history.json` artifact. The design-assessment **hidden-coupling** finding
  (`detectHiddenCoupling`, v0.30.35) consumes the `co_change` bucket: co-change pairs (confidence ≥ 0.5, i.e.
  ≥ 3 shared commits) with NO structural import/call/reference edge surface as `hidden_coupling` architecture
  findings (strongest-first, capped at 10) — the temporal coupling static analysis cannot see. _Nothing open on
  this track._

- **Secret scanning = ACQUIRE via gitleaks (✅ SHIPPED — slices A–E done).** The from-scratch OWN `detectSecrets`
  detector briefly shipped as 0.30.36 and was **reverted** (`a10b79cd`) — a hand-rolled secret scanner is a worse
  gitleaks and breaks the two-tier dependency policy. Secret scanning is now acquired via gitleaks through the F5
  acquisition engine, wired end-to-end. **A** (`f5097e72`) per-tool `ExternalAnalyzerResults[]`; **B** (`c2a467a2`)
  `binary` runner + `binaryAcquisition.ts` (PATH→cache→pinned-release download, checksums SHA256-verify before `tar`,
  injectable fetcher); **C** (`7c393409`) `EXTERNAL_ANALYZER_CANDIDATES` (gitleaks default-on pinned 8.21.2, raw
  Secret/Match dropped; semgrep/eslint consent-gated; secret-scan off `OWNED_TOOL_IDS`); **D** production wiring —
  `external_analyzers_current` obligation + `external_analyzer_acquisition_executor` (`src/audit/orchestrator/
  acquisitionExecutor.ts`) between `syntax_resolved` and `structure_artifacts`, marker
  `external_analyzer_acquisition.json` (DAG deps {repo_manifest, file_disposition}), hermetic gate
  `AdvanceAuditOptions.externalAcquisition.{enabled,fetch,consentToken}` (disabled everywhere except the real CLI
  next-step path → suite never spawns/downloads), tests `acquisition-executor.test.mjs`; **E** surface — findings
  rejoin via `buildExternalAnalyzerFollowupTasks` → high-priority security tasks → mergeFindings external evidence
  (same seam as imported analyzers). Default-ON on the real CLI; `session-config.external_acquisition.enabled:false`
  opts out; `consent_token` unlocks semgrep/eslint. The plan doc has been deleted (shipped).
  [[deterministic-analyzers-own-vs-acquire]]

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
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built and green (4 hosts).
  **Codex live-dispatch e2e is now REAL + passing (v0.30.48, 2026-06-28):** it imported a `runCodexHeadlessAuditDispatch`
  that was never implemented (always-skipped → latent `TypeError`); implementing + running it live surfaced two real
  bugs that made headless codex dispatch fail end-to-end on Windows: (1) codex provider missing `--skip-git-repo-check`
  (codex 0.142.3 refuses `exec` in untrusted/temp dirs, exits 1 pre-work); (2) `spawnLoggedCommand` cmd.exe-shim
  quote-mangling — Node re-escaped the pre-quoted `cmd /c` command line so codex got malformed paths (`os error 123`),
  fixed with `windowsVerbatimArguments` (also fixes the opencode provider, same shim). **Generalized into ONE
  provider-matrix e2e (2026-06-28):** the per-provider hardcoded tests (a7 codex e2e + nim-rolling-audit e2e) were
  replaced by `tests/audit/provider-matrix-dispatch-e2e.test.mjs` (gate `RUN_PROVIDER_MATRIX_E2E=1`), which runs the
  SAME bounded in-process dispatch round-trip through EVERY available provider — candidate set from the production
  `discoverProviders` layer (+ `api_key_env` presence for the API provider), unavailable ones skipped with the
  discovery layer's own reason, fails if nothing was reachable. Driver generalized to provider-agnostic
  `runInProcessAuditDispatch({root, sessionConfig})`. Verified live: codex ✔ + openai-compatible/NIM ✔ both
  round-tripped; opencode skipped (not installed). Adding a backend now needs no new test. **Remaining:** the
  release-time manual GUI checklist run ([`host-validation.md`](../spec/host-validation.md)) for the GUI-only hosts
  (Antigravity/OpenCode).
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned subtasks
  (can't be unit-tested; user-owned). Folds into the A7 checklist.
- **Gated live e2es** skip without creds: `RUN_PROVIDER_MATRIX_E2E=1` (in-process audit dispatch across all
  available providers — codex + openai-compatible/NIM live-verified 2026-06-28), `RUN_NIM_E2E=1` (hybrid-spill +
  remediate rolling), `AUDIT_TOOLS_LIVE_QUOTA=1`, `RUN_AUTONOMY_E2E=1` (autonomy capstone a9 — still
  NIM-hardcoded; candidate for the same provider-matrix generalization).
- **Provider `queryLimits`** deferred — an absent method and a `null` return are handled identically, so stubs
  change nothing; revisit if a provider gains a real proactive rate-limit endpoint.
- **headroom proxy** — enable + validate the `headroom proxy` (auto-compresses tool-output traffic) in one
  opt-in session before any global env flip. **Progress (2026-06-28):** opentoken command-wrapper plumbing confirmed
  100% gone from `src/` (the `no-opentoken-guard` test was scanning the dead pre-A12 `packages/*/src` layout →
  vacuously green; fixed to scan `src/` + assert non-vacuous coverage). headroom MCP compression engine validated
  lossless (original stored, `retrieve` returns byte-identical) and `router:noop`s contract JSON. **`DO_NOT_TOKEN_WRAP_NOTE`
  DELETED** — its premise (a command-wrapper corrupting JSON stdout) was specific to the prior opentoken package;
  headroom doesn't wrap commands (transparent lossless HTTP proxy + noop on contract JSON), so the constraint the
  note warned against no longer exists. Removed the const + re-export + 4 prompt usages (audit ×2, remediate ×2).
  **Proxy validated 2026-06-28 — flip BLOCKED by a real defect (the gate paid off):** started `headroom proxy`
  (v0.20.15, installed via `uv tool`) and it **crashes on boot in default optimize mode** —
  `FATAL: Rust extension headroom._core not loadable (ModuleNotFoundError: No module named 'headroom._core')`.
  Flipping the global `ANTHROPIC_BASE_URL` to it would have bricked Claude Code sessions. Degraded Python-only mode
  (`HEADROOM_REQUIRE_RUST_CORE=false`) boots fine and forwards correctly (livez/readyz/health 200; a `/v1/messages`
  POST reached api.anthropic.com and returned an intact upstream 401 for a dummy key) — but degraded = **no
  optimization**, a pointless no-op forwarder. Root cause: no prebuilt Windows wheel for `headroom-ai`, so
  `uv tool install headroom-ai --reinstall` builds the Rust core from source and **fails at link** (`error: linking
  with link.exe failed: exit code 1`) — MSVC `link.exe` (Visual Studio C++ Build Tools) is not available; no
  Windows wheel exists on PyPI (macOS-arm64 + manylinux only). **RESOLVED 2026-06-28 via WSL (Option B) — proxy now
  RUNS durably:** WSL Ubuntu 26.04 (systemd active), `uv tool install "headroom-ai[proxy]"` (manylinux wheel → `_core`
  present, no build; the `[proxy]` extra is REQUIRED or it errors "Proxy dependencies not installed"), durable systemd
  service `headroom-proxy` (`--host 0.0.0.0 --port 8787`, enabled + active, Restart=on-failure). Optimize mode ENABLED,
  reachable from Windows via WSL2 localhost-forwarding (`http://127.0.0.1:8787`, livez/readyz/health 200, `/v1/messages`
  forwards intact). Full setup in project memory ([[headroom-proxy-broken-windows-no-rust-core]]). **Still pending
  (user-owned):** the one opt-in session that confirms contract JSON survives the proxy's compression, before flipping
  the GLOBAL `ANTHROPIC_BASE_URL`; and a Windows login trigger so WSL (hence the proxy) is up at session start.
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
- **`node --test` needs the tsx loader**: `node --import tsx/esm --test <file>` (bare `node --test` can't
  resolve `audit-tools/shared` via tsconfig `paths`). Same for `npm run test:single`.
- **Don't mask the test exit code.** `node --test … ; echo "exit=$?"` and `npm test > out; echo done` report
  the *trailing* command's exit, not the suite's — and piping through `grep`/`rm` in the same Bash call races
  the output file, so a real failure reads as "green." Capture the suite's own status: `npm test > out 2>&1 &&
  echo PASS || echo "FAIL=$?"`. (Mis-reading a masked exit shipped a release whose CI then failed.)
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
- **`t.mock.module` is unusable** under the tsx/esm loader → use a dependency-injection seam instead.
