import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile } from "@audit-tools/shared";
import { StateStore } from "../state/store.js";
import {
  validateClarificationRequest,
  validateDocumentResponse,
  validateItemSpec,
  validateRemediationPlan,
  validateTriageResolution,
} from "./remediationState.js";
import {
  type ValidationIssue,
  formatValidationIssues,
  isRecord,
  pushValidationIssue,
} from "@audit-tools/shared";
import {
  REMEDIATION_CLOSING_RESULT_CONTRACT_VERSION,
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_STEP_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../steps/types.js";
import {
  validateVerificationReport,
} from "./contractPipeline.js";
import {
  CP_ARTIFACT_NAMES,
  contractPipelineDir,
} from "../contractPipeline/artifactStore.js";
import {
  validateGoalSpec,
  validateContextBundle,
  validateDesignSpec,
  validateConceptualDesignCritique,
  validateObligationLedger,
  validateContractAssessmentReport,
  validateCounterexample,
  validateJudgeReport,
  validateImplementationDAG,
} from "./contractPipeline.js";

export interface ArtifactValidationResult {
  status: "ok" | "error";
  issue_count: number;
  issues: string[];
}

async function readJsonForValidation(
  path: string,
  issues: string[],
): Promise<unknown | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return await readJsonFile<unknown>(path);
  } catch (error) {
    issues.push(`Invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

function validateStringArray(
  value: unknown,
  label: string,
  issues: ValidationIssue[],
): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    pushValidationIssue(issues, label, `${label} must be an array of strings.`);
  }
}

function validateCurrentStep(value: unknown, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== REMEDIATION_STEP_CONTRACT_VERSION) {
    pushValidationIssue(issues, `${path}.contract_version`, `${path} has unsupported contract_version.`);
  }
  for (const key of [
    "step_kind",
    "status",
    "prompt_path",
    "run_id",
    "repo_root",
    "artifacts_dir",
    "stop_condition",
  ]) {
    if (typeof value[key] !== "string") {
      pushValidationIssue(issues, `${path}.${key}`, `${path}.${key} must be a string.`);
    }
  }
  validateStringArray(value.allowed_commands, `${path}.allowed_commands`, issues);
  if (!isRecord(value.artifact_paths)) {
    pushValidationIssue(issues, `${path}.artifact_paths`, `${path}.artifact_paths must be an object.`);
  }
  if (typeof value.prompt_path === "string" && !existsSync(value.prompt_path)) {
    pushValidationIssue(issues, `${path}.prompt_path`, `${path}.prompt_path points to a missing file: ${value.prompt_path}.`);
  }
  return issues;
}

function validateDispatchPlan(
  value: unknown,
  path: string,
): { issues: ValidationIssue[]; phase?: "document" | "implement"; resultPaths: string[] } {
  const issues: ValidationIssue[] = [];
  const resultPaths: string[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return { issues, resultPaths };
  }
  if (value.contract_version !== REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION) {
    pushValidationIssue(issues, `${path}.contract_version`, `${path} has unsupported contract_version.`);
  }
  const phase =
    value.phase === "document" || value.phase === "implement"
      ? value.phase
      : undefined;
  if (!phase) {
    pushValidationIssue(issues, `${path}.phase`, `${path}.phase must be document or implement.`);
  }
  for (const key of ["run_id", "repo_root", "artifacts_dir"]) {
    if (typeof value[key] !== "string") {
      pushValidationIssue(issues, `${path}.${key}`, `${path}.${key} must be a string.`);
    }
  }
  if (!Array.isArray(value.items)) {
    pushValidationIssue(issues, `${path}.items`, `${path}.items must be an array.`);
    return { issues, phase, resultPaths };
  }
  for (const [index, item] of value.items.entries()) {
    const itemPath = `${path}.items[${index}]`;
    if (!isRecord(item)) {
      pushValidationIssue(issues, itemPath, `${itemPath} must be an object.`);
      continue;
    }
    for (const key of ["task_id", "prompt_path", "result_path"]) {
      if (typeof item[key] !== "string") {
        pushValidationIssue(issues, `${itemPath}.${key}`, `${itemPath}.${key} must be a string.`);
      }
    }
    if (phase === "document" && typeof item.finding_id !== "string") {
      pushValidationIssue(issues, `${itemPath}.finding_id`, `${itemPath}.finding_id must be a string for document dispatch.`);
    }
    if (phase === "implement" && typeof item.block_id !== "string") {
      pushValidationIssue(issues, `${itemPath}.block_id`, `${itemPath}.block_id must be a string for implement dispatch.`);
    }
    if (typeof item.prompt_path === "string" && !existsSync(item.prompt_path)) {
      pushValidationIssue(issues, `${itemPath}.prompt_path`, `${itemPath}.prompt_path points to a missing file: ${item.prompt_path}.`);
    }
    if (typeof item.result_path === "string") {
      resultPaths.push(item.result_path);
    }
  }
  return { issues, phase, resultPaths };
}

export function validateImplementWorkerResult(
  value: unknown,
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} implement worker result must be an object.`);
    return issues;
  }
  if (value.contract_version !== REMEDIATION_WORKER_RESULT_CONTRACT_VERSION) {
    pushValidationIssue(issues, `${path}.contract_version`, `${path} implement worker result has unsupported contract_version.`);
  }
  if (value.phase !== "implement") {
    pushValidationIssue(issues, `${path}.phase`, `${path} implement worker result phase must be implement.`);
  }
  if (!Array.isArray(value.item_results)) {
    pushValidationIssue(issues, `${path}.item_results`, `${path} implement worker result item_results must be an array.`);
    return issues;
  }
  for (const [index, result] of value.item_results.entries()) {
    const resultPath = `${path}.item_results[${index}]`;
    if (!isRecord(result)) {
      pushValidationIssue(issues, resultPath, `${resultPath} must be an object.`);
      continue;
    }
    if (typeof result.finding_id !== "string") {
      pushValidationIssue(issues, `${resultPath}.finding_id`, `${resultPath}.finding_id must be a string.`);
    }
    if (result.status !== "resolved" && result.status !== "blocked") {
      pushValidationIssue(issues, `${resultPath}.status`, `${resultPath}.status must be resolved or blocked.`);
    }
  }
  return issues;
}

function validateClosingResult(value: unknown, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== REMEDIATION_CLOSING_RESULT_CONTRACT_VERSION) {
    pushValidationIssue(issues, `${path}.contract_version`, `${path}.contract_version is unsupported.`);
  }
  if (typeof value.action !== "string") {
    pushValidationIssue(issues, `${path}.action`, `${path}.action must be a string.`);
  }
  if (!["success", "failed", "skipped"].includes(String(value.status))) {
    pushValidationIssue(issues, `${path}.status`, `${path}.status must be success, failed, or skipped.`);
  }
  if (!Array.isArray(value.commands)) {
    pushValidationIssue(issues, `${path}.commands`, `${path}.commands must be an array.`);
    return issues;
  }
  for (const [index, command] of value.commands.entries()) {
    const commandPath = `${path}.commands[${index}]`;
    if (!isRecord(command)) {
      pushValidationIssue(issues, commandPath, `${commandPath} must be an object.`);
      continue;
    }
    validateStringArray(command.command, `${commandPath}.command`, issues);
    if (
      command.exit_code !== null &&
      (typeof command.exit_code !== "number" || !Number.isInteger(command.exit_code))
    ) {
      pushValidationIssue(issues, `${commandPath}.exit_code`, `${commandPath}.exit_code must be an integer or null.`);
    }
  }
  return issues;
}

async function validateDispatchArtifacts(
  artifactsDir: string,
  issues: string[],
): Promise<void> {
  const runsDir = join(artifactsDir, "runs");
  const files = await collectFiles(runsDir);
  const dispatchPlanPaths = files.filter((file) => file.endsWith("dispatch-plan.json"));
  const resultFiles = files.filter((file) => file.endsWith(".result.json"));
  const referencedResults = new Map<string, "document" | "implement">();

  for (const dispatchPlanPath of dispatchPlanPaths) {
    const plan = await readJsonForValidation(dispatchPlanPath, issues);
    if (!plan) continue;
    const { issues: planIssues, phase, resultPaths } = validateDispatchPlan(plan, dispatchPlanPath);
    const errorPlanIssues = planIssues.filter((issue) => issue.severity === "error");
    if (errorPlanIssues.length > 0) {
      issues.push(formatValidationIssues(errorPlanIssues));
    }
    if (!phase) continue;
    for (const resultPath of resultPaths) {
      referencedResults.set(resultPath, phase);
      if (!existsSync(resultPath)) continue;
      const result = await readJsonForValidation(resultPath, issues);
      if (!result) continue;
      if (phase === "document") {
        const resultIssues = validateDocumentResponse(result, resultPath).filter(
          (issue) => issue.severity === "error",
        );
        if (resultIssues.length > 0) {
          issues.push(formatValidationIssues(resultIssues));
        }
      } else {
        const implIssues = validateImplementWorkerResult(result, resultPath).filter(
          (issue) => issue.severity === "error",
        );
        if (implIssues.length > 0) {
          issues.push(formatValidationIssues(implIssues));
        }
      }
    }
  }

  for (const resultFile of resultFiles) {
    if (!referencedResults.has(resultFile)) {
      issues.push(`Stale worker result is not referenced by any dispatch plan: ${resultFile}.`);
    }
  }
}

export async function validateArtifacts(
  artifactsDir: string,
  root = ".",
): Promise<ArtifactValidationResult> {
  const issues: string[] = [];
  const store = new StateStore(artifactsDir);
  const state = await store.loadState();

  if (!state) {
    issues.push(`Missing remediation state at ${join(artifactsDir, "state.json")}.`);
  }

  if (state?.plan) {
    const planIssues = validateRemediationPlan(state.plan).filter(
      (issue) => issue.severity === "error",
    );
    if (planIssues.length > 0) {
      issues.push(formatValidationIssues(planIssues));
    }
  }

  if (state?.items) {
    for (const item of Object.values(state.items)) {
      if (item.item_spec) {
        const itemIssues = validateItemSpec(item.item_spec).filter(
          (issue) => issue.severity === "error",
        );
        if (itemIssues.length > 0) {
          issues.push(formatValidationIssues(itemIssues));
        }
      }
    }
  }

  const planPath = join(artifactsDir, "remediation_plan.json");
  const persistedPlan = await readJsonForValidation(planPath, issues);
  if (persistedPlan) {
    const planIssues = validateRemediationPlan(persistedPlan).filter(
      (issue) => issue.severity === "error",
    );
    if (planIssues.length > 0) {
      issues.push(formatValidationIssues(planIssues));
    }
  }

  for (const file of await collectFiles(artifactsDir)) {
    if (/[/\\]item_spec_[^/\\]+\.json$/u.test(file)) {
      const spec = await readJsonForValidation(file, issues);
      if (!spec) continue;
      const specIssues = validateItemSpec(spec).filter(
        (issue) => issue.severity === "error",
      );
      if (specIssues.length > 0) {
        issues.push(formatValidationIssues(specIssues));
      }
    }
  }

  const clarificationRequest = await readJsonForValidation(
    join(artifactsDir, "clarification_request.json"),
    issues,
  );
  if (clarificationRequest) {
    if (!Array.isArray(clarificationRequest)) {
      issues.push("clarification_request.json must be an array.");
    } else {
      for (const [index, request] of clarificationRequest.entries()) {
        const requestIssues = validateClarificationRequest(
          request,
          `clarification_request[${index}]`,
        ).filter((issue) => issue.severity === "error");
        if (requestIssues.length > 0) {
          issues.push(formatValidationIssues(requestIssues));
        }
      }
    }
  }

  const triageBatch = await readJsonForValidation(
    join(artifactsDir, "triage_batch.json"),
    issues,
  );
  if (triageBatch) {
    if (!isRecord(triageBatch) || !Array.isArray(triageBatch.items)) {
      issues.push("triage_batch.json must be an object with an items array.");
    }
  }

  const triageResolution = await readJsonForValidation(
    join(artifactsDir, "triage_resolution.json"),
    issues,
  );
  if (triageResolution) {
    const triageIssues = validateTriageResolution(triageResolution).filter(
      (issue) => issue.severity === "error",
    );
    if (triageIssues.length > 0) {
      issues.push(formatValidationIssues(triageIssues));
    }
  }

  const currentStep = await readJsonForValidation(
    join(artifactsDir, "steps", "current-step.json"),
    issues,
  );
  if (currentStep) {
    const stepIssues = validateCurrentStep(currentStep, "current-step.json").filter(
      (issue) => issue.severity === "error",
    );
    if (stepIssues.length > 0) {
      issues.push(formatValidationIssues(stepIssues));
    }
  }

  await validateDispatchArtifacts(artifactsDir, issues);

  const closingResultPath = join(artifactsDir, "remediation-closing-result.json");
  const closingResult = await readJsonForValidation(closingResultPath, issues);
  if (closingResult) {
    const closingIssues = validateClosingResult(closingResult, "remediation-closing-result.json").filter(
      (issue) => issue.severity === "error",
    );
    if (closingIssues.length > 0) {
      issues.push(formatValidationIssues(closingIssues));
    }
  }

  // Contract-pipeline artifact validation (optional — only checked when present).
  const cpDir = contractPipelineDir(artifactsDir);
  const cpValidators: Record<string, (v: unknown, p: string) => ValidationIssue[]> = {
    goal_spec: validateGoalSpec,
    context_bundle: validateContextBundle,
    design_spec: validateDesignSpec,
    conceptual_design_critique: validateConceptualDesignCritique,
    obligation_ledger: validateObligationLedger,
    contract_assessment_report: validateContractAssessmentReport,
    counterexample: validateCounterexample,
    judge_report: validateJudgeReport,
    implementation_dag: validateImplementationDAG,
  };
  for (const name of CP_ARTIFACT_NAMES) {
    const cpPath = join(cpDir, `${name}.json`);
    const cpRaw = await readJsonForValidation(cpPath, issues);
    if (!cpRaw) continue;
    // The envelope wraps the payload — validate the payload field.
    const payload = isRecord(cpRaw) && "payload" in cpRaw ? cpRaw.payload : cpRaw;
    if (name === "verification_report") {
      const vIssues = validateVerificationReport(payload, name).filter(
        (issue) => issue.severity === "error",
      );
      if (vIssues.length > 0) issues.push(formatValidationIssues(vIssues));
    } else {
      const validator = cpValidators[name];
      if (validator) {
        const vIssues = validator(payload, name).filter(
          (issue) => issue.severity === "error",
        );
        if (vIssues.length > 0) issues.push(formatValidationIssues(vIssues));
      }
    }
  }

  // Verification report at the root artifacts dir (from FINDING-027).
  const verificationReportPath = join(root, ".audit-tools", "verification_report.json");
  const verificationReport = await readJsonForValidation(verificationReportPath, issues);
  if (verificationReport) {
    const vrIssues = validateVerificationReport(verificationReport, "verification_report.json").filter(
      (issue) => issue.severity === "error",
    );
    if (vrIssues.length > 0) issues.push(formatValidationIssues(vrIssues));
  }

  return {
    status: issues.length > 0 ? "error" : "ok",
    issue_count: issues.length,
    issues,
  };
}
