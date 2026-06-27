/**
 * N-R07: Multi-agent seam negotiation replaces the monolithic design pass.
 *
 * Tests:
 * - nextMissingContractPhase phase ordering through seam-negotiation phases
 * - ingestContractArtifacts validates module_decomposition, module_contracts,
 *   seam_reconciliation_report, and finalized_module_contracts shapes
 * - DEPENDENCY_MAP staleness propagates through new phases
 * - buildNextContractPipelineStep emits correct phases for each seam step
 * - evaluateJudgeGate infers finalized_module_contracts (not design_spec) when
 *   repair_directive is absent
 * - CP_ARTIFACT_NAMES ordering enforces dependency order
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNextContractPipelineStep,
  ingestContractArtifacts,
  nextMissingContractPhase,
} from "../../src/remediate/steps/contractPipeline.js";
import {
  CP_ARTIFACT_NAMES,
  detectStaleArtifacts,
  writeContractArtifact,
  readContractArtifact,
  contractInputFilePath,
  contractPipelineDir,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import type { ContractPipelineArtifactName } from "../../src/remediate/contractPipeline/artifactStore.js";
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
} from "audit-tools/shared";
import {
  CP_MODULE_DECOMPOSITION_VERSION,
  CP_MODULE_CONTRACTS_VERSION,
  CP_SEAM_RECONCILIATION_REPORT_VERSION,
  CP_FINALIZED_MODULE_CONTRACTS_VERSION,
  CP_CYCLIC_SEAM_RESOLUTION_VERSION,
} from "../../src/remediate/validation/contractPipeline.js";
import { readFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-n-r07");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");
const CREATED_AT = "2026-01-01T00:00:00.000Z";

const STEP_OPTIONS = { root: TEST_DIR, artifactsDir: ARTIFACTS_DIR, runId: "N-R07-TEST" };

async function writeRaw(name: ContractPipelineArtifactName, payload: unknown): Promise<void> {
  const path = contractInputFilePath(ARTIFACTS_DIR, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function makeGoalSpec() {
  return {
    contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
    goal_id: "G1",
    objective: "Improve.",
    non_goals: [],
    success_criteria: ["Improved."],
    source_type: "conversation",
    created_at: CREATED_AT,
  };
}

function makeContextBundle() {
  return {
    contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
    goal_id: "G1",
    entries: [],
    context_summary: "ctx",
    created_at: CREATED_AT,
  };
}

function makeModuleDecomposition() {
  return {
    contract_version: CP_MODULE_DECOMPOSITION_VERSION,
    goal_id: "G1",
    modules: [{ name: "mod-a", responsibilities: "Does A.", file_scope: ["src/a.ts"] }],
    created_at: CREATED_AT,
  };
}

function makeModuleContracts() {
  return {
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
  };
}

function makeSeamReconciliationReport(mismatches: unknown[] = []) {
  return {
    contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
    goal_id: "G1",
    mismatches,
    created_at: CREATED_AT,
  };
}

function makeFinalizedModuleContracts() {
  return {
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
  };
}

// Multi-module fixtures: the seam_reconciliation / contract_finalization HOST
// steps only exist when there is more than one module (a single-module
// decomposition collapses them — see degenerate-phase-collapse.test.ts). Tests
// that assert those steps get emitted must therefore use ≥2 modules.
function makeMultiModuleDecomposition() {
  return {
    contract_version: CP_MODULE_DECOMPOSITION_VERSION,
    goal_id: "G1",
    modules: [
      { name: "mod-a", responsibilities: "Does A.", file_scope: ["src/a.ts"] },
      { name: "mod-b", responsibilities: "Does B.", file_scope: ["src/b.ts"] },
    ],
    created_at: CREATED_AT,
  };
}

function makeMultiModuleContracts() {
  return {
    contract_version: CP_MODULE_CONTRACTS_VERSION,
    goal_id: "G1",
    module_contracts: ["mod-a", "mod-b"].map((name) => ({
      name,
      inputs: ["x"],
      outputs: ["y"],
      invariants: [],
      side_effects: [],
      validation_boundary: "validates x",
      failure_modes: [],
      neighbor_needs: [],
    })),
    created_at: CREATED_AT,
  };
}

// MNT-74af66b4: the explicit `writeSeamChain` helper below is the seam-chain
// authority used throughout; a parallel FULL_SEAM_CHAIN constant was dead (never
// referenced) and has been removed to avoid a reader reconciling two encodings.
async function writeSeamChain(): Promise<void> {
  await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
  await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
  await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());
  await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", makeModuleContracts());
  await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", makeSeamReconciliationReport());
  await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", makeFinalizedModuleContracts());
}

async function writeFullChainThroughJudge(): Promise<void> {
  await writeSeamChain();
  await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", {
    contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
    goal_id: "G1", items: [], verdict: "approved", created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
    contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
    goal_id: "G1",
    obligations: [{ id: "O-1", description: "Behavior holds.", kind: "behavioral", depends_on: [], status: "pending" }],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "cyclic_seam_resolution", {
    contract_version: CP_CYCLIC_SEAM_RESOLUTION_VERSION,
    goal_id: "G1",
    cycles: [],
    status: "no_cycles",
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "test_validator_plan", {
    contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
    goal_id: "G1",
    test_specs: [],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "contract_assessment_report", {
    contract_version: CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
    goal_id: "G1", findings: [], verdict: "passed", created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "counterexample", {
    contract_version: CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
    goal_id: "G1", counterexamples: [], created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "judge_report", {
    contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
    goal_id: "G1", verdict: "approved", classifications: [], created_at: CREATED_AT,
  });
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ── CP_ARTIFACT_NAMES ordering ────────────────────────────────────────────────

describe("CP_ARTIFACT_NAMES ordering enforces dependency order", () => {
  it("module_decomposition appears before module_contracts", () => {
    const names = Array.from(CP_ARTIFACT_NAMES);
    expect(names.indexOf("module_decomposition")).toBeLessThan(names.indexOf("module_contracts"));
  });

  it("seam_reconciliation_report appears after module_contracts and before finalized_module_contracts", () => {
    const names = Array.from(CP_ARTIFACT_NAMES);
    const seamIdx = names.indexOf("seam_reconciliation_report");
    expect(seamIdx).toBeGreaterThan(names.indexOf("module_contracts"));
    expect(seamIdx).toBeLessThan(names.indexOf("finalized_module_contracts"));
  });

  it("finalized_module_contracts appears before obligation_ledger", () => {
    const names = Array.from(CP_ARTIFACT_NAMES);
    expect(names.indexOf("finalized_module_contracts")).toBeLessThan(names.indexOf("obligation_ledger"));
  });

  it("design_spec is NOT in CP_ARTIFACT_NAMES (replaced by seam-negotiation phases)", () => {
    // @ts-expect-error — intentional check that design_spec is removed
    expect(CP_ARTIFACT_NAMES).not.toContain("design_spec");
  });
});

// ── nextMissingContractPhase returns seam phases in order ─────────────────────

describe("nextMissingContractPhase returns seam-negotiation phases in order", () => {
  it("returns decomposition after goal_spec and context_bundle exist", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("decomposition");
  });

  it("returns module_contract_drafting after decomposition exists", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("module_contract_drafting");
  });

  it("returns seam_reconciliation after module_contracts exists", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", makeModuleContracts());
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("seam_reconciliation");
  });

  it("returns contract_finalization after seam_reconciliation_report exists", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", makeModuleContracts());
    await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", makeSeamReconciliationReport());
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("contract_finalization");
  });

  it("returns obligation_ledger after all seam phases and critique exist", async () => {
    await writeSeamChain();
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", {
      contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
      goal_id: "G1", items: [], verdict: "approved", created_at: CREATED_AT,
    });
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("obligation_ledger");
  });
});

// ── ingestContractArtifacts validates seam artifact shapes ───────────────────

describe("ingestContractArtifacts validates module_decomposition shape", () => {
  it("a module_decomposition missing the modules array fails validation and is archived", async () => {
    await writeRaw("goal_spec", makeGoalSpec());
    await writeRaw("context_bundle", makeContextBundle());
    await writeRaw("module_decomposition", {
      contract_version: CP_MODULE_DECOMPOSITION_VERSION,
      goal_id: "G1",
      // modules array missing
      created_at: CREATED_AT,
    });

    const result = await ingestContractArtifacts(ARTIFACTS_DIR);
    expect(result.invalid.some((e) => e.name === "module_decomposition")).toBe(true);
  });

  it("a valid module_decomposition with name, responsibilities, and file_scope passes validation", async () => {
    await writeRaw("module_decomposition", makeModuleDecomposition());

    const result = await ingestContractArtifacts(ARTIFACTS_DIR);
    expect(result.ingested).toContain("module_decomposition");
  });

  it("an invalid module_decomposition causes the decomposition phase to be re-emitted with validation errors", async () => {
    await writeRaw("goal_spec", makeGoalSpec());
    await writeRaw("context_bundle", makeContextBundle());
    await writeRaw("module_decomposition", {
      contract_version: CP_MODULE_DECOMPOSITION_VERSION,
      goal_id: "G1",
      modules: [{ name: "" }], // missing responsibilities and file_scope
      created_at: CREATED_AT,
    });

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toMatch(/Module Decomposition/);
    expect(prompt).toMatch(/Validation Errors From the Previous Attempt/);
  });
});

describe("ingestContractArtifacts validates seam_reconciliation_report", () => {
  it("a seam_reconciliation_report with a mismatch entry missing a resolution fails validation", async () => {
    await writeRaw("seam_reconciliation_report", {
      contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
      goal_id: "G1",
      mismatches: [{
        seam_id: "S-001",
        module_a: "mod-a",
        module_b: "mod-b",
        description: "A declares string output; B expects number.",
        // resolution is missing
      }],
      created_at: CREATED_AT,
    });

    const result = await ingestContractArtifacts(ARTIFACTS_DIR);
    expect(result.invalid.some((e) => e.name === "seam_reconciliation_report")).toBe(true);
  });

  it("a seam_reconciliation_report with all mismatches resolved passes validation", async () => {
    await writeRaw("seam_reconciliation_report", makeSeamReconciliationReport([{
      seam_id: "S-001",
      module_a: "mod-a",
      module_b: "mod-b",
      description: "A declares string output; B expects number.",
      resolution: { decision: "A", agreed_interface: "Both use number." },
    }]));

    const result = await ingestContractArtifacts(ARTIFACTS_DIR);
    expect(result.ingested).toContain("seam_reconciliation_report");
  });
});

// ── DEPENDENCY_MAP staleness propagates through new phases ────────────────────

describe("DEPENDENCY_MAP staleness propagates through new phases", () => {
  it("changing goal_spec marks module_decomposition, module_contracts, seam_reconciliation_report, finalized_module_contracts, obligation_ledger, and implementation_dag all stale", async () => {
    await writeSeamChain();
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [],
      edges: [],
      created_at: CREATED_AT,
    });

    // Now rewrite goal_spec with different content.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", { ...makeGoalSpec(), objective: "Updated objective." });

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.stale).not.toContain("goal_spec");
    expect(result.stale).toContain("context_bundle");
    expect(result.stale).toContain("module_decomposition");
    expect(result.stale).toContain("module_contracts");
    expect(result.stale).toContain("seam_reconciliation_report");
    expect(result.stale).toContain("finalized_module_contracts");
    expect(result.stale).toContain("obligation_ledger");
    expect(result.stale).toContain("implementation_dag");
  });

  it("changing seam_reconciliation_report marks finalized_module_contracts and all downstream stale but not module_decomposition", async () => {
    await writeSeamChain();
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1", obligations: [], created_at: CREATED_AT,
    });

    // Rewrite seam_reconciliation_report with a LOAD-BEARING change (a new
    // mismatch entry). A timestamp-only change would NOT re-stale under
    // semantic-projection staleness (B3) — provenance stamps are stripped.
    await writeContractArtifact(
      ARTIFACTS_DIR,
      "seam_reconciliation_report",
      makeSeamReconciliationReport([{ id: "M1", note: "new mismatch" }]),
    );

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.stale).not.toContain("module_decomposition");
    expect(result.stale).not.toContain("module_contracts");
    expect(result.stale).toContain("finalized_module_contracts");
    expect(result.stale).toContain("obligation_ledger");
  });

  it("detectStaleArtifacts returns the full downstream set when a seam artifact is updated", async () => {
    await writeSeamChain();
    // Update module_decomposition with new content.
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", {
      ...makeModuleDecomposition(),
      modules: [
        { name: "mod-a", responsibilities: "Updated.", file_scope: ["src/a.ts"] },
        { name: "mod-b", responsibilities: "New module.", file_scope: ["src/b.ts"] },
      ],
    });

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    // module_contracts depends on module_decomposition → stale
    expect(result.stale).toContain("module_contracts");
    // seam_reconciliation_report depends on module_contracts → stale (transitively)
    expect(result.stale).toContain("seam_reconciliation_report");
    // finalized_module_contracts depends on seam_reconciliation_report → stale (transitively)
    expect(result.stale).toContain("finalized_module_contracts");
  });
});

// ── buildNextContractPipelineStep emits correct seam phases ──────────────────

describe("buildNextContractPipelineStep emits a step for each seam phase", () => {
  async function promptOf(step: { prompt_path: string }): Promise<string> {
    return readFile(step.prompt_path, "utf8");
  }

  it("emits decomposition step when goal_spec and context_bundle are present", async () => {
    await writeRaw("goal_spec", makeGoalSpec());
    await writeRaw("context_bundle", makeContextBundle());

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Module Decomposition/);
  });

  it("emits module_contract_drafting step when decomposition is complete", async () => {
    await writeRaw("goal_spec", makeGoalSpec());
    await writeRaw("context_bundle", makeContextBundle());
    await writeRaw("module_decomposition", makeModuleDecomposition());

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Per-Module Contract Drafting/);
  });

  it("emits seam_reconciliation step when multi-module module_contracts are present", async () => {
    // ≥2 modules: a real seam exists, so the host step is emitted (a single
    // module would collapse to an auto-written empty report instead).
    await writeRaw("goal_spec", makeGoalSpec());
    await writeRaw("context_bundle", makeContextBundle());
    await writeRaw("module_decomposition", makeMultiModuleDecomposition());
    await writeRaw("module_contracts", makeMultiModuleContracts());

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Seam Reconciliation/);
  });

  it("emits contract_finalization step when multi-module seam_reconciliation_report is present", async () => {
    await writeRaw("goal_spec", makeGoalSpec());
    await writeRaw("context_bundle", makeContextBundle());
    await writeRaw("module_decomposition", makeMultiModuleDecomposition());
    await writeRaw("module_contracts", makeMultiModuleContracts());
    await writeRaw("seam_reconciliation_report", makeSeamReconciliationReport());

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Per-Module Contract Finalization/);
  });

  it("emits implementation_planning step after all seam phases and pre-planning phases complete", async () => {
    await writeRaw("goal_spec", makeGoalSpec());
    await writeRaw("context_bundle", makeContextBundle());
    await writeRaw("module_decomposition", makeModuleDecomposition());
    await writeRaw("module_contracts", makeModuleContracts());
    await writeRaw("seam_reconciliation_report", makeSeamReconciliationReport());
    await writeRaw("finalized_module_contracts", makeFinalizedModuleContracts());
    await writeRaw("conceptual_design_critique", {
      contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
      goal_id: "G1", items: [], verdict: "approved", created_at: CREATED_AT,
    });
    await writeRaw("obligation_ledger", {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [{ id: "O-1", description: "Behavior holds.", kind: "behavioral", depends_on: [], status: "pending" }],
      created_at: CREATED_AT,
    });
    await writeRaw("cyclic_seam_resolution", {
      contract_version: CP_CYCLIC_SEAM_RESOLUTION_VERSION,
      goal_id: "G1",
      cycles: [],
      status: "no_cycles",
      created_at: CREATED_AT,
    });
    await writeRaw("test_validator_plan", {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [],
      created_at: CREATED_AT,
    });
    await writeRaw("contract_assessment_report", {
      contract_version: CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
      goal_id: "G1", findings: [], verdict: "passed", created_at: CREATED_AT,
    });
    await writeRaw("counterexample", {
      contract_version: CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
      goal_id: "G1", counterexamples: [], created_at: CREATED_AT,
    });
    await writeRaw("judge_report", {
      contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id: "G1", verdict: "approved", classifications: [], created_at: CREATED_AT,
    });

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Implementation Planning/);
  });
});

// ── evaluateJudgeGate infers finalized_module_contracts as repair target ──────

describe("evaluateJudgeGate infers repair target from failing classifications when repair_directive is absent", () => {
  async function promptOf(step: { prompt_path: string }): Promise<string> {
    return readFile(step.prompt_path, "utf8");
  }

  it("when judge report has verdict=needs_repair and no repair_directive, target defaults to finalized_module_contracts", async () => {
    // Write ALL artifacts as envelopes (in dependency order) so staleness
    // detection does not archive the judge_report. writeContractArtifact
    // captures each dependency hash at write time; mixing raw + envelope
    // writes causes the staleness check to see a mismatched hash.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", makeModuleContracts());
    await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", makeSeamReconciliationReport());
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", makeFinalizedModuleContracts());
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", {
      contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
      goal_id: "G1", items: [], verdict: "approved", created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [{ id: "O-1", description: "Hold.", kind: "behavioral", depends_on: [], status: "pending" }],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "cyclic_seam_resolution", {
      contract_version: CP_CYCLIC_SEAM_RESOLUTION_VERSION,
      goal_id: "G1",
      cycles: [],
      status: "no_cycles",
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "test_validator_plan", {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "contract_assessment_report", {
      contract_version: CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
      goal_id: "G1", findings: [], verdict: "passed", created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "counterexample", {
      contract_version: CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
      goal_id: "G1",
      counterexamples: [{
        id: "CE-1",
        claim: "Module A produces correct output.",
        reproduction_steps: ["Pass invalid input."],
        expected: "Error.",
        actual: "Incorrect output.",
        violated_obligation_ids: ["O-1"],
      }],
      created_at: CREATED_AT,
    });
    // Judge says needs_repair but provides NO repair_directive.
    // The inferRepairDirective path applies when the stored payload has no directive.
    await writeContractArtifact(ARTIFACTS_DIR, "judge_report", {
      contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id: "G1",
      verdict: "needs_repair",
      classifications: [{
        counterexample_id: "CE-1",
        classification: "accepted",
        rationale: "Real flaw.",
      }],
      // No repair_directive — test infers finalized_module_contracts
      created_at: CREATED_AT,
    });

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Contract Repair: finalized_module_contracts/);
    expect(prompt).not.toMatch(/Contract Repair: design_spec/);
  });

  it("when verdict=approved, returns kind=proceed regardless of classifications", async () => {
    await writeFullChainThroughJudge();

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Implementation Planning/);
    expect(prompt).not.toMatch(/Contract Repair/);
  });
});
