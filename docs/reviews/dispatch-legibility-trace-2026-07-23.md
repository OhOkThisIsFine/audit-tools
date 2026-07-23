# Dispatch-legibility mechanistic trace — mechanism record (2026-07-23)

Closes the backlog item *"Dispatch legibility: a deterministic mechanistic trace for EVERY dispatch
decision"* (owner goal 2026-07-22; subsumed the 2026-07-19 `AdmissionGrant.resource_key` partiality
entry). Spec authority: `spec/audit/dispatch-admission-control.md` → Resolved decision 3.

## Mechanism

**Host path (`src/shared/dispatch/admissionLoop.ts`):**

- New wire type `ConstraintOutcomeRecord` `{resource_key, headroom_before (null = unbounded;
  Infinity normalized), outstanding_before, cost, cleared}` + `toConstraintOutcomeRecords()` — the
  serialized form of the ledger's `ConstraintOutcome`, which `ReservationLedger.admit()` was already
  computing per key and callers were discarding. The whole change is carry-through, not new
  derivation.
- `AdmissionGrant.resource_key` (scalar, one-of-N under multi-constraint) → `resource_keys[]`
  (every key the lease was recorded under). Sole reader (`reconcileAdmissionLeasesFromQuotaFile`)
  uses `lease_id` only — verified before the change.
- `AdmissionExplain` now carries: `constraints[]` (the decisive attempt's full evaluation),
  `binding` (the tightest/refusing key as a FULL outcome row — replaces the one-of-N-looking
  `resource_key`/`headroom_before`/`outstanding_before` scalars, which are deleted), `attempts[]`
  (every pool consulted and refused before the decision, with `cap_reached` cap counts and
  `window_uncalibrated` unpriceable-window labels), and the decisive refusal's extras lifted onto
  the record. The decisive pool's entry is popped off the trail so record and trail never
  duplicate.
- Plan-only path (`grantLeases:false`): every displayed grant emits a `reason:"planned"` explain
  (admitted:true, no lease BY DESIGN — the engine leases per-packet at dispatch). Covers BOTH
  branches: the floor-filtered path and the `pools.length===0` grant-all early return — the latter
  was the live 144-granted-with-empty-explains incident path (caught in design review, deepseek).

**Engine (`src/shared/dispatch/rollingDispatch.ts` + new `dispatchDecisionLog.ts`):**

- ONE emission chokepoint `emitDecision` (per-dispatcher monotonic `seq` + wall-clock `ts`):
  wired sink (`onAdmissionDecision`) or stderr JSON-line fallback — **emission, never silence**;
  a driver that forgets to wire the sink degrades to telemetry, not to nothing.
- `admitAgainstLedger` returns the decision's constraint records + binding + cost; `dispatchPass`
  emits `engine_admitted` (incl. `forced:true` for the liveness backstop, and the no-ledger
  unmetered branch with `lease_id:null`), `engine_blocked` (`budget_exhausted` /
  `window_uncalibrated` with unpriced labels + `any_outstanding`).
- Strand sites emit records REPLACING the old ids-only stderr telemetry (atomic replace):
  `engine_stranded_pool_wall` (per-pool exhausted vs paused-with-reset_at),
  `engine_stranded_no_fitting_pool` (per-(packet, pool) why-not: `pool_exhausted` /
  `oversized_for_pool` / `context_cap` / `below_capability_floor`, first-refusing-condition order),
  `engine_stranded_packet_too_large_all_pools`, `engine_stranded_host_session_escalation`.
- `createDispatchDecisionLog(path)`: append-only JSONL sink (`runs/<runId>/dispatch-explains.jsonl`),
  synchronous single-line appends, warn-ONCE degrade to stderr on I/O failure. Wired by both
  production drivers: audit `driveRollingAuditDispatch` and remediate
  `driveRollingImplementDispatch`.

Records are EVENTS, not state — a packet admitted then later stranded appears twice; `(ts, seq)`
orders the timeline.

## Review history (independent, multi-lane; Codex quota-walled until 2026-07-30)

- **AGY (gemini-3.6-flash, design round):** 8 findings; 5 adopted — the optional-callback silent
  hole (→ engine stderr fallback so no decision can vanish), constraint-array duplication (→
  attempts hold only non-decisive consultations), binding as a full row not a scalar key, warn-once
  sink degrade, ts+seq stamping, shared refusal vocabulary. Declined: "planned admitted:true is a
  false signal" (readers verified: only `reason`/`admitted:false` aggregation exists) and
  per-attempt cost/capability metadata (joinable via `capacity_pools` on pool_id).
- **NIM deepseek (design round):** caught the `pools.length===0` early return as a separate
  still-silent branch — adopted (it is plausibly the live 144-case). Declined its two "simpler
  mechanisms": a per-pool summary block loses per-packet provenance; a zero-cost dry-run admit for
  planned packets would fabricate a decision the engine has not made.
- **AGY (diff round):** 1 real finding adopted — the pool-wall record read `Date.now()` twice, so
  a pause expiring between the check and the record could yield `status:"paused"` with no
  `reset_at` (fixed: one wall-clock reading for check + record). 1 adopted secondary: the
  no-ledger `engine_admitted` cost omitted the output reservation (fixed: same input+envelope
  arithmetic as the metered branch). Declined: stderr-fallback volume (designed
  emission-over-silence; production drivers wire the file sink), transient strand-record
  allocations (once per strand event). Control-flow audit: clean — instrumentation only.
- **NIM deepseek (diff round):** first hypothesis (pop misattribution) self-refuted by its own
  trace; second (cross-packet `attempts` aliasing) FALSE — the array is declared fresh inside the
  per-packet loop and nothing mutates it after an explain is pushed (verified against source).
- **NIM nemotron (engine diff retry after two glm `UND_ERR_HEADERS_TIMEOUT` deaths on a 16KB
  payload — the bimodal-latency lane trap, not size):** 4 categories clean (control flow,
  forced-path record ordering, why-not precedence, emission races); 1 real finding adopted — an
  ASYNC sink's rejection would escape `emitDecision`'s try/catch (sync-only guard) as an unhandled
  rejection; hardened with a `.catch` on any thenable a sink returns.
- **Host subagent (full-diff round): verdict "concerns" — 1 med + 3 low, ALL adopted:**
  - **F1 (med):** unbounded `engine_blocked` re-emission during a blocked-wait stall (50ms tick ×
    per-pass re-admit ≈ 20 records/s/packet for a peer lease's whole TTL). Fixed:
    transition-dedup — one record per distinct `(pool, reason, any_outstanding, forced)` per
    packet, reset when the packet dispatches so a post-requeue re-block records again.
  - **F2 (low):** `seq` documented as authoritative but resets per sub-wave dispatcher within one
    shared JSONL. Fixed: the sink stamps per-file monotonic `file_seq` (the file-authoritative
    order); docs corrected.
  - **F3 (low):** a refused forced-backstop attempt left no trace (reachable via
    `window_uncalibrated` — the backstop unbounds budgets, not slopes), and a throwing WIRED sink
    silenced the record. Fixed: the forced refusal emits `engine_blocked {forced:true}`;
    `emitDecision`'s catch degrades to stderr.
  - **F4 (low):** no behavioral test pinned the `lastDecision` reset (stale ledger outcomes
    bleeding onto a later cap_reached record) or the decisive-extras lift. Fixed: regression test
    added (plus a live-engine dedup/transition/forced-record test).
  - Verified clean with citations: admitBatch bookkeeping (pop cannot lose or double-record),
    schema/emit coherence incl. exactOptionalPropertyTypes, engine control flow unchanged beyond
    emission, zero readers of the deleted fields/event kinds across src/scripts/hooks, old on-disk
    artifacts still load (structural readers only).

## Residuals (accepted, revisit on evidence)

- The engine's stderr fallback on the common unwired host path emits one JSON line per packet —
  comparable cadence to the existing per-result progress line; acceptable, and both production
  drivers wire the file sink.
- `dispatch-explains.jsonl` grows unbounded within a run dir (bounded by run size; run dirs are
  already the retention unit).
- Selection-time transient refusals (a `selectProvider` null on a pass that later succeeds) are
  deliberately NOT recorded — they are waiting, not decisions; the eventual admit/strand is.
