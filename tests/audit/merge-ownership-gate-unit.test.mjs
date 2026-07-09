/**
 * merge-ownership-gate-unit.test.mjs (D-66/67 slice-1, Part A) — unit coverage
 * for `partitionByOwnership`, the OD3 merge-time ownership gate `mergeAndIngest`
 * runs on the passing/failing terminal sets before ingest/claim-clear. The
 * pure-partition cases use a fake `{ listLiveClaims }` registry (DI seam); the
 * STALENESS cases use a real file-backed `ClaimRegistry` with an injected clock,
 * because the live-vs-stale distinction is the registry's own `staleMs` logic
 * and faking it would pin nothing. The full merge round-trip is covered by
 * merge-ownership-gate.test.mjs.
 */
import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { partitionByOwnership } = await import("../../src/audit/cli/mergeAndIngestCommand.ts");
const { ClaimRegistry } = await import("../../src/shared/quota/claimRegistry.ts");

function fakeRegistry(liveClaims) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async listLiveClaims() {
      calls += 1;
      return liveClaims;
    },
  };
}

test("partitionByOwnership: a task with no persisted token fails OPEN (stays owned, listLiveClaims never consulted)", async () => {
  const registry = fakeRegistry({});
  const { owned, unowned } = await partitionByOwnership(
    [{ task_id: "a" }],
    {}, // no token persisted for "a"
    registry,
  );
  expect(owned.map((t) => t.task_id)).toEqual(["a"]);
  expect(unowned).toEqual([]);
  expect(registry.calls, "no persisted token anywhere in the batch — skip the listLiveClaims call entirely").toBe(0);
});

test("partitionByOwnership: a persisted token matching the LIVE claim stays owned", async () => {
  const registry = fakeRegistry({ a: { ownerToken: "tok-a", poolId: "run-1", heartbeatAt: Date.now() } });
  const { owned, unowned } = await partitionByOwnership(
    [{ task_id: "a" }],
    { a: "tok-a" },
    registry,
  );
  expect(owned.map((t) => t.task_id)).toEqual(["a"]);
  expect(unowned).toEqual([]);
});

test("partitionByOwnership: a persisted token whose claim is LIVE under a DIFFERENT token is excluded as unowned", async () => {
  const registry = fakeRegistry({ a: { ownerToken: "tok-peer", poolId: "peer-run", heartbeatAt: Date.now() } });
  const { owned, unowned } = await partitionByOwnership(
    [{ task_id: "a" }],
    { a: "tok-a" },
    registry,
  );
  expect(owned).toEqual([]);
  expect(unowned).toEqual([
    { task_id: "a", reason: "claim lease reclaimed by a peer since dispatch" },
  ]);
});

test("partitionByOwnership: a persisted token whose claim is ABSENT (e.g. WE already cleared it after a prior ingest) fails OPEN, not unowned", async () => {
  // This is the self-heal scenario: round 1 ingests + clears the claim; round 2
  // re-lists the SAME task_id as pending (stale completion-marker recovery) with
  // its round-1 token still on record in the sidecar. Nobody else holds the
  // claim — it must NOT be mistaken for a peer reclaim.
  const registry = fakeRegistry({});
  const { owned, unowned } = await partitionByOwnership(
    [{ task_id: "a" }],
    { a: "tok-a-stale" },
    registry,
  );
  expect(owned.map((t) => t.task_id)).toEqual(["a"]);
  expect(unowned).toEqual([]);
});

test("partitionByOwnership: partitions a mixed set — owned (live, matching), tokenless (fail-open), absent (fail-open), and reclaimed (live, different)", async () => {
  const registry = fakeRegistry({
    owned1: { ownerToken: "tok-owned1", poolId: "run-1", heartbeatAt: Date.now() },
    reclaimed1: { ownerToken: "tok-peer", poolId: "peer-run", heartbeatAt: Date.now() },
    // "absent1" intentionally has no entry.
  });
  const items = [
    { task_id: "owned1" },
    { task_id: "tokenless1" },
    { task_id: "absent1" },
    { task_id: "reclaimed1" },
  ];
  const tokens = { owned1: "tok-owned1", absent1: "tok-absent1-stale", reclaimed1: "tok-reclaimed1" };
  const { owned, unowned } = await partitionByOwnership(items, tokens, registry);

  expect(owned.map((t) => t.task_id).sort()).toEqual(["absent1", "owned1", "tokenless1"]);
  expect(unowned).toEqual([
    { task_id: "reclaimed1", reason: "claim lease reclaimed by a peer since dispatch" },
  ]);
});

// ── Staleness — real ClaimRegistry, injected clock (the live-vs-stale rule is
// the registry's own staleMs logic; a fake would pin nothing). ────────────────

const LEASE_MS = 10_000;

async function tempStalenessRegistry() {
  const dir = await mkdtemp(join(tmpdir(), "ownership-stale-"));
  let clock = 1_000;
  const registry = new ClaimRegistry(join(dir, "task-claims.json"), () => clock, LEASE_MS);
  return {
    registry,
    advanceTo: (ms) => {
      clock = ms;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("partitionByOwnership: a STALE different-token claim (crashed peer's ghost, heartbeat older than the lease) fails OPEN, not unowned", async () => {
  const { registry, advanceTo, cleanup } = await tempStalenessRegistry();
  try {
    // The resurrection scenario the gate must NOT fire on: run A claims + crashes
    // past the lease; peer B reclaims (rotating the token) then ALSO crashes past
    // the lease; A resurrects and merges. B's claim is a ghost — nobody live
    // holds the task — so A's valid result must ingest (fail-open).
    const a = await registry.claim("t1", "run-A");
    expect(a.acquired).toBe(true);

    advanceTo(1_000 + LEASE_MS + 1); // A's claim goes stale
    const b = await registry.claim("t1", "run-B"); // B reclaims, token rotates
    expect(b.acquired).toBe(true);

    advanceTo(1_000 + 2 * (LEASE_MS + 1)); // B's claim is now stale too

    const { owned, unowned } = await partitionByOwnership(
      [{ task_id: "t1" }],
      { t1: a.ownerToken }, // A's original persisted token
      registry,
    );
    expect(owned.map((t) => t.task_id), "a stale ghost claim must not gate a valid result").toEqual(["t1"]);
    expect(unowned).toEqual([]);
  } finally {
    await cleanup();
  }
});

test("partitionByOwnership: a LIVE different-token claim (fresh heartbeat within the lease) IS excluded as unowned", async () => {
  const { registry, advanceTo, cleanup } = await tempStalenessRegistry();
  try {
    const a = await registry.claim("t1", "run-A");
    expect(a.acquired).toBe(true);

    advanceTo(1_000 + LEASE_MS + 1); // A's claim goes stale
    const b = await registry.claim("t1", "run-B"); // B reclaims LIVE (fresh heartbeat)
    expect(b.acquired).toBe(true);

    // Still within B's lease window — B genuinely owns the task now.
    advanceTo(1_000 + LEASE_MS + 2);

    const { owned, unowned } = await partitionByOwnership(
      [{ task_id: "t1" }],
      { t1: a.ownerToken },
      registry,
    );
    expect(owned).toEqual([]);
    expect(unowned).toEqual([
      { task_id: "t1", reason: "claim lease reclaimed by a peer since dispatch" },
    ]);
  } finally {
    await cleanup();
  }
});
