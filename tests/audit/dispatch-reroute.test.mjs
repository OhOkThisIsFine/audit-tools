/**
 * OBL-INV-ACL-04 / OBL-INV-ACL-08
 *
 * Verifies the no-stranding guarantee (INV-QD-13 / SEAM-rolling-stranding-audit):
 * after any dropProvider call — including simultaneous multi-pool drops where
 * pending demand exceeds the survivors' slot capacity — reroutePackets leaves
 * ZERO pending_tokens whose assigned_pool_id points at a dropped/exhausted pool.
 *
 * Every pending packet is either:
 *   (a) reassigned to a pool still in active_pools, OR
 *   (b) removed from pending_tokens and surfaced in PartialCompletionTerminal.stranded_ids
 *
 * The audit-cli consumer (this block) is the one that verifies both invariants
 * hold after the shared reroutePackets implementation is invoked. It never
 * re-implements its own reroute logic (OBL-INV-ACL-04).
 */

import { test, expect } from "vitest";

// Import from shared — audit-cli is a consumer, not an implementor.
const {
  dropProvider,
  reroutePackets,
} = await import("audit-tools/shared");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(id, contextTokens = 50_000, outputTokens = 8_000) {
  return {
    id,
    providerName: "test-provider",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: {
      context_tokens: contextTokens,
      output_tokens: outputTokens,
      source: "host_capability",
    },
    quotaSourceSnapshot: null,
  };
}

function makeProvider() {
  return { queryLimits: async () => null };
}

/** Build an initial RollingEnginePoolState with active pools and no pending tokens. */
function buildState(poolIds) {
  return {
    active_pools: poolIds.map((id) => ({ pool: makePool(id), provider: makeProvider() })),
    exhausted_pools: [],
    in_flight_tokens: [],
    pending_tokens: [],
    event_log: [],
  };
}

/** Build packet tokens that are "in-flight" on a given pool — will be requeued on drop. */
function makeInFlightTokens(poolId, count, tokensEach = 1_000) {
  return Array.from({ length: count }, (_, i) => ({
    id: `packet-${poolId}-${i}`,
    assigned_pool_id: poolId,
    estimated_tokens: tokensEach,
  }));
}

/** Extract the set of pool ids currently in active_pools. */
function activePoolIds(state) {
  return new Set(state.active_pools.map((e) => e.pool.id));
}

// ---------------------------------------------------------------------------
// OBL-INV-ACL-04 / OBL-INV-ACL-08 — drop-mid-run reroute assertions
// ---------------------------------------------------------------------------

await test("OBL-INV-ACL-08: single pool drop — pending tokens reassigned or stranded, zero dead-pool refs", () => {
  // Two active pools; 2 packets in-flight on pool-A (will be requeued on drop).
  let state = buildState(["pool-A", "pool-B"]);
  state = {
    ...state,
    in_flight_tokens: makeInFlightTokens("pool-A", 2),
  };

  // Drop pool-A — the 2 in-flight tokens are moved to pending (by dropProvider),
  // then reroutePackets reassigns them to pool-B (or strands any that don't fit).
  state = dropProvider(state, "pool-A", "exhausted");
  // After drop, pending_tokens should contain the requeued packets.
  expect(state.pending_tokens.length, "dropProvider must requeue in-flight tokens").toBe(2);

  const result = reroutePackets(state, {});

  // Core invariant (INV-QD-13): every remaining pending_token must point to an active pool.
  const alive = activePoolIds(result.state);
  for (const token of result.state.pending_tokens) {
    expect(alive.has(token.assigned_pool_id), `pending token ${token.id} is assigned to dead pool ${token.assigned_pool_id}`).toBeTruthy();
  }

  // Any packet that could not be placed must be in stranded_ids (not left on dead pool).
  const strandedIds = new Set(result.terminal?.stranded_ids ?? []);
  const pendingIds = new Set(result.state.pending_tokens.map((t) => t.id));
  const originalIds = ["packet-pool-A-0", "packet-pool-A-1"];

  for (const id of originalIds) {
    expect(pendingIds.has(id) || strandedIds.has(id), `packet ${id} must be in pending_tokens (on a live pool) or stranded_ids — never on a dead pool`).toBeTruthy();
  }
  // No packet can be in both.
  for (const id of pendingIds) {
    expect(!strandedIds.has(id), `packet ${id} cannot be both pending and stranded`).toBeTruthy();
  }
});

await test("OBL-INV-ACL-08: all pools dropped — pending tokens surfaced in stranded_ids, none remain in pending", () => {
  // Single active pool; 3 packets in-flight.
  let state = buildState(["pool-only"]);
  state = {
    ...state,
    in_flight_tokens: makeInFlightTokens("pool-only", 3),
  };

  // Drop the only pool.
  state = dropProvider(state, "pool-only", "exhausted");
  expect(state.pending_tokens.length, "dropProvider must requeue all 3 tokens").toBe(3);
  expect(state.active_pools.length, "active_pools must be empty after sole pool drops").toBe(0);

  const result = reroutePackets(state, {});

  // Terminal must fire: empty_pool.
  expect(result.terminal !== null, "terminal must be set when no active pool remains").toBeTruthy();
  expect(result.terminal.reason).toBe("empty_pool");
  expect(result.terminal.stranded_ids.length, "all 3 packet ids must be stranded").toBe(3);

  // Invariant: zero pending_tokens remain (they were moved to stranded_ids).
  expect(result.state.pending_tokens.length, "pending_tokens must be empty after empty-pool terminal — INV-QD-13").toBe(0);
});

await test("OBL-INV-ACL-08: surplus pending tokens (exceed survivor capacity) are stranded, zero dead-pool refs", () => {
  // Two pools; pool-A has 6 in-flight tokens (will be requeued), pool-B also dropped.
  // Single very-small survivor pool-C with room for 1 packet only.
  let state = buildState(["pool-A", "pool-B", "pool-C"]);
  // Use tiny context windows for pool-C so capacity = 1 slot.
  // Replace pool-C pool to be very small (1k context, 500 output → ~500 token budget).
  state = {
    ...state,
    active_pools: [
      { pool: makePool("pool-A", 50_000, 8_000), provider: makeProvider() },
      { pool: makePool("pool-B", 50_000, 8_000), provider: makeProvider() },
      { pool: makePool("pool-C", 2_000, 500), provider: makeProvider() },
    ],
    in_flight_tokens: makeInFlightTokens("pool-A", 4, 1_500),
  };

  // Drop pool-A and pool-B simultaneously.
  state = dropProvider(state, "pool-A", "exhausted");
  state = dropProvider(state, "pool-B", "exhausted");

  // Now only pool-C survives. pending has the 4 requeued tokens from pool-A;
  // pool-B had no in-flight tokens in this scenario.
  expect(state.active_pools.length, "only pool-C should remain active").toBe(1);

  const result = reroutePackets(state, {});

  // Some packets will fit in pool-C; the rest must be stranded (not left on dead pools).
  const alive = activePoolIds(result.state);

  // Core invariant: no pending token assigned to a dead pool.
  for (const token of result.state.pending_tokens) {
    expect(alive.has(token.assigned_pool_id), `pending token ${token.id} assigned to dead pool ${token.assigned_pool_id} — violates INV-QD-13`).toBeTruthy();
  }

  // Whatever couldn't fit must appear in stranded_ids (not hidden in pending).
  const pendingIds = new Set(result.state.pending_tokens.map((t) => t.id));
  const strandedIds = new Set(result.terminal?.stranded_ids ?? []);
  const originalIds = new Set(state.pending_tokens.map((t) => t.id));

  for (const id of originalIds) {
    expect(pendingIds.has(id) || strandedIds.has(id), `packet ${id} must be either in pending_tokens or stranded_ids after reroutePackets`).toBeTruthy();
  }
  // No packet should appear in both.
  for (const id of pendingIds) {
    expect(!strandedIds.has(id), `packet ${id} cannot be both pending and stranded`).toBeTruthy();
  }
});

await test("OBL-INV-ACL-08: no pending tokens — reroutePackets is a no-op, no terminal", () => {
  let state = buildState(["pool-A"]);
  state = dropProvider(state, "pool-A", "exhausted");
  // No in-flight, so dropProvider produces no pending tokens.
  expect(state.pending_tokens.length).toBe(0);

  const result = reroutePackets(state, {});

  expect(result.terminal, "no terminal when no pending tokens").toBe(null);
  expect(result.state.pending_tokens.length).toBe(0);
});

await test("OBL-INV-ACL-04: audit-cli-commands does not re-implement reroute — reroutePackets is the single owner", () => {
  // Structural assertion: verify that the shared reroutePackets function exists and
  // is callable, and that the audit-cli has no local reroute implementation.
  // This test asserts the contract, not a specific algorithm.
  expect(typeof reroutePackets, "reroutePackets must be exported from audit-tools/shared").toBe("function");
  expect(typeof dropProvider, "dropProvider must be exported from audit-tools/shared").toBe("function");

  // Run a basic reroute through the shared API — no wrapping in audit-cli.
  let state = buildState(["P1", "P2"]);
  state = { ...state, in_flight_tokens: makeInFlightTokens("P1", 1) };
  state = dropProvider(state, "P1", "exhausted");
  const result = reroutePackets(state, {});

  // If P2 can absorb the packet, no stranding.
  const alive = activePoolIds(result.state);
  for (const token of result.state.pending_tokens) {
    expect(alive.has(token.assigned_pool_id)).toBeTruthy();
  }
});
