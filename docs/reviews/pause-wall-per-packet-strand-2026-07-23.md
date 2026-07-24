# Per-packet pause wall — mechanism record (2026-07-23)

**Defect (backlog LEAD, surfaced by the zero-spill fix — the last open item of the dogfood-resume
defect tier).** A deep-tier packet whose only above-capability-floor pool was PAUSED with a future
session-limit reset (`pausedPoolResetAt`, piece D — not exhausted) looped the in-process 50ms wait
tick until the reset: `noPoolCanAcceptNow` is pool-level (a healthy below-floor sibling "can
accept", so the pool wall never fires) and the `neverDispatchable` strand deliberately refuses to
strand on a resettable pause. The run then waited in-process for what can be a multi-hour wall —
the exact shape the retryable `quota_paused` terminal was built to avoid.

## Mechanism

Third strand check in `run()`'s no-progress branch (`src/shared/dispatch/rollingDispatch.ts`),
ordered AFTER the pool-level wall and the permanent `neverDispatchable` strand, BEFORE the 50ms
tick:

- **`packetPoolBlockReason(packet, pool, now)`** single-sources the per-(packet, pool) refusal
  disjunction in one fixed order — `pool_exhausted | oversized_for_pool | context_cap |
  below_capability_floor | pool_paused | null` — for the `neverDispatchable` strand (permanent
  reasons only), the new pause wall (any reason), and both decision records' `why` fields, so
  predicate and record cannot drift. `pool_paused` is deliberately LAST: pause only reads as the
  reason when it is the load-bearing blocker. The disjunction is EXHAUSTIVE for a
  `selectProvider` null: the scheduler floors `max_concurrent` at 1 (verified `scheduler.ts:851,
  :893`), so the eligibility filter is the only refusal path — low quota headroom re-orders
  (proactive spill), it never refuses. The stale `selectProvider` doc comment claiming a headroom
  null was corrected in the same change.
- **Pause wall:** when EVERY remaining pending packet has every confirmed pool blocked — the
  permanent-only strand having just come up empty, at least one blocker per packet is a resettable
  pause — emit `engine_stranded_packet_pause_wall` (new `EngineDecisionRecord` kind: per-packet,
  per-pool `why`, `reset_at` on every `pool_paused` row), strand the queue, break.
  `getTerminal()` then returns the RETRYABLE `quota_paused` terminal. A paused pool deliberately
  still HOLDS the capability floor (zero-spill doctrine): the wall pauses the work rather than
  degrading a deep packet onto a below-floor pool.
- **R2 hardening — wall-time reset capture:** `state.wallStrandEarliestResetAtMs` records
  `earliestPausedResetMs(wallNow)` at the instant either WALL (pool-level or per-packet) strands;
  `getTerminal` falls back to it when every pause has expired by the time it runs. Without this, a
  near-instant reset degraded the classification to the non-retryable `empty_pool` (an expired
  reset means "retry now", never "permanent failure"). Stamped ONLY at the two wall sites — the
  host-session-escalation and all-pools-413 strands are intended as the non-retryable path and do
  not stamp.
- Ledger-blocked packets cannot be swallowed by the wall: a packet holding a provider slot has, by
  construction, at least one unblocked pool in the disjunction, so the wall predicate fails and
  the 50ms tick (correct for cross-process lease waits) is preserved.

## Review history (3 independent lanes + agentic recon)

- **Codex (agentic recon, pre-design):** enumerated every `selectProvider` null reason with
  citations; established the exhaustiveness fact above (scheduler floors `max_concurrent` ≥ 1);
  confirmed cost-demotion is ordering-only (never a refusal → never a wall input); identified that
  strand-then-continue paths can outlive their pauses (the general form of R2); confirmed no
  existing test covered the mixed per-packet pause shape.
- **AGY gemini-3.6-flash (design round):** REFUTED the design's R2 claim ("cannot degrade to
  empty_pool") — the pause-expiry race between `run()` and `getTerminal()` — which became the
  wall-time capture mechanism. R1/R3/R4/R5 could-not-refute with structural arguments.
- **AGY gemini-3.6-flash (diff round):** semantic-drift surface refuted (helper preserves order,
  empty-pool-set behavior, record integrity). Two claimed defects checked against source and
  REFUTED by the verifier: the "vacuous truth on empty pendingQueue" state is unreachable (the
  wall sits inside the `pendingQueue.length > 0 && inFlight.size === 0` guard, outside the diff
  hunk's context — a diff-only-review limit); "spurious stamping" falls with it. One REAL
  pre-existing property surfaced: batch terminal classification (one reason for all stranded ids —
  a permanent strand riding a retryable batch re-strands on retry, converging). Pinned as intended
  contract by a new heterogeneous-queue test. Race deadlines raised 5s → 15s on its flake note.
- **Codex (diff round, with runtime probes):** semantic-drift and ledger-blocked surfaces REFUTED
  (helper preserves the exact predicate order; a slot-holding packet mechanically has a null-reason
  pool, so the wall cannot swallow ledger-blocked work). Two REAL findings, both probe-demonstrated
  and both FIXED in-lap: (1) MEDIUM — the sync decision sink ran between the wall predicate and
  `strandPending()`, so a sink reentrantly enqueueing (enqueue is documented safe during `run()`)
  had its dispatchable packet swept into the strand → fixed as a CLASS at both wall sites:
  build-record → stamp → strand → emit → `continue` (a reentrant packet lands in the cleared queue
  and the next pass dispatches it; with no enqueue the loop exits on its condition, identical to
  the old `break`); (2) LOW — `wallStrandEarliestResetAtMs` survived dispatcher reuse, so a later
  permanent strand inherited a stale reset and read retryable → cleared at `run()` start
  (production is one-dispatcher-per-sub-wave; lifecycle hygiene). Both pinned by new
  inversion-validated tests (reentrant-enqueue; reused-dispatcher).
- **NIM (diff round):** deepseek-v4-pro, nemotron-3-ultra-550b, and qwen3.5-397b all died
  `UND_ERR_HEADERS_TIMEOUT` (observations 7-9) — traced to the CALLER's transport (global `fetch`
  on undici's ~5-min default headersTimeout vs a >5-min first byte); the helper was fixed to POST
  via `node:http` with a 30-min ceiling, and the SAME latent defect was found + backlog-logged in
  the in-repo `openai-compatible` provider lane. deepseek-v4-pro then reviewed the current tree
  cleanly. VERDICT: all four analytical surfaces could-not-refute (semantic drift, liveness incl.
  the strand-then-emit-then-continue reorder, the run-start-cleared fallback, exhaustiveness under
  the `max_concurrent ≥ 1` floor). One test note: the heterogeneous-queue test under-asserted its
  named two-record split — STRENGTHENED to pin both decision records
  (`engine_stranded_no_fitting_pool` for the context-capped packet, `engine_stranded_packet_pause_wall`
  for the pause-walled one). Its two open questions were non-issues (empty-strand never reaches the
  fallback — `getTerminal` returns null on `strandedIds.size === 0`; duplicate reentrant packet ids
  are not reachable — ids are unique).

## Tests (red-green validated by inversion)

- **Incident-shaped:** deep packet, band-0 pool pauses with a 2h reset, band-1 sibling below
  floor → run returns promptly, strand is `quota_paused` with `earliest_reset_at`, decision
  record carries `pool_paused`+`reset_at` / `below_capability_floor` rows. Red (hangs → bounded
  15s race fails) with the wall inverted out.
- **Frontier scoping:** dispatchable peer completes first; only the pause-blocked packet strands.
  Red under the same inversion.
- **Heterogeneous batch:** permanent + pause-blocked strands share ONE retryable terminal (pinned
  as intended; AGY surface 3a).
- **Wall-time capture (R2):** after `run()`, the live pause map is cleared to simulate the reset
  passing; `getTerminal` must still classify `quota_paused`. Red with only the `??` fallback
  inverted out (others stayed green — the test reaches exactly the code it names).
- **Reentrant enqueue (codex MEDIUM):** a sink enqueueing from the wall's decision record gets its
  packet dispatched on the healthy pool, never swept into the strand. Red with the packet wall
  inverted back to emit-first + `break`.
- **Reused dispatcher (codex LOW):** run 1 pause-walls; run 2 (pauses gone) strands permanently →
  terminal reason `empty_pool`, not the stale run-1 capture. Red with the `run()`-start clear
  removed.

## Accepted residuals

- (a) `earliest_reset_at` may come from a live pause on a pool irrelevant to the stranded packets
  (earlier reset elsewhere) → the consumer can retry one hop early; the retry re-strands cheaply
  and converges. Same property as the pre-existing pool-level wall.
- (b) Mixed frontier (pause-blocked + genuinely transient ledger-blocked packets): the wall does
  not fire; pause-blocked packets wait in-process while transient peers make progress — the spin
  this lap fixes only existed when the WHOLE frontier was pause-blocked.
- (c) Batch terminal classification is one-reason-for-all (pre-existing; now pinned by test).
- Codex recon LEAD (logged to backlog): `window_uncalibrated` ledger blocks are a fixed-state
  50ms-poll livelock IF an out-of-repo `resolvePoolConstraints` emits unpriced windows
  (`rollingDispatch.ts` forced-retry path); the in-repo producer omits unpriceable windows, so
  not reachable from shipped wiring.
