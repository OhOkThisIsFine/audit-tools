import {
  writeStepContract,
  stepsDir as sharedStepsDir,
  currentStepPath as sharedCurrentStepPath,
  currentPromptPath as sharedCurrentPromptPath,
} from "audit-tools/shared";
import {
  REMEDIATION_STEP_CONTRACT_VERSION,
  type RemediationStep,
  type RemediationStepKind,
  type RemediationStepStatus,
} from "./types.js";

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

/** `<artifactsDir>/steps` — re-exported from the shared path authority. */
export function stepsDir(artifactsDir: string): string {
  return sharedStepsDir(artifactsDir);
}

export function currentStepPath(artifactsDir: string): string {
  return sharedCurrentStepPath(artifactsDir);
}

export function currentPromptPath(artifactsDir: string): string {
  return sharedCurrentPromptPath(artifactsDir);
}

/**
 * Write the remediation step contract. Delegates to the shared
 * `writeStepContract` (drift-plan R3) which owns the steps/ filenames, mkdir,
 * prompt write, atomic current-step.json write, the forward-slash normalization
 * of ALL host-facing path fields, and the canonical-paths-win merge. This
 * wrapper only supplies the remediation contract version, the remediation
 * `step_kind` enum, and the trim-leading-whitespace behaviour remediation
 * prompts rely on.
 */
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
  return writeStepContract<RemediationStep, RemediationStepKind, string>({
    contractVersion: REMEDIATION_STEP_CONTRACT_VERSION,
    stepKind,
    status,
    runId,
    repoRoot,
    artifactsDir,
    prompt,
    allowedCommands,
    stopCondition,
    artifactPaths,
    trimPromptStart: true,
  });
}
