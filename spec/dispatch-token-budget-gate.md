# Dispatch token-budget gate — design of record

Everything-agnostic. Governs concurrency for a **heterogeneous dispatch pool** (any mix of IDEs /
CLIs / API backends), not Claude-specifically. Claude is the highest-priority backend today but never
a special case in the mechanism.

## The rule (Ethan, 2026-06-30)
Concurrency is limited by ONLY two things:
1. **IDE/provider subagent allowance** — a hard ceiling ONLY when a host actually reports one
   (`CapacityPool.hostConcurrencyLimit`). Most IDEs report none → no ceiling from here.
2. **Token budget** — real provider RPM/TPM (per-minute rate) when discovered, PLUS the **window
   budget**: in-flight + next-task estimated tokens must fit the remaining window budget.

Everything else the scheduler currently invents is deleted: the `first_contact` floor (~3/8), the
`fallback` `unknown_*_concurrency` caps, and the `applyQuotaSourceAdjustment` 0.1/0.3 cliffs.

## Provider-neutral substrate
Every quota source already normalizes to `QuotaUsageSnapshot { remaining_pct (0–1), reset_at,
requests_remaining, tokens_remaining, … }`. The gate reads ONLY this shape, so a Claude pool, a Codex
pool, and a NIM pool are handled by identical code — each with its own snapshot and its own learned
window. `computeDispatchCapacity` already partitions pending work across pools and schedules each
independently; the gate slots into `scheduleWave` per pool.

## Multiple windows scale DIFFERENTLY — learn a slope PER WINDOW
A provider exposes several concurrent limit windows, each with its OWN denominator: Claude has a
5-hour `session` window and a 7-day `weekly` window (Codex: primary-5h + secondary-weekly; etc.). The
same N tokens consumes a LARGE percent of the small 5-hour window but a TINY percent of the big 7-day
window — the tokens→percent slope is completely different per window. A single collapsed
`remaining_pct` + single learned slope is therefore WRONG: if the binding window flips between session
and weekly mid-run, one averaged slope mixes two unrelated denominators.

So the snapshot must carry a generic per-window breakdown (`windows[]`, each `{label, remaining_pct,
reset_at}` — provider-agnostic labels like `session`/`weekly`), and the gate learns a slope keyed on
`(pool-key, window-label)`. The single top-level `remaining_pct` stays as the min (binding) window for
other consumers, but the BUDGET gate works per-window.

## Deriving the per-pool remaining token budget
Compute a token budget PER active window, then take the **min across windows** (you're limited by
whichever window runs out first). For each window, in priority order:
1. **Absolute, if the provider gives it** — `tokens_remaining` for that window → use directly.
2. **Learned slope** — most subscription endpoints expose only PERCENT-utilization (see
   [[claude-usage-endpoint-body-shape]]). Learn `tokens_per_pct[window-label]` per pool key from
   observed Δutilization vs tokens-dispatched FOR THAT WINDOW; budget = `remaining_pct × 100 ×
   tokens_per_pct[label]`.
3. **Cold start (no absolute, no learned slope yet for that window)** — calibrate, don't invent a cap:
   dispatch a small bounded first batch, observe the resulting Δutilization per window to seed each
   window's slope, then widen. A measurement bootstrap, per-(pool, window), NOT a fixed ceiling.

`remaining_token_budget = min over active windows of (that window's derived budget)`.

## The gate
Per pool, max concurrent slots K = the largest K such that:

    sum(top-K pending slot-token estimates) + in_flight_tokens(pool)  ≤  remaining_token_budget × safety_margin

then clamp by `hostConcurrencyLimit` if the host reported one, and by real RPM/TPM. `reset_at` bounds
how long a fully-spent pool stays parked before it refills.

## Learning wiring (per pool key, persisted in quota-state)
The rolling engine samples the pool's snapshot around dispatch and attributes token spend:
`slope_sample = Δtokens_dispatched / Δutilization_percent`, folded into a per-key EWMA in
`quota-state.json`. Same learned-limits machinery as the existing RPM/TPM learning; degrade-to-cold
when no history.

## Surface to the orchestrating agent
The dispatch step exposes, per target: `{remaining_pct, reset_at, in_flight_tokens,
remaining_token_budget}`, plus a wave-level `upcoming_tokens` (estimated wave token load, not
per-target) — so the host driver (or a nested Y-dispatcher) sees the real constraints, not an opaque
slot count. Mechanical gate enforces; the driver picks within it.

## Quota-death = retryable pause (data-loss fix)
A detected session/rate-limit worker death is a pause-until-`reset_at` + preserve-worktree (an
early return before `removeWorktree` in `acceptNodeWorktree`) + re-dispatch — never a node failure.
Distinguishes quota-killed from real failure so partial worktrees are not lost.

## Build order (green at every commit)
- **A.** Strip the invented caps (`first_contact`, `fallback`, cliffs). Governed by token budget +
  real RPM/TPM + host allowance only. Independently correct.
- **B.** Learned-slope token-budget gate + cold-start calibration, per pool key.
- **C.** Surface the per-target budget view into the dispatch step contract.
- **D.** Quota-death retryable pause + worktree preservation.

Both orchestrators consume the shared `scheduleWave`/`computeDispatchCapacity`, so the change lands
once in `src/shared/quota` and applies to audit + remediate identically.
</content>
