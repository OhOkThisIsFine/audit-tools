import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeContractArtifact,
  readContractArtifact,
  detectStaleArtifacts,
  contractArtifactExists,
  contractPipelineDir,
} from "../src/contractPipeline/artifactStore.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
  CONTRACT_PIPELINE_DESIGN_SPEC_VERSION,
} from "@audit-tools/shared";

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

function makeDesignSpec(goalId = "GOAL-001") {
  return {
    contract_version: CONTRACT_PIPELINE_DESIGN_SPEC_VERSION,
    goal_id: goalId,
    design_narrative: "Add tests.",
    invariants: [],
    affected_paths: [],
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
    // Write a minimal chain: goal_spec → context_bundle → design_spec
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "design_spec", makeDesignSpec());

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.stale).not.toContain("goal_spec");
    expect(result.stale).not.toContain("context_bundle");
    expect(result.stale).not.toContain("design_spec");
  });

  it("changing GoalSpec causes every downstream artifact to be reported stale", async () => {
    // Write chain.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec("OLD"));
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle("OLD"));
    await writeContractArtifact(ARTIFACTS_DIR, "design_spec", makeDesignSpec("OLD"));

    // Now rewrite goal_spec with different content.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec("NEW"));

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    // goal_spec itself is fresh (we just wrote it).
    expect(result.stale).not.toContain("goal_spec");
    // context_bundle and design_spec have goal_spec in their dependency hashes, but
    // those hashes were recorded from the OLD goal_spec.
    expect(result.stale).toContain("context_bundle");
    expect(result.stale).toContain("design_spec");
  });

  it("changing ContextBundle causes design_spec stale without marking GoalSpec stale", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle("OLD"));
    await writeContractArtifact(ARTIFACTS_DIR, "design_spec", makeDesignSpec());

    // Rewrite context_bundle.
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", { ...makeContextBundle(), context_summary: "Updated." });

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.stale).not.toContain("goal_spec");
    expect(result.stale).not.toContain("context_bundle");
    expect(result.stale).toContain("design_spec");
  });

  it("reports absent artifacts correctly when they have never been written", async () => {
    // Write only goal_spec.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.absent).toContain("context_bundle");
    expect(result.absent).toContain("design_spec");
    expect(result.absent).not.toContain("goal_spec");
  });

  it("missing dependency causes downstream to be reported stale", async () => {
    // Write goal_spec and design_spec but NOT context_bundle.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "design_spec", makeDesignSpec());

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    // design_spec depends on context_bundle which is absent.
    expect(result.stale).toContain("design_spec");
  });

  it("absent artifacts are reported as absent rather than crashing", async () => {
    // Nothing written at all — should not throw and should report all as absent.
    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(Array.isArray(result.absent)).toBe(true);
    expect(result.absent).toContain("goal_spec");
  });
});
