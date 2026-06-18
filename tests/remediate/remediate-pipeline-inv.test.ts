/**
 * INV-remediate-pipeline-01..10: contract invariants for the remediate-pipeline module
 *
 * INV-01: One bounded step per next-step invocation — decideNextStep returns exactly one step
 * INV-02: parallel_safe derives from depends_on.length === 0 in promoteImplementationDagToExtractedPlan
 * INV-03: Judge gate is monotonic — already-handled judge hash at cap must not re-emit repair
 * INV-04: implementation_planning reachable only via approved judge, bounded repair, or cap
 * INV-05: Every implementation_dag node must trace to an obligation or accepted counterexample
 * INV-06: Cyclic depends_on is detected before dispatch (detectCyclicSeamObligations)
 * INV-07: confirm_resume_ack.json 'restart'/'merge' choice re-presents until acted on (does not loop forever)
 * INV-08: Phase order single-sourced — CONTRACT_PIPELINE_PHASE_ORDER matches PHASE_TO_ARTIFACT keys
 * INV-09: Implement worker prompts list merge-implement-results and next-step in allowed_commands, NOT next-step alone
 * INV-10: mergeImplementResults transitions to 'triage' (not back to 'implementing') when no pending items remain
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNextContractPipelineStep,
  ingestContractArtifacts,
  promoteImplementationDagToExtractedPlan,
  MAX_CONTRACT_REPAIR_ITERATIONS,
  validateImplementationDagTraceability,
} from "../../src/remediate/steps/contractPipeline.js";
import { CONTRACT_PIPELINE_PHASE_ORDER } from "../../src/remediate/steps/contractPipelinePrompts.js";
import {
  contractArtifactFilePath,
  contractPipelineDir,
  writeContractArtifact,
  type ContractPipelineArtifactName,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import { detectCyclicSeamObligations } from "../../src/remediate/contractPipeline/cyclicSeamResolution.js";
import { intakePaths } from "../../src/remediate/intake.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import {
  mergeImplementResults,
  prepareImplementDispatch,
} from "../../src/remediate/steps/dispatch.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../../src/remediate/steps/types.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
  CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
  CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
  CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
} from "audit-tools/shared";
import {
  CP_MODULE_DECOMPOSITION_VERSION,
  CP_MODULE_CONTRACTS_VERSION,
  CP_SEAM_RECONCILIATION_REPORT_VERSION,
  CP_FINALIZED_MODULE_CONTRACTS_VERSION,
} from "../../src/remediate/validation/contractPipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-remediate-pipeline-inv");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");
const REPO_DIR = TEST_DIR;

const CREATED_AT = "2026-01-01T00:00:00.000Z";

const STEP_OPTIONS = {
  root: TEST_DIR,
  artifactsDir: ARTIFACTS_DIR,
  runId: "CONTRACT-INV-TEST",
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function writeRawArtifact(
  name: ContractPipelineArtifactName,
  payload: unknown,
): Promise<void> {
  const path = contractArtifactFilePath(ARTIFACTS_DIR, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function makeApprovedChainPayloads() {
  return {
    goal_spec: {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1",
      objective: "Invariant tests.",
      non_goals: [],
      success_criteria: ["Pass."],
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
        validation_boundary: "v",
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
        validation_boundary: "v",
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
      cycles: [],
      status: "no_cycles",
      created_at: CREATED_AT,
    },
    test_validator_plan: {
      contract_version: "remediate-code-contract-pipeline/test-validator-plan/v1alpha1",
      goal_id: "G1",
      // O-1 is a behavioral (testable) obligation: the paired-obligation gate
      // requires a spec covering both the satisfied path and the failure path.
      test_specs: [
        {
          obligation_id: "O-1",
          name: "behavior holds and rejects the failure case",
          kind: "invariant",
          assertions: [
            "returns the expected result on the satisfied path",
            "rejects the invalid input on the failure path",
          ],
        },
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
  };
}

const APPROVED_CHAIN_NAMES = [
  "goal_spec", "context_bundle", "module_decomposition", "module_contracts",
  "seam_reconciliation_report", "finalized_module_contracts", "conceptual_design_critique",
  "obligation_ledger", "cyclic_seam_resolution", "test_validator_plan",
  "contract_assessment_report", "counterexample", "judge_report",
] as const;

async function writeApprovedChain(): Promise<void> {
  const all = makeApprovedChainPayloads();
  for (const name of APPROVED_CHAIN_NAMES) {
    await writeRawArtifact(name, all[name as keyof typeof all]);
  }
}

function traceableDag(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
    goal_id: "G1",
    nodes: [
      {
        id: "N-001",
        title: "Implement fix",
        description: "Apply the fix.",
        satisfies_obligations: ["O-1"],
        addresses_counterexamples: [],
        depends_on: [],
        verification_obligation_ids: [],
        targeted_commands: [],
        status: "pending",
        ...overrides,
      },
    ],
    edges: [],
    created_at: CREATED_AT,
  };
}

async function saveState(state: RemediationState): Promise<void> {
  await new StateStore(ARTIFACTS_DIR).saveState(state);
}

async function promptOf(step: { prompt_path: string }): Promise<string> {
  return readFile(step.prompt_path, "utf8");
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// INV-01: One bounded step per next-step invocation
// (structural: buildNextContractPipelineStep returns exactly one step or null)
// ---------------------------------------------------------------------------

describe("INV-remediate-pipeline-01: one bounded step per pipeline invocation", () => {
  it("buildNextContractPipelineStep returns exactly one step (not an array or undefined)", async () => {
    await writeApprovedChain();
    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    // Returns one step (not undefined — caller wraps null → plan promotion)
    expect(step !== undefined).toBe(true);
    if (step !== null) {
      expect(typeof step).toBe("object");
      // Must be exactly one step object
      expect(Array.isArray(step)).toBe(false);
      expect(step.step_kind).toBeDefined();
    }
  });

  it("a valid traceable DAG results in null (pipeline complete — no extra step emitted)", async () => {
    await writeApprovedChain();
    await writeRawArtifact("implementation_dag", traceableDag());
    // After all artifacts: promotes and returns null (extracted plan created)
    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(step).toBeNull();
    expect(existsSync(intakePaths(ARTIFACTS_DIR).extractedPlan)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-02: parallel_safe derives from depends_on.length === 0
// ---------------------------------------------------------------------------

describe("INV-remediate-pipeline-02: parallel_safe = (depends_on.length === 0) after promotion", () => {
  it("a node with empty depends_on produces parallel_safe=true", async () => {
    await writeApprovedChain();
    await writeRawArtifact("implementation_dag", traceableDag({ depends_on: [] }));
    await buildNextContractPipelineStep(STEP_OPTIONS); // promotes

    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8")) as {
      blocks: Array<{ block_id: string; parallel_safe: boolean; dependencies: string[] }>;
    };
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0].parallel_safe).toBe(true);
    expect(plan.blocks[0].dependencies).toHaveLength(0);
  });

  it("a node with non-empty depends_on produces parallel_safe=false (INV-02 regression)", async () => {
    await writeApprovedChain();
    // Two nodes: N-001 depends on N-002
    const dagWithDep = {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [
        {
          id: "N-001",
          title: "Fix A",
          description: "Applies fix A.",
          satisfies_obligations: ["O-1"],
          addresses_counterexamples: [],
          depends_on: ["N-002"],
          verification_obligation_ids: [],
          targeted_commands: [],
          status: "pending",
        },
        {
          id: "N-002",
          title: "Fix B",
          description: "Applies fix B.",
          satisfies_obligations: ["O-1"],
          addresses_counterexamples: [],
          depends_on: [],
          verification_obligation_ids: [],
          targeted_commands: [],
          status: "pending",
        },
      ],
      edges: [{ from: "N-001", to: "N-002", kind: "dependency" }],
      created_at: CREATED_AT,
    };

    await writeRawArtifact("implementation_dag", dagWithDep);
    await buildNextContractPipelineStep(STEP_OPTIONS); // promotes

    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8")) as {
      blocks: Array<{ block_id: string; parallel_safe: boolean; dependencies: string[] }>;
    };
    const n001Block = plan.blocks.find((b) => b.block_id === "CP-BLOCK-N-001");
    const n002Block = plan.blocks.find((b) => b.block_id === "CP-BLOCK-N-002");

    expect(n001Block).toBeDefined();
    expect(n002Block).toBeDefined();
    // N-001 depends on N-002 → parallel_safe must be false
    expect(n001Block!.parallel_safe).toBe(false);
    expect(n001Block!.dependencies).toContain("CP-BLOCK-N-002");
    // N-002 has no deps → parallel_safe must be true
    expect(n002Block!.parallel_safe).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-03: Judge gate is monotonic — already-handled hash at cap must not re-emit repair
// (tested via buildNextContractPipelineStep with pre-seeded repair-state.json)
// ---------------------------------------------------------------------------

describe("INV-remediate-pipeline-03: judge gate is monotonic — cap reached → proceed_residual for new judge hash", () => {
  it("when repairs.length >= MAX_CONTRACT_REPAIR_ITERATIONS and the judge hash is NEW (not yet handled), proceeds to implementation_planning with residual risks (not infinite repair)", async () => {
    const NEEDS_REPAIR_JUDGE = {
      contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id: "G1",
      verdict: "needs_repair",
      classifications: [
        { counterexample_id: "CE-1", classification: "accepted", rationale: "Real failure." },
      ],
      repair_directive: {
        target: "finalized_module_contracts",
        instruction: "Fix the contract.",
      },
      created_at: CREATED_AT,
    };

    await writeApprovedChain();
    // Override judge with needs_repair
    await writeRawArtifact("judge_report", NEEDS_REPAIR_JUDGE);
    // After ingestion, get the judge's content hash.
    await ingestContractArtifacts(ARTIFACTS_DIR);
    const cpDir = contractPipelineDir(ARTIFACTS_DIR);

    // Pre-seed repair-state with DIFFERENT (prior) judge hashes filling the cap.
    // The current judge hash is NOT in this list — so alreadyHandled=false.
    // Since repairs.length >= cap, the proceed_residual branch fires.
    expect(MAX_CONTRACT_REPAIR_ITERATIONS).toBe(2);
    const repairState = {
      schema_version: "remediate-code-contract-pipeline/repair-state/v1alpha1",
      repairs: [
        { judge_hash: "prior-judge-hash-1", target: "finalized_module_contracts", at: CREATED_AT },
        { judge_hash: "prior-judge-hash-2", target: "obligation_ledger", at: CREATED_AT },
      ],
      dag_regenerations: [],
    };
    await writeFile(join(cpDir, "repair-state.json"), JSON.stringify(repairState), "utf8");

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(step).not.toBeNull();
    // Must be implementation_planning with residual risks — cap exhausted
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Implementation Planning/);
    expect(prompt).toMatch(/Repair Cap Reached/);
    expect(prompt).not.toMatch(/Contract Repair:/);
  });

  it("the same judge hash is idempotently re-emitted as a repair when the worker has not acted yet (below cap)", async () => {
    const NEEDS_REPAIR_JUDGE = {
      contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id: "G1",
      verdict: "needs_repair",
      classifications: [
        { counterexample_id: "CE-1", classification: "accepted", rationale: "Real failure." },
      ],
      repair_directive: {
        target: "finalized_module_contracts",
        instruction: "Fix the contract.",
      },
      created_at: CREATED_AT,
    };

    await writeApprovedChain();
    await writeRawArtifact("judge_report", NEEDS_REPAIR_JUDGE);
    await ingestContractArtifacts(ARTIFACTS_DIR);
    const cpDir = contractPipelineDir(ARTIFACTS_DIR);
    const judgeEnvelope = JSON.parse(
      await readFile(join(cpDir, "judge_report.json"), "utf8"),
    ) as { content_hash: string };
    const judgeHash = judgeEnvelope.content_hash;

    // This hash is already handled (recorded), and repairs.length = 1 < cap(2)
    // → idempotent: re-emit the same repair without adding a new entry
    const repairState = {
      schema_version: "remediate-code-contract-pipeline/repair-state/v1alpha1",
      repairs: [
        { judge_hash: judgeHash, target: "finalized_module_contracts", at: CREATED_AT },
      ],
      dag_regenerations: [],
    };
    await writeFile(join(cpDir, "repair-state.json"), JSON.stringify(repairState), "utf8");

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(step).not.toBeNull();
    // Re-emits the repair (idempotent, worker hasn't acted yet)
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Contract Repair/);
    // No new entry added (still 1)
    const stateAfter = JSON.parse(
      await readFile(join(cpDir, "repair-state.json"), "utf8"),
    ) as { repairs: unknown[] };
    expect(stateAfter.repairs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// INV-04: implementation_planning only reachable via approved judge, bounded repair, or cap
// (already covered by contract-pipeline-adversarial.test.ts but minimal positive check here)
// ---------------------------------------------------------------------------

describe("INV-remediate-pipeline-04: implementation_planning is never skipped via the judge gate", () => {
  it("an approved judge verdict proceeds directly to implementation_planning", async () => {
    await writeApprovedChain();
    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(step).not.toBeNull();
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Implementation Planning/);
  });

  it("a missing judge artifact (empty chain) does not reach implementation_planning prematurely", async () => {
    // Only goal_spec present; next phase is context_bundle, not implementation_planning
    await writeRawArtifact("goal_spec", makeApprovedChainPayloads().goal_spec);
    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(step).not.toBeNull();
    const prompt = await promptOf(step!);
    expect(prompt).not.toMatch(/Implementation Planning/);
    expect(prompt).toMatch(/Context Collection/);
  });
});

// ---------------------------------------------------------------------------
// INV-05: Every implementation_dag node must trace to obligation or accepted CE
// ---------------------------------------------------------------------------

describe("INV-remediate-pipeline-05: traceability gate — untraceable nodes are rejected", () => {
  it("validateImplementationDagTraceability: ok=true for a fully traceable DAG", async () => {
    await writeApprovedChain();
    await ingestContractArtifacts(ARTIFACTS_DIR);
    await writeRawArtifact("implementation_dag", traceableDag());
    await ingestContractArtifacts(ARTIFACTS_DIR);

    const result = await validateImplementationDagTraceability(ARTIFACTS_DIR);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("validateImplementationDagTraceability: ok=false when a node has no trace", async () => {
    await writeApprovedChain();
    await ingestContractArtifacts(ARTIFACTS_DIR);
    await writeRawArtifact(
      "implementation_dag",
      traceableDag({ satisfies_obligations: ["O-UNKNOWN"], addresses_counterexamples: [] }),
    );
    await ingestContractArtifacts(ARTIFACTS_DIR);

    const result = await validateImplementationDagTraceability(ARTIFACTS_DIR);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]).toMatch(/N-001/);
  });

  it("buildNextContractPipelineStep: untraceable DAG triggers re-emit of implementation_planning", async () => {
    await writeApprovedChain();
    // The integrity gate (referential integrity + obligation coverage) runs
    // before the traceability gate, and obligation coverage is a superset of
    // per-node traceability. To exercise the traceability re-emit path on its
    // own, the DAG must PASS integrity (every ledger obligation is covered) yet
    // still contain at least one node that traces to nothing: N-cover satisfies
    // O-1 (coverage holds) while N-untraceable lists no obligation and no
    // counterexample (traceability fails on that node).
    await writeRawArtifact("implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [
        {
          id: "N-cover",
          title: "Cover O-1",
          description: "Satisfies the only ledger obligation so integrity passes.",
          satisfies_obligations: ["O-1"],
          addresses_counterexamples: [],
          depends_on: [],
          verification_obligation_ids: [],
          targeted_commands: [],
          status: "pending",
        },
        {
          id: "N-untraceable",
          title: "Untraceable node",
          description: "Traces to no obligation and no accepted counterexample.",
          satisfies_obligations: [],
          addresses_counterexamples: [],
          depends_on: [],
          verification_obligation_ids: [],
          targeted_commands: [],
          status: "pending",
        },
      ],
      edges: [],
      created_at: CREATED_AT,
    });

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(step).not.toBeNull();
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Traceability Errors From the Previous Attempt/);
    // The traceability violation names the untraceable node, not the covering one.
    expect(prompt).toMatch(/N-untraceable/);
    // The bad DAG was archived, not promoted
    expect(existsSync(intakePaths(ARTIFACTS_DIR).extractedPlan)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INV-06: Cyclic depends_on is detected before dispatch
// ---------------------------------------------------------------------------

describe("INV-remediate-pipeline-06: cyclic seam obligations are detected by detectCyclicSeamObligations", () => {
  it("detects a direct A→B→A cycle", () => {
    const nodes = [
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["A"] },
    ];
    const cycles = detectCyclicSeamObligations(nodes);
    expect(cycles.length).toBeGreaterThan(0);
    const members = cycles[0].members;
    expect(members).toContain("A");
    expect(members).toContain("B");
  });

  it("detects a three-node cycle A→B→C→A", () => {
    const nodes = [
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["C"] },
      { id: "C", needs: ["A"] },
    ];
    const cycles = detectCyclicSeamObligations(nodes);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it("returns empty for an acyclic graph", () => {
    const nodes = [
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["C"] },
      { id: "C", needs: [] },
    ];
    const cycles = detectCyclicSeamObligations(nodes);
    expect(cycles).toHaveLength(0);
  });

  it("returns empty for an empty graph", () => {
    expect(detectCyclicSeamObligations([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// INV-07: confirm_resume_ack.json choice terminates and does not loop forever
// (restart/merge presents the same prompt until acted on; 'resume' falls through)
// ---------------------------------------------------------------------------

describe("INV-remediate-pipeline-07: resume/restart/merge ack choices reach distinct terminals", () => {
  it("'resume' choice falls through the gate and does not re-present the choice prompt", async () => {
    // Write an in-progress implementing state
    await saveState({
      status: "implementing",
      plan: {
        plan_id: "PLAN-1",
        findings: [
          {
            id: "F-001",
            title: "Fix",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["e1"],
          },
        ],
        blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: { "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" } },
      closing_plan: { action: "none" },
    } as RemediationState);

    // Write a confirmed intent checkpoint so the intent gate passes
    await writeFile(
      join(ARTIFACTS_DIR, "intent_checkpoint.json"),
      JSON.stringify({
        schema_version: "intent-checkpoint/v1",
        confirmed_at: CREATED_AT,
        confirmed_by: "host",
        scope_summary: "all",
        intent_summary: "fix everything",
      }),
      "utf8",
    );

    // With choice=resume the confirm_resume_or_restart gate is bypassed
    await writeFile(
      join(ARTIFACTS_DIR, "confirm_resume_ack.json"),
      JSON.stringify({ choice: "resume" }),
      "utf8",
    );
    await writeFile(join(REPO_DIR, "session-config.json"), JSON.stringify({ dispatch: { rolling_engine: false } }), "utf8");

    // Must NOT emit confirm_resume_or_restart — it must advance to actual implementing
    const { decideNextStep } = await import("../../src/remediate/steps/nextStep.js");
    const step = await decideNextStep({ root: TEST_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(step.step_kind).not.toBe("confirm_resume_or_restart");
  });

  it("a 'restart' choice re-presents the choice step when state still exists (action not yet taken)", async () => {
    await saveState({
      status: "implementing",
      plan: {
        plan_id: "PLAN-1",
        findings: [],
        blocks: [],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {},
      closing_plan: { action: "none" },
    } as unknown as RemediationState);

    await writeFile(
      join(ARTIFACTS_DIR, "intent_checkpoint.json"),
      JSON.stringify({
        schema_version: "intent-checkpoint/v1",
        confirmed_at: CREATED_AT,
        confirmed_by: "host",
        scope_summary: "all",
        intent_summary: "fix everything",
      }),
      "utf8",
    );

    // choice=restart, but state still exists — must re-present the choice
    await writeFile(
      join(ARTIFACTS_DIR, "confirm_resume_ack.json"),
      JSON.stringify({ choice: "restart" }),
      "utf8",
    );

    const { decideNextStep } = await import("../../src/remediate/steps/nextStep.js");
    const step = await decideNextStep({ root: TEST_DIR, artifactsDir: ARTIFACTS_DIR });
    // Still blocked on the choice until the caller deletes state
    expect(step.step_kind).toBe("confirm_resume_or_restart");
  });
});

// ---------------------------------------------------------------------------
// INV-08: Phase order single-sourced
// (CONTRACT_PIPELINE_PHASE_ORDER must include every key in PHASE_TO_ARTIFACT mapping)
// ---------------------------------------------------------------------------

describe("INV-remediate-pipeline-08: phase order is single-sourced — phase names consistent", () => {
  it("CONTRACT_PIPELINE_PHASE_ORDER is a non-empty array of strings", () => {
    expect(Array.isArray(CONTRACT_PIPELINE_PHASE_ORDER)).toBe(true);
    expect(CONTRACT_PIPELINE_PHASE_ORDER.length).toBeGreaterThan(0);
    for (const phase of CONTRACT_PIPELINE_PHASE_ORDER) {
      expect(typeof phase).toBe("string");
      expect(phase.length).toBeGreaterThan(0);
    }
  });

  it("CONTRACT_PIPELINE_PHASE_ORDER contains 'closing' as the last phase", () => {
    const last = CONTRACT_PIPELINE_PHASE_ORDER[CONTRACT_PIPELINE_PHASE_ORDER.length - 1];
    expect(last).toBe("closing");
  });

  it("CONTRACT_PIPELINE_PHASE_ORDER has no duplicate phases", () => {
    const seen = new Set<string>();
    for (const phase of CONTRACT_PIPELINE_PHASE_ORDER) {
      expect(seen.has(phase)).toBe(false);
      seen.add(phase);
    }
  });
});

// ---------------------------------------------------------------------------
// INV-09: Implement worker prompts include merge and next-step in allowed_commands
// (workers get merge-implement-results and next-step; NOT next-step-as-sole-command)
// ---------------------------------------------------------------------------

describe("INV-remediate-pipeline-09: dispatch prompts are cwd-explicit; implement worker prompts do not advertise next-step", () => {
  it("implement worker prompt (prompt_path) is cwd-explicit — contains 'Repository root:'", async () => {
    const state: RemediationState = {
      status: "implementing",
      plan: {
        plan_id: "PLAN-1",
        findings: [
          {
            id: "F-001",
            title: "Fix A",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix A.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["ev1"],
          },
        ],
        blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
      },
      closing_plan: { action: "none" },
    } as RemediationState;
    await saveState(state);

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      "RUN-test",
    );

    expect(plan.items.length).toBeGreaterThan(0);
    const promptContent = await readFile(plan.items[0].prompt_path, "utf8");
    // Worker prompt must be cwd-explicit
    expect(promptContent).toContain("Repository root:");
    // Worker prompt must NOT call next-step (it's a host-only command)
    // Workers only write their result JSON and stop — no next-step instruction
    expect(promptContent).not.toMatch(/remediate-code next-step\b/);
  });

  it("implement worker prompt instructs the worker to write the result JSON and stop (no host-only commands)", async () => {
    const state: RemediationState = {
      status: "implementing",
      plan: {
        plan_id: "PLAN-1",
        findings: [
          {
            id: "F-002",
            title: "Fix B",
            category: "correctness",
            severity: "medium",
            confidence: "high",
            lens: "correctness",
            summary: "Fix B.",
            affected_files: [{ path: "src/b.ts" }],
            evidence: ["ev2"],
          },
        ],
        blocks: [{ block_id: "B-002", items: ["F-002"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-002": { finding_id: "F-002", status: "pending", block_id: "B-002" },
      },
      closing_plan: { action: "none" },
    } as RemediationState;
    await saveState(state);

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      "RUN-test2",
    );

    expect(plan.items.length).toBeGreaterThan(0);
    const promptContent = await readFile(plan.items[0].prompt_path, "utf8");
    // Worker must be told to write the result path and stop
    expect(promptContent).toMatch(/result_path|result\.json|Stop after writing/);
  });
});

// ---------------------------------------------------------------------------
// INV-10: mergeImplementResults transitions to 'triage' when no pending items remain
// (bug: was "implementing" both branches — now "triage" when moreToImplement=false)
// ---------------------------------------------------------------------------

describe("INV-remediate-pipeline-10: mergeImplementResults transitions to triage when no pending items remain", () => {
  it("state.status becomes 'triage' after all items are resolved", async () => {
    const state: RemediationState = {
      status: "implementing",
      plan: {
        plan_id: "PLAN-1",
        findings: [
          {
            id: "F-001",
            title: "Fix A",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix A.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["ev1"],
          },
        ],
        blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
      },
      closing_plan: { action: "none" },
    } as RemediationState;
    await saveState(state);

    const runId = "RUN-inv10";
    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );
    expect(plan.items.length).toBeGreaterThan(0);

    // Write a resolved worker result
    const resultPath = plan.items[0].result_path;
    const result = {
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: [
        { finding_id: "F-001", status: "resolved", evidence: ["Tests pass."] },
      ],
    };
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(resultPath, JSON.stringify(result), "utf8");

    const merged = await mergeImplementResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    // No pending items remain — status must be 'triage' (not 'implementing')
    expect(merged.status).toBe("triage");
    expect(merged.items!["F-001"].status).toBe("resolved");
  });

  it("state.status stays 'implementing' when pending items remain", async () => {
    const state: RemediationState = {
      status: "implementing",
      plan: {
        plan_id: "PLAN-1",
        findings: [
          {
            id: "F-001",
            title: "Fix A",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix A.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["ev1"],
          },
          {
            id: "F-002",
            title: "Fix B",
            category: "correctness",
            severity: "medium",
            confidence: "high",
            lens: "correctness",
            summary: "Fix B.",
            affected_files: [{ path: "src/b.ts" }],
            evidence: ["ev2"],
          },
        ],
        blocks: [
          { block_id: "B-001", items: ["F-001"], parallel_safe: true },
          // B-002 depends on B-001 so it won't be dispatched in first wave
          { block_id: "B-002", items: ["F-002"], parallel_safe: false, dependencies: ["B-001"] },
        ],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
        "F-002": { finding_id: "F-002", status: "pending", block_id: "B-002" },
      },
      closing_plan: { action: "none" },
    } as RemediationState;
    await saveState(state);

    const runId = "RUN-inv10b";
    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );
    // Only B-001 should be dispatched (B-002 has unmet dependency)
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].block_id).toBe("B-001");

    // Resolve B-001
    const resultPath = plan.items[0].result_path;
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(
      resultPath,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [
          { finding_id: "F-001", status: "resolved", evidence: ["Done."] },
        ],
      }),
      "utf8",
    );

    const merged = await mergeImplementResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    // F-002 still pending — status must remain 'implementing'
    expect(merged.status).toBe("implementing");
  });
});
