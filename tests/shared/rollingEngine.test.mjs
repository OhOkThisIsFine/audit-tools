import { test, expect } from "vitest";

const { dropProvider, reroutePackets } = await import("../../src/shared/quota/rollingEngine.ts");

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
  expect(next.active_pools.length).toBe(1);
  expect(next.active_pools[0].pool.id).toBe("pool-B");

  // exhausted_pools contains pool A
  expect(next.exhausted_pools.length).toBe(1);
  expect(next.exhausted_pools[0].pool.id).toBe("pool-A");

  // pending queue includes the 3 formerly in-flight packets from pool A
  expect(next.pending_tokens.length).toBe(3);
  const pendingIds = next.pending_tokens.map((t) => t.id);
  expect(pendingIds.sort()).toEqual(["pkt-1", "pkt-2", "pkt-3"]);

  // in_flight_tokens retains only pool-B's packet
  expect(next.in_flight_tokens.length).toBe(1);
  expect(next.in_flight_tokens[0].assigned_pool_id).toBe("pool-B");

  // event log contains one ProviderPoolEvent with the right shape
  expect(next.event_log.length).toBe(1);
  const evt = next.event_log[0];
  expect(evt.kind).toBe("exhausted");
  expect(evt.provider_id).toBe("pool-A");
  expect(evt.requeued_count).toBe(3);
  expect(evt.in_flight_count).toBe(3);
  expect(evt.timestamp).toBeTruthy();

  // original state is not mutated
  expect(state.active_pools.length).toBe(2);
  expect(state.in_flight_tokens.length).toBe(4);
  expect(state.pending_tokens.length).toBe(0);
  expect(state.event_log.length).toBe(0);
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
  expect(next.event_log.length).toBe(1);
  expect(next.event_log[0].kind).toBe("unavailable");

  // pool moves to exhausted_pools
  expect(next.exhausted_pools.length).toBe(1);
  expect(next.exhausted_pools[0].pool.id).toBe("pool-A");
  expect(next.active_pools.length).toBe(1);
  expect(next.active_pools[0].pool.id).toBe("pool-B");
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

  expect(record, "dropProvider should write a structured JSON observability line").toBeTruthy();
  expect(record.provider_id).toBe("pool-A");
  expect(record.drop_kind).toBe("exhausted");
  expect(record.in_flight_count).toBe(2);
  expect(record.requeued_count).toBe(2);
  expect(record.ts, "record should carry a timestamp").toBeTruthy();
  // The drop itself still behaves correctly alongside the logging.
  expect(next.event_log.length).toBe(1);
});

test("dropProvider on the last active pool produces empty active_pools", () => {
  const poolA = makePool("pool-A");
  const state = makeState({
    active_pools: [poolA],
    in_flight_tokens: [makeToken("pkt-1", "pool-A"), makeToken("pkt-2", "pool-A")],
  });

  const next = dropProvider(state, "pool-A", "exhausted");

  // active_pools is empty — caller responsible for detecting empty-pool
  expect(next.active_pools.length).toBe(0);
  expect(next.exhausted_pools.length).toBe(1);

  // packets requeued
  expect(next.pending_tokens.length).toBe(2);
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
  expect(second.active_pools.length).toBe(first.active_pools.length);
  expect(second.exhausted_pools.length).toBe(first.exhausted_pools.length);
  expect(second.pending_tokens.length).toBe(first.pending_tokens.length);
  // No duplicate event appended
  expect(second.event_log.length).toBe(first.event_log.length);
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
  expect(result.allocation !== null).toBeTruthy();

  // total_slots reflects only pool-B's capacity (≥1, capped by pending count)
  expect(result.allocation.total_slots >= 1).toBeTruthy();
  expect(result.allocation.total_slots <= 6).toBeTruthy();

  // packets originally assigned to pool-A now have pool-B as their pool
  for (const token of result.state.pending_tokens) {
    expect(token.assigned_pool_id).toBe("pool-B");
  }
});

test("reroutePackets strands all pending and emits empty_pool terminal when active_pools is empty (INV-QD-13)", () => {
  const state = makeState({
    active_pools: [],
    pending_tokens: [makeToken("pkt-1", "pool-A"), makeToken("pkt-2", "pool-A")],
  });

  const result = reroutePackets(state, {});
  expect(result.allocation).toBe(null);
  // No surviving pool: every pending packet is stranded (zero left assigned to a
  // dropped pool) and surfaced in an empty_pool terminal.
  expect(result.state.pending_tokens.length).toBe(0);
  expect(result.terminal !== null).toBeTruthy();
  expect(result.terminal.reason).toBe("empty_pool");
  expect(result.terminal.stranded_ids.sort()).toEqual(["pkt-1", "pkt-2"]);
  // Original state is not mutated.
  expect(state.pending_tokens.length).toBe(2);
});

test("reroutePackets returns state unchanged when no pending tokens", () => {
  const poolB = makePool("pool-B");
  const state = makeState({ active_pools: [poolB], pending_tokens: [] });

  const result = reroutePackets(state, {});
  expect(result.allocation).toBe(null);
  expect(result.terminal).toBe(null);
  expect(result.state).toBe(state);
});

// ── INV-QD-13 / SEAM-rolling-stranding: no pending token left on a dead pool ──
// Drop 2 of 3 pools where pending demand exceeds the lone survivor's slot
// capacity. Every pending token must end on an ACTIVE pool or in stranded_ids —
// zero may remain assigned to a dropped/exhausted pool.

test("reroutePackets (INV-QD-13): multi-pool drop with pending > survivor slots strands surplus, zero on dead pools", () => {
  // Three pools, survivor pool-C has a hard ceiling of 2 active subagents.
  const poolA = makePool("pool-A", 2);
  const poolB = makePool("pool-B", 2);
  const poolC = makePool("pool-C", 2);

  // 7 pending packets currently spread across all three pools (incl. the soon-
  // to-be-dropped pool-A and pool-B).
  const pending = [
    makeToken("pkt-1", "pool-A", 5000),
    makeToken("pkt-2", "pool-A", 4000),
    makeToken("pkt-3", "pool-B", 3000),
    makeToken("pkt-4", "pool-B", 2500),
    makeToken("pkt-5", "pool-C", 2000),
    makeToken("pkt-6", "pool-C", 1500),
    makeToken("pkt-7", "pool-A", 1000),
  ];

  let state = makeState({
    active_pools: [poolA, poolB, poolC],
    pending_tokens: pending,
  });

  // Simultaneously drop pool-A and pool-B (e.g. both exhausted in one pass).
  state = dropProvider(state, "pool-A", "exhausted");
  state = dropProvider(state, "pool-B", "exhausted");

  const activeIds = new Set(state.active_pools.map((e) => e.pool.id));
  expect([...activeIds], "only pool-C survives").toEqual(["pool-C"]);

  const result = reroutePackets(state, {});

  // INVARIANT: zero pending tokens point at a dropped/exhausted pool.
  for (const t of result.state.pending_tokens) {
    expect(activeIds.has(t.assigned_pool_id), `pending token ${t.id} is assigned to non-active pool ${t.assigned_pool_id}`).toBeTruthy();
  }

  // Surplus beyond pool-C's 2 slots must be stranded, not silently dropped.
  expect(result.terminal !== null, "surplus must surface a terminal").toBeTruthy();
  expect(result.terminal.reason).toBe("empty_pool");

  // Every original pending packet is accounted for exactly once: either on an
  // active pool or in stranded_ids. Nothing vanishes, nothing duplicated.
  const placedIds = result.state.pending_tokens.map((t) => t.id);
  const strandedIds = result.terminal.stranded_ids;
  const allAccounted = [...placedIds, ...strandedIds].sort();
  expect(allAccounted, "every pending packet must be either placed on an active pool or stranded").toEqual(pending.map((t) => t.id).sort());
  // No id appears in both sets.
  for (const id of placedIds) {
    expect(!strandedIds.includes(id), `${id} must not be both placed and stranded`).toBeTruthy();
  }
  // pool-C can take at most 2 → at least 5 stranded.
  expect(result.state.pending_tokens.length <= 2, "survivor placed at most its slot count").toBeTruthy();
  expect(strandedIds.length >= 5, "surplus beyond survivor slots stranded").toBeTruthy();
});

test("reroutePackets (INV-QD-13): single drop within survivor capacity strands nothing", () => {
  const poolA = makePool("pool-A", 4);
  const poolB = makePool("pool-B", 8);

  const pending = [
    makeToken("pkt-1", "pool-A"),
    makeToken("pkt-2", "pool-A"),
    makeToken("pkt-3", "pool-A"),
  ];
  let state = makeState({ active_pools: [poolA, poolB], pending_tokens: pending });
  state = dropProvider(state, "pool-A", "exhausted");

  const result = reroutePackets(state, {});
  // pool-B (8 slots) absorbs all 3 — nothing stranded.
  expect(result.terminal).toBe(null);
  expect(result.state.pending_tokens.length).toBe(3);
  for (const t of result.state.pending_tokens) {
    expect(t.assigned_pool_id).toBe("pool-B");
  }
});
