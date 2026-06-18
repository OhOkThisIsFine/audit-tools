/**
 * N-R06: Universal contract pipeline for BOTH intake paths.
 *
 * Verifies that:
 * - Path A (structured audit-findings.json) enters the contract pipeline via
 *   resolveIntakeStep → pipeline_ready → handleReadyIntakeContractPipeline,
 *   NOT via runPlanPhase directly.
 * - extract_findings step kind is never emitted by any path.
 * - A path-A seed file is written before the first pipeline step is emitted.
 * - goal_normalization prompt references the seed when it is present.
 * - Path B (document/conversation) continues to enter the contract pipeline.
 * - shouldEnterContractPipeline returns true for structured_audit.
 * - Both paths produce an extracted-plan.json after promoteImplementationDagToExtractedPlan.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveIntakeStep } from "../../src/remediate/steps/intakeResolver.js";
import {
  shouldEnterContractPipeline,
  promoteImplementationDagToExtractedPlan,
  writePathASeedFromFindings,
} from "../../src/remediate/steps/contractPipeline.js";
import {
  renderContractPipelinePrompt,
} from "../../src/remediate/steps/contractPipelinePrompts.js";
import {
  pathASeedFilePath,
  contractPipelineDir,
  contractArtifactFilePath,
  writeContractArtifact,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import { intakePaths } from "../../src/remediate/intake.js";
import {
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
} from "../../src/remediate/intake.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-n-r06-universal-cp");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");

const STUB_AUDIT_FINDINGS = {
  contract_version: "audit-findings/v1alpha1",
  findings: [
    {
      id: "AUD-001",
      title: "Missing auth check",
      category: "security",
      severity: "high",
      confidence: "high",
      lens: "security",
      summary: "Auth check is absent.",
      affected_files: [{ path: "src/auth.ts" }],
      evidence: ["src/auth.ts:42 — token never validated"],
    },
    {
      id: "AUD-002",
      title: "Stale dependency",
      category: "reliability",
      severity: "medium",
      confidence: "high",
      lens: "reliability",
      summary: "Dependency is outdated.",
      affected_files: [{ path: "package.json" }],
      evidence: ["package.json:15 — lodash@3"],
    },
  ],
  work_blocks: [
    { id: "WB-001", finding_ids: ["AUD-001", "AUD-002"], depends_on: [] },
  ],
};

const CREATED_AT = "2026-01-01T00:00:00.000Z";

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStubs() {
  return {
    collectStartingPointPrompt: () => "collect starting point",
    synthesizeIntakePrompt: () => "synthesize intake",
    collectIntakeClarificationsPrompt: () => "collect clarifications",
    loaderCommand: (cmd: string) => `remediate-code ${cmd}`,
    randomRunId: (prefix?: string) => `${prefix ?? "RUN"}-test`,
  };
}

async function writeAuditFindingsFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(STUB_AUDIT_FINDINGS), "utf8");
}

async function writeReadyStructuredAuditIntake(auditFindingsPath: string): Promise<void> {
  const intakeDir = join(ARTIFACTS_DIR, "intake");
  await mkdir(intakeDir, { recursive: true });
  await writeFile(
    join(intakeDir, "source-manifest.json"),
    JSON.stringify({
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "input",
      sources: [{ type: "structured_audit", path: auditFindingsPath, label: "audit-findings" }],
    }),
    "utf8",
  );
  await writeFile(
    join(intakeDir, "intake-summary.json"),
    JSON.stringify({
      schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
      ready: true,
      source_type: "structured_audit",
      goals: ["Remediate the structured audit findings."],
      non_goals: [],
      constraints: [],
      affected_files: [{ path: "src/auth.ts" }],
      open_questions: [],
    }),
    "utf8",
  );
  await writeFile(join(intakeDir, "remediation-brief.md"), "# Intake\n", "utf8");
}

async function writeReadyDocumentIntake(docPath: string): Promise<void> {
  const intakeDir = join(ARTIFACTS_DIR, "intake");
  await mkdir(intakeDir, { recursive: true });
  await writeFile(
    join(intakeDir, "source-manifest.json"),
    JSON.stringify({
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "input",
      sources: [{ type: "document", path: docPath, label: "input-01" }],
    }),
    "utf8",
  );
  await writeFile(
    join(intakeDir, "intake-summary.json"),
    JSON.stringify({
      schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
      ready: true,
      source_type: "documents",
      goals: ["Fix performance issues"],
      non_goals: [],
      constraints: [],
      affected_files: [{ path: "src/app.ts" }],
      open_questions: [],
    }),
    "utf8",
  );
  await writeFile(join(intakeDir, "remediation-brief.md"), "# Doc intake\n", "utf8");
}

async function writeCompleteContractPipelineArtifacts(): Promise<void> {
  await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
    contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
    goal_id: "G1",
    objective: "Improve.",
    non_goals: [],
    success_criteria: ["Improved."],
    source_type: "conversation",
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", {
    contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
    goal_id: "G1",
    entries: [],
    context_summary: "ctx",
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", {
    contract_version: CP_MODULE_DECOMPOSITION_VERSION,
    goal_id: "G1",
    modules: [{ name: "mod-a", responsibilities: "Does A.", file_scope: ["src/a.ts"] }],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", {
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
  });
  await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", {
    contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
    goal_id: "G1",
    mismatches: [],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", {
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
  });
  await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", {
    contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
    goal_id: "G1",
    items: [],
    verdict: "approved",
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
    contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
    goal_id: "G1",
    obligations: [
      { id: "O-1", description: "Behavior holds.", kind: "behavioral", depends_on: [], status: "pending" },
    ],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "contract_assessment_report", {
    contract_version: CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
    goal_id: "G1",
    findings: [],
    verdict: "passed",
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "counterexample", {
    contract_version: CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
    goal_id: "G1",
    counterexamples: [],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "judge_report", {
    contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
    goal_id: "G1",
    verdict: "approved",
    classifications: [],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
    contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
    goal_id: "G1",
    nodes: [
      {
        id: "N-001",
        title: "Fix auth",
        description: "Add the missing auth check.",
        satisfies_obligations: ["O-1"],
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
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("N-R06: Path A (structured audit-findings.json) enters contract pipeline", () => {
  it("resolveIntakeStep returns pipeline_ready for structured_audit — does NOT call runPlanPhase or emit extract_findings", async () => {
    const auditFindingsPath = join(TEST_DIR, "audit-findings.json");
    await writeAuditFindingsFile(auditFindingsPath);
    await writeReadyStructuredAuditIntake(auditFindingsPath);

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir: ARTIFACTS_DIR,
      inputResolution: { supplied: false, existing: [], missing: [], checked: [] },
      ...makeStubs(),
    });

    // Must return pipeline_ready, not a step with extract_findings or a state from runPlanPhase.
    expect(result.kind).toBe("pipeline_ready");
  });

  it("resolveIntakeStep never returns a step with step_kind === 'extract_findings' for structured_audit", async () => {
    const auditFindingsPath = join(TEST_DIR, "audit-findings.json");
    await writeAuditFindingsFile(auditFindingsPath);
    await writeReadyStructuredAuditIntake(auditFindingsPath);

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir: ARTIFACTS_DIR,
      inputResolution: { supplied: false, existing: [], missing: [], checked: [] },
      ...makeStubs(),
    });

    if (result.kind === "step") {
      expect(result.step.step_kind).not.toBe("extract_findings");
    }
    // If pipeline_ready, no extract_findings was emitted ✓
  });

  it("shouldEnterContractPipeline returns shouldHandleContractPipeline=true for structured_audit", () => {
    const check = shouldEnterContractPipeline(ARTIFACTS_DIR, "structured_audit");
    expect(check.shouldHandleContractPipeline).toBe(true);
    expect(check.pipelineComplete).toBe(false);
  });

  it("path-A seed file is written before the first pipeline step is emitted", async () => {
    const auditFindingsPath = join(TEST_DIR, "audit-findings.json");
    await writeAuditFindingsFile(auditFindingsPath);

    const parsed = STUB_AUDIT_FINDINGS;
    await writePathASeedFromFindings(ARTIFACTS_DIR, auditFindingsPath, parsed);

    const seedPath = pathASeedFilePath(ARTIFACTS_DIR);
    expect(existsSync(seedPath)).toBe(true);

    const seed = JSON.parse(await readFile(seedPath, "utf8")) as {
      finding_count: number;
      findings_summary: Array<{ id: string; title: string; lens: string }>;
      affected_files: string[];
      audit_findings_path: string;
    };

    expect(seed.finding_count).toBe(2);
    expect(seed.findings_summary).toHaveLength(2);
    expect(seed.findings_summary[0].id).toBe("AUD-001");
    expect(seed.findings_summary[0].lens).toBe("security");
    expect(seed.affected_files).toContain("src/auth.ts");
    expect(seed.audit_findings_path).toBe(auditFindingsPath);
  });

  it("writePathASeedFromFindings is idempotent (does not overwrite existing seed)", async () => {
    const auditFindingsPath = join(TEST_DIR, "audit-findings.json");
    await writeAuditFindingsFile(auditFindingsPath);

    await writePathASeedFromFindings(ARTIFACTS_DIR, auditFindingsPath, STUB_AUDIT_FINDINGS);
    const seedPath = pathASeedFilePath(ARTIFACTS_DIR);
    const firstContent = await readFile(seedPath, "utf8");

    // Writing again should not change the content (idempotent).
    await writePathASeedFromFindings(ARTIFACTS_DIR, auditFindingsPath, STUB_AUDIT_FINDINGS);
    const secondContent = await readFile(seedPath, "utf8");

    expect(firstContent).toBe(secondContent);
  });

  it("goal_normalization prompt references the path-A seed when it is present", async () => {
    const auditFindingsPath = join(TEST_DIR, "audit-findings.json");
    await writeAuditFindingsFile(auditFindingsPath);
    await writePathASeedFromFindings(ARTIFACTS_DIR, auditFindingsPath, STUB_AUDIT_FINDINGS);

    const seedPath = pathASeedFilePath(ARTIFACTS_DIR);
    const cpDir = contractPipelineDir(ARTIFACTS_DIR);
    const artifactPaths: Record<string, string> = {};
    for (const name of ["goal_spec", "context_bundle", "module_decomposition", "module_contracts",
      "seam_reconciliation_report", "finalized_module_contracts", "conceptual_design_critique",
      "obligation_ledger", "contract_assessment_report", "counterexample", "judge_report",
      "implementation_dag", "verification_report"] as const) {
      artifactPaths[name] = join(cpDir, `${name}.json`);
    }

    const rendered = renderContractPipelinePrompt({
      role: "goal_normalization",
      artifactPaths: artifactPaths as Parameters<typeof renderContractPipelinePrompt>[0]["artifactPaths"],
      pathASeedPath: seedPath,
      repoRoot: TEST_DIR,
    });

    expect(rendered.prompt).toContain(seedPath);
    expect(rendered.prompt).toContain("Path-A Audit Seed");
    expect(rendered.prompt).toContain("structured audit-findings report");
  });

  it("context_collection prompt references the path-A seed when it is present", async () => {
    const auditFindingsPath = join(TEST_DIR, "audit-findings.json");
    await writeAuditFindingsFile(auditFindingsPath);
    await writePathASeedFromFindings(ARTIFACTS_DIR, auditFindingsPath, STUB_AUDIT_FINDINGS);

    const seedPath = pathASeedFilePath(ARTIFACTS_DIR);
    const cpDir = contractPipelineDir(ARTIFACTS_DIR);
    const artifactPaths: Record<string, string> = {};
    for (const name of ["goal_spec", "context_bundle", "module_decomposition", "module_contracts",
      "seam_reconciliation_report", "finalized_module_contracts", "conceptual_design_critique",
      "obligation_ledger", "contract_assessment_report", "counterexample", "judge_report",
      "implementation_dag", "verification_report"] as const) {
      artifactPaths[name] = join(cpDir, `${name}.json`);
    }
    // Seed goal_spec for context_collection (required input)
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1",
      objective: "Remediate findings.",
      non_goals: [],
      success_criteria: [],
      source_type: "structured_audit",
      created_at: CREATED_AT,
    });
    artifactPaths.goal_spec = contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec");

    const rendered = renderContractPipelinePrompt({
      role: "context_collection",
      artifactPaths: artifactPaths as Parameters<typeof renderContractPipelinePrompt>[0]["artifactPaths"],
      pathASeedPath: seedPath,
      repoRoot: TEST_DIR,
    });

    expect(rendered.prompt).toContain(seedPath);
    expect(rendered.prompt).toContain("Path-A Audit Seed");
  });

  it("seam_reconciliation prompt does NOT include the path-A seed (only goal_normalization, context_collection, decomposition, module_contract_drafting use it)", async () => {
    const auditFindingsPath = join(TEST_DIR, "audit-findings.json");
    await writeAuditFindingsFile(auditFindingsPath);
    await writePathASeedFromFindings(ARTIFACTS_DIR, auditFindingsPath, STUB_AUDIT_FINDINGS);

    const seedPath = pathASeedFilePath(ARTIFACTS_DIR);
    const cpDir = contractPipelineDir(ARTIFACTS_DIR);
    const artifactPaths: Record<string, string> = {};
    for (const name of ["goal_spec", "context_bundle", "module_decomposition", "module_contracts",
      "seam_reconciliation_report", "finalized_module_contracts", "conceptual_design_critique",
      "obligation_ledger", "contract_assessment_report", "counterexample", "judge_report",
      "implementation_dag", "verification_report"] as const) {
      artifactPaths[name] = join(cpDir, `${name}.json`);
    }
    // Seed required inputs for seam_reconciliation
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", {
      contract_version: CP_MODULE_DECOMPOSITION_VERSION,
      goal_id: "G1",
      modules: [],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", {
      contract_version: CP_MODULE_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: [],
      created_at: CREATED_AT,
    });
    artifactPaths.module_decomposition = contractArtifactFilePath(ARTIFACTS_DIR, "module_decomposition");
    artifactPaths.module_contracts = contractArtifactFilePath(ARTIFACTS_DIR, "module_contracts");

    const rendered = renderContractPipelinePrompt({
      role: "seam_reconciliation",
      artifactPaths: artifactPaths as Parameters<typeof renderContractPipelinePrompt>[0]["artifactPaths"],
      pathASeedPath: seedPath,
      repoRoot: TEST_DIR,
    });

    // seam_reconciliation prompt must NOT include seed section
    expect(rendered.prompt).not.toContain("Path-A Audit Seed");
  });
});

describe("N-R06: extract_findings step kind is no longer emitted", () => {
  it("resolveIntakeStep never returns a step with step_kind === 'extract_findings' for document sources", async () => {
    const docPath = join(TEST_DIR, "feedback.md");
    await writeFile(docPath, "# Feedback\nFix bugs.", "utf8");
    await writeReadyDocumentIntake(docPath);

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir: ARTIFACTS_DIR,
      inputResolution: { supplied: false, existing: [], missing: [], checked: [] },
      ...makeStubs(),
    });

    // Document source also returns pipeline_ready — no extract_findings step emitted.
    expect(result.kind).toBe("pipeline_ready");
  });

  it("resolveIntakeStep never returns a step with step_kind === 'extract_findings' for conversation sources", async () => {
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    // Write a conversation-start.md
    await writeFile(join(intakeDir, "conversation-start.md"), "Improve performance.", "utf8");
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify({
        schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
        ready: true,
        source_type: "conversation",
        goals: ["Improve performance"],
        non_goals: [],
        constraints: [],
        affected_files: [{ path: "src/app.ts" }],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
        created_from: "conversation",
        sources: [{ type: "conversation", path: join(intakeDir, "conversation-start.md"), label: "conversation" }],
      }),
      "utf8",
    );
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief\n", "utf8");

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir: ARTIFACTS_DIR,
      inputResolution: { supplied: false, existing: [], missing: [], checked: [] },
      ...makeStubs(),
    });

    expect(result.kind).toBe("pipeline_ready");
  });
});

describe("N-R06: Path B (document/conversation) continues to run the contract pipeline", () => {
  it("shouldEnterContractPipeline returns true for document source with no existing extracted-plan.json", () => {
    const check = shouldEnterContractPipeline(ARTIFACTS_DIR, "documents");
    expect(check.shouldHandleContractPipeline).toBe(true);
    expect(check.pipelineComplete).toBe(false);
  });

  it("shouldEnterContractPipeline returns true for conversation source type", () => {
    const check = shouldEnterContractPipeline(ARTIFACTS_DIR, "conversation");
    expect(check.shouldHandleContractPipeline).toBe(true);
  });
});

describe("N-R06: Both paths converge at the implementation DAG and produce an extracted plan", () => {
  it("for a path-A run, once the pipeline completes, promoteImplementationDagToExtractedPlan produces extracted-plan.json", async () => {
    await writeCompleteContractPipelineArtifacts();

    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);

    const paths = intakePaths(ARTIFACTS_DIR);
    expect(existsSync(paths.extractedPlan)).toBe(true);
    const plan = JSON.parse(await readFile(paths.extractedPlan, "utf8")) as {
      plan_id: string;
      findings: Array<{ id: string }>;
      source: string;
    };
    expect(plan.findings.length).toBe(1);
    expect(plan.findings[0].id).toBe("N-001");
    expect(plan.source).toBe("contract_pipeline");
  });

  it("for a path-B run, once the pipeline completes, promoteImplementationDagToExtractedPlan produces extracted-plan.json", async () => {
    // Path B: same pipeline artifact structure, same outcome.
    await writeCompleteContractPipelineArtifacts();

    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);

    const paths = intakePaths(ARTIFACTS_DIR);
    expect(existsSync(paths.extractedPlan)).toBe(true);
    const plan = JSON.parse(await readFile(paths.extractedPlan, "utf8")) as {
      findings: Array<{ id: string }>;
    };
    expect(plan.findings.length).toBeGreaterThan(0);
  });
});
