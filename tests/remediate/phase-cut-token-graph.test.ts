/**
 * Tokens-only phase-cut graph (open-bugs.md:106).
 *
 * Implementation ordering derives from the `artifact:` producer/consumer graph
 * ALONE. Drafted `neighbor_needs` are symmetric coordination prose authored by
 * per-module drafting agents (directions often inverted — see project memory
 * inverted-neighbor-edges-manufacture-a-cycle); unioned into the dependency
 * graph they manufacture cycles, and the fail-toward-later tier derivation then
 * places token consumers AHEAD of their producers. These tests pin:
 *   1. finalization DROPS neighbor_needs — the field never reaches the
 *      finalized contracts;
 *   2. phaseCutModulesFromContracts derives NO edge from neighbor_needs;
 *   3. a cyclic artifact-token graph is a VALIDATION error on the finalized
 *      artifact, not a silently dropped edge;
 *   4. the finalization gate does not derive over a cyclic token graph — it
 *      emits the contract_finalization LLM step with the cycle named.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveFinalizedModuleContracts } from "../../src/remediate/contractPipeline/derive.js";
import { phaseCutModulesFromContracts } from "../../src/remediate/contractPipeline/phaseCut.js";
import {
  validateFinalizedModuleContracts,
  CP_FINALIZED_MODULE_CONTRACTS_VERSION,
} from "../../src/remediate/validation/contractPipeline.js";
import {
  writeContractArtifact,
  contractArtifactExists,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";

const AT = new Date().toISOString();

/** A full drafted module contract; token edges come from the caller. */
function moduleContract(
  name: string,
  { inputs = [], outputs = [], neighbor_needs = [] as unknown[] } = {},
) {
  return {
    name,
    inputs,
    outputs,
    invariants: ["inv"],
    side_effects: [],
    validation_boundary: "none",
    failure_modes: [],
    neighbor_needs,
  };
}

describe("tokens-only phase-cut graph (open-bugs.md:106)", () => {
  it("finalization DROPS neighbor_needs from every module contract", () => {
    const finalized = deriveFinalizedModuleContracts(
      {
        goal_id: "goal-test",
        module_contracts: [
          moduleContract("A", { neighbor_needs: [{ neighbor: "B", needs: "the store" }] }),
          moduleContract("B"),
        ],
      },
      { mismatches: [] },
      { created_at: AT },
    );
    for (const mod of finalized.module_contracts as Record<string, unknown>[]) {
      expect(mod, `module ${String(mod.name)} must not carry neighbor_needs`).not.toHaveProperty(
        "neighbor_needs",
      );
    }
  });

  it("phaseCutModulesFromContracts derives NO edge from neighbor_needs", () => {
    const modules = phaseCutModulesFromContracts({
      module_contracts: [
        moduleContract("A", { neighbor_needs: [{ neighbor: "B", needs: "the store" }] }),
        moduleContract("B"),
      ],
    });
    const a = modules.find((m) => m.name === "A");
    expect(a?.depends_on, "neighbor_needs must contribute no dependency edge").toEqual([]);
  });

  it("validateFinalizedModuleContracts REFUSES a cyclic artifact-token graph", () => {
    const issues = validateFinalizedModuleContracts({
      contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
      goal_id: "goal-test",
      module_contracts: [
        {
          ...moduleContract("A", {
            inputs: ["needs artifact:beta"],
            outputs: ["emits artifact:alpha"],
          }),
          neighbor_needs: undefined,
          seam_adjustments: [],
        },
        {
          ...moduleContract("B", {
            inputs: ["needs artifact:alpha"],
            outputs: ["emits artifact:beta"],
          }),
          neighbor_needs: undefined,
          seam_adjustments: [],
        },
      ],
      created_at: AT,
    });
    const cycleIssues = issues.filter((i) => /cycle/i.test(i.message));
    expect(cycleIssues.length, `expected a cycle issue; got: ${JSON.stringify(issues)}`).toBeGreaterThan(0);
    expect(cycleIssues.map((i) => i.message).join("\n")).toMatch(/A/);
    expect(cycleIssues.map((i) => i.message).join("\n")).toMatch(/B/);
  });
});

describe("finalization gate over a cyclic token graph (open-bugs.md:106)", () => {
  let tmpDir: string;
  let artifactsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "phase-cut-cycle-"));
    artifactsDir = join(tmpDir, ".audit-tools");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("does NOT derive finalized contracts; emits the finalization LLM step with the cycle named", async () => {
    await writeContractArtifact(artifactsDir, "goal_spec", {
      contract_version: "remediate-code-contract-pipeline/goal-spec/v1alpha1",
      goal_id: "goal-test",
      objective: "Test goal",
      non_goals: [],
      success_criteria: ["works"],
      source_type: "conversation",
      created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "context_bundle", {
      contract_version: "remediate-code-contract-pipeline/context-bundle/v1alpha1",
      goal_id: "goal-test",
      entries: [],
      context_summary: "Test context",
      created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "module_decomposition", {
      contract_version: "remediate-code-contract-pipeline/module-decomposition/v1alpha1",
      goal_id: "goal-test",
      modules: [
        { name: "A", responsibilities: "does A", file_scope: [] },
        { name: "B", responsibilities: "does B", file_scope: [] },
      ],
      created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "module_contracts", {
      contract_version: "remediate-code-contract-pipeline/module-contracts/v1alpha1",
      goal_id: "goal-test",
      module_contracts: [
        moduleContract("A", {
          inputs: ["needs artifact:beta"],
          outputs: ["emits artifact:alpha"],
        }),
        moduleContract("B", {
          inputs: ["needs artifact:alpha"],
          outputs: ["emits artifact:beta"],
        }),
      ],
      created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "seam_reconciliation_report", {
      contract_version: "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1",
      goal_id: "goal-test",
      mismatches: [],
      created_at: AT,
    });

    const step = await buildNextContractPipelineStep({
      root: tmpDir,
      artifactsDir,
      runId: "test-run",
    });

    // The mechanical derive must refuse a cyclic declared graph…
    expect(
      contractArtifactExists(artifactsDir, "finalized_module_contracts"),
      "finalized contracts must NOT be derived over a cyclic token graph",
    ).toBe(false);
    // …and route to the LLM finalization step with the cycle in the prompt.
    expect(step).not.toBeNull();
    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toContain("Contract Finalization");
    expect(prompt).toContain("artifact:alpha");
    expect(prompt).toContain("artifact:beta");
  });
});
