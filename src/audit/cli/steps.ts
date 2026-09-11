import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  writeStepContract,
  StepStatusSchema,
  AccessDeclarationSchema,
  AGENT_FEEDBACK_FILENAME,
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
    /**
     * The per-process agent id `writeStepContract` stamps on every step it
     * writes — the owner of the `steps/<agentId>/` slot the step's canonical
     * `prompt_path` points into.
     *
     * NAMED HERE because the schema is `.strict()`: the writer stamped it and
     * this list omitted it, so the contract the tool WRITES was rejected by the
     * schema the tool declares for reading it. The strictness is right and the
     * omission was the bug — a reader must not be able to loosen `.strict()`
     * away, because that is the property catching every future such drift.
     * Optional for a HAND-BUILT fixture that predates the per-agent slot; the
     * writer always supplies it.
     */
    agent_id: z.string().optional(),
    /** Run-level orientation; omitted for steps that have no meaningful summary. */
    progress: StepProgressSchema.optional(),
    /** Shell commands the host may run for this step. */
    allowed_commands: z.array(z.string()),
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
 * Audit's optional fields (progress, access) ride through
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

/**
 * The reserved `artifact_paths` key carrying the run's agent-reflection file
 * (`<artifactsDir>/agent-feedback.jsonl`, append-only NDJSON).
 *
 * WHY IT IS ON THE STEP. The loader prompt asks the host to append reflections
 * (and requires one for a degraded quick/shallow run), but a host can only do
 * that if it knows WHICH FILE. `parseReflectionsNdjson` reports a malformed line
 * inside a file it FOUND; it returns an empty list, silently, when the file is
 * absent — so a host that guessed a different filename produced no reflection,
 * no error, and a quietly thinner audit report. Handing the path over on the
 * contract is what makes the filename something the tool SUPPLIES rather than
 * something a host must reproduce from prose (auditor-agnostic robustness).
 *
 * Set HERE, in the one funnel every audit step emission goes through, so no
 * step kind can be added that forgets it.
 */
export const AGENT_FEEDBACK_ARTIFACT_KEY = "agent_feedback";

export async function writeCurrentStep(params: {
  artifactsDir: string;
  stepKind: StepKind;
  status: StepStatus;
  runId: string | null;
  allowedCommands: string[];
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
    artifactPaths: {
      ...params.artifactPaths,
      // The canonical reflection destination, supplied on EVERY step and
      // overwriting any caller entry of the same name — a reserved slot, the
      // same rule as current_step / current_prompt, so no caller can repoint a
      // host at a file the loader will not read.
      [AGENT_FEEDBACK_ARTIFACT_KEY]: join(
        params.artifactsDir,
        AGENT_FEEDBACK_FILENAME,
      ),
    },
    extraFields: {
      // Optional audit fields keep their conditional-omission semantics; they
      // ride before the canonical path fields so they can never clobber them.
      ...(params.progress ? { progress: params.progress } : {}),
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
