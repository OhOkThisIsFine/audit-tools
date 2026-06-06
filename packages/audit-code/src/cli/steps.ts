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

/**
 * Lightweight run-level orientation surfaced in the step contract so a host
 * resuming an in-flight audit knows where it stands without reading artifacts.
 */
export interface StepProgress {
  /** One-line, human-readable summary safe to show a resuming host. */
  summary: string;
  /** Pending review packets in the active dispatch run, when applicable. */
  pending_packets?: number;
  /** Audit tasks covered by the pending packets. */
  pending_tasks?: number;
  /** Audit tasks already completed before this run (skipped as done). */
  completed_tasks?: number;
  /** Subagent parallelism resolved for this dispatch run. */
  wave_size?: number;
  /** "canary" when only the top packet was emitted this round; "fan_out" otherwise. */
  phase?: "canary" | "fan_out";
  /** packet_id of the emitted canary packet when `phase === "canary"`. */
  canary_packet_id?: string | null;
  /** Total agents (packets) that will be launched this run. */
  agent_count?: number;
  /** Number of dispatch waves for this run (`ceil(agent_count / wave_size)`). */
  wave_count?: number;
  /**
   * True when `agent_count` exceeds the configured confirm threshold and the
   * loader should pause for user confirmation before fan-out (FINDING-012).
   */
  confirmation_recommended?: boolean;
  /** Human-readable fan-out summary, e.g. "12 agents across 3 waves (wave_size=4)". */
  dispatch_summary?: string;
}

export interface StepArtifact {
  contract_version: typeof STEP_CONTRACT_VERSION;
  step_kind: StepKind;
  prompt_path: string;
  status: StepStatus;
  run_id: string | null;
  /** Run-level orientation; omitted for steps that have no meaningful summary. */
  progress?: StepProgress;
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
  progress?: StepProgress;
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
    ...(params.progress ? { progress: params.progress } : {}),
    allowed_commands: params.allowedCommands,
    ...(params.allowedMcpTools && params.allowedMcpTools.length > 0
      ? { allowed_mcp_tools: params.allowedMcpTools }
      : {}),
    stop_condition: params.stopCondition,
    repo_root: params.repoRoot,
    artifacts_dir: params.artifactsDir,
    artifact_paths: {
      // Caller-supplied paths are merged first so the canonical, computed
      // step/prompt locations always win — a caller (or step config) must not be
      // able to repoint the host at a different current-step.json / -prompt.md.
      ...params.artifactPaths,
      current_step: stepPath,
      current_prompt: promptPath,
    },
    ...(params.access ? { access: params.access } : {}),
  };
  await writeJsonFile(stepPath, step);
  return step;
}
