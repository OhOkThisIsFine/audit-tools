import { bindContractReviewPrompt } from "../../src/remediate/contractPipeline/contractReviewBinding.js";
import { ReviewSubmissionEnvelopeSchema } from "../../src/shared/types/reviewIndependence.js";
import { ANALYZER_SETTINGS } from "../../src/shared/analyzerPolicy.js";
import { AnalyzerRunConsentDecisionSchema } from "../../src/shared/analyzerRunConsent.js";
import { REVIEW_NECESSITY_ORDER } from "../../src/remediate/review/reviewNecessity.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderConfirmIntentPrompt } from "../../src/audit/cli/confirmIntentStep.js";
import { renderAnalyzerConsentPrompt, renderAnalyzerInstallPrompt, renderEdgeReasoningDispatchPrompt, renderPresentReportPrompt } from "../../src/audit/cli/prompts.js";
import { functionalPreflightStep, FunctionalPreflightSchema } from "../../src/audit/cli/functionalPreflight.js";
import { ambiguityReviewPrompt, clarificationPrompt, collectIntakeClarificationsPrompt, collectStartingPointPrompt, extractedPlanDiscardedPrompt, reviewApprovalPrompt, triagePrompt } from "../../src/remediate/steps/prompts.js";
import { intakePaths, INTAKE_SUMMARY_SCHEMA_VERSION } from "../../src/remediate/intake.js";
import { buildReviewRequest } from "../../src/remediate/review/reviewGate.js";
import { renderBlockedStepPrompt } from "../../src/shared/io/stepContractWriter.js";
import { makeState } from "../remediate/test-helpers.js";
import type { PromptContractRegistryRow } from "./promptContractRegistry.js";

const paths = intakePaths("registry-fixture");
const continueCommand = "audit-code next-step --root registry-fixture";
const answerPath = "registry-fixture/operator-answer.json";
const question = { finding_id: "F-CHOICE", category: "scope_of_fix" as const, description: "Keep the public API?", options: ["keep", "replace"] };
const continuation = /(?:next-step|stop|Do not run the orchestrator again)/i;

/** Test expectations for real driver renders; these do not define a second runtime output schema. */
function row(builder: string, file: string, renderDriver: NonNullable<PromptContractRegistryRow["renderDriver"]>, checks: NonNullable<PromptContractRegistryRow["driverChecks"]>, profile: "driver" | "dispatch" = "driver"): PromptContractRegistryRow {
  return { builder, file, disposition: profile, renderDriver, driverChecks: checks };
}
const checks = (inputs: string[], outputs: string[], choices: string[] = []) => ({
  actor: /(?:user|operator|host|you|present|report)/i,
  action: /(?:ask|write|read|execute|choose|record|present|correct|stop)/i,
  inputs, outputs, choices, continuation,
});
const remediateFile = "src/remediate/steps/prompts.ts";
const auditFile = "src/audit/cli/prompts.ts";

export const driverPromptRows: PromptContractRegistryRow[] = [
  row("renderConfirmIntentPrompt", "src/audit/cli/confirmIntentStep.ts", () => renderConfirmIntentPrompt({
    mode: "full", since: null, files_in_scope: 1, scope_dirs: [{ dir: "src/scheduling", files: 1 }],
    excluded_summary: [], disposition_override_proposals: [], lens_propositions: [], docs_digest: [], mis_scope_smells: [],
  }, { intentCheckpointPath: answerPath, continueCommand }), checks(["src/scheduling"], [answerPath, "confirmed_by", "confirmed_at"], ["shallow", "deep"])),
  row("renderAnalyzerConsentPrompt", auditFile, () => renderAnalyzerConsentPrompt({
    pending: [{ id: "fixture-scanner", runner: "npm", spec: "fixture-scanner@1.0.0", purpose: "Find the fixture defect", safetyProfile: { config_execution: "executable", network_egress: true, version_pinning: "pinned" } }],
    decisionsPath: answerPath, continueCommand,
  }), checks(["fixture-scanner", "Find the fixture defect"], [answerPath], [...AnalyzerRunConsentDecisionSchema.options])),
  row("renderAnalyzerInstallPrompt", auditFile, () => renderAnalyzerInstallPrompt({
    unresolved: [{ id: "typescript", dependency: "typescript", supportedCount: 1, setting: "auto", resolution: "absent" }],
    decisionsPath: answerPath, continueCommand,
  }), { ...checks(["typescript"], [answerPath], [...ANALYZER_SETTINGS]), actor: /(?:ask|operator|user)/i }),
  row("renderEdgeReasoningDispatchPrompt", auditFile, () => renderEdgeReasoningDispatchPrompt({ promptPath: "registry-fixture/edges-prompt.md", resultsPath: answerPath, continueCommand, contentHash: "fixture-content-hash", candidateCount: 1, scratchDirPath: "registry-fixture/scratch" }), checks(["registry-fixture/edges-prompt.md", "registry-fixture/scratch", "fixture-content-hash"], [answerPath]), "dispatch"),
  row("renderPresentReportPrompt", auditFile, () => renderPresentReportPrompt("registry-fixture/audit-report.md"), checks(["registry-fixture/audit-report.md"], ["Present", "Do not run the orchestrator again"])),
  row("ambiguityReviewPrompt", remediateFile, () => ambiguityReviewPrompt([question], answerPath, [question.finding_id], undefined, "registry-fixture/ambiguity-request.json"), checks([question.finding_id, question.description, "registry-fixture/ambiguity-request.json"], [answerPath, "finding_id", "action", "rationale"], ["[]"])),
  row("clarificationPrompt", remediateFile, () => clarificationPrompt([question], answerPath), checks([question.finding_id, question.description], [answerPath, "finding_id", "action", "rationale"], question.options)),
  row("collectIntakeClarificationsPrompt", remediateFile, () => collectIntakeClarificationsPrompt({
    schema_version: INTAKE_SUMMARY_SCHEMA_VERSION, ready: false, source_type: "conversation", goals: [], non_goals: [], constraints: [], affected_files: [],
    open_questions: [{ id: "Q-CHOICE", question: "Which API is public?", blocking: true }], source_summary: "Fixture task", acceptance_criteria: [], scope_summary: "Fixture", intent_summary: "Fixture", filters: {},
  }, paths), checks(["Q-CHOICE", "Which API is public?"], [paths.clarificationResolution, "question_id", "answer"])),
  row("collectStartingPointPrompt", remediateFile, () => collectStartingPointPrompt("registry-fixture", ["registry-fixture/audit-findings.json"], ["registry-fixture/missing.json"], paths), checks(["registry-fixture/missing.json", "registry-fixture/audit-findings.json"], ["--input", "--guidance"])),
  row("extractedPlanDiscardedPrompt", remediateFile, () => extractedPlanDiscardedPrompt("Unknown finding F-BAD", "registry-fixture/original-plan.json", paths), checks(["Unknown finding F-BAD", "registry-fixture/original-plan.json"], [paths.extractedPlan])),
  row("reviewApprovalPrompt", remediateFile, () => reviewApprovalPrompt(buildReviewRequest([{ id: "F-REVIEW", title: "Preserve fixture API", category: "General", severity: "high", confidence: "high", lens: "correctness", summary: "The public API drops a required field", affected_files: [{ path: "src/api.ts" }], evidence: ["src/api.ts#handler"] }], "PLAN-CHOICE"), answerPath), checks(["F-REVIEW", "The public API drops a required field"], [answerPath, "declined_findings", "declined_tiers"], [...REVIEW_NECESSITY_ORDER])),
  row("triagePrompt", remediateFile, () => triagePrompt(makeState({ status: "waiting_for_triage", items: { "F-CHOICE": { finding_id: "F-CHOICE", status: "blocked", block_id: "B-CHOICE", failure_reason: "Fixture test fails" } } }), answerPath), checks(["F-CHOICE", "Fixture test fails"], [answerPath, "finding_id", "action", "rationale"], ["retry", "ignore", "halt"])),
  row("renderBlockedStepPrompt", "src/shared/io/stepContractWriter.ts", () => renderBlockedStepPrompt("audit-code", "Fixture infrastructure unavailable"), checks(["Fixture infrastructure unavailable"], ["Report this blocker", "stop"])),
  row("bindContractReviewPrompt", "src/remediate/contractPipeline/contractReviewBinding.ts", async () => {
    const root = await mkdtemp(join(tmpdir(), "prompt-bound-review-"));
    try { return await bindContractReviewPrompt({ artifactsDir: root, artifact: "judge_report", role: "judge", emissionId: "registry-emission", requirement: "independent", prompt: "Reviewer: read registry-fixture/contract.json and assess the result. Write the result to registry-fixture/judge.input.json, then stop." }); }
    finally { await rm(root, { recursive: true, force: true }); }
  }, { ...checks(["registry-fixture/contract.json"], ["registry-fixture/judge.input.json", "prompt_sha256", "review", "result"], ["independent", "unavailable"]), actor: /Reviewer/, exampleSchema: ReviewSubmissionEnvelopeSchema }, "dispatch"),
  row("functionalPreflightStep", "src/audit/cli/functionalPreflight.ts", async () => {
    const root = await mkdtemp(join(tmpdir(), "prompt-preflight-"));
    try { return (await functionalPreflightStep(root, join(root, ".audit-tools", "audit")))!.prompt; }
    finally { await rm(root, { recursive: true, force: true }); }
  }, { ...checks(["source_inspection", "relationship_inspection"], ["functional-preflight.json", "run_id", "repository_root"], ["ready", "degraded", "stop"]), exampleSchema: FunctionalPreflightSchema }),
];
