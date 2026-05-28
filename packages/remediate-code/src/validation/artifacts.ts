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
import { formatValidationIssues, isRecord } from "@audit-tools/shared";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_STEP_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../steps/types.js";

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
  issues: string[],
): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    issues.push(`${label} must be an array of strings.`);
  }
}

function validateCurrentStep(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object.`);
    return;
  }
  if (value.contract_version !== REMEDIATION_STEP_CONTRACT_VERSION) {
    issues.push(`${path} has unsupported contract_version.`);
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
      issues.push(`${path}.${key} must be a string.`);
    }
  }
  validateStringArray(value.allowed_commands, `${path}.allowed_commands`, issues);
  if (!isRecord(value.artifact_paths)) {
    issues.push(`${path}.artifact_paths must be an object.`);
  }
  if (typeof value.prompt_path === "string" && !existsSync(value.prompt_path)) {
    issues.push(`${path}.prompt_path points to a missing file: ${value.prompt_path}.`);
  }
}

function validateDispatchPlan(
  value: unknown,
  path: string,
  issues: string[],
): { phase?: "document" | "implement"; resultPaths: string[] } {
  const resultPaths: string[] = [];
  if (!isRecord(value)) {
    issues.push(`${path} must be an object.`);
    return { resultPaths };
  }
  if (value.contract_version !== REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION) {
    issues.push(`${path} has unsupported contract_version.`);
  }
  const phase =
    value.phase === "document" || value.phase === "implement"
      ? value.phase
      : undefined;
  if (!phase) {
    issues.push(`${path}.phase must be document or implement.`);
  }
  for (const key of ["run_id", "repo_root", "artifacts_dir"]) {
    if (typeof value[key] !== "string") {
      issues.push(`${path}.${key} must be a string.`);
    }
  }
  if (!Array.isArray(value.items)) {
    issues.push(`${path}.items must be an array.`);
    return { phase, resultPaths };
  }
  for (const [index, item] of value.items.entries()) {
    const itemPath = `${path}.items[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${itemPath} must be an object.`);
      continue;
    }
    for (const key of ["task_id", "prompt_path", "result_path"]) {
      if (typeof item[key] !== "string") {
        issues.push(`${itemPath}.${key} must be a string.`);
      }
    }
    if (phase === "document" && typeof item.finding_id !== "string") {
      issues.push(`${itemPath}.finding_id must be a string for document dispatch.`);
    }
    if (phase === "implement" && typeof item.block_id !== "string") {
      issues.push(`${itemPath}.block_id must be a string for implement dispatch.`);
    }
    if (typeof item.prompt_path === "string" && !existsSync(item.prompt_path)) {
      issues.push(`${itemPath}.prompt_path points to a missing file: ${item.prompt_path}.`);
    }
    if (typeof item.result_path === "string") {
      resultPaths.push(item.result_path);
    }
  }
  return { phase, resultPaths };
}

function validateImplementWorkerResult(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!isRecord(value)) {
    issues.push(`${path} implement worker result must be an object.`);
    return;
  }
  if (value.contract_version !== REMEDIATION_WORKER_RESULT_CONTRACT_VERSION) {
    issues.push(`${path} implement worker result has unsupported contract_version.`);
  }
  if (value.phase !== "implement") {
    issues.push(`${path} implement worker result phase must be implement.`);
  }
  if (!Array.isArray(value.item_results)) {
    issues.push(`${path} implement worker result item_results must be an array.`);
    return;
  }
  for (const [index, result] of value.item_results.entries()) {
    const resultPath = `${path}.item_results[${index}]`;
    if (!isRecord(result)) {
      issues.push(`${resultPath} must be an object.`);
      continue;
    }
    if (typeof result.finding_id !== "string") {
      issues.push(`${resultPath}.finding_id must be a string.`);
    }
    if (result.status !== "resolved" && result.status !== "blocked") {
      issues.push(`${resultPath}.status must be resolved or blocked.`);
    }
  }
}

function validateClosingResult(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object.`);
    return;
  }
  if (value.contract_version !== "remediate-code-closing-result/v1alpha1") {
    issues.push(`${path}.contract_version is unsupported.`);
  }
  if (typeof value.action !== "string") {
    issues.push(`${path}.action must be a string.`);
  }
  if (!["success", "failed", "skipped"].includes(String(value.status))) {
    issues.push(`${path}.status must be success, failed, or skipped.`);
  }
  if (!Array.isArray(value.commands)) {
    issues.push(`${path}.commands must be an array.`);
    return;
  }
  for (const [index, command] of value.commands.entries()) {
    const commandPath = `${path}.commands[${index}]`;
    if (!isRecord(command)) {
      issues.push(`${commandPath} must be an object.`);
      continue;
    }
    validateStringArray(command.command, `${commandPath}.command`, issues);
    if (
      command.exit_code !== null &&
      (typeof command.exit_code !== "number" || !Number.isInteger(command.exit_code))
    ) {
      issues.push(`${commandPath}.exit_code must be an integer or null.`);
    }
  }
}

function validateReportJson(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object.`);
    return;
  }
  for (const key of ["resolved", "inappropriate", "ignored"]) {
    if (!Array.isArray(value[key])) {
      issues.push(`${path}.${key} must be an array.`);
    }
  }
  if (value.verified_no_change !== undefined && !Array.isArray(value.verified_no_change)) {
    issues.push(`${path}.verified_no_change must be an array when present.`);
  }
  if (!isRecord(value.combined_test_result)) {
    issues.push(`${path}.combined_test_result must be an object.`);
  } else if (typeof value.combined_test_result.passed !== "boolean") {
    issues.push(`${path}.combined_test_result.passed must be a boolean.`);
  }
  if (!isRecord(value.closing_result)) {
    issues.push(`${path}.closing_result must be an object.`);
  } else if (typeof value.closing_result.status !== "string") {
    issues.push(`${path}.closing_result.status must be a string.`);
  }
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
    const { phase, resultPaths } = validateDispatchPlan(
      plan,
      dispatchPlanPath,
      issues,
    );
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
        validateImplementWorkerResult(result, resultPath, issues);
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
    validateCurrentStep(currentStep, "current-step.json", issues);
  }

  await validateDispatchArtifacts(artifactsDir, issues);

  const closingResultPath = join(artifactsDir, "remediation-closing-result.json");
  const closingResult = await readJsonForValidation(closingResultPath, issues);
  if (closingResult) {
    validateClosingResult(closingResult, "remediation-closing-result.json", issues);
  }

  const jsonReportPath = join(root, "remediation-report.json");
  const reportJson = await readJsonForValidation(jsonReportPath, issues);
  if (reportJson) {
    validateReportJson(reportJson, "remediation-report.json", issues);
  }

  return {
    status: issues.length > 0 ? "error" : "ok",
    issue_count: issues.length,
    issues,
  };
}
