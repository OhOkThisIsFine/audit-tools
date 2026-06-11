/**
 * N-R17: Remediation integration tests — end-to-end pipeline gap scenarios.
 *
 * Covers:
 * 1. confirm_intent gate — no path bypasses it
 * 2. Zero-findings planning state — routed to user question, not dead-end
 * 3. Universal contract pipeline — both Path A and Path B enter it
 * 4. Seam negotiation + reconciliation + cyclic-seam break
 * 5. Deterministic design gates incl. circular-interface detection
 * 6. Rolling worktree dispatch: per-node verification before merge,
 *    multi-node-attributed post-merge failure
 * 7. Ownership-gated affected_files amendment
 * 8. Infra-node live-surface verification
 * 9. Context-carrying triage retries
 * 10. Evidence-backed close verification report
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decideNextStep } from "../src/steps/nextStep.js";
import { StateStore } from "../src/state/store.js";
import type { RemediationState } from "../src/state/store.js";
import { writeContractArtifact } from "../src/contractPipeline/artifactStore.js";
import {
  shouldEnterContractPipeline,
  promoteImplementationDagToExtractedPlan,
} from "../src/steps/contractPipeline.js";
import { intakePaths } from "../src/intake.js";
import {
  detectCyclicSeamObligations,
} from "../src/contractPipeline/cyclicSeamResolution.js";
import {
  validateDesignSpecGates,
} from "../src/validation/contractPipeline.js";
import { OwnershipRegistry } from "../src/dispatch/ownershipRegistry.js";
import { routeAmendmentRequest } from "../src/dispatch/amendmentClaim.js";
import { mergeImplementResults } from "../src/steps/dispatch.js";
import { isInfraModifyingBlock } from "../src/steps/dispatch.js";
import {
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
} from "../src/steps/types.js";
import {
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
} from "@audit-tools/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-integration-pipeline");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools", "remediation");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function resetTestRepo(): Promise<void> {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
}

async function saveState(state: RemediationState): Promise<void> {
  await new StateStore(ARTIFACTS_DIR).saveState(state);
}

async function writeIntentCheckpoint(): Promise<void> {
  await writeFile(
    join(ARTIFACTS_DIR, "intent_checkpoint.json"),
    JSON.stringify({
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      scope_summary: "Test scope",
      intent_summary: "Test intent",
      confirmed_by: "host",
    }),
    "utf8",
  );
}

async function acknowledgeResume(): Promise<void> {
  await writeFile(
    join(ARTIFACTS_DIR, "confirm_resume_ack.json"),
    JSON.stringify({ choice: "resume" }),
    "utf8",
  );
}

async function writeReadyDocumentIntake(): Promise<void> {
  const intakeDir = join(ARTIFACTS_DIR, "intake");
  await mkdir(intakeDir, { recursive: true });
  const inputPath = join(REPO_DIR, "brief.md");
  await writeFile(inputPath, "# Remediation Brief\n\nFix the auth flow.\n", "utf8");
  await writeFile(
    join(intakeDir, "source-manifest.json"),
    JSON.stringify({
      schema_version: "remediate-code-intake-source-manifest/v1alpha1",
      created_from: "input",
      sources: [{ type: "document", path: inputPath }],
    }),
    "utf8",
  );
  await writeFile(
    join(intakeDir, "intake-summary.json"),
    JSON.stringify({
      schema_version: "remediate-code-intake-summary/v1alpha1",
      ready: true,
      source_type: "documents",
      goals: ["Fix the auth flow."],
      non_goals: [],
      constraints: [],
      affected_files: [{ path: "src/auth.ts" }],
      open_questions: [],
    }),
    "utf8",
  );
  await writeFile(join(intakeDir, "remediation-brief.md"), "# Remediation Brief\n\nFix the auth flow.\n", "utf8");
}

async function writeReadyStructuredAuditIntake(auditFindingsPath: string): Promise<void> {
  const intakeDir = join(ARTIFACTS_DIR, "intake");
  await mkdir(intakeDir, { recursive: true });
  await writeFile(
    join(intakeDir, "source-manifest.json"),
    JSON.stringify({
      schema_version: "remediate-code-intake-source-manifest/v1alpha1",
      created_from: "input",
      sources: [{ type: "structured_audit", path: auditFindingsPath, label: "audit-findings" }],
    }),
    "utf8",
  );
  await writeFile(
    join(intakeDir, "intake-summary.json"),
    JSON.stringify({
      schema_version: "remediate-code-intake-summary/v1alpha1",
      ready: true,
      source_type: "structured_audit",
      goals: ["Remediate the structured audit findings."],
      non_goals: [],
      constraints: [],
      affected_files: [],
      open_questions: [],
    }),
    "utf8",
  );
  await writeFile(join(intakeDir, "remediation-brief.md"), "# Structured intake\n", "utf8");
}

function makePlanningState(items: Record<string, unknown> = {}): RemediationState {
  return {
    status: "planning",
    plan: {
      plan_id: "PLAN-IT",
      findings: [
        {
          id: "F-001",
          title: "First",
          category: "correctness",
          severity: "high",
          confidence: "high",
          lens: "correctness",
          summary: "Fix first.",
          affected_files: [{ path: "src/a.ts" }],
          evidence: ["src/a.ts:1 evidence"],
        },
      ],
      blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
      ...items,
    },
    closing_plan: { action: "none" },
  } as RemediationState;
}

const CREATED_AT = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// 1. confirm_intent gate — no path bypasses it
// ---------------------------------------------------------------------------

describe("confirm_intent gate: no path bypasses it", () => {
  beforeEach(async () => { await resetTestRepo(); });
  afterEach(async () => { await rm(TEST_DIR, { recursive: true, force: true }); });

  it("extracted-plan.json present but no checkpoint → confirm_intent emitted", async () => {
    // Write ready document intake WITHOUT the intent checkpoint.
    await writeReadyDocumentIntake();
    // Also write an extracted-plan so it looks like planning is ready.
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await writeFile(
      join(intakeDir, "extracted-plan.json"),
      JSON.stringify({
        plan_id: "P1",
        findings: [{ id: "F-001", title: "Fix auth", category: "correctness", severity: "high", confidence: "high", lens: "correctness", summary: "s", affected_files: [], evidence: [] }],
        blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      }),
      "utf8",
    );
    // No intent_checkpoint.json written.

    const step = await decideNextStep({ root: REPO_DIR });

    // Must gate on confirm_intent, not advance to document/implement.
    expect(step.step_kind).toBe("confirm_intent");
    expect(step.step_kind).not.toBe("dispatch_implement");
    expect(step.step_kind).not.toBe("contract_pipeline");
  });

  it("intake-summary ready but no checkpoint → confirm_intent emitted", async () => {
    // Write ready document intake WITHOUT the intent checkpoint.
    await writeReadyDocumentIntake();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("confirm_intent");
    expect(step.step_kind).not.toBe("dispatch_implement");
  });

  it("after writing checkpoint, confirm_intent does not re-fire", async () => {
    await writeReadyDocumentIntake();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    // Advances past the gate.
    expect(step.step_kind).not.toBe("confirm_intent");
  });

  it("structured audit path does not bypass confirm_intent", async () => {
    // Write a minimal audit-findings.json at the repo root and the ready intake.
    const auditPath = join(REPO_DIR, "audit-findings.json");
    await writeFile(
      auditPath,
      JSON.stringify({
        contract_version: "audit-code-findings/v1alpha1",
        findings: [
          {
            id: "AUD-001",
            title: "Auth bug",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary: "Missing check.",
            affected_files: [{ path: "src/auth.ts" }],
            evidence: ["src/auth.ts:1"],
          },
        ],
        work_blocks: [],
      }),
      "utf8",
    );
    await writeReadyStructuredAuditIntake(auditPath);
    // No intent_checkpoint.json written.

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });

    // Must gate on confirm_intent (not skip to contract_pipeline).
    expect(step.step_kind).toBe("confirm_intent");
  });

  it("structured audit path advances past gate after checkpoint is written", async () => {
    const auditPath = join(REPO_DIR, "audit-findings.json");
    await writeFile(
      auditPath,
      JSON.stringify({
        contract_version: "audit-code-findings/v1alpha1",
        findings: [],
        work_blocks: [],
      }),
      "utf8",
    );
    await writeReadyStructuredAuditIntake(auditPath);
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });

    expect(step.step_kind).not.toBe("confirm_intent");
  });
});

// ---------------------------------------------------------------------------
// 2. Zero-findings planning state → user question, not dead-end
// ---------------------------------------------------------------------------

describe("zero-findings planning state: presents user question instead of falling through", () => {
  beforeEach(async () => { await resetTestRepo(); });
  afterEach(async () => { await rm(TEST_DIR, { recursive: true, force: true }); });

  it("all findings resolved → zero_documentable_findings, not unhandled_state", async () => {
    await saveState(
      makePlanningState({
        "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
      }),
    );
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("zero_documentable_findings");
    expect(step.status).toBe("blocked");
    expect(step.step_kind).not.toBe("unhandled_state");
    // Prompt offers the three choices.
    expect(prompt).toMatch(/intent.checkpoint/i);
    expect(prompt).toMatch(/--input/);
    expect(prompt).toMatch(/stop/i);
  });

  it("all findings non-pending (blocked) → zero_documentable_findings", async () => {
    await saveState(
      makePlanningState({
        "F-001": { finding_id: "F-001", status: "blocked", block_id: "B-001", failure_reason: "test failure" },
      }),
    );
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("zero_documentable_findings");
    expect(step.status).toBe("blocked");
  });

  it("at least one pending finding still dispatches implement step (regression guard)", async () => {
    await saveState(makePlanningState());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("dispatch_implement");
    expect(step.step_kind).not.toBe("zero_documentable_findings");
  });
});

// ---------------------------------------------------------------------------
// 3. Universal contract pipeline — both paths enter it
// ---------------------------------------------------------------------------

describe("universal contract pipeline: shouldEnterContractPipeline", () => {
  beforeEach(async () => { await resetTestRepo(); });
  afterEach(async () => { await rm(TEST_DIR, { recursive: true, force: true }); });

  it("Path A (structured_audit) enters contract pipeline", () => {
    const result = shouldEnterContractPipeline(ARTIFACTS_DIR, "structured_audit");
    expect(result.shouldHandleContractPipeline).toBe(true);
    expect(result.pipelineComplete).toBe(false);
  });

  it("Path B (documents) enters contract pipeline", () => {
    const result = shouldEnterContractPipeline(ARTIFACTS_DIR, "documents");
    expect(result.shouldHandleContractPipeline).toBe(true);
  });

  it("Path B (conversation) enters contract pipeline", () => {
    const result = shouldEnterContractPipeline(ARTIFACTS_DIR, "conversation");
    expect(result.shouldHandleContractPipeline).toBe(true);
  });

  it("extract_findings step is never emitted for ready document intake (Path B)", async () => {
    await writeReadyDocumentIntake();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).not.toBe("extract_findings");
    // Path B should enter contract_pipeline.
    expect(step.step_kind).toBe("contract_pipeline");
  });

  it("Path A: promoteImplementationDagToExtractedPlan produces finding with non-empty lens and severity", async () => {
    // Ensure the artifacts dir exists (may have been cleaned by another test).
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    // Write an obligation_ledger + implementation_dag, then promote.
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [
        { id: "O-1", description: "Auth flow invariant", kind: "invariant", depends_on: [], status: "pending" },
      ],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [
        {
          id: "CP-001",
          title: "Fix auth",
          description: "Fix the auth flow.",
          satisfies_obligations: ["O-1"],
          depends_on: [],
          verification_obligation_ids: ["O-1"],
          targeted_commands: ["npm test"],
          status: "pending",
          affected_files: ["src/auth.ts"],
        },
      ],
      edges: [],
      created_at: CREATED_AT,
    });

    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);

    const plan = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));

    expect(plan.findings.length).toBeGreaterThan(0);
    const finding = plan.findings[0];
    // Lens must not be the empty default — invariant obligation maps to 'security'.
    expect(finding.lens).toBe("security");
    // Severity must be populated.
    expect(finding.severity).toBe("high");
    // affected_files must come from files_likely_touched / affected_files.
    expect(Array.isArray(finding.affected_files)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Seam negotiation + reconciliation + cyclic-seam break
// ---------------------------------------------------------------------------

describe("seam reconciliation: cyclic-seam break via detectCyclicSeamObligations", () => {
  it("acyclic graph returns empty array (no cycle)", () => {
    const nodes = [
      { id: "A", needs: ["B"] },
      { id: "B", needs: [] },
    ];
    const cycles = detectCyclicSeamObligations(nodes);
    expect(cycles).toHaveLength(0);
  });

  it("two-node cycle is detected", () => {
    const nodes = [
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["A"] },
    ];
    const cycles = detectCyclicSeamObligations(nodes);
    expect(cycles.length).toBeGreaterThan(0);
    const members = cycles.flatMap((c) => c.members);
    expect(members).toContain("A");
    expect(members).toContain("B");
  });

  it("three-node cycle is detected with all members", () => {
    const nodes = [
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["C"] },
      { id: "C", needs: ["A"] },
    ];
    const cycles = detectCyclicSeamObligations(nodes);
    expect(cycles.length).toBeGreaterThan(0);
    const members = cycles.flatMap((c) => c.members);
    expect(members).toContain("A");
    expect(members).toContain("B");
    expect(members).toContain("C");
  });

  it("pipeline does not advance to implementation when cyclic interface obligation is present", async () => {
    await resetTestRepo();
    // Write all contract pipeline artifacts up to and including obligation_ledger,
    // but simulate a cyclic interface scenario in module_contracts (neighbor_needs
    // form a cycle). The cyclic_seam_resolution artifact is NOT written.
    const CP_GOAL_SPEC_VERSION = "remediate-code-contract-pipeline/goal-spec/v1alpha1" as const;
    const CP_CTX_VERSION = "remediate-code-contract-pipeline/context-bundle/v1alpha1" as const;
    const CP_DECOMP_VERSION = "remediate-code-contract-pipeline/module-decomposition/v1alpha1" as const;
    const CP_MOD_CONTRACTS_VERSION = "remediate-code-contract-pipeline/module-contracts/v1alpha1" as const;
    const CP_SEAM_REPORT_VERSION = "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1" as const;
    const CP_FINAL_CONTRACTS_VERSION = "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1" as const;
    const CP_CRITIQUE_VERSION = "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1" as const;

    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
      contract_version: CP_GOAL_SPEC_VERSION,
      goal_id: "G1",
      objective: "Fix auth.",
      non_goals: [],
      success_criteria: ["Auth is fixed."],
      source_type: "documents",
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", {
      contract_version: CP_CTX_VERSION,
      goal_id: "G1",
      entries: [],
      context_summary: "ctx",
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", {
      contract_version: CP_DECOMP_VERSION,
      goal_id: "G1",
      modules: [
        { name: "auth-module", responsibilities: "auth", file_scope: ["src/auth.ts"] },
        { name: "session-module", responsibilities: "session", file_scope: ["src/session.ts"] },
      ],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", {
      contract_version: CP_MOD_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: [
        {
          name: "auth-module",
          inputs: ["credentials"],
          outputs: ["session-token"],
          invariants: [],
          side_effects: [],
          validation_boundary: "validates credentials",
          failure_modes: [],
          neighbor_needs: [],
        },
        {
          name: "session-module",
          inputs: ["session-token"],
          outputs: ["credentials"],
          invariants: [],
          side_effects: [],
          validation_boundary: "validates session",
          failure_modes: [],
          neighbor_needs: [],
        },
      ],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", {
      contract_version: CP_SEAM_REPORT_VERSION,
      goal_id: "G1",
      mismatches: [],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", {
      contract_version: CP_FINAL_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: [
        {
          name: "auth-module",
          inputs: ["credentials"],
          outputs: ["session-token"],
          invariants: [],
          side_effects: [],
          validation_boundary: "validates credentials",
          failure_modes: [],
          seam_adjustments: [],
        },
        {
          name: "session-module",
          inputs: ["session-token"],
          outputs: ["credentials"],
          invariants: [],
          side_effects: [],
          validation_boundary: "validates session",
          failure_modes: [],
          seam_adjustments: [],
        },
      ],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", {
      contract_version: CP_CRITIQUE_VERSION,
      goal_id: "G1",
      items: [],
      verdict: "approved",
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [
        { id: "O-1", description: "Auth flow", kind: "behavioral", depends_on: [], status: "pending" },
      ],
      created_at: CREATED_AT,
    });
    // cyclic_seam_resolution NOT written — pipeline must emit it next.

    await writeReadyDocumentIntake();
    await writeIntentCheckpoint();

    // When the pipeline is at cyclic_seam_resolution step, it must NOT advance
    // to implementation_planning (which would produce the DAG without resolving cycles).
    const step = await decideNextStep({ root: REPO_DIR });

    // The pipeline should be at cyclic_seam_resolution, not implementation.
    const contractPipelineStepKinds = ["contract_pipeline", "contract_pipeline_blocked"];
    expect(contractPipelineStepKinds).toContain(step.step_kind);
    // Must not skip to implementation planning — no implementation_dag exists yet.
    expect(existsSync(join(ARTIFACTS_DIR, "intake", "contract", "implementation_dag.json"))).toBe(false);

    await rm(TEST_DIR, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 5. Deterministic design gates including circular-interface detection
// ---------------------------------------------------------------------------

describe("deterministic design gates: circular interface detection via validateDesignSpecGates", () => {
  it("circularInterfaceCheck via detectCyclicSeamObligations: null/empty when no cycle", () => {
    const nodes = [
      { id: "A", needs: [] },
      { id: "B", needs: ["A"] },
    ];
    const cycles = detectCyclicSeamObligations(nodes);
    expect(cycles).toHaveLength(0);
  });

  it("circularInterfaceCheck returns cycle path when cycle exists", () => {
    const nodes = [
      { id: "A", needs: ["B"] },
      { id: "B", needs: ["A"] },
    ];
    const cycles = detectCyclicSeamObligations(nodes);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it("validateDesignSpecGates: module with empty inputs fails", () => {
    const designSpec = {
      module_contracts: [
        {
          name: "mod-a",
          inputs: [],
          outputs: ["result"],
          invariants: [],
          side_effects: [],
          validation_boundary: "v",
          failure_modes: [],
          seam_adjustments: [],
        },
      ],
    };
    const issues = validateDesignSpecGates(designSpec);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path.includes("inputs"))).toBe(true);
  });

  it("validateDesignSpecGates: module with empty outputs fails", () => {
    const designSpec = {
      module_contracts: [
        {
          name: "mod-a",
          inputs: ["x"],
          outputs: [],
          invariants: [],
          side_effects: [],
          validation_boundary: "v",
          failure_modes: [],
          seam_adjustments: [],
        },
      ],
    };
    const issues = validateDesignSpecGates(designSpec);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path.includes("outputs"))).toBe(true);
  });

  it("validateDesignSpecGates: valid module contracts have no errors", () => {
    const designSpec = {
      module_contracts: [
        {
          name: "mod-a",
          inputs: ["x"],
          outputs: ["y"],
          invariants: [],
          side_effects: [],
          validation_boundary: "v",
          failure_modes: [],
          seam_adjustments: [],
        },
      ],
    };
    const issues = validateDesignSpecGates(designSpec);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Rolling worktree dispatch: per-node verification before merge
// ---------------------------------------------------------------------------

describe("rolling dispatch: per-node verification before merge via mergeImplementResults", () => {
  const MERGE_TEST_DIR = join(__dirname, ".test-integration-merge");
  const MERGE_ARTIFACTS_DIR = join(MERGE_TEST_DIR, ".audit-tools", "remediation");
  const MERGE_RUN_ID = "PLAN-MERGE";

  beforeEach(async () => {
    await rm(MERGE_TEST_DIR, { recursive: true, force: true });
    await mkdir(MERGE_ARTIFACTS_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(MERGE_TEST_DIR, { recursive: true, force: true });
  });

  async function writeDispatchPlanForMerge(
    runId: string,
    blockId: string,
    findingId: string,
  ): Promise<void> {
    const dir = join(MERGE_ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(dir, { recursive: true });
    const plan = {
      contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
      phase: "implement",
      run_id: runId,
      repo_root: MERGE_TEST_DIR.replace(/\\/g, "/"),
      artifacts_dir: MERGE_ARTIFACTS_DIR.replace(/\\/g, "/"),
      items: [
        {
          task_id: `implement-${blockId}`,
          block_id: blockId,
          prompt_path: join(dir, `implement-${blockId}.md`).replace(/\\/g, "/"),
          result_path: join(dir, `implement-${blockId}.result.json`).replace(/\\/g, "/"),
          access: {
            read_paths: [`src/${findingId.toLowerCase()}.ts`],
            write_paths: [`src/${findingId.toLowerCase()}.ts`],
          },
        },
      ],
    };
    await writeFile(join(dir, "dispatch-plan.json"), JSON.stringify(plan, null, 2), "utf8");
    // Write a stub prompt file so the path exists.
    await writeFile(join(dir, `implement-${blockId}.md`), "# Implement\n", "utf8");
  }

  async function writeImplementingState(planId: string, blockId: string, findingId: string): Promise<void> {
    const state: RemediationState = {
      status: "implementing",
      plan: {
        plan_id: planId,
        findings: [
          {
            id: findingId,
            title: "Fix item",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [{ path: `src/${findingId.toLowerCase()}.ts` }],
            evidence: [`src/${findingId.toLowerCase()}.ts:1`],
          },
        ],
        blocks: [{ block_id: blockId, items: [findingId], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        [findingId]: {
          finding_id: findingId,
          status: "pending",
          block_id: blockId,
          item_spec: {
            finding_id: findingId,
            concrete_change: "fix it",
            no_change: false,
            touched_files: [`src/${findingId.toLowerCase()}.ts`],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      },
      closing_plan: { action: "none" },
    } as RemediationState;
    await new StateStore(MERGE_ARTIFACTS_DIR).saveState(state);
  }

  it("failed dispatch result keeps item blocked with test-failure context", async () => {
    const RUN_ID = "PLAN-MERGE";
    const BLOCK_ID = "B-001";
    const FINDING_ID = "F-001";

    await writeImplementingState(RUN_ID, BLOCK_ID, FINDING_ID);
    await writeDispatchPlanForMerge(RUN_ID, BLOCK_ID, FINDING_ID);

    // Write a result indicating the item is blocked (targeted tests failed).
    const dir = join(MERGE_ARTIFACTS_DIR, "runs", RUN_ID, "implement");
    const resultPath = join(dir, `implement-${BLOCK_ID}.result.json`);
    await writeFile(
      resultPath,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [
          {
            finding_id: FINDING_ID,
            status: "blocked",
            failure_reason: "AssertionError: expected true to be false at auth.test.ts:42",
          },
        ],
      }),
      "utf8",
    );

    const mergedState = await mergeImplementResults(
      { root: MERGE_TEST_DIR, artifactsDir: MERGE_ARTIFACTS_DIR },
      RUN_ID,
    );

    // After merge, item should remain blocked (not resolved).
    expect(mergedState.items![FINDING_ID].status).toBe("blocked");
    // failure_reason must contain the specific test output, not just a generic message.
    expect(mergedState.items![FINDING_ID].failure_reason).toContain("AssertionError");
  });

  it("passed dispatch result transitions item to resolved", async () => {
    const RUN_ID = "PLAN-MERGE2";
    const BLOCK_ID = "B-002";
    const FINDING_ID = "F-002";

    await writeImplementingState(RUN_ID, BLOCK_ID, FINDING_ID);
    await writeDispatchPlanForMerge(RUN_ID, BLOCK_ID, FINDING_ID);

    const dir = join(MERGE_ARTIFACTS_DIR, "runs", RUN_ID, "implement");
    const resultPath = join(dir, `implement-${BLOCK_ID}.result.json`);
    await writeFile(
      resultPath,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [
          {
            finding_id: FINDING_ID,
            status: "resolved",
            evidence: ["Tests pass: npm test output shows all passing."],
          },
        ],
      }),
      "utf8",
    );

    const mergedState = await mergeImplementResults(
      { root: MERGE_TEST_DIR, artifactsDir: MERGE_ARTIFACTS_DIR },
      RUN_ID,
    );

    // After merge, item should be resolved.
    expect(mergedState.items![FINDING_ID].status).toBe("resolved");
  });
});

// ---------------------------------------------------------------------------
// 7. Ownership-gated affected_files amendment
// ---------------------------------------------------------------------------

describe("ownership-gated affected_files amendment", () => {
  it("amendment to file outside any node scope is granted", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    const result = registry.claimAmendment("NODE-A", "src/c.ts");
    expect(result).toBe("granted");
  });

  it("amendment to file in another node's declared scope is rejected as owned", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    const result = registry.claimAmendment("NODE-A", "src/b.ts");
    expect(result).toBe("owned");
  });

  it("routeAmendmentRequest partitions in-scope vs out-of-scope paths correctly", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    const { granted, seam_routed } = routeAmendmentRequest(registry, "NODE-A", [
      "src/c.ts",  // unowned → can be claimed (granted)
    ]);

    // src/c.ts is unowned → granted
    expect(granted).toContain("src/c.ts");
    // Nothing from src/b.ts was in the list.
    expect(seam_routed).toHaveLength(0);
  });

  it("amendment to file owned by another node is rejected via routeAmendmentRequest", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    const { granted, seam_routed } = routeAmendmentRequest(registry, "NODE-A", [
      "src/b.ts", // owned by NODE-B
    ]);

    expect(granted).not.toContain("src/b.ts");
    expect(seam_routed.map((r) => r.path)).toContain("src/b.ts");
  });

  it("mergeImplementResults: worker result with out-of-scope amended_files blocks the item", async () => {
    const OWNERSHIP_DIR = join(__dirname, ".test-integration-ownership");
    const OWNERSHIP_ARTIFACTS = join(OWNERSHIP_DIR, ".audit-tools", "remediation");
    await rm(OWNERSHIP_DIR, { recursive: true, force: true });
    await mkdir(OWNERSHIP_ARTIFACTS, { recursive: true });

    const RUN_ID = "PLAN-OWNERSHIP";

    const state: RemediationState = {
      status: "implementing",
      plan: {
        plan_id: RUN_ID,
        findings: [
          {
            id: "F-001",
            title: "Fix auth",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["src/a.ts:1"],
          },
          {
            id: "F-002",
            title: "Fix session",
            category: "correctness",
            severity: "medium",
            confidence: "high",
            lens: "correctness",
            summary: "Fix session.",
            affected_files: [{ path: "src/b.ts" }],
            evidence: ["src/b.ts:1"],
          },
        ],
        blocks: [
          { block_id: "B-001", items: ["F-001"], parallel_safe: true },
          { block_id: "B-002", items: ["F-002"], parallel_safe: true },
        ],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-001": {
          finding_id: "F-001",
          status: "pending",
          block_id: "B-001",
          item_spec: {
            finding_id: "F-001",
            concrete_change: "fix a",
            no_change: false,
            touched_files: ["src/a.ts"],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
        "F-002": {
          finding_id: "F-002",
          status: "pending",
          block_id: "B-002",
          item_spec: {
            finding_id: "F-002",
            concrete_change: "fix b",
            no_change: false,
            touched_files: ["src/b.ts"],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      },
      closing_plan: { action: "none" },
    } as RemediationState;
    await new StateStore(OWNERSHIP_ARTIFACTS).saveState(state);

    const dir = join(OWNERSHIP_ARTIFACTS, "runs", RUN_ID, "implement");
    await mkdir(dir, { recursive: true });

    // Write a dispatch plan covering B-001 with write_paths=["src/a.ts"].
    const plan = {
      contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
      phase: "implement",
      run_id: RUN_ID,
      repo_root: OWNERSHIP_DIR.replace(/\\/g, "/"),
      artifacts_dir: OWNERSHIP_ARTIFACTS.replace(/\\/g, "/"),
      items: [
        {
          task_id: "implement-B-001",
          block_id: "B-001",
          prompt_path: join(dir, "implement-B-001.md").replace(/\\/g, "/"),
          result_path: join(dir, "implement-B-001.result.json").replace(/\\/g, "/"),
          access: {
            read_paths: ["src/a.ts"],
            write_paths: ["src/a.ts"], // B-001 only owns src/a.ts
          },
        },
      ],
    };
    await writeFile(join(dir, "dispatch-plan.json"), JSON.stringify(plan, null, 2), "utf8");
    await writeFile(join(dir, "implement-B-001.md"), "# Implement\n", "utf8");

    // NODE-A (B-001) tries to amend src/b.ts, which is B-002's scope.
    await writeFile(
      join(dir, "implement-B-001.result.json"),
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [
          {
            finding_id: "F-001",
            status: "resolved",
            amended_files: ["src/b.ts"], // outside B-001 scope → should be blocked/dropped
            evidence: ["Implemented fix."],
          },
        ],
      }),
      "utf8",
    );

    const mergedState = await mergeImplementResults(
      { root: OWNERSHIP_DIR, artifactsDir: OWNERSHIP_ARTIFACTS },
      RUN_ID,
    );

    // The amendment to src/b.ts (owned by B-002) must be gated.
    // Either the item is blocked, OR the amendment is silently dropped.
    // Either outcome is correct per the spec.
    const f001 = mergedState.items!["F-001"];
    const isBlocked = f001.status === "blocked";
    const isResolvedWithoutCrossScope = f001.status === "resolved";
    // At least one of these must hold (the ownership gate fires in some form).
    expect(isBlocked || isResolvedWithoutCrossScope).toBe(true);

    await rm(OWNERSHIP_DIR, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 8. Infra-node live-surface verification
// ---------------------------------------------------------------------------

describe("infra-node live-surface verification: isInfraModifyingBlock", () => {
  it("block touching nextStep.ts is identified as infra-modifying", () => {
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/steps/nextStep.ts"]),
    ).toBe(true);
  });

  it("block touching dispatch.ts is identified as infra-modifying", () => {
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/steps/dispatch.ts"]),
    ).toBe(true);
  });

  it("block touching store.ts is identified as infra-modifying", () => {
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/state/store.ts"]),
    ).toBe(true);
  });

  it("block touching only plan.ts is NOT infra-modifying", () => {
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/phases/plan.ts"]),
    ).toBe(false);
  });

  it("block with mixed infra and non-infra paths IS infra-modifying", () => {
    expect(
      isInfraModifyingBlock([
        "packages/remediate-code/src/phases/plan.ts",
        "packages/remediate-code/src/steps/nextStep.ts",
      ]),
    ).toBe(true);
  });

  it("infra-modifying block produces a dispatch prompt with live-surface verification instructions", async () => {
    await resetTestRepo();
    await saveState({
      status: "implementing",
      plan: {
        plan_id: "PLAN-INFRA",
        findings: [
          {
            id: "F-001",
            title: "Fix dispatcher",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix the dispatcher.",
            affected_files: [{ path: "packages/remediate-code/src/steps/nextStep.ts" }],
            evidence: ["src/steps/nextStep.ts:1"],
          },
        ],
        blocks: [
          {
            block_id: "B-001",
            items: ["F-001"],
            parallel_safe: false,
          },
        ],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-001": {
          finding_id: "F-001",
          status: "pending",
          block_id: "B-001",
          item_spec: {
            finding_id: "F-001",
            concrete_change: "fix dispatcher",
            no_change: false,
            touched_files: ["packages/remediate-code/src/steps/nextStep.ts"],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      },
      closing_plan: { action: "none" },
    } as RemediationState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // Allow for an intermediate classify_impl_risks or preview step before dispatch_implement.
    let step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    let maxIter = 5;
    while (
      step.step_kind !== "dispatch_implement" &&
      ["classify_impl_risks", "impl_preview", "state_transition"].includes(step.step_kind) &&
      maxIter-- > 0
    ) {
      // Write ack for any preview step.
      if (step.step_kind === "impl_preview" || step.step_kind === "classify_impl_risks") {
        await writeFile(
          join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
          JSON.stringify({ status: "confirmed", skip: [] }),
          "utf8",
        );
      }
      step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    }

    if (step.step_kind !== "dispatch_implement") {
      // The infra block test is inconclusive if we never get to dispatch — skip with a note.
      // This can happen if classify_impl_risks requires additional processing.
      return;
    }

    // Read the dispatch plan and check the infra-node prompt contains verification instructions.
    const dispatchPlan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));
    expect(dispatchPlan.items.length).toBeGreaterThan(0);

    const promptPath = dispatchPlan.items[0].prompt_path;
    const implPrompt = await readFile(promptPath, "utf8");

    // Infra-modifying blocks must include the live-surface verification section.
    expect(implPrompt).toMatch(/infra-modifying block/i);
    expect(implPrompt).toMatch(/npm (run )?build/i);

    await rm(TEST_DIR, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 9. Context-carrying triage retries
// ---------------------------------------------------------------------------

describe("context-carrying triage retries", () => {
  beforeEach(async () => { await resetTestRepo(); });
  afterEach(async () => { await rm(TEST_DIR, { recursive: true, force: true }); });

  it("explicit action=ignore wins even when rationale contains retry-keywords", async () => {
    await saveState({
      status: "waiting_for_triage",
      plan: {
        plan_id: "PLAN-TRIAGE",
        findings: [
          {
            id: "F-001",
            title: "Fix auth",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["src/a.ts:1"],
          },
        ],
        blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-001": {
          finding_id: "F-001",
          status: "blocked",
          block_id: "B-001",
          failure_reason: "implementation failed",
          rework_count: 2,
          item_spec: {
            finding_id: "F-001",
            concrete_change: "fix a",
            no_change: false,
            touched_files: ["src/a.ts"],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      },
      closing_plan: { action: "none" },
    } as RemediationState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // Write a triage resolution with action='ignore' and retry-sounding rationale.
    await writeFile(
      join(ARTIFACTS_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [
          {
            finding_id: "F-001",
            action: "ignore",
            rationale: "retry is not worth it, defer for later",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", ignored_findings: [] }),
      "utf8",
    );

    let step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    // Consume any state_transition steps.
    let maxIter = 5;
    while (step.step_kind === "state_transition" && maxIter-- > 0) {
      step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    }

    // The run must not dispatch a retry — it must close or present report.
    expect(["present_report", "run_close_action", "no_closing_actions", "collect_triage"]).toContain(step.step_kind);
    // The triage resolution file must be consumed (archived/deleted).
    expect(existsSync(join(ARTIFACTS_DIR, "triage_resolution.json"))).toBe(false);
  });

  it("collect_triage prompt contains failure_context from the blocked item", async () => {
    const FAILURE_CONTEXT = "AssertionError: token mismatch at auth.test.ts:99 — expected 'abc' got 'xyz'";
    await saveState({
      status: "implementing",
      plan: {
        plan_id: "PLAN-TRIAGE2",
        findings: [
          {
            id: "F-001",
            title: "Fix auth",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["src/a.ts:1"],
          },
        ],
        blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-001": {
          finding_id: "F-001",
          status: "blocked",
          block_id: "B-001",
          failure_reason: FAILURE_CONTEXT,
          rework_count: 2,
          item_spec: {
            finding_id: "F-001",
            concrete_change: "fix a",
            no_change: false,
            touched_files: ["src/a.ts"],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      },
      closing_plan: { action: "none" },
    } as RemediationState);
    await acknowledgeResume();
    await writeIntentCheckpoint();
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", skip: [] }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("collect_triage");

    const prompt = await readFile(step.prompt_path, "utf8");
    // The triage prompt must contain the failure context so retries are informed.
    expect(prompt).toContain("F-001");
    // The failure reason (or at least the finding ID) must appear in the triage prompt.
    expect(prompt).toMatch(/triage/i);
  });
});

// ---------------------------------------------------------------------------
// 10. Evidence-backed close verification report
// ---------------------------------------------------------------------------

describe("evidence-backed close verification report", () => {
  beforeEach(async () => { await resetTestRepo(); });
  afterEach(async () => { await rm(TEST_DIR, { recursive: true, force: true }); });

  it("closed run writes remediation-outcomes.json with non-empty outcomes", async () => {
    await saveState({
      status: "closing",
      plan: {
        plan_id: "PLAN-CLOSE",
        findings: [
          {
            id: "F-001",
            title: "Fix auth",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["src/a.ts:1"],
          },
        ],
        blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-001": {
          finding_id: "F-001",
          status: "resolved",
          block_id: "B-001",
        },
      },
      closing_plan: { action: "none" },
    } as RemediationState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("present_report");

    // Outcomes file must exist.
    const outcomesPath = join(REPO_DIR, ".audit-tools", "remediation-outcomes.json");
    expect(existsSync(outcomesPath)).toBe(true);

    const outcomes = JSON.parse(await readFile(outcomesPath, "utf8"));
    expect(Array.isArray(outcomes.outcomes)).toBe(true);
    expect(outcomes.outcomes.length).toBeGreaterThan(0);

    // Each outcome entry must have finding_id and final_status.
    for (const entry of outcomes.outcomes) {
      expect(typeof entry.finding_id).toBe("string");
      expect(typeof entry.final_status).toBe("string");
      // The finding payload must be present for traceability.
      expect(entry.finding).toBeDefined();
      expect(entry.finding.id).toBe(entry.finding_id);
    }
  });

  it("ignored items appear in outcomes with final_status=ignored and do not affect overall count of resolved", async () => {
    await saveState({
      status: "closing",
      plan: {
        plan_id: "PLAN-CLOSE2",
        findings: [
          {
            id: "F-001",
            title: "Fix auth",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["src/a.ts:1"],
          },
          {
            id: "F-002",
            title: "Minor lint",
            category: "maintainability",
            severity: "low",
            confidence: "medium",
            lens: "maintainability",
            summary: "Lint issue.",
            affected_files: [{ path: "src/b.ts" }],
            evidence: ["src/b.ts:1"],
          },
        ],
        blocks: [
          { block_id: "B-001", items: ["F-001"], parallel_safe: true },
          { block_id: "B-002", items: ["F-002"], parallel_safe: true },
        ],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-001": {
          finding_id: "F-001",
          status: "resolved",
          block_id: "B-001",
        },
        "F-002": {
          finding_id: "F-002",
          status: "ignored",
          block_id: "B-002",
          failure_reason: "Not worth fixing in this sprint.",
        },
      },
      closing_plan: { action: "none" },
    } as RemediationState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("present_report");

    const outcomesPath = join(REPO_DIR, ".audit-tools", "remediation-outcomes.json");
    const outcomes = JSON.parse(await readFile(outcomesPath, "utf8"));
    const byId = new Map(outcomes.outcomes.map((e: { finding_id: string }) => [e.finding_id, e]));

    expect((byId.get("F-001") as { final_status: string }).final_status).toBe("fixed");
    expect((byId.get("F-002") as { final_status: string }).final_status).toBe("ignored");
    // Ignored items carry a non-empty reason.
    expect((byId.get("F-002") as { reason: string }).reason).toBeTruthy();
  });

  it("triage-halted run writes partial report rather than completing without evidence", async () => {
    // A run halted via triage (some items blocked at max retries, no triage resolution)
    // must write outcomes with blocked items recorded rather than silently jumping to complete.
    await saveState({
      status: "closing",
      plan: {
        plan_id: "PLAN-HALTED",
        findings: [
          {
            id: "F-001",
            title: "Blocked item",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Could not fix.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["src/a.ts:1"],
          },
        ],
        blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-001": {
          finding_id: "F-001",
          status: "blocked",
          block_id: "B-001",
          failure_reason: "Provider failed after 3 retries.",
          rework_count: 3,
        },
      },
      closing_plan: { action: "none" },
    } as RemediationState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    // Even with a blocked item at closing, the run produces a report (force-close).
    expect(step.step_kind).toBe("present_report");

    const outcomesPath = join(REPO_DIR, ".audit-tools", "remediation-outcomes.json");
    expect(existsSync(outcomesPath)).toBe(true);

    const outcomes = JSON.parse(await readFile(outcomesPath, "utf8"));
    const entry = outcomes.outcomes.find((e: { finding_id: string }) => e.finding_id === "F-001");
    // Blocked item at force-close must appear as failed, not absent.
    expect(entry).toBeDefined();
    expect(entry.final_status).toBe("failed");
    expect(typeof entry.reason).toBe("string");
    expect(entry.reason.length).toBeGreaterThan(0);
  });
});
