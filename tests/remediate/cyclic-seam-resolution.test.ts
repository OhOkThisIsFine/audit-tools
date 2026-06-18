/**
 * Unit + integration tests for the cyclic-seam resolution gate.
 *
 * Covers:
 * - detectCyclicSeamObligations: acyclic, 2-node cycle, 3-node cycle
 * - validateCycleBreak: mediator that re-introduces a cycle vs. clean break
 * - validateCyclicSeamResolution: valid artifact, missing fields, invalid status
 * - buildNextContractPipelineStep integration:
 *   - emits cyclic_seam_resolution phase when obligation_ledger is present
 *   - proceeds to assessment after no_cycles artifact
 *   - emits blocked step after cap exhaustion
 * - detectStaleArtifacts: obligation_ledger change stales cyclic_seam_resolution
 *   and contract_assessment_report
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCyclicSeamObligations,
  validateCycleBreak,
} from "../../src/remediate/contractPipeline/cyclicSeamResolution.js";
import {
  validateCyclicSeamResolution,
} from "../../src/remediate/validation/contractPipeline.js";
import {
  writeContractArtifact,
  detectStaleArtifacts,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  buildNextContractPipelineStep,
  MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS,
  readCyclicSeamRepairState,
  writeCyclicSeamRepairState,
} from "../../src/remediate/steps/contractPipeline.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeArtifactsDir(root: string): string {
  return join(root, ".audit-tools");
}

// ── detectCyclicSeamObligations ───────────────────────────────────────────────

describe("detectCyclicSeamObligations", () => {
  it("returns [] for an empty graph", () => {
    expect(detectCyclicSeamObligations([])).toEqual([]);
  });

  it("returns [] for an acyclic graph", () => {
    const cycles = detectCyclicSeamObligations([
      { id: "A", needs: ["B"] },
      { id: "B", needs: [] },
    ]);
    expect(cycles).toEqual([]);
  });

  it("returns [] for a single node with no needs", () => {
    expect(detectCyclicSeamObligations([{ id: "A", needs: [] }])).toEqual([]);
  });

  it("detects a direct 2-node cycle", () => {
    const cycles = detectCyclicSeamObligations([
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["A"] },
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].members.sort()).toEqual(["A", "B"]);
  });

  it("detects a 3-node cycle", () => {
    const cycles = detectCyclicSeamObligations([
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["C"] },
      { id: "C", needs: ["A"] },
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].members.sort()).toEqual(["A", "B", "C"]);
  });

  it("ignores external needs references not in the graph", () => {
    const cycles = detectCyclicSeamObligations([
      { id: "A", needs: ["EXTERNAL"] },
    ]);
    expect(cycles).toEqual([]);
  });

  it("reports two independent cycles as two separate cycles", () => {
    const cycles = detectCyclicSeamObligations([
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["A"] },
      { id: "C", needs: ["D"] },
      { id: "D", needs: ["C"] },
    ]);
    expect(cycles).toHaveLength(2);
    const sorted = cycles.map((c) => c.members.sort()).sort();
    expect(sorted[0]).toEqual(["A", "B"]);
    expect(sorted[1]).toEqual(["C", "D"]);
  });
});

// ── validateCycleBreak ────────────────────────────────────────────────────────

describe("validateCycleBreak", () => {
  it("accepts a clean mediator that removes the cycle", () => {
    // A needs B, B needs A — mediator M with no needs breaks both
    const allNodes = [
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["A"] },
    ];
    const result = validateCycleBreak(
      { members: ["A", "B"] },
      allNodes,
      { id: "M", needs: [] },
    );
    expect(result.accepted).toBe(true);
  });

  it("rejects a mediator that re-introduces a cycle (M needs A, A needs M)", () => {
    // A needs B, B needs A. We propose M but M needs A, and after patching
    // A and B both need M. If M needs A, the patched graph A→M→A is a cycle.
    const allNodes = [
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["A"] },
    ];
    // Proposed mediator M needs A — so in the patched graph:
    // A needs M (was B, now M), B needs M (was A, now M), M needs A → cycle M→A→M
    const result = validateCycleBreak(
      { members: ["A", "B"] },
      allNodes,
      { id: "M", needs: ["A"] },
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("accepts a single-authority break (empty mediator as proxy)", () => {
    const allNodes = [
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["A"] },
    ];
    // Authority placeholder with no needs — modelling single-authority
    const result = validateCycleBreak(
      { members: ["A", "B"] },
      allNodes,
      { id: "_authority_AB", needs: [] },
    );
    expect(result.accepted).toBe(true);
  });

  it("handles 3-node cycle with a clean mediator", () => {
    const allNodes = [
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["C"] },
      { id: "C", needs: ["A"] },
    ];
    const result = validateCycleBreak(
      { members: ["A", "B", "C"] },
      allNodes,
      { id: "M", needs: [] },
    );
    expect(result.accepted).toBe(true);
  });
});

// ── validateCyclicSeamResolution ──────────────────────────────────────────────

const VALID_RESOLUTION = {
  contract_version:
    "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
  goal_id: "goal-123",
  cycles: [],
  status: "no_cycles",
  created_at: new Date().toISOString(),
};

describe("validateCyclicSeamResolution", () => {
  it("passes a valid no_cycles artifact", () => {
    expect(validateCyclicSeamResolution(VALID_RESOLUTION)).toEqual([]);
  });

  it("passes a valid resolved artifact with cycles", () => {
    const artifact = {
      ...VALID_RESOLUTION,
      cycles: [
        {
          members: ["A", "B"],
          break_strategy: "mediator",
          resolution_description: "Introduced M",
          exception_registration: null,
        },
      ],
      status: "resolved",
    };
    expect(validateCyclicSeamResolution(artifact)).toEqual([]);
  });

  it("returns errors for an empty object", () => {
    const issues = validateCyclicSeamResolution({});
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("cyclic_seam_resolution.contract_version");
    expect(paths).toContain("cyclic_seam_resolution.goal_id");
    expect(paths).toContain("cyclic_seam_resolution.cycles");
    expect(paths).toContain("cyclic_seam_resolution.status");
    expect(paths).toContain("cyclic_seam_resolution.created_at");
  });

  it("returns an error for an invalid status", () => {
    const artifact = { ...VALID_RESOLUTION, status: "bad_status" };
    const issues = validateCyclicSeamResolution(artifact);
    const statusIssue = issues.find(
      (i) => i.path === "cyclic_seam_resolution.status",
    );
    expect(statusIssue).toBeDefined();
  });

  it("returns an error for a non-array cycles field", () => {
    const artifact = { ...VALID_RESOLUTION, cycles: "not-an-array" };
    const issues = validateCyclicSeamResolution(artifact);
    expect(issues.some((i) => i.path === "cyclic_seam_resolution.cycles")).toBe(
      true,
    );
  });

  it("returns an error for a cycle entry with non-string-array members", () => {
    const artifact = {
      ...VALID_RESOLUTION,
      cycles: [{ members: [1, 2] }],
      status: "resolved",
    };
    const issues = validateCyclicSeamResolution(artifact);
    expect(
      issues.some((i) => i.path === "cyclic_seam_resolution.cycles[0].members"),
    ).toBe(true);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function promptOf(step: { prompt_path: string }): Promise<string> {
  return readFile(step.prompt_path, "utf8");
}

// ── Integration: buildNextContractPipelineStep ────────────────────────────────

describe("buildNextContractPipelineStep — cyclic_seam_resolution gate", () => {
  let tmpDir: string;
  let artifactsDir: string;

  const GOAL_SPEC = {
    contract_version: "remediate-code-contract-pipeline/goal-spec/v1alpha1",
    goal_id: "goal-test",
    objective: "Test goal",
    non_goals: [],
    success_criteria: ["works"],
    source_type: "conversation",
    created_at: new Date().toISOString(),
  };

  const CONTEXT_BUNDLE = {
    contract_version: "remediate-code-contract-pipeline/context-bundle/v1alpha1",
    goal_id: "goal-test",
    entries: [],
    context_summary: "Test context",
    created_at: new Date().toISOString(),
  };

  const MODULE_DECOMP = {
    contract_version:
      "remediate-code-contract-pipeline/module-decomposition/v1alpha1",
    goal_id: "goal-test",
    modules: [{ name: "A", responsibilities: "does A", file_scope: [] }],
    created_at: new Date().toISOString(),
  };

  const MODULE_CONTRACTS = {
    contract_version: "remediate-code-contract-pipeline/module-contracts/v1alpha1",
    goal_id: "goal-test",
    module_contracts: [
      {
        name: "A",
        inputs: ["x"],
        outputs: ["y"],
        invariants: ["inv"],
        side_effects: [],
        validation_boundary: "none",
        failure_modes: [],
      },
    ],
    created_at: new Date().toISOString(),
  };

  const SEAM_REPORT = {
    contract_version:
      "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1",
    goal_id: "goal-test",
    mismatches: [],
    created_at: new Date().toISOString(),
  };

  const FINALIZED_CONTRACTS = {
    contract_version:
      "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1",
    goal_id: "goal-test",
    module_contracts: [
      {
        name: "A",
        inputs: ["x"],
        outputs: ["y"],
        invariants: ["inv"],
        side_effects: [],
        validation_boundary: "none",
        failure_modes: [],
      },
    ],
    created_at: new Date().toISOString(),
  };

  const CONCEPTUAL_CRITIQUE = {
    contract_version:
      "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1",
    goal_id: "goal-test",
    items: [],
    verdict: "approved",
    created_at: new Date().toISOString(),
  };

  // Obligation ledger WITHOUT a cycle
  const OBLIGATION_LEDGER_NO_CYCLE = {
    contract_version:
      "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
    goal_id: "goal-test",
    obligations: [
      {
        id: "OBL-1",
        description: "Thing A",
        kind: "invariant",
        depends_on: [],
        status: "pending",
      },
      {
        id: "OBL-2",
        description: "Thing B",
        kind: "behavioral",
        depends_on: ["OBL-1"],
        status: "pending",
      },
    ],
    created_at: new Date().toISOString(),
  };

  // Obligation ledger WITH a cycle (OBL-A ↔ OBL-B)
  const OBLIGATION_LEDGER_WITH_CYCLE = {
    contract_version:
      "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
    goal_id: "goal-test",
    obligations: [
      {
        id: "OBL-A",
        description: "Thing A",
        kind: "invariant",
        depends_on: ["OBL-B"],
        status: "pending",
      },
      {
        id: "OBL-B",
        description: "Thing B",
        kind: "behavioral",
        depends_on: ["OBL-A"],
        status: "pending",
      },
    ],
    created_at: new Date().toISOString(),
  };

  async function writeUpToObligationLedger(ledger: unknown): Promise<void> {
    await writeContractArtifact(artifactsDir, "goal_spec", GOAL_SPEC);
    await writeContractArtifact(artifactsDir, "context_bundle", CONTEXT_BUNDLE);
    await writeContractArtifact(
      artifactsDir,
      "module_decomposition",
      MODULE_DECOMP,
    );
    await writeContractArtifact(
      artifactsDir,
      "module_contracts",
      MODULE_CONTRACTS,
    );
    await writeContractArtifact(
      artifactsDir,
      "seam_reconciliation_report",
      SEAM_REPORT,
    );
    await writeContractArtifact(
      artifactsDir,
      "finalized_module_contracts",
      FINALIZED_CONTRACTS,
    );
    await writeContractArtifact(
      artifactsDir,
      "conceptual_design_critique",
      CONCEPTUAL_CRITIQUE,
    );
    await writeContractArtifact(artifactsDir, "obligation_ledger", ledger);
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cyclic-seam-test-"));
    artifactsDir = makeArtifactsDir(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("emits cyclic_seam_resolution phase after obligation_ledger with a cycle is present", async () => {
    await writeUpToObligationLedger(OBLIGATION_LEDGER_WITH_CYCLE);

    const step = await buildNextContractPipelineStep({
      root: tmpDir,
      artifactsDir,
      runId: "test-run",
    });

    expect(step).not.toBeNull();
    const p1 = await promptOf(step!);
    expect(p1).toContain("Cyclic Seam Resolution");
    expect(p1).toContain("OBL-A");
    expect(p1).toContain("OBL-B");
  });

  it("auto-writes no_cycles artifact and proceeds to test_validator_plan when no cycle", async () => {
    await writeUpToObligationLedger(OBLIGATION_LEDGER_NO_CYCLE);

    const step = await buildNextContractPipelineStep({
      root: tmpDir,
      artifactsDir,
      runId: "test-run",
    });

    // After auto-writing the no_cycles artifact the pipeline moves on to the
    // next missing phase (test_validator_plan).
    expect(step).not.toBeNull();
    const p2 = await promptOf(step!);
    expect(p2).not.toContain("Cyclic Seam Resolution");
    expect(p2).toContain("Test and Validator Plan");
  });

  it("proceeds to assessment after a resolved (no_cycles) cyclic_seam_resolution artifact", async () => {
    await writeUpToObligationLedger(OBLIGATION_LEDGER_NO_CYCLE);

    // Write the cyclic_seam_resolution artifact manually (simulating prior run).
    const resolution = {
      contract_version:
        "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
      goal_id: "goal-test",
      cycles: [],
      status: "no_cycles",
      created_at: new Date().toISOString(),
    };
    await writeContractArtifact(
      artifactsDir,
      "cyclic_seam_resolution",
      resolution,
    );

    // Also write test_validator_plan so the next phase is assessment.
    const testValidatorPlan = {
      contract_version:
        "remediate-code-contract-pipeline/test-validator-plan/v1alpha1",
      goal_id: "goal-test",
      test_specs: [],
      created_at: new Date().toISOString(),
    };
    await writeContractArtifact(
      artifactsDir,
      "test_validator_plan",
      testValidatorPlan,
    );

    const step = await buildNextContractPipelineStep({
      root: tmpDir,
      artifactsDir,
      runId: "test-run",
    });

    // Next missing phase should be assessment (contract_assessment_report).
    expect(step).not.toBeNull();
    const p3 = await promptOf(step!);
    expect(p3).toContain("Contract Assessment");
  });

  it("emits a blocked step after MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS with cyclic ledger", async () => {
    await writeUpToObligationLedger(OBLIGATION_LEDGER_WITH_CYCLE);

    // Simulate exhausted attempts by writing repair state at the cap.
    const { readContractArtifact: rca } = await import("../../src/remediate/contractPipeline/artifactStore.js");
    const ledgerEnv = await rca(artifactsDir, "obligation_ledger");
    const ledgerHash = ledgerEnv?.content_hash ?? "fakehash";

    const repairState = await readCyclicSeamRepairState(artifactsDir);
    for (let i = 0; i < MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS; i++) {
      repairState.attempts.push({
        ledger_hash: ledgerHash,
        at: new Date().toISOString(),
        recheck_passed: false,
      });
    }
    await writeCyclicSeamRepairState(artifactsDir, repairState);

    const step = await buildNextContractPipelineStep({
      root: tmpDir,
      artifactsDir,
      runId: "test-run",
    });

    expect(step?.status).toBe("blocked");
    const p4 = await promptOf(step!);
    expect(p4).toContain("User Decision Required");
    expect(p4).toContain("OBL-A");
  });
});

// ── Staleness: modifying obligation_ledger stales cyclic_seam_resolution ──────

describe("detectStaleArtifacts — obligation_ledger change stales downstream", () => {
  let tmpDir: string;
  let artifactsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "stale-test-"));
    artifactsDir = makeArtifactsDir(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("stales cyclic_seam_resolution and contract_assessment_report after re-writing obligation_ledger", async () => {
    const AT = new Date().toISOString();

    // Write the full dependency chain in topological order so writeContractArtifact
    // can capture upstream hashes correctly at each step.
    await writeContractArtifact(artifactsDir, "goal_spec", {
      contract_version: "remediate-code-contract-pipeline/goal-spec/v1alpha1",
      goal_id: "g", objective: "x", non_goals: [], success_criteria: ["y"],
      source_type: "conversation", created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "context_bundle", {
      contract_version: "remediate-code-contract-pipeline/context-bundle/v1alpha1",
      goal_id: "g", entries: [], context_summary: "ctx", created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "module_decomposition", {
      contract_version: "remediate-code-contract-pipeline/module-decomposition/v1alpha1",
      goal_id: "g", modules: [], created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "module_contracts", {
      contract_version: "remediate-code-contract-pipeline/module-contracts/v1alpha1",
      goal_id: "g", module_contracts: [], created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "seam_reconciliation_report", {
      contract_version: "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1",
      goal_id: "g", mismatches: [], created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", {
      contract_version: "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1",
      goal_id: "g", module_contracts: [], created_at: AT,
    });
    const obligationLedger = {
      contract_version: "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
      goal_id: "g", obligations: [], created_at: AT,
    };
    await writeContractArtifact(artifactsDir, "obligation_ledger", obligationLedger);
    await writeContractArtifact(artifactsDir, "cyclic_seam_resolution", {
      contract_version: "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
      goal_id: "g", cycles: [], status: "no_cycles", created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "test_validator_plan", {
      contract_version: "remediate-code-contract-pipeline/test-validator-plan/v1alpha1",
      goal_id: "g", test_specs: [], created_at: AT,
    });
    await writeContractArtifact(artifactsDir, "contract_assessment_report", {
      contract_version: "remediate-code-contract-pipeline/contract-assessment-report/v1alpha1",
      goal_id: "g", findings: [], verdict: "passed", created_at: AT,
    });

    // No stale artifacts yet.
    const before = await detectStaleArtifacts(artifactsDir);
    expect(before.stale).not.toContain("cyclic_seam_resolution");
    expect(before.stale).not.toContain("contract_assessment_report");

    // Re-write obligation_ledger with changed content — stales downstream.
    await writeContractArtifact(artifactsDir, "obligation_ledger", {
      ...obligationLedger,
      obligations: [
        { id: "NEW", description: "new", kind: "invariant", depends_on: [], status: "pending" },
      ],
    });

    const after = await detectStaleArtifacts(artifactsDir);
    expect(after.stale).toContain("cyclic_seam_resolution");
    expect(after.stale).toContain("contract_assessment_report");
  });
});
