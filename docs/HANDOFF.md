# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail.

## Live state

- On npm as `latest` (current version tracked in `package.json`, not pinned here). `main ==
  audit-tools/main`, clean tree.
- **Latest lap (2026-06-28): A7 Codex live-dispatch e2e made REAL — fixed 2 headless-codex Windows bugs. Shipped v0.30.48.**
  Working the blocked ladder, the A7 Codex e2e (`tests/audit/a7.test.mjs`, `RUN_CODEX_E2E=1`) imported
  `runCodexHeadlessAuditDispatch` from `nextStepCommand.ts` — a function that **never existed** (always-skipped test →
  latent `TypeError`, same class as the vacuous opentoken guard). Implemented it (mirrors the NIM rolling-audit e2e:
  `provider:codex` + `rolling_engine` on → `runDeterministicForNextStep` routes `audit_tasks_completed` review through
  the in-process rolling engine, which launches real headless codex per packet; loops until a result lands). Running it
  live surfaced **two real production bugs** that made headless codex dispatch fail end-to-end on Windows: (1) codex
  provider missing `--skip-git-repo-check` — codex 0.142.3 refuses `exec` in untrusted/temp dirs and exits 1 pre-work;
  (2) `spawnLoggedCommand` cmd.exe-shim quote-mangling — Node re-escaped the pre-quoted `cmd /d /s /c "<line>"` so codex
  received malformed paths (`os error 123`), fixed with `windowsVerbatimArguments` (scoped win32+cmd.exe; **also fixes
  the opencode provider** — same shim). Live e2e now round-trips real review results (all packets accepted, exitCode 0,
  ~163s). Test rewritten to deploy the codex host surface + drive a planning-ready fixture (no test-fixture deps in src).
  Full gate green (audit node:test + remediate vitest 2071/2-skip).
- **Prior lap (2026-06-28): blocked-item ladder — headroom-track cleanup + A7 automated check. Shipped v0.30.47.**
  Working the deferred/env-bound backlog easiest-first. (1) **Repaired the vacuous `no-opentoken` guard** — it scanned
  the dead pre-A12 `packages/*/src` layout → `walk()` returned nothing → vacuously green, guarding NOTHING (an
  enforce-in-tooling latent failure: a guard that doesn't guard). Now scans the real single-package `src/` + asserts
  >50 files scanned so a future layout move can't make it vacuous again. Confirmed opentoken plumbing is 100% gone
  from `src/`. (2) **Deleted `DO_NOT_TOKEN_WRAP_NOTE`** (D7) — its premise (a command-wrapper corrupting JSON stdout)
  was opentoken-specific; headroom (the replacement) doesn't wrap commands — it's a transparent lossless HTTP proxy
  that `router:noop`s contract JSON (validated via the MCP compress/retrieve round-trip: original stored, retrieve
  byte-identical). Removed const + shared re-export + 4 prompt usages (audit ×2, remediate ×2). (3) **A7 automated
  portion green** — `verify:hosts` passes all 4 hosts (codex/opencode/vscode/antigravity). Full gate green (audit
  node:test + remediate vitest 2071/2-skip). **Still env-bound (need user/live host):** headroom HTTP-proxy flip
  (`ANTHROPIC_BASE_URL`→127.0.0.1:8787 in a real session), A7 manual GUI checklist + Codex live e2e, OpenCode
  permission propagation, gated live e2es (creds), A2 oracle (hand-labeled corpus), live Y-dispatcher (nested-agent
  host), prose-staleness (defer until churn measured), `queryLimits` (no-op until a provider gains an endpoint).
- **Prior lap (2026-06-28): T5 #15 X-cluster — RESOLVED (X1 prompt-trim shipped, X2 closed). Shipped v0.30.46.**
  An adversarial verification pass falsified the review doc's headline ("packets re-inline machine-contract content →
  one minimal-contract + sidecar-pointers design lap"). Two facts killed the projection: (1) the dispatch contract
  **never instructs a worker to read a JSON sidecar** (it grants source-file reads only), and (2) the full `Finding` is
  consumed verbatim at outcomes-write (`close.ts:191` → `remediation-outcomes.json`). A first trace called 12 `Finding`
  fields "dead in state"; the skeptic pass found only **3 truly dead** (`likelihood`, `reproduction`,
  `executable_anchor`) — the other 9 are LIVE (cross-lens dedup ranking+merge, leanFastPath gate, reviewNecessity,
  autonomousGate, intent checkpointFilter, close report, dispatch grounding). So the X2 state-projection is **closed as
  not-worth-it**. The genuine, zero-behavior-change win shipped (X1): `renderFindingBadgeBody` gained a
  `showAdvisoryMeta` opt (gates the worker-irrelevant `systemic`/`impact`/`likelihood` badge lines), set false only in
  the implement-dispatch call; the **Contract Pipeline Traceability** section (pure provenance — goal/obligation ids + a
  non-runnable copy of `targeted_commands`) was removed from the implement prompt with its now-dead helpers
  (`contractPipelineTrace{Lines,Bullets}`). The runnable per-node commands still emit (build-free subset) in
  `perNodeVerificationSection`. Tests flipped to lock the trim (`dispatch-conventions.test.ts`,
  `next-step-pipeline-dispatch.test.ts`). Full gate green (audit 2508/0, remediate 2071). **T5 #15 closes — nothing
  scheduled remains; only env-bound T6 is open.**
- **Prior lap (2026-06-28): C2 — incremental graph-build (T5 #12 residual). Shipped v0.30.45.** The graph build
  re-read + re-regexed + re-metric'd every in-scope file on any one-file change; now each file's per-file edge
  contribution is cached and reused when unchanged, so a single edit only re-extracts that file. Keyed on (REAL
  content hash + global pathLookup hash) — reuse iff both match, any drift re-extracts (fail-safe); cross-file work
  (`accumulateCrossFileEdges`: auth-session/conftest/suite/analyzer) ALWAYS re-runs (global, never cached). The
  per-file loop body is extracted into `extractPerFileContribution` (behavior-identical, push order preserved →
  byte-identical bundle). Cache is self-describing (`path_lookup_hash` + per-entry `content_key`) so it needs NO
  artifact_metadata baseline and is NOT a staleness-DAG node — a special-loaded bundle artifact `graph-edge-cache.json`
  (read in `loadArtifactBundle`, written in `writeCoreArtifacts`, like `active_dispatch`). Adversarial review hardened
  the soundness gate: `content_key` is a real content hash ONLY — a hash-less file is never cached/reused (the size
  fallback would falsely reuse an equal-byte edit), so the cache is sound regardless of whether the manifest enabled
  hashing. New: `src/audit/orchestrator/graphEdgeCache.ts`; tests `tests/audit/graph-edge-cache.test.mjs` (6).
  **T5 #12 granular-staleness track is now COMPLETE** (coverage, results, design-review, git-history, graph-build all
  done). Remaining T5 #15 open: **X-cluster** (minimal-dispatch-contract design lap).
- **Prior lap (2026-06-28): T5 #15 E2 — bound incomplete-coverage re-dispatch so omitted findings converge. Shipped v0.30.44.**
  A worker that silently OMITS an assigned finding from its `item_results` (no entry — distinct from blocked/unknown)
  left it `pending` at merge and dispatch re-dispatched it every wave with NO attempt accounting → unbounded loop.
  `mergeImplementResultsIntoState` now counts each omission (`incomplete_coverage_attempts`) and at the cap (2) blocks
  the finding (→ triage) so a no-human run converges (T2 termination). `implementResultCoversFindings` /
  `resolveCoveredFindingIds` are now alias-aware (same resolution as `collapseItemResults`) so an alias-using-but-complete
  result isn't falsely re-dispatched forever. Tests in `dispatch-merge-tolerance.test.ts`. (`collapseItemResults`
  already covered duplicates + unknown ids; E2 was the missing-finding convergence gap.)
- **Prior lap (2026-06-27): T5 #15 E3 — executor-registry coverage made a LOAD-TIME invariant (enforce-in-tooling). Shipped v0.30.43.**
  `assertExecutorRegistryCoversPriority()` (`src/audit/orchestrator/nextStep.ts`) runs at module load and throws on a
  missing OR ambiguous PRIORITY→executor mapping, so the silent runtime "configuration gap" (`selected_executor: null`,
  a dead-end dispatch step) is now impossible instead of surfaced after a run starts. All PRIORITY ids are covered
  today (verified) → zero behavior change; the guard makes a future PRIORITY addition without a registry entry fail
  loudly at load. Regression test mirrors the property (`orchestration.test.mjs`). Full gate green (audit node:test +
  remediate vitest 2069/2 skipped). Remaining T5 #15 open: X-cluster (minimal-dispatch-contract design lap), C2/C4
  (incremental graph-build = T5 #12 residual), E2 (worker item_results completeness — verify collapseItemResults
  coverage first).
- **Prior lap (2026-06-27): T5 #15 E1 — accept-time write-scope gate made UNCONDITIONAL (enforce-in-tooling).**
  `AcceptNodeWorktreeParams.scope` is now REQUIRED (was optional → `if (params.scope)` could silently skip the
  OBL-DS-06 write-scope gate before the cherry-pick); `computeAcceptScope` no longer returns `undefined` on a
  plan-read failure — it falls back to `{ allBlockScopes: [] }` (empty registry owns nothing → every edit
  unowned-and-granted, no false block, git-probe fail-closed path still fires). The gate is the type + the
  always-run call, never host/state discretion. Both rolling drivers already supplied scope; lifecycle tests
  that don't exercise scope pass `{ allBlockScopes: [] }` (sound no-op). `src/remediate/steps/dispatch.ts` +
  `rollingSession.ts`; tests updated in `dispatch-worktree.test.ts` + `host-rolling-dispatch.test.ts`. Suite green
  (remediate vitest 2069; audit node:test). Remaining T5 #15 open items unchanged (X-cluster, C2/C4, E2/E3).
- **Prior lap (2026-06-27): T5 #15 codebase-wide churn / context / enforce-in-tooling review pass.** Three
  parallel review agents (one per category) swept the repo; verification-tiered findings landed in
  [`docs/reviews/churn-context-enforce-pass-2026-06-27.md`](reviews/churn-context-enforce-pass-2026-06-27.md).
  Shipped a clean verified win: **auth-session heuristic O(auth×files)→O(files)** — `extractHeuristicAuthSessionEdges`
  moved out of the per-file loop into `accumulateCrossFileEdges` (its named cross-file home) with a single
  index sweep (`src/audit/extractors/graph.ts`); edges identical (uniqueSortedEdges normalizes order). Promoted
  open items to backlog #15: **E1** write-scope gate `if (params.scope)` optional → make `allBlockScopes`
  required (verified, highest-certainty enforce win); **X-cluster** prompts re-inline machine-contract content
  → one "minimal contract + sidecar pointers" design lap; **C2** incremental graph-build extraction = the T5 #12
  known residual; **E2/E3** worker item-completeness + null-executor rejects. Suite green (audit node:test +
  remediate vitest 2069).
- **Prior lap (2026-06-27): T5 #12 incremental structure phase — git-history mine reuse.** `runStructureExecutor`
  now reuses the carried `git_history` (skips the full `git log` walk + O(files²) co-change aggregation — the
  structure phase's costliest deterministic step) when neither HEAD nor the in-scope file set moved since the
  `{head, scope_key}` baseline in `artifact_metadata.git_history_baseline`; any drift re-mines (fail-safe). New:
  `src/audit/orchestrator/gitHistoryBaseline.ts`, `headCommit` (`src/shared/git.ts`), `gitHistoryInScopeKeys`
  single-sourcing the in-scope set. Tests: `tests/audit/git-history-incremental.test.mjs` (7). **Survey finding
  recorded:** the granular-staleness targets that matter (re-derive destroys expensive state) are now ALL done —
  coverage, results, design-review, git-history; the remaining structure artifacts are deterministic+idempotent
  (preserving them is gratuitous), and the only real residual is incremental graph-build extraction (a careful
  pathLookup-keyed lap, not a baseline mirror). See T5 #12 + backlog.
- **Prior lap (2026-06-27): T5 #12 coverage + #14 + #13 actionable slices** — content-addressed granular coverage
  staleness, CE-009 semantic-validity gate on significant `total_lines` divergence (#14), and capability-tiered
  dispatch driver-selection + prompt rendering (#13). See the T5 entries below; full detail in `docs/backlog.md`.
- **Secret scanning = gitleaks via the acquisition engine — slices A–E COMPLETE.** The from-scratch OWN
  detector (npm `0.30.36`) stays reverted (`a10b79cd`); the working tree wires gitleaks end-to-end through the
  acquisition engine: new `external_analyzers_current` obligation + `external_analyzer_acquisition_executor`
  (between `syntax_resolved` and `structure_artifacts`), hermetic gate (`AdvanceAuditOptions.externalAcquisition.
  {enabled,fetch,consentToken}` — disabled everywhere except the real CLI next-step path, so the suite never
  spawns/downloads), marker artifact `external_analyzer_acquisition.json` (DAG deps {repo_manifest,
  file_disposition}). Findings rejoin at the SAME seam as imported analyzers (`buildExternalAnalyzerFollowupTasks`
  → high-priority security tasks → mergeFindings external evidence), so gitleaks secrets surface in
  audit-findings.json. Do not re-introduce the from-scratch detector. **Shipped v0.30.37** (supersedes 0.30.36);
  the published bin's secret scanning is now gitleaks via the acquisition engine.

## Cadence & standing rules (don't re-derive)

- **Risk-tier every lap** ([[risk-tier-loop-laps-cheap-vs-heavy]]): full adversarial contract pipeline only
  for risky/complex changes; trivial mechanical clusters run lean (one implementation agent → full-suite
  gate → ship). This is the *host workaround* until the self-scaling pipeline (T1) makes it the tool's job.
- **Full friction walk every lap** ([[log-all-friction-categories-every-lap]]): log all three categories
  (ambiguous-direction / tool-should-decide / inefficient-feeding) to backlog + `open_observations`; don't
  trust the empty mechanical friction set.
- **Release:** `env -u CLAUDECODE npm run release:patch:publish`; recover a bad attempt with
  `gh release delete vX.Y.Z --cleanup-tag` + forward-bump. Run gate/test with `env -u CLAUDECODE`.
  Run `env -u CLAUDECODE npm run verify:release` locally before tagging (local pre-tag gate is only `check`).
- **Branch-strand trap (bit twice this session):** a remediation run leaves you checked out on its
  worktree branch — commit/push docs from `main` (verify `git rev-parse --abbrev-ref HEAD`) or the commit
  strands off main.

---

## Suggested ordering — everything open, sequenced

Rationale: the **loop is the meta-tool**; making it cheaper, convergent, and safe has compounding leverage
on all downstream work, and is the "redesign before scheduled autonomy" the north star requires
([[autonomous-pipeline-capstone-spec]]). So: loop-infra (T1–T2) → headline capability (T3) → cheap
ergonomics (T4) → product/analysis tracks (T5) → deferred (T6).

### T1 — Self-scaling pipeline — ✅ COMPLETE
Design of record: [`spec/self-scaling-pipeline-design.md`](../spec/self-scaling-pipeline-design.md)
([[self-scaling-pipeline-not-forked-paths]]). All slices shipped: 1 degenerate-collapse, 2 shared signal,
3a depth dial, 3b lean-light-review, 4a escalate-on-evidence, **4b granularity collapse**
(`roundTripGranularityForTier`: low ⇒ framing phases fold into ONE round-trip; un-collapses on 4a escalation;
best-effort fall-back to fine-grained). _Nothing open on this track._

### T2 — Make the loop converge & safe (enables unattended autonomy)
4. **repair-cap → convergence-termination — ✅ SHIPPED.** `evaluateJudgeGate` is fixpoint-terminated:
   approved ⇒ proceed; new accepted CE ⇒ repair; all-already-addressed ⇒ escalate (blocked user-decision);
   `MAX_CONTRACT_REPAIR_ITERATIONS` is now the loud runaway backstop (2 ⇒ 8).
5. **Friction detection is mechanical-only — DESCOPED (env-bound).** Recon found `HostSessionQuotaSource.recordLimit`
   has ZERO production callers, so the whole record→escalate→strand→`quota_escalation`-friction chain is unwired
   end-to-end (not just the friction tap); validating a fix needs a live rate-limited multi-worker run. Root cause +
   seam map recorded in backlog → friction-detection entry; folds into the dispatch capability-tiered driver track.
   *([[meta-audit-friction-must-be-tool-enforced]])*
6. **P0 — data-loss on a GENUINE fail-loud — ✅ FIXED.** `quarantineUncommittedWorktreeEdits` preserves the
   worker's uncommitted source edits under a durable quarantine ref before `removeWorktree` on a commit-refusal.

### T3 — Headline product capability — ✅ COMPLETE
7. **Remediator auto-phasing — derivation + persistence + ordinal threading + scheduler barrier + per-phase
   boundary gate ALL SHIPPED.** Phase cut is PERSISTED as a first-class sidecar `intake/contract/phase_cut.json`
   (`src/remediate/contractPipeline/phaseCutArtifact.ts`); each promoted block carries a mechanically-derived
   `phase_ordinal`; the rolling scheduler enforces a HARD barrier (INV-PHASE-01, `rollingDependencyLevels`):
   foundations→consumers honoured end-to-end. **The final sliver landed 2026-06-27:** a whole-repo test-suite
   gate now runs AT each phase boundary — `phaseBoundaryToGate(state)` (pure, reblock-safe: fires once at the
   untouched entry of each phase P>0) drives `runPhaseBoundaryGate`, interposed in the `implementing` obligation
   BEFORE `buildImplementDispatchStep`. It reuses the all-terminal gate's machinery (`runToolOwnedFinalGate` +
   `applyCoarseReblock` + shared `final-gate.json` sidecar, INV-RS-09/CE-003), so a red foundations phase is
   caught + attributed to that phase before consumers build on it (earlier + more attributable than the close
   gate), and a no-human host converges deterministically. Tests: `rolling-scheduler.test.ts`
   (`phaseBoundaryToGate` predicate: phase-0-no-gate, phase-1-entry, no-re-gate-mid-phase, next-boundary,
   ordinal-free, empty-frontier, dead-ended). _Nothing open on this track._

### T4 — Remaining host-friction inventory (cheap lean laps once T1 lands)
8. **A-items (ambiguous backend direction → host had to pick): ✅ ALL SHIPPED.** A1 (blocking-critique→repair)
    + A2 (judge marked MANDATORY-independent) shipped 0.30.29. **A3 merged-base check command pinned** —
    `mergedBaseCheckArgv(root)` (new leaf module `src/remediate/steps/gateCommands.ts`, single-sourcing
    `isAuditToolsMonorepo` / `toolOwnedFinalGateCommands` so `dispatch.ts` reuses the gate's `check`-layer argv
    with no import cycle) replaces the hardcoded `"npm run check"` default; runs via `runCommand` (argv +
    CLAUDECODE scrub, no `shell:true`); `null`/skip on a non-monorepo target. _Nothing open on this track._
9. **B-items (tool-should-decide):** **B2 ✅ SHIPPED** (`buildImplementationDagScaffold` groups a module's
    obligations into ONE node via a `module` field threaded onto design_spec obligations — 1-module change derives
    1 node); **B3 ✅ SHIPPED** (advisory-critique carrier `addressed_critique_items` + `advisoryCritiqueItems()`);
    **B4 ✅ SHIPPED** (`created_at` tool-stamped, dropped from host schemas — except the lean-light-review verdict,
    a separate read-path); **B5 ✅ SHIPPED** (opt-in `merge-to-base` closing action: tool records launch branch in
    a sidecar, at close does `git merge --no-ff remediation/<runId>`, aborts+restores on conflict, base untouched
    by default — kills the strand-trap without changing the safe default). (B1 subsumed by T3.) _Nothing open on
    this track._
10. **C/D residue:** **C3 ✅ SHIPPED** (test-plan diff-carry: `captureTestPlanCarry` snapshots authored specs on
    ingest, `buildTestValidatorPlanScaffold` pre-fills assertions for obligations whose premise is unchanged —
    fail-safe toward re-author). **D1 ✅ SHIPPED** (per-spec `scope_anchors`). **D3 ✅ SHIPPED** — host INPUT path
    (`<name>.input.json`, `contractInputFilePath`) separated from the tool-owned canonical envelope (`<name>.json`):
    host writes/reads only plain `.input.json`; ingest derives the envelope (idempotent via semantic-hash, never an
    in-place re-wrap); `archiveContractArtifact` preserves the host input + clears the canonical so the gate re-fires;
    every host-facing path points at the input file. Remaining: C2 host-authored boilerplate for trivial scope
    (→ subsumed by T1). *(all in backlog → "Contract-pipeline host-friction inventory")*
11. **Selective-deepening task_id convergence** — partial fix needs a live deepening-capable run to validate.

### T5 — Product / analysis forward tracks
12. **Content-addressed granular staleness — ✅ TRACK COMPLETE (2026-06-28).** Coverage slice
    (`coverageElementBaseline.ts`), per-result ledger (`resultBaseline.ts`), design-review snapshots, git-history mine
    (`gitHistoryBaseline.ts`), and now **incremental graph-build (C2, v0.30.45)** — `buildGraphBundle` caches each
    file's per-file edge contribution keyed (real content hash + global pathLookup hash), reuses unchanged, re-extracts
    on drift; cross-file work always re-runs (`extractPerFileContribution`, `graphEdgeCache.ts`,
    `graph-edge-cache.json`). Every target where re-derive destroys expensive carried state is done; the remaining
    structure artifacts are deterministic+idempotent (preserving = gratuitous). _Nothing open on this track._
    *([[graph-signals-thin-substrate-extraction-persist]])*
13. **Tool-enforced dispatch broker — ✅ driver SELECTION + prompt rendering SHIPPED (2026-06-27).**
    `selectDispatchDriver` picks Y-dispatcher vs slot-pull vs in-process off the single classification + live
    frontier/slots (`DISPATCH_Y_DISPATCHER_MIN_ITEMS`); `renderDispatchDriverInstruction` single-sources the host
    instruction across both orchestrators. **Remaining (env-bound):** live Y-dispatcher validation (nested-agent host)
    + proactive pre-wall pacing. *(forward track)*
14. **Schema-enforced generation everywhere** — emit-time seam present; **CE-009 SHIPPED (2026-06-27):** semantic-validity
    gate hard-rejects significant `total_lines` divergence (>2 lines AND >5%) → re-dispatch, small stays S7 advisory
    (`isSignificantLineCountDivergence`). **Residual:** CE-004 (claude-code advertises no API constraint → ONE-VALIDATOR
    repair floor) is env-bound; broader semantic checks are candidates.
15. **Codebase-wide churn / context / enforce-in-tooling review** — pass run 2026-06-27
    ([`docs/reviews/churn-context-enforce-pass-2026-06-27.md`](reviews/churn-context-enforce-pass-2026-06-27.md)).
    Shipped: auth-session O(auth×files)→O(files), E1 write-scope required-param, E3 load-time executor-registry
    invariant, **E2 incomplete-coverage convergence (v0.30.44)**, **C2 incremental graph-build (v0.30.45)**.
    **X-cluster RESOLVED (v0.30.46):** adversarial verification falsified the "minimal contract + sidecar pointers"
    premise — workers never read JSON sidecars and the full `Finding` is consumed verbatim at outcomes-write
    (`close.ts:191`); only 3/12 flagged fields are truly dead (9 are live in dedup/fastpath/review/intent/close), so
    the X2 state-projection is closed as not-worth-it. Shipped the genuine win — **X1 prompt-render trim**
    (`showAdvisoryMeta` opt gates worker-irrelevant systemic/impact/likelihood; Contract Pipeline Traceability section
    removed from the implement prompt with its dead helpers; zero worker-behavior change). Low-value/needs-design-intent
    items (C3,C5,C6,E4,E5) not scheduled. **T5 #15 now has nothing scheduled.**
16. **Deterministic analyzers — own-vs-acquire acquisition engine** — build the agnostic on-the-fly
    acquire+run+normalize engine (adapters are fixture-ready). **Git-history mining ✅ SHIPPED (0.30.34)** —
    `runStructureExecutor` now wires the (previously unwired) F6 extractor: co-change → own `co_change` graph bucket
    (skipped by `allGraphEdges` so it never feeds structural signals), churn/authorship risk signals, churn ×
    complexity `risk_concentration` compound, persisted `git_history.json`. **Hidden-coupling design finding
    SHIPPED (0.30.35)** — `detectHiddenCoupling` surfaces co-change pairs with no structural edge.
    **✅ Secret scanning — own-vs-acquire CORRECTED + SHIPPED via gitleaks.** All five slices A–E done: array
    artifact model (`f5097e72`), binary runner + checksum-verified download seam (`c2a467a2`), gitleaks candidate
    (`7c393409`), **D production wiring** (`external_analyzers_current` obligation + `external_analyzer_acquisition_executor`
    + marker artifact + hermetic `externalAcquisition.{enabled,fetch,consentToken}` gate; tests
    `acquisition-executor.test.mjs`), **E surface** (findings rejoin via `buildExternalAnalyzerFollowupTasks` →
    mergeFindings, same seam as imported analyzers). Default-ON on the real CLI next-step path (gitleaks pinned
    8.21.2, PATH→cache→checksum-verified download); `session-config.external_acquisition.enabled:false` opts out;
    `consent_token` unlocks semgrep/eslint. _Nothing open on this track._ *([[deterministic-analyzers-own-vs-acquire]])*

### T6 — Deferred / waiting (env-bound or low priority)
17. A2 finding-quality oracle (needs hand-labeled corpus); A7 multi-host GUI checklist + gated Codex e2e;
    manual OpenCode permission-propagation validation; gated live e2es (`RUN_NIM_E2E` etc.); provider
    `queryLimits` (revisit if a provider gains a proactive endpoint); **headroom proxy** validate-before-flip;
    narrow-staleness on prose-heavy artifacts (bounded semantic judgment, defer until churn is measured).
    *(backlog → "Deferred / waiting")*

---

## Why this order

- **T1 (self-scaling pipeline) is COMPLETE** — every later lap now pays a complexity-scaled pipeline cost, and
  the T4 host-friction items become cheap lean laps.
- **T2** — convergence-termination ✅ and no-data-loss ✅ shipped; the remaining T2 item (a real friction signal)
  is env-bound (needs a live rate-limited run) and folds into the dispatch-driver track. These are what let the
  loop run *unattended* — the precondition for the scheduled audit→remediate→PR capstone.
- **T3 (auto-phasing)** is the biggest user-facing capability but leans on T1/T2 being solid (it will generate
  many bounded laps).
- **T4** is incremental ergonomics best done *after* T1 makes them cheap; several B/C items are subsumed by
  T1/T3.
- **T5/T6** are product breadth and env-bound work that don't gate the loop.

Each lap: pick the next item, **risk-tier it** (the friction/ergonomic items → lean; T1 slices, T2, T3 →
full pipeline), ship, reinstall, **full friction walk**, update this ordering.
