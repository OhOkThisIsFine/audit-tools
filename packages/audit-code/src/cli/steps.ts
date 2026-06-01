import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "@audit-tools/shared";
import type { StepStatus } from "@audit-tools/shared";
import type { AccessDeclaration } from "../types/workerSession.js";

export const STEP_CONTRACT_VERSION = "audit-code-step/v1alpha1";

export type StepKind =
  | "dispatch_review"
  | "single_task_fallback"
  | "design_review"
  | "analyzer_install"
  | "edge_reasoning"
  | "edge_reasoning_dispatch"
  | "synthesis_narrative"
  | "present_report"
  | "blocked";

export interface StepArtifact {
  contract_version: typeof STEP_CONTRACT_VERSION;
  step_kind: StepKind;
  prompt_path: string;
  status: StepStatus;
  run_id: string | null;
  /** Shell commands the host may run for this step. */
  allowed_commands: string[];
  /**
   * MCP tool names equivalent to `allowed_commands`, for hosts driving the
   * backend through the MCP adapter. Omitted when the step has no MCP
   * equivalents, so a shell host never has to guess which list entries are
   * tool names versus runnable commands.
   */
  allowed_mcp_tools?: string[];
  stop_condition: string;
  repo_root: string;
  artifacts_dir: string;
  artifact_paths: Record<string, string | null>;
  access?: AccessDeclaration;
}

export async function writeCurrentStep(params: {
  artifactsDir: string;
  stepKind: StepKind;
  status: StepStatus;
  runId: string | null;
  allowedCommands: string[];
  allowedMcpTools?: string[];
  stopCondition: string;
  repoRoot: string;
  artifactPaths: Record<string, string | null>;
  prompt: string;
  access?: AccessDeclaration;
}): Promise<StepArtifact> {
  const stepsDir = join(params.artifactsDir, "steps");
  await mkdir(stepsDir, { recursive: true });
  const promptPath = join(stepsDir, "current-prompt.md");
  const stepPath = join(stepsDir, "current-step.json");
  await writeFile(promptPath, params.prompt, "utf8");
  const step: StepArtifact = {
    contract_version: STEP_CONTRACT_VERSION,
    step_kind: params.stepKind,
    prompt_path: promptPath,
    status: params.status,
    run_id: params.runId,
    allowed_commands: params.allowedCommands,
    ...(params.allowedMcpTools && params.allowedMcpTools.length > 0
      ? { allowed_mcp_tools: params.allowedMcpTools }
      : {}),
    stop_condition: params.stopCondition,
    repo_root: params.repoRoot,
    artifacts_dir: params.artifactsDir,
    artifact_paths: {
      current_step: stepPath,
      current_prompt: promptPath,
      ...params.artifactPaths,
    },
    ...(params.access ? { access: params.access } : {}),
  };
  await writeJsonFile(stepPath, step);
  return step;
}
