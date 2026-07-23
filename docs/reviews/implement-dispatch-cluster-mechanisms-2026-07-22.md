# Implement-dispatch defect cluster — verified mechanisms (2026-07-22)

Recon record for the four-defect cluster that walled the `high-severity-self-audit-2026-07-22`
dogfood run (see `remediate-dogfood-2026-07-22.md` for the run itself; backlog *Open bugs* →
"CLEAN REPRO LANDED" entry for the triage). Every mechanism below is verified against HEAD
(v0.34.11) source + the paused run's own artifacts, not inferred. Recon fan-out: 3× NIM
(glm-5.2 / deepseek-v4-pro), 1× AGY (gemini-3.6-flash, plan-mode); Codex quota-walled until
2026-07-28. All lane output was source-verified before landing here.

## Run evidence (`.audit-tools/remediation/runs/high-severity-self-audit-2026-07-22/implement/`)

- `dispatch-quota.json`: `resolved_limits.context_tokens: 32000`, `model: null`,
  `source: "discovered_capability"`; ONE capacity pool (`is_conversation_host: true`, context
  32000); `admission.explains[]` = `[{packet_id: CP-BLOCK-CP-NODE-7, admitted: false, reason:
  no_capable_pool, cost: 92700}]`; `granted_packet_ids: []`.
- `rolling-session.json`: frontier `[]`, dispatched `[]` — the engine saw an empty frontier.
- `node-dispositions.json`: CP-NODE-7 `blocked`, reason "worker did not produce a result
  file… never dispatched (no task.json)" — the admission refusal is not mentioned.
- `state.json`: `host_capabilities: null` — even though the re-drive passed the full
  `--host-*` handshake.

## (d) Handshake flags dropped — the C1 fold runs on only one branch

`resolveHostCapabilities` (the C1 explicit-∪-persisted merge + delta persist to
`state.host_capabilities`) runs ONLY inside the implement-dispatch step builder
(`src/remediate/steps/nextStep.ts:1814-1834`). A `next-step` invocation carrying the handshake
flags that lands on ANY other obligation — exactly the re-drive's case, since the state was in
triage — silently drops them; nothing persists. `prepare-implement-dispatch`
(`src/remediate/index.ts:202`) is additionally a flagless parallel channel: it calls
`prepareImplementDispatch({root, artifactsDir}, runId)` with no handshake and no read of
`state.host_capabilities`, so `buildHostPoolPreamble` (`src/shared/quota/hostPool.ts:195`) gets
`hostContextTokens: undefined` → `hostCapabilityLimits = null` → `buildHostModelPools` falls to
`DEFAULT_CONTEXT_TOKENS` (32 000, `src/shared/tokens.ts:18`). `model: null` is `resolveHostModel`
finding no name and no threaded `hostModelId`.

Audit's contrast: the `AuditorDescriptor` is parsed once (`nextStepCommand.ts:93`), resolved
into the effective session config, and RIDDEN on every continue-command — a bare resume
preserves the handshake.

**Fix direction:** hoist the C1 fold+persist to the `decideNextStep` seam (before obligation
selection) so EVERY invocation persists the delta; make `prepareImplementDispatch` read the
persisted `state.host_capabilities` and thread it into `scheduleWave` — closing the flagless
parallel channel at the seam rather than adding flags to it.

## (b) Floor-refused round spins triage — the empty-frontier fold conflates two cases

The honest `no_capable_pool` wall EXISTS (`buildQuotaPausedStep`, nextStep.ts:2415-2437:
"fit mismatch, NOT a quota wall") and `classifyEmptyGrantCause`
(`src/shared/dispatch/hostDispatchWall.ts:42`) already classifies it as structural. But it is
drawn only on the host-parallel path (nextStep.ts:2314) — and the run took the rolling path,
where:

1. admission refused every packet → `rolling.session.frontier` came back EMPTY;
2. the empty-frontier fold (nextStep.ts:2132: "everything eligible may already be
   done/skipped — fold straight to merge") cannot distinguish "all done" from "all refused";
3. `mergeImplementResults` marked the never-dispatched node `blocked` → triage → auto-retry
   re-prepared the same refusal, deterministically.

Additionally the rolling-wall site (nextStep.ts:2118-2128) calls `buildQuotaPausedTerminal`
WITHOUT the `emptyGrantCause` argument the parallel-path site (2332) passes, so even when that
wall fires the pause renders "wait for the reset" for a structural mismatch.

**Fix direction:** before the empty-frontier fold (and on the backend-partition path), read the
freshly-written dispatch-quota admission: zero grant + pending frontier + `no_capable_pool`
classification → the existing honest pause (quota_paused terminal with cause threaded), never
merge. Thread `emptyGrantCause` at 2122.

## (a) Disposition misreport — the refusal sits unread in explains[]

`diagnoseMissingResultCause` (`src/remediate/steps/dispatch/marshal.ts:482-521`) discriminates
never-dispatched vs dispatched-but-silent from `task.json`/`stderr.txt` sidecars only; neither
it nor `mergeImplementResultsIntoState` reads `dispatch-quota.json` — whose `explains[]` the
same function family WRITES (`prepareImplementDispatch`, marshal.ts:437) and even re-reads for
lease reconciliation (`mergeImplementResults`, marshal.ts:529). An admission refusal is
therefore reported as "a rolling-engine plan-vs-drive eligibility inconsistency" when the
engine in fact refused admission deliberately and said so.

**Fix direction:** in `mergeImplementResults`, load the quota file's explains once, build a
`block_id → explain` map, and let the never-dispatched disposition carry the admission reason
("admission refused: no_capable_pool — packet cost 92700 vs capability floor 32000") when one
exists. Defense-in-depth under (b): still needed for partial refusals (some granted, some
refused) which merge normally.

## (c) Oversized node never split — a single-finding block is atomic to the splitter

The contract-pipeline promotion (`promoteImplementationDagToExtractedPlan`,
`src/remediate/steps/contractPipeline.ts:2874+`) maps ONE DAG node → ONE `Finding` → ONE
`RemediationBlock` with `items: [nodeId]`. The split DOES run downstream
(`handlePendingExtractedPlan` → `applyPlanPipeline` → `splitBlocksByContextBudget`,
plan.ts:542) — but it partitions at FINDING granularity: `splitOversizedOverlapGroup`
(plan.ts:199-203) returns any `group.length <= 1` unsplit regardless of size. CP-NODE-7's 13
affected files stat to ~183 KB ≈ 45.8k estimator tokens — well over the ~28k plan-time budget —
and sailed through because the block held a single finding. (The 92.7k dispatch cost adds the
packet's inlined content/prompt overhead on top.)

**Fix direction:** the oversized single-finding case must split by FILE partition, not finding
partition — at promotion (where `targeted_commands`, `phase_ordinal`, deps, and the
traceability map are all in hand) per INV-RSM-SPLIT-01 semantics: `phase_ordinal` carried
unchanged, `targeted_commands` partitioned by relevance (no silent drop), downstream
`dependencies` remapped to all sub-blocks (the `splitRemap` pattern, plan.ts:297-308).
Plan-time budget should account for the persisted host capability (after (d)) rather than
always the 28k floor, to avoid over-fragmentation when a 200k window exists.

## Anti-cascade retry (backlog spec) — insertion points

AGY trace (source-verified): non-dispatch reason should be recorded at the dispatch boundary
(`prepareImplementDispatch` / the rolling drive); transient-vs-structural classification per
the backlog SPEC (`no_capable_pool` = structural via `classifyEmptyGrantCause`; capacity/cap =
transient); bounded counter as a new `RemediationItemState` field alongside the existing
`rework_count`/`infra_rework_count`; empty-scope guard in the candidate filter at
`prepareImplementDispatch` so a scope-less node can never enqueue. With (b) pausing wholly
structural rounds, the retry piece covers the mixed case.

## Order of work

(d) seam hoist → (b) honest wall on the rolling/backend path → (a) disposition carries the
refusal → (c) promotion-time file-partition split → anti-cascade retry. (d)+(b)+(a) ship
together (they share the seam and jointly un-wall the paused run); then (c); then the retry.
All loop-core (`nextStep.ts`, `dispatch/`, shared quota) → red-green regression tests +
independent review + attestation per commit.
