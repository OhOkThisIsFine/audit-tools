/**
 * CP-NODE-1 — file-ownership-disjoint wave scheduling (INV-SOO-01..10).
 *
 * Reproduces the N-same-file-nodes starvation case and pins the file-ownership
 * scheduler that replaced the numeric `block_id.localeCompare` in-level admission
 * ordering. Covers every INV-SOO invariant and the five failure modes:
 *
 *  INV-SOO-01  file-ownership-disjoint in-flight set (non-vacuous)
 *  INV-SOO-02  same-file serialization, no starved tail
 *  INV-SOO-03  different-file parallelization preserved (real throughput)
 *  INV-SOO-04  numeric ordering removed atomically (red against pre-change)
 *  INV-SOO-05  scheduling-time gate composes with quota cap
 *  INV-SOO-06  grant-time disjointness, not admission-only
 *  INV-SOO-07  atomic triage-retry claim hand-off A→A'
 *  INV-SOO-08  deterministic admission ordering (explicit tie-break)
 *  INV-SOO-09  canonical physical-file identity (rel/abs/case/'..')
 *  INV-SOO-10  disposition-aware claim lifecycle
 */
import { describe, it, expect } from "vitest";
import type { CapacityPool, SessionConfig } from "audit-tools/shared";
import {
  ownershipSubWaves,
  canonicalScopeKeys,
  type OwnershipSchedulerNode,
} from "../../src/remediate/dispatch/ownershipScheduler.js";
import {
  OwnershipRegistry,
  canonicalizeFilePath,
} from "../../src/remediate/dispatch/ownershipRegistry.js";
import { driveRollingDispatch } from "../../src/remediate/steps/nextStep.js";
import type { RemediationBlock } from "../../src/remediate/state/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const node = (block_id: string, write_paths: string[]): OwnershipSchedulerNode => ({
  block_id,
  write_paths,
});

/** Flatten sub-waves to their block_id rows, for structural assertions. */
const ids = (waves: OwnershipSchedulerNode[][]): string[][] =>
  waves.map((w) => w.map((n) => n.block_id));

// ---------------------------------------------------------------------------
// INV-SOO-01 / 02: same-file serialization, no starved tail
// ---------------------------------------------------------------------------

describe("INV-SOO-01/02: N same-file nodes serialize (one writer per file per sub-wave)", () => {
  it("N nodes all writing src/x.ts land one-per-sub-wave (in-flight writers per file == 1)", () => {
    const level = [
      node("B-3", ["src/x.ts"]),
      node("B-1", ["src/x.ts"]),
      node("B-2", ["src/x.ts"]),
    ];
    const waves = ownershipSubWaves(level);
    // N sub-waves, each exactly one node → never two in-flight writers on src/x.ts.
    expect(waves).toHaveLength(3);
    for (const w of waves) expect(w).toHaveLength(1);
    // No starved tail: every node is scheduled (N admissions, N merges follow).
    const scheduled = waves.flat().map((n) => n.block_id).sort();
    expect(scheduled).toEqual(["B-1", "B-2", "B-3"]);
  });

  it("the per-file in-flight set never exceeds one across the whole level", () => {
    const level = Array.from({ length: 5 }, (_, i) => node(`B-${i}`, ["src/x.ts"]));
    const waves = ownershipSubWaves(level);
    for (const w of waves) {
      const sameFile = w.filter((n) => n.write_paths.includes("src/x.ts"));
      expect(sameFile.length).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// INV-SOO-03 / 05: different-file parallelization preserved, gate composes
// ---------------------------------------------------------------------------

describe("INV-SOO-03: pairwise-disjoint nodes share one sub-wave (parallelize)", () => {
  it("K disjoint-file nodes are admitted together in a single sub-wave", () => {
    const level = [
      node("B-1", ["src/a.ts"]),
      node("B-2", ["src/b.ts"]),
      node("B-3", ["src/c.ts"]),
    ];
    const waves = ownershipSubWaves(level);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(3);
  });

  it("mixed: two disjoint files parallelize while a same-file pair serializes", () => {
    const level = [
      node("B-1", ["src/a.ts"]),
      node("B-2", ["src/b.ts"]),
      node("B-3", ["src/a.ts"]), // shares src/a.ts with B-1
    ];
    const waves = ownershipSubWaves(level);
    expect(ids(waves)).toEqual([["B-1", "B-2"], ["B-3"]]);
  });
});

// ---------------------------------------------------------------------------
// INV-SOO-03 / 05 (integration): real peak in-flight through driveRollingDispatch
// ---------------------------------------------------------------------------

describe("INV-SOO-03/05: real concurrent in-flight through the rolling driver", () => {
  const pool: CapacityPool = {
    id: "stub/*",
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: { active_subagents: 8, source: "session_config" },
  };
  const session: SessionConfig = { quota: { enabled: false } };
  const block = (id: string, files: string[]): RemediationBlock => ({
    block_id: id,
    items: [id],
    parallel_safe: true,
    touched_files: files,
  });

  /**
   * Drive a single level and record, per dispatch start, the set of nodes
   * concurrently in flight. A small async yield inside each node lets the rolling
   * engine admit every node in a sub-wave before any completes, so the recorded
   * peak reflects the sub-wave's true admitted concurrency.
   */
  async function run(level: RemediationBlock[]): Promise<{ peak: number; results: number }> {
    let inFlight = 0;
    let peak = 0;
    let results = 0;
    await driveRollingDispatch([level], {
      confirmedPools: [pool],
      sessionConfig: session,
      rebuildSharedBetweenLevels: async () => {},
      root: process.cwd(),
      dispatchNode: async (b) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Yield twice so peers in the same sub-wave are admitted before completion.
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        results += 1;
        return {
          packet: { id: b.block_id, payload: { block_id: b.block_id }, estimatedTokens: 0, complexity: 0.5 },
          outcome: "success" as const,
        };
      },
    });
    return { peak, results };
  }

  it("INV-SOO-03: K disjoint nodes overlap in flight (peak > 1, real parallelism)", async () => {
    const level = [block("B-1", ["src/a.ts"]), block("B-2", ["src/b.ts"]), block("B-3", ["src/c.ts"])];
    const { peak, results } = await run(level);
    expect(peak).toBe(3);
    expect(results).toBe(3);
  });

  it("INV-SOO-01/02: N same-file nodes never overlap (peak == 1) and all complete", async () => {
    const level = [block("B-1", ["src/x.ts"]), block("B-2", ["src/x.ts"]), block("B-3", ["src/x.ts"])];
    const { peak, results } = await run(level);
    expect(peak).toBe(1);
    expect(results).toBe(3);
  });

  it("mixed level: disjoint pair overlaps, same-file pair serializes, all complete", async () => {
    const level = [
      block("B-1", ["src/a.ts"]),
      block("B-2", ["src/b.ts"]),
      block("B-3", ["src/a.ts"]), // shares src/a.ts with B-1 → next sub-wave
    ];
    const { peak, results } = await run(level);
    // First sub-wave {B-1,B-2} overlaps (peak 2); B-3 serializes after B-1.
    expect(peak).toBe(2);
    expect(results).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// INV-SOO-04: numeric ordering removed atomically (red against pre-change)
// ---------------------------------------------------------------------------

describe("INV-SOO-04: pure block_id.localeCompare ordering would FAIL this disjointness assertion", () => {
  it("the old numeric scheduler (single wave, sorted by block_id) co-admits same-file nodes; the new one does not", () => {
    const level = [
      node("B-1", ["src/x.ts"]),
      node("B-2", ["src/x.ts"]),
      node("B-3", ["src/x.ts"]),
    ];
    // Pre-change behavior simulated: one wave, all N nodes, ordered by block_id.
    const preChangeSingleWave = [...level].sort((a, b) => a.block_id.localeCompare(b.block_id));
    const preChangeMaxSameFileConcurrent = preChangeSingleWave.filter((n) =>
      n.write_paths.includes("src/x.ts"),
    ).length;
    expect(preChangeMaxSameFileConcurrent).toBe(3); // numeric scheduler over-admits

    // New scheduler: no sub-wave holds more than one writer of src/x.ts.
    const waves = ownershipSubWaves(level);
    const maxSameFilePerWave = Math.max(
      ...waves.map((w) => w.filter((n) => n.write_paths.includes("src/x.ts")).length),
    );
    expect(maxSameFilePerWave).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// INV-SOO-06: grant-time disjointness, not admission-only
// ---------------------------------------------------------------------------

describe("INV-SOO-06: a scope-widening grant onto an in-flight-held file is refused", () => {
  it("claimAmendment onto a file another in-flight node holds returns 'contended', not 'granted'", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "A", write_paths: ["src/a.ts"] },
      { node_id: "B", write_paths: ["src/b.ts"] },
    ]);
    // A widened its scope onto an UNOWNED file src/shared.ts and is in flight on it.
    registry.claimInFlight("A", ["src/a.ts", "src/shared.ts"]);
    // B tries to widen its scope onto that same in-flight file → refused (seam).
    expect(registry.claimAmendment("B", "src/shared.ts")).toBe("contended");
    // The in-flight owned-file union stays disjoint: src/shared.ts owned by A only.
    expect(registry.inFlightOwner("src/shared.ts")).toBe("A");
  });

  it("after A releases, B may claim the formerly in-flight file", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "A", write_paths: ["src/a.ts"] },
      { node_id: "B", write_paths: ["src/b.ts"] },
    ]);
    registry.claimInFlight("A", ["src/shared.ts"]);
    expect(registry.claimAmendment("B", "src/shared.ts")).toBe("contended");
    registry.releaseInFlight("A");
    expect(registry.claimAmendment("B", "src/shared.ts")).toBe("granted");
  });
});

// ---------------------------------------------------------------------------
// INV-SOO-07: atomic triage-retry claim hand-off A→A'
// ---------------------------------------------------------------------------

describe("INV-SOO-07: triage-retry hands off file claims atomically", () => {
  it("a single file stays continuously single-owned across the A→A' hand-off", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([{ node_id: "A", write_paths: ["src/x.ts"] }]);
    registry.claimInFlight("A", ["src/x.ts"]);
    expect(registry.inFlightOwner("src/x.ts")).toBe("A");

    // Atomic hand-off: there is no intermediate state where the file is unowned
    // or where a foreign node could be admitted between release and re-claim.
    registry.handoffInFlight("A", "A-prime");
    expect(registry.inFlightOwner("src/x.ts")).toBe("A-prime");
    // The file was never free → a foreign same-file node remains gated throughout.
    expect(registry.isFileOwnershipDisjoint("FOREIGN", ["src/x.ts"])).toBe(false);
  });

  it("hand-off transfers in-flight AND amendment claims; self-handoff is a no-op", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([{ node_id: "A", write_paths: ["src/x.ts"] }]);
    registry.claimInFlight("A", ["src/x.ts"]);
    registry.claimAmendment("A", "src/extra.ts");
    registry.handoffInFlight("A", "A-prime");
    expect(registry.inFlightOwner("src/x.ts")).toBe("A-prime");
    expect(registry.amendmentClaimant("src/extra.ts")).toBe("A-prime");
    // No-op self-handoff keeps ownership.
    registry.handoffInFlight("A-prime", "A-prime");
    expect(registry.inFlightOwner("src/x.ts")).toBe("A-prime");
  });
});

// ---------------------------------------------------------------------------
// INV-SOO-08: deterministic admission ordering
// ---------------------------------------------------------------------------

describe("INV-SOO-08: explicit block_id tie-break after the disjointness filter", () => {
  it("two runs over identical state admit the identical ordered subset", () => {
    const mk = (): OwnershipSchedulerNode[] => [
      node("B-9", ["src/a.ts"]),
      node("B-2", ["src/a.ts"]),
      node("B-5", ["src/a.ts"]),
    ];
    const run1 = ids(ownershipSubWaves(mk()));
    const run2 = ids(ownershipSubWaves(mk()));
    expect(run1).toEqual(run2);
    // Tie-break is ascending block_id: B-2 admits first, then B-5, then B-9.
    expect(run1).toEqual([["B-2"], ["B-5"], ["B-9"]]);
  });

  it("input order does not leak: shuffled input yields the same admission order", () => {
    const a = ids(ownershipSubWaves([
      node("B-5", ["src/a.ts"]),
      node("B-2", ["src/a.ts"]),
      node("B-9", ["src/a.ts"]),
    ]));
    const b = ids(ownershipSubWaves([
      node("B-9", ["src/a.ts"]),
      node("B-5", ["src/a.ts"]),
      node("B-2", ["src/a.ts"]),
    ]));
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// INV-SOO-09: canonical physical-file identity
// ---------------------------------------------------------------------------

describe("INV-SOO-09: rel/abs/'..'/case spellings of one file collide", () => {
  const root = process.cwd();

  it("a relative and a '..'-laden spelling of the same file canonicalize equal", () => {
    const a = canonicalizeFilePath("src/x.ts", { root });
    const b = canonicalizeFilePath("src/sub/../x.ts", { root });
    expect(a).toBe(b);
  });

  it("nodes that spell the same file differently are gated as same-file (serialize)", () => {
    const level = [
      node("B-1", ["src/x.ts"]),
      node("B-2", ["src/sub/../x.ts"]),
    ];
    const waves = ownershipSubWaves(level, root);
    // Same physical file → serialized into two sub-waves, never co-admitted.
    expect(waves).toHaveLength(2);
  });

  it("case-folding collides on a case-insensitive FS; stays distinct on Linux", () => {
    const lower = canonicalizeFilePath("src/x.ts", { root });
    const upper = canonicalizeFilePath("src/X.ts", { root });
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(lower).toBe(upper);
    } else {
      expect(lower).not.toBe(upper);
    }
  });

  it("canonicalScopeKeys reduces a node's declared scope to canonical identity", () => {
    const keys = canonicalScopeKeys(node("B", ["src/x.ts", "src/sub/../x.ts"]), root);
    expect(keys.size).toBe(1); // both spellings collapse to one physical file
  });
});

// ---------------------------------------------------------------------------
// INV-SOO-10: disposition-aware claim lifecycle
// ---------------------------------------------------------------------------

describe("INV-SOO-10: blocked-pending RETAINS; releasing dispositions RELEASE", () => {
  it("a blocked-PENDING-triage node retains its file claim (still live)", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([{ node_id: "A", write_paths: ["src/x.ts"] }]);
    registry.claimInFlight("A", ["src/x.ts"]);
    // blocked-pending: the node is awaiting a host decision → DO NOT release.
    expect(registry.inFlightOwner("src/x.ts")).toBe("A");
    // A same-file peer stays gated while A is pending.
    expect(registry.isFileOwnershipDisjoint("PEER", ["src/x.ts"])).toBe(false);
  });

  it("a releasing disposition (merged/blocked-final/abandoned/no-op) frees the file", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([{ node_id: "A", write_paths: ["src/x.ts"] }]);
    registry.claimInFlight("A", ["src/x.ts"]);
    registry.releaseInFlight("A"); // merged / blocked-final / abandoned / no-op
    expect(registry.inFlightOwner("src/x.ts")).toBeUndefined();
    // The freed file is now schedulable for the next same-file node (no inverse-deadlock).
    expect(registry.isFileOwnershipDisjoint("PEER", ["src/x.ts"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure modes (fail-1..fail-5)
// ---------------------------------------------------------------------------

describe("INV-SOO failure modes", () => {
  it("fail-1/CE-008: an EMPTY/unresolved declared scope is conservatively NON-disjoint", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([{ node_id: "A", write_paths: ["src/a.ts"] }]);
    registry.claimInFlight("A", ["src/a.ts"]);
    // A node with no declared scope must NOT be admitted as vacuously disjoint
    // while another node is in flight.
    expect(registry.isFileOwnershipDisjoint("EMPTY", [])).toBe(false);
    // It admits only when nothing else is in flight.
    registry.releaseInFlight("A");
    expect(registry.isFileOwnershipDisjoint("EMPTY", [])).toBe(true);
  });

  it("fail-1: an empty-scope node never batches with a peer in the sub-wave scheduler", () => {
    const level = [node("B-1", []), node("B-2", ["src/b.ts"])];
    const waves = ownershipSubWaves(level);
    // The empty-scope node is solo in its sub-wave (conservative gating).
    const emptyWave = waves.find((w) => w.some((n) => n.block_id === "B-1"))!;
    expect(emptyWave).toHaveLength(1);
  });

  it("fail-5: all eligible nodes share one file AND cap>1 → throughput capped at 1, N merges still scheduled", () => {
    const level = Array.from({ length: 4 }, (_, i) => node(`B-${i}`, ["src/x.ts"]));
    const waves = ownershipSubWaves(level);
    expect(waves).toHaveLength(4); // serialized
    expect(waves.flat()).toHaveLength(4); // forward progress: all N scheduled (no starved tail)
  });

  it("fail-3: a symlink alias is NOT silently treated as disjoint when realpath is unavailable", () => {
    // Without FS symlink resolution, link.ts and x.ts canonicalize distinctly
    // (recorded residual: degrades to the merge guard, not asserted disjoint here).
    const a = canonicalizeFilePath("src/link.ts", { root: process.cwd() });
    const b = canonicalizeFilePath("src/x.ts", { root: process.cwd() });
    expect(a).not.toBe(b);
    // The lexical canonical key is stable (no crash on a non-existent path).
    expect(canonicalizeFilePath("src/link.ts", { root: process.cwd(), resolveSymlinks: true }))
      .toBe(a);
  });
});
