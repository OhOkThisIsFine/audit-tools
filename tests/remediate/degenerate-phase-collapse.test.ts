/**
 * Self-scaling pipeline, slice 1 — degenerate-phase collapse.
 *
 * A single-module decomposition has no inter-module seams, so the pipeline
 * auto-satisfies `seam_reconciliation` (empty report) and `contract_finalization`
 * (verbatim passthrough of the drafted contracts) with NO host round-trip,
 * mirroring the obligation_ledger / cyclic_seam no-op fast paths. A multi-module
 * decomposition still dispatches both phases to the host.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeContractArtifact,
  readContractArtifact,
  contractArtifactExists,
  isEnvelope,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";

function makeArtifactsDir(root: string): string {
  return join(root, ".audit-tools");
}

/** Unwrap a contract-artifact envelope to its payload (mirrors the backend's private helper). */
async function readPayload(artifactsDir: string, name: Parameters<typeof readContractArtifact>[1]): Promise<unknown> {
  const env = await readContractArtifact(artifactsDir, name);
  if (!env) return undefined;
  return isEnvelope(env) ? env.payload : env;
}

async function promptOf(step: { prompt_path: string }): Promise<string> {
  return readFile(step.prompt_path, "utf8");
}

const AT = new Date().toISOString();

const GOAL_SPEC = {
  contract_version: "remediate-code-contract-pipeline/goal-spec/v1alpha1",
  goal_id: "goal-test",
  objective: "Test goal",
  non_goals: [],
  success_criteria: ["works"],
  source_type: "conversation",
  created_at: AT,
};

const CONTEXT_BUNDLE = {
  contract_version: "remediate-code-contract-pipeline/context-bundle/v1alpha1",
  goal_id: "goal-test",
  entries: [],
  context_summary: "Test context",
  created_at: AT,
};

function moduleContract(name: string) {
  return {
    name,
    inputs: ["x"],
    outputs: ["y"],
    invariants: ["inv"],
    side_effects: [],
    validation_boundary: "none",
    failure_modes: [],
    // neighbor_needs is a drafting-only field; the passthrough must drop it.
    neighbor_needs: [],
  };
}

describe("degenerate-phase collapse — single-module decomposition", () => {
  let tmpDir: string;
  let artifactsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "degenerate-collapse-"));
    artifactsDir = makeArtifactsDir(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeUpToDrafting(moduleNames: string[]): Promise<void> {
    await writeContractArtifact(artifactsDir, "goal_spec", GOAL_SPEC);
    await writeContractArtifact(artifactsDir, "context_bundle", CONTEXT_BUNDLE);
    await writeContractArtifact(artifactsDir, "module_decomposition", {
      contract_version:
        "remediate-code-contract-pipeline/module-decomposition/v1alpha1",
      goal_id: "goal-test",
      modules: moduleNames.map((name) => ({
        name,
        responsibilities: `does ${name}`,
        file_scope: [],
      })),
      created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "module_contracts", {
      contract_version:
        "remediate-code-contract-pipeline/module-contracts/v1alpha1",
      goal_id: "goal-test",
      module_contracts: moduleNames.map(moduleContract),
      created_at: AT,
    });
  }

  it("auto-satisfies seam_reconciliation + contract_finalization and lands on critique", async () => {
    await writeUpToDrafting(["A"]);

    const step = await buildNextContractPipelineStep({
      root: tmpDir,
      artifactsDir,
      runId: "test-run",
    });

    // Both degenerate phases were written by the backend (no host round-trip)...
    expect(contractArtifactExists(artifactsDir, "seam_reconciliation_report")).toBe(true);
    expect(contractArtifactExists(artifactsDir, "finalized_module_contracts")).toBe(true);

    const seam = (await readPayload(artifactsDir, "seam_reconciliation_report")) as {
      mismatches: unknown[];
    };
    expect(seam.mismatches).toEqual([]);

    const finalized = (await readPayload(artifactsDir, "finalized_module_contracts")) as {
      module_contracts: { name: string; seam_adjustments: unknown[]; neighbor_needs?: unknown }[];
    };
    expect(finalized.module_contracts).toHaveLength(1);
    expect(finalized.module_contracts[0].name).toBe("A");
    // Passthrough records empty seam_adjustments and drops the drafting-only field.
    expect(finalized.module_contracts[0].seam_adjustments).toEqual([]);
    expect(finalized.module_contracts[0].neighbor_needs).toBeUndefined();

    // ...so the next host phase is critique, NOT seam/finalization.
    expect(step).not.toBeNull();
    const prompt = await promptOf(step!);
    expect(prompt).toContain("Conceptual Design Critique");
    expect(prompt).not.toContain("Seam Reconciliation");
    expect(prompt).not.toContain("Contract Finalization");
  });
});

describe("degenerate-phase collapse — multi-module decomposition does NOT collapse", () => {
  let tmpDir: string;
  let artifactsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "degenerate-collapse-multi-"));
    artifactsDir = makeArtifactsDir(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("dispatches seam_reconciliation to the host and does not auto-write the report", async () => {
    await writeContractArtifact(artifactsDir, "goal_spec", GOAL_SPEC);
    await writeContractArtifact(artifactsDir, "context_bundle", CONTEXT_BUNDLE);
    await writeContractArtifact(artifactsDir, "module_decomposition", {
      contract_version:
        "remediate-code-contract-pipeline/module-decomposition/v1alpha1",
      goal_id: "goal-test",
      modules: [
        { name: "A", responsibilities: "does A", file_scope: [] },
        { name: "B", responsibilities: "does B", file_scope: [] },
      ],
      created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "module_contracts", {
      contract_version:
        "remediate-code-contract-pipeline/module-contracts/v1alpha1",
      goal_id: "goal-test",
      module_contracts: [moduleContract("A"), moduleContract("B")],
      created_at: AT,
    });

    const step = await buildNextContractPipelineStep({
      root: tmpDir,
      artifactsDir,
      runId: "test-run",
    });

    // Two modules → a real seam exists to reconcile → host step, not auto-write.
    expect(contractArtifactExists(artifactsDir, "seam_reconciliation_report")).toBe(false);
    expect(step).not.toBeNull();
    const prompt = await promptOf(step!);
    expect(prompt).toContain("Seam Reconciliation");
  });
});
