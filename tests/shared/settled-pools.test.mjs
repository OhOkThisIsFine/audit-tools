/**
 * A-8 DC-4 cross-cycle settled-pool store. A backend pool that spilled-then-exhausted
 * is recorded here so the coordinator excludes it from future splits (its work then
 * falls back to the host pool). Asserts the store round-trips, is idempotent, only
 * grows, and is lock-safe under concurrent adds (no lost update).
 */

import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readSettledPools, addSettledPool } = await import(
  "../../src/shared/dispatch/settledPools.ts"
);

test("settled-pools store: empty by default, round-trips, idempotent, accumulates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "settled-"));
  try {
    const path = join(dir, "settled.json");
    expect([...(await readSettledPools(path))]).toEqual([]);

    await addSettledPool(path, "pool/nim");
    expect([...(await readSettledPools(path))]).toEqual(["pool/nim"]);

    // Idempotent — re-settling an already-settled pool is a no-op.
    await addSettledPool(path, "pool/nim");
    expect([...(await readSettledPools(path))]).toEqual(["pool/nim"]);

    // Accumulates (the set only grows within a run).
    await addSettledPool(path, "pool/codex");
    expect([...(await readSettledPools(path))].sort()).toEqual(["pool/codex", "pool/nim"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settled-pools store: concurrent adds don't lose entries (lock-guarded)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "settled2-"));
  try {
    const path = join(dir, "settled.json");
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((id) => addSettledPool(path, `pool/${id}`)),
    );
    const set = await readSettledPools(path);
    expect(set.size).toBe(5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Unified-routing step D: reason-aware settle predicate ────────────────────
// Settling is permanent for the run (INV-S03), so only genuinely-terminal pool
// conditions qualify. packet_too_large is the load-bearing exclusion: the 2026-07-17
// dogfood settled a healthy 3-pool frontier onto a walled host because sizing faults
// and transients were treated as exhaustion.
test("isPoolSettlingOutcome: terminal exhaustion settles; sizing faults and transients never do", async () => {
  const { isPoolSettlingOutcome } = await import("../../src/shared/dispatch/settledPools.ts");
  // Genuine terminal pool conditions → settle.
  expect(isPoolSettlingOutcome("credit_exhausted")).toBe(true);
  expect(isPoolSettlingOutcome("model_unavailable")).toBe(true);
  expect(isPoolSettlingOutcome("rate_limited")).toBe(true);
  expect(isPoolSettlingOutcome("quota_unclassified")).toBe(true);
  // A 413 is a per-(item,pool) sizing fact — must NEVER kill the pool.
  expect(isPoolSettlingOutcome("packet_too_large")).toBe(false);
  // Transients are retry/cooldown territory, not exhaustion.
  expect(isPoolSettlingOutcome("timeout")).toBe(false);
  expect(isPoolSettlingOutcome("error")).toBe(false);
  expect(isPoolSettlingOutcome("success")).toBe(false);
});
