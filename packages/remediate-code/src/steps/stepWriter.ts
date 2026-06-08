import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  REMEDIATION_STEP_CONTRACT_VERSION,
  type RemediationStep,
  type RemediationStepKind,
  type RemediationStepStatus,
} from "./types.js";
import { writeJsonFile, toPromptPathToken } from "@audit-tools/shared";

/**
 * Normalize a filesystem path for inclusion in host-facing step contract JSON.
 * The step contract is read by hosts and workers that may execute commands in
 * bash-like shells on Windows, where backslashes are escape characters. Forward
 * slashes are accepted by Node on Windows and survive bash, PowerShell, and cmd
 * alike, so all host-facing path fields in the step JSON use forward slashes.
 */
function normalizeStepPath(value: string): string {
  return toPromptPathToken(value);
}

function normalizePathRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = normalizeStepPath(v);
  }
  return out;
}

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
    prompt_path: normalizeStepPath(promptPath),
    run_id: runId,
    repo_root: normalizeStepPath(repoRoot),
    artifacts_dir: normalizeStepPath(artifactsDir),
    allowed_commands: allowedCommands,
    stop_condition: stopCondition,
    artifact_paths: normalizePathRecord({
      current_prompt: promptPath,
      ...artifactPaths,
    }),
  };

  await writeJsonFile(currentStepPath(artifactsDir), step);
  return step;
}
