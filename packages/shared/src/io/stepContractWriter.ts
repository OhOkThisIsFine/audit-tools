import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stepsDir } from "./auditToolsPaths.js";
import { writeJsonFile } from "./json.js";
import { toPromptPathToken } from "../tooling/exec.js";

/**
 * Single source of truth for the step-contract object + writer shared by both
 * orchestrators (drift-plan R3). Before this module existed, audit-code
 * (`src/cli/steps.ts`) and remediate-code (`src/steps/stepWriter.ts`) each had
 * their own `writeCurrentStep` with REAL behavioural drift: remediate
 * normalized every host-facing path to forward slashes via `toPromptPathToken`,
 * but audit wrote raw Windows paths (backslashes), which break in the bash-like
 * shells a host may use to run the step's commands. This module owns:
 *
 *  - the `steps/` filenames (`current-step.json`, `current-prompt.md`), via the
 *    shared `stepsDir` helper;
 *  - `mkdir` of the steps dir, the `current-prompt.md` write, and the atomic
 *    `writeJsonFile` of `current-step.json`;
 *  - the `toPromptPathToken` normalization of ALL host-facing path fields
 *    (`prompt_path`, `repo_root`, `artifacts_dir`, and every value in
 *    `artifact_paths`);
 *  - the "computed canonical paths win" merge guard: caller-supplied
 *    `artifact_paths` are merged FIRST so the canonical `current_step` /
 *    `current_prompt` entries always overwrite them — a caller (or step config)
 *    must never be able to repoint a host at a different current-step.json or
 *    current-prompt.md.
 *
 * Each orchestrator extends `BaseStepContract` with its own `step_kind` enum
 * and optional fields (progress, allowed_mcp_tools, access, ...) and calls
 * `writeStepContract` with its concrete types; neither writes raw paths.
 */

/** Path of `current-step.json` for a given artifacts dir. */
export function currentStepPath(artifactsDir: string): string {
  return join(stepsDir(artifactsDir), "current-step.json");
}

/** Path of `current-prompt.md` for a given artifacts dir. */
export function currentPromptPath(artifactsDir: string): string {
  return join(stepsDir(artifactsDir), "current-prompt.md");
}

/**
 * Fields every step contract shares. Orchestrators extend this with a narrowed
 * `step_kind` (their own enum), a narrowed `contract_version` literal, and any
 * orchestrator-specific optional fields.
 *
 * `TStepKind` is the orchestrator's step-kind enum; `TArtifactValue` is whether
 * artifact path values may be `null` (audit allows null entries for not-yet
 * materialized artifacts; remediate does not).
 */
export interface BaseStepContract<
  TStepKind extends string = string,
  TArtifactValue extends string | null = string | null,
> {
  contract_version: string;
  step_kind: TStepKind;
  status: string;
  prompt_path: string;
  run_id: string | null;
  allowed_commands: string[];
  stop_condition: string;
  repo_root: string;
  artifacts_dir: string;
  artifact_paths: Record<string, TArtifactValue>;
}

/**
 * Input to {@link writeStepContract}. `contractVersion`, `stepKind`, `status`,
 * `runId`, `allowedCommands`, `stopCondition`, `repoRoot`, `artifactsDir`, and
 * `prompt` map onto the matching base contract fields. `artifactPaths` is the
 * caller's extra artifact map (merged before the canonical step/prompt keys).
 * `extraFields` is a shallow object spread onto the contract AFTER the base
 * fields but BEFORE the canonical `prompt_path`/`repo_root`/`artifacts_dir`/
 * `artifact_paths` normalization — so an orchestrator's optional fields
 * (progress, allowed_mcp_tools, access, ...) ride along without this module
 * knowing about them, and can never clobber the normalized path fields.
 */
export interface WriteStepContractInput<
  TStepKind extends string = string,
  TArtifactValue extends string | null = string | null,
> {
  contractVersion: string;
  stepKind: TStepKind;
  status: string;
  runId: string | null;
  allowedCommands: string[];
  stopCondition: string;
  repoRoot: string;
  artifactsDir: string;
  prompt: string;
  /**
   * Caller-supplied artifact map. Merged FIRST; the canonical `current_step`
   * and `current_prompt` entries always win. All values are normalized to
   * forward-slash prompt path tokens.
   */
  artifactPaths?: Record<string, TArtifactValue>;
  /**
   * Orchestrator-specific optional fields (progress, allowed_mcp_tools,
   * access, ...). Spread onto the contract before the canonical path fields,
   * so they can never overwrite the normalized paths or `artifact_paths`.
   */
  extraFields?: Record<string, unknown>;
  /**
   * Whether to trim leading whitespace from the prompt before writing it.
   * Remediate trims (its prompts are built with a leading newline); audit
   * writes the prompt verbatim. Defaults to `false` (verbatim).
   */
  trimPromptStart?: boolean;
}

/**
 * Write `current-prompt.md` and an atomically-replaced `current-step.json`
 * under `<artifactsDir>/steps/`, returning the contract object that was
 * persisted (path fields normalized to forward slashes). The generic
 * parameters let each orchestrator recover its concrete contract type.
 *
 * Path normalization is applied to EVERY host-facing path field so a step
 * never carries Windows backslashes into the JSON a host reads and runs
 * commands from.
 */
export async function writeStepContract<
  TStep extends BaseStepContract<TStepKind, TArtifactValue>,
  TStepKind extends string = string,
  TArtifactValue extends string | null = string | null,
>(input: WriteStepContractInput<TStepKind, TArtifactValue>): Promise<TStep> {
  const stepsDirPath = stepsDir(input.artifactsDir);
  await mkdir(stepsDirPath, { recursive: true });

  const promptPath = currentPromptPath(input.artifactsDir);
  const stepPath = currentStepPath(input.artifactsDir);
  await writeFile(
    promptPath,
    input.trimPromptStart ? input.prompt.trimStart() : input.prompt,
    "utf8",
  );

  const callerArtifactPaths = input.artifactPaths ?? {};
  const normalizedArtifactPaths: Record<string, string | null> = {};
  // Caller-supplied paths are merged FIRST so the canonical, computed
  // step/prompt locations always win — a caller (or step config) must not be
  // able to repoint the host at a different current-step.json / -prompt.md.
  for (const [key, value] of Object.entries(callerArtifactPaths)) {
    normalizedArtifactPaths[key] =
      value === null ? null : toPromptPathToken(value as string);
  }
  normalizedArtifactPaths.current_step = toPromptPathToken(stepPath);
  normalizedArtifactPaths.current_prompt = toPromptPathToken(promptPath);

  const step = {
    contract_version: input.contractVersion,
    step_kind: input.stepKind,
    status: input.status,
    run_id: input.runId,
    allowed_commands: input.allowedCommands,
    stop_condition: input.stopCondition,
    // Orchestrator-specific optional fields ride here; the canonical path
    // fields below are written last so extraFields can never clobber them.
    ...(input.extraFields ?? {}),
    prompt_path: toPromptPathToken(promptPath),
    repo_root: toPromptPathToken(input.repoRoot),
    artifacts_dir: toPromptPathToken(input.artifactsDir),
    artifact_paths: normalizedArtifactPaths,
  } as unknown as TStep;

  await writeJsonFile(stepPath, step);
  return step;
}
