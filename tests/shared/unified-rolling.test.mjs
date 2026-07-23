// Unified in-process rolling driver (driveRolling) — the ONE loop both orchestrators
// drive above createRollingDispatcher. These isolate the driver's own behaviour: the
// read-only degenerate case (audit runs full-parallel), the contrast that an
// empty/unresolved scope serializes (the audit-serial regression read_only guards
// against), and the rebuild-between-levels boundary.

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { driveRolling, resolveLedgerBudgets } from "../../src/shared/dispatch/unifiedRolling.ts";
import { ReservationLedger } from "../../src/shared/quota/reservationLedger.ts";
import { setQuotaStateDir } from "../../src/shared/quota/state.ts";

const POOL = {
  id: "stub/*",
  providerName: "claude-code",
  hostModel: null,
  hostConcurrencyLimit: { active_subagents: 16, source: "session_config" },
};
const SESSION = { quota: {} };

/**
 * A dispatchPacket that records peak concurrency. A short yield lets every packet in a
 * sub-wave be admitted before any completes, so the recorded peak reflects the sub-wave's
 * true admitted concurrency.
 */
function makeDispatch(track) {
  return async (packet) => {
    track.inFlight += 1;
    track.peak = Math.max(track.peak, track.inFlight);
    await new Promise((r) => setTimeout(r, 5));
    track.inFlight -= 1;
    track.results += 1;
    return { packet, outcome: "success" };
  };
}

const packetFor = (it) => ({ id: it.id, payload: { id: it.id }, estimatedTokens: 0, complexity: 0.5 });

describe("driveRolling — unified in-process rolling driver", () => {
  it("read-only level collapses into ONE maximal parallel sub-wave (audit degenerate case)", async () => {
    const track = { inFlight: 0, peak: 0, results: 0 };
    // Shuffled ids to prove the collapse is order-independent (block_id tie-break inside).
    const items = [{ id: "a3" }, { id: "a1" }, { id: "a2" }];
    const run = await driveRolling({
      levels: [items],
      confirmedPools: [POOL],
      sessionConfig: SESSION,
      toNode: (it) => ({ block_id: it.id, write_paths: [], read_only: true }),
      toPacket: packetFor,
      dispatchPacket: makeDispatch(track),
    });
    // All 3 read-only nodes ran concurrently in one sub-wave — NOT serialized.
    expect(track.peak).toBe(3);
    expect(run.allResults).toHaveLength(3);
    expect(run.levels).toHaveLength(1);
    expect(run.levels[0].results).toHaveLength(3);
    expect(run.rebuilds).toBe(0);
    expect(run.terminal).toBeUndefined();
  });

  it("REGRESSION GUARD: without read_only, empty/unresolved-scope nodes serialize (peak 1)", async () => {
    // Same nodes, but empty write_paths WITHOUT read_only ⇒ conservative solo gating
    // (unresolved scope). This is the fully-serial behaviour that read_only:true AVOIDS —
    // the exact audit-serial regression a naive unification would silently introduce.
    const track = { inFlight: 0, peak: 0, results: 0 };
    const items = [{ id: "a1" }, { id: "a2" }, { id: "a3" }];
    const run = await driveRolling({
      levels: [items],
      confirmedPools: [POOL],
      sessionConfig: SESSION,
      toNode: (it) => ({ block_id: it.id, write_paths: [] }),
      toPacket: packetFor,
      dispatchPacket: makeDispatch(track),
    });
    expect(track.peak).toBe(1);
    expect(run.allResults).toHaveLength(3);
  });

  it("disjoint-file writers in one level parallelize; same-file writers serialize", async () => {
    const track = { inFlight: 0, peak: 0, results: 0 };
    const items = [{ id: "b1", f: "src/a.ts" }, { id: "b2", f: "src/b.ts" }, { id: "b3", f: "src/a.ts" }];
    const run = await driveRolling({
      levels: [items],
      confirmedPools: [POOL],
      sessionConfig: SESSION,
      toNode: (it) => ({ block_id: it.id, write_paths: [it.f] }),
      toPacket: packetFor,
      dispatchPacket: makeDispatch(track),
    });
    // {b1,b2} disjoint → parallel (peak 2); b3 shares src/a.ts with b1 → next sub-wave.
    expect(track.peak).toBe(2);
    expect(run.allResults).toHaveLength(3);
  });

  it("forwards the reservation ledger: two co-located runs over one ledger never exceed the shared budget", async () => {
    // The C4 wiring: driveRolling forwards reservationLedger + resolvePoolConstraints to the
    // engine, so two co-located in-process loops on ONE account (same ledger file) reserve
    // before dispatch and never collectively over-admit — the spec's central overshoot
    // criterion, exercised through the unified driver rather than the raw engine.
    setQuotaStateDir(await mkdtemp(join(tmpdir(), "unified-rolling-ledger-")));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "unified-ledger-")), "ledger.json");
    const BUDGET = 100;
    const COST = 60; // COST <= BUDGET < 2*COST → at most one in flight across BOTH loops

    const m = { inFlight: 0, peak: 0 };
    const dispatchPacket = async (packet) => {
      m.inFlight += COST;
      m.peak = Math.max(m.peak, m.inFlight);
      await new Promise((r) => setTimeout(r, 15));
      m.inFlight -= COST;
      return { packet, outcome: "success", actualTokens: COST };
    };

    const mkRun = (prefix, ledger) =>
      driveRolling({
        levels: [[{ id: `${prefix}-1` }, { id: `${prefix}-2` }, { id: `${prefix}-3` }]],
        confirmedPools: [POOL],
        sessionConfig: SESSION,
        toNode: (it) => ({ block_id: it.id, write_paths: [], read_only: true }),
        toPacket: (it) => ({ id: it.id, payload: { id: it.id }, estimatedTokens: COST, complexity: 0.5 }),
        dispatchPacket,
        reservationLedger: ledger,
        resolvePoolConstraints: (poolId, tokens) => ({
          constraints: [{ resourceKey: poolId, budget: BUDGET, cost: tokens }],
          unpriced: [],
        }),
      });

    // Two SEPARATE ledger instances → SAME file (two co-located loops coordinating only
    // through the locked file).
    const [a, b] = await Promise.all([
      mkRun("a", new ReservationLedger(ledgerPath)),
      mkRun("b", new ReservationLedger(ledgerPath)),
    ]);
    expect(a.allResults).toHaveLength(3);
    expect(b.allResults).toHaveLength(3);
    // The combined in-flight reservation never breached the shared budget.
    expect(m.peak).toBeLessThanOrEqual(BUDGET);
  });

  it("resolveLedgerBudgets omits the ledger when no pool has a finite budget (claude-code path)", () => {
    // Quota-disabled + no snapshot ⇒ remaining_token_budget is null for every pool ⇒ no
    // absolute ceiling to protect ⇒ the ledger is NOT wired (the reactive 429 floor is the
    // safety), so in-process dispatch stays lock-overhead-free and fully parallel.
    const cfg = resolveLedgerBudgets({ pools: [POOL], sessionConfig: SESSION, pendingItemTokens: [100, 100] });
    expect(cfg.reservationLedger).toBeUndefined();
    // No windows and no scalar ceiling ⇒ one unbounded pool-keyed constraint.
    const resolved = cfg.resolvePoolConstraints("stub/*", 100);
    expect(resolved.unpriced).toEqual([]);
    expect(resolved.constraints).toEqual([
      { resourceKey: "stub/*", budget: Number.POSITIVE_INFINITY, cost: 100 },
    ]);
  });

  it("reactive cost verification: a declared-free pool that charges stays demoted across levels — onCostDrift fires ONCE per drive", async () => {
    // Two levels ⇒ two dispatchers (the sub-wave/level boundary). A per-dispatcher
    // demotion set would reset at the boundary and re-fire onCostDrift for level 2;
    // the drive-level shared set persists the demotion so it fires exactly once.
    setQuotaStateDir(await mkdtemp(join(tmpdir(), "unified-rolling-costdrift-")));
    const freePool = {
      id: "free/*",
      providerName: "claude-code",
      hostModel: null,
      hostConcurrencyLimit: { active_subagents: 16, source: "session_config" },
      declaredCostPerMtok: 0,
    };
    const drifts = [];
    const run = await driveRolling({
      levels: [[{ id: "L1" }], [{ id: "L2" }]],
      confirmedPools: [freePool],
      sessionConfig: SESSION,
      toNode: (it) => ({ block_id: it.id, write_paths: [`src/${it.id}.ts`] }),
      toPacket: packetFor,
      // Declared-free pool reports a positive cost on every completion (lapsed free tier).
      dispatchPacket: async (packet) => ({ packet, outcome: "success", observedCostUsd: 0.02 }),
      onCostDrift: (info) => drifts.push(info),
      rebuildBetweenLevels: async () => {},
    });
    expect(run.allResults).toHaveLength(2);
    expect(drifts, "demotion persists across the level boundary → one emit").toHaveLength(1);
    expect(drifts[0]).toEqual({ poolId: "free/*", observedCostUsd: 0.02, declaredCostPerMtok: 0 });
  });

  it("NEGATIVE TERMINAL MERGE: quota_paused is preferred over empty_pool; stranded ids union; earliest reset kept", { timeout: 20_000 }, async () => {
    // TST-37d441fa / TST-caab6d8f: construct BOTH partial-terminal reasons in one
    // drive — an early retryable session-limit pause (parseable "Resets in …")
    // and a later bare-429 empty_pool — and assert the merged terminal keeps the
    // retryable quota_paused shape with the union of stranded ids.
    setQuotaStateDir(await mkdtemp(join(tmpdir(), "unified-rolling-terminal-")));
    const run = await driveRolling({
      levels: [[{ id: "P1" }], [{ id: "E1" }]],
      confirmedPools: [POOL],
      sessionConfig: SESSION,
      toNode: (it) => ({ block_id: it.id, write_paths: [], read_only: true }),
      toPacket: packetFor,
      dispatchPacket: async (packet) =>
        packet.id === "P1"
          ? {
              packet,
              outcome: "rate_limited",
              // Session-limit sentinel with a parseable duration → the pool is
              // PAUSED until the reset (retryable), not permanently exhausted.
              rateLimit: {
                channel: "error",
                text: "You've hit your session limit · Resets in 2h30m",
              },
            }
          : { packet, outcome: "rate_limited" }, // bare 429 → exhaust → empty_pool
    });
    expect(run.terminal, "a partially-completed run must surface a terminal").toBeTruthy();
    expect(run.terminal.reason, "quota_paused (retryable) must win the merge over empty_pool").toBe(
      "quota_paused",
    );
    expect([...run.terminal.stranded_ids].sort(), "no stranded id may be lost across waves").toEqual([
      "E1",
      "P1",
    ]);
    expect(typeof run.terminal.earliest_reset_at, "the retryable pause must carry its reset").toBe(
      "string",
    );
    expect(Number.isNaN(Date.parse(run.terminal.earliest_reset_at))).toBe(false);
    // No packet ever completed.
    expect(run.allResults).toHaveLength(0);
  });

  // ESCALATED PRODUCTION DEFECT (rolling level advance) — expected-fail until the
  // owning node fixes src/shared/dispatch/unifiedRolling.ts (LOOP-CORE — needs
  // review attestation): the level loop in `driveRolling` never consults the
  // merged partial terminal, so after level 1 strands (quota_paused OR
  // empty_pool) the driver still runs `rebuildBetweenLevels` and DISPATCHES
  // later levels — burning attempts on a known-dead/paused pool and violating
  // the dependency contract (level-2 items depend on level-1 outputs that never
  // landed). Empirically: with a level-1 terminal, the level-2 packet is still
  // dispatched (probe 2026-07-22). `it.fails` flips loudly when the fix lands;
  // remove the marker then.
  it.fails("NEGATIVE TRANSITION: after a level-1 partial terminal, driveRolling must NOT advance to later levels", { timeout: 20_000 }, async () => {
    setQuotaStateDir(await mkdtemp(join(tmpdir(), "unified-rolling-noadvance-")));
    const dispatched = [];
    let rebuilds = 0;
    const run = await driveRolling({
      levels: [[{ id: "L1a" }], [{ id: "L2a" }]],
      confirmedPools: [POOL],
      sessionConfig: SESSION,
      toNode: (it) => ({ block_id: it.id, write_paths: [], read_only: true }),
      toPacket: packetFor,
      dispatchPacket: async (packet) => {
        dispatched.push(packet.id);
        return { packet, outcome: "rate_limited" }; // bare 429 → level-1 empty_pool terminal
      },
      rebuildBetweenLevels: async () => {
        rebuilds += 1;
      },
    });
    expect(run.terminal?.reason).toBe("empty_pool");
    // The negative transition: a stranded level must HALT the drive.
    expect(dispatched, "level-2 packets must not be dispatched after a level-1 terminal").toEqual([
      "L1a",
    ]);
    expect(rebuilds, "no inter-level rebuild after a terminal").toBe(0);
    // The undispatched level-2 item is stranded on the terminal, not dropped.
    expect(run.terminal.stranded_ids).toContain("L2a");
  });

  it("rebuilds once between dependency levels (single-flight)", async () => {
    const track = { inFlight: 0, peak: 0, results: 0 };
    let rebuilds = 0;
    const run = await driveRolling({
      levels: [[{ id: "L1a" }, { id: "L1b" }], [{ id: "L2a" }]],
      confirmedPools: [POOL],
      sessionConfig: SESSION,
      toNode: (it) => ({ block_id: it.id, write_paths: [`src/${it.id}.ts`] }),
      toPacket: packetFor,
      dispatchPacket: makeDispatch(track),
      rebuildBetweenLevels: async () => {
        rebuilds += 1;
      },
    });
    expect(rebuilds).toBe(1); // exactly one inter-level boundary
    expect(run.rebuilds).toBe(1);
    expect(run.levels).toHaveLength(2);
    expect(run.allResults).toHaveLength(3);
  });
});

