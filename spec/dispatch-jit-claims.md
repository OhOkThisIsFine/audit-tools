# Dispatch claims & JIT quota reservation — conceptual design

> Timeless concept doc (no status; sequencing lives in `docs/HANDOFF.md`, per-item detail in
> `docs/backlog.md` → [[relax-dispatch-source-forcing]]). Companion to
> `spec/unified-dispatch-worker-model.md` (worker kinds, per-auditor capability) and
> `spec/audit/dispatch-admission-control.md` (admission mechanics).

## The problem this dissolves

Dispatch pre-binds work to backends: the planner assigns specific nodes/packets to specific pools
up-front, and the claim a worker holds is pool-bound. Pre-binding makes three false promises at
once: that the pool's quota headroom at plan time still holds at launch time, that the planned
pool is still the best (or any) route for the packet, and that a packet waiting on a saturated
pool shouldn't run on an idle one. Every one of those staleness windows produces a real observed
failure class: phantom walls from stale grants, packets queued behind a saturated pool while
capacity idles elsewhere, and re-plan churn when a pool drops mid-run.

## The cut

Separate three things the pre-binding model conflates:

- **CLAIM — exclusivity, not routing.** A claim on a node/packet is a pool-agnostic lock: it says
  *someone is working on this*, never *on which backend*. The ClaimRegistry owns exclusivity
  (lease, TTL, ownership) and carries no `poolId`.
- **CAPABILITY FEED — live metadata, not assignments.** The dispatch planner's job shrinks to
  feeding the orchestrator a current view per source: quota headroom, rate state (RPM/TPM,
  cooldowns), cost, capability rank, worker kind. It recommends; it never binds.
- **JIT RESERVATION — quota is reserved at the moment of launch.** The orchestrator selects a
  backend for a claimed packet *right before calling the provider*, reserving quota against the
  live ledger then, not at plan time. A reservation is short-lived and releases on completion or
  failure — the existing lease/reconcile machinery, applied at the correct (latest) moment.

Effective route = `claim (who) × live feed (what's open) × selection policy (cost↔throughput λ,
capability floor) at launch time`. Nothing persists a packet→pool binding; a binding that cannot
be represented cannot go stale.

## Invariants

- One pool identity ⇒ one launchable source (`service[#account]/model`); the claim never
  duplicates or overrides that identity.
- The only legitimate holds on a runnable packet are the three from the remove-waves rule:
  a true predecessor unlock, a quota-window refresh, or rate limiting. "Planned onto a busy pool"
  is not a hold.
- Selection is per-packet at launch (per-worker backend routing rides this — the same moment the
  claude-worker lane composes its namespace model string).
- Degradation: with no live feed (blind pools), selection falls back to declared/ambient ordering —
  uncapped-but-loud, never an invented ceiling ([[quota-onetrack-always-on]]).
- Multi-agent: claims stay valid under concurrent admitters; reservation contention resolves at
  the ledger (account-keyed), never by partitioning packets up-front.

## What gates it

- The ClaimRegistry lock-split (claims today embed pool binding) — a state-shape migration.
- Reservation TTLs reuse the existing lease/reconcile paths (grant-site TTL fix, startup sweep
  residuals in `docs/backlog.md`).
- The in-process rolling engine already approximates the endpoint (slot-pull,
  dispatch-to-capacity, refill-on-completion); the host path is the deviation to converge.
