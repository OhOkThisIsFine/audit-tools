import { mkdir, writeFile, readFile, readdir, stat, rm } from "node:fs/promises";
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
// many next-step processes. Age is necessary but NOT sufficient: a slot whose
// owner process is still alive is NEVER removed, however old its mtime (an idle
// peer's slot is old and live). Removal requires BOTH past-TTL age AND a dead
// or unidentifiable owner. Every decision is logged with its reason; never throws.
const STEP_SLOT_TTL_MS = 60 * 60_000;
/** Liveness marker written into every per-agent slot: `{ "pid": <owner pid> }`. */
const SLOT_OWNER_FILE = "owner.json";
type SlotGcReason =
  | "stale_and_owner_dead"
  | "kept_live_peer"
  | "unreadable_marker"
  | "steps_dir_unreadable";
/**
 * Every non-trivial GC decision (removal, live-peer keep, unreadable skip) is
 * reported with its reason — best-effort observability on stderr, never fatal.
 */
function emitSlotGc(event: { slot: string; reason: SlotGcReason; detail?: string }): void {
  console.warn(
    `[step-contract] agent-slot gc ${event.reason}: ${event.slot}${event.detail ? ` (${event.detail})` : ""}`,
  );
}

/** Parse `a-<pid>-<ts>-<rand>` back to its pid; null when not our grammar. */
function parseAgentIdPid(agentId: string): number | null {
  if (!agentId.startsWith("a-")) return null;
  const pidPart = agentId.slice(2).split("-")[0];
  if (!/^\d+$/.test(pidPart)) return null;
  const pid = Number.parseInt(pidPart, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Liveness probe for a slot's owning process. `kill(pid, 0)` sends no signal;
 * it reports deliverability, so an EPERM host still learns the peer EXISTS.
 */
function isProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Resolve a slot's owner pid from its LIVENESS SIGNAL — the `owner.json`
 * marker written when the slot is created — falling back to the pid embedded
 * in the slot name. Null when neither yields a usable pid.
 */
async function resolveOwnerPid(slot: string, agentName: string): Promise<number | null> {
  try {
    const raw = await readFile(join(slot, SLOT_OWNER_FILE), "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) {
      return parsed.pid;
    }
  } catch {
    /* absent/corrupt marker — fall through to the id grammar */
  }
  return parseAgentIdPid(agentName);
}

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
            // Young slots are the common case: silently kept, never spammed.
            if (now - st.mtimeMs <= STEP_SLOT_TTL_MS) {
              return;
            }
            // Past-TTL age alone never removes a slot: confirm the owner is
            // actually gone first. An idle-but-live peer keeps its slot.
            const ownerPid = await resolveOwnerPid(slot, e.name);
            if (ownerPid !== null && isProcessLive(ownerPid)) {
              emitSlotGc({
                slot,
                reason: "kept_live_peer",
                detail: `owner pid ${ownerPid} alive past TTL`,
              });
              return;
            }
            await rm(slot, { recursive: true, force: true });
            emitSlotGc({
              slot,
              reason: "stale_and_owner_dead",
              detail:
                ownerPid === null
                  ? "past TTL, no identifiable live owner"
                  : `past TTL, owner pid ${ownerPid} not running`,
            });
          } catch (error) {
            emitSlotGc({
              slot,
              reason: "unreadable_marker",
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        }),
    );
  } catch (error) {
    emitSlotGc({
      slot: stepsDirPath,
      reason: "steps_dir_unreadable",
      detail: error instanceof Error ? error.message : String(error),
    });
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
  // Liveness signal for the GC (and any external reaper): the owning pid. The
  // id grammar already embeds it, but the marker is explicit, survives a rename
  // of the id grammar, and is what makes "is this peer still running?" a read
  // instead of an inference.
  await writeFile(
    join(agentSlotDir, SLOT_OWNER_FILE),
    `${JSON.stringify({ pid: process.pid })}\n`,
    "utf8",
  );

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

/**
 * Run `body` under the terminal-exit backstop both next-step CLIs share
 * (backlog: abnormal-exit no-step-contract). If `body` throws — a
 * mis-shaped-submission parse crash, a host-handoff abort, an IO failure —
 * write a blocked step contract naming the cause via
 * `writeBlockedStep`, then rethrow the ORIGINAL error so the caller's exit
 * semantics (stderr report + nonzero exit) are unchanged. This guarantees the
 * step-contract property mechanically: after ANY terminal exit of a next-step
 * invocation, `steps/current-step.json` reflects that invocation's outcome — a
 * consumer can never read the previous step as a live instruction.
 *
 * `writeBlockedStep` failures are swallowed deliberately: the backstop must
 * never mask the original failure with a secondary write error.
 */
export async function runWithBlockedStepBackstop<T>(
  body: () => Promise<T>,
  writeBlockedStep: (reason: string) => Promise<unknown>,
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await writeBlockedStep(reason);
    } catch {
      // Swallowed: the original error below is the signal; a failed blocked-step
      // write (e.g. the same disk fault that caused it) must not replace it.
    }
    throw error;
  }
}

/**
 * Canonical blocked-step prompt. Single-sourced here (one core, two draws) so
 * the two orchestrators' blocked prompts cannot drift; `tool` is the CLI name
 * for the heading ("audit-code" / "remediate-code").
 */
export function renderBlockedStepPrompt(tool: string, reason: string): string {
  return [
    `# ${tool} blocked`,
    "",
    "The run cannot continue automatically from this step.",
    "",
    "Report this blocker verbatim and stop:",
    "",
    reason,
    "",
  ].join("\n");
}

/**
 * Single-sourced blocked-step ASSEMBLY (one core, two draws — the semantics
 * live in `runWithBlockedStepBackstop`, the contract shape lives here). Each
 * orchestrator's draw supplies only its genuine per-mode inputs: the contract
 * version and its run-id convention (audit: `null`; remediate: a minted id).
 * The step JSON always carries `progress.summary` naming the cause — a
 * contract-only consumer may never read the prompt file — and the
 * prompt is the shared `renderBlockedStepPrompt`.
 */
export async function writeBlockedStepContract(params: {
  /** CLI name for the prompt heading, e.g. "audit-code". */
  tool: string;
  contractVersion: string;
  artifactsDir: string;
  repoRoot: string;
  runId: string | null;
  reason: string;
  /** Optional pointers a specific blocked path adds (e.g. operator_handoff). */
  artifactPaths?: Record<string, string | null>;
}): Promise<BaseStepContract> {
  return writeStepContract<BaseStepContract>({
    contractVersion: params.contractVersion,
    stepKind: "blocked",
    status: "blocked",
    runId: params.runId,
    allowedCommands: [],
    stopCondition: "Report the blocker and stop.",
    repoRoot: params.repoRoot,
    artifactsDir: params.artifactsDir,
    prompt: renderBlockedStepPrompt(params.tool, params.reason),
    artifactPaths: params.artifactPaths ?? {},
    extraFields: { progress: { summary: params.reason } },
  });
}
