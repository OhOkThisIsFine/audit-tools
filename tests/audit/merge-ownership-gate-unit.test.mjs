/**
 * merge-ownership-gate-unit.test.mjs (D-66/67 slice-1, Part A) — unit coverage
 * for `partitionByOwnership`, the OD3 merge-time ownership gate `mergeAndIngest`
 * runs on the passing/failing terminal sets before ingest/claim-clear, and for
 * `partitionOwnedMissing`, the partial-wave in-flight deferral that runs on the
 * gate's `owned` failures. Both are pure functions over ONE live-claim snapshot
 * (the merge reads it once so the two decisions cannot disagree), so the
 * pure-partition cases pass a plain claim map; the STALENESS cases take the
 * snapshot from a real file-backed `ClaimRegistry` with an injected clock,
 * because the live-vs-stale distinction is the registry's own `staleMs` logic
 * and faking it would pin nothing. The full merge round-trip is covered by
 * merge-ownership-gate.test.mjs.
 */
import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { partitionByOwnership, partitionUnattemptedMissing } = await import(
  "../../src/audit/cli/mergeAndIngestCommand.ts"
);
const { ClaimRegistry } = await import("../../src/shared/quota/claimRegistry.ts");

test("partitionByOwnership: a task with no persisted token fails OPEN (stays owned)", () => {
  const { owned, unowned } = partitionByOwnership(
    [{ task_id: "a" }],
    {}, // no token persisted for "a"
    {},
  );
  expect(owned.map((t) => t.task_id)).toEqual(["a"]);
  expect(unowned).toEqual([]);
});

test("partitionByOwnership: a persisted token matching the LIVE claim stays owned", () => {
  const { owned, unowned } = partitionByOwnership(
    [{ task_id: "a" }],
    { a: "tok-a" },
    { a: { ownerToken: "tok-a", poolId: "run-1", heartbeatAt: Date.now() } },
  );
  expect(owned.map((t) => t.task_id)).toEqual(["a"]);
  expect(unowned).toEqual([]);
});

test("partitionByOwnership: a persisted token whose claim is LIVE under a DIFFERENT token is excluded as unowned", () => {
  const { owned, unowned } = partitionByOwnership(
    [{ task_id: "a" }],
    { a: "tok-a" },
    { a: { ownerToken: "tok-peer", poolId: "peer-run", heartbeatAt: Date.now() } },
  );
  expect(owned).toEqual([]);
  expect(unowned).toEqual([
    { task_id: "a", reason: "claim lease reclaimed by a peer since dispatch" },
  ]);
});

test("partitionByOwnership: a persisted token whose claim is ABSENT (e.g. WE already cleared it after a prior ingest) fails OPEN, not unowned", () => {
  // This is the self-heal scenario: round 1 ingests + clears the claim; round 2
  // re-lists the SAME task_id as pending (stale completion-marker recovery) with
  // its round-1 token still on record in the sidecar. Nobody else holds the
  // claim — it must NOT be mistaken for a peer reclaim.
  const { owned, unowned } = partitionByOwnership(
    [{ task_id: "a" }],
    { a: "tok-a-stale" },
    {},
  );
  expect(owned.map((t) => t.task_id)).toEqual(["a"]);
  expect(unowned).toEqual([]);
});

test("partitionByOwnership: partitions a mixed set — owned (live, matching), tokenless (fail-open), absent (fail-open), and reclaimed (live, different)", () => {
  const claims = {
    owned1: { ownerToken: "tok-owned1", poolId: "run-1", heartbeatAt: Date.now() },
    reclaimed1: { ownerToken: "tok-peer", poolId: "peer-run", heartbeatAt: Date.now() },
    // "absent1" intentionally has no entry.
  };
  const items = [
    { task_id: "owned1" },
    { task_id: "tokenless1" },
    { task_id: "absent1" },
    { task_id: "reclaimed1" },
  ];
  const tokens = { owned1: "tok-owned1", absent1: "tok-absent1-stale", reclaimed1: "tok-reclaimed1" };
  const { owned, unowned } = partitionByOwnership(items, tokens, claims);

  expect(owned.map((t) => t.task_id).sort()).toEqual(["absent1", "owned1", "tokenless1"]);
  expect(unowned).toEqual([
    { task_id: "reclaimed1", reason: "claim lease reclaimed by a peer since dispatch" },
  ]);
});

// ── Partial-wave deferral (`partitionUnattemptedMissing`). ───────────────────
// The classification the exit-code lie turned on. Every planned task carries a
// dispatch result-map entry, but only the ATTEMPTED subset was ever handed to a
// worker (host path: the admission grant; in-process: what the engine drove, so
// stranded packets are absent). A missing result for a packet nobody attempted
// is deferred work, not a failure.

const MISSING = (task_id) => ({
  task_id,
  errors: ["Missing audit result for assigned task."],
  kind: "missing",
});
const INVALID = (task_id) => ({ task_id, errors: ["Invalid JSON: boom"], kind: "invalid" });
const PACKETS = new Map([
  ["a", "pkt-1"],
  ["b", "pkt-2"],
  ["inflight", "pkt-planned"],
  ["badjson", "pkt-run"],
  ["vanished", "pkt-run"],
]);

test("partitionUnattemptedMissing: a MISSING result whose packet was never attempted is deferred, not failed", () => {
  const { failing, deferred } = partitionUnattemptedMissing(
    [MISSING("a")],
    PACKETS,
    new Set(["pkt-2"]), // pkt-1 was planned but not granted/driven
  );
  expect(deferred, "nobody was ever asked to run this packet").toEqual(["a"]);
  expect(failing).toEqual([]);
});

test("partitionUnattemptedMissing: a MISSING result whose packet WAS attempted stays failing", () => {
  const { failing, deferred } = partitionUnattemptedMissing(
    [MISSING("a")],
    PACKETS,
    new Set(["pkt-1"]),
  );
  expect(deferred, "the packet was dispatched and produced nothing — a real failure").toEqual([]);
  expect(failing.map((f) => f.task_id)).toEqual(["a"]);
});

test("partitionUnattemptedMissing: an INVALID result is terminal even when its packet was not attempted", () => {
  // A result ARRIVED and failed validation. Whatever the attempted set says,
  // deferring it would hide a real failure behind "not dispatched".
  const { failing, deferred } = partitionUnattemptedMissing(
    [INVALID("a")],
    PACKETS,
    new Set(),
  );
  expect(deferred).toEqual([]);
  expect(failing.map((f) => f.task_id)).toEqual(["a"]);
});

test("partitionUnattemptedMissing: a NULL attempted set defers nothing (an unrecorded round must not swallow failures)", () => {
  const { failing, deferred } = partitionUnattemptedMissing(
    [MISSING("a"), INVALID("b")],
    PACKETS,
    null,
  );
  expect(deferred).toEqual([]);
  expect(failing.map((f) => f.task_id)).toEqual(["a", "b"]);
});

test("partitionUnattemptedMissing: a task with no result-map packet id stays failing (no packet, no evidence)", () => {
  const { failing, deferred } = partitionUnattemptedMissing(
    [MISSING("orphan")],
    PACKETS, // no "orphan" entry
    new Set(["pkt-1"]),
  );
  expect(deferred).toEqual([]);
  expect(failing.map((f) => f.task_id)).toEqual(["orphan"]);
});

test("partitionUnattemptedMissing: partitions a mixed round — unattempted deferred, arrived-and-invalid failing, attempted-but-empty failing", () => {
  const { failing, deferred } = partitionUnattemptedMissing(
    [MISSING("inflight"), INVALID("badjson"), MISSING("vanished")],
    PACKETS,
    new Set(["pkt-run"]), // "pkt-planned" was never attempted
  );
  expect(deferred).toEqual(["inflight"]);
  expect(failing.map((f) => f.task_id).sort()).toEqual(["badjson", "vanished"]);
});

// ── The attempted record is CUMULATIVE per run (adversarial-review catch). ───
// A run id outlives one prepare/dispatch/merge round: `semanticReviewStep`
// prepares against a PERSISTED activeReviewRun.run_id, so a later next-step
// re-runs prepareDispatchArtifacts under the same id with a NEW grant.
// Last-write-wins would erase round 1's attempts, and a packet round 1
// dispatched-and-failed would read as never-attempted at the next merge —
// deferred instead of failed, with no retry entry and no surfaced failure.

test("recordAttemptedPackets: a later round's grant UNIONS with earlier rounds, so an earlier attempt is never erased", async () => {
  const { recordAttemptedPackets, readAttemptedPackets } = await import(
    "../../src/audit/cli/dispatchAttempted.ts"
  );
  const dir = await mkdtemp(join(tmpdir(), "attempted-union-"));
  try {
    await recordAttemptedPackets(dir, ["pkt-round1"]);
    await recordAttemptedPackets(dir, ["pkt-round2"]); // second prepare, same run id
    const attempted = await readAttemptedPackets(dir);
    expect(
      [...attempted].sort(),
      "round 1's attempt is a fact round 2 cannot undo",
    ).toEqual(["pkt-round1", "pkt-round2"]);

    // And the round-1 packet therefore still classifies as a FAILURE, not deferred.
    const { failing, deferred } = partitionUnattemptedMissing(
      [MISSING("t-round1")],
      new Map([["t-round1", "pkt-round1"]]),
      attempted,
    );
    expect(deferred).toEqual([]);
    expect(failing.map((f) => f.task_id)).toEqual(["t-round1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readAttemptedPackets: a missing or malformed sidecar reads as null (defer nothing), not as an empty attempted set", async () => {
  const { recordAttemptedPackets, readAttemptedPackets } = await import(
    "../../src/audit/cli/dispatchAttempted.ts"
  );
  const dir = await mkdtemp(join(tmpdir(), "attempted-absent-"));
  try {
    expect(await readAttemptedPackets(dir), "no sidecar => no evidence").toBeNull();
    // An empty recorded set is DIFFERENT from an absent one: it means "this round
    // attempted nothing", which legitimately defers everything.
    await recordAttemptedPackets(dir, []);
    expect([...(await readAttemptedPackets(dir))]).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

    const { owned, unowned } = partitionByOwnership(
      [{ task_id: "t1" }],
      { t1: a.ownerToken }, // A's original persisted token
      await registry.listLiveClaims(),
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

    const { owned, unowned } = partitionByOwnership(
      [{ task_id: "t1" }],
      { t1: a.ownerToken },
      await registry.listLiveClaims(),
    );
    expect(owned).toEqual([]);
    expect(unowned).toEqual([
      { task_id: "t1", reason: "claim lease reclaimed by a peer since dispatch" },
    ]);
  } finally {
    await cleanup();
  }
});

test("partitionUnattemptedMissing: claim state is NOT the discriminator — a freshly-claimed but unattempted task still defers, an attempted one still fails", async () => {
  // Guards the wrong discriminator this fix was first written with. Claims are
  // taken at PLAN time for the whole candidate set, so "claim held live under our
  // own token" is true of every planned task for the lease window — including
  // ones no worker ever touched. Keying deferral on it defers genuine failures
  // (a host that dispatched and got nothing back reads as "still in flight").
  const { registry, cleanup } = await tempStalenessRegistry();
  try {
    const a = await registry.claim("attempted", "run-A");
    const b = await registry.claim("unattempted", "run-A");
    expect(a.acquired && b.acquired).toBe(true);
    // Both claims are equally live and equally ours...
    const claims = await registry.listLiveClaims();
    expect(Object.keys(claims).sort()).toEqual(["attempted", "unattempted"]);

    // ...yet only the un-attempted one defers.
    const { failing, deferred } = partitionUnattemptedMissing(
      [MISSING("attempted"), MISSING("unattempted")],
      new Map([["attempted", "pkt-run"], ["unattempted", "pkt-planned"]]),
      new Set(["pkt-run"]),
    );
    expect(deferred).toEqual(["unattempted"]);
    expect(failing.map((f) => f.task_id)).toEqual(["attempted"]);
  } finally {
    await cleanup();
  }
});
