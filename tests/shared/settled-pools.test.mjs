/**
 * A-8 DC-4 cross-cycle settled-pool store. A backend pool that spilled-then-exhausted
 * is recorded here so the coordinator excludes it from future splits (its work then
 * falls back to the host pool). Asserts the store round-trips, is idempotent, only
 * grows, and is lock-safe under concurrent adds (no lost update).
 */

import test from "node:test";
import assert from "node:assert/strict";
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
    assert.deepEqual([...(await readSettledPools(path))], []);

    await addSettledPool(path, "pool/nim");
    assert.deepEqual([...(await readSettledPools(path))], ["pool/nim"]);

    // Idempotent — re-settling an already-settled pool is a no-op.
    await addSettledPool(path, "pool/nim");
    assert.deepEqual([...(await readSettledPools(path))], ["pool/nim"]);

    // Accumulates (the set only grows within a run).
    await addSettledPool(path, "pool/codex");
    assert.deepEqual([...(await readSettledPools(path))].sort(), ["pool/codex", "pool/nim"]);
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
    assert.equal(set.size, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
