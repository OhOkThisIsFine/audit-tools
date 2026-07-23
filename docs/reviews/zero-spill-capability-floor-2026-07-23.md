# Zero-spill capability-floor fix — mechanism record (2026-07-23)

**Defect (backlog HIGH, live-confirmed re-dogfood run 20260722T005925355Z).** A rolling wave
granted 144 packets, launched exactly 2 (both on the single best pool, claude-worker/glm-5.2);
when that pool 429-stormed into permanent exclusion, ~140 packets stranded as
`rolling_dispatch_stranded_no_fitting_pool` — with five healthy, Gate-0-confirmed sibling pools
(deepseek-v4-pro, minimax-m3, codex, agy, opencode-free) never attempted once.

## Mechanism

`buildCapabilityFloorCapable` (`src/shared/dispatch/admissionLoop.ts`) computed
`bestAvailableBand` **once at closure build** over the full pool list, and the returned
`capable(pool, packet)` used that snapshot forever. The floor's own contract is *relative*:
"`deep` means the most capable band **available**, not band 0 or nothing" — but the snapshot
kept holding the floor at the best pool's band after that pool was permanently excluded
(`state.exhaustedPoolIds`: bare-429, credit-exhausted, model-404). Every surviving lower-band
sibling then failed `capable` in both `selectProvider` (candidate filter) and the
`neverDispatchable` strand predicate (`rollingDispatch.ts` ~1631), which classifies a packet
unfittable when every pool is `exhausted ∨ skip ∨ context-overflow ∨ !capable` — satisfied
vacuously: the best pool by `exhausted`, every sibling by `!capable` against the dead pool's band.

Diagnosis provenance: independent mechanistic traces from agy/gemini-3.6-flash (agentic recon)
and NIM/glm-5.2 (slice recon); the load-bearing claim (build-time static snapshot at
`admissionLoop.ts` `bestAvailableBand`) verified directly against source before any design.

## Fix

The floor's **bands stay static** per build (banding is a property of the confirmed roster);
its **reference point tracks live availability**:

- `buildCapabilityFloorCapable(pools, onFailOpen, isAvailable?)` — `bestAvailableBand` is
  re-derived per evaluation over banded pools with `isAvailable(poolId) !== false`. No callback
  (host admission path, which re-bands per batch) ⇒ behavior unchanged. Every banded pool
  unavailable ⇒ floor inert (fail-open; the availability filters exclude those pools anyway).
- `buildCapacityPoolCapabilityFloor` threads the callback.
- The rolling engine (`rollingDispatch.ts` `createRollingDispatcher`) passes
  `(poolId) => !state.exhaustedPoolIds.has(poolId)` — **exhausted-only on purpose**: merely
  PAUSED pools (`pausedPoolResetAt`) still hold the floor, because pauses reset and exclusions
  don't — the same doctrine the never-dispatchable strand comment states.

## Contract change surfaced by an existing test

`tests/shared/rollingDispatch.test.mjs` "a floor-stranded packet strands (empty_pool) instead of
spinning when its only capable pool exhausts (F4 liveness)" pinned the OLD snapshot semantics
(survivor never attempted). Under the fix the survivor IS attempted first and stranding happens
only when it too exhausts — liveness (strand, never spin) is preserved; the test was updated to
pin the new ordering, not deleted.

## Tests (red-green validated by inversion)

Inverting only the engine wiring (dropping the `isAvailable` argument) turned exactly these red:

- engine: "the capability floor RELAXES to surviving pools when the best-band pool exhausts" —
  incident-shaped: scored band-0 pool 429s, `requiredTier: "deep"` packet must complete on the
  band-1 survivor with no strand terminal.
- engine: the updated F4-liveness test above (survivor attempted before stranding).
- unit (`tests/shared/admission-loop.test.mjs`): static floor blocks the band-1 pool for a deep
  packet; with `isAvailable`, the floor relaxes when the band-0 pool drops out; all-unavailable
  goes inert.

## Accepted residual (pre-existing, logged as backlog LEAD)

A deep packet whose only above-floor pool is **paused with a future reset** (not exhausted)
loops the 50 ms wait tick in-process until the reset: `noPoolCanAcceptNow` is pool-level (a
below-floor sibling "can accept"), and `neverDispatchable` correctly refuses to strand on a
resettable pause. Identical behavior pre-fix — not a regression — but it is an in-process wait
the `quota_paused` retryable-strand path was built to avoid; tracked in `docs/backlog.md`.
