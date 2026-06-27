// Rolling per-node scheduler + tool-owned final gate (CP-BLOCK-N-rolling-scheduler).
//
// Covers the block's invariants and residuals:
//  - INV-RS-01: verified-complete rolling eligibility — a SKIP / blocked
//    dependency NEVER satisfies a dependency edge.
//  - Rolling dependency levels + shared-rebuild-between-levels + single-flight
//    build (driveRollingDispatch wiring onto shared createRollingDispatcher).
//  - INV-RS-10: tool-owned, non-vacuous, plan.test_command-independent,
//    env-scrubbed final gate.
//  - CE-001: per-package build-free + single-flight (no same-package double build).
//  - CE-002: runtime/packaged-bin smoke surface declared as a residual.
//  - CE-003: bounded auto-terminate to terminal `blocked` for a NO-HUMAN host
//    (negative test) + close.ts force-close guard against landing a blocked suite.
//  - Atomic-replace: the waveScheduler.ts shim file is deleted.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import {
  dependencyVerifiedComplete,
  isVerifiedCompleteStatus,
  rollingDependencyLevels,
  phaseBoundaryToGate,
  driveRollingDispatch,
  toolOwnedFinalGateCommands,
  isAuditToolsMonorepo,
  runToolOwnedFinalGate,
  applyCoarseReblock,
  COARSE_REBLOCK_BOUND,
  type GateRunner,
} from "../../src/remediate/steps/nextStep.js";
import { mergedBaseCheckArgv } from "../../src/remediate/steps/gateCommands.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { RemediationBlock, RemediationItemState } from "../../src/remediate/state/types.js";
import type { CapacityPool, ProviderSlot, SessionConfig } from "audit-tools/shared";
import { runClosePhase } from "../../src/remediate/phases/close.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> remediate-code/ -> packages/ -> repo root.
const REPO_ROOT = join(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Tiny state builders
// ---------------------------------------------------------------------------

function block(
  id: string,
  items: string[],
  dependencies: string[] = [],
): RemediationBlock {
  return { block_id: id, items, parallel_safe: true, dependencies };
}

function item(
  findingId: string,
  blockId: string,
  status: RemediationItemState["status"],
): RemediationItemState {
  return { finding_id: findingId, status, block_id: blockId };
}

function stateWith(
  blocks: RemediationBlock[],
  items: Record<string, RemediationItemState>,
): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-RS",
      findings: blocks.flatMap((b) =>
        b.items.map((id) => ({
          id,
          title: id,
          category: "correctness",
          severity: "medium" as const,
          confidence: "high" as const,
          lens: "correctness",
          summary: id,
          affected_files: [{ path: `src/${id}.ts` }],
          evidence: [`src/${id}.ts:1`],
        })),
      ),
      blocks,
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items,
    closing_plan: { action: "none" },
  };
}

/** A block carrying an auto-phasing phase ordinal (T3). */
function phasedBlock(
  id: string,
  items: string[],
  phaseOrdinal: number,
  dependencies: string[] = [],
): RemediationBlock {
  return { ...block(id, items, dependencies), phase_ordinal: phaseOrdinal };
}

// ===========================================================================
// INV-PHASE-01: auto-phasing barrier — a higher phase never dispatches until
// every lower phase is verified-complete (foundations→consumers, T3).
// ===========================================================================

describe("INV-PHASE-01: phase barrier in rollingDependencyLevels", () => {
  it("emits only the lowest unfinished phase while a foundation is still pending", () => {
    const blocks = [
      phasedBlock("B0", ["F0"], 0),
      phasedBlock("B1", ["F1"], 1),
      phasedBlock("B2", ["F2"], 2),
    ];
    const st = stateWith(blocks, {
      F0: item("F0", "B0", "pending"),
      F1: item("F1", "B1", "pending"),
      F2: item("F2", "B2", "pending"),
    });
    const levels = rollingDependencyLevels(st);
    // Only phase 0 is eligible; phases 1/2 are barrier-gated, not stacked into
    // later levels (their barrier needs a VERIFIED-complete phase 0, not merely
    // a placed one).
    expect(levels.map((l) => l.map((b) => b.block_id))).toEqual([["B0"]]);
  });

  it("opens the next phase once the prior phase is verified-complete", () => {
    const blocks = [
      phasedBlock("B0", ["F0"], 0),
      phasedBlock("B1", ["F1"], 1),
    ];
    const st = stateWith(blocks, {
      F0: item("F0", "B0", "resolved"),
      F1: item("F1", "B1", "pending"),
    });
    const levels = rollingDependencyLevels(st);
    expect(levels.map((l) => l.map((b) => b.block_id))).toEqual([["B1"]]);
  });

  it("runs same-phase independent blocks together in one level", () => {
    const blocks = [
      phasedBlock("B0a", ["F0a"], 0),
      phasedBlock("B0b", ["F0b"], 0),
    ];
    const st = stateWith(blocks, {
      F0a: item("F0a", "B0a", "pending"),
      F0b: item("F0b", "B0b", "pending"),
    });
    const levels = rollingDependencyLevels(st);
    expect(levels).toHaveLength(1);
    expect(levels[0].map((b) => b.block_id).sort()).toEqual(["B0a", "B0b"]);
  });

  it("a foundation that can never verify-complete (skipped) dead-ends its consumers", () => {
    const blocks = [
      phasedBlock("B0", ["F0"], 0),
      phasedBlock("B1", ["F1"], 1),
    ];
    const st = stateWith(blocks, {
      F0: item("F0", "B0", "ignored"), // skipped → barrier can never clear
      F1: item("F1", "B1", "pending"),
    });
    const levels = rollingDependencyLevels(st);
    // No level forms: B0 is not pending (skipped) so nothing to place; B1 is
    // permanently ineligible behind an unsatisfiable phase barrier.
    expect(levels).toEqual([]);
  });

  it("ordinal-free blocks collapse to phase 0 — identical to pre-auto-phasing", () => {
    const blocks = [block("B1", ["F1"]), block("B2", ["F2"], ["B1"])];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "pending"),
      F2: item("F2", "B2", "pending"),
    });
    const levels = rollingDependencyLevels(st);
    // Both phase 0; B2 still stacks behind its explicit dependency on B1.
    expect(levels.map((l) => l.map((b) => b.block_id))).toEqual([["B1"], ["B2"]]);
  });
});

// ===========================================================================
// T3 per-phase boundary gate — phaseBoundaryToGate predicate. A whole-repo
// suite gate runs once at the UNTOUCHED entry of each phase P > 0.
// ===========================================================================

describe("phaseBoundaryToGate: per-phase whole-repo gate trigger (T3)", () => {
  it("no gate at phase 0 entry (no preceding phase to validate)", () => {
    const blocks = [phasedBlock("B0", ["F0"], 0), phasedBlock("B1", ["F1"], 1)];
    const st = stateWith(blocks, {
      F0: item("F0", "B0", "pending"),
      F1: item("F1", "B1", "pending"),
    });
    expect(phaseBoundaryToGate(st)).toBeNull();
  });

  it("gates phase 1 entry once foundations (phase 0) are verified-complete", () => {
    const blocks = [phasedBlock("B0", ["F0"], 0), phasedBlock("B1", ["F1"], 1)];
    const st = stateWith(blocks, {
      F0: item("F0", "B0", "resolved"),
      F1: item("F1", "B1", "pending"),
    });
    expect(phaseBoundaryToGate(st)).toBe(1);
  });

  it("does NOT re-gate mid-phase — once a phase-P block has left pending", () => {
    // Two phase-1 blocks; one already resolved → phase 1 is no longer pristine.
    const blocks = [
      phasedBlock("B0", ["F0"], 0),
      phasedBlock("B1a", ["F1a"], 1),
      phasedBlock("B1b", ["F1b"], 1),
    ];
    const st = stateWith(blocks, {
      F0: item("F0", "B0", "resolved"),
      F1a: item("F1a", "B1a", "resolved"),
      F1b: item("F1b", "B1b", "pending"),
    });
    expect(phaseBoundaryToGate(st)).toBeNull();
  });

  it("gates the next boundary (phase 2) once phase 1 is fully verified", () => {
    const blocks = [
      phasedBlock("B0", ["F0"], 0),
      phasedBlock("B1", ["F1"], 1),
      phasedBlock("B2", ["F2"], 2),
    ];
    const st = stateWith(blocks, {
      F0: item("F0", "B0", "resolved"),
      F1: item("F1", "B1", "resolved"),
      F2: item("F2", "B2", "pending"),
    });
    expect(phaseBoundaryToGate(st)).toBe(2);
  });

  it("ordinal-free (single-phase) plan never gates per-phase", () => {
    const blocks = [block("B1", ["F1"]), block("B2", ["F2"], ["B1"])];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "resolved"),
      F2: item("F2", "B2", "pending"),
    });
    expect(phaseBoundaryToGate(st)).toBeNull();
  });

  it("no gate when the frontier is empty (nothing pending)", () => {
    const blocks = [phasedBlock("B0", ["F0"], 0), phasedBlock("B1", ["F1"], 1)];
    const st = stateWith(blocks, {
      F0: item("F0", "B0", "resolved"),
      F1: item("F1", "B1", "resolved"),
    });
    expect(phaseBoundaryToGate(st)).toBeNull();
  });

  it("dead-ended consumer (skipped foundation) yields no frontier → no gate", () => {
    const blocks = [phasedBlock("B0", ["F0"], 0), phasedBlock("B1", ["F1"], 1)];
    const st = stateWith(blocks, {
      F0: item("F0", "B0", "ignored"), // barrier can never clear
      F1: item("F1", "B1", "pending"),
    });
    expect(phaseBoundaryToGate(st)).toBeNull();
  });
});

// ===========================================================================
// INV-RS-01: verified-complete eligibility — skip != satisfied
// ===========================================================================

describe("INV-RS-01: verified-complete eligibility (skip never satisfies a dep)", () => {
  it("isVerifiedCompleteStatus: only resolved / resolved_no_change are verified-complete", () => {
    expect(isVerifiedCompleteStatus("resolved")).toBe(true);
    expect(isVerifiedCompleteStatus("resolved_no_change")).toBe(true);
    // SKIP dispositions are terminal but NOT verified-complete.
    expect(isVerifiedCompleteStatus("ignored")).toBe(false);
    expect(isVerifiedCompleteStatus("deemed_inappropriate")).toBe(false);
    // blocked / pending are not verified-complete either.
    expect(isVerifiedCompleteStatus("blocked")).toBe(false);
    expect(isVerifiedCompleteStatus("pending")).toBe(false);
    expect(isVerifiedCompleteStatus(undefined)).toBe(false);
  });

  it("a resolved dependency makes the dependent eligible", () => {
    const blocks = [block("B1", ["F1"]), block("B2", ["F2"], ["B1"])];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "resolved"),
      F2: item("F2", "B2", "pending"),
    });
    expect(dependencyVerifiedComplete(blocks[1], st)).toBe(true);
  });

  it("a SKIPPED dependency (ignored) NEVER satisfies the edge — dependent stays ineligible", () => {
    const blocks = [block("B1", ["F1"]), block("B2", ["F2"], ["B1"])];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "ignored"),
      F2: item("F2", "B2", "pending"),
    });
    expect(dependencyVerifiedComplete(blocks[1], st)).toBe(false);
  });

  it("a deemed_inappropriate dependency NEVER satisfies the edge", () => {
    const blocks = [block("B1", ["F1"]), block("B2", ["F2"], ["B1"])];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "deemed_inappropriate"),
      F2: item("F2", "B2", "pending"),
    });
    expect(dependencyVerifiedComplete(blocks[1], st)).toBe(false);
  });

  it("a blocked dependency does not satisfy the edge", () => {
    const blocks = [block("B1", ["F1"]), block("B2", ["F2"], ["B1"])];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "blocked"),
      F2: item("F2", "B2", "pending"),
    });
    expect(dependencyVerifiedComplete(blocks[1], st)).toBe(false);
  });

  it("a dangling dependency edge never strands the dependent", () => {
    const blocks = [block("B2", ["F2"], ["B-missing"])];
    const st = stateWith(blocks, { F2: item("F2", "B2", "pending") });
    expect(dependencyVerifiedComplete(blocks[0], st)).toBe(true);
  });
});

// ===========================================================================
// Rolling dependency levels + shared-rebuild-between-levels + single-flight
// ===========================================================================

describe("rollingDependencyLevels: rolling per-node partition (INV-RS-01)", () => {
  it("partitions a linear A->B->C DAG into three single-node levels", () => {
    const blocks = [
      block("A", ["FA"]),
      block("B", ["FB"], ["A"]),
      block("C", ["FC"], ["B"]),
    ];
    const st = stateWith(blocks, {
      FA: item("FA", "A", "pending"),
      FB: item("FB", "B", "pending"),
      FC: item("FC", "C", "pending"),
    });
    const levels = rollingDependencyLevels(st);
    expect(levels.map((l) => l.map((b) => b.block_id))).toEqual([
      ["A"],
      ["B"],
      ["C"],
    ]);
  });

  it("places independent nodes in the same (first) level", () => {
    const blocks = [block("A", ["FA"]), block("B", ["FB"])];
    const st = stateWith(blocks, {
      FA: item("FA", "A", "pending"),
      FB: item("FB", "B", "pending"),
    });
    const levels = rollingDependencyLevels(st);
    expect(levels).toHaveLength(1);
    expect(levels[0].map((b) => b.block_id).sort()).toEqual(["A", "B"]);
  });

  it("a node whose dependency was SKIPPED is NOT placed in any level (INV-RS-01)", () => {
    const blocks = [block("A", ["FA"]), block("B", ["FB"], ["A"])];
    const st = stateWith(blocks, {
      FA: item("FA", "A", "ignored"),
      FB: item("FB", "B", "pending"),
    });
    const levels = rollingDependencyLevels(st);
    // A is terminal (not pending), B's only dep is skipped → no level forms.
    expect(levels.flat().map((b) => b.block_id)).not.toContain("B");
  });

  it("an already-verified upstream lets a fresh downstream node be level 0", () => {
    const blocks = [block("A", ["FA"]), block("B", ["FB"], ["A"])];
    const st = stateWith(blocks, {
      FA: item("FA", "A", "resolved"),
      FB: item("FB", "B", "pending"),
    });
    const levels = rollingDependencyLevels(st);
    expect(levels.map((l) => l.map((b) => b.block_id))).toEqual([["B"]]);
  });
});

describe("driveRollingDispatch: shared rebuild between levels + single-flight (CE-001)", () => {
  const pools: CapacityPool[] = [
    {
      id: "claude-code/*",
      providerName: "claude-code",
      hostModel: null,
    } as CapacityPool,
  ];
  const sessionConfig: SessionConfig = { quota: { enabled: false } } as SessionConfig;

  it("interposes exactly one shared rebuild between two dependency levels", async () => {
    const levels = [[block("A", ["FA"])], [block("B", ["FB"], ["A"])]];
    let rebuildCount = 0;
    const order: string[] = [];
    const result = await driveRollingDispatch(levels, {
      confirmedPools: pools,
      sessionConfig,
      dispatchNode: async (b, _slot: ProviderSlot) => {
        order.push(`dispatch:${b.block_id}`);
        return { packet: { id: b.block_id, payload: { block_id: b.block_id }, estimatedTokens: 1, complexity: 0.5 }, outcome: "success" as const };
      },
      rebuildSharedBetweenLevels: async () => {
        rebuildCount += 1;
        order.push("rebuild");
      },
    });
    // Two levels → exactly one inter-level rebuild.
    expect(rebuildCount).toBe(1);
    expect(result.rebuilds).toBe(1);
    // The rebuild lands strictly between level-0 and level-1 dispatch.
    expect(order).toEqual(["dispatch:A", "rebuild", "dispatch:B"]);
  });

  it("performs NO rebuild for a single level (one build, never per-node)", async () => {
    const levels = [[block("A", ["FA"]), block("B", ["FB"])]];
    let rebuildCount = 0;
    const result = await driveRollingDispatch(levels, {
      confirmedPools: pools,
      sessionConfig,
      dispatchNode: async (b) => ({
        packet: { id: b.block_id, payload: { block_id: b.block_id }, estimatedTokens: 1, complexity: 0.5 },
        outcome: "success" as const,
      }),
      rebuildSharedBetweenLevels: async () => {
        rebuildCount += 1;
      },
    });
    expect(rebuildCount).toBe(0);
    expect(result.rebuilds).toBe(0);
    // Both nodes in the single level were dispatched (scheduler-owned concurrency,
    // no wave cap).
    expect(result.levels[0].results.map((r) => r.packet.id).sort()).toEqual(["A", "B"]);
  });

  it("does not start a second rebuild while one is in flight (single-flight CE-001)", async () => {
    const levels = [[block("A", ["FA"])], [block("B", ["FB"], ["A"])], [block("C", ["FC"], ["B"])]];
    let concurrentRebuilds = 0;
    let maxConcurrentRebuilds = 0;
    const result = await driveRollingDispatch(levels, {
      confirmedPools: pools,
      sessionConfig,
      dispatchNode: async (b) => ({
        packet: { id: b.block_id, payload: { block_id: b.block_id }, estimatedTokens: 1, complexity: 0.5 },
        outcome: "success" as const,
      }),
      rebuildSharedBetweenLevels: async () => {
        concurrentRebuilds += 1;
        maxConcurrentRebuilds = Math.max(maxConcurrentRebuilds, concurrentRebuilds);
        await new Promise((r) => setTimeout(r, 5));
        concurrentRebuilds -= 1;
      },
    });
    // Three levels → two inter-level rebuilds, never overlapping.
    expect(result.rebuilds).toBe(2);
    expect(maxConcurrentRebuilds).toBe(1);
  });
});

// ===========================================================================
// INV-RS-10: tool-owned final gate (non-vacuous, plan-independent, env-scrubbed)
// CE-001 (build-free per-package, single-flight) + CE-002 (runtime residual)
// ===========================================================================

describe("INV-RS-10 / CE-001 / CE-002: tool-owned final gate command list", () => {
  it("the repo root IS recognized as the audit-tools monorepo", () => {
    expect(isAuditToolsMonorepo(REPO_ROOT)).toBe(true);
  });

  it("is NON-VACUOUS for the audit-tools monorepo (build + check + unit layers)", () => {
    const cmds = toolOwnedFinalGateCommands(REPO_ROOT);
    expect(cmds.length).toBeGreaterThan(0);
    const layers = new Set(cmds.map((c) => c.layer));
    expect(layers.has("build")).toBe(true);
    expect(layers.has("check")).toBe(true);
    expect(layers.has("unit")).toBe(true);
  });

  it("is INDEPENDENT of plan.test_command (commands are fixed tool-owned argv)", () => {
    const cmds = toolOwnedFinalGateCommands(REPO_ROOT);
    // Every command is a concrete npm/node/npx argv — none reference a plan field.
    const allowedBins = new Set(["npm", "node", "npx"]);
    for (const c of cmds) {
      expect(allowedBins.has(c.argv[0])).toBe(true);
    }
    // Single package: one build, then check.
    expect(cmds[0].argv).toEqual(["npm", "run", "build"]);
    expect(cmds[1].argv).toEqual(["npm", "run", "check"]);
  });

  it("CE-001: every UNIT command is build-free (never `npm test`/`npm run build`)", () => {
    const unit = toolOwnedFinalGateCommands(REPO_ROOT).filter((c) => c.layer === "unit");
    // Single package: node:test (shared+audit) + vitest (remediate).
    expect(unit.length).toBe(2);
    for (const c of unit) {
      expect(c.build_free).toBe(true);
      const joined = c.argv.join(" ");
      expect(joined).not.toMatch(/\bnpm\s+(test|t)\b/);
      expect(joined).not.toMatch(/\bnpm\s+run\s+(test|build)\b/);
    }
  });

  it("CE-001: single-flight — the unit suites are distinct commands (no suite run twice)", () => {
    const unit = toolOwnedFinalGateCommands(REPO_ROOT).filter((c) => c.layer === "unit");
    const joined = unit.map((c) => c.argv.join(" "));
    expect(new Set(joined).size).toBe(joined.length);
  });

  it("CE-001: the package builds at most once (single-flight build, never `npm -w`)", () => {
    const builds = toolOwnedFinalGateCommands(REPO_ROOT).filter((c) => c.layer === "build");
    // Exactly one whole-package build — never a per-workspace `npm run build -w <pkg>`.
    expect(builds).toHaveLength(1);
    const workspaceBuilds = builds.filter((b) => b.argv.includes("-w"));
    expect(workspaceBuilds).toHaveLength(0);
  });

  it("returns an EMPTY list for a non-audit-tools repo (scoped, not fabricated)", () => {
    expect(toolOwnedFinalGateCommands(join(__dirname, ".does-not-exist"))).toEqual([]);
    expect(isAuditToolsMonorepo(join(__dirname, ".does-not-exist"))).toBe(false);
  });

  it("A3: the merged-base check is PINNED to the gate's `check`-layer argv (not a hardcoded string)", () => {
    // Single-sourced from the same derivation as the final gate — the per-node
    // merged-base check (INV-2) and the final gate can never drift apart.
    const checkLayer = toolOwnedFinalGateCommands(REPO_ROOT).find((c) => c.layer === "check");
    expect(mergedBaseCheckArgv(REPO_ROOT)).toEqual(checkLayer?.argv);
    expect(mergedBaseCheckArgv(REPO_ROOT)).toEqual(["npm", "run", "check"]);
  });

  it("A3: merged-base check is null (skipped) on a non-audit-tools target", () => {
    expect(mergedBaseCheckArgv(join(__dirname, ".does-not-exist"))).toBeNull();
  });
});

describe("INV-RS-10: runToolOwnedFinalGate execution + CE-002 residual", () => {
  it("runs every gate command (injected runner) and passes when all green", async () => {
    const seen: string[][] = [];
    const runner: GateRunner = (argv) => {
      seen.push(argv);
      return { status: 0 };
    };
    const result = await runToolOwnedFinalGate(REPO_ROOT, { runner });
    expect(result.passed).toBe(true);
    expect(result.scoped_out).toBe(false);
    // All four commands ran (build, check, node:test unit, vitest unit).
    expect(seen.length).toBe(4);
    // CE-002: the runtime/packaged-bin smoke surface is declared as a residual.
    expect(result.runtime_residual.surface).toMatch(/smoke/i);
    expect(result.runtime_residual.commands.length).toBeGreaterThan(0);
  });

  it("fails and short-circuits on the first red command (a broken build stops the floor)", async () => {
    const seen: string[][] = [];
    const runner: GateRunner = (argv) => {
      seen.push(argv);
      // Fail the very first command (shared build).
      return { status: 1 };
    };
    const result = await runToolOwnedFinalGate(REPO_ROOT, { runner });
    expect(result.passed).toBe(false);
    // Short-circuit: only the first command ran.
    expect(seen.length).toBe(1);
    expect(result.results[0].passed).toBe(false);
  });

  it("a vacuous plan.test_command can never substitute: the gate runs its OWN commands", async () => {
    // The gate takes no plan and never consults plan.test_command — it always
    // runs the fixed tool-owned argv. Proven by the runner receiving build/check.
    const ran = new Set<string>();
    const runner: GateRunner = (argv) => {
      ran.add(argv.join(" "));
      return { status: 0 };
    };
    await runToolOwnedFinalGate(REPO_ROOT, { runner });
    expect(ran.has("npm run build")).toBe(true);
    expect(ran.has("npm run check")).toBe(true);
  });

  it("is scoped_out (not vacuously passing) for a non-audit-tools repo", async () => {
    const result = await runToolOwnedFinalGate(join(__dirname, ".no-repo"), {
      runner: () => ({ status: 1 }), // would fail if it ran anything
    });
    expect(result.scoped_out).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(0);
  });
});

// ===========================================================================
// INV-RS-09 + CE-003: coarse re-block + bounded auto-terminate (no-human host)
// ===========================================================================

describe("INV-RS-09 / CE-003: coarse re-block with bounded auto-terminate", () => {
  function resolvedState(): RemediationState {
    const blocks = [block("B1", ["F1"]), block("B2", ["F2"])];
    return stateWith(blocks, {
      F1: item("F1", "B1", "resolved"),
      F2: item("F2", "B2", "resolved"),
    });
  }

  it("below the bound: re-opens ALL non-skip items to pending and re-attempts via the rolling scheduler (INV-RS-09)", () => {
    const st = resolvedState();
    const decision = applyCoarseReblock(st, 0, "gate red");
    // The whole-repo red is unattributable → every resolved item is re-attempted
    // through the rolling scheduler, NOT the human triage prompt.
    expect(decision.action).toBe("reattempt_all");
    expect(decision.next_count).toBe(1);
    expect(st.items!.F1.status).toBe("pending");
    expect(st.items!.F2.status).toBe("pending");
  });

  it("leaves user SKIP dispositions untouched while re-attempting the rest", () => {
    const blocks = [block("B1", ["F1"]), block("B2", ["F2"])];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "resolved"),
      F2: item("F2", "B2", "ignored"),
    });
    const decision = applyCoarseReblock(st, 0, "gate red");
    expect(decision.action).toBe("reattempt_all");
    expect(st.items!.F1.status).toBe("pending"); // re-attempted
    expect(st.items!.F2.status).toBe("ignored"); // settled skip preserved
  });

  it("NEGATIVE (no-human host): at the bound it converges DETERMINISTICALLY to terminal blocked — never livelock, never a triage prompt", () => {
    const st = resolvedState();
    // currentCount already at the bound → terminate, do NOT re-attempt.
    const decision = applyCoarseReblock(st, COARSE_REBLOCK_BOUND, "gate still red");
    expect(decision.action).toBe("terminal_blocked");
    // Counter does not advance past the bound (no unbounded growth).
    expect(decision.next_count).toBe(COARSE_REBLOCK_BOUND);
    // Every item is now terminal `blocked` — a no-human host run cannot livelock,
    // never reaches the human triage prompt, and is never force-closed to green.
    for (const it of Object.values(st.items!)) {
      expect(it.status).toBe("blocked");
      expect(it.completed_at).toBeDefined();
    }
  });

  it("the bounded counter reaches terminal within COARSE_REBLOCK_BOUND+1 iterations (deterministic convergence)", () => {
    let st = resolvedState();
    let count = 0;
    let actions: string[] = [];
    for (let i = 0; i < 10; i++) {
      // Re-resolve to simulate a rolling re-attempt that the gate keeps rejecting.
      for (const it of Object.values(st.items!)) it.status = "resolved";
      const decision = applyCoarseReblock(st, count, "still red");
      actions.push(decision.action);
      count = decision.next_count;
      if (decision.action === "terminal_blocked") break;
    }
    // Deterministic convergence: exactly BOUND reattempt_all then one terminal_blocked.
    expect(actions.filter((a) => a === "reattempt_all")).toHaveLength(COARSE_REBLOCK_BOUND);
    expect(actions[actions.length - 1]).toBe("terminal_blocked");
  });
});

// ===========================================================================
// CE-003: close.ts force-close guard — never land a blocked suite as green
// ===========================================================================

describe("CE-003: close.ts force-close guard preserves artifacts when an item is blocked", () => {
  const GUARD_DIR = join(__dirname, ".test-rolling-close-guard");
  const REPO_DIR = join(GUARD_DIR, "repo");
  const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools", "remediation");

  beforeEach(async () => {
    await rm(GUARD_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(GUARD_DIR, { recursive: true, force: true });
  });

  it("a blocked terminal item keeps fullyGreen false → artifacts dir is preserved (not landed green)", async () => {
    // No plan.test_command → combinedTest is vacuously passing; a vacuous suite
    // must NOT mask a blocked item and let the run be cleaned up as complete.
    const blocks = [block("B1", ["F1"]), block("B2", ["F2"])];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "resolved"),
      F2: item("F2", "B2", "blocked"),
    });
    st.status = "closing";
    st.items!.F2.failure_reason = "gate red, coarse-reblocked";
    await new (await import("../../src/remediate/state/store.js")).StateStore(ARTIFACTS_DIR).saveState(st);

    const result = await runClosePhase(st, { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.status).toBe("complete");
    // The artifacts dir must survive (run not fully green because F2 is blocked),
    // so the partial outcome stays diagnosable.
    expect(existsSync(ARTIFACTS_DIR)).toBe(true);
    // The durable outcomes report records the blocked item.
    const outcomes = JSON.parse(
      await readFile(join(REPO_DIR, ".audit-tools", "remediation-outcomes.json"), "utf8"),
    );
    const f2 = outcomes.outcomes.find((e: { finding_id: string }) => e.finding_id === "F-002" || e.finding_id === "F2");
    expect(f2.outcome).toBe("blocked");
  });
});

// ===========================================================================
// INV-RS-01 end-to-end: a skipped dependency dead-ends the dependent (orchestrator)
// ===========================================================================

describe("INV-RS-01 (orchestrator): a node whose dependency was SKIPPED is dead-ended, never dispatched", () => {
  const harness = createNextStepHarness(".test-rolling-skip-deadend");

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  it("B2 (depends on skipped B1) is marked blocked, not dispatched, and the run does not loop", async () => {
    // B1 is user-skipped (ignored); B2 depends on B1. Under INV-RS-01 the skip
    // never satisfies B2's edge, so B2 must be dead-ended (blocked), and the
    // implementing phase must not livelock on the un-dispatchable pending node.
    const blocks = [block("B1", ["F1"]), block("B2", ["F2"], ["B1"])];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "ignored"),
      F2: item("F2", "B2", "pending"),
    });
    st.items!.F1.failure_reason = "user skipped";
    await harness.saveState(st);
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();

    // Drive to a terminal step; must converge (no infinite loop) — the bounded
    // guard below is the livelock assertion (a true loop would exhaust it).
    let step = await decideNextStep({ root: harness.REPO_DIR });
    let guard = 20;
    while (
      step.step_kind !== "present_report" &&
      step.step_kind !== "collect_triage" &&
      guard-- > 0
    ) {
      step = await decideNextStep({ root: harness.REPO_DIR });
    }
    // Converged (did not livelock): a terminal step was reached well within guard.
    expect(guard).toBeGreaterThan(0);

    // B2 must NEVER have been dispatched: no dispatch step targeted it. The
    // strongest signal is the final state — F2 dead-ended to `blocked` (INV-RS-01),
    // F1 left as the user's `ignored` skip. The artifacts dir is preserved because
    // the run is not fully green (F2 blocked), so state.json is still readable.
    const finalState = JSON.parse(
      await readFile(join(harness.ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(finalState.items.F1.status).toBe("ignored");
    expect(finalState.items.F2.status).toBe("blocked");
    expect(finalState.items.F2.failure_reason ?? "").toMatch(
      /verified-complete|INV-RS-01|skipped|blocked|cyclic/i,
    );
  });
});

// ===========================================================================
// Atomic-replace: the waveScheduler.ts shim is deleted
// ===========================================================================

describe("atomic-replace: wave-batch shim removed", () => {
  it("src/remediate/steps/waveScheduler.ts no longer exists", () => {
    expect(existsSync(join(REPO_ROOT, "src/remediate/steps/waveScheduler.ts"))).toBe(false);
  });

  it("the wave-batch single-item step kind is gone from the types union", async () => {
    const typesSrc = await readFile(
      join(REPO_ROOT, "src/remediate/steps/types.ts"),
      "utf8",
    );
    expect(typesSrc).not.toContain("implement_single_item");
    expect(typesSrc).toContain("implement_rolling_sequential");
  });
});
