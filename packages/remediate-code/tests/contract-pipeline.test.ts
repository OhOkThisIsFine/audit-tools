import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  shouldEnterContractPipeline,
  nextMissingContractPhase,
  promoteImplementationDagToExtractedPlan,
} from "../src/steps/contractPipeline.js";
import { writeContractArtifact } from "../src/contractPipeline/artifactStore.js";
import { intakePaths } from "../src/intake.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
  CONTRACT_PIPELINE_DESIGN_SPEC_VERSION,
  CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
  CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
  CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
} from "@audit-tools/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-contract-pipeline");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

const CREATED_AT = "2026-01-01T00:00:00.000Z";

/** Valid payloads per artifact, used to build prefix chains for phase tests. */
const CHAIN_PAYLOADS = {
  goal_spec: {
    contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
    goal_id: "G1",
    objective: "Improve.",
    non_goals: [],
    success_criteria: ["Improved."],
    source_type: "conversation",
    created_at: CREATED_AT,
  },
  context_bundle: {
    contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
    goal_id: "G1",
    entries: [],
    context_summary: "ctx",
    created_at: CREATED_AT,
  },
  design_spec: {
    contract_version: CONTRACT_PIPELINE_DESIGN_SPEC_VERSION,
    goal_id: "G1",
    design_narrative: "n",
    invariants: [],
    affected_paths: [],
    created_at: CREATED_AT,
  },
  conceptual_design_critique: {
    contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
    goal_id: "G1",
    items: [],
    verdict: "approved",
    created_at: CREATED_AT,
  },
  obligation_ledger: {
    contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
    goal_id: "G1",
    obligations: [
      { id: "O-1", description: "Behavior holds.", kind: "behavioral", depends_on: [], status: "pending" },
    ],
    created_at: CREATED_AT,
  },
  contract_assessment_report: {
    contract_version: CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
    goal_id: "G1",
    findings: [],
    verdict: "passed",
    created_at: CREATED_AT,
  },
  counterexample: {
    contract_version: CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
    goal_id: "G1",
    counterexamples: [],
    created_at: CREATED_AT,
  },
  judge_report: {
    contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
    goal_id: "G1",
    verdict: "approved",
    classifications: [],
    created_at: CREATED_AT,
  },
  implementation_dag: {
    contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
    goal_id: "G1",
    nodes: [
      {
        id: "CP-001",
        title: "Do the work",
        description: "Implement the change.",
        satisfies_obligations: ["O-1"],
        depends_on: [],
        verification_obligation_ids: [],
        targeted_commands: [],
        status: "pending",
      },
    ],
    edges: [],
    created_at: CREATED_AT,
  },
} as const;

const CHAIN_ORDER = [
  "goal_spec",
  "context_bundle",
  "design_spec",
  "conceptual_design_critique",
  "obligation_ledger",
  "contract_assessment_report",
  "counterexample",
  "judge_report",
  "implementation_dag",
] as const;

/** Write valid envelopes for every artifact up to and including `through`. */
async function writeChainThrough(
  through: (typeof CHAIN_ORDER)[number],
): Promise<void> {
  for (const name of CHAIN_ORDER) {
    await writeContractArtifact(ARTIFACTS_DIR, name, CHAIN_PAYLOADS[name]);
    if (name === through) return;
  }
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("shouldEnterContractPipeline", () => {
  it("returns false for structured_audit source type (fast path)", () => {
    const result = shouldEnterContractPipeline(ARTIFACTS_DIR, "structured_audit");
    expect(result.shouldHandleContractPipeline).toBe(false);
  });

  it("returns true for conversation source type", () => {
    const result = shouldEnterContractPipeline(ARTIFACTS_DIR, "conversation");
    expect(result.shouldHandleContractPipeline).toBe(true);
    expect(result.pipelineComplete).toBe(false);
  });

  it("returns true for document source type", () => {
    const result = shouldEnterContractPipeline(ARTIFACTS_DIR, "document");
    expect(result.shouldHandleContractPipeline).toBe(true);
  });

  it("returns false when an extracted-plan.json already exists", async () => {
    const paths = intakePaths(ARTIFACTS_DIR);
    await mkdir(dirname(paths.extractedPlan), { recursive: true });
    await writeJson(paths.extractedPlan, { plan_id: "TEST", findings: [] });

    const result = shouldEnterContractPipeline(ARTIFACTS_DIR, "conversation");
    expect(result.shouldHandleContractPipeline).toBe(false);
  });

  it("returns pipelineComplete=true when implementation_dag exists but no extracted plan", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [],
      edges: [],
      created_at: new Date().toISOString(),
    });

    const result = shouldEnterContractPipeline(ARTIFACTS_DIR, "conversation");
    expect(result.shouldHandleContractPipeline).toBe(true);
    expect(result.pipelineComplete).toBe(true);
  });
});

describe("nextMissingContractPhase", () => {
  it("returns goal_normalization when no artifacts exist", () => {
    const phase = nextMissingContractPhase(ARTIFACTS_DIR);
    expect(phase).toBe("goal_normalization");
  });

  it("returns context_collection after goal_spec is written", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1",
      objective: "Improve.",
      non_goals: [],
      success_criteria: [],
      source_type: "conversation",
      created_at: new Date().toISOString(),
    });
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("context_collection");
  });

  it("returns design after goal_spec and context_bundle", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1",
      objective: "Improve.",
      non_goals: [],
      success_criteria: [],
      source_type: "conversation",
      created_at: new Date().toISOString(),
    });
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", {
      contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
      goal_id: "G1",
      entries: [],
      context_summary: "ctx",
      created_at: new Date().toISOString(),
    });
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("design");
  });

  it("returns obligation_ledger_phase before assessment when obligation_ledger missing", async () => {
    // Write goal, context, design, and critique — but NOT obligation_ledger.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1", objective: "Improve.", non_goals: [], success_criteria: [], source_type: "conversation", created_at: new Date().toISOString(),
    });
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", {
      contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
      goal_id: "G1", entries: [], context_summary: "ctx", created_at: new Date().toISOString(),
    });
    await writeContractArtifact(ARTIFACTS_DIR, "design_spec", {
      contract_version: CONTRACT_PIPELINE_DESIGN_SPEC_VERSION,
      goal_id: "G1", design_narrative: "n", invariants: [], affected_paths: [], created_at: new Date().toISOString(),
    });
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", {
      contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
      goal_id: "G1", items: [], verdict: "approved", created_at: new Date().toISOString(),
    });
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("obligation_ledger_phase");
  });

  it("returns critic after assessment, judge after counterexample (adversarial gate phases)", async () => {
    await writeChainThrough("contract_assessment_report");
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("critic");

    await writeContractArtifact(ARTIFACTS_DIR, "counterexample", CHAIN_PAYLOADS.counterexample);
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("judge");

    await writeContractArtifact(ARTIFACTS_DIR, "judge_report", CHAIN_PAYLOADS.judge_report);
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("implementation_planning");
  });

  it("returns null once implementation_dag exists, before closing verification", async () => {
    await writeChainThrough("implementation_dag");

    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBeNull();
  });

  it("returns null when all pipeline phases including closing are complete", async () => {
    await writeChainThrough("implementation_dag");
    // closing phase produces verification_report.
    await writeContractArtifact(ARTIFACTS_DIR, "verification_report", {
      contract_version: "remediate-code-verification-report/v1alpha1",
      goal_id: "G1", findings: [], overall_status: "passed", created_at: new Date().toISOString(),
    });

    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBeNull();
  });
});

describe("promoteImplementationDagToExtractedPlan", () => {
  it("maps depends_on to block IDs, handles empty depends_on, and uses CP-BLOCK- prefix consistently", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [
        {
          id: "CP-001",
          title: "Task 1",
          description: "Do first task",
        },
        {
          id: "CP-002",
          title: "Task 2",
          description: "Do second task",
          depends_on: ["CP-001"],
        },
      ],
      edges: [],
      created_at: new Date().toISOString(),
    });

    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);

    const paths = intakePaths(ARTIFACTS_DIR);
    const planContent = await readFile(paths.extractedPlan, "utf8");
    const plan = JSON.parse(planContent);

    expect(plan.blocks).toBeDefined();
    expect(plan.blocks.length).toBe(2);

    const block1 = plan.blocks.find((b: any) => b.block_id === "CP-BLOCK-CP-001");
    const block2 = plan.blocks.find((b: any) => b.block_id === "CP-BLOCK-CP-002");

    expect(block1).toBeDefined();
    expect(block1.dependencies).toEqual([]);

    expect(block2).toBeDefined();
    expect(block2.dependencies).toEqual(["CP-BLOCK-CP-001"]);
  });
});

