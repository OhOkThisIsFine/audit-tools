/**
 * Remediator auto-phasing (T3): the tool DERIVES a foundations→consumers phase cut
 * from the module-dependency DAG and hands it to the conceptual-design critique, so
 * an arbitrary N-goal change is assessed within a mechanically dependency-ordered
 * phasing instead of being rejected as "over-scoped" (which used to force the host
 * to re-scope by hand at intake).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  derivePhaseCut,
  phaseCutModulesFromContracts,
  phaseOrdinalForObligations,
  moduleSlug,
  type PhaseCutModule,
} from "../../src/remediate/contractPipeline/phaseCut.js";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";
import { writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  ensurePhaseCutArtifact,
  readPhaseCutArtifact,
  phaseCutFilePath,
} from "../../src/remediate/contractPipeline/phaseCutArtifact.js";

/** Tier of a named module in a derived cut. */
function tierOf(
  cut: ReturnType<typeof derivePhaseCut>,
  name: string,
): number | undefined {
  return cut.phases.find((p) => p.modules.includes(name))?.ordinal;
}

describe("derivePhaseCut", () => {
  it("places dependency-free modules in the foundations tier and dependents above", () => {
    const modules: PhaseCutModule[] = [
      { name: "core", depends_on: [] },
      { name: "api", depends_on: ["core"] },
      { name: "ui", depends_on: ["api"] },
    ];
    const cut = derivePhaseCut(modules);
    expect(cut.has_cycle).toBe(false);
    expect(tierOf(cut, "core")).toBe(0);
    expect(tierOf(cut, "api")).toBe(1);
    expect(tierOf(cut, "ui")).toBe(2);
    expect(cut.phases[0].name).toBe("foundations");
    expect(cut.phases.at(-1)!.name).toBe("integration");
  });

  it("groups independent foundations together and a diamond consumer at the deepest tier", () => {
    // a,b are foundations; c needs a; d needs b,c => d sits one past c.
    const cut = derivePhaseCut([
      { name: "a", depends_on: [] },
      { name: "b", depends_on: [] },
      { name: "c", depends_on: ["a"] },
      { name: "d", depends_on: ["b", "c"] },
    ]);
    expect(tierOf(cut, "a")).toBe(0);
    expect(tierOf(cut, "b")).toBe(0);
    expect(tierOf(cut, "c")).toBe(1);
    expect(tierOf(cut, "d")).toBe(2);
    expect(cut.phases[0].modules).toEqual(["a", "b"]);
  });

  it("is deterministic and covers every module exactly once", () => {
    const modules: PhaseCutModule[] = [
      { name: "z", depends_on: ["y"] },
      { name: "y", depends_on: ["x"] },
      { name: "x", depends_on: [] },
    ];
    const a = derivePhaseCut(modules);
    const b = derivePhaseCut(modules);
    expect(a).toEqual(b);
    const all = a.phases.flatMap((p) => p.modules).sort();
    expect(all).toEqual(["x", "y", "z"]);
  });

  it("ignores edges to unknown (out-of-scope) module names", () => {
    const cut = derivePhaseCut([
      { name: "solo", depends_on: ["does-not-exist"] },
    ]);
    expect(cut.has_cycle).toBe(false);
    expect(tierOf(cut, "solo")).toBe(0);
    expect(cut.phases).toHaveLength(1);
  });

  it("is cycle-safe — a dependency cycle is flagged and its members are still tiered", () => {
    const cut = derivePhaseCut([
      { name: "p", depends_on: ["q"] },
      { name: "q", depends_on: ["p"] },
    ]);
    expect(cut.has_cycle).toBe(true);
    // Every member is still placed exactly once (no crash, no drop).
    const all = cut.phases.flatMap((c) => c.modules).sort();
    expect(all).toEqual(["p", "q"]);
  });

  it("yields a single foundations phase when nothing depends on anything", () => {
    const cut = derivePhaseCut([
      { name: "m1", depends_on: [] },
      { name: "m2", depends_on: [] },
    ]);
    expect(cut.phases).toHaveLength(1);
    expect(cut.phases[0].name).toBe("foundations");
  });
});

describe("phaseCutModulesFromContracts", () => {
  it("derives depends_on from each module's directional neighbor_needs", () => {
    const modules = phaseCutModulesFromContracts({
      module_contracts: [
        { name: "core", neighbor_needs: [] },
        { name: "api", neighbor_needs: [{ neighbor: "core", needs: "the store" }] },
      ],
    });
    expect(modules).toEqual([
      { name: "core", depends_on: [] },
      { name: "api", depends_on: ["core"] },
    ]);
  });

  it("degrades to empty on a malformed payload", () => {
    expect(phaseCutModulesFromContracts(null)).toEqual([]);
    expect(phaseCutModulesFromContracts({})).toEqual([]);
    expect(phaseCutModulesFromContracts({ module_contracts: "nope" })).toEqual([]);
  });

  it("derives depends_on from producer/consumer artifact tokens in inputs/outputs (finalized contracts drop neighbor_needs)", () => {
    // Finalized contracts carry no neighbor_needs — the ordering must come from
    // the data-flow: 'roster' produces artifact:validated-roster; 'fanout' consumes it.
    const modules = phaseCutModulesFromContracts({
      module_contracts: [
        { name: "roster", inputs: ["the raw list"], outputs: ["artifact:validated-roster (a checked roster)"] },
        { name: "fanout", inputs: ["artifact:validated-roster to fan out"], outputs: ["dispatched work"] },
      ],
    });
    expect(modules).toEqual([
      { name: "roster", depends_on: [] },
      { name: "fanout", depends_on: ["roster"] },
    ]);
  });

  it("unions neighbor_needs with artifact-token edges and matches artifact names case-insensitively", () => {
    const modules = phaseCutModulesFromContracts({
      module_contracts: [
        { name: "core", outputs: ["artifact:Store"] },
        { name: "seed", neighbor_needs: [], outputs: [] },
        {
          name: "api",
          neighbor_needs: [{ neighbor: "seed", needs: "seed data" }],
          inputs: ["artifact:store for reads"],
        },
      ],
    });
    const api = modules.find((m) => m.name === "api")!;
    expect([...api.depends_on].sort()).toEqual(["core", "seed"]);
  });

  it("ignores an artifact token consumed and produced by the same module (no self-edge)", () => {
    const modules = phaseCutModulesFromContracts({
      module_contracts: [
        { name: "rewriter", inputs: ["artifact:doc"], outputs: ["artifact:doc (rewritten)"] },
      ],
    });
    expect(modules).toEqual([{ name: "rewriter", depends_on: [] }]);
  });
});

describe("module_phase map + phaseOrdinalForObligations (node→phase key)", () => {
  it("exposes a module name → ordinal map alongside the phases", () => {
    const cut = derivePhaseCut([
      { name: "core", depends_on: [] },
      { name: "api", depends_on: ["core"] },
      { name: "ui", depends_on: ["api"] },
    ]);
    expect(cut.module_phase).toEqual({ core: 0, api: 1, ui: 2 });
  });

  it("moduleSlug matches the obligation-ledger id fragment", () => {
    expect(moduleSlug("Auth Service")).toBe("auth-service");
    expect(moduleSlug("core")).toBe("core");
  });

  it("resolves a node's phase from its obligation ids by module slug", () => {
    const slugToOrdinal = new Map([
      ["core", 0],
      ["api", 1],
    ]);
    // Single-module obligations resolve to that module's ordinal.
    expect(
      phaseOrdinalForObligations(["OBL-core-contract"], slugToOrdinal, 1),
    ).toBe(0);
    expect(
      phaseOrdinalForObligations(["OBL-api-inv-1"], slugToOrdinal, 1),
    ).toBe(1);
  });

  it("takes the MAX ordinal for a node spanning phases (fail-toward-later)", () => {
    const slugToOrdinal = new Map([
      ["core", 0],
      ["api", 2],
    ]);
    expect(
      phaseOrdinalForObligations(
        ["OBL-core-contract", "OBL-api-fail-1"],
        slugToOrdinal,
        2,
      ),
    ).toBe(2);
  });

  it("defaults an unmatched / counterexample-only node to the last phase", () => {
    const slugToOrdinal = new Map([["core", 0]]);
    expect(phaseOrdinalForObligations([], slugToOrdinal, 3)).toBe(3);
    expect(
      phaseOrdinalForObligations(["OBL-unknown-mod-contract"], slugToOrdinal, 3),
    ).toBe(3);
  });

  it("prefers the longest matching slug (prefix disambiguation)", () => {
    const slugToOrdinal = new Map([
      ["auth", 0],
      ["auth-service", 2],
    ]);
    expect(
      phaseOrdinalForObligations(["OBL-auth-service-contract"], slugToOrdinal, 2),
    ).toBe(2);
  });
});

describe("auto-phasing wired into the critique step", () => {
  let root: string;
  let artifactsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "phase-cut-"));
    artifactsDir = join(root, ".audit-tools", "remediation");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Seed every pre-critique artifact so nextMissingContractPhase returns "critique". */
  async function seedThroughFinalization(): Promise<void> {
    const GID = "G-PC";
    const CV = (n: string) => `remediate-code-contract-pipeline/${n}/v1alpha1`;
    await writeContractArtifact(artifactsDir, "goal_spec", {
      contract_version: CV("goal-spec"),
      goal_id: GID,
      goals: ["x"],
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await writeContractArtifact(artifactsDir, "context_bundle", {
      contract_version: CV("context-bundle"),
      goal_id: GID,
      files: [],
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await writeContractArtifact(artifactsDir, "module_decomposition", {
      contract_version: CV("module-decomposition"),
      goal_id: GID,
      modules: [
        { name: "core", responsibilities: "base", file_scope: ["src/core.ts"] },
        { name: "api", responsibilities: "uses core", file_scope: ["src/api.ts"] },
      ],
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const moduleContract = (name: string, needs: string[]) => ({
      name,
      inputs: [],
      outputs: [],
      invariants: [],
      side_effects: [],
      validation_boundary: "self",
      failure_modes: [],
      neighbor_needs: needs.map((n) => ({ neighbor: n, needs: "x" })),
    });
    await writeContractArtifact(artifactsDir, "module_contracts", {
      contract_version: CV("module-contracts"),
      goal_id: GID,
      module_contracts: [
        moduleContract("core", []),
        moduleContract("api", ["core"]),
      ],
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await writeContractArtifact(artifactsDir, "seam_reconciliation_report", {
      contract_version: CV("seam-reconciliation-report"),
      goal_id: GID,
      mismatches: [],
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", {
      contract_version: CV("finalized-module-contracts"),
      goal_id: GID,
      module_contracts: [
        { ...moduleContract("core", []), seam_adjustments: [] },
        { ...moduleContract("api", ["core"]), seam_adjustments: [] },
      ],
      created_at: "2026-01-01T00:00:00.000Z",
    });
  }

  it("injects the derived phase cut into the critique prompt for a multi-phase change", async () => {
    await seedThroughFinalization();

    const step = await buildNextContractPipelineStep({
      root,
      artifactsDir,
      runId: "PC-TEST",
    });

    expect(step).not.toBeNull();
    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toContain("Mechanically-Derived Phase Cut");
    expect(prompt).toContain("Phase 0 — foundations");
    expect(prompt).toContain("core");
    expect(prompt).toContain("api");
    // The anti-over-scoping directive is present.
    expect(prompt).toMatch(/Do NOT reject the work as/i);

    // The cut is PERSISTED as the first-class sidecar (single-sourced for the
    // downstream implementation-DAG promotion), not just rendered into the prompt.
    const persisted = await readPhaseCutArtifact(artifactsDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.module_phase).toEqual({ core: 0, api: 1 });
    expect(existsSync(phaseCutFilePath(artifactsDir))).toBe(true);
  });

  it("ensurePhaseCutArtifact derives + persists the cut idempotently from finalized contracts", async () => {
    await seedThroughFinalization();
    const first = await ensurePhaseCutArtifact(artifactsDir);
    expect(first).not.toBeNull();
    expect(first!.phases.map((p) => p.modules)).toEqual([["core"], ["api"]]);
    const firstBytes = await readFile(phaseCutFilePath(artifactsDir), "utf8");
    // Re-deriving the same DAG yields byte-identical JSON (deterministic).
    await ensurePhaseCutArtifact(artifactsDir);
    expect(await readFile(phaseCutFilePath(artifactsDir), "utf8")).toBe(firstBytes);
  });

  it("returns null (no sidecar) when there are no finalized contracts to phase", async () => {
    expect(await ensurePhaseCutArtifact(artifactsDir)).toBeNull();
    expect(existsSync(phaseCutFilePath(artifactsDir))).toBe(false);
  });
});
