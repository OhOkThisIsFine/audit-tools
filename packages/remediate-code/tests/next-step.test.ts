import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { decideNextStep, resolveHostDispatchCapability } from "../src/steps/nextStep.js";
import { loaderCommand } from "../src/steps/prompts.js";
import { StateStore } from "../src/state/store.js";
import type { RemediationState } from "../src/state/store.js";
import { REMEDIATION_WORKER_RESULT_CONTRACT_VERSION } from "../src/steps/types.js";
import { writeContractArtifact } from "../src/contractPipeline/artifactStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-next-step");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");
const WRAPPER = join(__dirname, "..", "remediate-code.mjs");
const AUDIT_FIXTURE = join(__dirname, "fixtures", "audit-findings-simple.json");
const AUDITOR_CONTRACT_FIXTURE = join(
  __dirname,
  "fixtures",
  "auditor-contract-audit-findings.json",
);

function makePlanningState(overrides: Partial<RemediationState> = {}): RemediationState {
  return {
    status: "planning",
    plan: {
      plan_id: "PLAN-1",
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
        {
          id: "F-002",
          title: "Second",
          category: "tests",
          severity: "low",
          confidence: "medium",
          lens: "tests",
          summary: "Fix second.",
          affected_files: [{ path: "src/b.ts" }],
          evidence: ["src/b.ts:1 evidence"],
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
      "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
      "F-002": { finding_id: "F-002", status: "pending", block_id: "B-002" },
    },
    closing_plan: { action: "none" },
    ...overrides,
  } as RemediationState;
}

async function saveState(state: RemediationState): Promise<void> {
  await new StateStore(ARTIFACTS_DIR).saveState(state);
}

function makeImplementingState(
  overrides: Partial<RemediationState> = {},
): RemediationState {
  return makePlanningState({
    status: "implementing",
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
    ...overrides,
  });
}

async function resetTestRepo(): Promise<void> {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
}

async function acknowledgeImplementationPreview(): Promise<void> {
  await writeFile(
    join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
    JSON.stringify({ status: "confirmed", ignored_findings: [] }),
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

async function writeReadyStructuredAuditIntake(inputPath: string): Promise<void> {
  const intakeDir = join(ARTIFACTS_DIR, "intake");
  await mkdir(intakeDir, { recursive: true });
  await writeFile(
    join(intakeDir, "source-manifest.json"),
    JSON.stringify({
      schema_version: "remediate-code-intake-source-manifest/v1alpha1",
      created_from: "input",
      sources: [
        {
          type: "structured_audit",
          path: inputPath,
          label: "audit-findings",
        },
      ],
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
  await writeFile(
    join(intakeDir, "remediation-brief.md"),
    "# Structured intake\n",
    "utf8",
  );
  await writeIntentCheckpoint();
}

async function writeCompleteContractPipelineDag(): Promise<void> {
  const created_at = "2026-01-01T00:00:00.000Z";
  await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
    contract_version: "remediate-code-contract-pipeline/goal-spec/v1alpha1",
    goal_id: "G1",
    objective: "Clean up the auth flow.",
    non_goals: [],
    success_criteria: ["Auth flow cleanup is implemented."],
    source_type: "documents",
    created_at,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", {
    contract_version: "remediate-code-contract-pipeline/context-bundle/v1alpha1",
    goal_id: "G1",
    entries: [],
    context_summary: "Auth flow context.",
    created_at,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", {
    contract_version: "remediate-code-contract-pipeline/module-decomposition/v1alpha1",
    goal_id: "G1",
    modules: [{ name: "auth-module", responsibilities: "Handles auth flow.", file_scope: ["src/auth.ts"] }],
    created_at,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", {
    contract_version: "remediate-code-contract-pipeline/module-contracts/v1alpha1",
    goal_id: "G1",
    module_contracts: [{
      name: "auth-module",
      inputs: ["credentials"],
      outputs: ["session"],
      invariants: [],
      side_effects: [],
      validation_boundary: "validates credentials",
      failure_modes: [],
      neighbor_needs: [],
    }],
    created_at,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", {
    contract_version: "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1",
    goal_id: "G1",
    mismatches: [],
    created_at,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", {
    contract_version: "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1",
    goal_id: "G1",
    module_contracts: [{
      name: "auth-module",
      inputs: ["credentials"],
      outputs: ["session"],
      invariants: [],
      side_effects: [],
      validation_boundary: "validates credentials",
      failure_modes: [],
      seam_adjustments: [],
    }],
    created_at,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", {
    contract_version: "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1",
    goal_id: "G1",
    items: [],
    verdict: "approved",
    created_at,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
    contract_version: "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
    goal_id: "G1",
    obligations: [
      {
        id: "O-1",
        description: "Auth flow cleanup is implemented.",
        kind: "behavioral",
        depends_on: [],
        status: "pending",
      },
    ],
    created_at,
  });
  // cyclic_seam_resolution is auto-written by the pipeline when no cycles exist,
  // but we write it explicitly here so the pipeline sees it and proceeds.
  await writeContractArtifact(ARTIFACTS_DIR, "cyclic_seam_resolution", {
    contract_version: "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
    goal_id: "G1",
    status: "no_cycles",
    cycles: [],
    created_at,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "test_validator_plan", {
    contract_version: "remediate-code-contract-pipeline/test-validator-plan/v1alpha1",
    goal_id: "G1",
    test_specs: [],
    created_at,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "contract_assessment_report", {
    contract_version: "remediate-code-contract-pipeline/contract-assessment-report/v1alpha1",
    goal_id: "G1",
    findings: [],
    verdict: "passed",
    created_at,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "counterexample", {
    contract_version: "remediate-code-contract-pipeline/counterexample/v1alpha1",
    goal_id: "G1",
    counterexamples: [],
    created_at,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "judge_report", {
    contract_version: "remediate-code-contract-pipeline/judge-report/v1alpha1",
    goal_id: "G1",
    verdict: "approved",
    classifications: [],
    created_at,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
    contract_version: "remediate-code-contract-pipeline/implementation-dag/v1alpha1",
    goal_id: "G1",
    nodes: [
      {
        id: "CP-001",
        title: "Update auth flow",
        description: "Implement the auth flow cleanup.",
        satisfies_obligations: ["O-1"],
        depends_on: [],
        verification_obligation_ids: ["O-1"],
        targeted_commands: ["npm test"],
        status: "pending",
      },
    ],
    edges: [],
    created_at,
  });
}

beforeEach(async () => {
  await resetTestRepo();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("decideNextStep", () => {
  it("complete run emits present_report", async () => {
    await saveState({ status: "complete" });
    await mkdir(join(REPO_DIR, ".audit-tools"), { recursive: true });
    await writeFile(join(REPO_DIR, ".audit-tools", "remediation-report.md"), "# Report\n", "utf8");

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.contract_version).toBe("remediate-code-step/v1alpha1");
    expect(step.step_kind).toBe("present_report");
    expect(step.status).toBe("complete");
    expect(step.artifact_paths.final_report).toMatch(/remediation-report\.md$/);
    expect(await readFile(step.prompt_path, "utf8")).toMatch(/Present Remediation Report/);
  });

  it("accepts options supplied as a JSON string", async () => {
    await saveState({ status: "complete" });
    await mkdir(join(REPO_DIR, ".audit-tools"), { recursive: true });
    await writeFile(join(REPO_DIR, ".audit-tools", "remediation-report.md"), "# Report\n", "utf8");

    const step = await decideNextStep(JSON.stringify({ root: REPO_DIR }));

    expect(step.step_kind).toBe("present_report");
    // prompt_path is normalized to forward slashes (FINDING-004), so compare
    // with the slash-normalized artifacts dir.
    expect(step.prompt_path).toContain(ARTIFACTS_DIR.replace(/\\/g, "/"));
  });

  it("rejects malformed JSON string and array options", async () => {
    await expect(decideNextStep("{bad")).rejects.toThrow(
      /decideNextStep options must be an object or JSON object string/i,
    );
    await expect(decideNextStep("[]")).rejects.toThrow(
      /decideNextStep options must be an object or JSON object string/i,
    );
  });

  it("loaderCommand renders argv tokens through the shared prompt command renderer", () => {
    expect(loaderCommand("next-step --force-replan")).toBe(
      "remediate-code next-step --force-replan",
    );
    expect(loaderCommand(["next-step", "--input", "C:\\Path With Spaces\\report.md"])).toBe(
      'remediate-code next-step --input "C:/Path With Spaces/report.md"',
    );
  });

  it("records started_at and increments step_count once per next-step invocation", async () => {
    await saveState(makePlanningState());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const firstState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(Date.parse(firstState.started_at)).not.toBeNaN();
    expect(firstState.step_count).toBe(1);

    await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const secondState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(secondState.started_at).toBe(firstState.started_at);
    expect(secondState.step_count).toBe(2);
  });

  it("stale remediation-report.md does not complete a fresh --input run", async () => {
    // A leftover report must NOT short-circuit a run that has fresh intent: with
    // a new --input, planning proceeds instead of declaring the prior run done.
    await mkdir(join(REPO_DIR, ".audit-tools"), { recursive: true });
    await writeFile(join(REPO_DIR, ".audit-tools", "remediation-report.md"), "# Stale prior run\n", "utf8");
    const inputPath = join(REPO_DIR, "new-brief.md");
    await writeFile(inputPath, "# A new brief\n", "utf8");

    const step = await decideNextStep({ root: REPO_DIR, input: inputPath });

    expect(step.step_kind).not.toBe("present_report");
  });

  it("re-presents the report on a bare re-invocation after a completed+cleaned run", async () => {
    // close deletes .audit-tools/remediation/state.json but leaves durable root
    // outputs. A bare next-step with no fresh intent should re-present the report.
    await mkdir(join(REPO_DIR, ".audit-tools"), { recursive: true });
    await writeFile(join(REPO_DIR, ".audit-tools", "remediation-report.md"), "# Done\n", "utf8");

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("present_report");
  });

  it("new --input against an in-progress run emits input_conflict instead of silently resuming", async () => {
    await saveState(makePlanningState());
    const inputPath = join(REPO_DIR, "new-feedback.md");
    await writeFile(inputPath, "# A different brief\n", "utf8");

    const step = await decideNextStep({ root: REPO_DIR, input: inputPath });

    expect(step.step_kind).toBe("input_conflict");
    expect(step.status).toBe("blocked");
    expect(await readFile(step.prompt_path, "utf8")).toMatch(/already exists/i);
  });

  it("writes a structured run log recording the state and resulting step", async () => {
    const step = await decideNextStep({ root: REPO_DIR });

    const logRaw = await readFile(join(ARTIFACTS_DIR, "run.log.jsonl"), "utf8");
    const events = logRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    // every line carries a timestamp
    expect(events.every((event) => typeof event.ts === "string")).toBe(true);

    const stateEvent = events.find((event) => event.kind === "state");
    expect(stateEvent?.phase).toBe("next-step");

    const stepEvent = events.find((event) => event.kind === "step");
    expect(stepEvent?.obligation).toBe(step.step_kind);
    expect(typeof stepEvent?.duration_ms).toBe("number");
  });

  it("does not write a run log when observability.run_log is disabled", async () => {
    await writeFile(
      join(REPO_DIR, "session-config.json"),
      JSON.stringify({ observability: { run_log: false } }),
      "utf8",
    );

    await decideNextStep({ root: REPO_DIR });

    expect(existsSync(join(ARTIFACTS_DIR, "run.log.jsonl"))).toBe(false);
  });

  it("missing input emits a conversation-first starting-point step", async () => {
    const step = await decideNextStep({ root: REPO_DIR });
    const currentStep = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "steps", "current-step.json"), "utf8"),
    );
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("collect_starting_point");
    expect(currentStep.step_kind).toBe("collect_starting_point");
    expect(prompt).toMatch(/document paths/i);
    expect(prompt).toMatch(/conversational feedback/i);
    expect(step.artifact_paths.source_manifest).toMatch(/source-manifest\.json$/);
  });

  it("explicit missing input emits a starting-point step with the missing path", async () => {
    const missingPath = join(REPO_DIR, "missing feedback.md");

    const step = await decideNextStep({ root: REPO_DIR, input: missingPath });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("collect_starting_point");
    expect(prompt).toContain(missingPath);
    expect(prompt).toMatch(/did not exist/i);
  });

  it("free-form Markdown enters intake synthesis instead of a zero-finding plan", async () => {
    const inputPath = join(REPO_DIR, "feedback.md");
    await writeFile(inputPath, "# Notes\n\nPlease clean up the auth flow.\n", "utf8");

    const step = await decideNextStep({ root: REPO_DIR, input: inputPath });
    const prompt = await readFile(step.prompt_path, "utf8");
    const manifest = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "intake", "source-manifest.json"), "utf8"),
    );

    expect(step.step_kind).toBe("synthesize_intake");
    expect(step.artifact_paths.intake_summary).toMatch(/intake-summary\.json$/);
    expect(prompt).toMatch(/Synthesize Remediation Intake/);
    expect(manifest.sources[0]).toMatchObject({
      type: "document",
      path: inputPath,
    });
  });

  it("conversation-start artifact enters intake synthesis", async () => {
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    const conversationPath = join(intakeDir, "conversation-start.md");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(
      conversationPath,
      "Please refactor the auth flow until the refresh behavior is clear.",
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR });
    const manifest = JSON.parse(
      await readFile(join(intakeDir, "source-manifest.json"), "utf8"),
    );

    expect(step.step_kind).toBe("synthesize_intake");
    expect(manifest.sources[0]).toMatchObject({
      type: "conversation",
      path: conversationPath,
    });
  });

  it("audit-looking Markdown without Work Blocks uses intake synthesis", async () => {
    const inputPath = join(REPO_DIR, "partial-audit-report.md");
    await writeFile(
      inputPath,
      `# Audit Report\n\n## Findings\n\n### F-001 — Missing block section\n- Severity: high\n- Confidence: high\n- Lens: security\n- Summary: Needs extraction.\n- Files: src/auth.ts\n- Evidence:\n  - evidence\n`,
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, input: inputPath });

    expect(step.step_kind).toBe("synthesize_intake");
    expect(await readFile(step.prompt_path, "utf8")).toMatch(/Synthesize Remediation Intake/);
  });

  it("ready document intake advances to one bounded contract-pipeline step", async () => {
    const inputPath = join(REPO_DIR, "feedback.md");
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(inputPath, "# Notes\n\nPlease clean up the auth flow.\n", "utf8");
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
        goals: ["Clean up the auth flow."],
        non_goals: [],
        constraints: [],
        affected_files: [{ path: "src/auth.ts" }],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "remediation-brief.md"),
      "# Remediation Brief\n\nClean up the auth flow.\n",
      "utf8",
    );
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("contract_pipeline");
    expect(step.artifact_paths.output).toMatch(/goal_spec\.json$/);
    expect(prompt).toMatch(/Goal Normalization/);
    expect(prompt).toMatch(/Stop after writing the output file/i);
    expect(prompt).not.toMatch(/Extract Findings From Intake Brief/);
  });

  it("contract pipeline resumes at the next missing artifact only", async () => {
    const inputPath = join(REPO_DIR, "feedback.md");
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(inputPath, "# Notes\n\nPlease clean up the auth flow.\n", "utf8");
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
        goals: ["Clean up the auth flow."],
        non_goals: [],
        constraints: [],
        affected_files: [{ path: "src/auth.ts" }],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "remediation-brief.md"),
      "# Remediation Brief\n\nClean up the auth flow.\n",
      "utf8",
    );
    await writeIntentCheckpoint();
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
      contract_version: "remediate-code-contract-pipeline/goal-spec/v1alpha1",
      goal_id: "G1",
      objective: "Clean up the auth flow.",
      non_goals: [],
      success_criteria: ["Auth flow cleanup is implemented."],
      source_type: "documents",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    const step = await decideNextStep({ root: REPO_DIR });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("contract_pipeline");
    expect(step.artifact_paths.output).toMatch(/context_bundle\.json$/);
    expect(prompt).toMatch(/Context Collection/);
    expect(prompt).not.toMatch(/Design\n/);
    expect(existsSync(join(ARTIFACTS_DIR, "extracted-plan.json"))).toBe(false);
  });

  it("completed implementation DAG promotes into the normal document dispatch flow", async () => {
    const inputPath = join(REPO_DIR, "feedback.md");
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(inputPath, "# Notes\n\nPlease clean up the auth flow.\n", "utf8");
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
        goals: ["Clean up the auth flow."],
        non_goals: [],
        constraints: [],
        affected_files: [{ path: "src/auth.ts" }],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "remediation-brief.md"),
      "# Remediation Brief\n\nClean up the auth flow.\n",
      "utf8",
    );
    await writeIntentCheckpoint();
    await acknowledgeResume();
    await writeCompleteContractPipelineDag();

    const step = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });
    const state = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    const dispatchPlan = JSON.parse(
      await readFile(step.artifact_paths.dispatch_plan, "utf8"),
    );
    const implPrompt = await readFile(dispatchPlan.items[0].prompt_path, "utf8");

    expect(step.step_kind).toBe("dispatch_implement");
    expect(state.plan.goal_id).toBe("G1");
    expect(state.plan.source).toBe("contract_pipeline");
    expect(state.plan.findings.map((finding: { id: string }) => finding.id)).toEqual(["CP-001"]);
    expect(state.plan.findings[0].contract_obligation_ids).toEqual(["O-1"]);
    expect(state.plan.findings[0].verification_obligation_ids).toEqual(["O-1"]);
    expect(state.plan.findings[0].targeted_commands).toEqual(["npm test"]);
    expect(implPrompt).toContain("Contract Pipeline Traceability");
    expect(implPrompt).toContain("Satisfies obligations: O-1");
    expect(implPrompt).toContain("Targeted commands: npm test");
    expect(existsSync(join(ARTIFACTS_DIR, "extracted-plan.json"))).toBe(true);
  });

  it("ready intake survives a default-candidate manifest re-derivation instead of looping", async () => {
    // Regression: when next-step runs without --input but a default audit-report
    // candidate exists, the resolver re-derives the source manifest every call.
    // An identical candidate set must not discard the persisted summary/brief and
    // re-emit synthesize_intake forever.
    const auditDir = join(REPO_DIR, ".audit-tools/audit");
    const reportPath = join(auditDir, "audit-report.md");
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(auditDir, { recursive: true });
    await mkdir(intakeDir, { recursive: true });
    await writeFile(reportPath, "# Audit Report\n\nFindings here.\n", "utf8");
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-source-manifest/v1alpha1",
        created_from: "default_candidates",
        sources: [{ type: "document", path: reportPath, label: "input-01" }],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-summary/v1alpha1",
        ready: true,
        source_type: "documents",
        goals: ["Fix only the critical bugs."],
        non_goals: ["Broad refactors."],
        constraints: [],
        affected_files: [{ path: "src/auth.ts" }],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "remediation-brief.md"),
      "# Remediation Brief\n\nCritical bugs only.\n",
      "utf8",
    );
    await writeIntentCheckpoint();

    // Run twice to prove it is not a one-shot escape: a stable candidate set must
    // keep advancing rather than oscillating back into synthesis.
    const first = await decideNextStep({ root: REPO_DIR });
    expect(first.step_kind).toBe("contract_pipeline");

    const second = await decideNextStep({ root: REPO_DIR });
    expect(second.step_kind).toBe("contract_pipeline");

    // The persisted summary must remain intact (scope preserved, not reset).
    const summary = JSON.parse(
      await readFile(join(intakeDir, "intake-summary.json"), "utf8"),
    );
    expect(summary.ready).toBe(true);
    expect(summary.goals).toContain("Fix only the critical bugs.");
  });

  it("prefers the structured audit-findings.json contract over the markdown render for default input", async () => {
    // Regression: with no --input, default discovery must pick the canonical
    // machine contract (lossless structured hand-off), not its human-facing
    // audit-report.md render sitting beside it (which forces a lossy LLM
    // re-extraction from prose). The JSON is the source of truth on both sides.
    const contract = await readFile(AUDITOR_CONTRACT_FIXTURE, "utf8");
    await writeFile(join(REPO_DIR, "audit-findings.json"), contract, "utf8");
    await writeFile(
      join(REPO_DIR, "audit-report.md"),
      "# Audit Report\n\n## Findings\n\n### DECOY-001 — must never be extracted\n",
      "utf8",
    );

    // N-R01: first call emits confirm_auto_discovered_input gate; write ack to proceed.
    const confirm = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });
    expect(confirm.step_kind).toBe("confirm_auto_discovered_input");
    await writeFile(
      join(ARTIFACTS_DIR, "confirm_auto_discovered_input_ack.json"),
      JSON.stringify({ status: "confirmed" }),
      "utf8",
    );

    const first = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });
    expect(first.step_kind).toBe("synthesize_intake");
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    const manifest = JSON.parse(
      await readFile(join(intakeDir, "source-manifest.json"), "utf8"),
    );
    expect(manifest.sources[0].type).toBe("structured_audit");

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
    await writeIntentCheckpoint();

    const step = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });

    // After intake, N-R06: structured_audit path enters the contract pipeline
    // (not direct plan). The path-A seed verifies the JSON contract is consumed
    // (not the markdown decoy), proving lossless structured hand-off.
    expect(step.step_kind).toBe("contract_pipeline");
    const { pathASeedFilePath } = await import("../src/contractPipeline/artifactStore.js");
    const { existsSync } = await import("node:fs");
    expect(existsSync(pathASeedFilePath(ARTIFACTS_DIR))).toBe(true);
  });

  it("structured fast path is gated by confirm_intent and honors checkpoint filters (FINDING-012)", async () => {
    // Regression: a lone audit-findings.json must NOT bypass the scope/intent
    // gate. The other structured-path tests pre-write the checkpoint, so this
    // is the only coverage of the no-checkpoint flow: ready structured intake
    // without intent_checkpoint.json must emit confirm_intent (not plan), and
    // the checkpoint's filters must then prune planning while the JSON
    // contract is still consumed losslessly (no LLM extraction).
    const contract = await readFile(AUDITOR_CONTRACT_FIXTURE, "utf8");
    await writeFile(join(REPO_DIR, "audit-findings.json"), contract, "utf8");

    // N-R01: first call emits confirm_auto_discovered_input gate; write ack to proceed.
    const confirm = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });
    expect(confirm.step_kind).toBe("confirm_auto_discovered_input");
    await writeFile(
      join(ARTIFACTS_DIR, "confirm_auto_discovered_input_ack.json"),
      JSON.stringify({ status: "confirmed" }),
      "utf8",
    );

    const first = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });
    expect(first.step_kind).toBe("synthesize_intake");

    const intakeDir = join(ARTIFACTS_DIR, "intake");
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

    const gated = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });
    expect(gated.step_kind).toBe("confirm_intent");
    const gatePrompt = await readFile(gated.prompt_path, "utf8");
    expect(gatePrompt).toMatch(/intent_checkpoint\.json/);

    await writeFile(
      join(ARTIFACTS_DIR, "intent_checkpoint.json"),
      JSON.stringify({
        schema_version: "intent-checkpoint/v1",
        confirmed_at: new Date().toISOString(),
        confirmed_by: "host",
        scope_summary: "Everything in the report",
        intent_summary: "High and critical findings only",
        filters: { severity: ["high", "critical"] },
      }),
      "utf8",
    );

    const step = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });

    // N-R06: structured_audit path now enters the contract pipeline after the
    // intent checkpoint is confirmed (not a direct plan/dispatch). The intent
    // gate still fires (confirm_intent before this call) and filters still apply
    // once the pipeline promotes an extracted-plan; the contract pipeline is the
    // new "fast path" for both structured_audit and document/conversation.
    expect(step.step_kind).toBe("contract_pipeline");
  });

  it("ambiguous intake summary asks for clarification before extraction", async () => {
    const inputPath = join(REPO_DIR, "feedback.md");
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(inputPath, "# Notes\n\nPlease clean up auth.\n", "utf8");
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
        ready: false,
        source_type: "documents",
        goals: ["Clean up auth."],
        non_goals: [],
        constraints: [],
        affected_files: [],
        open_questions: [
          {
            id: "Q-001",
            category: "scope_of_fix",
            question: "Which auth flow should change?",
            blocking: true,
          },
        ],
      }),
      "utf8",
    );
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Draft\n", "utf8");
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("collect_intake_clarifications");
    expect(prompt).toMatch(/Which auth flow should change/);
  });

  it("N-R06: auditor-rendered input enters the contract pipeline after intake is ready", async () => {
    // After N-R06: structured_audit no longer uses the runPlanPhase fast path.
    // Once intake is ready, the next step is contract_pipeline (goal_normalization).
    const first = await decideNextStep({
      root: REPO_DIR,
      input: AUDITOR_CONTRACT_FIXTURE,
      hostCanDispatchSubagents: true,
    });
    expect(first.step_kind).toBe("synthesize_intake");

    await writeReadyStructuredAuditIntake(AUDITOR_CONTRACT_FIXTURE);

    const step = await decideNextStep({
      root: REPO_DIR,
      input: AUDITOR_CONTRACT_FIXTURE,
      hostCanDispatchSubagents: true,
    });

    // Path A now enters the contract pipeline (goal_normalization) — not dispatch_document.
    expect(step.step_kind).toBe("contract_pipeline");
    // Verify the path-A seed was written so pipeline prompts can reference audit findings.
    const seedPath = join(ARTIFACTS_DIR, "intake", "contract", "path_a_seed.json");
    const seedRaw = await readFile(seedPath, "utf8");
    const seed = JSON.parse(seedRaw) as { finding_count: number; findings_summary: unknown[] };
    expect(seed.finding_count).toBeGreaterThan(0);
    expect(seed.findings_summary.length).toBeGreaterThan(0);
  });

  it("blocked clarifications emit one batched user prompt", async () => {
    await saveState({
      ...makePlanningState(),
      status: "waiting_for_clarification",
      clarifications: [
        {
          finding_id: "F-001",
          category: "scope_of_fix",
          description: "Clarify one.",
        },
        {
          finding_id: "F-002",
          category: "behavioral_semantics",
          description: "Clarify two.",
        },
      ],
    });
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("collect_clarifications");
    expect(prompt).toContain("F-001");
    expect(prompt).toContain("F-002");
    expect(prompt).toMatch(/one batched response/i);
  });

  it("clarification_resolution.json is applied and the run advances", async () => {
    await saveState({
      ...makePlanningState(),
      status: "waiting_for_clarification",
      clarifications: [
        { finding_id: "F-001", category: "scope_of_fix", description: "Clarify one." },
        { finding_id: "F-002", category: "issue_appropriateness", description: "Clarify two." },
      ],
    });
    await acknowledgeResume();
    await writeIntentCheckpoint();
    await writeFile(
      join(ARTIFACTS_DIR, "clarification_resolution.json"),
      JSON.stringify([
        { finding_id: "F-001", action: "clarified", rationale: "Scope is just the auth module." },
        { finding_id: "F-002", action: "deemed_inappropriate", rationale: "Not a real issue." },
      ]),
      "utf8",
    );

    // Folded: clarification resolution is applied and the run advances to dispatch
    // in a single decideNextStep call (no state_transition bounce).
    const dispatchStep = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });
    expect(dispatchStep.step_kind).toBe("dispatch_implement");

    const state = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    // clarified → re-opened as pending for implementation.
    expect(state.items["F-001"]).toMatchObject({
      status: "pending",
    });
    // deemed_inappropriate → terminal, rationale recorded as the failure reason.
    expect(state.items["F-002"]).toMatchObject({
      status: "deemed_inappropriate",
      failure_reason: "Not a real issue.",
    });
    expect(state.items["F-002"].completed_at).toBeTruthy();
    // A finding is pending again → planning transitions to implementing.
    expect(state.status).toBe("implementing");
    // The resolution is consumed (archived), so re-entry cannot re-apply it.
    expect(existsSync(join(ARTIFACTS_DIR, "clarification_resolution.json"))).toBe(false);

    // The dispatch includes only F-001 (F-002 is terminal).
    const dispatchPlan = JSON.parse(
      await readFile(dispatchStep.artifact_paths.dispatch_plan, "utf8"),
    );
    expect(dispatchPlan.items.length).toBeGreaterThan(0);
  });

  it("host can dispatch agents emits dispatch_implement and prepares artifacts", async () => {
    await saveState(makePlanningState());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });
    const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));

    expect(step.step_kind).toBe("dispatch_implement");
    expect(plan.contract_version).toBe("remediate-code-dispatch-plan/v1alpha1");
    expect(plan.items).toHaveLength(2);
  });

  it("omitted hostCanDispatchSubagents defaults to parallel dispatch (conversation-first)", async () => {
    await saveState(makePlanningState());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("dispatch_implement");
    expect(step.step_kind).not.toBe("capability_check");
  });

  it("session config host_can_dispatch_subagents=true enables dispatch without CLI flag", async () => {
    await saveState(makePlanningState());
    await acknowledgeResume();
    await writeIntentCheckpoint();
    const configPath = join(REPO_DIR, "session-config.json");
    await writeFile(configPath, JSON.stringify({ host_can_dispatch_subagents: true }), "utf8");

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("dispatch_implement");
  });

  it("closing state runs close inline and returns present_report", async () => {
    await saveState(
      makePlanningState({
        status: "closing",
        items: {
          "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
          "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
        },
      }),
    );
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // Folded: closing state runs close and returns present_report in one call.
    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("present_report");
  });

  it("finalize-closing runs close and returns present_report", async () => {
    await saveState(
      makePlanningState({
        status: "closing",
        items: {
          "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
          "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
        },
      }),
    );
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({
      root: REPO_DIR,
      finalizeClosing: true,
    });

    expect(step.step_kind).toBe("present_report");
    expect(step.status).toBe("complete");
    expect(existsSync(join(REPO_DIR, ".audit-tools", "remediation-report.md"))).toBe(true);
  });

  describe("retryable remediation-outcomes contract", () => {
    const OUTCOMES_PATH = join(REPO_DIR, ".audit-tools", "remediation-outcomes.json");

    function makeFinding(
      id: string,
      title: string,
      lens: string,
      path: string,
    ): NonNullable<RemediationState["plan"]>["findings"][number] {
      return {
        id,
        title,
        category: lens,
        severity: "high",
        confidence: "high",
        lens,
        summary: `Fix ${title.toLowerCase()}.`,
        affected_files: [{ path }],
        evidence: [`${path}:1 evidence`],
      };
    }

    function makeItemSpec(findingId: string, file: string) {
      return {
        finding_id: findingId,
        concrete_change: `fix ${file}`,
        no_change: false,
        touched_files: [file],
        tests_to_write: [{ name: `${findingId} regression`, assertions: ["holds"] }],
        not_applicable_steps: [],
      };
    }

    function makeRetryableClosingState(): RemediationState {
      return {
        status: "closing",
        plan: {
          plan_id: "PLAN-RETRY",
          findings: [
            makeFinding("F-001", "First", "correctness", "src/a.ts"),
            makeFinding("F-002", "Second", "security", "src/b.ts"),
            makeFinding("F-003", "Third", "tests", "src/c.ts"),
            makeFinding("F-004", "Fourth", "maintainability", "src/d.ts"),
          ],
          blocks: [
            { block_id: "B-001", items: ["F-001"], parallel_safe: true },
            {
              block_id: "B-002",
              items: ["F-002"],
              parallel_safe: false,
              dependencies: ["B-001"],
            },
            { block_id: "B-003", items: ["F-003", "F-004"], parallel_safe: true },
          ],
          project_type: "unknown",
          candidate_closing_actions: ["none"],
        },
        items: {
          "F-001": {
            finding_id: "F-001",
            status: "resolved",
            block_id: "B-001",
            item_spec: makeItemSpec("F-001", "src/a.ts"),
          },
          "F-002": {
            finding_id: "F-002",
            status: "blocked",
            block_id: "B-002",
            item_spec: makeItemSpec("F-002", "src/b.ts"),
            failure_reason: "Implementation failed: unit tests did not pass.",
          },
          "F-003": {
            finding_id: "F-003",
            status: "ignored",
            block_id: "B-003",
            failure_reason: "Ignored by user decision.",
          },
          "F-004": {
            finding_id: "F-004",
            status: "deemed_inappropriate",
            block_id: "B-003",
            // No failure_reason on purpose: skipped entries must still carry a
            // non-empty reason in the outcomes contract.
          },
        },
        closing_plan: { action: "none" },
      } as RemediationState;
    }

    async function readOutcomesReport(): Promise<any> {
      return JSON.parse(await readFile(OUTCOMES_PATH, "utf8"));
    }

    it("every terminal item carries its full finding payload, item-spec summary, block refs, and final status", async () => {
      const state = makeRetryableClosingState();
      await saveState(state);
      await acknowledgeResume();
      await writeIntentCheckpoint();

      // Folded: closing state runs close and returns present_report in one call.
      const step = await decideNextStep({ root: REPO_DIR });
      expect(step.step_kind).toBe("present_report");

      const report = await readOutcomesReport();
      const byId = new Map<string, any>(
        report.outcomes.map((entry: any) => [entry.finding_id, entry]),
      );

      // (a) Full original Finding payload, identical to the planned finding.
      for (const finding of state.plan!.findings) {
        expect(byId.get(finding.id)?.finding).toEqual(finding);
      }

      // (b) Item-spec summary matching the documented ItemSpec.
      expect(byId.get("F-001")?.item_spec).toEqual({
        concrete_change: "fix src/a.ts",
        no_change: false,
        touched_files: ["src/a.ts"],
        tests_to_write: ["F-001 regression"],
      });
      expect(byId.get("F-002")?.item_spec).toEqual({
        concrete_change: "fix src/b.ts",
        no_change: false,
        touched_files: ["src/b.ts"],
        tests_to_write: ["F-002 regression"],
      });

      // (c) Owning block id and that block's dependency ids.
      expect(byId.get("F-001")?.block_id).toBe("B-001");
      expect(byId.get("F-001")?.block_dependencies).toEqual([]);
      expect(byId.get("F-002")?.block_id).toBe("B-002");
      expect(byId.get("F-002")?.block_dependencies).toEqual(["B-001"]);
      expect(byId.get("F-003")?.block_id).toBe("B-003");

      // (d) Final status per terminal state.
      expect(byId.get("F-001")?.final_status).toBe("fixed");
      expect(byId.get("F-002")?.final_status).toBe("failed");
      expect(byId.get("F-003")?.final_status).toBe("ignored");
      expect(byId.get("F-004")?.final_status).toBe("skipped");

      // (e) Skipped and ignored items each carry a non-empty reason.
      expect(byId.get("F-003")?.reason).toBeTruthy();
      expect(byId.get("F-003")?.reason).toMatch(/ignored by user decision/i);
      expect(byId.get("F-004")?.reason).toBeTruthy();
    });

    it("force-close records non-terminal items as failed with the original state preserved", async () => {
      const state = makeRetryableClosingState();
      state.items!["F-002"] = {
        finding_id: "F-002",
        status: "pending",
        block_id: "B-002",
        item_spec: makeItemSpec("F-002", "src/b.ts"),
      };
      await saveState(state);
      await acknowledgeResume();
      await writeIntentCheckpoint();

      // Folded: closing runs to completion in one call.
      const step = await decideNextStep({ root: REPO_DIR });
      expect(step.step_kind).toBe("present_report");

      const report = await readOutcomesReport();
      const entry = report.outcomes.find((e: any) => e.finding_id === "F-002");
      expect(entry?.final_status).toBe("failed");
      expect(entry?.outcome).toBe("blocked");
      expect(entry?.original_state).toBe("pending");
      expect(entry?.reason).toMatch(/force-closed/i);
      expect(entry?.reason).toMatch(/non-terminal/i);
      expect(entry?.reason).toMatch(/pending/);
      // The force-closed item still carries its full payload for retry.
      expect(entry?.finding?.id).toBe("F-002");
    });

    it("never-planned findings appear in the coverage-ledger section with payloads and drop reasons", async () => {
      const fPlanned = makeFinding("F-001", "First", "correctness", "src/a.ts");
      const fDup = makeFinding("F-DUP", "First duplicate", "security", "src/a.ts");
      const fChk = makeFinding("F-CHK", "Checkpointed", "tests", "src/c.ts");

      // The structured-audit intake source is the payload authority for findings
      // that were dropped before the plan was written.
      const sourcePath = join(REPO_DIR, "audit-findings.json");
      await writeFile(
        sourcePath,
        JSON.stringify({
          contract_version: "audit-code-findings/v1alpha1",
          findings: [fPlanned, fDup, fChk],
          work_blocks: [],
        }),
        "utf8",
      );
      const intakeDir = join(ARTIFACTS_DIR, "intake");
      await mkdir(intakeDir, { recursive: true });
      await writeFile(
        join(intakeDir, "source-manifest.json"),
        JSON.stringify({
          schema_version: "remediate-code-intake-source-manifest/v1alpha1",
          created_from: "input",
          sources: [
            { type: "structured_audit", path: sourcePath, label: "audit-findings" },
          ],
        }),
        "utf8",
      );

      const state: RemediationState = {
        status: "closing",
        plan: {
          plan_id: "PLAN-COVERAGE",
          findings: [fPlanned],
          blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
          project_type: "unknown",
          candidate_closing_actions: ["none"],
        },
        items: {
          "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
        },
        closing_plan: { action: "none" },
        plan_coverage: {
          contract_version: "remediate-code-coverage/v1alpha1",
          plan_id: "PLAN-COVERAGE",
          source_finding_count: 3,
          planned_count: 1,
          folded_count: 1,
          dropped_count: 0,
          checkpoint_dropped_count: 1,
          phantom_dropped_count: 0,
          entries: [
            {
              finding_id: "F-001",
              title: "First",
              disposition: "planned",
              block_id: "B-001",
            },
            {
              finding_id: "F-DUP",
              title: "First duplicate",
              disposition: "folded_into",
              folded_into: "F-001",
            },
            {
              finding_id: "F-CHK",
              title: "Checkpointed",
              disposition: "dropped_by_checkpoint",
              rationale:
                "Finding excluded by the intent checkpoint (filter or excluded scope).",
            },
          ],
        },
      } as RemediationState;
      await saveState(state);
      await acknowledgeResume();
      await writeIntentCheckpoint();

      // Folded: closing runs to completion in one call.
      const step = await decideNextStep({ root: REPO_DIR });
      expect(step.step_kind).toBe("present_report");

      const report = await readOutcomesReport();
      const coverageEntries: any[] = report.plan_coverage.entries;

      const dup = coverageEntries.find((e) => e.finding_id === "F-DUP");
      expect(dup?.drop_reason).toBe("cross_lens_dedup");
      expect(dup?.finding).toEqual(fDup);

      const chk = coverageEntries.find((e) => e.finding_id === "F-CHK");
      expect(chk?.drop_reason).toBe("intent_checkpoint");
      expect(chk?.finding).toEqual(fChk);

      // No planned-or-dropped finding id from intake is absent from the union of
      // item entries and the coverage-ledger section.
      const recordedIds = new Set<string>([
        ...report.outcomes.map((e: any) => e.finding_id),
        ...coverageEntries.map((e) => e.finding_id),
      ]);
      for (const id of ["F-001", "F-DUP", "F-CHK"]) {
        expect(recordedIds.has(id)).toBe(true);
      }
    });

    it("close writes the enriched outcomes before deleting state.json", async () => {
      const state = makeRetryableClosingState();
      await saveState(state);
      await acknowledgeResume();
      await writeIntentCheckpoint();

      // Folded: closing runs to completion in one call.
      const step = await decideNextStep({ root: REPO_DIR });
      expect(step.step_kind).toBe("present_report");

      // state.json (the whole artifacts dir) is gone after close...
      expect(existsSync(join(ARTIFACTS_DIR, "state.json"))).toBe(false);
      // ...but the outcomes file was written first, from the pre-deletion state:
      // it carries payloads that exist only in state.json.
      const report = await readOutcomesReport();
      expect(report.outcomes).toHaveLength(4);
      for (const entry of report.outcomes) {
        expect(entry.finding?.id).toBe(entry.finding_id);
        expect(entry.finding?.summary).toBeTruthy();
        expect(entry.block_id).toBeTruthy();
      }
    });
  });

  it("N-R06: CLI next-step writes parseable JSON to stdout for structured-audit input entering contract pipeline", async () => {
    // After N-R06: structured-audit enters the contract pipeline, not runPlanPhase.
    // The output is still valid JSON with the step contract.
    await writeReadyStructuredAuditIntake(AUDIT_FIXTURE);

    const result = spawnSync(
      process.execPath,
      [WRAPPER, "next-step", "--root", REPO_DIR, "--input", AUDIT_FIXTURE],
      {
        cwd: REPO_DIR,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout).contract_version).toBe(
      "remediate-code-step/v1alpha1",
    );
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    // N-R06: no "Running Plan Phase" any more — structured audit enters contract pipeline
    expect(JSON.parse(result.stdout).step_kind).toBe("contract_pipeline");
  });

  it("CLI run is a deprecated parseable next-step alias", async () => {
    await writeReadyStructuredAuditIntake(AUDIT_FIXTURE);

    const result = spawnSync(
      process.execPath,
      [WRAPPER, "run", "--root", REPO_DIR, "--input", AUDIT_FIXTURE],
      {
        cwd: REPO_DIR,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout).contract_version).toBe(
      "remediate-code-step/v1alpha1",
    );
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    expect(result.stderr).toMatch(/`run` is deprecated/);
    // N-R06: no "Running Plan Phase" — structured audit enters contract pipeline
    expect(JSON.parse(result.stdout).step_kind).toBe("contract_pipeline");
  });

  it("CLI next-step accepts the backend-rendered --force-replan flag", () => {
    const result = spawnSync(
      process.execPath,
      [WRAPPER, "next-step", "--root", REPO_DIR, "--force-replan"],
      {
        cwd: REPO_DIR,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout).contract_version).toBe(
      "remediate-code-step/v1alpha1",
    );
  });

  it("force replan refreshes baselines and preserves unchanged documented item specs", async () => {
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(join(REPO_DIR, "src", "b.ts"), "export const b = 1;\n", "utf8");

    const implementingState: RemediationState = makePlanningState({
      status: "implementing",
      plan: {
        ...makePlanningState().plan!,
        findings: makePlanningState().plan!.findings.map((finding) => ({
          ...finding,
          affected_files: finding.affected_files.map((file) => ({
            ...file,
            hash_at_plan_time: "stale-plan-time-hash",
          })),
        })),
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
    });
    await saveState(implementingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify(makePlanningState().plan),
      "utf8",
    );
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", skip: [] }),
      "utf8",
    );

    const step = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
      forceReplan: true,
    });

    expect(step.step_kind).toBe("dispatch_implement");
    const savedState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(savedState.status).toBe("implementing");
    expect(savedState.items["F-001"].status).toBe("pending");
    expect(savedState.items["F-001"].item_spec.concrete_change).toBe("fix a");
    expect(
      savedState.plan.findings[0].affected_files[0].hash_at_plan_time,
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("planning state with zero pending findings emits zero_documentable_findings (not unhandled_state)", async () => {
    // A planning state where every item is already non-pending (e.g. resolved)
    // means documentableFindings() returns empty. The early guard must intercept
    // this before handleUnhandledState and emit a user-facing choice step.
    await saveState(
      makePlanningState({
        status: "planning",
        items: {
          "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
          "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
        },
      }),
    );
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("zero_documentable_findings");
    expect(step.status).toBe("blocked");
    expect(step.step_kind).not.toBe("unhandled_state");
    // All three choices must be present in the prompt.
    expect(prompt).toMatch(/intent.checkpoint/i);
    expect(prompt).toMatch(/--input/);
    expect(prompt).toMatch(/stop/i);
  });

  it("planning state with zero pending findings (mixed non-pending non-terminal) emits zero_documentable_findings", async () => {
    // documentableFindings() filters for status === 'pending'. When some items
    // are non-pending and non-terminal (e.g. 'blocked'), allItemsTerminal
    // returns false and no earlier branch matches, so the guard must fire.
    await saveState(
      makePlanningState({
        status: "planning",
        items: {
          "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
          "F-002": { finding_id: "F-002", status: "blocked", block_id: "B-002" },
        },
      }),
    );
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("zero_documentable_findings");
    expect(step.status).toBe("blocked");
    expect(step.step_kind).not.toBe("unhandled_state");
  });

  it("planning state with at least one pending finding still dispatches document step (regression guard)", async () => {
    // Ensure the zero_documentable_findings guard does NOT fire when findings remain.
    await saveState(makePlanningState());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("dispatch_implement");
    expect(step.step_kind).not.toBe("zero_documentable_findings");
  });

  it("implementing state with all items blocked and exhausted retries routes to collect_triage", async () => {
    // An implementing state where all items are 'blocked' at max rework count and an
    // ack file is present: auto-retry is skipped (rework_count >= MAX_AUTO_RETRIES),
    // so runTriagePhase writes triage_batch.json and returns waiting_for_triage.
    // handleImplementing wraps this in continueWithState; the next loop iteration
    // immediately returns the collect_triage step. This exercises the triage
    // fallback path that prevents stranded blocked items from looping indefinitely.
    await saveState(
      makePlanningState({
        status: "implementing",
        items: {
          "F-001": {
            finding_id: "F-001",
            status: "blocked",
            block_id: "B-001",
            failure_reason: "provider failed",
            rework_count: 2,
          },
          "F-002": {
            finding_id: "F-002",
            status: "blocked",
            block_id: "B-002",
            failure_reason: "provider failed",
            rework_count: 2,
          },
        },
      }),
    );
    await acknowledgeResume();
    await writeIntentCheckpoint();
    // Presence of the ack file triggers the auto-retry path inside runTriagePhase;
    // rework_count >= 2 (MAX_AUTO_RETRIES) suppresses auto-retry and falls through
    // to the waiting_for_triage exit.
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", skip: [] }),
      "utf8",
    );

    // Folded: implementing state runs triage and returns collect_triage in one call.
    const step = await decideNextStep({ root: REPO_DIR });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("collect_triage");
    expect(step.status).toBe("blocked");
    expect(prompt).toMatch(/triage/i);
    expect(prompt).toContain("Use `retry` for blocked, deferred, retry-later, or prerequisite-dependent work.");
  });

  it("waiting_for_triage consumes an existing triage_resolution before re-prompting", async () => {
    await saveState(
      makePlanningState({
        status: "waiting_for_triage",
        items: {
          "F-001": {
            finding_id: "F-001",
            status: "blocked",
            block_id: "B-001",
            failure_reason: "needs another implementation pass",
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
            status: "resolved",
            block_id: "B-002",
          },
        },
      }),
    );
    await acknowledgeResume();
    await writeIntentCheckpoint();
    await writeFile(
      join(ARTIFACTS_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [
          {
            finding_id: "F-001",
            action: "retry",
            rationale: "retry requested",
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
    const implementDir = join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement");
    const staleResultPath = join(implementDir, "implement-B-001.result.json");
    await mkdir(implementDir, { recursive: true });
    await writeFile(
      staleResultPath,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [
          {
            finding_id: "F-001",
            status: "blocked",
            failure_reason: "previous attempt failed",
          },
        ],
      }),
      "utf8",
    );

    let step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    while (step.step_kind === "state_transition") {
      step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    }

    expect(step.step_kind).toBe("dispatch_implement");
    expect(existsSync(join(ARTIFACTS_DIR, "triage_resolution.json"))).toBe(false);
    expect(existsSync(staleResultPath)).toBe(false);
    const implementFiles = await readdir(implementDir);
    expect(implementFiles.some((name) => name.startsWith("implement-B-001.result.json.stale-"))).toBe(true);
    expect(implementFiles.some((name) => name.startsWith("implement-B-001.md"))).toBe(true);
    const savedState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(savedState.items["F-001"].status).toBe("pending");
    expect(savedState.items["F-001"].rework_count).toBe(1);
  });
});

  it("buildImplementDispatchStep: declined ack marks all pending items deemed_inappropriate and returns continueWithState", async () => {
    // Set up a documenting state with two documented items
    const documentingState: RemediationState = makePlanningState({
      status: "implementing",
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
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // Write a "declined" ack file
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "declined", skip: [] }),
      "utf8",
    );

    let step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    while (step.step_kind === "state_transition") {
      step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    }

    // Should not dispatch — all items are terminal so the run folds straight
    // through closing to completion (which deletes the artifact dir, so the
    // durable evidence is the report in .audit-tools/).
    expect(["present_report", "run_close_action", "no_closing_actions"]).toContain(step.step_kind);

    // Both pending items were marked deemed_inappropriate before closing; the
    // completed run records them in outcomes with the declined rationale.
    const report = JSON.parse(
      await readFile(join(REPO_DIR, ".audit-tools", "remediation-outcomes.json"), "utf8"),
    );
    const outcomes = report.outcomes as Array<{
      finding_id: string;
      outcome: string;
      reason?: string;
    }>;
    const f1 = outcomes.find((e) => e.finding_id === "F-001");
    const f2 = outcomes.find((e) => e.finding_id === "F-002");
    expect(f1?.outcome).toBe("inappropriate");
    expect(f2?.outcome).toBe("inappropriate");
    expect(f1?.reason).toMatch(/declined by the user/i);
    expect(f2?.reason).toMatch(/declined by the user/i);
  });

  it("buildImplementDispatchStep: terminal items are not mutated when ack is declined", async () => {
    const documentingState: RemediationState = makePlanningState({
      status: "implementing",
      items: {
        "F-001": {
          finding_id: "F-001",
          status: "resolved",
          block_id: "B-001",
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
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "declined", skip: [] }),
      "utf8",
    );

    let step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    while (step.step_kind === "state_transition") {
      step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    }

    // The run completes (deleting the artifact dir), so assert on the durable
    // outcomes in .audit-tools/ rather than the now-removed state.json.
    const report = JSON.parse(
      await readFile(join(REPO_DIR, ".audit-tools", "remediation-outcomes.json"), "utf8"),
    );
    const outcomes = report.outcomes as Array<{ finding_id: string; outcome: string }>;
    const resolvedIds = outcomes.filter((e) => e.outcome === "resolved").map((e) => e.finding_id);
    const inappropriateIds = outcomes.filter((e) => e.outcome === "inappropriate").map((e) => e.finding_id);
    // Already-resolved item must not be touched — it stays in the resolved bucket
    // and never appears as deemed_inappropriate.
    expect(resolvedIds).toContain("F-001");
    expect(inappropriateIds).not.toContain("F-001");
    // Non-terminal item is marked deemed_inappropriate.
    expect(inappropriateIds).toContain("F-002");
  });

  it("buildImplementDispatchStep: confirmed ack with empty skip still dispatches implementation", async () => {
    const documentingState: RemediationState = makePlanningState({
      status: "implementing",
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
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // Write a reviewed risk file so the preview step is skipped
    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify([]),
      "utf8",
    );
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", skip: [] }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });

    // Items should NOT be marked deemed_inappropriate — dispatch proceeds
    expect(step.step_kind).toMatch(/dispatch_implement/);
    const savedState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(savedState.items["F-001"].status).toBe("pending");
    expect(savedState.items["F-002"].status).toBe("pending");
  });

  it("emits classify_impl_risks before implementation preview when reviewed risks are missing", async () => {
    const documentingState: RemediationState = makePlanningState({
      status: "implementing",
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
      },
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("classify_impl_risks");
    expect(step.artifact_paths.reviewed).toMatch(/impl_risk_reviewed\.json$/);
    expect(prompt).toMatch(/impl_risk_reviewed\.json/);
    expect(prompt).not.toMatch(/remove.*risk-review hop/i);
  });

  it("renders preview decision labels with reviewed reasons, pros and cons, and excludes no-change choices", async () => {
    const documentingState: RemediationState = makePlanningState({
      status: "implementing",
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
            tests_to_write: [{ name: "a.test", assertions: ["asserts a"] }],
            not_applicable_steps: [],
          },
        },
        "F-002": {
          finding_id: "F-002",
          status: "pending",
          block_id: "B-002",
          item_spec: {
            finding_id: "F-002",
            concrete_change: "already correct after prior change",
            no_change: true,
            touched_files: [],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      },
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();
    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_preliminary.json"),
      JSON.stringify({
        schema_version: "impl-risk-preliminary/v1",
        findings: [
          {
            finding_id: "F-001",
            title: "First",
            summary: "Fix first.",
            affected_files: ["src/a.ts"],
            concrete_change: "fix a",
            no_change: false,
            tests_to_write: [{ name: "a.test", assertions: ["asserts a"] }],
            preliminary_tier: "safe",
            preliminary_reason: "low blast radius",
          },
          {
            finding_id: "F-002",
            title: "Second",
            summary: "Already correct.",
            affected_files: ["src/b.ts"],
            concrete_change: "already correct after prior change",
            no_change: true,
            tests_to_write: [],
            preliminary_tier: "context_dependent",
            preliminary_reason: "no-op",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify({
        schema_version: "impl-risk-reviewed/v1",
        findings: [
          { finding_id: "F-001", tier: "safe", reason: "reviewed safe reason" },
          { finding_id: "F-002", tier: "context_dependent", reason: "reviewed no-op reason" },
        ],
      }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("preview_implement");
    expect(prompt).toContain("Straightforward");
    expect(prompt).toContain("Reviewed Reason");
    expect(prompt).toContain("Pros");
    expect(prompt).toContain("Cons");
    expect(prompt).toContain("reviewed safe reason");
    expect(prompt).toContain("Already Correct (no changes planned)");
    expect(prompt).toContain("ignored_findings");
    expect(prompt).not.toContain("Tier 1");
    expect(prompt).not.toContain("Tier 2");
    expect(prompt).not.toContain("Tier 3");
    // The ## Ignore Choices section was removed (N-D01 #23) — the tiered tables
    // already carry the full context; an extra duplicate list is noise.
    expect(prompt).not.toContain("## Ignore Choices");
    // F-001 appears in the Straightforward table (not in a separate Ignore Choices list)
    expect(prompt).toContain("F-001");
    expect(prompt).toContain("Straightforward");
    // F-002 is no-op — excluded from tier tables, listed only under Already Correct
    expect(prompt).toContain("F-002");
  });

  it("confirmed preview ack with ignored_findings marks only named items ignored and dispatches the rest", async () => {
    const documentingState: RemediationState = makePlanningState({
      status: "implementing",
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
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", ignored_findings: ["F-002"] }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const savedState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));

    expect(step.step_kind).toBe("dispatch_implement");
    expect(savedState.items["F-002"].status).toBe("ignored");
    expect(savedState.items["F-002"].failure_reason).toMatch(/implementation preview/i);
    expect(savedState.items["F-001"].status).toBe("pending");
    expect(plan.items.map((item: { block_id: string }) => item.block_id)).toContain("B-001");
    expect(plan.items.map((item: { block_id: string }) => item.block_id)).not.toContain("B-002");
  });

  it("implement phase dispatch sweep defaults to parallel after preview acknowledgment", async () => {
    const cases = [
      {
        options: { root: REPO_DIR },
        sessionConfig: null,
        stepKind: "dispatch_implement",
        itemCount: 2,
      },
      {
        options: { root: REPO_DIR, hostCanDispatchSubagents: true },
        sessionConfig: null,
        stepKind: "dispatch_implement",
        itemCount: 2,
      },
      {
        options: { root: REPO_DIR },
        sessionConfig: { host_can_dispatch_subagents: true },
        stepKind: "dispatch_implement",
        itemCount: 2,
      },
      {
        options: { root: REPO_DIR, hostCanDispatchSubagents: false },
        sessionConfig: null,
        stepKind: "implement_single_item",
        itemCount: 1,
      },
    ];

    for (const scenario of cases) {
      await resetTestRepo();
      await saveState(makeImplementingState());
      await acknowledgeResume();
      await writeIntentCheckpoint();
      await acknowledgeImplementationPreview();
      if (scenario.sessionConfig) {
        await writeFile(
          join(REPO_DIR, "session-config.json"),
          JSON.stringify(scenario.sessionConfig),
          "utf8",
        );
      }

      const step = await decideNextStep(scenario.options);
      const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));

      expect(step.step_kind).toBe(scenario.stepKind);
      expect(plan.items).toHaveLength(scenario.itemCount);
      if (scenario.stepKind === "implement_single_item") {
        expect(existsSync(step.artifact_paths.single_task_prompt)).toBe(true);
      }
    }
  });

  it("host cannot dispatch agents emits implement_single_item", async () => {
    const documentingState: RemediationState = makePlanningState({
      status: "implementing",
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
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // Write a confirmed ack to bypass the preview-ack gate
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", skip: [] }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: false });
    const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));

    expect(step.step_kind).toBe("implement_single_item");
    expect(plan.items.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(step.artifact_paths.single_task_prompt)).toBe(true);
    expect(await readFile(step.prompt_path, "utf8")).toMatch(/Implement One Remediation Block/);
  });

  it("host cannot dispatch agents ingests an existing implement result before prompting again", async () => {
    const documentingState: RemediationState = makePlanningState({
      status: "implementing",
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
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // Write a confirmed ack to bypass the preview-ack gate
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", skip: [] }),
      "utf8",
    );

    // Write a completed implement result for B-001
    const implResultDir = join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement");
    await mkdir(implResultDir, { recursive: true });
    await writeFile(
      join(implResultDir, "implement-B-001.result.json"),
      JSON.stringify({
        contract_version: "remediate-code-worker-result/v1alpha1",
        phase: "implement",
        item_results: [
          { finding_id: "F-001", status: "resolved", evidence: ["applied fix a"] },
        ],
      }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: false });
    const savedState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );

    // B-001 result was merged — F-001 should have advanced past 'documented'
    expect(savedState.items["F-001"].status).not.toBe("pending");
    // The next step targets B-002 (the second pending block)
    expect(step.step_kind).toBe("implement_single_item");
    expect(step.artifact_paths.result).toMatch(/implement-B-002\.result\.json$/);
  });

  it("deterministic transition fold: documenting with no implementable blocks advances to implementing and triage in one call", async () => {
    // documenting state with all items documented but no item_spec (no implementable blocks)
    // → handleDocumenting marks documented items blocked, sets status=implementing, folds
    // → handleImplementing runs triage (no blocked items with specs → all_terminal check fails)
    // → allItemsTerminal is still false (blocked items), so it emits collect_triage or unhandled_state
    // The key invariant: step_kind is NOT state_transition.
    const documentingState = makePlanningState({
      status: "implementing",
      items: {
        "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
        "F-002": { finding_id: "F-002", status: "pending", block_id: "B-002" },
      },
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step).toBeDefined();
    expect(step.step_kind).not.toBe("state_transition");
  });

  it("deterministic transition fold: implementing with all resolved folds all the way to present_report in one call", async () => {
    const implementingState = makePlanningState({
      status: "implementing",
      items: {
        "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
        "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
      },
    });
    await saveState(implementingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // implementing → triage (no-op, all resolved) → allTerminal → closing → present_report
    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("present_report");
  });

  it("deterministic transition fold: planning with all-terminal items emits zero_documentable_findings (N-R13)", async () => {
    // N-R13: document phase dissolved. A planning state where all items are already
    // terminal hits the zero_documentable_findings guard BEFORE allItemsTerminal,
    // presenting user choices instead of silently folding to present_report.
    const state = makePlanningState({
      status: "planning",
      items: {
        "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
        "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
      },
    });
    await saveState(state);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("zero_documentable_findings");
  });

  it("deterministic transition fold: closing state folds to present_report in one call", async () => {
    const state = makePlanningState({
      status: "closing",
      items: {
        "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
        "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
      },
    });
    await saveState(state);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("present_report");
  });

  it("MAX_ITERATIONS no longer exists as a symbol or loop construct", async () => {
    const filePath = join(__dirname, "../src/steps/nextStep.ts");
    const content = await readFile(filePath, "utf8");
    expect(content).not.toContain("MAX_ITERATIONS");
    expect(content).not.toContain("for (let iteration = 0;");
  });

  it("state_transition step_kind no longer emitted — step_count increments exactly once through folded transitions", async () => {
    const state = makePlanningState({
      status: "closing",
      step_count: 5,
      items: {
        "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
        "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
      },
    });
    await saveState(state);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    // Closing folds directly to present_report — no state_transition bounce.
    expect(step.step_kind).toBe("present_report");
    expect(step.step_kind).not.toBe("state_transition");

    const completeStatePath = join(REPO_DIR, ".audit-tools", "remediation-state.complete.json");
    const completedState = JSON.parse(await readFile(completeStatePath, "utf8"));
    // step_count incremented exactly once (from 5 to 6), even through multiple folded transitions.
    expect(completedState.step_count).toBe(6);
  });

  it("state_transition step_kind is not in the types union", async () => {
    const filePath = join(__dirname, "../src/steps/types.ts");
    const content = await readFile(filePath, "utf8");
    expect(content).not.toContain("state_transition");
  });

  it("emits confirm_intent step when intent_checkpoint.json is absent", async () => {
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-summary/v1alpha1",
        ready: true,
        source_type: "documents",
        goals: ["Clean up the auth flow."],
        non_goals: [],
        constraints: [],
        affected_files: [{ path: "src/auth.ts" }],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "remediation-brief.md"),
      "# Remediation Brief\n\nClean up the auth flow.\n",
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("confirm_intent");
    expect(step.status).toBe("ready");

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

    const nextStep = await decideNextStep({ root: REPO_DIR });
    expect(nextStep.step_kind).not.toBe("confirm_intent");
  });

describe("N-R01: confirm_resume_or_restart gate", () => {
  it("bare re-invocation with planning state emits confirm_resume_or_restart (blocked)", async () => {
    await saveState(makePlanningState({ status: "planning" }));
    // No confirm_resume_ack.json → gate fires

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("confirm_resume_or_restart");
    expect(step.status).toBe("blocked");
  });

  it("confirm_resume_or_restart prompt includes state status, plan_id, and item counts", async () => {
    await saveState(makePlanningState({ status: "planning" }));

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("confirm_resume_or_restart");
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toMatch(/planning/i);
    expect(prompt).toContain("PLAN-1");
    expect(prompt).toMatch(/pending/i);
  });

  it("confirm_resume_or_restart prompt lists resume, restart, and merge choices", async () => {
    await saveState(makePlanningState({ status: "planning" }));

    const step = await decideNextStep({ root: REPO_DIR });

    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toMatch(/resume/i);
    expect(prompt).toMatch(/restart/i);
    expect(prompt).toMatch(/merge/i);
  });

  it("with confirm_resume_ack.json choice=resume, does NOT emit confirm_resume_or_restart", async () => {
    await saveState(makePlanningState({ status: "planning" }));
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).not.toBe("confirm_resume_or_restart");
  });
});

describe("N-R01: extracted-plan fast-path does not bypass confirm_intent", () => {
  it("extracted-plan.json present with no checkpoint emits confirm_intent (not dispatch)", async () => {
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify(makePlanningState().plan),
      "utf8",
    );
    // No intent_checkpoint.json written

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("confirm_intent");
  });

  it("extracted-plan.json prompt references intent_checkpoint.json", async () => {
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify(makePlanningState().plan),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("confirm_intent");
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toMatch(/intent_checkpoint\.json/);
  });

  it("N-R06: with checkpoint + intake artifacts + extracted-plan, proceeds past confirm_intent to dispatch", async () => {
    // After N-R06: a pre-existing extracted-plan.json still works for resumability,
    // but intake artifacts must be present (the fast-path bypass without intake was removed).
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-source-manifest/v1alpha1",
        created_from: "input",
        sources: [{ type: "document", path: join(REPO_DIR, "notes.md"), label: "input-01" }],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-summary/v1alpha1",
        ready: true,
        source_type: "documents",
        goals: ["Fix all bugs"],
        non_goals: [],
        constraints: [],
        affected_files: [],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief\n", "utf8");
    await writeFile(join(REPO_DIR, "notes.md"), "# notes", "utf8");
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify(makePlanningState().plan),
      "utf8",
    );
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    // Should advance to planning / document dispatch — not blocked at confirm_intent
    expect(step.step_kind).not.toBe("confirm_intent");
  });
});

describe("resolveHostDispatchCapability", () => {
  it("returns the explicit flag when provided", () => {
    expect(resolveHostDispatchCapability({ hostCanDispatchSubagents: true })).toBe(true);
    expect(resolveHostDispatchCapability({ hostCanDispatchSubagents: false })).toBe(false);
  });

  it("reads session config when flag is undefined", () => {
    expect(
      resolveHostDispatchCapability({
        sessionConfig: { host_can_dispatch_subagents: true },
      }),
    ).toBe(true);
  });

  it("reads REMEDIATE_HOST_CAN_DISPATCH env var as fallback", () => {
    expect(
      resolveHostDispatchCapability({
        env: { REMEDIATE_HOST_CAN_DISPATCH: "true" } as any,
      }),
    ).toBe(true);
    expect(
      resolveHostDispatchCapability({
        env: { REMEDIATE_HOST_CAN_DISPATCH: "false" } as any,
      }),
    ).toBe(false);
  });

  it("defaults to true when nothing is configured (conversation-first parallel dispatch)", () => {
    expect(resolveHostDispatchCapability({ env: {} as any })).toBe(true);
  });

  it("CLI flag overrides session config", () => {
    expect(
      resolveHostDispatchCapability({
        hostCanDispatchSubagents: false,
        sessionConfig: { host_can_dispatch_subagents: true },
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// N-D01: verified-defect table standalone fixes
// ---------------------------------------------------------------------------

describe("N-D01: preview ack plan_id binding (#22)", () => {
  async function makeImplementingStateWithItems(): Promise<RemediationState> {
    return makePlanningState({
      status: "implementing",
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
    });
  }

  it("stale ack with mismatched plan_id is rejected and preview is re-emitted", async () => {
    await saveState(await makeImplementingStateWithItems());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // Write reviewed risk so we reach the preview step
    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify({ schema_version: "impl-risk-reviewed/v1", findings: [] }),
      "utf8",
    );

    // Write an ack with a DIFFERENT plan_id than the current plan ("PLAN-1")
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", ignored_findings: [], plan_id: "PLAN-STALE" }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });

    // Ack should be rejected → preview step re-emitted, not dispatch
    expect(step.step_kind).toBe("preview_implement");
    // Stale ack file should be deleted
    expect(existsSync(join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"))).toBe(false);
  });

  it("matching plan_id in ack is accepted and dispatch proceeds", async () => {
    await saveState(await makeImplementingStateWithItems());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify({ schema_version: "impl-risk-reviewed/v1", findings: [] }),
      "utf8",
    );

    // Write ack with correct plan_id ("PLAN-1" matches makePlanningState default)
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", ignored_findings: [], plan_id: "PLAN-1" }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });

    // Ack is accepted → dispatch proceeds
    expect(step.step_kind).toBe("dispatch_implement");
  });

  it("ack without plan_id field is accepted (backward compat: identity binding only when plan_id present)", async () => {
    await saveState(await makeImplementingStateWithItems());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify({ schema_version: "impl-risk-reviewed/v1", findings: [] }),
      "utf8",
    );

    // Legacy ack without plan_id — should still be honored
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", ignored_findings: [] }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });

    expect(step.step_kind).toBe("dispatch_implement");
  });

  it("preview prompt includes plan_id in the ack schema example", async () => {
    await saveState(await makeImplementingStateWithItems());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // No reviewed file — triggers classify_impl_risks first; write it so we get preview
    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify({ schema_version: "impl-risk-reviewed/v1", findings: [
        { finding_id: "F-001", tier: "safe", reason: "simple fix" },
        { finding_id: "F-002", tier: "safe", reason: "simple fix" },
      ] }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("preview_implement");
    expect(prompt).toMatch(/plan_id/);
    expect(prompt).toContain("PLAN-1");
  });
});

describe("N-D01: preview prompt does not include redundant Ignore Choices section (#23)", () => {
  it("preview_implement prompt does NOT contain ## Ignore Choices section", async () => {
    const state = makePlanningState({
      status: "implementing",
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
            tests_to_write: [{ name: "test-a", assertions: ["asserts a"] }],
            not_applicable_steps: [],
          },
        },
      },
    });
    await saveState(state);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify({ schema_version: "impl-risk-reviewed/v1", findings: [
        { finding_id: "F-001", tier: "safe", reason: "simple fix" },
      ] }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("preview_implement");
    expect(prompt).not.toContain("## Ignore Choices");
    // Tiered tables are still present
    expect(prompt).toMatch(/Straightforward|Substantive|Operator Context/);
  });
});
