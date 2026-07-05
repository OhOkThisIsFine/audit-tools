import { z } from "zod";
import {
  writeStepContract,
  StepStatusSchema,
  AccessDeclarationSchema,
} from "audit-tools/shared";
import type { StepStatus } from "audit-tools/shared";
import type { AccessDeclaration } from "../types/workerSession.js";

export const STEP_CONTRACT_VERSION = "audit-code-step/v1alpha1";

export const StepKindSchema = z.enum([
  "dispatch_review",
  "single_task_fallback",
  "design_review",
  "design_review_parallel",
  "design_review_contract",
  "design_review_conceptual",
  "confirm_intent",
  "analyzer_install",
  "edge_reasoning",
  "edge_reasoning_dispatch",
  "synthesis_narrative",
  "present_report",
  "blocked",
]);
export type StepKind = z.infer<typeof StepKindSchema>;

/**
 * Lightweight run-level orientation surfaced in the step contract so a host
 * resuming an in-flight audit knows where it stands without reading artifacts.
 */
export const StepProgressSchema = z
  .object({
    /** One-line, human-readable summary safe to show a resuming host. */
    summary: z.string(),
    /** Pending review packets in the active dispatch run, when applicable. */
    pending_packets: z.number().int().optional(),
    /** Audit tasks covered by the pending packets. */
    pending_tasks: z.number().int().optional(),
    /** Audit tasks already completed before this run (skipped as done). */
    completed_tasks: z.number().int().optional(),
    /** Packets GRANTED for dispatch this pass (the emergent admission width). */
    granted_count: z.number().int().optional(),
    /** Verbatim host in-flight cap (declared env limit), or null. */
    declared_cap: z.number().int().nullable().optional(),
    /** Total agents (packets) that will be launched this run. */
    agent_count: z.number().int().optional(),
    /**
     * True when `agent_count` exceeds the configured confirm threshold and the
     * loader should pause for user confirmation before fan-out (FINDING-012).
     */
    confirmation_recommended: z.boolean().optional(),
    /** Human-readable fan-out summary, e.g. "12 agents, max 4 concurrent (rolling)". */
    dispatch_summary: z.string().optional(),
  })
  .strict();
export type StepProgress = z.infer<typeof StepProgressSchema>;

export const StepArtifactSchema = z
  .object({
    contract_version: z.literal(STEP_CONTRACT_VERSION),
    step_kind: StepKindSchema,
    prompt_path: z.string(),
    status: StepStatusSchema,
    run_id: z.string().nullable(),
    /** Run-level orientation; omitted for steps that have no meaningful summary. */
    progress: StepProgressSchema.optional(),
    /** Shell commands the host may run for this step. */
    allowed_commands: z.array(z.string()),
    /**
     * MCP tool names equivalent to `allowed_commands`, for hosts driving the
     * backend through the MCP adapter. Omitted when the step has no MCP
     * equivalents, so a shell host never has to guess which list entries are
     * tool names versus runnable commands.
     */
    allowed_mcp_tools: z.array(z.string()).optional(),
    stop_condition: z.string(),
    repo_root: z.string(),
    artifacts_dir: z.string(),
    artifact_paths: z.record(z.string(), z.string().nullable()),
    access: AccessDeclarationSchema.optional(),
  })
  .strict();
export type StepArtifact = z.infer<typeof StepArtifactSchema>;

/**
 * Write the audit step contract. Delegates to the shared `writeStepContract`
 * (drift-plan R3) — the single source for the steps/ filenames, mkdir, prompt
 * write, atomic current-step.json write, the forward-slash normalization of ALL
 * host-facing path fields, and the canonical-paths-win merge. Promoting the
 * writer to shared is what fixed audit-code's Windows path-separator drift: it
 * previously wrote `prompt_path` / `repo_root` / `artifacts_dir` /
 * `artifact_paths` with raw backslashes, while remediate-code normalized them.
 * Audit's optional fields (progress, allowed_mcp_tools, access) ride through
 * `extraFields` with the same conditional-omission semantics as before.
 */
export async function writeCurrentStep(params: {
  artifactsDir: string;
  stepKind: StepKind;
  status: StepStatus;
  runId: string | null;
  allowedCommands: string[];
  allowedMcpTools?: string[];
  progress?: StepProgress;
  stopCondition: string;
  repoRoot: string;
  artifactPaths: Record<string, string | null>;
  prompt: string;
  access?: AccessDeclaration;
}): Promise<StepArtifact> {
  return writeStepContract<StepArtifact, StepKind, string | null>({
    contractVersion: STEP_CONTRACT_VERSION,
    stepKind: params.stepKind,
    status: params.status,
    runId: params.runId,
    allowedCommands: params.allowedCommands,
    stopCondition: params.stopCondition,
    repoRoot: params.repoRoot,
    artifactsDir: params.artifactsDir,
    prompt: params.prompt,
    artifactPaths: params.artifactPaths,
    extraFields: {
      // Optional audit fields keep their conditional-omission semantics; they
      // ride before the canonical path fields so they can never clobber them.
      ...(params.progress ? { progress: params.progress } : {}),
      ...(params.allowedMcpTools && params.allowedMcpTools.length > 0
        ? { allowed_mcp_tools: params.allowedMcpTools }
        : {}),
      ...(params.access ? { access: params.access } : {}),
    },
  });
}
