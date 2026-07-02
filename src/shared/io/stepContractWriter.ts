import { mkdir, writeFile, readdir, stat, rm } from "node:fs/promises";
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

/**
 * Path of `current-step.json`. With no `agentId` this is the SHARED
 * `steps/current-step.json` "latest" slot (single-agent default + back-compat);
 * with an `agentId` it is the per-agent `steps/<agentId>/current-step.json` slot
 * (cooperative multi-agent, spec/multi-ide-concurrent-runs-design.md). Each
 * `writeStepContract` returns the per-agent path so a concurrent peer never reads
 * another peer's prompt from a clobbered shared file.
 */
export function currentStepPath(artifactsDir: string, agentId?: string): string {
  const dir = agentId ? join(stepsDir(artifactsDir), agentId) : stepsDir(artifactsDir);
  return join(dir, "current-step.json");
}

/** Path of `current-prompt.md` (shared with no `agentId`, per-agent with one). */
export function currentPromptPath(artifactsDir: string, agentId?: string): string {
  const dir = agentId ? join(stepsDir(artifactsDir), agentId) : stepsDir(artifactsDir);
  return join(dir, "current-prompt.md");
}

/**
 * Per-PROCESS agent id: one `next-step` invocation = one process = one id = one
 * `steps/<agentId>/` slot. Concurrent invocations are separate processes with
 * distinct ids, so their step/prompt files never collide. Not host-supplied (no
 * manual flag) — minted here, path- and ref-safe. Lazily cached for the process.
 */
let cachedProcessAgentId: string | null = null;
export function processAgentId(): string {
  if (cachedProcessAgentId === null) {
    const rand = Math.random().toString(36).slice(2, 8);
    cachedProcessAgentId = `a-${process.pid}-${Date.now().toString(36)}-${rand}`;
  }
  return cachedProcessAgentId;
}

// Best-effort GC of stale per-agent step slots so they don't accumulate across
// many next-step processes. Removes `steps/<id>/` subdirs whose `current-step.json`
// is older than the TTL; never touches the shared `current-*` files (they live
// directly in `steps/`, not a subdir) and never throws.
const STEP_SLOT_TTL_MS = 60 * 60_000;
async function gcStaleAgentSlots(stepsDirPath: string, keepAgentId: string): Promise<void> {
  try {
    const entries = await readdir(stepsDirPath, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && e.name !== keepAgentId)
        .map(async (e) => {
          const slot = join(stepsDirPath, e.name);
          try {
            const st = await stat(join(slot, "current-step.json"));
            if (now - st.mtimeMs > STEP_SLOT_TTL_MS) {
              await rm(slot, { recursive: true, force: true });
            }
          } catch {
            /* missing marker / race — leave it, next pass may collect it */
          }
        }),
    );
  } catch {
    /* steps dir unreadable — nothing to collect */
  }
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
  const agentId = processAgentId();
  const agentSlotDir = join(stepsDirPath, agentId);
  await mkdir(agentSlotDir, { recursive: true });

  // The returned/canonical paths are the PER-AGENT slot so a concurrent peer
  // never reads this step from a shared file another peer has clobbered.
  const promptPath = currentPromptPath(input.artifactsDir, agentId);
  const stepPath = currentStepPath(input.artifactsDir, agentId);
  const promptContent = input.trimPromptStart
    ? input.prompt.trimStart()
    : input.prompt;
  await writeFile(promptPath, promptContent, "utf8");

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
    // Per-process agent id owning this step slot (observability; the host uses
    // the returned prompt_path, not this).
    agent_id: agentId,
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

  // Shared "latest" pointer: mirror this step's prompt + JSON into the shared
  // `steps/current-*` slot. NOT the canonical handoff (the returned per-agent
  // path is) — it exists for single-agent back-compat, human/debug inspection,
  // and helper-based readers (`currentPromptPath(artifactsDir)`). Last-writer-
  // wins under concurrency, which is fine because nothing correctness-critical
  // reads it (peers use the returned per-agent prompt_path / stdout contract).
  await writeFile(currentPromptPath(input.artifactsDir), promptContent, "utf8");
  await writeJsonFile(currentStepPath(input.artifactsDir), step);

  await gcStaleAgentSlots(stepsDirPath, agentId);
  return step;
}
