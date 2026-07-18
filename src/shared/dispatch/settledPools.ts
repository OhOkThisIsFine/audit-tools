import { withFileLock } from "../quota/fileLock.js";
import { readOptionalJsonFile, writeJsonFile } from "../io/json.js";

/**
 * The cross-cycle settled-pool store for A-8 hybrid dispatch (DC-4).
 *
 * A pool that was spilled onto and then EXHAUSTED is recorded here so the
 * {@link HybridSpillCoordinator} excludes it from every future split (its
 * `readSettled` reads this set) — the stranded work then falls back to the other
 * pool class (the conversation host) instead of re-looping on a dead backend each
 * cycle. The set only grows within a run (a spilled-then-exhausted pool is never
 * re-offered as net-new, INV-S03); a fresh run starts empty (the file is per-run /
 * per-artifacts-dir, cleared with the run's artifacts).
 *
 * Single-sourced so audit and remediate persist exhaustion identically — the same
 * primitive both drivers' cutovers read on every cycle and write on backend
 * exhaustion. Every mutation runs inside `withFileLock` so two loops driving the
 * same run can't lose a settle to a read-modify-write race (mirrors the claim
 * registry's cross-process safety).
 */
export async function readSettledPools(path: string): Promise<Set<string>> {
  const raw = await readOptionalJsonFile<string[]>(path);
  return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : []);
}

/**
 * Whether a worker outcome justifies SETTLING its pool for the rest of the run
 * (unified-routing step D) — the reason-aware predicate for the CROSS-CYCLE hybrid
 * partitions (remediate's direct in-process partition; any caller whose in-memory
 * engine state evaporates at the cycle boundary).
 *
 * ⚠ Deliberately BROADER than the rolling engine's own per-pass exhaustion set
 * (`exhaustedPoolIds` = credit_exhausted / model_unavailable / a rate limit with NO
 * parseable reset): the engine holds a reset-bearing 429 in a reversible in-memory
 * pause and never exhausts on `quota_unclassified` — but a cross-cycle hybrid
 * partition has no memory between cycles, so a reset-bearing 429 or a
 * quota-unclassified death would be re-offered and re-die every cycle. Audit's
 * hybrid caller settles from the ENGINE set (its drive result's
 * `exhausted_pool_ids`); this predicate is the cross-cycle analog. The two sets
 * agree on the invariants below; they diverge on reset-bearing 429 /
 * quota_unclassified BY DESIGN (in-memory pause vs no-memory cycles).
 *
 * Settling is the harshest reaction (permanent for the run, INV-S03 monotonic).
 * Qualifying outcomes:
 *   - `credit_exhausted`   — the account is out of credit; no reset timer.
 *   - `model_unavailable`  — the backend does not serve this model (404-class).
 *   - `rate_limited`       — cross-cycle the in-memory reversible pause evaporates,
 *                            so a hybrid cycle records it here; the learned
 *                            cooldown additionally paces the next build.
 *   - `quota_unclassified` — a quota-suspicious death that matched no precise
 *                            pattern; conservative cross-cycle exclusion.
 * NEVER `packet_too_large`: a 413 is a per-(item,pool) sizing fact — one oversized
 * item must not kill the pool for every other item. NEVER plain `timeout`/`error`:
 * those are transient and retry-covered — settling on them is how the 2026-07-17
 * dogfood collapsed a healthy frontier onto a walled host.
 */
export function isPoolSettlingOutcome(outcome: string): boolean {
  return (
    outcome === "credit_exhausted" ||
    outcome === "model_unavailable" ||
    outcome === "rate_limited" ||
    outcome === "quota_unclassified"
  );
}

/** Record a pool id as settled (idempotent), lock-guarded. */
export async function addSettledPool(path: string, poolId: string): Promise<void> {
  await withFileLock(`${path}.lock`, async () => {
    const set = await readSettledPools(path);
    if (set.has(poolId)) return;
    set.add(poolId);
    await writeJsonFile(path, [...set].sort());
  });
}
