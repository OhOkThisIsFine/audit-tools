// sites-pinned: tests/remediate/friction-capture-closeout.test.ts, tests/remediate/next-step-lifecycle.test.ts, tests/remediate/phase-close.test.ts
import {
  writeStepContract,
  writeBlockedStepContract,
  type BaseStepContract,
  type StepStatus,
} from "audit-tools/shared";
import {
  REMEDIATION_STEP_CONTRACT_VERSION,
  type RemediationStep,
  type RemediationStepKind,
} from "./types.js";

export interface WriteStepInput {
  stepKind: RemediationStepKind;
  status: StepStatus;
  runId: string | null;
  repoRoot: string;
  artifactsDir: string;
  prompt: string;
  allowedCommands?: string[];
  stopCondition: string;
  artifactPaths?: Record<string, string>;
  access?: RemediationStep["access"];
  assertOwnership?: () => Promise<void>;
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
  access,
  assertOwnership,
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
    extraFields: access ? { access } : undefined,
    trimPromptStart: true,
    assertOwnership,
  });
}

/** A fresh run id: `<prefix>-<base36 time>-<6 random base36 chars>`. */
export function randomRunId(prefix = "RUN"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Write the terminal blocked step the CLI's fatal backstop emits (backlog:
 * abnormal-exit no-step-contract). Remediate's DRAW of the shared blocked-step
 * assembly (`writeBlockedStepContract` in audit-tools/shared — semantics in
 * `runWithBlockedStepBackstop`): this wrapper supplies only the per-mode
 * inputs — the remediation contract version and a freshly minted run id
 * (there may be no loadable state to read a real run id from when the
 * backstop fires).
 */
export async function writeBlockedStep(params: {
  root: string;
  artifactsDir: string;
  reason: string;
}): Promise<BaseStepContract> {
  return writeBlockedStepContract({
    tool: "remediate-code",
    contractVersion: REMEDIATION_STEP_CONTRACT_VERSION,
    artifactsDir: params.artifactsDir,
    repoRoot: params.root,
    runId: randomRunId("BLOCKED"),
    reason: params.reason,
  });
}
