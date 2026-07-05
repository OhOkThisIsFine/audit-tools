// Unified in-process rolling driver (driveRolling) — the ONE loop both orchestrators
// drive above createRollingDispatcher. These isolate the driver's own behaviour: the
// read-only degenerate case (audit runs full-parallel), the contrast that an
// empty/unresolved scope serializes (the audit-serial regression read_only guards
// against), and the rebuild-between-levels boundary.

import { describe, it, expect } from "vitest";
import { driveRolling } from "../../src/shared/dispatch/unifiedRolling.ts";

const POOL = {
  id: "stub/*",
  providerName: "claude-code",
  hostModel: null,
  hostConcurrencyLimit: { active_subagents: 16, source: "session_config" },
};
const SESSION = { quota: { enabled: false } };

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
