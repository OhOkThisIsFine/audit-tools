import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  writeStepContract,
  StepStatusSchema,
  AccessDeclarationSchema,
} from "audit-tools/shared";
import type { AccessDeclaration, StepStatus } from "audit-tools/shared";
import {
  LaneSubmissionShortfallSchema,
  type LaneSubmissionShortfall,
} from "./laneSubmissions.js";

export const STEP_CONTRACT_VERSION = "audit-code-step/v1alpha1";

export const StepKindSchema = z.enum([
  "dispatch_review",
  "design_review",
  "design_review_parallel",
  "design_review_contract",
  "design_review_conceptual",
  "charter_extraction",
  "charter_delta",
  "charter_clarification",
  "systemic_challenge",
  "confirm_intent",
  "intent_equivalence",
  "analyzer_install",
  "analyzer_consent",
  "edge_reasoning_dispatch",
  "critical_flow_fallback",
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
    /**
     * What a PREVIOUS emission of this step's lanes is still owed, by lane and
     * issue code. Present only when something is actually outstanding, so an
     * automated consumer reads the shortfall off the contract instead of
     * diffing two identical-looking steps.
     */
    submission_shortfall: LaneSubmissionShortfallSchema.optional(),
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
/**
 * One-line scope echo rendered into EVERY step prompt from the persisted
 * `scope_summary.json` the intake executor writes. Previously the echo lived
 * only in the host loader instructions, keyed to "after the FIRST next-step
 * (the intake step)" — so a RESUMED run (which never re-runs intake) silently
 * skipped it (2026-08-05 friction, ambiguous_direction). Tool-rendered here,
 * fresh and resumed steps carry the same line and no host has to remember.
 * Lenient: no/malformed summary file → no line.
 */
export function scopeEchoLine(artifactsDir: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(artifactsDir, "scope_summary.json"), "utf8"),
    ) as { repo_root?: unknown; auditable_file_count?: unknown; git_available?: unknown };
    if (
      typeof parsed.repo_root !== "string" ||
      typeof parsed.auditable_file_count !== "number"
    ) {
      return null;
    }
    const git =
      parsed.git_available === true ? "yes" : parsed.git_available === false ? "no" : "unknown";
    return `> Scope: auditing \`${parsed.repo_root}\` — ${parsed.auditable_file_count} files, git: ${git}.`;
  } catch {
    return null;
  }
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
  submissionShortfall?: LaneSubmissionShortfall;
}): Promise<StepArtifact> {
  const echo = scopeEchoLine(params.artifactsDir);
  return writeStepContract<StepArtifact, StepKind, string | null>({
    contractVersion: STEP_CONTRACT_VERSION,
    stepKind: params.stepKind,
    status: params.status,
    runId: params.runId,
    allowedCommands: params.allowedCommands,
    stopCondition: params.stopCondition,
    repoRoot: params.repoRoot,
    artifactsDir: params.artifactsDir,
    prompt: echo ? `${echo}\n\n${params.prompt}` : params.prompt,
    artifactPaths: params.artifactPaths,
    extraFields: {
      // Optional audit fields keep their conditional-omission semantics; they
      // ride before the canonical path fields so they can never clobber them.
      ...(params.progress ? { progress: params.progress } : {}),
      ...(params.allowedMcpTools && params.allowedMcpTools.length > 0
        ? { allowed_mcp_tools: params.allowedMcpTools }
        : {}),
      ...(params.access ? { access: params.access } : {}),
      // Omitted when nothing is outstanding: a field that is always present
      // reads as noise, while its presence IS the statement.
      ...(params.submissionShortfall &&
      params.submissionShortfall.outstanding.length > 0
        ? { submission_shortfall: params.submissionShortfall }
        : {}),
    },
  });
}
