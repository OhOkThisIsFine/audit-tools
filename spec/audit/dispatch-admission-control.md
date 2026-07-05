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

## What changes

- **Remove the reported concurrency number.** `--host-max-active-subagents` is
  demoted to an explicit operator-only hard cap (one pool's optional in-flight
  cap), never the primary source and never an LLM's answer to "how many?".
- **Add the shared reservation ledger** alongside the learned-quota store
  (`readQuotaState`/`recordWaveOutcome`), same `withFileLock`, keyed by
  `resourceKey`. The dispatch-quota schema already anticipates it
  (`in_flight_tokens`, `remaining_token_budget`).
- **Audit reaches parity with remediate**: use `resolveHostProviderName` for the
  driver identity (remediate already does at `src/remediate/steps/nextStep.ts`;
  audit's `semanticReviewStep.ts` still uses raw `sessionConfig.provider`).
- **`max_concurrent_agents` becomes emergent** — the dispatch prompt drives the
  admission loop, not a precomputed cap.

This is the ClaimRegistry / HybridSpillCoordinator lineage generalized: the
ClaimRegistry already coordinates *task* claiming across agents; this adds *quota*
claiming (token leases) on the same shared-ledger, account-keyed pattern.

## Resolved decisions (owner, 2026-07-04 — these were the Open tensions)

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
3. **Legibility — the dispatch-quota artifact explains every admission.** Each
   admission records `{ pool_id, resourceKey, headroom_before, estimate,
   output_reservation, decision (admit|block), outstanding_leases }` so the
   emergent fan-out width is reconstructable after the fact.
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

## Validation criteria (how we'd know it works)

- A flagless resume by a *different* auditor never sizes against or charges the
  original auditor's quota (the founding bug).
- Two co-located runs on one account never collectively exceed the account budget
  (no 429 storm) under a forced-wall test (`AUDIT_TOOLS_LIVE_QUOTA=1`).
- A wrong (over-large) declared window self-corrects: early actuals / a 429 pull
  admission back down; the run pauses gracefully rather than crashing.
- The dispatch-quota artifact explains every admission well enough that a human
  can reconstruct why the fan-out was the width it was.

## Migration

Atomic-replace ordering (invariant): the new admission loop + reservation ledger
and the deletion of the precomputed `max_concurrent_agents` scalar ship as one
change, not add-then-delete across commits. Tests to update/add:
`tests/audit/quota-scheduler.test.mjs`, `seam-host-only-next-step`,
`dispatch-*`; a new test for "different-auditor resume never inherits the
started-provider's quota", and a co-located double-run overshoot test.

## Relationship to existing machinery

Generalizes: `--host-models` roster pools, A8 `poolsOverride` NIM spill,
`capacity_pools[]`, the ClaimRegistry, HostSessionQuotaSource, and the learned
per-`(provider,model)` quota store — all already account-aware in the `pool_id`.
The rework unifies them under one per-invocation pool-descriptor + admission gate.
