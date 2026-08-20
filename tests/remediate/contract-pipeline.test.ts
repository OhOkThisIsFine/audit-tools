import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  shouldEnterContractPipeline,
  nextMissingContractPhase,
  promoteImplementationDagToExtractedPlan,
  buildNextContractPipelineStep,
  classifyObligationKind,
  consumeGateOutcomes,
  detectSeedSourceDigestMismatches,
  evaluateContractObligationsPromotionGate,
  evaluatePromotedPlanWriteScope,
  normalizeBlockTargetedCommands,
  normalizeBlockTouchedFiles,
  obligationKindVocabularyDivergence,
  readContractPipelinePlanningOutputs,
  writePathASeedFromFindings,
  CONTRACT_PIPELINE_GATE_ORDER,
  OBLIGATION_KIND_PRIORITY,
} from "../../src/remediate/steps/contractPipeline.js";
import { validateAuthoredCycleBreak } from "../../src/remediate/contractPipeline/cyclicSeamResolution.js";
import { TESTABLE_OBLIGATION_KINDS } from "../../src/remediate/validation/contractPipelineGates.js";
import {
  contractInputFilePath,
  contractArtifactFilePath,
  pathASeedFilePath,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  renderContractPipelinePrompt,
  CONTRACT_PIPELINE_PHASE_ORDER,
} from "../../src/remediate/steps/contractPipelinePrompts.js";
import { writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import { intakePaths } from "../../src/remediate/intake.js";
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
  buildAuditFindingsDeliverable,
  type Finding,
} from "audit-tools/shared";
import {
  validateTestValidatorPlan,
  validateDesignSpecGates,
  CONTRACT_PIPELINE_VALIDATORS,
  // MNT-7014a745: consume the single-sourced version constants rather than
  // re-declaring them here (a bump must not require editing the tests too).
  CP_MODULE_DECOMPOSITION_VERSION,
  CP_MODULE_CONTRACTS_VERSION,
  CP_SEAM_RECONCILIATION_REPORT_VERSION,
  CP_FINALIZED_MODULE_CONTRACTS_VERSION,
} from "../../src/remediate/validation/contractPipeline.js";
import { scratchDir } from "../helpers/scratch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-contract-pipeline");
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

  it("node with NO declared files but WITH module obligations inherits the module file_scope (root-cause fix: no scope-less nodes)", async () => {
    // A coarse "Remediate <module>" decomposition leaves output_files /
    // files_likely_touched empty on the DAG node; without the fallback that
    // promotes a scope-less, undispatchable finding (empty affected_files) that
    // silently dooms the run. The node's obligations are `OBL-<slug>-…`, so it
    // must inherit the file_scope of the module they belong to.
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", {
      contract_version: CHAIN_PAYLOADS.module_decomposition.contract_version,
      goal_id: "G1",
      modules: [
        { name: "mod-x", responsibilities: "X.", file_scope: ["src/x1.ts", "src/x2.ts"] },
        { name: "mod-y", responsibilities: "Y.", file_scope: ["src/y.ts"] },
      ],
    });
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [{
        id: "N-mod-x", title: "Remediate mod-x", description: "d",
        satisfies_obligations: ["OBL-mod-x-contract", "OBL-mod-x-inv-1"], depends_on: [],
        verification_obligation_ids: [], targeted_commands: [], status: "pending",
      }],
      edges: [],
      created_at: CREATED_AT,
    });
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(plan.findings[0].affected_files).toEqual([{ path: "src/x1.ts" }, { path: "src/x2.ts" }]);
    // The block's touched_files is derived the same way (file-ownership scheduler).
    expect(plan.blocks[0].touched_files).toEqual(["src/x1.ts", "src/x2.ts"]);
  });

  it("node with no declared files AND no obligations to inherit from produces affected_files=[]", async () => {
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

// ---------------------------------------------------------------------------
// Regression: COR-86b18f1b — Gate 3 must use exact id match, not includes(),
// to avoid substring false-positives (e.g. INV-1 ⊂ INV-10).
// ---------------------------------------------------------------------------
describe("validateDesignSpecGates Gate 3 — exact invariant id match", () => {
  it("reports uncovered when obligation id is a superset string (INV-10 does not cover INV-1)", () => {
    const designSpec = {
      invariants: [{ id: "INV-1", description: "Sessions stay valid." }],
    };
    const obligationLedger = {
      obligations: [
        { id: "INV-10", kind: "invariant", description: "Covers INV-10 only." },
      ],
    };

    const issues = validateDesignSpecGates(designSpec, obligationLedger);

    // INV-10's id is not an exact match for INV-1; the invariant must be flagged.
    const found = issues.some((i) => i.path.includes("INV-1") && !i.path.includes("INV-10"));
    expect(found).toBe(true);
  });

  it("does not report uncovered when obligation id exactly matches invariant id", () => {
    const designSpec = {
      invariants: [{ id: "INV-1", description: "Sessions stay valid." }],
    };
    const obligationLedger = {
      obligations: [
        { id: "INV-1", kind: "invariant", description: "Exactly covers INV-1." },
      ],
    };

    const issues = validateDesignSpecGates(designSpec, obligationLedger);

    const uncovered = issues.filter((i) => i.path.includes("invariants[INV-1]"));
    expect(uncovered).toHaveLength(0);
  });

  it("does not report uncovered when obligation description contains invariant id at word boundary", () => {
    const designSpec = {
      invariants: [{ id: "INV-1", description: "Sessions stay valid." }],
    };
    const obligationLedger = {
      obligations: [
        { id: "O-99", kind: "invariant", description: "This obligation covers INV-1 behavior." },
      ],
    };

    const issues = validateDesignSpecGates(designSpec, obligationLedger);

    const uncovered = issues.filter((i) => i.path.includes("invariants[INV-1]"));
    expect(uncovered).toHaveLength(0);
  });

  it("reports uncovered when description mentions INV-10 but not INV-1 at word boundary", () => {
    const designSpec = {
      invariants: [{ id: "INV-1", description: "Sessions stay valid." }],
    };
    const obligationLedger = {
      obligations: [
        { id: "O-99", kind: "invariant", description: "This obligation covers INV-10 only." },
      ],
    };

    const issues = validateDesignSpecGates(designSpec, obligationLedger);

    const uncovered = issues.filter((i) => i.path.includes("invariants[INV-1]"));
    expect(uncovered).toHaveLength(1);
  });
});

// MNT-86b18f1b: the per-validator envelope check (isRecord guard + contract_version
// match) is single-sourced through validateEnvelope. Assert the shared behavior is
// uniform across EVERY registered validator so the extraction can't silently drop a
// guard for one artifact.
describe("contract-pipeline validators — shared envelope guard (MNT-86b18f1b)", () => {
  const artifactNames = Object.keys(
    CONTRACT_PIPELINE_VALIDATORS,
  ) as (keyof typeof CONTRACT_PIPELINE_VALIDATORS)[];

  it("every validator rejects a non-record with a '<path> must be an object' issue and returns early", () => {
    for (const name of artifactNames) {
      const validate = CONTRACT_PIPELINE_VALIDATORS[name];
      for (const nonRecord of [null, undefined, 42, "str", []]) {
        const issues = validate(nonRecord, name);
        // Exactly the envelope object-guard issue (one), nothing from the body.
        expect(
          issues,
          `${name} must reject ${JSON.stringify(nonRecord)} with a single object-guard issue`,
        ).toHaveLength(1);
        expect(issues[0]).toMatchObject({
          path: name,
          message: `${name} must be an object.`,
        });
      }
    }
  });

  it("every validator flags a contract_version mismatch on an otherwise-empty object", () => {
    for (const name of artifactNames) {
      const validate = CONTRACT_PIPELINE_VALIDATORS[name];
      const issues = validate({ contract_version: "WRONG/v0" }, name);
      expect(
        issues.some((issue) => issue.path === `${name}.contract_version`),
        `${name} must flag a contract_version mismatch`,
      ).toBe(true);
    }
  });
});


// ---------------------------------------------------------------------------
// CP-NODE-13 — contract-pipeline-orchestration.
//
// The gate chain is decomposed onto the ONE shared step-emission scaffold, the
// cyclic-seam re-check validates the break the worker actually authored, a
// failed stale-archive aborts instead of proceeding on stale content, the
// obligation-kind vocabulary is single-sourced with the gate module's, gate
// call sites branch on `evaluated`, the block write scope is normalized, the
// seed binds its sources by digest, and the planning outputs are pinned.
// ---------------------------------------------------------------------------

describe("CP-NODE-13 inv-8: the numbered gates run on the ONE shared scaffold", () => {
  const REPO_ROOT = join(__dirname, "..", "..");
  const PIPELINE_SOURCE = join(
    REPO_ROOT,
    "src",
    "remediate",
    "steps",
    "contractPipeline.ts",
  );

  /**
   * The same NAME-FAMILY + SHAPE detector the shared scaffold's own contract
   * test uses, applied here so this module's adoption is checkable in its own
   * home: a module that exports a `…EmissionScaffold` factory, or a
   * `create…Scaffold` carrying a handler table plus a write+log emission member,
   * IS a step-emission scaffold whatever it calls itself.
   */
  function definesAScaffold(source: string): boolean {
    if (/export\s+(?:async\s+)?function\s+\w*EmissionScaffold\w*\b/.test(source)) {
      return true;
    }
    return (
      /export\s+function\s+create\w*Scaffold\b/.test(source) &&
      /\btable\s*[:?]/.test(source) &&
      /\bwrite\s*[:(]/.test(source) &&
      /\blog\s*[:(]/.test(source)
    );
  }

  it("POSITIVE: contractPipeline.ts IMPORTS the shared scaffold and defines none of its own", async () => {
    const source = await readFile(PIPELINE_SOURCE, "utf8");
    expect(source).toMatch(
      /import \{\s*createStepEmissionScaffold,[\s\S]*?\} from "\.\.\/\.\.\/shared\/steps\/stepEmissionScaffold\.js";/,
    );
    expect(
      definesAScaffold(source),
      "the pipeline must ADOPT the one shared scaffold, never fork a second one",
    ).toBe(false);
  });

  it("NEGATIVE: the same detector FLAGS a local emit scaffold (red-green by inversion)", () => {
    // Invert the fix in a copy of the source rather than on disk: introducing a
    // local scaffold factory with a table + write + log is exactly the second
    // emission site the single-scaffold contract refuses.
    const forked = `
      export function createGateEmissionScaffold(options: {
        table: Record<string, unknown>;
        write: (plan: unknown) => unknown;
        log: (step: unknown) => void;
      }) { return options; }
    `;
    expect(definesAScaffold(forked)).toBe(true);
  });
});

describe("CP-NODE-13 inv-4: named, ordered gate units — no label can collide or drift", () => {
  const PIPELINE_SOURCE = join(
    __dirname,
    "..",
    "..",
    "src",
    "remediate",
    "steps",
    "contractPipeline.ts",
  );

  it("POSITIVE: every gate label is unique and the walk order is the declared order", () => {
    expect(CONTRACT_PIPELINE_GATE_ORDER.length).toBeGreaterThan(10);
    expect(new Set(CONTRACT_PIPELINE_GATE_ORDER).size).toBe(
      CONTRACT_PIPELINE_GATE_ORDER.length,
    );
    // The frontier must be resolved after the archive pass and before every
    // phase-conditional gate — the ordering the decimal labels used to hide.
    const orderOf = (gate: string) => CONTRACT_PIPELINE_GATE_ORDER.indexOf(gate);
    expect(orderOf("stale_artifact_archived")).toBeGreaterThan(
      orderOf("ingested_artifact_invalid"),
    );
    expect(orderOf("phase_frontier_resolved")).toBeGreaterThan(
      orderOf("stale_artifact_archived"),
    );
    expect(orderOf("obligation_ledger_derived")).toBeGreaterThan(
      orderOf("phase_frontier_resolved"),
    );
    expect(orderOf("cyclic_seam_rechecked")).toBeGreaterThan(
      orderOf("cyclic_seam_resolved"),
    );
  });

  it("NEGATIVE: the decimal-insertion label scheme is gone from the source", async () => {
    const source = await readFile(PIPELINE_SOURCE, "utf8");
    // `// 2.55.` / `// 5a.` / `// 4c.` style gate labels — the decimal-insertion
    // scheme in which section 5 executed after 5a/5b and "5a" named two
    // unrelated blocks. A plain `// 1.` enumeration inside a doc comment is not
    // that scheme, so the suffix is required.
    const numberedGateLabels = source.match(/^\s*\/\/\s*\d+(?:\.\d+|[a-z])+\.\s/gm) ?? [];
    expect(numberedGateLabels).toEqual([]);
  });

  it("POSITIVE: the earliest applicable gate wins — an invalid ingestion beats a later cycle gate", async () => {
    await writeChainThrough("conceptual_design_critique");
    // A cyclic ledger (a LATER gate) plus a malformed input (an EARLIER gate).
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
      ...CHAIN_PAYLOADS.obligation_ledger,
      obligations: [
        { id: "OBL-A", description: "A", kind: "invariant", depends_on: ["OBL-B"], status: "pending" },
        { id: "OBL-B", description: "B", kind: "behavioral", depends_on: ["OBL-A"], status: "pending" },
      ],
    });
    await writeJson(contractInputFilePath(ARTIFACTS_DIR, "test_validator_plan"), {
      contract_version: "wrong-version",
    });

    const step = await buildNextContractPipelineStep({
      root: TEST_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "gate-order",
    });
    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toContain("Validation Errors From the Previous Attempt");
    expect(prompt).not.toContain("Cyclic Seam Resolution");
  });
});

describe("CP-NODE-13 inv-2: a failed stale archive ABORTS the step", () => {
  /** Make the obligation_ledger stale by rewriting its upstream. */
  async function seedStaleObligationLedger(): Promise<void> {
    await writeChainThrough("obligation_ledger");
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", {
      ...CHAIN_PAYLOADS.finalized_module_contracts,
      module_contracts: [
        {
          ...CHAIN_PAYLOADS.finalized_module_contracts.module_contracts[0],
          outputs: ["y", "z-changed"],
        },
      ],
    });
  }

  it("POSITIVE: archiving succeeds, so the pipeline proceeds past the stale artifact", async () => {
    await seedStaleObligationLedger();
    const step = await buildNextContractPipelineStep({
      root: TEST_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "stale-ok",
    });
    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).not.toContain("Could Not Be Archived");
  });

  it("NEGATIVE: a renameFn that throws makes the step refuse instead of deriving downstream", async () => {
    await seedStaleObligationLedger();
    const step = await buildNextContractPipelineStep({
      root: TEST_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "stale-fail",
      renameFn: async () => {
        throw new Error("history move refused");
      },
    });
    expect(step).not.toBeNull();
    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toMatch(/Could Not Be Archived/);
    // The stale artifact is still on disk — which is exactly why proceeding
    // would have derived the back half from content already declared invalid.
    expect(
      existsSync(contractArtifactFilePath(ARTIFACTS_DIR, "obligation_ledger")),
    ).toBe(true);
  });
});

describe("CP-NODE-13 inv-1: the cyclic-seam re-check validates the AUTHORED break", () => {
  const CYCLIC_NODES = [
    { id: "OBL-A", needs: ["OBL-B"] },
    { id: "OBL-B", needs: ["OBL-A"] },
  ];
  const BROKEN_NODES = [
    { id: "OBL-A", needs: ["OBL-M"] },
    { id: "OBL-B", needs: ["OBL-M"] },
    { id: "OBL-M", needs: [] },
  ];

  it("NEGATIVE: a 'resolved' claim over an UNCHANGED ledger is refused", () => {
    // HEAD fabricated `{ id: "_mediator_OBL-A_OBL-B", needs: [] }` and asked
    // whether redirecting the cycle at that edge-free sink was acyclic — yes by
    // construction, so this exact case was ACCEPTED.
    const result = validateAuthoredCycleBreak({ members: ["OBL-A", "OBL-B"] }, CYCLIC_NODES, {
      strategy: "single_authority",
      designatedId: "OBL-A",
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/still present in the obligation ledger/);
  });

  it("NEGATIVE: a break that designates nothing, or names an obligation off the ledger, is refused", () => {
    expect(
      validateAuthoredCycleBreak({ members: ["OBL-A", "OBL-B"] }, BROKEN_NODES, {
        strategy: "mediator",
      }).reason,
    ).toMatch(/names no obligation/);
    expect(
      validateAuthoredCycleBreak({ members: ["OBL-A", "OBL-B"] }, BROKEN_NODES, {
        strategy: "mediator",
        designatedId: "OBL-GHOST",
      }).reason,
    ).toMatch(/not an obligation in the ledger/);
  });

  it("NEGATIVE: a mediator that is itself in the cycle, or an authority that is not, is refused", () => {
    expect(
      validateAuthoredCycleBreak({ members: ["OBL-A", "OBL-B"] }, BROKEN_NODES, {
        strategy: "mediator",
        designatedId: "OBL-A",
      }).reason,
    ).toMatch(/itself a member of cycle/);
    expect(
      validateAuthoredCycleBreak({ members: ["OBL-A", "OBL-B"] }, BROKEN_NODES, {
        strategy: "single_authority",
        designatedId: "OBL-M",
      }).reason,
    ).toMatch(/not a member of cycle/);
  });

  it("NEGATIVE: a mediator whose REAL needs point back into the cycle is refused", () => {
    // The check the fabricated `needs: []` node could never fail.
    const result = validateAuthoredCycleBreak(
      { members: ["OBL-A", "OBL-B"] },
      [
        { id: "OBL-A", needs: ["OBL-M"] },
        { id: "OBL-B", needs: ["OBL-M"] },
        { id: "OBL-M", needs: ["OBL-A"] },
      ],
      { strategy: "mediator", designatedId: "OBL-M" },
    );
    expect(result.accepted).toBe(false);
  });

  it("NEGATIVE: an UNRELATED obligation cannot serve as the mediator (F4)", () => {
    // OBL-Z exists and is not in the cycle, and the graph is acyclic — but no
    // cycle member depends on it, so it mediates nothing.
    const result = validateAuthoredCycleBreak(
      { members: ["OBL-A", "OBL-B"] },
      [...BROKEN_NODES, { id: "OBL-Z", needs: [] }],
      { strategy: "mediator", designatedId: "OBL-Z" },
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/no member of cycle .* depends on/);
  });

  it("NEGATIVE: a single_authority break over a still-cyclic graph is refused (F5)", () => {
    // The named cycle IS broken, but the break left a cycle elsewhere. The
    // single_authority path used to reach the accept with no whole-graph check.
    const result = validateAuthoredCycleBreak(
      { members: ["OBL-A", "OBL-B"] },
      [
        { id: "OBL-A", needs: ["OBL-B"] },
        { id: "OBL-B", needs: [] },
        { id: "OBL-P", needs: ["OBL-Q"] },
        { id: "OBL-Q", needs: ["OBL-P"] },
      ],
      { strategy: "single_authority", designatedId: "OBL-A" },
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/cyclic elsewhere/);
  });

  it("POSITIVE: a single_authority break over a genuinely acyclic graph is accepted", () => {
    expect(
      validateAuthoredCycleBreak(
        { members: ["OBL-A", "OBL-B"] },
        [
          { id: "OBL-A", needs: ["OBL-B"] },
          { id: "OBL-B", needs: [] },
        ],
        { strategy: "single_authority", designatedId: "OBL-A" },
      ).accepted,
    ).toBe(true);
  });

  it("POSITIVE: a mediator break actually reflected in the ledger is accepted", () => {
    expect(
      validateAuthoredCycleBreak({ members: ["OBL-A", "OBL-B"] }, BROKEN_NODES, {
        strategy: "mediator",
        designatedId: "OBL-M",
      }).accepted,
    ).toBe(true);
  });

  it("NEGATIVE end-to-end: the pipeline does NOT advance past a vacuous 'resolved' record", async () => {
    await writeChainThrough("conceptual_design_critique");
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
      ...CHAIN_PAYLOADS.obligation_ledger,
      obligations: [
        { id: "OBL-A", description: "A", kind: "invariant", depends_on: ["OBL-B"], status: "pending" },
        { id: "OBL-B", description: "B", kind: "behavioral", depends_on: ["OBL-A"], status: "pending" },
      ],
    });
    await writeContractArtifact(ARTIFACTS_DIR, "cyclic_seam_resolution", {
      contract_version: "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
      goal_id: "G1",
      status: "resolved",
      cycles: [
        {
          members: ["OBL-A", "OBL-B"],
          break_strategy: "single_authority",
          designated_obligation_id: "OBL-A",
          resolution_description: "A owns the interface.",
        },
      ],
      created_at: CREATED_AT,
    });

    const step = await buildNextContractPipelineStep({
      root: TEST_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "recheck-vacuous",
    });
    const prompt = await readFile(step!.prompt_path, "utf8");
    // The claim was rejected, the record archived, and the resolution phase
    // re-emitted — never advanced to test_validator_plan.
    expect(prompt).toContain("Cyclic Seam Resolution");
    expect(prompt).not.toContain("Test and Validator Plan");
    expect(prompt).toContain("Why the Previous Attempt Was Rejected");
  });

  it("POSITIVE end-to-end: a ledger the worker genuinely rewrote advances past the gate", async () => {
    await writeChainThrough("conceptual_design_critique");
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
      ...CHAIN_PAYLOADS.obligation_ledger,
      obligations: [
        { id: "OBL-A", description: "A", kind: "invariant", depends_on: ["OBL-M"], status: "pending" },
        { id: "OBL-B", description: "B", kind: "behavioral", depends_on: ["OBL-M"], status: "pending" },
        { id: "OBL-M", description: "M", kind: "structural", depends_on: [], status: "pending" },
      ],
    });
    await writeContractArtifact(ARTIFACTS_DIR, "cyclic_seam_resolution", {
      contract_version: "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
      goal_id: "G1",
      status: "resolved",
      cycles: [
        {
          members: ["OBL-A", "OBL-B"],
          break_strategy: "mediator",
          designated_obligation_id: "OBL-M",
          resolution_description: "M owns the shared primitive.",
        },
      ],
      created_at: CREATED_AT,
    });

    const step = await buildNextContractPipelineStep({
      root: TEST_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "recheck-real",
    });
    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toContain("Test and Validator Plan");
  });
});

describe("CP-NODE-13 F1: a rejected resolution that cannot be archived does not loop", () => {
  it("NEGATIVE: a failing renameFn blocks instead of re-deriving into an unbounded loop", async () => {
    await writeChainThrough("conceptual_design_critique");
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
      ...CHAIN_PAYLOADS.obligation_ledger,
      obligations: [
        { id: "OBL-A", description: "A", kind: "invariant", depends_on: ["OBL-B"], status: "pending" },
        { id: "OBL-B", description: "B", kind: "behavioral", depends_on: ["OBL-A"], status: "pending" },
      ],
    });
    await writeContractArtifact(ARTIFACTS_DIR, "cyclic_seam_resolution", {
      contract_version: "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
      goal_id: "G1",
      status: "resolved",
      cycles: [
        {
          members: ["OBL-A", "OBL-B"],
          break_strategy: "single_authority",
          designated_obligation_id: "OBL-A",
          resolution_description: "A owns the interface.",
        },
      ],
      created_at: CREATED_AT,
    });

    const step = await buildNextContractPipelineStep({
      root: TEST_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "recheck-archive-fail",
      renameFn: async () => {
        throw new Error("history move refused");
      },
    });
    expect(step?.status).toBe("blocked");
    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toContain("Could Not Be Archived");
    expect(prompt).toMatch(/loop without bound/);
    // The rejected record is still where it was — which is exactly why
    // re-deriving would have read it again.
    expect(
      existsSync(contractArtifactFilePath(ARTIFACTS_DIR, "cyclic_seam_resolution")),
    ).toBe(true);
  });
});

describe("CP-NODE-13 inv-3: ONE obligation-kind vocabulary", () => {
  it("POSITIVE: every kind the gate module calls testable is in this module's vocabulary", () => {
    expect(obligationKindVocabularyDivergence()).toEqual([]);
    for (const kind of TESTABLE_OBLIGATION_KINDS) {
      expect(OBLIGATION_KIND_PRIORITY).toContain(kind);
      expect(classifyObligationKind(kind)).toBe(kind);
    }
  });

  it("NEGATIVE: a kind added to the SHARED testable set alone turns the cross-check red", () => {
    // Red-green by inversion, at runtime: widen the gate module's set, confirm
    // the divergence check names the new kind, then invert the edit.
    TESTABLE_OBLIGATION_KINDS.add("operational");
    try {
      expect(obligationKindVocabularyDivergence()).toEqual(["operational"]);
    } finally {
      TESTABLE_OBLIGATION_KINDS.delete("operational");
    }
    expect(obligationKindVocabularyDivergence()).toEqual([]);
  });

  it("NEGATIVE: an unrecognized ledger kind never promotes a lens-less finding", async () => {
    // HEAD cast the raw string to the local union, scored it -1, and indexed
    // the lens map to `undefined`.
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
      ...CHAIN_PAYLOADS.obligation_ledger,
      obligations: [
        { id: "OBL-1", description: "d", kind: "operational", depends_on: [], status: "pending" },
      ],
    });
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      ...CHAIN_PAYLOADS.implementation_dag,
      nodes: [
        {
          id: "N1",
          title: "N1",
          description: "d",
          satisfies_obligations: ["OBL-1"],
          depends_on: [],
          verification_obligation_ids: [],
          targeted_commands: [],
          status: "pending",
        },
      ],
    });
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(
      await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"),
    );
    expect(plan.findings[0].lens).toBeDefined();
    // Unrecognized ⇒ routed through the SHARED testability predicate, which
    // fails open ⇒ behavioral.
    expect(plan.findings[0].lens).toBe("correctness");
  });
});

describe("CP-NODE-13 inv-5: gate call sites branch on `evaluated`", () => {
  const issue = (message: string) =>
    ({ path: "p", message, severity: "error" }) as const;

  it("NEGATIVE: a REQUIRED gate that did not run is a violation, not a clean pass", () => {
    const verdict = consumeGateOutcomes(
      [{ gate: "paired_obligations", evaluated: false, issues: [], reason: "payload absent" }],
      ["paired_obligations"],
      new Set(["paired_obligations"]),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.violations[0]).toMatch(/did not run \(payload absent\)/);
  });

  it("POSITIVE: an EVALUATED gate with zero issues is genuinely clean", () => {
    const verdict = consumeGateOutcomes(
      [{ gate: "paired_obligations", evaluated: true, issues: [] }],
      ["paired_obligations"],
      new Set(["paired_obligations"]),
    );
    expect(verdict).toEqual({ ok: true, violations: [] });
  });

  it("POSITIVE: a gate NOT required at this boundary may skip — the branch is taken, not skipped", () => {
    const verdict = consumeGateOutcomes(
      [{ gate: "digest_coverage", evaluated: false, issues: [], reason: "source not enumerable" }],
      ["digest_coverage"],
      new Set(),
    );
    expect(verdict.ok).toBe(true);
  });

  it("NEGATIVE: an evaluated gate's error issues still surface", () => {
    const verdict = consumeGateOutcomes(
      [{ gate: "evidence_threaded", evaluated: true, issues: [issue("evidence dropped")] }],
      ["evidence_threaded"],
      new Set(["evidence_threaded"]),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.violations[0]).toContain("evidence dropped");
  });

  it("NEGATIVE: the promotion gate re-reads payloads FRESH — a cached verdict would go stale", async () => {
    await writeChainThrough("implementation_dag");
    const before = await evaluateContractObligationsPromotionGate(ARTIFACTS_DIR, TEST_DIR);
    expect(before.violations.join("\n")).not.toMatch(/reconciliation_derivation/);
    // Break the seam report AFTER the first call. A call site holding a payload
    // (or a verdict) cached from before would still report this gate clean.
    await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", {
      ...CHAIN_PAYLOADS.seam_reconciliation_report,
      mismatches: "not-an-array",
    });
    const after = await evaluateContractObligationsPromotionGate(ARTIFACTS_DIR, TEST_DIR);
    expect(after.ok).toBe(false);
    expect(after.violations.join("\n")).toMatch(
      /\[reconciliation_derivation\] did not run/,
    );
  });
});

describe("CP-NODE-13 inv-6: block write scope + targeted commands are normalized", () => {
  const REPO_ROOT = join(__dirname, "..", "..");

  it("POSITIVE: already-clean paths pass through repo-relative, unique and sorted", () => {
    const scope = normalizeBlockTouchedFiles(
      REPO_ROOT,
      ["src/b.ts", "src/a.ts", "src/a.ts"],
      "B-1",
    );
    expect(scope.touched_files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(scope.refusals).toEqual([]);
  });

  it("POSITIVE: an ABSOLUTE in-repo path is NORMALIZED to its repo-relative form, case preserved", () => {
    expect(
      normalizeBlockTouchedFiles(REPO_ROOT, [join(REPO_ROOT, "src", "Shared", "X.ts")], "B-1")
        .touched_files,
    ).toEqual(["src/Shared/X.ts"]);
  });

  it("NEGATIVE: an escaping path is REFUSED as DATA — never as a throw out of the pipeline", () => {
    const escaping = normalizeBlockTouchedFiles(REPO_ROOT, ["../outside/evil.ts"], "B-1");
    expect(escaping.touched_files).toEqual([]);
    expect(escaping.refusals[0]).toMatch(/beneath the repository root/);
    expect(normalizeBlockTouchedFiles(REPO_ROOT, ["   "], "B-1").refusals[0]).toMatch(
      /empty touched_files entry/,
    );
  });

  it("NEGATIVE: a leading-slash 'repo-relative' path is refused with the drop-the-slash reason", () => {
    // The very common LLM form. It reads as POSIX-ABSOLUTE, so it resolves
    // outside the repo — and used to throw an unclassified stack that wedged
    // every subsequent next-step.
    const refusals = normalizeBlockTouchedFiles(REPO_ROOT, ["/src/a.ts"], "B-1").refusals;
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/drop the leading slash/);
  });

  it("POSITIVE: a bare package-script / test invocation is emitted verbatim", () => {
    const commands = normalizeBlockTargetedCommands(
      ["npm run check:tests", "npx vitest run tests/remediate/x.test.ts"],
      "B-1",
    );
    expect(commands.targeted_commands).toEqual([
      "npm run check:tests",
      "npx vitest run tests/remediate/x.test.ts",
    ]);
    expect(commands.refusals).toEqual([]);
  });

  it("NEGATIVE: a shell-chained or substituting command is REFUSED as data", () => {
    for (const command of [
      "npm run build && npm run check",
      "npm test; rm -rf /",
      "echo `whoami`",
      "npm test | tee out.log",
      "npm test > out.log",
    ]) {
      const result = normalizeBlockTargetedCommands([command], "B-1");
      expect(result.targeted_commands).toEqual([]);
      expect(result.refusals[0]).toMatch(/shell chaining, substitution or redirection/);
    }
  });

  it("NEGATIVE end-to-end: a leading-slash write scope produces a BOUNDED re-emit, not a throw", async () => {
    await writeChainThrough("implementation_dag");
    // The chain's one-assertion test plan fails the paired-obligation gate,
    // which archives the DAG before promotion is ever reached. Pair it so the
    // walk actually gets as far as the write-scope check under test.
    await writeContractArtifact(ARTIFACTS_DIR, "test_validator_plan", {
      ...CHAIN_PAYLOADS.test_validator_plan,
      test_specs: [
        {
          obligation_id: "O-1",
          name: "behavior holds test",
          kind: "unit",
          assertions: ["POSITIVE: O-1 returns the record on success", "NEGATIVE: O-1 rejects an invalid record"],
        },
      ],
    });
    // Re-write the downstream artifacts after that edit so their recorded
    // dependency hashes are current — otherwise the staleness pass archives
    // them and the walk stops at `assessment`, upstream of the gate under test.
    for (const name of [
      "contract_assessment_report",
      "counterexample",
      "judge_report",
    ] as const) {
      await writeContractArtifact(ARTIFACTS_DIR, name, CHAIN_PAYLOADS[name]);
    }
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      ...CHAIN_PAYLOADS.implementation_dag,
      nodes: [
        {
          ...CHAIN_PAYLOADS.implementation_dag.nodes[0],
          output_files: ["/src/a.ts"],
        },
      ],
    });
    const step = await buildNextContractPipelineStep({
      root: TEST_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "leading-slash",
    });
    expect(step).not.toBeNull();
    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toMatch(/Write-Scope and Command Errors|Block Write Scope Failed/);
    expect(prompt).toMatch(/drop the leading slash/);
    // No plan was promoted on the back of an unpromotable scope.
    expect(existsSync(intakePaths(ARTIFACTS_DIR).extractedPlan)).toBe(false);
  });

  it("NEGATIVE: a promoted block whose write scope names a fabricated directory is refused", async () => {
    await writeJson(intakePaths(ARTIFACTS_DIR).extractedPlan, {
      blocks: [
        { block_id: "CP-BLOCK-N1", touched_files: ["ghost-dir-xyz/ghost.ts"] },
        { block_id: "CP-BLOCK-N2", touched_files: ["src/remediate/steps/new-file.ts"] },
      ],
    });
    const gate = await evaluatePromotedPlanWriteScope(ARTIFACTS_DIR, REPO_ROOT);
    expect(gate).not.toBeNull();
    expect(gate!.violations).toHaveLength(1);
    expect(gate!.violations[0]).toContain("ghost-dir-xyz/ghost.ts");
  });

  it("POSITIVE: a NEW file under a real tracked directory is legal write scope", async () => {
    await writeJson(intakePaths(ARTIFACTS_DIR).extractedPlan, {
      blocks: [
        { block_id: "CP-BLOCK-N1", touched_files: ["src/remediate/steps/brand-new.ts"] },
      ],
    });
    expect(await evaluatePromotedPlanWriteScope(ARTIFACTS_DIR, REPO_ROOT)).toBeNull();
  });
});

describe("CP-NODE-13 inv-7: the path_a seed binds its sources by digest", () => {
  const REPORT = buildAuditFindingsDeliverable([
    {
      id: "F-1",
      title: "t",
      category: "General",
      severity: "medium",
      confidence: "high",
      lens: "correctness",
      summary: "s",
      affected_files: [{ path: "src/seeded.ts" }],
    } as Finding,
  ]);

  async function seedFrom(reportPath: string): Promise<void> {
    await writeJson(reportPath, REPORT);
    await writePathASeedFromFindings(ARTIFACTS_DIR, reportPath, REPORT);
  }

  it("POSITIVE: the seed records a sha256 per readable source, and an unchanged tree yields no mismatch", async () => {
    const reportPath = join(TEST_DIR, "audit-findings.json");
    await mkdir(join(TEST_DIR, "src"), { recursive: true });
    await writeFile(join(TEST_DIR, "src", "seeded.ts"), "export const a = 1;\n", "utf8");
    await seedFrom(reportPath);

    const seed = JSON.parse(
      await readFile(pathASeedFilePath(ARTIFACTS_DIR), "utf8"),
    );
    expect(seed.source_digests.map((d: { path: string }) => d.path)).toContain(
      "src/seeded.ts",
    );
    expect(await detectSeedSourceDigestMismatches(TEST_DIR, seed)).toEqual([]);
  });

  it("NEGATIVE: mutating a seeded source is detected, and the entry refuses with a blocked step", async () => {
    const reportPath = join(TEST_DIR, "audit-findings.json");
    await mkdir(join(TEST_DIR, "src"), { recursive: true });
    await writeFile(join(TEST_DIR, "src", "seeded.ts"), "export const a = 1;\n", "utf8");
    await seedFrom(reportPath);
    await writeFile(join(TEST_DIR, "src", "seeded.ts"), "export const a = 2;\n", "utf8");

    const seed = JSON.parse(
      await readFile(pathASeedFilePath(ARTIFACTS_DIR), "utf8"),
    );
    const mismatches = await detectSeedSourceDigestMismatches(TEST_DIR, seed);
    expect(mismatches.map((m) => m.path)).toEqual(["src/seeded.ts"]);

    const step = await buildNextContractPipelineStep({
      root: TEST_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "seed-digest",
    });
    expect(step?.status).toBe("blocked");
    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toContain("Source Content Changed Since the Audit Seed Was Built");
    expect(prompt).toContain("src/seeded.ts");
  });

  it("POSITIVE: a seed with no recorded digests binds nothing (back-compat)", async () => {
    expect(
      await detectSeedSourceDigestMismatches(TEST_DIR, {
        schema_version: "remediate-code-contract-pipeline/path-a-seed/v1alpha2",
        audit_findings_path: "x",
        finding_count: 0,
        findings_summary: [],
        affected_files: [],
        work_blocks: [],
        work_block_seams: [],
        created_at: CREATED_AT,
      }),
    ).toEqual([]);
  });
});

describe("CP-NODE-13 inv-9: the planning outputs are a PINNED shape", () => {
  async function promoteTwoBlocks(): Promise<void> {
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      ...CHAIN_PAYLOADS.implementation_dag,
      nodes: [
        {
          id: "N1",
          title: "one",
          description: "first",
          satisfies_obligations: [],
          depends_on: [],
          verification_obligation_ids: [],
          targeted_commands: ["npm run check"],
          status: "pending",
          files_likely_touched: ["src/one.ts"],
        },
        {
          id: "N2",
          title: "two",
          description: "second",
          satisfies_obligations: [],
          depends_on: ["N1"],
          verification_obligation_ids: [],
          targeted_commands: [],
          status: "pending",
          files_likely_touched: ["src/two.ts"],
        },
      ],
    });
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR, TEST_DIR);
  }

  it("POSITIVE: membership, coverage, estimates and digests are all exported together", async () => {
    await promoteTwoBlocks();
    const pinned = await readContractPipelinePlanningOutputs(ARTIFACTS_DIR);
    expect(pinned).not.toBeNull();
    expect(pinned!.block_membership.map((b) => b.block_id)).toEqual([
      "CP-BLOCK-N1",
      "CP-BLOCK-N2",
    ]);
    expect(pinned!.block_membership[0].items).toEqual(["N1"]);
    expect(pinned!.block_membership[0].touched_files).toEqual(["src/one.ts"]);
    expect(pinned!.block_membership[0].targeted_commands).toEqual(["npm run check"]);
    expect(pinned!.coverage).toEqual({
      finding_ids: ["N1", "N2"],
      exhaustive_once: true,
    });
    expect(pinned!.token_estimates.every((e) => e.estimated_tokens > 0)).toBe(true);
    expect(pinned!.seed_source_digests).toEqual([]);
  });

  it("NEGATIVE: moving one finding into another block's membership turns the pinned coverage red", async () => {
    await promoteTwoBlocks();
    const planPath = intakePaths(ARTIFACTS_DIR).extractedPlan;
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    // Invert the canonical membership: N2 is now claimed twice, N1 not at all.
    plan.blocks[0].items = ["N2"];
    await writeJson(planPath, plan);

    const pinned = await readContractPipelinePlanningOutputs(ARTIFACTS_DIR);
    expect(pinned!.coverage.exhaustive_once).toBe(false);
    expect(pinned!.block_membership[0].items).toEqual(["N2"]);
  });

  it("POSITIVE: no promoted plan yields null rather than a fabricated shape", async () => {
    expect(await readContractPipelinePlanningOutputs(ARTIFACTS_DIR)).toBeNull();
  });
});
