# Dispatch: admission control over a shared quota ledger

This is the design of record for the dispatch/quota model. It describes the
contract for how dispatch admits work against a shared quota ledger.

## Why this exists

The design answers one core defect:

**Capability inherited from the run, not the current driver.** A run started in
Codex (host concurrency 6) was resumed by a different auditor (Claude Code
fanning out subagents). A `next-step` that omitted the capability flags
resolved the dispatch pool from the *stored* `sessionConfig.provider` (codex)
and sized against codex's `provider_default` quota → 2 slots — wrong for both
auditors, and it would have charged the fan-out against codex's quota.

Chasing that defect exposed that **`concurrency` is the wrong primitive.** We
backed into it because it was the number that came out wrong. But it is not a real, fixed
quantity: pools appear and vanish, estimates drift from actuals, and a hard
"max in flight" only exists for the subset of hosts that genuinely have one.
Precomputing `max_concurrent_agents = N` bakes a snapshot of a continuously moving
thing, and it invites an LLM to *guess* the number — anchored to nothing.

## Principles

- **Capability is per-pool, and the active pool set is per-invocation.** Dispatch
  is a *fleet*: this host's subagents, a NIM endpoint, a Codex backend, a second
  IDE's host, a local subprocess — possibly several at once. The unit is a
  self-describing pool, not "the auditor" and certainly not "the audit."
- **Enforce in tooling, for every install.** No correctness property may rest on
  host-side config that does not ship in the package (e.g. a `CLAUDE.md`
  instruction "don't guess the window" — that is on one operator's machine, not
  in `audit-tools`). The tool must hold even when the host reports garbage.
- **The LLM is structurally excluded from the number.** No pool's concurrency or
  budget is ever supplied by an LLM. Concurrency is *derived/emergent*; the host
  contributes at most a verifiable identity and gets *measured*.
- **Tolerate wrong or absent declared facts.** Start optimistically; let measured
  actuals and 429s correct any over-declaration. Never *trust* a declared window.
- **No fabrication from stale config.** The tool never adds a pool that is not
  confirmed present this invocation. `sessionConfig.provider` authority is
  confined to the headless in-process path (where that provider is itself a pool
  doing the work); it is never the dispatch/quota authority for host-driven or
  multi-pool dispatch.

## The model: admission control, concurrency emergent

Dispatch is not fixed-N waves. It is continuous admission control against a live
budget. One task is admitted at a time; how many end up in flight is whatever the
budget allows right now, and it moves as the budget moves.

```
state: a set of LIVE pools, each with:
         - resourceKey: provider # account / model   (the real rate-limited meter)
         - live headroom (tokens / RPM / TPM remaining, as a proxy for the meter)
         - optional hard in-flight cap, IF that pool declares one
loop:  while tasks remain:
         t = next task;  cost(t) = deterministic estimateTokensFromBytes(packet)
         find a live pool p with headroom(p) >= cost(t)  (and under p's cap, if any)
         -> admit t to p; RESERVE cost(t) against p.resourceKey before dispatch
         -> none available? block until an in-flight task completes
on complete:  reconcile the reservation with ACTUAL tokens; update learned quota
on 429/limit: collapse headroom + set backoff on resourceKey
              -> every consumer keyed to it drops out of admission until reset
on crash/timeout: the reservation lease expires -> budget returns automatically
```

A "fixed-limit IDE" is no longer the model — it is *one pool that declares an
in-flight cap* as an optional constraint. Heterogeneity is native: each admitted
task goes to whichever live pool has headroom; pools join/leave between admissions
(cooperative multi-agent). The admission gate is the single broker chokepoint —
every task passes it; it enforces per-pool budget/attribution/backoff mechanically.

This subsumes the old scalar: a "token-budget cap of N fit at once" is just the
instantaneous width of the admission window, not a stored number.

### Pool selection — cost-first, capability-tiebreak

When more than one live pool can admit a task, selection is **cost-first, capability
tiebreak**: candidates are ranked by `costRank` (cheapest capable pool first), and
`capabilityRank` breaks ties. Multi-provider cost routing is native, not a bolt-on —
each task goes to the cheapest pool that is *capable* of it (has budget + fits under
any declared cap), and overflow spills to the next-cheapest. `admissionLoop.ts`
(`computeDispatchAdmission`, single-sourced across both orchestrators) owns this
ordering, so the emergent fan-out favours the cheapest capable capacity first.

The cost-first routing mechanism itself (the `costRank`/`capabilityRank` model,
price banding, and collision handling) is owned by [`spec/cost-first-routing.md`](../cost-first-routing.md);
this section only describes how admission control *consumes* that ordering at dispatch time.

## The shared resource, and how we avoid clobbering it

**The shared resource is the provider's rate-limit meter for your credential** —
Anthropic for Claude, whatever backs Codex, the NIM endpoint — metered against
your account / key / subscription as a windowed budget. It lives on the
*provider* side and is decremented by every request that authenticates as you.

Independent admission loops clobber it when they draw on the *same remote meter*
with private optimistic estimates: two Claude IDEs on one account, a host + its
subagents, a cooperative agent on the same subscription — all one meter. A
self-hosted NIM or a Codex login on a different account is a *different* meter.

"Shared" is therefore defined by **the granularity the provider enforces at** —
the credential/account. That is exactly what `pool_id` already names:
`codex#<account-uuid>/<model>` = `provider # account / model`. Two consumers
share a budget **iff they resolve to the same (provider, account)** — because that
is the meter that returns the 429.

### One shared, lock-guarded reservation ledger, account-keyed

Every admission loop leases against the *same* ledger, keyed by `resourceKey`, not
per-run and not a per-pool copy:

```
admit(task, pool):
  withFileLock(ledger[pool.resourceKey]):
    headroom = shared_budget
             - Σ outstanding_leases(resourceKey)      # EVERYONE's in-flight, not just mine
             - recorded_consumption(resourceKey)
    if headroom >= estimate(task):
        write lease{ id, estimate, expires_at }        # reserve BEFORE dispatch
        admit
    else: block
on complete:      withFileLock -> replace lease with recorded ACTUAL tokens
on 429/limit:     withFileLock -> collapse headroom + backoff on resourceKey
on crash/timeout: lease expires -> budget returns (no stranded reservation)
```

Properties that stop clobbering:

- **Reserve-before-dispatch under the lock** ⇒ concurrent admitters serialize on
  the reservation and each sees the others' outstanding leases; optimistic
  estimates cannot multiply across consumers. Optimism is bounded by *one* budget.
- **Shared backoff** ⇒ a 429 anyone hits collapses headroom for every consumer on
  that account, not just the loop that tripped it.
- **Leases expire** ⇒ a dead IDE/agent does not strand budget (reuses the
  token-checked stale-lock cleanup already in `quota/fileLock`).
- **Reconcile on completion** ⇒ estimate error self-corrects; the ledger tracks
  *measured* actuals, so a wrong up-front estimate cannot compound.

### Proactive vs reactive — an honest boundary

A **local** ledger can only coordinate consumers that see the same ledger file:

- **Co-located** (same machine / shared FS / user-scope quota state): *proactive*
  — reserve against the shared account-keyed ledger before dispatch.
- **Cross-machine, same account**: *reactive* — the local ledger cannot see the
  other machine's in-flight work, so the only true defence is shared-key 429/
  backoff learning on the same `resourceKey` after the wall.

Both key to the same `provider#account/model`. Proactive reservation is a
*refinement* that reduces overshoot among co-located consumers; **reactive backoff
is the primary, always-correct safety mechanism** (see *Open tensions* — this
ordering matters).

## What the tooling enforces (not host memory, not a shipped instruction)

- The broker admission gate is the single chokepoint; every task passes it.
- Quota is attributed per `resourceKey` (real account), always — a Claude fan-out
  can never be charged against Codex's meter, nor a NIM pool against Codex.
- The active pool set is per-invocation; no pool is fabricated from stale
  `sessionConfig`.
- The current driver's descriptor rides the returned continue-command so it
  survives that driver's own steps without the host "remembering"; a *different*
  driver entering through its own loader overrides with its own descriptor. This
  is not "persist to the run" (which froze auditor A onto B) — the descriptor
  rides the conversation that owns it.
- `sessionConfig.provider` is demoted to the headless in-process pool only.
- **ONE fan-out over the eligible pool set; the primary backend is always a source
  pool.** A configured in-process backend (codex/opencode/openai-compatible/agy — plus
  the command-shaped backends under remediate's policy) is folded into the source-pool
  set UNCONDITIONALLY (`primaryInProcessSource` via `collectDispatchableSources` —
  there is no demote flag and no monopoly branch). The attended/headless split is
  pool-set membership, not a predicate pair: attended
  (`host_can_dispatch_subagents:true` — the conversation-first default) means the
  conversation host participates (remediate: as a member pool; audit: as the
  coverage-driven complement reviewer, never a coordinator claimant) and the frontier
  fans across host + backend + NIM concurrently; headless means no attended host in
  the set, so the engine drives the whole frontier — the same fan-out, degenerate
  case. The host-pool identity is decoupled from the folded source: the host keys to
  the conversation host (`resolveHostDispatchProviderName`, single-sourced in shared)
  while the backend's own source pool keys to the backend. Same-agent collision
  (conversation host provider equals the primary backend — one credential/account,
  where two pools would double-book the meter and could collide on one `pool_id`) is
  resolved by the shared cross-class dedup (`dedupHostAndSourcePools`): on a
  provider+account identity collision the SOURCE/engine pool survives when its
  provider is an in-process worker (the engine drives that single account), and the
  HOST pool survives otherwise.

## Where the pieces live

- **There is no reported concurrency number.** The operator override for the
  in-flight subagent cap (the `--auditor` descriptor's `self.max_active_subagents`
  field) is an
  explicit operator-only hard cap (one pool's optional in-flight cap),
  never the primary source and never an LLM's answer to "how many?".
- **The shared reservation ledger** sits alongside the learned-quota store
  (`readQuotaState`/`recordWaveOutcome`), same `withFileLock`, keyed by
  `resourceKey` (the dispatch-quota schema's `in_flight_tokens`,
  `remaining_token_budget`).
- **Audit and remediate are at parity.** Both resolve driver identity through
  the shared `resolveHostProviderName`: remediate calls it directly
  (`src/remediate/steps/nextStep.ts`); audit calls it via the thin
  `resolveHostDispatchProviderName` wrapper (`src/audit/cli/rollingAuditDispatch.ts`),
  which falls back to it once the in-process-dispatch case is ruled out.
- **There is no precomputed `max_concurrent_agents`** — the dispatch prompt drives
  the admission loop; fan-out width is emergent.

This is the ClaimRegistry / HybridSpillCoordinator lineage generalized: the
ClaimRegistry already coordinates *task* claiming across agents; this adds *quota*
claiming (token leases) on the same shared-ledger, account-keyed pattern.

## Admission decisions

The owner resolved the fork: **build the full proactive reservation ledger now**
(not the deferred reactive-only minimal core), because the full ledger is judged
the right endpoint — implementation size is not a cost, only the endpoint is.
Reactive shared-key backoff remains the *always-correct* floor; the proactive
ledger is layered on top of it, never in place of it.

1. **Output tokens — reserve an output envelope, learn the ratio.** A lease
   reserves `cost(t) = input_estimate + output_reservation`, where
   `output_reservation` is the packet's declared output cap when the
   `(resourceKey, lens)` has no learned history, and the learned empirical
   output/input ratio once completions have measured it. On completion the lease
   reconciles against **actual (input+output)** tokens, which updates the learned
   ratio. This makes output — the binding constraint — a first-class part of the
   reservation instead of an ignored axis. Reactive 429/backoff still catches any
   residual under-reservation.
2. **The ledger is a proxy, and that is accepted.** Non-audit-tools clients on the
   same account never touch the ledger, so proactive reservation is optimistic
   relative to true meter state — but reactive shared-key backoff is the floor that
   remains correct regardless. The ledger reduces co-located overshoot; it never
   claims to be the meter. It must not be presented (in artifact or prompt) as a
   hard guarantee.
3. **Legibility — every dispatch decision leaves a deterministic, mechanistic
   trace.** Every admit AND every refusal/strand carries the FULL
   constraint-outcome array it was decided on — which keys were consulted, each
   key's headroom before, the packet's cost against it, and which key refused —
   assembled deterministically from ledger state the tool already holds (no
   judgment, no sampling). A decision path that writes no explain at all is
   itself a defect of this invariant (a live run observed a 144-packet grant
   whose leases/explains arrays were empty — the plan-only display-grant path).
   Concretely: the host-path explain record carries
   `constraints: ConstraintOutcomeRecord[]` (the decisive attempt's full
   evaluation), `binding` (the tightest/refusing key as a full outcome row, never
   a one-of-N scalar), and `attempts` (every pool consulted and refused before
   the decision, with cap counts / unpriceable-window labels); the lease record
   names EVERY key it was recorded under (`resource_keys`). Plan-only display
   grants write a `planned` explain (no lease, by design — the engine decides at
   dispatch). The in-process engine emits every per-packet decision — admit,
   ledger block, strand with per-pool why-not — as a stamped record through one
   chokepoint: wired to the run dir's append-only `dispatch-explains.jsonl`
   (`createDispatchDecisionLog`), or written to stderr when no sink is wired, so
   the fallback is emission, never silence.
4. **Cold-start — probe-then-widen only when unknown.** When the `resourceKey` has
   no learned slope, the first admission window is deliberately narrow (probe: admit
   a small N, then widen as the first completions calibrate the learned
   tokens-per-percent / output-ratio). When a learned slope *does* exist for the
   `resourceKey`, size against it directly — no artificial narrow probe.
5. **Fairness — FIFO on the lock, for now.** Co-located consumers serialize on the
   ledger lock in arrival order; no per-consumer shares until starvation is
   *observed* on a real double-run. Revisit only with evidence.
6. **Not over-built — full ledger is the chosen endpoint.** The owner explicitly
   chose the full proactive reservation ledger over the reactive-only minimal core.
   The reactive floor is still built first and independently correct; the ledger is
   the refinement layered on it, both shipping under one atomic-replace change.

**Framing: concurrency is not a computed quantity.**
There is no "how many agents" number to derive, report, or make emergent — the
count is *entirely* a function of quota/token headroom (admit while the resourceKey's
budget covers the next task's cost). The ONLY place an explicit agent-count exists is
when a *specific environment declares a hard in-flight cap* (e.g. Codex's 6, which may
change) — that is one pool's optional declared constraint, passed through verbatim,
never a value the tool computes. So the host-dispatch path does not report a live
"emergent number" either: the tool ADMITS the set that budget (and any declared cap)
allows and hands the host exactly that granted set; the granted set is the
instantaneous admission width, not a reported concurrency. "Concurrency is not the
thing to think about" — budget is.

## Host-path admission shape

The model above says the tool "hands the host exactly that granted set." That has
more than one faithful implementation; these are pinned so any-strength builder lands
the SAME atomic replace (auditor-agnostic robustness — the build must not depend on the
agent re-deriving the shape). They apply to the host-dispatch prompt path in BOTH
orchestrators (audit `dispatch_review`, remediate rolling session).

- **The plan stays whole; a `granted_packet_ids` list carries the admission.** The
  dispatch plan is NOT re-emitted as a shrinking subset each step. The tool runs ledger
  admission at the dispatch step and writes the admitted ids plus the per-admission
  explain records (`{packet_id, pool_id, admitted, reason, constraints[], binding,
  attempts[], cost}`, Resolved decision 3) onto the dispatch-quota artifact;
  the host dispatches EXACTLY `granted_packet_ids` and nothing else. This keeps the plan
  a stable content-addressed artifact (one home for the packet set), puts the granted
  set and its explain records in one place, and makes the host's rule trivial ("dispatch
  these ids"). Leases are taken at grant; reconciled at result-ingest (merge-and-ingest /
  accept-node); the next `next-step` re-grants from the still-pending remainder until the
  plan is exhausted. The granted set's size is the instantaneous admission width —
  emergent, never a computed/reported number. (Rejected alternative: emitting only the
  granted subset into the plan/prompt each step — it forks the plan artifact across steps
  and loses the stable whole-plan identity.)

- **Admission is orthogonal to the top-K coverage budget — two distinct axes, applied in
  order.** The existing `max_packets` top-K cap (`filterPackets` → `deferred_packet_ids`)
  is a COVERAGE budget: which packets are in scope for the whole run. Ledger admission is
  a QUOTA gate: how many of the in-scope packets are granted THIS step. Top-K filters
  first (bounding the plan); admission then grants a subset of what survives. They never
  fold into each other: a top-K deferral is permanent for the run (out of scope), an
  admission deferral is transient (re-granted next step once a lease frees). Both may be
  present at once; the plan carries the top-K survivors, `granted_packet_ids` carries the
  admitted subset of those.

- **The constraints the ledger admits against come from the pool's live quota
  snapshot, not a new source.** `windowConstraintsFor` (next section) turns the pool's
  window allowances into one ledger constraint per window — `remaining_pct × learned
  tokens_per_pct` per window where the provider reports only percent — using the slope
  `rollingDispatch.ts` already learns (`recordTokensPerPctObservation`) and the
  snapshot the quota source already supplies. Cold start (no learned slope for a window's
  resourceKey) → probe-then-widen
  (Resolved decision 4): a deliberately narrow first grant, widening as the first
  completions calibrate the slope. **On the claude-code host path the slope learns from
  host-reported `token_usage`** when the host stamps it (`recordHostTokenUsageObservation`,
  `src/audit/cli/dispatch/tokenUsageObservation.ts`), and degrades to the declared-cap
  output envelope only (Resolved decision 1) when it doesn't — the ledger prevents
  co-located double-counting but never gates on an absolute token ceiling; the reactive
  429 floor remains the safety. The token-budget path is live only where a provider
  reports usage (NIM/openai-compatible), and its live validation is the env-bound item
  tracked in `docs/backlog.md` (quota-aware dispatch). See
  [[claude-usage-endpoint-body-shape]] / [[cross-provider-quota-matrix]].

## Deriving the per-pool admission constraints (the substrate the ledger admits against)

Admission does not compare a task's cost against one collapsed number. Each active
quota window on a pool becomes its **own ledger constraint**, and a packet is admitted
only when **every** constraint clears simultaneously — all-or-nothing at the ledger.
The derivation is single-sourced in `windowConstraintsFor`
(`src/shared/quota/windowConstraints.ts`), the one seam both admission paths go
through — the host grant (`admissionLoop`) and the in-process rolling engine — and is
consumed identically by audit + remediate. A MIN-collapsed scalar budget is the
rejected model: collapsing loses *which* window binds (illegible refusals) and cannot
meter an account-shared window separately from a per-model one (see
[[claude-usage-endpoint-body-shape]] / [[cross-provider-quota-matrix]]).

- **Provider-neutral snapshot.** Every quota source normalizes to
  `QuotaUsageSnapshot { remaining_pct (0–1), reset_at, requests_remaining,
  tokens_remaining, windows[] }`. Each `windows[]` entry is
  `{ label, scope, remaining_pct, reset_at, tokens_remaining? }` — and `scope` is
  REQUIRED (`'account' | 'model'`, no default): it declares which partition the
  allowance belongs to, decided by the PRODUCER (the quota source / source
  declaration) and only carried downstream, never re-derived at a consumer. The
  derivation reads only this shape, so a Claude pool, a Codex pool, and a NIM pool
  run through identical code.
- **`openai_compatible` converges onto the same source-pool shape.** A legacy
  `openai_compatible` config block carries its own `quota` (the same
  `QuotaModelLimits` shape a `sources[]` entry carries) — it converges onto identical
  constraint derivation rather than falling to a generic default-token floor.
- **Scope decides the ledger key** (`windowResourceKey`). An `account`-scoped window
  meters as `acct:<accountKey>::<label>` — one allowance shared by every model on
  the credential (`accountKey` travels from `CapacityPool.accountKey`, stamped at the
  producer). A `model`-scoped window meters as `pool:<poolId>::<label>` — this model
  alone, so siblings the limit does not cover are never falsely throttled. The
  namespaces are deliberate: without them the two keyspaces collide exactly on the
  unattributable-source fallback (`accountKey === poolId`), and an account window
  sharing a label with a model window would silently meter as one allowance.
- **Per-window budgets in per-window units — never one collapsed slope.** A
  `WindowBudget` carries its remaining allowance in its own unit: absolute `tokens`,
  or `percent` with a learned `tokensPerPct` slope. A provider exposes several
  concurrent windows with different denominators (Claude: 5-hour `session` + 7-day
  `weekly`; Codex: primary-5h + secondary-weekly); the same N tokens is a large
  percent of the small window and a tiny percent of the big one, so slopes are
  learned per `(pool-key, window-label)`. The top-level `remaining_pct` stays the min
  (binding) window for other consumers; admission itself is per-window.
- **A window that cannot price the draw refuses the pool.** A `percent` window with
  no learned slope cannot convert the packet's tokens into its unit. Such windows are
  returned separately (`unpriced`; non-empty means REFUSE) and the caller routes the
  pool through the cold-start clamp instead of admitting against the partial
  constraint set — silently omitting an unpriceable window would meter the packet
  against fewer allowances than actually bind it, which is the fail-open direction.
- **No windows at all** (no live signal, or the cooldown path that skips derivation)
  → one pool-keyed fallback constraint carrying the pool's own scalar budget —
  deliberately never `+Infinity`, so a caller still holding a finite
  `remaining_token_budget` keeps its ceiling instead of silently over-admitting.
- **Cold start — calibrate, don't invent a cap.** No absolute and no learned slope →
  dispatch a small bounded first batch, observe the per-window Δutilization to seed
  each slope, then widen (a measurement bootstrap, per-(pool, window); Resolved
  decision 4).
- **Learning wiring.** The rolling engine samples the pool's snapshot around dispatch and
  attributes spend: `slope_sample = Δtokens_dispatched / Δutilization_percent`, folded
  into a per-key EWMA in `quota-state.json` (the same learned-limits machinery as RPM/TPM
  learning; degrade-to-cold when no history).
- **Quota-death = retryable pause.** A detected session/rate-limit worker death is a
  pause-until-`reset_at` + preserve-worktree + re-dispatch — never a node failure (an
  early return before `removeWorktree` in `acceptNodeWorktree`), distinguishing
  quota-killed from real failure so partial worktrees are not lost.

`hostConcurrencyLimit` (when a host declares one) and real RPM/TPM still clamp the
admitted set; `reset_at` bounds how long a fully-spent pool stays parked before it
refills. On the claude-code host path the slope learns from host-reported `token_usage`
when the host stamps it, and degrades to percent-only (no actual-usage number) otherwise,
so there the operative constraint set is the declared-cap output envelope
and the reactive 429 floor — the ledger prevents co-located double-counting but never
gates on an absolute token ceiling (see *Host-path admission shape*).

## Observable invariants

- A flagless resume by a *different* auditor never sizes against or charges the
  original auditor's quota (the founding bug).
- Two co-located runs on one account never collectively exceed the account budget
  (no 429 storm) when a metered provider + large target actually exercises the wall.
  (`AUDIT_TOOLS_LIVE_QUOTA=1` only enables the live-credential test probe in
  `tests/audit/inv2.test.mjs`; it does not force a production wall.)
- A wrong (over-large) declared window self-corrects: early actuals / a 429 pull
  admission back down; the run pauses gracefully rather than crashing.
- The dispatch-quota artifact explains every admission well enough that a human
  can reconstruct why the fan-out was the width it was.

## Relationship to existing machinery

Generalizes: the `--auditor` descriptor's `self.roster` model pools, A8 `poolsOverride` NIM spill,
`capacity_pools[]`, the ClaimRegistry, HostSessionQuotaSource, and the learned
per-`(provider,model)` quota store — all already account-aware in the `pool_id`.
The rework unifies them under one per-invocation pool-descriptor + admission gate.
