import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  REMEDIATION_STEP_CONTRACT_VERSION,
  type RemediationStep,
  type RemediationStepKind,
  type RemediationStepStatus,
} from "./types.js";
import { writeJsonFile } from "../io/json.js";

export interface WriteStepInput {
  stepKind: RemediationStepKind;
  status: RemediationStepStatus;
  runId: string;
  repoRoot: string;
  artifactsDir: string;
  prompt: string;
  allowedCommands?: string[];
  stopCondition: string;
  artifactPaths?: Record<string, string>;
}

export function stepsDir(artifactsDir: string): string {
  return join(artifactsDir, "steps");
}

export function currentStepPath(artifactsDir: string): string {
  return join(stepsDir(artifactsDir), "current-step.json");
}

export function currentPromptPath(artifactsDir: string): string {
  return join(stepsDir(artifactsDir), "current-prompt.md");
}

export async function writeCurrentStep({
  stepKind,
  status,
  runId,
  repoRoot,
  artifactsDir,
  prompt,
  allowedCommands = [],
  stopCondition,
  artifactPaths = {},
}: WriteStepInput): Promise<RemediationStep> {
  await mkdir(stepsDir(artifactsDir), { recursive: true });
  const promptPath = currentPromptPath(artifactsDir);
  await writeFile(promptPath, prompt.trimStart(), "utf8");

  const step: RemediationStep = {
    contract_version: REMEDIATION_STEP_CONTRACT_VERSION,
    step_kind: stepKind,
    status,
    prompt_path: promptPath,
    run_id: runId,
    repo_root: repoRoot,
    artifacts_dir: artifactsDir,
    allowed_commands: allowedCommands,
    stop_condition: stopCondition,
    artifact_paths: {
      current_prompt: promptPath,
      ...artifactPaths,
    },
  };

  await writeJsonFile(currentStepPath(artifactsDir), step);
  return step;
}
