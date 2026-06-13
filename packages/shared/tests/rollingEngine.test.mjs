import test from "node:test";
import assert from "node:assert/strict";

const { dropProvider, reroutePackets } = await import("../src/quota/rollingEngine.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(id, slots = 4) {
  return {
    pool: {
      id,
      providerName: "claude-code",
      hostModel: null,
      hostConcurrencyLimit: { active_subagents: slots, source: "cli_flags", description: "test" },
      quotaStateEntry: null,
      discoveredLimits: null,
      quotaSourceSnapshot: null,
    },
    provider: {},
  };
}

function makeToken(id, pool_id, tokens = 1000) {
  return { id, assigned_pool_id: pool_id, estimated_tokens: tokens };
}

function makeState(overrides = {}) {
  return {
    active_pools: [],
    exhausted_pools: [],
    in_flight_tokens: [],
    pending_tokens: [],
    event_log: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// dropProvider tests
// ---------------------------------------------------------------------------

test("dropProvider removes pool and requeues in-flight packets", () => {
  const poolA = makePool("pool-A");
  const poolB = makePool("pool-B");

  const inFlight = [
    makeToken("pkt-1", "pool-A"),
    makeToken("pkt-2", "pool-A"),
    makeToken("pkt-3", "pool-A"),
    makeToken("pkt-4", "pool-B"),
  ];

  const state = makeState({
    active_pools: [poolA, poolB],
    in_flight_tokens: inFlight,
  });

  const next = dropProvider(state, "pool-A", "exhausted");

  // active_pools contains only pool B
  assert.equal(next.active_pools.length, 1);
  assert.equal(next.active_pools[0].pool.id, "pool-B");

  // exhausted_pools contains pool A
  assert.equal(next.exhausted_pools.length, 1);
  assert.equal(next.exhausted_pools[0].pool.id, "pool-A");

  // pending queue includes the 3 formerly in-flight packets from pool A
  assert.equal(next.pending_tokens.length, 3);
  const pendingIds = next.pending_tokens.map((t) => t.id);
  assert.deepEqual(pendingIds.sort(), ["pkt-1", "pkt-2", "pkt-3"]);

  // in_flight_tokens retains only pool-B's packet
  assert.equal(next.in_flight_tokens.length, 1);
  assert.equal(next.in_flight_tokens[0].assigned_pool_id, "pool-B");

  // event log contains one ProviderPoolEvent with the right shape
  assert.equal(next.event_log.length, 1);
  const evt = next.event_log[0];
  assert.equal(evt.kind, "exhausted");
  assert.equal(evt.provider_id, "pool-A");
  assert.equal(evt.requeued_count, 3);
  assert.equal(evt.in_flight_count, 3);
  assert.ok(evt.timestamp);

  // original state is not mutated
  assert.equal(state.active_pools.length, 2);
  assert.equal(state.in_flight_tokens.length, 4);
  assert.equal(state.pending_tokens.length, 0);
  assert.equal(state.event_log.length, 0);
});

test("dropProvider with unavailable kind records correct event", () => {
  const poolA = makePool("pool-A");
  const poolB = makePool("pool-B");

  const state = makeState({
    active_pools: [poolA, poolB],
    in_flight_tokens: [makeToken("pkt-1", "pool-A")],
  });

  const next = dropProvider(state, "pool-A", "unavailable");

  // event records unavailable kind
  assert.equal(next.event_log.length, 1);
  assert.equal(next.event_log[0].kind, "unavailable");

  // pool moves to exhausted_pools
  assert.equal(next.exhausted_pools.length, 1);
  assert.equal(next.exhausted_pools[0].pool.id, "pool-A");
  assert.equal(next.active_pools.length, 1);
  assert.equal(next.active_pools[0].pool.id, "pool-B");
});

test("dropProvider emits a structured stderr observability line (OBS-d81a55ab)", () => {
  const poolA = makePool("pool-A");
  const poolB = makePool("pool-B");
  const state = makeState({
    active_pools: [poolA, poolB],
    in_flight_tokens: [makeToken("pkt-1", "pool-A"), makeToken("pkt-2", "pool-A")],
  });

  const realWrite = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return realWrite(chunk, ...rest);
  };
  let next;
  try {
    next = dropProvider(state, "pool-A", "exhausted");
  } finally {
    process.stderr.write = realWrite;
  }

  // Locate the structured drop record among whatever was written to stderr.
  const record = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((r) => r && r.kind === "rolling_engine_drop_provider");

  assert.ok(record, "dropProvider should write a structured JSON observability line");
  assert.equal(record.provider_id, "pool-A");
  assert.equal(record.drop_kind, "exhausted");
  assert.equal(record.in_flight_count, 2);
  assert.equal(record.requeued_count, 2);
  assert.ok(record.ts, "record should carry a timestamp");
  // The drop itself still behaves correctly alongside the logging.
  assert.equal(next.event_log.length, 1);
});

test("dropProvider on the last active pool produces empty active_pools", () => {
  const poolA = makePool("pool-A");
  const state = makeState({
    active_pools: [poolA],
    in_flight_tokens: [makeToken("pkt-1", "pool-A"), makeToken("pkt-2", "pool-A")],
  });

  const next = dropProvider(state, "pool-A", "exhausted");

  // active_pools is empty — caller responsible for detecting empty-pool
  assert.equal(next.active_pools.length, 0);
  assert.equal(next.exhausted_pools.length, 1);

  // packets requeued
  assert.equal(next.pending_tokens.length, 2);
});

test("dropProvider is idempotent for an already-dropped pool", () => {
  const poolA = makePool("pool-A");
  const poolB = makePool("pool-B");

  const state = makeState({
    active_pools: [poolA, poolB],
    in_flight_tokens: [makeToken("pkt-1", "pool-A")],
  });

  const first = dropProvider(state, "pool-A", "exhausted");
  const second = dropProvider(first, "pool-A", "exhausted");

  // Second call changes nothing: pool-A already not in active_pools
  assert.equal(second.active_pools.length, first.active_pools.length);
  assert.equal(second.exhausted_pools.length, first.exhausted_pools.length);
  assert.equal(second.pending_tokens.length, first.pending_tokens.length);
  // No duplicate event appended
  assert.equal(second.event_log.length, first.event_log.length);
});

// ---------------------------------------------------------------------------
// reroutePackets tests
// ---------------------------------------------------------------------------

test("reroutePackets distributes pending tokens across remaining pools", () => {
  const poolB = makePool("pool-B", 6);

  // Simulate state after dropping pool-A: 5 pending tokens, 1 active pool
  const state = makeState({
    active_pools: [poolB],
    pending_tokens: [
      makeToken("pkt-1", "pool-A"),
      makeToken("pkt-2", "pool-A"),
      makeToken("pkt-3", "pool-A"),
      makeToken("pkt-4", "pool-A"),
      makeToken("pkt-5", "pool-A"),
    ],
  });

  const result = reroutePackets(state, {});

  // allocation is returned (non-null)
  assert.ok(result.allocation !== null);

  // total_slots reflects only pool-B's capacity (≥1, capped by pending count)
  assert.ok(result.allocation.total_slots >= 1);
  assert.ok(result.allocation.total_slots <= 6);

  // packets originally assigned to pool-A now have pool-B as their pool
  for (const token of result.state.pending_tokens) {
    assert.equal(token.assigned_pool_id, "pool-B");
  }
});

test("reroutePackets returns state unchanged when active_pools is empty", () => {
  const state = makeState({
    active_pools: [],
    pending_tokens: [makeToken("pkt-1", "pool-A")],
  });

  const result = reroutePackets(state, {});
  assert.equal(result.allocation, null);
  assert.equal(result.state, state);
});

test("reroutePackets returns state unchanged when no pending tokens", () => {
  const poolB = makePool("pool-B");
  const state = makeState({ active_pools: [poolB], pending_tokens: [] });

  const result = reroutePackets(state, {});
  assert.equal(result.allocation, null);
  assert.equal(result.state, state);
});
