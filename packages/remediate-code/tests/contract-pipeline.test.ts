import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  shouldEnterContractPipeline,
  nextMissingContractPhase,
  promoteImplementationDagToExtractedPlan,
} from "../src/steps/contractPipeline.js";
import {
  renderContractPipelinePrompt,
  CONTRACT_PIPELINE_PHASE_ORDER,
} from "../src/steps/contractPipelinePrompts.js";
import { writeContractArtifact } from "../src/contractPipeline/artifactStore.js";
import { intakePaths } from "../src/intake.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
  CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
  CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
  CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
  CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
} from "@audit-tools/shared";
import {
  validateTestValidatorPlan,
  CONTRACT_PIPELINE_VALIDATORS,
} from "../src/validation/contractPipeline.js";

const CP_MODULE_DECOMPOSITION_VERSION = "remediate-code-contract-pipeline/module-decomposition/v1alpha1" as const;
const CP_MODULE_CONTRACTS_VERSION = "remediate-code-contract-pipeline/module-contracts/v1alpha1" as const;
const CP_SEAM_RECONCILIATION_REPORT_VERSION = "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1" as const;
const CP_FINALIZED_MODULE_CONTRACTS_VERSION = "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1" as const;

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
  module_decomposition: {
    contract_version: CP_MODULE_DECOMPOSITION_VERSION,
    goal_id: "G1",
    modules: [{ name: "mod-a", responsibilities: "Does A.", file_scope: ["src/a.ts"] }],
    created_at: CREATED_AT,
  },
  module_contracts: {
    contract_version: CP_MODULE_CONTRACTS_VERSION,
    goal_id: "G1",
    module_contracts: [{
      name: "mod-a",
      inputs: ["x"],
      outputs: ["y"],
      invariants: [],
      side_effects: [],
      validation_boundary: "validates x",
      failure_modes: [],
      neighbor_needs: [],
    }],
    created_at: CREATED_AT,
  },
  seam_reconciliation_report: {
    contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
    goal_id: "G1",
    mismatches: [],
    created_at: CREATED_AT,
  },
  finalized_module_contracts: {
    contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
    goal_id: "G1",
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
  cyclic_seam_resolution: {
    contract_version: "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
    goal_id: "G1",
    status: "no_cycles",
    cycles: [],
    created_at: CREATED_AT,
  },
  test_validator_plan: {
    contract_version: "remediate-code-contract-pipeline/test-validator-plan/v1alpha1",
    goal_id: "G1",
    test_specs: [
      { obligation_id: "O-1", name: "behavior holds test", kind: "unit", assertions: ["behavior holds"] },
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
  "module_decomposition",
  "module_contracts",
  "seam_reconciliation_report",
  "finalized_module_contracts",
  "conceptual_design_critique",
  "obligation_ledger",
  "cyclic_seam_resolution",
  "test_validator_plan",
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
  it("N-R06: returns true for structured_audit source type (fast path deleted, all paths enter pipeline)", () => {
    const result = shouldEnterContractPipeline(ARTIFACTS_DIR, "structured_audit");
    expect(result.shouldHandleContractPipeline).toBe(true);
    expect(result.pipelineComplete).toBe(false);
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

  it("returns decomposition after goal_spec and context_bundle", async () => {
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
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("decomposition");
  });

  it("returns obligation_ledger before assessment when obligation_ledger missing", async () => {
    // Write goal, context, all seam-negotiation phases, and critique — but NOT obligation_ledger.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1", objective: "Improve.", non_goals: [], success_criteria: [], source_type: "conversation", created_at: new Date().toISOString(),
    });
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", {
      contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
      goal_id: "G1", entries: [], context_summary: "ctx", created_at: new Date().toISOString(),
    });
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", CHAIN_PAYLOADS.module_decomposition);
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", CHAIN_PAYLOADS.module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", CHAIN_PAYLOADS.seam_reconciliation_report);
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", CHAIN_PAYLOADS.finalized_module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", {
      contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
      goal_id: "G1", items: [], verdict: "approved", created_at: new Date().toISOString(),
    });
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("obligation_ledger");
  });

  it("returns test_validator_plan after obligation_ledger is written", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1", objective: "Improve.", non_goals: [], success_criteria: [], source_type: "conversation", created_at: new Date().toISOString(),
    });
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", {
      contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
      goal_id: "G1", entries: [], context_summary: "ctx", created_at: new Date().toISOString(),
    });
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", CHAIN_PAYLOADS.module_decomposition);
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", CHAIN_PAYLOADS.module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", CHAIN_PAYLOADS.seam_reconciliation_report);
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", CHAIN_PAYLOADS.finalized_module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", {
      contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
      goal_id: "G1", items: [], verdict: "approved", created_at: new Date().toISOString(),
    });
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", CHAIN_PAYLOADS.obligation_ledger);
    await writeContractArtifact(ARTIFACTS_DIR, "cyclic_seam_resolution", CHAIN_PAYLOADS.cyclic_seam_resolution);
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("test_validator_plan");
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

describe("N-R08: obligation_ledger as first-class phase", () => {
  it("CONTRACT_PIPELINE_PHASE_ORDER includes obligation_ledger", () => {
    expect(CONTRACT_PIPELINE_PHASE_ORDER).toContain("obligation_ledger");
  });

  it("obligation_ledger appears between critique and assessment in CONTRACT_PIPELINE_PHASE_ORDER", () => {
    const obIdx = CONTRACT_PIPELINE_PHASE_ORDER.indexOf("obligation_ledger");
    const critiqueIdx = CONTRACT_PIPELINE_PHASE_ORDER.indexOf("critique");
    const assessmentIdx = CONTRACT_PIPELINE_PHASE_ORDER.indexOf("assessment");
    expect(obIdx).toBeGreaterThan(critiqueIdx);
    expect(obIdx).toBeLessThan(assessmentIdx);
  });

  it("nextMissingContractPhase returns obligation_ledger after critique is written but obligation_ledger absent", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", CHAIN_PAYLOADS.goal_spec);
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", CHAIN_PAYLOADS.context_bundle);
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", CHAIN_PAYLOADS.module_decomposition);
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", CHAIN_PAYLOADS.module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", CHAIN_PAYLOADS.seam_reconciliation_report);
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", CHAIN_PAYLOADS.finalized_module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", CHAIN_PAYLOADS.conceptual_design_critique);
    // obligation_ledger NOT written
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("obligation_ledger");
  });

  it("nextMissingContractPhase returns cyclic_seam_resolution after obligation_ledger is written but cyclic_seam_resolution absent", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", CHAIN_PAYLOADS.goal_spec);
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", CHAIN_PAYLOADS.context_bundle);
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", CHAIN_PAYLOADS.module_decomposition);
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", CHAIN_PAYLOADS.module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", CHAIN_PAYLOADS.seam_reconciliation_report);
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", CHAIN_PAYLOADS.finalized_module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", CHAIN_PAYLOADS.conceptual_design_critique);
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", CHAIN_PAYLOADS.obligation_ledger);
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("cyclic_seam_resolution");
  });

  it("nextMissingContractPhase returns assessment after test_validator_plan is written", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", CHAIN_PAYLOADS.goal_spec);
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", CHAIN_PAYLOADS.context_bundle);
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", CHAIN_PAYLOADS.module_decomposition);
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", CHAIN_PAYLOADS.module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", CHAIN_PAYLOADS.seam_reconciliation_report);
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", CHAIN_PAYLOADS.finalized_module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", CHAIN_PAYLOADS.conceptual_design_critique);
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", CHAIN_PAYLOADS.obligation_ledger);
    await writeContractArtifact(ARTIFACTS_DIR, "cyclic_seam_resolution", CHAIN_PAYLOADS.cyclic_seam_resolution);
    await writeContractArtifact(ARTIFACTS_DIR, "test_validator_plan", CHAIN_PAYLOADS.test_validator_plan);
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("assessment");
  });

  it("nextMissingContractPhase never returns the old sentinel obligation_ledger_phase", async () => {
    // With no artifacts: should return goal_normalization, not the old sentinel.
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).not.toBe("obligation_ledger_phase");

    // With critique written but obligation_ledger missing: should return obligation_ledger.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", CHAIN_PAYLOADS.goal_spec);
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", CHAIN_PAYLOADS.context_bundle);
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", CHAIN_PAYLOADS.module_decomposition);
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", CHAIN_PAYLOADS.module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", CHAIN_PAYLOADS.seam_reconciliation_report);
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", CHAIN_PAYLOADS.finalized_module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", CHAIN_PAYLOADS.conceptual_design_critique);
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("obligation_ledger");
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).not.toBe("obligation_ledger_phase");
  });

  it("renderContractPipelinePrompt handles obligation_ledger role without throwing", () => {
    const ARTIFACTS_PATH = "/a";
    const result = renderContractPipelinePrompt({
      role: "obligation_ledger",
      artifactPaths: {
        goal_spec: `${ARTIFACTS_PATH}/goal_spec.json`,
        finalized_module_contracts: `${ARTIFACTS_PATH}/finalized_module_contracts.json`,
        obligation_ledger: `${ARTIFACTS_PATH}/obligation_ledger.json`,
      },
    });
    expect(result.outputPath).toBe(`${ARTIFACTS_PATH}/obligation_ledger.json`);
    expect(result.prompt).toContain("contract_version");
  });
});

describe("validateTestValidatorPlan — valid payloads", () => {
  it("accepts a well-formed payload with unit test spec", () => {
    const payload = {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [
        { obligation_id: "O-1", name: "behavior holds", kind: "unit", assertions: ["the behavior holds"] },
      ],
      created_at: new Date().toISOString(),
    };
    const issues = validateTestValidatorPlan(payload);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("accepts a well-formed payload with inapplicable_claim carrying obligation_id and reason", () => {
    const payload = {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [
        {
          obligation_id: "O-2",
          name: "inapplicable test",
          kind: "schema",
          assertions: ["schema matches"],
          inapplicable_claim: { obligation_id: "O-2", reason: "This obligation is a pure invariant with no runtime testable path." },
        },
      ],
      created_at: new Date().toISOString(),
    };
    const issues = validateTestValidatorPlan(payload);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });
});

describe("validateTestValidatorPlan — malformed payloads", () => {
  it("non-object input produces an issue at path test_validator_plan", () => {
    const issues = validateTestValidatorPlan("not-an-object");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].path).toBe("test_validator_plan");
  });

  it("missing contract_version produces a contract_version issue", () => {
    const payload = {
      goal_id: "G1",
      test_specs: [],
      created_at: new Date().toISOString(),
    };
    const issues = validateTestValidatorPlan(payload);
    expect(issues.some((i) => i.path.includes("contract_version"))).toBe(true);
  });

  it("wrong contract_version string produces a contract_version issue", () => {
    const payload = {
      contract_version: "wrong-version",
      goal_id: "G1",
      test_specs: [],
      created_at: new Date().toISOString(),
    };
    const issues = validateTestValidatorPlan(payload);
    expect(issues.some((i) => i.path.includes("contract_version"))).toBe(true);
  });

  it("test_spec entry with empty obligation_id produces a path-specific issue", () => {
    const payload = {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [{ obligation_id: "", name: "test", kind: "unit", assertions: ["assert something"] }],
      created_at: new Date().toISOString(),
    };
    const issues = validateTestValidatorPlan(payload);
    expect(issues.some((i) => i.path.includes("obligation_id"))).toBe(true);
  });

  it("test_spec entry with empty assertions array produces an issue", () => {
    const payload = {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [{ obligation_id: "O-1", name: "test", kind: "unit", assertions: [] }],
      created_at: new Date().toISOString(),
    };
    const issues = validateTestValidatorPlan(payload);
    expect(issues.some((i) => i.path.includes("assertions"))).toBe(true);
  });

  it("test_spec entry with unknown kind produces an issue", () => {
    const payload = {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [{ obligation_id: "O-1", name: "test", kind: "badkind", assertions: ["assert"] }],
      created_at: new Date().toISOString(),
    };
    const issues = validateTestValidatorPlan(payload);
    expect(issues.some((i) => i.path.includes("kind"))).toBe(true);
  });

  it("inapplicable_claim without reason produces an issue", () => {
    const payload = {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [{
        obligation_id: "O-1",
        name: "test",
        kind: "unit",
        assertions: ["assert"],
        inapplicable_claim: { obligation_id: "O-1" },
      }],
      created_at: new Date().toISOString(),
    };
    const issues = validateTestValidatorPlan(payload);
    expect(issues.some((i) => i.path.includes("reason"))).toBe(true);
  });

  it("inapplicable_claim without obligation_id produces an issue", () => {
    const payload = {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [{
        obligation_id: "O-1",
        name: "test",
        kind: "unit",
        assertions: ["assert"],
        inapplicable_claim: { reason: "some reason" },
      }],
      created_at: new Date().toISOString(),
    };
    const issues = validateTestValidatorPlan(payload);
    expect(issues.some((i) => i.path.includes("obligation_id"))).toBe(true);
  });
});

describe("CONTRACT_PIPELINE_VALIDATORS registry — test_validator_plan", () => {
  it("CONTRACT_PIPELINE_VALIDATORS test_validator_plan is a function", () => {
    expect(typeof CONTRACT_PIPELINE_VALIDATORS["test_validator_plan"]).toBe("function");
  });

  it("calling CONTRACT_PIPELINE_VALIDATORS test_validator_plan with a valid payload returns no errors", () => {
    const payload = {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [{ obligation_id: "O-1", name: "test", kind: "integration", assertions: ["passes integration check"] }],
      created_at: new Date().toISOString(),
    };
    const issues = CONTRACT_PIPELINE_VALIDATORS["test_validator_plan"](payload, "test_validator_plan");
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });
});

describe("N-R09: nextMissingContractPhase returns test_validator_plan when obligation_ledger exists but test_validator_plan does not", () => {
  it("returns test_validator_plan when goal_spec through cyclic_seam_resolution all exist but test_validator_plan absent", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", CHAIN_PAYLOADS.goal_spec);
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", CHAIN_PAYLOADS.context_bundle);
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", CHAIN_PAYLOADS.module_decomposition);
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", CHAIN_PAYLOADS.module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", CHAIN_PAYLOADS.seam_reconciliation_report);
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", CHAIN_PAYLOADS.finalized_module_contracts);
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", CHAIN_PAYLOADS.conceptual_design_critique);
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", CHAIN_PAYLOADS.obligation_ledger);
    await writeContractArtifact(ARTIFACTS_DIR, "cyclic_seam_resolution", CHAIN_PAYLOADS.cyclic_seam_resolution);
    // test_validator_plan NOT written
    const phase = nextMissingContractPhase(ARTIFACTS_DIR);
    expect(phase).toBe("test_validator_plan");
  });
});

describe("N-R12: promoteImplementationDagToExtractedPlan — derives lens and severity from obligation kinds", () => {
  async function writeMinimalDagWithObligations(
    nodes: Array<{
      id: string;
      title: string;
      description: string;
      satisfies_obligations?: string[];
      depends_on?: string[];
    }>,
    obligations: Array<{
      id: string;
      description: string;
      kind: string;
      depends_on: string[];
      status: string;
    }>,
  ): Promise<void> {
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations,
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: nodes.map((n) => ({
        ...n,
        satisfies_obligations: n.satisfies_obligations ?? [],
        depends_on: n.depends_on ?? [],
        verification_obligation_ids: [],
        targeted_commands: [],
        status: "pending",
      })),
      edges: [],
      created_at: CREATED_AT,
    });
  }

  it("invariant obligation → lens=security, severity=high", async () => {
    await writeMinimalDagWithObligations(
      [{ id: "N1", title: "N1", description: "d", satisfies_obligations: ["OBL-1"] }],
      [{ id: "OBL-1", description: "invariant", kind: "invariant", depends_on: [], status: "pending" }],
    );
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(plan.findings[0].lens).toBe("security");
    expect(plan.findings[0].severity).toBe("high");
  });

  it("behavioral obligation → lens=correctness, severity=medium", async () => {
    await writeMinimalDagWithObligations(
      [{ id: "N2", title: "N2", description: "d", satisfies_obligations: ["OBL-2"] }],
      [{ id: "OBL-2", description: "behavioral", kind: "behavioral", depends_on: [], status: "pending" }],
    );
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(plan.findings[0].lens).toBe("correctness");
    expect(plan.findings[0].severity).toBe("medium");
  });

  it("structural obligation → lens=architecture, severity=low", async () => {
    await writeMinimalDagWithObligations(
      [{ id: "N3", title: "N3", description: "d", satisfies_obligations: ["OBL-3"] }],
      [{ id: "OBL-3", description: "structural", kind: "structural", depends_on: [], status: "pending" }],
    );
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(plan.findings[0].lens).toBe("architecture");
    expect(plan.findings[0].severity).toBe("low");
  });

  it("test obligation → lens=tests, severity=low", async () => {
    await writeMinimalDagWithObligations(
      [{ id: "N4", title: "N4", description: "d", satisfies_obligations: ["OBL-4"] }],
      [{ id: "OBL-4", description: "test", kind: "test", depends_on: [], status: "pending" }],
    );
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(plan.findings[0].lens).toBe("tests");
    expect(plan.findings[0].severity).toBe("low");
  });

  it("mixed invariant+behavioral → highest-priority wins: lens=security, severity=high", async () => {
    await writeMinimalDagWithObligations(
      [{ id: "N5", title: "N5", description: "d", satisfies_obligations: ["OBL-INV", "OBL-BEH"] }],
      [
        { id: "OBL-INV", description: "invariant", kind: "invariant", depends_on: [], status: "pending" },
        { id: "OBL-BEH", description: "behavioral", kind: "behavioral", depends_on: [], status: "pending" },
      ],
    );
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(plan.findings[0].lens).toBe("security");
    expect(plan.findings[0].severity).toBe("high");
  });

  it("no satisfies_obligations and no obligation_ledger → falls back to lens=correctness, severity=medium", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [{
        id: "N6", title: "N6", description: "d",
        satisfies_obligations: [], depends_on: [],
        verification_obligation_ids: [], targeted_commands: [], status: "pending",
      }],
      edges: [],
      created_at: CREATED_AT,
    });
    // No obligation_ledger written
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(plan.findings[0].lens).toBe("correctness");
    expect(plan.findings[0].severity).toBe("medium");
  });
});

describe("N-R12: promoteImplementationDagToExtractedPlan — propagates files_likely_touched to affected_files", () => {
  it("node with files_likely_touched produces those as affected_files", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [{
        id: "N1", title: "N1", description: "d",
        satisfies_obligations: [], depends_on: [],
        verification_obligation_ids: [], targeted_commands: [], status: "pending",
        files_likely_touched: ["src/foo.ts", "src/bar.ts"],
      }],
      edges: [],
      created_at: CREATED_AT,
    });
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(plan.findings[0].affected_files).toEqual([{ path: "src/foo.ts" }, { path: "src/bar.ts" }]);
  });

  it("node without files_likely_touched produces affected_files=[]", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [{
        id: "N2", title: "N2", description: "d",
        satisfies_obligations: [], depends_on: [],
        verification_obligation_ids: [], targeted_commands: [], status: "pending",
      }],
      edges: [],
      created_at: CREATED_AT,
    });
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(plan.findings[0].affected_files).toEqual([]);
  });
});

describe("N-R12: promoteImplementationDagToExtractedPlan — propagates preconditions and expected_changes", () => {
  it("node with preconditions and expected_changes produces those in the finding", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [{
        id: "N1", title: "N1", description: "d",
        satisfies_obligations: [], depends_on: [],
        verification_obligation_ids: [], targeted_commands: [], status: "pending",
        preconditions: ["P1", "P2"],
        expected_changes: "Adds retry logic",
      }],
      edges: [],
      created_at: CREATED_AT,
    });
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(plan.findings[0].preconditions).toEqual(["P1", "P2"]);
    expect(plan.findings[0].expected_changes).toBe("Adds retry logic");
  });

  it("node without preconditions or expected_changes produces preconditions=[] and expected_changes=''", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [{
        id: "N2", title: "N2", description: "d",
        satisfies_obligations: [], depends_on: [],
        verification_obligation_ids: [], targeted_commands: [], status: "pending",
      }],
      edges: [],
      created_at: CREATED_AT,
    });
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(plan.findings[0].preconditions).toEqual([]);
    expect(plan.findings[0].expected_changes).toBe("");
  });
});

describe("N-R12: promoteImplementationDagToExtractedPlan — graceful fallback when obligation_ledger absent", () => {
  it("completes without throwing and uses lens=correctness, severity=medium when no obligation_ledger", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [{
        id: "N1", title: "N1", description: "d",
        satisfies_obligations: ["OBL-MISSING"], depends_on: [],
        verification_obligation_ids: [], targeted_commands: [], status: "pending",
      }],
      edges: [],
      created_at: CREATED_AT,
    });
    // No obligation_ledger written — must not throw
    await expect(promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR)).resolves.not.toThrow();
    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(plan.findings[0].lens).toBe("correctness");
    expect(plan.findings[0].severity).toBe("medium");
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

