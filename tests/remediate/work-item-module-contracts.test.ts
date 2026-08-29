/**
 * Promotion attaches the APPROVED module contracts to blocks
 * (open-bugs.md:474): the implement work item used to carry only the node's
 * description and obligation ids — never the finalized contract text — so a
 * worker could implement a locally plausible interface that contradicts an
 * already-approved module contract, and the workflow held only when the DAG
 * author happened to restate every declared value. The promotion now resolves
 * each node's obligation-id slugs against `finalized_module_contracts` and
 * attaches the owning contracts VERBATIM to the block, which the dispatch
 * prompt then binds the worker to.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import { promoteImplementationDagToExtractedPlan } from "../../src/remediate/steps/contractPipeline.js";
import { intakePaths } from "../../src/remediate/intake.js";

const AT = new Date().toISOString();

describe("promotion attaches the owning module contracts (open-bugs.md:474)", () => {
  let tmp: string;
  let artifactsDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "promote-contracts-"));
    artifactsDir = join(tmp, ".audit-tools");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("resolves each node's obligation slugs against finalized_module_contracts", async () => {
    const contract = {
      name: "auth-module",
      inputs: ["credentials"],
      outputs: ["artifact:session"],
      invariants: ["INV-1: sessions survive refresh"],
      side_effects: [],
      validation_boundary: "validates credentials",
      failure_modes: ["InvalidCredentials"],
      seam_adjustments: [],
    };
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", {
      contract_version:
        "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1",
      goal_id: "G1",
      module_contracts: [contract],
      created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "implementation_dag", {
      contract_version:
        "remediate-code-contract-pipeline/implementation-dag/v1alpha1",
      goal_id: "G1",
      nodes: [
        {
          id: "CP-001",
          title: "Implement the auth module",
          description: "Apply the approved contract.",
          satisfies_obligations: ["OBL-auth-module-inv-1"],
          output_files: ["src/auth.ts"],
          depends_on: [],
          verification_obligation_ids: [],
          targeted_commands: [],
          status: "pending",
        },
      ],
      edges: [],
      created_at: AT,
    });

    await promoteImplementationDagToExtractedPlan(artifactsDir, tmp);

    const plan = JSON.parse(
      await readFile(intakePaths(artifactsDir).extractedPlan, "utf8"),
    );
    expect(plan.blocks).toHaveLength(1);
    // The owning contract rides the block VERBATIM.
    expect(plan.blocks[0].module_contracts).toEqual([
      { module: "auth-module", contract },
    ]);
  });

  it("attaches nothing when no obligation resolves to a module", async () => {
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", {
      contract_version:
        "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1",
      goal_id: "G1",
      module_contracts: [
        {
          name: "auth-module",
          inputs: [],
          outputs: [],
          invariants: [],
          side_effects: [],
          validation_boundary: "none",
          failure_modes: [],
          seam_adjustments: [],
        },
      ],
      created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "implementation_dag", {
      contract_version:
        "remediate-code-contract-pipeline/implementation-dag/v1alpha1",
      goal_id: "G1",
      nodes: [
        {
          id: "CP-001",
          title: "Unmatched task",
          description: "No module home.",
          satisfies_obligations: ["O-1"],
          output_files: ["src/x.ts"],
          depends_on: [],
          verification_obligation_ids: [],
          targeted_commands: [],
          status: "pending",
        },
      ],
      edges: [],
      created_at: AT,
    });

    await promoteImplementationDagToExtractedPlan(artifactsDir, tmp);

    const plan = JSON.parse(
      await readFile(intakePaths(artifactsDir).extractedPlan, "utf8"),
    );
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0]).not.toHaveProperty("module_contracts");
  });
});
