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

/** Record a pool id as settled (idempotent), lock-guarded. */
export async function addSettledPool(path: string, poolId: string): Promise<void> {
  await withFileLock(`${path}.lock`, async () => {
    const set = await readSettledPools(path);
    if (set.has(poolId)) return;
    set.add(poolId);
    await writeJsonFile(path, [...set].sort());
  });
}
