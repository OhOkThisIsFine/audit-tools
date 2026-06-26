import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeContractArtifact,
  readContractArtifact,
  detectStaleArtifacts,
  contractArtifactExists,
  contractPipelineDir,
  contractArtifactFilePath,
  DEPENDENCY_MAP,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
} from "audit-tools/shared";
import {
  CP_MODULE_DECOMPOSITION_VERSION,
  CP_FINALIZED_MODULE_CONTRACTS_VERSION,
} from "../../src/remediate/validation/contractPipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-cp-artifact-store");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");

function makeGoalSpec(goalId = "GOAL-001") {
  return {
    contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
    goal_id: goalId,
    objective: "Improve test coverage.",
    non_goals: [],
    success_criteria: ["All tests pass."],
    source_type: "conversation" as const,
    created_at: new Date().toISOString(),
  };
}

function makeContextBundle(goalId = "GOAL-001") {
  return {
    contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
    goal_id: goalId,
    entries: [],
    context_summary: "Minimal context.",
    created_at: new Date().toISOString(),
  };
}

function makeModuleDecomposition(goalId = "GOAL-001") {
  return {
    contract_version: CP_MODULE_DECOMPOSITION_VERSION,
    goal_id: goalId,
    modules: [{ name: "mod-a", responsibilities: "Does A.", file_scope: ["src/a.ts"] }],
    created_at: new Date().toISOString(),
  };
}

function makeFinalizedModuleContracts(goalId = "GOAL-001") {
  return {
    contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
    goal_id: goalId,
    module_contracts: [{
      name: "mod-a",
      inputs: ["x"],
      outputs: ["y"],
      invariants: [],
      side_effects: [],
      validation_boundary: "validates x",
      failure_modes: [],
      seam_adjustments: [],
    }],
    created_at: new Date().toISOString(),
  };
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("contract pipeline artifact store", () => {
  it("writes a GoalSpec artifact and creates the expected JSON file", async () => {
    const payload = makeGoalSpec();
    const envelope = await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", payload);

    expect(envelope.artifact_name).toBe("goal_spec");
    expect(typeof envelope.content_hash).toBe("string");
    expect(envelope.content_hash.length).toBeGreaterThan(0);
    expect(contractArtifactExists(ARTIFACTS_DIR, "goal_spec")).toBe(true);
  });

  it("reads the artifact back and returns the original payload", async () => {
    const payload = makeGoalSpec("READ-TEST");
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", payload);

    const read = await readContractArtifact(ARTIFACTS_DIR, "goal_spec");
    expect(read).not.toBeNull();
    expect(read!.artifact_name).toBe("goal_spec");
    expect(read!.payload).toMatchObject(payload);
  });

  it("rewriting the same payload keeps the computed content hash stable", async () => {
    const payload = makeGoalSpec();
    const first = await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", payload);
    const second = await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", payload);
    expect(first.content_hash).toBe(second.content_hash);
  });

  it("stores the file under the contract-pipeline subdirectory", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    const cpDir = contractPipelineDir(ARTIFACTS_DIR);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(cpDir, "goal_spec.json"))).toBe(true);
  });
});

describe("contract pipeline staleness", () => {
  it("no artifacts are reported stale when all are freshly written", async () => {
    // Write a minimal chain: goal_spec → context_bundle → module_decomposition
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.stale).not.toContain("goal_spec");
    expect(result.stale).not.toContain("context_bundle");
    expect(result.stale).not.toContain("module_decomposition");
  });

  it("changing GoalSpec causes every downstream artifact to be reported stale", async () => {
    // Write chain.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec("OLD"));
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle("OLD"));
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition("OLD"));

    // Now rewrite goal_spec with different content.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec("NEW"));

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    // goal_spec itself is fresh (we just wrote it).
    expect(result.stale).not.toContain("goal_spec");
    // context_bundle and module_decomposition have goal_spec in their dependency hashes, but
    // those hashes were recorded from the OLD goal_spec.
    expect(result.stale).toContain("context_bundle");
    expect(result.stale).toContain("module_decomposition");
  });

  it("changing ContextBundle causes module_decomposition stale without marking GoalSpec stale", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle("OLD"));
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());

    // Rewrite context_bundle.
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", { ...makeContextBundle(), context_summary: "Updated." });

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.stale).not.toContain("goal_spec");
    expect(result.stale).not.toContain("context_bundle");
    expect(result.stale).toContain("module_decomposition");
  });

  it("an IN-PLACE load-bearing payload edit (header untouched) re-stales downstream and reconverges on re-read", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());

    // Edit goal_spec's payload directly on disk WITHOUT touching the stored
    // header — semantic_hash is no longer recorded, and the recompute-on-read
    // path must still detect the change. (Previously a cached header hash would
    // have hidden this edit.)
    const goalPath = contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec");
    const stored = JSON.parse(await readFile(goalPath, "utf8"));
    stored.payload.objective = "A different, load-bearing objective.";
    await writeFile(goalPath, JSON.stringify(stored), "utf8");

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    // goal_spec's own dependency_hashes are empty (no deps) so it is not stale,
    // but downstreams recorded the OLD recomputed hash and must now be stale.
    expect(result.stale).toContain("context_bundle");
    expect(result.stale).toContain("module_decomposition");

    // Reconverge: rewrite the downstreams against the edited goal_spec.
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());
    const after = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(after.stale).not.toContain("context_bundle");
    expect(after.stale).not.toContain("module_decomposition");
  });

  it("an IN-PLACE COSMETIC payload edit (same semantic projection) does NOT stale downstream", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());

    // Edit only a cosmetic field (created_at) — semantic projection strips it,
    // so the recomputed hash is unchanged and downstreams stay fresh.
    const goalPath = contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec");
    const stored = JSON.parse(await readFile(goalPath, "utf8"));
    stored.payload.created_at = new Date(Date.now() + 100000).toISOString();
    await writeFile(goalPath, JSON.stringify(stored), "utf8");

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.stale).not.toContain("context_bundle");
    expect(result.stale).not.toContain("module_decomposition");
  });

  it("reports absent artifacts correctly when they have never been written", async () => {
    // Write only goal_spec.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.absent).toContain("context_bundle");
    expect(result.absent).toContain("module_decomposition");
    expect(result.absent).not.toContain("goal_spec");
  });

  it("missing dependency causes downstream to be reported stale", async () => {
    // Write goal_spec and finalized_module_contracts but NOT context_bundle or module_decomposition.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", makeFinalizedModuleContracts());

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    // finalized_module_contracts depends on module_contracts (→ module_decomposition → context_bundle) which are absent.
    expect(result.stale).toContain("finalized_module_contracts");
  });

  it("absent artifacts are reported as absent rather than crashing", async () => {
    // Nothing written at all — should not throw and should report all as absent.
    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(Array.isArray(result.absent)).toBe(true);
    expect(result.absent).toContain("goal_spec");
  });
});

describe("artifact store dependency map — test_validator_plan", () => {
  it("DEPENDENCY_MAP test_validator_plan contains goal_spec and obligation_ledger", () => {
    expect(DEPENDENCY_MAP["test_validator_plan"]).toContain("goal_spec");
    expect(DEPENDENCY_MAP["test_validator_plan"]).toContain("obligation_ledger");
  });

  it("DEPENDENCY_MAP contract_assessment_report contains test_validator_plan", () => {
    expect(DEPENDENCY_MAP["contract_assessment_report"]).toContain("test_validator_plan");
  });

  it("DEPENDENCY_MAP counterexample contains test_validator_plan", () => {
    expect(DEPENDENCY_MAP["counterexample"]).toContain("test_validator_plan");
  });

  it("DEPENDENCY_MAP judge_report contains test_validator_plan", () => {
    expect(DEPENDENCY_MAP["judge_report"]).toContain("test_validator_plan");
  });

  it("DEPENDENCY_MAP implementation_dag contains test_validator_plan", () => {
    expect(DEPENDENCY_MAP["implementation_dag"]).toContain("test_validator_plan");
  });
});
