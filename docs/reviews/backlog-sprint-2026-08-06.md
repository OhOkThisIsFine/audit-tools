# Backlog sprint — 2026-08-06 (multi-agent fix waves + analyzer layer A/B/D)

One-day sprint over the HANDOFF's immediate-next set: the 2026-08-05 minor-friction cluster, the
2026-08-06 verified defects, and the priority-raised mechanical-analyzer forward track. Run as two
7-agent worktree dispatch waves + a 16-agent adversarial review, with orchestrator patch review
between every stage. This record is the sprint's provenance; the durable outcomes live in code,
tests, the backlog, and memory.

## What shipped (all red-green-tested unless noted)

**Analyzer layer, items A/B/D** (spec/mechanical-analyzer-layer-design.md; item C still open):
- A: `AnalyzerSafetyProfile` on every candidate; `defaultRun` derives from
  `config_execution !== "executable" && !network_egress && version_pinning === "pinned"`
  (contract test). Promoted hadolint/actionlint/type-coverage; jscpd STAYED GATED — the wave-1
  agent promoted it on a claimed argv mitigation that was never implemented; profile records
  `executable`. semgrep pinned `==1.63.0`; `duration_ms` measured into every tool status.
- B: consent surfacing as a FOLD-LEVEL pause on the acquisition executor (mirrors the
  analyzer-install fold; the wave-2 skeleton's dangling PRIORITY row + registry executor were
  deleted): `pendingAnalyzerConsent` single-sources "who is owed the offer" for both the drain
  stop predicate and the fold; the offer step (`analyzer_consent`) is tool-rendered from
  per-candidate `purpose` + safety profile; decisions arrive via
  `incoming/analyzer-consent-decisions.json`, persist to `analyzer_consent` in session config
  (tokens never persist); admission = default ∨ recorded granted ∨ per-run token, token
  overrides declined.
- D: lizard candidate — bounded source-extension walk drives BOTH `detect()` and the `-l`
  filter (ecosystem markers miss Java/Go/C/C++/Kotlin entirely); quoted-CSV-safe parse;
  leads-only severity threshold bands (≥2× threshold → medium).

**Minor-friction cluster (2026-08-05, re-confirmed 2026-08-06)** — all six:
- au-1 handshake re-echo → handshake persists once (`auditor-handshake.json`, write-if-changed);
  every continue-command renders `--auditor @<file>` (the `@path` transport already existed).
- au-2 fallback-prompt stub dump → premise failed: already resolved (lane-file materialization).
- au-3 resumed runs skip the scope echo → the echo now renders into EVERY step prompt from the
  persisted `scope_summary.json` at the `writeCurrentStep` chokepoint (the old echo was a host
  loader instruction keyed to "after the FIRST next-step" — host-remembering).
- au-4 silent long derivation → per-call liveness heartbeat in `advanceAudit` (closure-scoped
  label = the selected obligation; unref'd interval; covers the >2min re-extraction class too).
- au-5 observability rationale → evidence-grounded (unit-kind + path heuristics); the exclude
  branch states "heuristic default", never factual absence.
- au-6 staleness re-log spam → content-dedupe at the single `emitStalenessRecord` writer,
  reset per `advanceAudit` call (dedupe scoped to one call).

**Dispatch/quota:** dq-1 tier-collapse → `computeDynamicRoutingTiers` (percentile partition for
2/3-tier rosters), applied ONLY when no operator `routing_tiers` is configured. dq-2
concurrency-collapse-to-1 → real path found: `contractPipeline` called `scheduleWave` WITHOUT the
persisted host roster; now threads validated (`HostModelRosterEntrySchema.safeParse`) persisted
`host_capabilities` into the schedule.

**Remediate gates:** ws-1/ws-2 write-scope residuals → fixed at COMMIT ASSEMBLY, not the gate
(both dispatch waves shipped the inverted fix — exempting the leaked files from violations):
`commitWorktree` strips new non-source files outside declared write scope (worker scratch — the
unowned-grant path in `adjudicateWriteScope` is for source work) and unstages tool-seeded files
whose content hash still equals the seed (`seedUntrackedDeclaredPaths` now returns per-file
hashes); exclusions are recorded (`excludedFromCommit` on the result + sidecar). cg-1 close-gate
verify replay → root cause: `deferredVerifyCommands` was documented as sidecar-recorded but NEVER
persisted, so nothing tool-side could drain it; now persisted, collected across all runs' sidecars
(dir scan, no run-id reconstruction), deduped + full-suite-subsumed, residual run once at close
(red residual re-blocks to triage like a combined-suite red).

**Worker/runtime:** wr-1 task-file read failure → failed WorkerResult written (supervisor passes
`--result`; a no-path failure emits the result on stdout, never discarded). wr-2 output-ratio
learning → FULLY deleted (fold + EWMA constant + `output_per_input` field + the learned-ratio
read in `resolveOutputReservation`); wiring was unsound — open-bugs:301: real harnesses cannot
supply the input/output split. wr-3 bare-python Store popup → PATH+platform-parameterized walk
refuses the zero-byte WindowsApps stub.

**Hooks:** friction-stop-gate skips an area whose `steps/current-step.json` churned within 2min
(bystander stops no longer blocked by a concurrent live run; real contract tests). hk-1
(relay-liveness 403) and hk-4 (doc-manifest predicate) were STALE entries — both already enforced
at HEAD; hk-4's incident mechanism was most plausibly the registered chained-`add+commit`
gate-miss trap.

## Process record (what the next dispatcher should know)

- Every workflow subagent ran as Haiku despite `model:'fable'` overrides (durable-traps entry).
  Both waves produced plausible-but-inverted fixes on the write-scope items and vacuous tests
  (logic re-declared inside the test; `toBeDefined()` assertions); the orchestrator patch review
  caught them. Verify-before-landing is not optional at this model tier.
- The vitest false-RED fix attempt (w6) put `projects` at the TOP LEVEL of `vitest.config.ts` —
  silently ignored, voiding include/excludes/setupFiles/reporters: 107 hermeticity failures and
  the RPC-timeout error flipped the run to EXIT 0 (false GREEN). Reverted; entry stays open with
  the mechanism.
- 14 leftover workflow worktrees + 180 orphan CP-BLOCK node-worktree dirs poisoned filtered
  vitest runs (durable-traps + open-bugs entries).
- 16-agent adversarial review over the integrated diff: 12 raised, 10 confirmed, all 10 fixed
  in-tree (workerRunCommand stdout fallback; heartbeat label closure; staleness dedupe reset;
  platform-param bug; lizard detect/severity; item-B completion).

## Advisory design drafts (verify mechanisms before implementing)

- **Provider mid-run re-detection (open-bugs, high):** recommended Option B — classify
  provider-unavailable errors, N-consecutive threshold per pool, transition to the existing
  `waiting_for_provider` resumable pause NAMING the dead provider; resume re-runs
  `buildConfirmedPools` (re-detects PATH/env, folds in alternatives; settled-exclusion prevents
  re-offering dead ones). No Gate-0/confirmation resurrection; llm-relay keeps concrete routing.
  Rejected: wave-boundary active re-probe (latency + pool-construction coupling), hybrid (two
  failure paths). Open: threshold value; pause-prompt guidance; exclusion persistence across
  cycles.
  **Mechanism claims verified against source 2026-08-06** (offload lane + dispatcher spot-checks):
  HOLDS — `waiting_for_provider` lifecycle state exists (`src/shared/rolling/pausedState.ts`,
  persisted via `DispatchPausedState` in `src/audit/types/activeDispatch.ts`); `buildConfirmedPools`
  exists and re-runs provider resolution with an `excludedBackends` filter
  (`src/remediate/steps/dispatch/waveScheduling.ts`); construction-time-only auto-selection
  confirmed (`resolveFreshSessionProviderName` snapshots env once, `src/shared/providers/providerFactory.ts`).
  GAPS the implementation must add (design assumed these exist; they do not):
  (1) `classifyFailureChannels` (`src/shared/dispatch/providerLaunchFinalize.ts`) has NO
  provider-death outcome — spawn/PATH failures fall into generic `error`; a distinct classification
  is new work. (2) the pause artifact carries `settled_exclusions` as pool ids and NO provider
  identity — "naming the dead provider" is a new field. (3) no per-pool spawn-failure counter
  exists (only `consecutive_429_count`, `src/shared/quota/types.ts`) — the N-consecutive threshold
  needs its own field. (4) the pool-id → provider-name join for exclusions is undefined.
- **Item C design-check prep:** proceed-with-changes — no retirement collisions found;
  `src/shared/analyzers/` relocation consistent with one-core-two-draws; instance-level verify
  semantics ("this provenance identity no longer fires") is mechanical fact, not a verdict. Open
  questions to settle at `/design-check`: instance-vs-file verify boundary documentation;
  remediate-only runs with no recorded consent (friction vs blocker); snippet-hash computed over
  the analyzer-reported span exactly; relocation code-review for audit-baked assumptions.
