import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { REMEDIATION_WORKER_RESULT_CONTRACT_VERSION } from "../../src/remediate/steps/types.js";
import { writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  createNextStepHarness,
  makePlanningState,
  AUDIT_FIXTURE,
  AUDITOR_CONTRACT_FIXTURE,
  WRAPPER,
} from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-next-step-pipeline-dispatch");
const { REPO_DIR, ARTIFACTS_DIR, saveState, acknowledgeResume, writeIntentCheckpoint, writeReadyStructuredAuditIntake, approveReviewGate, writeCompleteContractPipelineDag } = harness;

let prevRollingEngine: string | undefined;
beforeEach(async () => {
  await harness.resetTestRepo();
  prevRollingEngine = process.env.REMEDIATE_ROLLING_ENGINE;
  process.env.REMEDIATE_ROLLING_ENGINE = "false";
});

afterEach(async () => {
  await harness.cleanupTestRepo();
  if (prevRollingEngine === undefined) delete process.env.REMEDIATE_ROLLING_ENGINE;
  else process.env.REMEDIATE_ROLLING_ENGINE = prevRollingEngine;
});
describe("decideNextStep — contract pipeline, dispatch, closing, and CLI", () => {
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
    expect(step.artifact_paths.output).toMatch(/goal_spec\.input\.json$/);
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
    expect(step.artifact_paths.output).toMatch(/context_bundle\.input\.json$/);
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
    await approveReviewGate();

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
    // The obligation/goal ids and provenance-only targeted_commands stay on the
    // finding in state (asserted above) but are worker-irrelevant decoration, so
    // the implement prompt no longer re-inlines the Contract Pipeline
    // Traceability section. The RUNNABLE per-node commands are emitted separately
    // (build-free subset only; `npm test` is build-prepending → filtered out).
    expect(implPrompt).not.toContain("Contract Pipeline Traceability");
    expect(implPrompt).not.toContain("Satisfies obligations: O-1");
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
    // Past the review-approval gate (approve-all) so the run reaches the pipeline.
    await approveReviewGate();

    const step = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });

    // After intake, N-R06: structured_audit path enters the contract pipeline
    // (not direct plan). The path-A seed verifies the JSON contract is consumed
    // (not the markdown decoy), proving lossless structured hand-off.
    expect(step.step_kind).toBe("contract_pipeline");
    const { pathASeedFilePath } = await import("../../src/remediate/contractPipeline/artifactStore.js");
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
    // Past the review-approval gate (approve-all) so the run reaches the pipeline.
    await approveReviewGate();

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
    // Past the review-approval gate (approve-all) so the run reaches the pipeline.
    await approveReviewGate();

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
        { finding_id: "F-002", action: "reject_finding", rationale: "Not a real issue." },
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
    // reject_finding → terminal deemed_inappropriate disposition, rationale recorded.
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
    await approveReviewGate();

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
    await approveReviewGate();
    // default-rolling routing is covered in next-step-implement-dispatch.test.ts; this pins the wave opt-out

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("dispatch_implement");
    expect(step.step_kind).not.toBe("capability_check");
  });

  it("session config host_can_dispatch_subagents=true enables dispatch without CLI flag", async () => {
    await saveState(makePlanningState());
    await acknowledgeResume();
    await writeIntentCheckpoint();
    await approveReviewGate();
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
    // status is "ready" (friction triage pending) — the test doesn't have a
    // passing test command so close isn't fully-green; the friction record is
    // materialized on this call with needs_open_observations=true.
    expect(step.status).toBe("ready");
    expect(existsSync(join(REPO_DIR, ".audit-tools", "remediation-report.md"))).toBe(true);
  });

  it("N-R06: CLI next-step writes parseable JSON to stdout for structured-audit input entering contract pipeline", async () => {
    // After N-R06: structured-audit enters the contract pipeline, not runPlanPhase.
    // The output is still valid JSON with the step contract.
    await writeReadyStructuredAuditIntake(AUDIT_FIXTURE);
    // Past the review-approval gate (approve-all) so the run reaches the pipeline.
    await approveReviewGate();

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

  it("CLI run alias is deleted (next-step is the only loop)", async () => {
    const result = spawnSync(
      process.execPath,
      [WRAPPER, "run", "--root", REPO_DIR],
      {
        cwd: REPO_DIR,
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown command/i);
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
      // V2 staging-manifest fields: a force-replan must CARRY these run-lifetime
      // values verbatim — dropping them would make the capture-once guard
      // re-snapshot AFTER edits landed (misclassifying the run's own edits as
      // pre-existing dirt) and lose the git-proven applied surface.
      run_start_dirty: ["pre-dirty.txt"],
      applied_edit_surface: ["src/landed.ts"],
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
    await approveReviewGate();

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
    // Carried verbatim across the force-replan — not dropped, not re-captured
    // (src/a.ts and src/b.ts are dirty right now; a post-edit re-capture would
    // have swept them into run_start_dirty).
    expect(savedState.run_start_dirty).toEqual(["pre-dirty.txt"]);
    expect(savedState.applied_edit_surface).toEqual(["src/landed.ts"]);
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
    await approveReviewGate();

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

    // Folded: implementing state runs triage and returns collect_triage in one
    // call — rework_count >= 2 (MAX_AUTO_RETRIES) suppresses auto-retry, so the
    // blocked item falls through to the waiting_for_triage exit.
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
