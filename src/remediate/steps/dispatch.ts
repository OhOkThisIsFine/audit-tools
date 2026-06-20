import { mkdir, rename } from "node:fs/promises";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, relative, dirname, resolve, isAbsolute } from "node:path";
import { OwnershipRegistry } from "../dispatch/ownershipRegistry.js";
import { routeAmendmentRequest } from "../dispatch/amendmentClaim.js";
import { toBlockId, fromBlockId } from "../contractPipeline/idRegistry.js";
import { readContractArtifact } from "../contractPipeline/artifactStore.js";
import { verifyPairingForFinding } from "../contractPipeline/changeClassification.js";
import { spawnSync } from "node:child_process";
import { StateStore, type RemediationState } from "../state/store.js";
import {
  REMEDIATION_STEP,
  isClarificationCategory,
  type ClarificationRequest,
  type Finding,
  type ItemSpec,
  type RemediationBlock,
} from "../state/types.js";
import type {
  SessionConfig,
  HostConcurrencyLimit,
  WaveSchedule,
  QuotaStateEntry,
  BackoffState,
  ResolvedProviderName,
  DispatchCapacityPoolSummary,
  DiscoveredRateLimitsInput,
  HostModelRosterEntry,
  CapacityPool,
  QuotaProbeResult,
  ProviderSlot,
  RollingDispatchResult,
} from "audit-tools/shared";
import { resolveWindowsShimSpawnCommand, probeQuotaSource } from "audit-tools/shared";
import { findingLead, renderFindingBadgeBody } from "audit-tools/shared";
import {
  AGENT_FEEDBACK_FILENAME,
  readJsonFile,
  readOptionalJsonFile,
  writeJsonFile,
  writeTextFile,
  withFsRetry,
  formatValidationIssues,
  isRecord,
  detectRepoConventions,
  formatRepoConventions,
  toPromptPathToken,
  estimateTokensFromBytes,
  buildQuotaSource,
  severityRank,
  findingNeedsVerificationBeforeFix,
  compareTier,
  mostCapableTier,
  normalizeRepoPath,
  buildSourcePools,
  type FindingTheme,
} from "audit-tools/shared";
import {
  validateClarificationRequest,
} from "../validation/remediationState.js";
import { validateImplementWorkerResult } from "../validation/artifacts.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_DISPATCH_QUOTA_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
  type DispatchModelHint,
  type DispatchPhase,
  type DispatchPlanItem,
  type ImplementWorkerResult,
  type RemediationDispatchPlan,
  type RemediationDispatchQuota,
} from "./types.js";
import {
  classifyFindingRisk,
  specIndicatesNoChange,
  hasExecutableEvidence,
  dependencyVerifiedComplete,
} from "./stepUtils.js";
import {
  isTerminalStatus,
  isVerifiedCompleteStatus,
  isSkipStatus,
} from "../state/itemStatus.js";
import { resnapshotAffectedFileHashes } from "../utils/fileIntegrity.js";
import {
  computeDispatchCapacity,
  resolveHostActiveSubagentLimit,
  readQuotaState,
  buildProviderModelKey,
  computeBackoffCooldownMs,
  computeBackoffFailureWeight,
  summarizeDispatchCapacityPools,
} from "../quota/index.js";
export { resolveHostActiveSubagentLimit };
export {
  detectHostActiveSubagentLimit as detectHostConcurrencyFromEnv,
} from "../quota/hostLimits.js";

// ---------------------------------------------------------------------------
// WaveScheduler types and functions (inlined from waveScheduler.ts)
// waveScheduler.ts is now a thin re-export shim pointing here.
// ---------------------------------------------------------------------------

export type { HostConcurrencyLimit };

const DEFAULT_WAVE_SIZE = 5;

export interface ScheduleWaveInput {
  hostMaxConcurrent?: number | null;
  sessionConfig: SessionConfig | null;
  itemCount: number;
  estimatedSlotTokens?: number[];
  providerName?: ResolvedProviderName;
  hostModel?: string | null;
  /** Context window the host reports for its dispatch model (handshake). */
  hostContextTokens?: number | null;
  /** Output cap the host reports for its dispatch model (handshake). */
  hostOutputTokens?: number | null;
  /**
   * Ordered model roster (lowest rank first) from the multi-rank handshake
   * (`--host-models`); outranks the scalar pair. One capacity pool is built per
   * reported rank, each with its own discovered window.
   */
  hostModels?: HostModelRosterEntry[] | null;
  /**
   * Opaque model identity for the quota key when no model name resolves —
   * a key segment ONLY (`provider/<id>`), never a window authority.
   */
  hostModelId?: string | null;
  env?: NodeJS.ProcessEnv;
}

export function normalizeSlotTokens(tokens: number[] | undefined, count: number): number[] {
  if (!tokens || tokens.length === 0) return new Array(count).fill(0);
  if (tokens.length > count) return tokens.slice(0, count);
  if (tokens.length < count) return [...tokens, ...new Array(count - tokens.length).fill(0)];
  return tokens;
}

function averageSlotTokens(estimatedSlotTokens?: number[]): number {
  if (!estimatedSlotTokens || estimatedSlotTokens.length === 0) return 0;
  const total = estimatedSlotTokens.reduce((a, b) => a + b, 0);
  return Math.floor(total / estimatedSlotTokens.length);
}

export interface WaveScheduleResult extends WaveSchedule {
  host_concurrency_limit: HostConcurrencyLimit | null;
  capacity_pools?: DispatchCapacityPoolSummary[];
}

export function resolveHostConcurrencyLimit(options: {
  hostMaxConcurrent?: number | null;
  sessionConfig: SessionConfig | null;
  env?: NodeJS.ProcessEnv;
}): HostConcurrencyLimit | null {
  return resolveHostActiveSubagentLimit({
    explicitLimit: options.hostMaxConcurrent,
    sessionConfig: options.sessionConfig ?? {},
    env: options.env,
  });
}

function _capacityPoolSummary(
  poolId: string,
  slots: number,
  schedule: WaveSchedule,
): DispatchCapacityPoolSummary {
  return {
    pool_id: poolId,
    slots,
    model: schedule.model,
    confidence: schedule.confidence,
    source: schedule.source,
    resolved_limits: schedule.resolved_limits,
    host_concurrency_limit: schedule.host_concurrency_limit,
    cooldown_until: schedule.cooldown_until,
    estimated_wave_tokens: schedule.estimated_wave_tokens,
    binding_cap: schedule.binding_cap ?? "none",
    quota_source_snapshot: schedule.quota_source_snapshot ?? null,
  };
}

/**
 * Most-capable rank first, so the largest pending items land on the rank with
 * the largest window. Ordering comes from the single shared tier-rank authority
 * (`compareTier`, negated for descending) — no local {small,standard,deep} copy.
 */
function sortRosterMostCapableFirst(
  roster: HostModelRosterEntry[],
): HostModelRosterEntry[] {
  return [...roster].sort((a, b) => compareTier(b.rank, a.rank));
}

export async function scheduleWave(input: ScheduleWaveInput): Promise<WaveScheduleResult> {
  const sessionConfig = input.sessionConfig ?? {};
  const providerName = input.providerName ?? (sessionConfig as { provider?: ResolvedProviderName }).provider ?? "claude-code";
  const hostModel = input.hostModel ?? (sessionConfig as { block_quota?: { host_model?: string | null } }).block_quota?.host_model ?? null;
  // Quota-key identity: resolved model name, else the host's opaque id, else
  // null → `provider/*`. Per-roster-rank `model_id` overrides per pool below.
  const quotaModelKeySegment = hostModel ?? input.hostModelId ?? null;
  const roster = input.hostModels?.length
    ? sortRosterMostCapableFirst(input.hostModels)
    : null;

  const hostLimit = resolveHostConcurrencyLimit({
    hostMaxConcurrent: input.hostMaxConcurrent,
    sessionConfig,
    env: input.env,
  });

  // The capability handshake: the host reported its dispatch model's real
  // context/output window this session (the roster's most capable entry under
  // the multi-rank handshake). Carried into the pool's discoveredLimits so the
  // shared discovered_capability rung sizes the budget to the real window
  // instead of the conservative 32k floor. RPM/TPM stay null and fill from the
  // learned quota state.
  const hostContextTokens = input.hostContextTokens ?? roster?.[0]?.context_tokens ?? null;
  const hostOutputTokens = input.hostOutputTokens ?? roster?.[0]?.output_tokens ?? null;
  const hostCapabilityLimits: DiscoveredRateLimitsInput | null =
    hostContextTokens != null || hostOutputTokens != null
      ? {
          context_tokens: hostContextTokens,
          output_tokens: hostOutputTokens,
        }
      : null;

  const quota = (sessionConfig as { quota?: { enabled?: boolean } }).quota;
  if (!quota || quota.enabled === false) {
    const cap = hostLimit?.active_subagents ?? DEFAULT_WAVE_SIZE;
    const waveSize = Math.max(1, Math.min(cap, input.itemCount));
    const avgTokens = averageSlotTokens(input.estimatedSlotTokens);
    const schedule: WaveScheduleResult = {
      max_concurrent: waveSize,
      estimated_wave_tokens: waveSize * avgTokens,
      cooldown_until: null,
      confidence: "low",
      source: "default",
      resolved_limits: {
        // Honor a host-reported window even with quota disabled; fall back to the
        // conservative floor only when nothing was discovered.
        context_tokens: hostContextTokens ?? 32_000,
        output_tokens: hostOutputTokens ?? 4_096,
        requests_per_minute: null,
        input_tokens_per_minute: null,
        output_tokens_per_minute: null,
      },
      host_concurrency_limit: hostLimit,
      model: hostModel,
      binding_cap: hostLimit && waveSize < input.itemCount ? "host_concurrency" : "none",
    };
    return {
      ...schedule,
      capacity_pools: [_capacityPoolSummary(buildProviderModelKey(providerName, quotaModelKeySegment), waveSize, schedule)],
    };
  }

  let quotaEntries: Record<string, QuotaStateEntry> = {};
  try {
    const state = await readQuotaState();
    quotaEntries = state.entries;
  } catch (err) {
    process.stderr.write(`[waveScheduler] readQuotaState failed; falling back to default wave size. ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // The proactive quota snapshot (Claude OAuth source, then learned) so the
  // scheduler can throttle/cooldown from live remaining quota — mirrors
  // audit-code's buildDispatchPool. Cached per key, so one probe per burst.
  const quotaSource = buildQuotaSource({
    halfLifeHours: (sessionConfig as { quota?: { empirical_half_life_hours?: number } }).quota
      ?.empirical_half_life_hours,
  });

  // One capacity pool per reported roster rank (most capable first), each with
  // its own discovered window and quota key; a single pool for the scalar/
  // absent handshake. A rank's opaque `model_id` keys that pool's quota.
  const pools = await Promise.all((roster ?? [null]).map(async (entry) => {
    const poolKey = buildProviderModelKey(
      providerName,
      entry?.model_id ?? quotaModelKeySegment,
    );
    const probe = await probeQuotaSource(quotaSource, poolKey).catch(
      (): QuotaProbeResult => ({ snapshot: null, status: "degraded" }),
    );
    return {
      id: poolKey,
      providerName,
      hostModel,
      ...(entry ? { rank: entry.rank } : {}),
      hostConcurrencyLimit: hostLimit,
      quotaStateEntry: quotaEntries[poolKey] ?? null,
      discoveredLimits: entry
        ? {
            context_tokens: entry.context_tokens,
            output_tokens: entry.output_tokens,
          }
        : hostCapabilityLimits,
      quotaSourceSnapshot: probe.snapshot,
      ...(probe.status === "degraded" ? { quotaSignalDegraded: true } : {}),
    };
  }));
  const capacity = computeDispatchCapacity({
    pools,
    sessionConfig,
    pendingItemTokens: normalizeSlotTokens(input.estimatedSlotTokens, input.itemCount),
  });

  return {
    ...capacity.primary.schedule,
    capacity_pools: summarizeDispatchCapacityPools(capacity),
  };
}

/**
 * Build the confirmed `CapacityPool[]` for a dispatch — one pool per reported
 * roster rank (each with its own discovered window + quota key), or a single
 * conservative pool for the scalar/absent handshake. This is the same pool shape
 * `scheduleWave` constructs internally; it is exposed so the rolling dispatch
 * engine (which is fed `confirmedPools` directly) sizes concurrency from the
 * identical quota inputs, never from a raw host flag. Reused by
 * `driveRollingImplementDispatch`.
 */
export async function buildConfirmedPools(input: {
  sessionConfig: SessionConfig | null;
  hostMaxConcurrent?: number | null;
  hostContextTokens?: number | null;
  hostOutputTokens?: number | null;
  hostModels?: HostModelRosterEntry[] | null;
  hostModelId?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<CapacityPool[]> {
  const sessionConfig = input.sessionConfig ?? {};
  const providerName =
    (sessionConfig as { provider?: ResolvedProviderName }).provider ?? "claude-code";
  const hostModel =
    (sessionConfig as { block_quota?: { host_model?: string | null } }).block_quota
      ?.host_model ?? null;
  const quotaModelKeySegment = hostModel ?? input.hostModelId ?? null;
  const roster = input.hostModels?.length
    ? sortRosterMostCapableFirst(input.hostModels)
    : null;
  const hostLimit = resolveHostConcurrencyLimit({
    hostMaxConcurrent: input.hostMaxConcurrent,
    sessionConfig,
    env: input.env,
  });
  const hostContextTokens = input.hostContextTokens ?? roster?.[0]?.context_tokens ?? null;
  const hostOutputTokens = input.hostOutputTokens ?? roster?.[0]?.output_tokens ?? null;
  const hostCapabilityLimits: DiscoveredRateLimitsInput | null =
    hostContextTokens != null || hostOutputTokens != null
      ? { context_tokens: hostContextTokens, output_tokens: hostOutputTokens }
      : null;

  let quotaEntries: Record<string, QuotaStateEntry> = {};
  try {
    const state = await readQuotaState();
    quotaEntries = state.entries;
  } catch {
    // Non-fatal: a missing/locked quota state degrades to no learned entry.
  }

  const quotaSource = buildQuotaSource({
    halfLifeHours: (sessionConfig as { quota?: { empirical_half_life_hours?: number } }).quota
      ?.empirical_half_life_hours,
  });

  const primaryPools: CapacityPool[] = await Promise.all((roster ?? [null]).map(async (entry) => {
    const poolKey = buildProviderModelKey(
      providerName,
      entry?.model_id ?? quotaModelKeySegment,
    );
    const probe = await probeQuotaSource(quotaSource, poolKey).catch(
      (): QuotaProbeResult => ({ snapshot: null, status: "degraded" }),
    );
    return {
      id: poolKey,
      providerName,
      hostModel,
      ...(entry ? { rank: entry.rank } : {}),
      hostConcurrencyLimit: hostLimit,
      quotaStateEntry: quotaEntries[poolKey] ?? null,
      discoveredLimits: entry
        ? { context_tokens: entry.context_tokens, output_tokens: entry.output_tokens }
        : hostCapabilityLimits,
      quotaSourceSnapshot: probe.snapshot,
      ...(probe.status === "degraded" ? { quotaSignalDegraded: true } : {}),
    };
  }));

  // Every configured dispatchable backend source (any non-IDE source: NIM/vLLM API,
  // a CLI pool, …) becomes a CapacityPool alongside the primary, so the scheduler's
  // proactive cross-pool spill (INV-QD-14) and the A-8 coordinator can route work to
  // them. Single-sourced in shared (`buildSourcePools`) so audit and remediate surface
  // the IDENTICAL pool shapes — the spill topology can't drift.
  const sourcePools = await buildSourcePools({
    sessionConfig,
    primaryProviderName: providerName,
    quotaSource,
    quotaEntries,
  });
  primaryPools.push(...sourcePools);

  return primaryPools;
}

export function buildDispatchQuota(
  runId: string,
  phase: DispatchPhase,
  schedule: WaveScheduleResult,
  quotaStateEntry?: QuotaStateEntry | null,
): RemediationDispatchQuota {
  let backoffState: BackoffState | null = null;
  const count = quotaStateEntry?.consecutive_429_count ?? 0;
  if (count > 0) {
    backoffState = {
      consecutive_429_count: count,
      current_cooldown_ms: computeBackoffCooldownMs(count),
      current_failure_weight: computeBackoffFailureWeight(count),
    };
  }

  return {
    contract_version: REMEDIATION_DISPATCH_QUOTA_CONTRACT_VERSION,
    run_id: runId,
    phase,
    host_concurrency_limit: schedule.host_concurrency_limit,
    max_concurrent_agents: schedule.max_concurrent,
    estimated_wave_tokens: schedule.estimated_wave_tokens,
    model: schedule.model,
    confidence: schedule.confidence,
    source: schedule.source,
    resolved_limits: schedule.resolved_limits,
    cooldown_until: schedule.cooldown_until,
    binding_cap: schedule.binding_cap ?? "none",
    capacity_pools: schedule.capacity_pools,
    quota_source_snapshot: schedule.quota_source_snapshot ?? null,
    backoff_state: backoffState,
  };
}

// ---------------------------------------------------------------------------
// Byte-based token estimation helpers
// ---------------------------------------------------------------------------

/** Fixed prompt overhead per dispatch slot (prompt instructions, JSON schema, etc.). */
const PROMPT_OVERHEAD_TOKENS = 2000;

/** Sum the byte sizes of a list of absolute or repo-relative file paths. */
function sumFileSizes(filePaths: string[]): number {
  let total = 0;
  for (const p of filePaths) {
    try {
      total += statSync(p).size;
    } catch {
      // Missing file → 0 bytes; not an error for estimation purposes.
    }
  }
  return total;
}

/** Estimate slot tokens for an implement dispatch slot from readFiles byte sizes. */
function estimateImplementSlotTokens(readFiles: string[], root: string): number {
  const absPaths = readFiles.map((f) =>
    f.startsWith("/") || /^[A-Za-z]:[/\\]/.test(f) ? f : join(root, f),
  );
  const bytes = sumFileSizes(absPaths);
  return estimateTokensFromBytes(bytes) + PROMPT_OVERHEAD_TOKENS;
}

// ---------------------------------------------------------------------------
// detectRepoConventions cache (one call per repo root per process)
// ---------------------------------------------------------------------------

/** Module-level cache: repo root → formatted conventions string. */
export const detectRepoConventionsCache = new Map<string, string>();

function getCachedConventions(root: string): string {
  if (detectRepoConventionsCache.has(root)) {
    return detectRepoConventionsCache.get(root)!;
  }
  const result = formatRepoConventions(detectRepoConventions(root));
  detectRepoConventionsCache.set(root, result);
  return result;
}

// ---------------------------------------------------------------------------
// Worktree dispatch engine
// ---------------------------------------------------------------------------

export interface WorktreeVerifyResult {
  passed: boolean;
  output: string;
}

/**
 * The git top-level directory containing `cwd`, or `null` when `cwd` is not
 * inside a git working tree (or git is unavailable). `git rev-parse
 * --show-toplevel` emits a forward-slash absolute path on every platform.
 */
export function gitTopLevel(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) return null;
  const top = (result.stdout ?? "").trim();
  return top.length > 0 ? top : null;
}

/**
 * Canonical comparison key for a filesystem path. `realpathSync` resolves
 * symlinks and platform short-names so it matches git's `--show-toplevel`
 * output (macOS TMPDIR `/var`→`/private/var`, Windows 8.3 names); falls back to
 * `resolve` for paths that don't exist on disk (e.g. mocked unit tests).
 */
function canonicalPathKey(p: string): string {
  try {
    return normalizeRepoPath(realpathSync(p));
  } catch {
    return normalizeRepoPath(resolve(p));
  }
}

/**
 * Create an isolated git worktree on a fresh branch at HEAD. Throws on non-zero exit.
 *
 * Refuses when `root` is not ITSELF a git top-level: a bare `git worktree add`
 * with `cwd: root` walks UP to the nearest enclosing repo and silently creates
 * the worktree/branch in that ancestor (observed polluting the monorepo with
 * leaked `remediate-*` branches during the rolling_engine flip). The resolved
 * top-level must equal the target root, or we refuse rather than escape.
 */
export function createWorktree(root: string, worktreePath: string, branchName: string): void {
  const top = gitTopLevel(root);
  if (top === null) {
    throw new Error(
      `Refusing to create a worktree: ${root} is not inside a git repository ` +
        `(git rev-parse --show-toplevel failed). Rolling dispatch requires the target root to be a git repo.`,
    );
  }
  if (canonicalPathKey(top) !== canonicalPathKey(root)) {
    throw new Error(
      `Refusing to create a worktree: the git top-level for ${root} is ${top}, not the target root ` +
        `itself, so 'git worktree add' would escape to an ancestor repo. Initialize a git repo at the ` +
        `target root before rolling dispatch.`,
    );
  }
  const result = spawnSync(
    "git",
    ["worktree", "add", "-b", branchName, worktreePath, "HEAD"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(
      `git worktree add failed (exit ${result.status ?? "unknown"}):\n${stderr || stdout}`,
    );
  }
}

/**
 * Materialize into a fresh worktree any of the node's declared target paths that
 * exist in the main tree but are absent from the worktree — i.e. git-untracked or
 * gitignored files that `git worktree add HEAD` does not bring over. Without this
 * a node whose scope names an untracked config file (the dogfood hit
 * `opencode.json` and an uncommitted `.gemini/commands/*.toml`) cannot see its own
 * target, so the edit silently no-ops. The "absent in worktree" test is the
 * discriminator: a tracked path is already materialized from HEAD, so only the
 * genuinely-missing untracked/ignored declarations are copied — a tracked-but-dirty
 * file keeps its clean-from-HEAD worktree content and is never clobbered. Paths are
 * repo-relative (the declared scope contract); absolute/escaping paths are skipped.
 * Best-effort: a copy failure must not abort the dispatch (logged, not thrown).
 */
export function seedUntrackedDeclaredPaths(
  root: string,
  worktreeRoot: string,
  declaredPaths: Iterable<string>,
): void {
  for (const rel of new Set(declaredPaths)) {
    if (!rel || isAbsolute(rel)) continue;
    // Reject paths that escape the root (defence-in-depth; declared scope is
    // repo-relative and never `..`-prefixed in practice).
    const dst = join(worktreeRoot, rel);
    const src = join(root, rel);
    if (relative(worktreeRoot, dst).startsWith("..")) continue;
    if (!existsSync(src) || existsSync(dst)) continue;
    try {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true });
    } catch (err) {
      process.stderr.write(
        `[remediate-code] worktree seed: could not copy untracked declared path ${rel}: ${
          (err as Error).message
        }\n`,
      );
    }
  }
}

/** Remove a git worktree. Best-effort: logs but does not throw on failure. */
export function removeWorktree(root: string, worktreePath: string): void {
  const result = spawnSync(
    "git",
    ["worktree", "remove", "--force", worktreePath],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    process.stderr.write(
      `[remediate-code] worktree remove failed (exit ${result.status ?? "unknown"}): ${stderr}\n`,
    );
  }
}

/**
 * Fully reset a node's isolated worktree + branch so a fresh `createWorktree -b`
 * can run, even when a prior attempt left either behind. This is the idempotent
 * cleanup the in-process driver needs across a `rate_limited` re-queue: the
 * engine re-enters the dispatcher for the SAME block while its branch (and maybe
 * a stale worktree admin entry) still exist, and `git worktree add -b <branch>`
 * would otherwise fail with "branch already exists". Removing the worktree,
 * pruning stale admin records, then force-deleting the branch makes every
 * (re-)dispatch start clean from HEAD. All steps are best-effort (a missing
 * worktree/branch is the expected first-attempt case, not an error). Any partial
 * edits from a throttled prior attempt are intentionally discarded — the
 * re-dispatch redoes the node from HEAD.
 */
export function resetNodeWorktreeAndBranch(
  root: string,
  worktreePath: string,
  branchName: string,
): void {
  removeWorktree(root, worktreePath);
  // Prune stale worktree admin entries (e.g. a dir deleted out from under git),
  // otherwise `git worktree add` can refuse a path it still thinks is registered.
  spawnSync("git", ["worktree", "prune"], { cwd: root, shell: false });
  // Force-delete the leftover branch from a prior attempt so `-b` recreates it.
  spawnSync("git", ["branch", "-D", branchName], { cwd: root, shell: false });
  // Force-remove a leftover worktree DIRECTORY: when a prior attempt's worktree
  // became an orphaned dir (registered admin entry gone but files remain),
  // `git worktree remove` no-ops ("is not a working tree") and `git worktree add`
  // then refuses because the path already exists. Deleting the dir makes the
  // re-create succeed. Best-effort.
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
}

/** Run each targeted command in the worktree directory. Returns pass/fail and combined output. */
/**
 * Package-manager / runner shim base names that must be spawned through the
 * command shell on Windows (their PATH entries are `.cmd` wrappers that
 * `spawnSync(..., { shell: false })` cannot exec). Routed through the shared
 * `resolveWindowsShimSpawnCommand` so the verify step is OS-agnostic — on
 * non-win32 these spawn directly. Without this, every node's first verify
 * command (`npm run build`) errors on Windows and the whole rolling implement
 * path blocks at triage.
 */
const VERIFY_SHIM_BASE_NAMES = ["npm", "npx", "pnpm", "yarn"] as const;

export function verifyNodeInWorktree(
  worktreePath: string,
  targetedCommands: string[],
): WorktreeVerifyResult {
  const outputs: string[] = [];
  for (const cmd of targetedCommands) {
    const [bin, ...rawArgs] = cmd.split(" ");
    const { command, args } = resolveWindowsShimSpawnCommand(bin, rawArgs, VERIFY_SHIM_BASE_NAMES);
    const r = spawnSync(command, args, {
      cwd: worktreePath,
      encoding: "utf8",
      shell: false,
    });
    if (r.error) {
      // Spawn itself failed (e.g. a shim not exec'able without a shell) — surface
      // it as a verify failure with the error text rather than a silent status.
      outputs.push(`$ ${cmd}\n${r.error.message}`);
      return { passed: false, output: outputs.join("\n---\n") };
    }
    const combined = [r.stdout ?? "", r.stderr ?? ""].filter(Boolean).join("\n");
    outputs.push(`$ ${cmd}\n${combined}`);
    if (r.status !== 0) {
      return { passed: false, output: outputs.join("\n---\n") };
    }
  }
  return { passed: true, output: outputs.join("\n---\n") };
}

/** Merge the worktree branch into the current HEAD via cherry-pick. On failure, removes the worktree and returns the error. */
export function mergeWorktree(
  root: string,
  worktreePath: string,
  branchName: string,
): { success: true } | { success: false; error: string } {
  // Get the tip commit of the worktree branch
  const revResult = spawnSync("git", ["rev-parse", branchName], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (revResult.status !== 0) {
    const errMsg = (revResult.stderr ?? "").trim();
    removeWorktree(root, worktreePath);
    return { success: false, error: `Failed to resolve worktree branch ${branchName}: ${errMsg}` };
  }

  const worktreeTip = revResult.stdout.trim();
  const mergeResult = spawnSync("git", ["cherry-pick", worktreeTip], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (mergeResult.status !== 0) {
    const stderr = (mergeResult.stderr ?? "").trim();
    // Abort the cherry-pick so the main tree stays clean
    spawnSync("git", ["cherry-pick", "--abort"], { cwd: root, shell: false });
    removeWorktree(root, worktreePath);
    return { success: false, error: `cherry-pick failed: ${stderr}` };
  }

  removeWorktree(root, worktreePath);
  return { success: true };
}

/**
 * Rebase a node's worktree branch onto the main checkout's current HEAD (the
 * remediation branch tip) so a sibling that merged AFTER this worktree was created
 * is folded in before this node verifies and merges. Additive edits to a shared
 * file merge automatically (git's per-commit 3-way); a true hunk conflict is a
 * genuine seam that aborts cleanly so the node routes to triage instead of landing
 * a broken merge. The branch is checked out in the worktree, so the rebase runs
 * there. A no-op (branch already on HEAD — the common, no-sibling-merged case)
 * succeeds. Leaves the branch on its pre-rebase commit on abort (so the failed
 * node's work can still be quarantined).
 */
export function rebaseBranchOntoHead(
  root: string,
  worktreePath: string,
  branch: string,
): { ok: true } | { ok: false; error: string } {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", shell: false });
  if (head.error || head.status !== 0) {
    const detail = (head.stderr ?? head.error?.message ?? "git rev-parse failed").toString().trim();
    return { ok: false, error: `could not resolve remediation HEAD for rebase: ${detail}` };
  }
  const target = head.stdout.trim();
  const rebase = spawnSync("git", ["rebase", target], {
    cwd: worktreePath,
    encoding: "utf8",
    shell: false,
  });
  if (rebase.error || rebase.status !== 0) {
    const detail = [rebase.stdout ?? "", rebase.stderr ?? "", rebase.error?.message ?? ""]
      .filter(Boolean)
      .join("\n")
      .trim();
    // Leave a clean tree: abort the in-progress rebase before the worktree is dropped.
    spawnSync("git", ["rebase", "--abort"], { cwd: worktreePath, shell: false });
    return {
      ok: false,
      error:
        `rebase onto the current remediation HEAD conflicted (a real seam — two ` +
        `nodes edited the same lines): ${detail}`,
    };
  }
  return { ok: true };
}

/** Worktree path for a remediation block. */
export function worktreePath(root: string, blockId: string, runId: string): string {
  return join(root, ".audit-tools", "worktrees", `remediate-${blockId}-${runId}`);
}

/**
 * Deterministic name of the dedicated remediation branch for a run. Derived from
 * the stable run id (= the plan id, constant for the whole remediation) so every
 * wave and the final report resolve the SAME branch without persisting it. Ref-safe:
 * any character outside [A-Za-z0-9._-] collapses to '-'. Distinct from the per-node
 * worktree branches (`remediate-<blockId>-<runId>`) — this uses a `remediation/` ref
 * namespace so the two never collide.
 */
function refSafeSegment(s: string, fallback: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/\.{2,}/g, ".") // ".." is invalid in a git ref name
      .replace(/^[-.]+|[-.]+$/g, "") || fallback
  );
}

export function remediationBranchName(runId: string): string {
  return `remediation/${refSafeSegment(runId, "run")}`;
}

/** Durable ref under which a failed-but-committed node's commit is preserved. */
function quarantineRef(runId: string, blockId: string): string {
  return `refs/remediation-quarantine/${refSafeSegment(runId, "run")}/${refSafeSegment(blockId, "node")}`;
}

/**
 * Preserve a failed-but-committed node's work so it can never be lost. A node that
 * committed real edits to its worktree branch but then failed verify / the
 * write-scope gate / the cherry-pick is about to have its worktree removed and (on
 * the next re-dispatch) its branch force-deleted — orphaning the commit. The dogfood
 * lost a verified fix exactly this way (the worktree was pruned before recovery).
 * Point a durable ref at the branch tip: a ref under refs/remediation-quarantine/
 * survives `git branch -D` and `git worktree prune`, so the work stays reachable for
 * a manual `git cherry-pick`. Best-effort; returns the ref + commit, or null.
 */
export function quarantineFailedNodeCommit(
  root: string,
  branch: string,
  runId: string,
  blockId: string,
): { ref: string; commit: string } | null {
  const rev = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (rev.status !== 0) return null;
  const commit = (rev.stdout ?? "").trim();
  const ref = quarantineRef(runId, blockId);
  const upd = spawnSync("git", ["update-ref", ref, commit], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (upd.status !== 0) {
    process.stderr.write(
      `[remediate-code] could not quarantine ${branch}: ${(upd.stderr ?? "").trim()}\n`,
    );
    return null;
  }
  process.stderr.write(
    `[remediate-code] preserved failed node ${blockId} commit ${commit.slice(0, 8)} at ${ref} for recovery\n`,
  );
  return { ref, commit };
}

/** Clear a node's quarantine ref (e.g. once a later re-dispatch landed successfully). Best-effort. */
export function clearQuarantinedCommit(root: string, runId: string, blockId: string): void {
  spawnSync("git", ["update-ref", "-d", quarantineRef(runId, blockId)], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
}

/** Quarantined failed-node commits still preserved for a run, for recovery surfacing in the report. */
export function listQuarantinedCommits(
  root: string,
  runId: string,
): Array<{ block: string; ref: string; commit: string }> {
  const prefix = `refs/remediation-quarantine/${refSafeSegment(runId, "run")}/`;
  const res = spawnSync("git", ["for-each-ref", "--format=%(refname) %(objectname)", prefix], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (res.status !== 0 || !res.stdout) return [];
  const out: Array<{ block: string; ref: string; commit: string }> = [];
  for (const line of res.stdout.split("\n")) {
    const [ref, commit] = line.trim().split(/\s+/);
    if (!ref || !commit) continue;
    out.push({ block: ref.slice(prefix.length), ref, commit });
  }
  return out;
}

/**
 * Ensure the main checkout is on the dedicated remediation branch BEFORE any node
 * commit is cherry-picked, so accepted work lands there and the user's base branch
 * is NEVER modified — the run leaves a feature branch for review (it does not merge
 * back). Idempotent across waves: creates the branch from the current HEAD (the base)
 * the first time, checks it out on later waves. Best-effort on a non-git root (the
 * worktree dispatch flow can't run there anyway): returns null without throwing so
 * non-git callers/tests are unaffected. Returns the branch name on success.
 */
export function ensureRemediationBranchCheckedOut(root: string, runId: string): string | null {
  const top = gitTopLevel(root);
  if (top === null || canonicalPathKey(top) !== canonicalPathKey(root)) return null;
  const branch = remediationBranchName(runId);
  const current = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (current.status === 0 && (current.stdout ?? "").trim() === branch) return branch;
  const args = gitBranchExists(root, branch) ? ["checkout", branch] : ["checkout", "-b", branch];
  const co = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  if (co.status !== 0) {
    process.stderr.write(
      `[remediate-code] could not switch to remediation branch ${branch}: ${(co.stderr ?? "").trim()}\n`,
    );
    return null;
  }
  process.stderr.write(
    `[remediate-code] remediation changes land on branch ${branch} (base branch left untouched)\n`,
  );
  return branch;
}

/**
 * Stage and commit all of a worktree's edits onto its branch. The TOOL owns this
 * commit (never the worker/host) so that the branch has a real commit for two
 * downstream invariants: `gitEditedFilesForBranch` (the write-scope ground truth,
 * `HEAD...<branch>`) and `mergeWorktree`'s cherry-pick both operate on the worker's
 * changes rather than an empty diff against HEAD. Gitignored paths (node_modules,
 * .audit-tools artifacts, the result file written to the main artifacts dir) are
 * excluded by `git add -A` honoring .gitignore, so the commit captures exactly the
 * source edits. Returns `committed:false` (not an error) when the worker made no
 * tracked edits — there is then nothing to verify or merge.
 */
export function commitWorktree(
  worktreeRoot: string,
  message: string,
): { committed: boolean; error?: string } {
  const add = spawnSync("git", ["add", "-A"], {
    cwd: worktreeRoot,
    encoding: "utf8",
    shell: false,
  });
  if (add.status !== 0) {
    return { committed: false, error: `git add failed: ${(add.stderr ?? "").trim()}` };
  }
  // `git diff --cached --quiet` exits 0 when nothing is staged → no worker edits.
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: worktreeRoot,
    shell: false,
  });
  if (staged.status === 0) {
    return { committed: false };
  }
  const commit = spawnSync("git", ["commit", "-m", message], {
    cwd: worktreeRoot,
    encoding: "utf8",
    shell: false,
  });
  if (commit.status !== 0) {
    return { committed: false, error: `git commit failed: ${(commit.stderr ?? "").trim()}` };
  }
  return { committed: true };
}

/**
 * Make the main checkout's installed `node_modules` available to a worktree. A
 * fresh `git worktree add` checks out only tracked files, and `node_modules` is
 * gitignored, so per-node verify commands (`npm run check`, focused tests) would
 * otherwise fail with missing dependencies. Best-effort junction/symlink to the
 * main root's `node_modules`; on failure it logs and the verify step surfaces the
 * missing-deps error rather than crashing the dispatch. NOTE: workspace package
 * symlinks inside `node_modules/@audit-tools/*` point back into the MAIN checkout,
 * so cross-package runtime resolution sees the main tree — the authoritative
 * cross-package re-check is the central post-merge build/gate, not this fast
 * per-node verify (which gates obvious breakage early).
 */
export function ensureWorktreeNodeModules(mainRoot: string, worktreeRoot: string): void {
  const target = join(mainRoot, "node_modules");
  const link = join(worktreeRoot, "node_modules");
  if (!existsSync(target) || existsSync(link)) return;
  try {
    symlinkSync(target, link, "junction");
  } catch (err) {
    process.stderr.write(
      `[remediate-code] worktree node_modules link failed (${worktreeRoot}): ${String(err)}\n`,
    );
  }
}

/** Worker transport outcome (mirrors shared `RollingDispatchResult["outcome"]`). */
export type NodeWorkerOutcome = "success" | "error" | "rate_limited" | "timeout";

export interface AcceptNodeWorktreeParams {
  root: string;
  runId: string;
  blockId: string;
  /** The node's isolated worktree directory. */
  worktreeRoot: string;
  /** The node's worktree branch (`worktreeBranchForBlock`). */
  branch: string;
  /** The worker's transport outcome from the node dispatcher. */
  workerOutcome: NodeWorkerOutcome;
  /**
   * Per-node verify commands. OMIT (leave `undefined`) for the real rolling drivers:
   * the gate then DERIVES the verify from the node's actually-touched test files
   * post-commit ({@link deriveVerifyCommandsFromBranch}) — correct paths/runner by
   * construction, never the whole suite. Pass `[]` to skip the gate (lifecycle unit
   * tests on a minimal temp repo), or an explicit list to force specific commands.
   */
  targetedCommands?: string[];
  /**
   * The node's own `targeted_commands` (the auditor/finding-specified verification),
   * run IN ADDITION to the derived commands — filtered to the build-free subset and
   * deduped against the derive. The derive gives correct-paths-by-construction; these
   * add the fix-specific regression checks the derive misses when a fix touches no test
   * (task_7d35176d). Omit / `[]` → derive-only (the prior behaviour). Ignored when
   * `targetedCommands` is an explicit override (the lifecycle unit-test path).
   */
  additionalVerifyCommands?: string[];
  /**
   * Accept-time write-scope inputs (OBL-DS-06). When present, the write-scope
   * gate runs HERE — after the verify, BEFORE the cherry-pick — so an out-of-scope
   * or seam-conflicting edit is PREVENTED from landing in the main tree rather than
   * reported post-hoc once it is already merged. Both rolling drivers supply it;
   * unit tests that exercise the verify/merge lifecycle in isolation omit it (the
   * gate is then skipped, matching the legacy lifecycle).
   */
  scope?: {
    /** Every block's declared write scope, for amendment ownership adjudication. */
    allBlockScopes: Array<{ block_id: string; write_paths: string[] }>;
  };
}

export interface AcceptNodeWorktreeResult {
  /** The LIFECYCLE outcome (verify/merge applied), distinct from the worker transport outcome. */
  outcome: NodeWorkerOutcome;
  verifyPassed: boolean;
  merged: boolean;
  /**
   * On a failure outcome, the captured failing command + its output — the verify
   * stdout/stderr (`$ <cmd>\n<output>`), or the git commit / cherry-pick error text.
   * Persisted into the accept-outcome sidecar so triage can see the root cause
   * instead of an `outcome:error` with no captured stderr. Absent on success.
   */
  diagnostic?: string;
}

/**
 * The shared post-worker "accept node" lifecycle, extracted so BOTH rolling
 * drivers reuse identical correctness: the in-process provider engine
 * (`driveRollingImplementDispatch`) calls it inline once the worker returns; the
 * host-subagent driver calls it from the `accept-node` callback once a host
 * subagent finishes.
 *
 * Given a completed worker run in an isolated worktree, this: (1) TOOL-commits
 * the worker's edits onto the branch (deterministic, never the worker/host) so
 * the branch diff is the write-scope ground truth; (2) runs the per-node verify
 * IN the worktree BEFORE accepting; (3) merges via cherry-pick only on a passing
 * verify; and (4) drops the worktree on any failure so the main tree is never
 * dirtied by an unverified change. It returns the LIFECYCLE outcome (which the
 * caller records for the deterministic merge); the caller still returns the
 * worker's TRANSPORT outcome to the rolling engine (so a `rate_limited` worker
 * re-queues, while a verify-failure is adjudicated by the merge → triage).
 *
 * SAFETY: the main tree is touched only through `mergeWorktree` (cherry-pick of a
 * verified branch, aborts cleanly on conflict). No state mutation here — the
 * caller persists via `mergeImplementResults`.
 */
export function acceptNodeWorktree(params: AcceptNodeWorktreeParams): AcceptNodeWorktreeResult {
  const { root, runId, blockId, worktreeRoot: wt, branch, workerOutcome, targetedCommands, additionalVerifyCommands } = params;
  let verifyPassed = false;
  let merged = false;

  if (workerOutcome !== "success") {
    // Worker failed / rate-limited: nothing to land; drop the worktree, preserve outcome.
    removeWorktree(root, wt);
    return { outcome: workerOutcome, verifyPassed, merged };
  }

  const commit = commitWorktree(wt, `remediate ${blockId} (${runId})`);
  if (commit.error) {
    // Could not commit the worker's edits → cannot safely land; drop it.
    removeWorktree(root, wt);
    return { outcome: "error", verifyPassed, merged, diagnostic: commit.error };
  }
  if (!commit.committed) {
    // Worker reported success but made no tracked edits — nothing to verify or merge.
    // The deterministic merge adjudicates the result file (resolved_no_change needs evidence).
    removeWorktree(root, wt);
    return { outcome: "success", verifyPassed, merged };
  }

  // Rebase the node's branch onto the current remediation HEAD BEFORE verify, so a
  // sibling that merged after this worktree was created is folded in. Verify, the
  // write-scope gate, and the cherry-pick then all operate on the FINAL to-be-merged
  // content (green-at-merge; the later cherry-pick can no longer conflict). A true
  // hunk conflict here is a genuine seam — preserve the work and route to triage
  // rather than land a broken merge.
  const rebase = rebaseBranchOntoHead(root, wt, branch);
  if (!rebase.ok) {
    quarantineFailedNodeCommit(root, branch, runId, blockId);
    removeWorktree(root, wt);
    return { outcome: "error", verifyPassed, merged, diagnostic: rebase.error };
  }

  // Verify commands: when the host omits them (real rolling drivers), DERIVE them
  // from the just-committed branch's touched test files — correct paths/runner by
  // construction, only this node's own tests, never the whole suite. An explicit
  // list (or `[]` to skip) overrides; both used by lifecycle unit tests. task_7d35176d:
  // run the derive AND the node's own build-free `targeted_commands` (deduped) — the
  // auditor's fix-specific regression checks the derive misses when a fix touches no
  // test. `additionalVerifyCommands` is ignored on the explicit-override path.
  const baseCommands =
    targetedCommands === undefined
      ? deriveVerifyCommandsFromBranch(root, branch)
      : targetedCommands;
  const verifyCommands =
    targetedCommands === undefined
      ? [...new Set([...baseCommands, ...buildFreeVerifyCommands(additionalVerifyCommands)])]
      : baseCommands;
  const verify =
    verifyCommands.length > 0
      ? verifyNodeInWorktree(wt, verifyCommands)
      : { passed: true, output: "" };
  verifyPassed = verify.passed;
  if (!verify.passed) {
    // Verify failed: do not merge; drop the worktree so the main tree stays clean.
    // The node DID commit real edits, so preserve them under a durable quarantine
    // ref before the worktree/branch go away — a tool-verify false-negative must
    // not destroy a good fix (the dogfood lost one this way). Carry the failing
    // command + output so triage isn't blind on outcome:error.
    quarantineFailedNodeCommit(root, branch, runId, blockId);
    removeWorktree(root, wt);
    return { outcome: "error", verifyPassed, merged, diagnostic: verify.output };
  }

  // Write-scope gate (OBL-DS-06), BEFORE the cherry-pick: an out-of-scope or
  // seam-conflicting edit must never land in the main tree, so it is adjudicated
  // against the branch's git diff (the ground truth) here rather than reported
  // after `mergeWorktree` already merged it. The gate routes the node's ACTUAL
  // out-of-declared edits (git diff, never a self-report): an edit to a file no
  // sibling block owns widens the effective scope, while one owned by another
  // block blocks as a seam conflict.
  if (params.scope) {
    const decision = enforceAcceptWriteScope({
      root,
      branch,
      blockId,
      allBlockScopes: params.scope.allBlockScopes,
    });
    if (decision.blocked) {
      // Scope-blocked but the node committed real work — preserve it for recovery.
      quarantineFailedNodeCommit(root, branch, runId, blockId);
      removeWorktree(root, wt);
      return { outcome: "error", verifyPassed, merged: false, diagnostic: decision.reason };
    }
  }

  // mergeWorktree cherry-picks the verified branch and removes the worktree (on
  // success AND on conflict-abort), so no explicit cleanup is needed afterwards.
  const mergeRes = mergeWorktree(root, wt, branch);
  merged = mergeRes.success;
  if (!mergeRes.success) {
    // Cherry-pick conflict: the committed work would otherwise be orphaned — preserve it.
    quarantineFailedNodeCommit(root, branch, runId, blockId);
    return { outcome: "error", verifyPassed, merged, diagnostic: mergeRes.error };
  }
  // Landed successfully: clear any quarantine ref left by a prior failed attempt
  // for this node so the recovery report lists only genuinely-unrecovered work.
  clearQuarantinedCommit(root, runId, blockId);
  return { outcome: "success", verifyPassed, merged };
}

/**
 * Sidecar path for a node's tool-owned accept (verify/merge) outcome. Written by
 * BOTH rolling drivers as each node is accepted, read by `mergeImplementResults`.
 * Block ids here follow the same filename-safe convention as the per-node result
 * files in the same dir.
 */
export function nodeAcceptOutcomePath(
  artifactsDir: string,
  runId: string,
  blockId: string,
): string {
  return join(runDir(artifactsDir, runId, "implement"), `accept-outcome-${blockId}.json`);
}

/**
 * Persist a node's `acceptNodeWorktree` lifecycle outcome so finalization can tell
 * a node whose edits actually LANDED (merged) from one that self-reported "resolved"
 * but failed tool-owned verify / merge (OBL-DS-06: never trust the worker's self
 * report). Both rolling drivers (host-subagent `advanceHostRolling` and in-process
 * `driveRollingImplementDispatch`) call this; the interim main-tree path writes none,
 * so the merge-state gate is inert there.
 */
export async function recordNodeAcceptOutcome(
  artifactsDir: string,
  runId: string,
  blockId: string,
  result: AcceptNodeWorktreeResult,
): Promise<void> {
  await writeJsonFile(nodeAcceptOutcomePath(artifactsDir, runId, blockId), {
    schema_version: "remediate-code-implement/node-accept-outcome/v1alpha1",
    block_id: blockId,
    outcome: result.outcome,
    verify_passed: result.verifyPassed,
    merged: result.merged,
    // Only present on a failure outcome; gives triage the failing command + output.
    ...(result.diagnostic !== undefined ? { diagnostic: result.diagnostic } : {}),
  });
}

/** Load a node's recorded accept outcome, or null when none was written. */
export async function loadNodeAcceptOutcome(
  artifactsDir: string,
  runId: string,
  blockId: string,
): Promise<AcceptNodeWorktreeResult | null> {
  const raw = await readOptionalJsonFile<{
    outcome: NodeWorkerOutcome;
    verify_passed: boolean;
    merged: boolean;
    diagnostic?: string;
  }>(nodeAcceptOutcomePath(artifactsDir, runId, blockId));
  if (!raw) return null;
  return {
    outcome: raw.outcome,
    verifyPassed: raw.verify_passed,
    merged: raw.merged,
    ...(raw.diagnostic !== undefined ? { diagnostic: raw.diagnostic } : {}),
  };
}

/**
 * The per-node worktree worker an in-process driver launches: it edits within the
 * node's isolated worktree (cwd-confined), writes its result file, and returns the
 * transport outcome. `makeProviderNodeDispatcher` is the live implementation; tests
 * inject a stub. Structurally identical to `nextStep`'s `ProgrammaticNodeDispatcher`.
 */
export type WorktreeNodeWorker = (args: {
  block: RemediationBlock;
  slot: ProviderSlot;
  worktreeRoot: string;
  resultPath: string;
}) => Promise<RollingDispatchResult<{ block_id: string }>>;

/** One node's worktree-lifecycle result: the worker transport outcome + the accept lifecycle. */
export interface NodeWorktreeExecution {
  /** Worker transport outcome the rolling engine consumes (success/error/rate_limited/timeout). */
  result: RollingDispatchResult<{ block_id: string }>;
  /** Tool-owned accept outcome (commit→verify→merge), already persisted via recordNodeAcceptOutcome. */
  accept: AcceptNodeWorktreeResult;
}

/**
 * Run ONE node's full in-process lifecycle in an isolated worktree — shared by BOTH
 * in-process callers (the reactive `driveRollingImplementDispatch` engine and the
 * A-8 hybrid executor) so they create / commit / verify / merge identically:
 *
 *   reset + create the node's worktree → link node_modules → seed declared targets →
 *   launch the worker (`dispatchNode`) → `acceptNodeWorktree` (tool-commit, rebase,
 *   verify, write-scope gate, cherry-pick) → persist the accept outcome.
 *
 * Claim ownership is the CALLER's concern (the reactive engine claims through the
 * shared registry; the hybrid executor is handed a coordinator-minted claim), so
 * this fn neither claims nor releases — it returns the worker transport result AND
 * the accept lifecycle outcome and lets the caller record `nodeOutcomes` / release.
 * Any thrown error degrades to a dropped worktree + a persisted `error` accept
 * outcome, never an unhandled rejection into the engine.
 */
export async function executeNodeInWorktree(args: {
  block: RemediationBlock;
  slot: ProviderSlot;
  root: string;
  artifactsDir: string;
  runId: string;
  resultPath: string;
  /** Untracked declared targets to seed into the worktree (the node's write set or write∪read). */
  seedPaths: string[];
  /** Every block's declared write scope, for the accept-time write-scope gate (OBL-DS-06). */
  allBlockScopes: Array<{ block_id: string; write_paths: string[] }>;
  /** The node's own targeted_commands, run IN ADDITION to the derived verify (task_7d35176d). */
  additionalVerifyCommands?: string[];
  dispatchNode: WorktreeNodeWorker;
}): Promise<NodeWorktreeExecution> {
  const { block, slot, root, artifactsDir, runId, resultPath, seedPaths, allBlockScopes, additionalVerifyCommands, dispatchNode } = args;
  const branch = worktreeBranchForBlock(block.block_id, runId);
  const wt = worktreePath(root, block.block_id, runId);
  try {
    // Idempotent reset of any worktree dir AND leftover branch from a prior attempt
    // (a `rate_limited` re-queue re-enters for the same block with its branch still
    // present), then create this node's isolated worktree, link the main checkout's
    // node_modules (gitignored → absent in a fresh worktree) so verify can run, and
    // seed untracked declared targets a committed-files-only worktree can't see.
    resetNodeWorktreeAndBranch(root, wt, branch);
    createWorktree(root, wt, branch);
    ensureWorktreeNodeModules(root, wt);
    seedUntrackedDeclaredPaths(root, wt, seedPaths);
    const result = await dispatchNode({ block, slot, worktreeRoot: wt, resultPath });
    // Shared post-worker lifecycle. Verify commands are DERIVED from the node's
    // actually-touched tests inside acceptNodeWorktree (post-commit) — omit them so a
    // host-authored path can't mis-verify. The write-scope gate adjudicates the node's
    // ACTUAL git edits against every block's declared scope.
    const accept = acceptNodeWorktree({
      root,
      runId,
      blockId: block.block_id,
      worktreeRoot: wt,
      branch,
      workerOutcome: result.outcome,
      additionalVerifyCommands,
      scope: { allBlockScopes },
    });
    await recordNodeAcceptOutcome(artifactsDir, runId, block.block_id, accept);
    return { result, accept };
  } catch (err) {
    removeWorktree(root, wt);
    const accept: AcceptNodeWorktreeResult = { outcome: "error", verifyPassed: false, merged: false };
    await recordNodeAcceptOutcome(artifactsDir, runId, block.block_id, accept);
    return {
      result: {
        packet: { id: block.block_id, payload: { block_id: block.block_id }, estimatedTokens: 0, complexity: 0.5 },
        outcome: "error",
        error: err,
      },
      accept,
    };
  }
}

export interface DispatchOptions {
  root: string;
  artifactsDir: string;
}

// ---------------------------------------------------------------------------
// DAG-node field accessors (read promoted node metadata off a Finding)
// ---------------------------------------------------------------------------

/**
 * The implementation-DAG node fields `promoteImplementationDagToExtractedPlan`
 * writes onto each Finding (one node ↔ one finding ↔ one block in the contract
 * pipeline). The shared `Finding` type does not declare these overlay fields, so
 * they are read through this structural view rather than added to the shared
 * contract. Every field is optional: a finding sourced from a plain
 * `audit-findings.json` (not the contract pipeline) carries none of them and the
 * seam degrades to the block-level behavior.
 */
export interface DagNodeFields {
  /** Relative model rank for the node (small | standard | deep). Never a model name. */
  model_tier?: "small" | "standard" | "deep";
  /** Upstream contracts' declared outputs this node builds on. */
  preconditions?: string[];
  /** Human-readable description of the concrete changes the node is expected to produce. */
  expected_changes?: string;
  /** Human-readable verification checks beyond `targeted_commands`. */
  verification?: string[];
  /**
   * Reconciliation expectations carried from seam reconciliation: what an
   * upstream/neighbor contract agreed to provide this node, expressed either as
   * a list of strings or, when richer, as the precondition list. Read tolerantly
   * because the promotion shape can vary across pipeline versions.
   */
  reconciliation_expectations?: string[];
}

/** Read the promoted DAG-node overlay fields off a Finding (all optional). */
function nodeFieldsOf(finding: Finding): DagNodeFields {
  return finding as Finding & DagNodeFields;
}

/**
 * The reconciliation expectations a node must honor (INV-DS-12): the explicit
 * `reconciliation_expectations` when present, else the node's `preconditions`
 * (upstream contracts' declared outputs). Returned as a deduped string list so
 * the renderer can thread them and the disposition can record them.
 */
function reconciliationExpectationsOf(finding: Finding): string[] {
  const node = nodeFieldsOf(finding);
  const explicit = Array.isArray(node.reconciliation_expectations)
    ? node.reconciliation_expectations
    : [];
  const preconditions = Array.isArray(node.preconditions) ? node.preconditions : [];
  return [...new Set([...explicit, ...preconditions])].filter(
    (s) => typeof s === "string" && s.trim().length > 0,
  );
}

// ---------------------------------------------------------------------------
// Build-free per-node verification commands (residual CE-001)
// ---------------------------------------------------------------------------

/**
 * The host manages the build centrally; a per-node verify command that runs
 * `npm run build` (or a `npm test` whose package script prepends a build) races
 * the central build's dist/ and is therefore forbidden. A command is build-free
 * only when it neither builds nor invokes a build-prepending test script.
 *
 * Forbidden (return false):
 *  - `npm run build` / `npm run build -w ...` / `tsc` emit (`tsc -b`, `tsc --build`)
 *  - bare `npm test` / `npm t` / `npm run test` (the package script prepends build)
 *
 * Allowed (return true):
 *  - `npm run check` (no emit)
 *  - `npx vitest run <path>` / `vitest run <path>`
 *  - `node --test <path>`
 */
export function isBuildFreeVerifyCommand(cmd: string): boolean {
  const c = cmd.trim().toLowerCase().replace(/\s+/g, " ");
  if (c.length === 0) return false;
  // Any explicit build step is forbidden.
  if (/\bnpm\s+run\s+build\b/.test(c)) return false;
  if (/\btsc\b.*(-b\b|--build\b)/.test(c)) return false;
  if (/(^|\s)tsc(\s|$)/.test(c) && !/--noemit\b/.test(c)) {
    // A bare `tsc` (or `tsc -p ...`) emits unless --noEmit is set.
    return false;
  }
  // A build-prepending `npm test` / `npm t` / `npm run test` is forbidden; the
  // build-free runner (vitest run / node --test) must be invoked directly.
  if (/\bnpm\s+(test|t)\b/.test(c)) return false;
  if (/\bnpm\s+run\s+test\b/.test(c)) return false;
  return true;
}

/**
 * Filter a node's `targeted_commands` to the build-free subset for the per-node
 * verify section. Build-prepending or build commands are dropped (the host runs
 * the build centrally) rather than emitted into the prompt.
 */
function buildFreeVerifyCommands(commands: string[] | undefined): string[] {
  if (!Array.isArray(commands)) return [];
  return commands.filter((c) => typeof c === "string" && isBuildFreeVerifyCommand(c));
}

/** A repo-relative test path → the runner that executes that file directly. */
function verifyRunnerForTestFile(repoRelPath: string): string | undefined {
  // node:test suites (audit/shared) — run via the tsx loader so the TS source the
  // test imports needs no prior build. vitest suites (remediate) — `vitest run`.
  if (/^tests\/.+\.test\.mjs$/.test(repoRelPath)) return "node:test";
  if (/^tests\/.+\.test\.(ts|tsx)$/.test(repoRelPath)) return "vitest";
  return undefined;
}

/**
 * Derive a node's per-node verify commands from the test files it ACTUALLY touched
 * on its worktree branch (the git ground truth), instead of trusting host-authored
 * `targeted_commands` whose paths/runner can drift from where the worker put the
 * test. Always typechecks (`npm run check`, no emit), then runs ONLY this node's
 * own touched test files with the repo's runners — never the whole suite (which
 * would re-enter worktree-spawning tests inside a nested worktree). Build-free: the
 * host owns the central build; a node's own test imports the source it changed via
 * the tsx loader. Returns `[]` when there is no git ground truth so the caller can
 * skip the gate rather than fabricate a command.
 */
/** Pure assembly (git-free) of the verify commands for a set of edited paths —
 *  the testable core of {@link deriveVerifyCommandsFromBranch}. */
export function verifyCommandsForEdits(editedFiles: Iterable<string>): string[] {
  const nodeTests: string[] = [];
  const vitestTests: string[] = [];
  for (const f of editedFiles) {
    const rel = f.replace(/\\/g, "/");
    const runner = verifyRunnerForTestFile(rel);
    if (runner === "node:test") nodeTests.push(rel);
    else if (runner === "vitest") vitestTests.push(rel);
  }
  const cmds = ["npm run check"];
  if (nodeTests.length > 0) {
    cmds.push(`node --import tsx/esm --test ${nodeTests.sort().join(" ")}`);
  }
  if (vitestTests.length > 0) {
    cmds.push(`npx vitest run ${vitestTests.sort().join(" ")}`);
  }
  return cmds;
}

export function deriveVerifyCommandsFromBranch(root: string, branch: string): string[] {
  const edited = gitEditedFilesForBranch(root, branch);
  if (!edited.available) return [];
  return verifyCommandsForEdits(edited.files);
}

/**
 * A node's own `targeted_commands` for the per-node verify (task_7d35176d) — the union
 * of the block's `targeted_commands` and its findings' `targeted_commands` (the
 * auditor-specified, fix-specific verification). `acceptNodeWorktree` runs these IN
 * ADDITION to the derived touched-test commands (build-free subset, deduped), so a
 * fix-specific regression check is honoured even when the fix touches no test file.
 */
export function targetedCommandsForBlock(state: RemediationState, blockId: string): string[] {
  const block = state.plan?.blocks?.find((b) => b.block_id === blockId);
  if (!block) return [];
  const out = [...(block.targeted_commands ?? [])];
  for (const fid of block.items) {
    const finding = state.plan?.findings?.find((f) => f.id === fid);
    for (const c of finding?.targeted_commands ?? []) out.push(c);
  }
  return [...new Set(out)];
}

function markStarted(item: { started_at?: string; completed_at?: string }): void {
  item.started_at ??= new Date().toISOString();
  delete item.completed_at;
}

function markTerminal(item: { started_at?: string; completed_at?: string }): void {
  const now = new Date().toISOString();
  item.started_at ??= now;
  item.completed_at = now;
}

async function tryLoadExistingImplementResult(
  resultPath: string,
): Promise<ImplementWorkerResult | undefined> {
  if (!existsSync(resultPath)) return undefined;
  try {
    const result = await readJsonFile<unknown>(resultPath);
    assertImplementWorkerResult(result, resultPath);
    return result;
  } catch {
    return undefined;
  }
}

function pendingOrDocumentedFindingIdsForBlock(
  block: RemediationBlock,
  state: RemediationState,
): string[] {
  return block.items.filter((findingId) => {
    const item = state.items?.[findingId];
    return item?.status === "pending" && !isTerminalStatus(item.status);
  });
}

function implementResultCoversFindings(
  result: ImplementWorkerResult,
  findingIds: string[],
): boolean {
  const resultIds = new Set(result.item_results.map((item) => item.finding_id));
  return findingIds.every((findingId) => resultIds.has(findingId));
}

async function archiveIncompleteImplementResult(resultPath: string): Promise<void> {
  if (!existsSync(resultPath)) return;
  const archivedPath = `${resultPath}.stale-${Date.now()}`;
  await withFsRetry(() => rename(resultPath, archivedPath));
}

function runDir(artifactsDir: string, runId: string, phase: string): string {
  return join(artifactsDir, "runs", runId, phase);
}

function dispatchPlanPath(
  artifactsDir: string,
  runId: string,
  phase: string,
): string {
  return join(runDir(artifactsDir, runId, phase), "dispatch-plan.json");
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const WALK_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", "out",
  ".next", ".turbo", ".audit-tools",
]);

/** Bounded recursive scan for test files under `root` (skips vendor/build dirs). */
function walkTestFiles(root: string, max = 400): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  let visited = 0;
  while (stack.length > 0 && out.length < max) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > 20000) return out;
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".test-")) continue;
        stack.push(join(dir, entry.name));
      } else if (TEST_FILE_RE.test(entry.name)) {
        out.push(join(dir, entry.name));
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

/**
 * Best-effort: repo-relative test files that reference any of `sourceFiles` (by
 * module basename). Pulling them into a block's access lets the worker that
 * changes or removes a symbol also fix the tests that assert it, instead of
 * leaving orphaned test breakage for a separate central mop-up. Matching is
 * deliberately loose (a false positive only grants slightly broader, harmless
 * write access; a false negative is the failure mode we want to avoid).
 */
export interface TestFileEntry {
  rel: string;
  content: string;
}

/**
 * Walk the repo ONCE and read every test file's content (bounded). Built once per
 * dispatch and shared across all blocks so the filesystem walk + reads are not
 * repeated per block.
 */
export function buildTestFileIndex(root: string): TestFileEntry[] {
  const index: TestFileEntry[] = [];
  for (const testPath of walkTestFiles(root)) {
    let content: string;
    try {
      content = readFileSync(testPath, "utf8");
    } catch {
      continue;
    }
    index.push({ rel: relative(root, testPath).replace(/\\/g, "/"), content });
  }
  return index;
}

/**
 * Collect test files from `index` that reference any of `sourceFiles` by
 * module basename. When `packageRoot` is supplied (repo-relative prefix, e.g.
 * `packages/foo`), only test files under that package are considered —
 * otherwise all test files in the index are matched (existing behavior).
 */
export function collectReferencingTests(
  index: TestFileEntry[],
  sourceFiles: string[],
  packageRoot?: string,
): string[] {
  if (sourceFiles.length === 0 || index.length === 0) return [];
  const basenames = sourceFiles
    .map((f) => (f.split(/[/\\]/).pop() ?? f).replace(/\.[cm]?[jt]sx?$/, ""))
    .filter((b) => b.length > 1);
  if (basenames.length === 0) return [];
  const needles = basenames.map(
    (b) => new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
  );
  const sourceSet = new Set(sourceFiles.map((f) => f.replace(/\\/g, "/")));
  // Normalize packageRoot to forward slashes and ensure it ends without trailing slash
  const pkgPrefix = packageRoot
    ? packageRoot.replace(/\\/g, "/").replace(/\/$/, "") + "/"
    : null;
  const result: string[] = [];
  for (const { rel, content } of index) {
    if (sourceSet.has(rel)) continue;
    // If a package scope is set, skip files outside that package
    if (pkgPrefix && !rel.startsWith(pkgPrefix)) continue;
    if (needles.some((re) => re.test(content))) result.push(rel);
  }
  return result;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

/**
 * Detect the nearest ancestor directory containing a `package.json` for the
 * first source file in `sourceFiles` (walk up, stop at `root`). Returns the
 * repo-relative path prefix (e.g. `packages/foo`) or undefined if none found.
 */
function detectPackageRoot(sourceFiles: string[], root: string): string | undefined {
  if (sourceFiles.length === 0) return undefined;
  const first = sourceFiles[0];
  // Resolve to absolute path relative to root if not already absolute
  const absFirst = first.startsWith("/") || /^[A-Za-z]:[/\\]/.test(first)
    ? first
    : join(root, first);
  let dir = dirname(absFirst);
  while (dir !== root && dir.length > root.length) {
    if (existsSync(join(dir, "package.json"))) {
      return relative(root, dir).replace(/\\/g, "/");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The files an implement worker should receive as context for a finding:
 * pre-document affected_files PLUS any files the document phase declared in the
 * item_spec's `touched_files`.
 */
function itemReadFiles(finding: Finding, spec?: ItemSpec): string[] {
  const files = finding.affected_files.map((f) => f.path);
  if (spec?.touched_files) files.push(...spec.touched_files);
  return uniquePaths(files);
}

/**
 * The files an implement worker is expected to write. The documented
 * `touched_files` set is authoritative when present; affected_files are only a
 * fallback for older or incomplete document results.
 */
function itemWriteFiles(finding: Finding, spec?: ItemSpec): string[] {
  if (Array.isArray(spec?.touched_files)) {
    return uniquePaths(spec.touched_files);
  }
  return uniquePaths(finding.affected_files.map((f) => f.path));
}

/**
 * Repo-relative paths every finding in a block needs for context, deduped.
 */
function blockReadFiles(
  block: RemediationBlock,
  state: RemediationState,
): string[] {
  const files = block.items.flatMap((findingId) => {
    const finding = state.plan?.findings.find((f) => f.id === findingId);
    if (!finding) return [];
    return itemReadFiles(finding, state.items?.[findingId]?.item_spec);
  });
  return uniquePaths(files);
}

/**
 * Repo-relative paths every finding in a block may write, deduped. This is kept
 * narrower than read context so a broad affected hub file does not serialize
 * blocks whose documented write sets are actually disjoint.
 */
function blockWriteFiles(
  block: RemediationBlock,
  state: RemediationState,
): string[] {
  const files = block.items.flatMap((findingId) => {
    const finding = state.plan?.findings.find((f) => f.id === findingId);
    if (!finding) return [];
    return itemWriteFiles(finding, state.items?.[findingId]?.item_spec);
  });
  return uniquePaths(files);
}

/**
 * Construct the DispatchPlanItem for an implement task. Single source of truth
 * so prepareImplementDispatch and mergeImplementResults stay in lockstep on item
 * shape.
 */
function buildImplementDispatchItem(
  block: RemediationBlock,
  state: RemediationState,
  dir: string,
): DispatchPlanItem {
  const taskId = `implement-${block.block_id}`;
  const readFiles = blockReadFiles(block, state);
  const writeFiles = blockWriteFiles(block, state);
  const resultPath = join(dir, `${taskId}.result.json`);
  return {
    task_id: taskId,
    block_id: block.block_id,
    prompt_path: join(dir, `${taskId}.md`),
    result_path: resultPath,
    model_hint: buildImplementModelHint(block, state),
    access: {
      read_paths: readFiles,
      write_paths: [...writeFiles, resultPath],
    },
  };
}

export function buildImplementModelHint(
  block: RemediationBlock,
  state: RemediationState,
): DispatchModelHint {
  // Prefer the node's own promoted `model_tier` (derived from contract-pipeline
  // complexity signals) over a re-derived block heuristic. In the contract
  // pipeline a block maps 1:1 to a DAG node, so the block's single finding
  // carries the authoritative relative rank. Never collapse to a flat
  // "standard" when the node declared a tier.
  const nodeTiers = block.items
    .map((findingId) => {
      const finding = state.plan?.findings.find((f) => f.id === findingId);
      return finding ? nodeFieldsOf(finding).model_tier : undefined;
    })
    .filter((t): t is "small" | "standard" | "deep" => t !== undefined);
  if (nodeTiers.length > 0) {
    // Take the most-capable declared rank across the block's nodes so a deep
    // node is never under-provisioned by a sibling's smaller rank. Ordering is
    // the single shared tier-rank authority (`mostCapableTier`).
    const tier = mostCapableTier(nodeTiers) ?? "standard";
    return { tier, reasons: ["node_model_tier"] };
  }

  const deepReasons: string[] = [];
  let allSafe = true;
  let maxSeverityRank = 0;

  for (const findingId of block.items) {
    const item = state.items?.[findingId];
    const finding = state.plan?.findings.find((f) => f.id === findingId);
    if (!finding) continue;
    const rank = severityRank(finding.severity);
    if (rank > maxSeverityRank) maxSeverityRank = rank;
    if (item?.item_spec) {
      const { tier } = classifyFindingRisk(
        finding,
        item.item_spec as import("../state/types.js").ItemSpec,
      );
      if (tier === "context_dependent") {
        deepReasons.push(`context_dependent_${findingId}`);
      }
      if (tier !== "safe") {
        allSafe = false;
      }
    } else {
      allSafe = false;
    }
  }

  if (maxSeverityRank >= 5) {
    deepReasons.push("critical_severity");
  }
  if (block.items.length >= 5) {
    deepReasons.push("large_block");
  }
  if (deepReasons.length > 0) {
    return { tier: "deep", reasons: deepReasons };
  }

  if (allSafe && block.items.length === 1 && maxSeverityRank <= 2) {
    return { tier: "small", reasons: ["all_safe_single_finding"] };
  }

  return { tier: "standard", reasons: ["default_implement_block"] };
}

function contractPipelineTraceLines(finding: Finding): string[] {
  const lines: string[] = [];
  if (finding.contract_goal_id) {
    lines.push(`Contract goal: ${finding.contract_goal_id}`);
  }
  if (finding.contract_obligation_ids?.length) {
    lines.push(`Satisfies obligations: ${finding.contract_obligation_ids.join(", ")}`);
  }
  if (finding.verification_obligation_ids?.length) {
    lines.push(`Verification obligations: ${finding.verification_obligation_ids.join(", ")}`);
  }
  if (finding.targeted_commands?.length) {
    // Provenance only: the DAG's recorded targeted commands. This is the
    // "Contract Pipeline Traceability" section (what the node's contract said),
    // NOT a runnable directive. The runnable per-node verify commands the
    // renderer emits are the build-free subset in `perNodeVerificationSection`
    // (residual CE-001 is enforced there, where the worker is told to RUN them).
    lines.push(`Targeted commands: ${finding.targeted_commands.join(" | ")}`);
  }
  return lines;
}

function contractPipelineTraceBullets(finding: Finding): string {
  const lines = contractPipelineTraceLines(finding);
  if (lines.length === 0) return "";
  return `\n## Contract Pipeline Traceability\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`;
}

/**
 * G1 + INV-GND-02: a finding that the auditor's grounding pass marked ungrounded
 * — or that carries NO grounding verdict (undefined → treated as ungrounded) —
 * has not been positively re-verified against the cited code. Instruct the
 * worker to VERIFY the claim against the source first and only then fix it (or
 * resolve_no_change if the claim does not hold), rather than blindly applying a
 * fix to a possibly-stale/hallucinated finding. A positively-grounded finding
 * adds no bullet (it was already re-verified at ingest).
 */
function groundingVerificationBullet(finding: Finding): string {
  if (!findingNeedsVerificationBeforeFix(finding)) return "";
  const reason = finding.grounding?.reason
    ? ` (${finding.grounding.reason})`
    : " (no grounding verdict was recorded for this finding)";
  return `- VERIFY BEFORE FIX: this finding is not positively grounded${reason}. Confirm the claim against the cited code first; if it holds, fix it, otherwise mark the item \`resolved_no_change\` with evidence. Do not apply a fix to an unverified claim.`;
}

/**
 * Opt-in meta-audit reflection invitation (parity with audit-code's worker
 * prompt). Rendered after the file-access section because it carves out one
 * extra append-only path. Shape: the shared `AgentReflectionSchema`;
 * the close phase aggregates the file into the report's "Process Feedback"
 * section. Best-effort by design — it must never compete with the obligation.
 */
function reflectionInvitation(
  feedbackDisplay: string,
  taskId: string,
  lens?: string,
): string {
  return `
## Optional process feedback

Never let this delay or replace the required output above: if you hit task
ambiguity, tool friction, or unclear instructions, you MAY append one JSON
reflection line to \`${feedbackDisplay}\` with shape:
  {"task_id": "${taskId}"${lens ? `, "lens": "${lens}"` : ""}, "instruction_clarity": "clear|mostly_clear|ambiguous|unclear",
   "ambiguities": ["..."], "tool_friction": ["..."], "suggestions": ["..."],
   "severity": "info|low|medium|high"}
One object per line; never overwrite existing lines. Appending to this file is
allowed in addition to the file access above.
`;
}

// ---------------------------------------------------------------------------
// Infra-modifying block detection
// ---------------------------------------------------------------------------

/**
 * Canonical set of infra files whose modification can break the live dispatcher
 * while the run is in progress. Paths are repo-relative forward-slash strings.
 */
const INFRA_FILE_PATHS = new Set([
  "packages/remediate-code/src/steps/nextStep.ts",
  "packages/remediate-code/src/steps/dispatch.ts",
  "packages/remediate-code/src/state/store.ts",
  "packages/remediate-code/src/steps/contractPipeline.ts",
  "packages/remediate-code/src/steps/waveScheduler.ts",
  "packages/remediate-code/src/steps/stepWriter.ts",
]);

/**
 * Returns true when any path in `writePaths` matches the set of infra files
 * (normalised to repo-relative forward-slash strings). Used to gate the
 * live-surface verification section in the implement prompt.
 */
export function isInfraModifyingBlock(writePaths: string[]): boolean {
  for (const p of writePaths) {
    const normalized = p.replace(/\\/g, "/");
    if (INFRA_FILE_PATHS.has(normalized)) return true;
    // Also match if the path ends with the infra file's relative segment,
    // e.g. an absolute path like /abs/root/packages/remediate-code/src/steps/dispatch.ts
    for (const infraPath of INFRA_FILE_PATHS) {
      if (normalized.endsWith("/" + infraPath)) return true;
    }
  }
  return false;
}

function infraModifyingSection(repoRoot: string): string {
  const rootDisplay = toPromptPathToken(repoRoot);
  return `
## Infra-modifying block

This block modifies the dispatch/orchestration engine that the current run
executes. **The host builds the package centrally — do NOT run \`npm run build\`
or \`npm test\` here** (a worker-side build races the central build's \`dist/\`).
Verify build-free only and let the host re-exercise the live surface after its
central build:

1. **Type-check (no emit):** After completing all edits, run:
   \`\`\`
   npm run check
   \`\`\`
   from \`${rootDisplay}\`. If type-check fails, mark the item blocked and record
   the failure in \`failure_reason\`.

2. **Targeted build-free tests:** Run this package's build-free test runner
   directly against the tests for your change — for remediate-code:
   \`\`\`
   npx vitest run <your-test-file>
   \`\`\`
   from \`${rootDisplay}\`. Never invoke \`npm test\`/\`npm run build\`: those
   prepend a build. If a targeted test fails, mark the item blocked and record
   the failure in \`failure_reason\`.

3. **Rollback is the host's job.** Because you do not build or republish the
   engine, you cannot brick the live dispatcher mid-run. The host owns the
   central build and any dist rollback; record the files you changed in your
   result evidence so the host can attribute a post-build failure.
`;
}

/**
 * Per-item bullets threading what upstream/neighbor nodes agreed to provide
 * (INV-DS-12): the node's reconciliation_expectations / preconditions and its
 * expected_changes. Rendered inside each item so a dependent node implements
 * against the realized upstream surface rather than guessing.
 */
function upstreamExpectationsBullets(finding: Finding): string {
  const node = nodeFieldsOf(finding);
  const expectations = reconciliationExpectationsOf(finding);
  const lines: string[] = [];
  if (expectations.length > 0) {
    lines.push(
      `- Upstream/neighbor contract provides (implement against these, do not redefine them): ${expectations.join("; ")}`,
    );
  }
  if (typeof node.expected_changes === "string" && node.expected_changes.trim().length > 0) {
    lines.push(`- Expected changes: ${node.expected_changes.trim()}`);
  }
  if (Array.isArray(node.verification) && node.verification.length > 0) {
    lines.push(`- Verification checks: ${node.verification.join("; ")}`);
  }
  return lines.join("\n");
}

/**
 * The build-free per-node verification section. Emits the node's own build-free
 * targeted commands (build/build-prepending commands filtered out — residual
 * CE-001) plus the standard build-free baseline (`npm run check` + the package's
 * build-free test runner). NON-EMITTING: it instructs the worker to run these to
 * gate its own result, never to emit further dispatch.
 */
function perNodeVerificationSection(
  block: RemediationBlock,
  state: RemediationState,
  rootDisplay: string,
): string {
  const nodeCommands = uniquePaths(
    block.items.flatMap((findingId) => {
      const finding = state.plan?.findings.find((f) => f.id === findingId);
      return finding ? buildFreeVerifyCommands(finding.targeted_commands) : [];
    }),
  );
  const commandBlock =
    nodeCommands.length > 0
      ? `Run these node-targeted, build-free commands and record each command + result in the affected item's evidence:
\`\`\`
${nodeCommands.join("\n")}
\`\`\`
`
      : "";
  return `
## Per-node verification (build-free)

The host builds the package centrally; do NOT run \`npm run build\` or \`npm test\`
(either races the central build's \`dist/\`). Verify build-free only, from
\`${rootDisplay}\`:

- Type-check with \`npm run check\` (no emit).
- Run the package's build-free test runner directly against your change
  (remediate-code: \`npx vitest run <your-test-file>\`; node-test packages:
  \`node --test <your-test-file>\`).

${commandBlock}A node is verified-complete only when its declared outputs exist and these
build-free checks pass; otherwise mark the item blocked with the failure in
\`failure_reason\`.
`;
}

function implementPrompt(
  block: RemediationBlock,
  state: RemediationState,
  resultPath: string,
  conventions: string,
  repoRoot: string,
  feedbackDisplay: string,
  worktreeRoot?: string,
): string {
  const items = block.items.flatMap((findingId) => {
    const item = state.items?.[findingId];
    const finding = state.plan?.findings.find((entry) => entry.id === findingId);
    if (!finding) return [];
    // Only render items that still need implementing — never a resolved item
    // from a prior wave or one the user skipped (deemed_inappropriate/ignored).
    if (!item || isTerminalStatus(item.status)) return [];
    if (item.status !== "pending") return [];
    // item_spec may be pre-populated from the plan DAG node or absent;
    // either way the implementer receives finding context directly.
    // clarification_context carries the user's answer when this item was re-opened
    // from a clarification round (up-front gate or mid-run) — thread it through so
    // the retry acts on the decided scope, not the original ambiguity.
    return [{ finding, spec: item.item_spec, clarification: item.clarification_context }];
  });

  // When a worktreeRoot is supplied, the worker operates in the worktree, not
  // the main repo root. Source file paths are prefixed with the worktree root.
  // The result path always lives in the artifacts dir (outside the worktree).
  const effectiveRoot = worktreeRoot ?? repoRoot;
  // Normalize to forward slashes for host-facing prompt text; bash-like shells
  // on Windows treat backslashes as escape characters.
  const rootDisplay = toPromptPathToken(effectiveRoot);
  const resultDisplay = toPromptPathToken(resultPath);

  // Prefix each source file path with the worktree root when applicable.
  function resolveFilePath(rel: string): string {
    if (!worktreeRoot) return rel;
    if (rel.startsWith("/") || /^[A-Za-z]:[/\\]/.test(rel)) return rel;
    return toPromptPathToken(join(worktreeRoot, rel));
  }

  const worktreeNote = worktreeRoot
    ? `\nYou are working in a worktree at ${toPromptPathToken(worktreeRoot)}; all file edits go here. Do not edit files outside this worktree.\n`
    : "";

  return `
# Implement Remediation Block

You are implementing one bounded remediation block. Edit the files needed for the
findings in this prompt, and you MAY create new files (e.g. a test file or an
extracted module) within the SAME package as those files when a finding's change
calls for it. Do not edit unrelated files in other packages, and do not change
remediation state files directly.
Repository root: ${rootDisplay}
Set the shell/tool workdir to the repository root when running commands; do not rely on cwd state from prior shell calls.

## Block

- Block ID: ${block.block_id}
- Findings: ${items.map(({ finding }) => finding.id).join(", ")}

## Items

${items
  .map(
    ({ finding, spec, clarification }) => `
### ${finding.id} — ${finding.title}

${findingLead(finding.summary)}

${renderFindingBadgeBody(finding, { showGrounding: false, showFiles: false, showDetails: false, showEvidence: false }).join("\n")}
- Files: ${itemReadFiles(finding, spec).map(resolveFilePath).join(", ")}
- Details: ${finding.summary}
${clarification ? `- Clarified scope (decided with the user — act on THIS): ${clarification}\n` : ""}${groundingVerificationBullet(finding)}
${spec ? `- Concrete change: ${spec.concrete_change}
- Tests to write: ${spec.tests_to_write
      .map((test) => `${test.name}: ${test.assertions.join("; ")}`)
      .join(" | ")}` : ""}
${upstreamExpectationsBullets(finding)}
${contractPipelineTraceBullets(finding)}
`,
  )
  .join("\n")}
${conventions ? `\n${conventions}\n` : ""}${perNodeVerificationSection(block, state, rootDisplay)}${isInfraModifyingBlock(blockWriteFiles(block, state)) ? infraModifyingSection(repoRoot) : ""}
## Verification
${worktreeNote}
Run changed or newly created tests by name when possible, and record the focused
command and result in the affected item's evidence. If a broad or full-suite
command fails in a dirty worktree and appears unrelated or pre-existing, record
that broad failure separately instead of using it as the only verdict for this
block. If a focused test for this block fails, the affected item remains blocked.
If targeted commands are listed under an item, run them when applicable and
include each command and result in that item's evidence.

Windows PowerShell: do not pipe an inline foreach statement directly into ConvertTo-Json.
Assign the foreach output to a variable first, then pipe that variable to ConvertTo-Json.

## Output

After editing and verifying the block, write JSON to exactly:

\`${resultDisplay}\`

Emit **exactly one \`item_results\` entry per node id below — no more, no fewer**.
Each entry's \`finding_id\` MUST be one of the exact ids: ${items
    .map(({ finding }) => `\`${finding.id}\``)
    .join(", ")}. Do not substitute a title, an obligation id, or a block id for
the node id, and do not emit duplicate entries for the same node.

\`\`\`json
{
  "contract_version": "${REMEDIATION_WORKER_RESULT_CONTRACT_VERSION}",
  "phase": "implement",
  "item_results": [
${items
    .map(
      ({ finding }) => `    {
      "finding_id": "${finding.id}",
      "status": "resolved",
      "evidence": ["test or verification evidence"]
    }`,
    )
    .join(",\n")}
  ]
}
\`\`\`

For an item you cannot safely finish because of an EXECUTION failure (a test
won't pass, a build breaks, the change is infeasible), set \`status\` to
\`blocked\` and include \`failure_reason\`. If instead you are stuck on a SCOPING
or JUDGMENT question — how far the fix should reach, which of several valid
behaviors is intended, or whether the issue is real — do NOT guess and do NOT
block: set \`status\` to \`needs_clarification\` and put the question in
\`clarification_question\` (optionally \`clarification_category\`). It is routed to
the user as a real question, then re-dispatched with the answer. Stop after
writing the result JSON.

## File access

Read: ${uniquePaths(items.flatMap(({ finding, spec }) => itemReadFiles(finding, spec))).join(", ")}
Write: ${uniquePaths(items.flatMap(({ finding, spec }) => itemWriteFiles(finding, spec))).join(", ")}
You may also create new files within the same package as those files (e.g. tests
or extracted modules) when a finding requires it.
If your change renames, moves, or removes a symbol, also update the existing test
files that reference it — fixing tests for a changed surface is part of this
block, not a later cleanup. Test files that reference these files are included in
your write access.
Write result: ${resultDisplay}
Do not modify unrelated files outside these paths or files in other packages.
${reflectionInvitation(feedbackDisplay, block.block_id)}`;
}

async function loadStateOrThrow(
  artifactsDir: string,
): Promise<RemediationState> {
  const state = await new StateStore(artifactsDir).loadState();
  if (!state) {
    throw new Error(`No remediation state found at ${join(artifactsDir, "state.json")}.`);
  }
  return state;
}

export async function prepareImplementDispatch(
  options: DispatchOptions,
  runId: string,
  onlyBlockId?: string,
  waveOptions?: {
    hostMaxConcurrent?: number;
    sessionConfig?: SessionConfig | null;
    hostContextTokens?: number | null;
    hostOutputTokens?: number | null;
    hostModels?: HostModelRosterEntry[] | null;
    hostModelId?: string | null;
    /**
     * Root each node's prompt at its isolated worktree (the deterministic
     * `worktreePath(root, block_id, runId)`) rather than the main checkout. Set by
     * the rolling engine (`driveRollingImplementDispatch`) so a worker told its
     * repository root is the worktree edits there, not the shared main tree.
     */
    worktreeRootedPrompts?: boolean;
  },
): Promise<RemediationDispatchPlan> {
  const state = await loadStateOrThrow(options.artifactsDir);
  if (!state.plan || !state.items) {
    throw new Error("Cannot prepare implement dispatch without plan and items.");
  }

  const dir = runDir(options.artifactsDir, runId, "implement");
  await mkdir(dir, { recursive: true });

  // Use the module-level cache so repeated calls within the same process do not
  // re-scan the filesystem for repo conventions.
  const conventions = getCachedConventions(options.root);

  const seenBlockIds = new Set<string>();
  const candidateBlocks = state.plan.blocks.filter((block) => {
    if (onlyBlockId && block.block_id !== onlyBlockId) return false;
    if (seenBlockIds.has(block.block_id)) return false;
    // Rolling eligibility (INV-RS-01): a dependent node is dispatched only once
    // every prerequisite reached a VERIFIED-COMPLETE disposition
    // (resolved / resolved_no_change). A skipped or blocked prerequisite never
    // satisfies the edge, so the dependent is held back rather than racing the
    // main tree against an upstream surface that never landed.
    if (!dependencyVerifiedComplete(block, state)) return false;
    const hasWork = block.items.some((findingId) => {
      const item = state.items?.[findingId];
      return item?.status === "pending";
    });
    if (hasWork) {
      seenBlockIds.add(block.block_id);
      return true;
    }
    return false;
  });

  // Before any node is dispatched (and therefore before any accepted commit is
  // cherry-picked into the main tree), switch the main checkout onto the dedicated
  // remediation branch so all landed work accumulates there and the base branch is
  // never modified. Idempotent across waves; only when there is work to land.
  if (candidateBlocks.length > 0 && options.root) {
    ensureRemediationBranchCheckedOut(options.root, runId);
  }

  // Walk the repo for test files ONCE per dispatch (not once per block) and cache
  // their contents; collectReferencingTests then matches in memory.
  const testIndex = buildTestFileIndex(options.root);

  const items: DispatchPlanItem[] = [];
  const itemReadFileLists: string[][] = [];
  let reconciledCount = 0;
  for (const block of candidateBlocks) {
    const item = buildImplementDispatchItem(block, state, dir);
    const readFiles = blockReadFiles(block, state);

    // Detect the package root from this block's source files: walk up from the
    // first source file to the nearest ancestor with a package.json (stop at root).
    const packageRoot = detectPackageRoot(readFiles, options.root);

    // Pull test files that reference this block's source into its access, so the
    // worker that changes or removes a symbol also fixes the tests that assert it
    // (otherwise their breakage is orphaned for a separate central mop-up).
    // Scoped to the block's package to avoid pulling in unrelated package tests.
    const referencingTests = collectReferencingTests(testIndex, readFiles, packageRoot);
    if (referencingTests.length > 0 && item.access) {
      item.access.read_paths = [
        ...new Set([...item.access.read_paths, ...referencingTests]),
      ];
      item.access.write_paths = [
        ...new Set([...item.access.write_paths, ...referencingTests]),
      ];
    }

    // Reconcile an already-produced result regardless of wave packing.
    const pendingFindingIds = pendingOrDocumentedFindingIdsForBlock(block, state);
    const existingResult = await tryLoadExistingImplementResult(item.result_path);
    if (existingResult) {
      if (implementResultCoversFindings(existingResult, pendingFindingIds)) {
        reconciledCount++;
        continue;
      }
      process.stderr.write(
        `[remediate-code] dispatch: existing implement result for block ${block.block_id} ` +
          `does not cover ${pendingFindingIds.length} still-pending item(s); re-dispatching\n`,
      );
      await archiveIncompleteImplementResult(item.result_path);
    }

    // No wave-time file-conflict deferral heuristic: parallel blocks with
    // overlapping files are both dispatched. Parallel safety comes from the planner
    // (mergeBlocksSharingFiles) and rolling verified-complete dependency ordering
    // (dependencyVerifiedComplete). Workers operate in isolated worktrees;
    // verification prevents bad merges from dirtying the main tree.

    await writeTextFile(
      item.prompt_path,
      implementPrompt(
        block,
        state,
        item.result_path,
        conventions,
        options.root,
        toPromptPathToken(join(options.artifactsDir, AGENT_FEEDBACK_FILENAME)),
        waveOptions?.worktreeRootedPrompts
          ? worktreePath(options.root, block.block_id, runId)
          : undefined,
      ),
    );
    items.push(item);
    itemReadFileLists.push([...readFiles, ...referencingTests]);
  }
  if (reconciledCount > 0) {
    console.log(`Reconciliation: reused ${reconciledCount} existing implement results.`);
  }

  const plan: RemediationDispatchPlan = {
    contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
    phase: "implement",
    run_id: runId,
    // Normalize to forward slashes so hosts running bash-like shells on Windows
    // receive paths that survive shell expansion (backslash is an escape char).
    repo_root: toPromptPathToken(options.root),
    artifacts_dir: toPromptPathToken(options.artifactsDir),
    items,
  };
  await writeJsonFile(dispatchPlanPath(options.artifactsDir, runId, "implement"), plan);

  const schedule = await scheduleWave({
    hostMaxConcurrent: waveOptions?.hostMaxConcurrent,
    sessionConfig: waveOptions?.sessionConfig ?? null,
    hostContextTokens: waveOptions?.hostContextTokens,
    hostOutputTokens: waveOptions?.hostOutputTokens,
    hostModels: waveOptions?.hostModels,
    hostModelId: waveOptions?.hostModelId,
    itemCount: items.length,
    estimatedSlotTokens: itemReadFileLists.map((files) =>
      estimateImplementSlotTokens(files, options.root),
    ),
  });
  process.stderr.write(
    `[remediate-code] dispatch: implement max_concurrent=${schedule.max_concurrent} of ${items.length} item(s) ` +
      `source=${schedule.source} cap=${schedule.binding_cap ?? "none"}\n`,
  );
  const quota = buildDispatchQuota(runId, "implement", schedule);
  await writeJsonFile(join(dir, "dispatch-quota.json"), quota);

  return plan;
}

function assertImplementWorkerResult(value: unknown, path: string): asserts value is ImplementWorkerResult {
  const issues = validateImplementWorkerResult(value, path).filter((i) => i.severity === "error");
  if (issues.length > 0) {
    throw new Error(formatValidationIssues(issues));
  }
}

// ---------------------------------------------------------------------------
// Merge-seam: git-diff write-scope enforcement (never trust amended_files)
// ---------------------------------------------------------------------------

/** Outcome of resolving the worker's ACTUAL edited files from git. */
export type GitEditedFiles =
  | { available: true; files: Set<string> }
  /** git is present but a probe failed against a real repo → fail closed. */
  | { available: false; reason: "probe_failed"; error: string }
  /** root is not under version control at all → no ground truth, gate is skipped. */
  | { available: false; reason: "not_a_repo"; error: string };

/** True when `root` is inside a git work tree (the git tool is present and it's a repo). */
function isGitWorkTree(root: string): boolean {
  const probe = spawnSync(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  return !probe.error && probe.status === 0 && /true/.test(probe.stdout ?? "");
}

/** True when `branch` resolves to a commit in the repo at `root`. */
function gitBranchExists(root: string, branch: string): boolean {
  const probe = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`],
    { cwd: root, encoding: "utf8", shell: false },
  );
  return !probe.error && probe.status === 0;
}

/**
 * The set of repo-relative paths the worker ACTUALLY edited, read from git
 * (tracked modifications + staged + untracked-not-ignored). This is the ground
 * truth for write-scope enforcement; the worker's self-reported `amended_files`
 * is advisory only and is never trusted for the scope gate.
 *
 * Fail-closed: when `root` IS a git repo but a probe errors, returns
 * `{ available: false, reason: "probe_failed" }` so the caller blocks rather than
 * silently trusting an unverifiable edit set. When `root` is not a git repo at
 * all (no worktree workflow, no diff ground truth), returns
 * `{ available: false, reason: "not_a_repo" }` so the caller skips the gate.
 */
export function gitEditedFiles(root: string): GitEditedFiles {
  if (!isGitWorkTree(root)) {
    return { available: false, reason: "not_a_repo", error: "root is not a git work tree" };
  }
  // `git diff --name-only HEAD` covers tracked working-tree + staged changes
  // against the last commit; `ls-files --others --exclude-standard` adds new
  // untracked files that aren't gitignored.
  const diff = spawnSync(
    "git",
    ["diff", "--name-only", "HEAD"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (diff.error || typeof diff.status !== "number" || diff.status !== 0) {
    const detail = (diff.stderr ?? diff.error?.message ?? "git diff failed").toString().trim();
    return { available: false, reason: "probe_failed", error: detail };
  }
  const others = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (others.error || typeof others.status !== "number" || others.status !== 0) {
    const detail = (others.stderr ?? others.error?.message ?? "git ls-files failed").toString().trim();
    return { available: false, reason: "probe_failed", error: detail };
  }
  const files = new Set<string>();
  for (const line of `${diff.stdout}\n${others.stdout}`.split(/\r?\n/)) {
    const p = line.trim();
    if (p.length > 0) files.add(p.replace(/\\/g, "/"));
  }
  return { available: true, files };
}

/** Normalize a declared path (absolute, repo-relative, or back-slashed) to a repo-relative forward-slash string. */
function toRepoRelative(p: string, root: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  let s = p.replace(/\\/g, "/");
  if (s.startsWith(normalizedRoot + "/")) {
    s = s.slice(normalizedRoot.length + 1);
  }
  return s;
}

/**
 * Files the worker edited (from git) that fall OUTSIDE the block's declared
 * write scope. Result-file artifacts and the agent-feedback file are excluded
 * (they are sanctioned side outputs, never source edits). Returns the offending
 * repo-relative paths (empty when the edits are fully within scope).
 */
export function writeScopeViolations(
  declaredWritePaths: string[],
  editedFiles: Set<string>,
  root: string,
): string[] {
  const declared = new Set(declaredWritePaths.map((p) => toRepoRelative(p, root)));
  const violations: string[] = [];
  for (const edited of editedFiles) {
    const rel = toRepoRelative(edited, root);
    if (declared.has(rel)) continue;
    // Sanctioned non-source outputs: result JSON files and the reflection file.
    if (rel.endsWith(".result.json")) continue;
    if (rel.endsWith(AGENT_FEEDBACK_FILENAME)) continue;
    violations.push(rel);
  }
  return violations;
}

/** Branch name a block's isolated worktree is created on (mirrors `worktreePath`). */
export function worktreeBranchForBlock(blockId: string, runId: string): string {
  return `remediate-${blockId}-${runId}`;
}

/**
 * The files a worker's worktree branch changed relative to HEAD — the ground
 * truth for write-scope enforcement. Diffs `HEAD...<branch>` (the branch's own
 * commits). Fail-closed / not-a-repo semantics mirror `gitEditedFiles`.
 */
export function gitEditedFilesForBranch(root: string, branch: string): GitEditedFiles {
  if (!isGitWorkTree(root)) {
    return { available: false, reason: "not_a_repo", error: "root is not a git work tree" };
  }
  const diff = spawnSync(
    "git",
    ["diff", "--name-only", `HEAD...${branch}`],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (diff.error || typeof diff.status !== "number" || diff.status !== 0) {
    const detail = (diff.stderr ?? diff.error?.message ?? "git diff failed").toString().trim();
    return { available: false, reason: "probe_failed", error: detail };
  }
  const files = new Set<string>();
  for (const line of (diff.stdout ?? "").split(/\r?\n/)) {
    const p = line.trim();
    if (p.length > 0) files.add(p.replace(/\\/g, "/"));
  }
  return { available: true, files };
}

/** The decision a write-scope gate makes given the resolved edit set. */
export interface WriteScopeDecision {
  blocked: boolean;
  reason?: string;
}

/**
 * Pure write-scope gate decision (OBL-DS-06). Given the block's declared write
 * paths and the resolved git edit set:
 *  - `not_a_repo`   → no ground truth (no worktree workflow) → not blocked.
 *  - `probe_failed` → git is a repo but the diff failed → FAIL CLOSED (blocked).
 *  - available      → block iff any edited file is outside declared scope.
 * The worker's self-reported `amended_files` is never an input here.
 */
export function enforceWriteScope(
  declaredWritePaths: string[],
  edited: GitEditedFiles,
  root: string,
): WriteScopeDecision {
  if (!edited.available) {
    if (edited.reason === "not_a_repo") {
      return { blocked: false };
    }
    // probe_failed: git is present but could not be queried → fail closed.
    return {
      blocked: true,
      reason:
        `Write-scope could not be verified: git probe failed (${edited.error}). ` +
        `Failing closed rather than trusting self-reported edits.`,
    };
  }
  const violations = writeScopeViolations(declaredWritePaths, edited.files, root);
  if (violations.length === 0) return { blocked: false };
  return {
    blocked: true,
    reason:
      `Worker edited files outside its declared write scope: ${violations.join(", ")}. ` +
      `Declared scope must be amended through the seam protocol; the self-reported ` +
      `amended_files set is not trusted for this gate.`,
  };
}

/** Each block's declared write scope from a dispatch plan — the seed for the
 *  accept-time write-scope gate's ownership registry (so an amended path owned by
 *  a sibling block is recognised as a seam conflict, not silently granted). */
export function blockScopesFromPlan(
  plan: RemediationDispatchPlan,
): Array<{ block_id: string; write_paths: string[] }> {
  return plan.items.flatMap((item) =>
    item.block_id && item.access
      ? [{ block_id: item.block_id, write_paths: item.access.write_paths }]
      : [],
  );
}

/**
 * A block's declared target paths (write ∪ read) from the persisted dispatch plan
 * — the single source of the scope the worker actually received (same authority
 * the accept-time write-scope gate reads). Used to seed untracked declared targets
 * into a fresh worktree (see {@link seedUntrackedDeclaredPaths}).
 */
export function declaredPathsFromPlan(
  plan: RemediationDispatchPlan,
  blockId: string,
): string[] {
  const item = plan.items.find((i) => i.block_id === blockId);
  if (!item?.access) return [];
  return [...(item.access.write_paths ?? []), ...(item.access.read_paths ?? [])];
}

/**
 * Pure write-scope adjudication (OBL-DS-06) — git-free so it is unit-testable with
 * a synthetic edit set. Seeds an ephemeral `OwnershipRegistry` from `allBlockScopes`
 * (normalised to repo-relative so ownership compares like-for-like) and routes the
 * node's ACTUAL out-of-declared edits — the git ground truth, never a self-report:
 *  - an edit to a file no sibling block owns is granted and widens this node's
 *    effective scope (a too-narrow — or empty — declared scope no longer blocks a
 *    correct fix; this is the sanctioned "extend into unowned files" path);
 *  - an edit to a file in another block's declared scope is a seam conflict that
 *    blocks until the seam protocol re-scopes or serialises the nodes.
 * Cross-sibling contention on a file two live nodes both touch (neither declared)
 * is left to the merge-time lost-update detector (`detectOverlappingEdits`), which
 * sees the full set of merged blocks a single accept cannot.
 */
export function adjudicateWriteScope(
  allBlockScopes: Array<{ block_id: string; write_paths: string[] }>,
  blockId: string,
  edited: GitEditedFiles,
  root: string,
): WriteScopeDecision {
  const registry = new OwnershipRegistry();
  registry.initialize(
    allBlockScopes.map((b) => ({
      node_id: b.block_id,
      write_paths: b.write_paths.map((p) => toRepoRelative(p, root)),
    })),
  );
  if (edited.available) {
    // The node's real source edits outside its declared scope (sanctioned side
    // outputs already excluded by writeScopeViolations).
    const candidates = writeScopeViolations(registry.getScope(blockId), edited.files, root);
    if (candidates.length > 0) {
      const { seam_routed } = routeAmendmentRequest(registry, blockId, candidates);
      if (seam_routed.length > 0) {
        const detail = seam_routed
          .map((r) => {
            const reason = r.reason;
            if (reason.outcome === "owned") return `${r.path} owned by ${reason.owner_node_id}`;
            if (reason.outcome === "contended") {
              return `${r.path} contended by ${reason.sibling_node_id}`;
            }
            return r.path;
          })
          .join("; ");
        return {
          blocked: true,
          reason:
            `Node edited files owned by another block (seam conflict): ${detail}. ` +
            `Resolve via the seam protocol (re-scope contracts or serialise the nodes) before this node can land.`,
        };
      }
      // every candidate was unowned → granted into this node's effective scope.
    }
  }
  return enforceWriteScope(registry.getScope(blockId), edited, root);
}

/**
 * Accept-time write-scope gate, run from `acceptNodeWorktree` AFTER the verify and
 * BEFORE the cherry-pick so a violation PREVENTS the merge rather than being
 * reported once the edit already landed in main. Thin git wrapper around
 * {@link adjudicateWriteScope}: resolves the branch's actual edits and adjudicates.
 */
export function enforceAcceptWriteScope(params: {
  root: string;
  branch: string;
  blockId: string;
  allBlockScopes: Array<{ block_id: string; write_paths: string[] }>;
}): WriteScopeDecision {
  const { root, branch, blockId, allBlockScopes } = params;
  return adjudicateWriteScope(
    allBlockScopes,
    blockId,
    gitEditedFilesForBranch(root, branch),
    root,
  );
}

// ---------------------------------------------------------------------------
// Merge-seam: obligation-id → node remap + multi-entry collapse (tolerance)
// ---------------------------------------------------------------------------

/**
 * Build the map from a known obligation/node alias to the finding id that owns
 * it, for one block. A worker that mislabels its `finding_id` as an obligation
 * id it was assigned (or a CP-BLOCK-prefixed/unprefixed node alias) is remapped
 * to the owning node's finding rather than dropped as an orphan — the tolerant
 * seam (the host is a variable of any strength). The map only ever points at
 * findings that belong to THIS block, so a mislabel can never resolve to an
 * unrelated node.
 */
export function buildBlockAliasMap(
  block: RemediationBlock,
  state: RemediationState,
): Map<string, string> {
  const aliasToFinding = new Map<string, string>();
  for (const findingId of block.items) {
    const finding = state.plan?.findings.find((f) => f.id === findingId);
    if (!finding) continue;
    // The node id itself, and its block-prefixed / unprefixed aliases.
    const register = (alias: string | undefined) => {
      if (!alias || alias === findingId) return;
      if (!aliasToFinding.has(alias)) aliasToFinding.set(alias, findingId);
    };
    // CP-BLOCK- aliases are now resolved deterministically by the id registry in
    // `collapseItemResults` (S4); registering them here is defence-in-depth only.
    register(toBlockId(findingId));
    register(block.block_id);
    // The obligation ids the node satisfies/verifies — a worker may report one.
    for (const obl of [
      ...(finding.contract_obligation_ids ?? []),
      ...(finding.verification_obligation_ids ?? []),
    ]) {
      register(obl);
    }
  }
  return aliasToFinding;
}

/**
 * Collapse a worker result's `item_results` to one entry per resolved finding
 * id, applying the block alias map first (obligation/node-alias → finding). When
 * several entries collapse onto the same finding, a single `blocked` entry wins
 * over `resolved` (a node is not complete if any reported facet failed), and the
 * union of evidence / first failure_reason is preserved. Entries whose id is
 * neither a known finding nor a known alias are returned in `unresolved` so the
 * caller can record them as orphans.
 */
export function collapseItemResults(
  itemResults: ImplementWorkerResult["item_results"],
  aliasMap: Map<string, string>,
  knownFindingIds: Set<string>,
): {
  collapsed: ImplementWorkerResult["item_results"];
  unresolved: ImplementWorkerResult["item_results"];
} {
  const byFinding = new Map<string, ImplementWorkerResult["item_results"][number]>();
  const unresolved: ImplementWorkerResult["item_results"] = [];
  for (const entry of itemResults) {
    let targetId = entry.finding_id;
    if (!knownFindingIds.has(targetId)) {
      // Registry-authoritative (S4): a CP-BLOCK- block id maps deterministically
      // to its bare node id via the id registry, so the common "worker reported
      // the block id" mislabel resolves here without the tolerant alias remap —
      // the remap is defence-in-depth for non-block aliases (e.g. a mislabelled
      // obligation id) only.
      const nodeId = fromBlockId(targetId);
      if (nodeId && knownFindingIds.has(nodeId)) {
        targetId = nodeId;
      } else {
        const remapped = aliasMap.get(targetId);
        if (remapped) {
          targetId = remapped;
        } else {
          unresolved.push(entry);
          continue;
        }
      }
    }
    const normalized = { ...entry, finding_id: targetId };
    const existing = byFinding.get(targetId);
    if (!existing) {
      byFinding.set(targetId, normalized);
      continue;
    }
    // Collapse precedence: blocked > needs_clarification > resolved >
    // resolved_no_change. A hard failure dominates an unanswered scoping question,
    // which dominates an actual change, which dominates a no-change claim (a
    // no-change claim only survives if every entry agreed nothing changed). Merge
    // evidence; keep first failure_reason / clarification question.
    const mergedEvidence = [
      ...new Set([...(existing.evidence ?? []), ...(normalized.evidence ?? [])]),
    ];
    const status: ImplementWorkerResult["item_results"][number]["status"] =
      existing.status === "blocked" || normalized.status === "blocked"
        ? "blocked"
        : existing.status === "needs_clarification" || normalized.status === "needs_clarification"
          ? "needs_clarification"
          : existing.status === "resolved" || normalized.status === "resolved"
            ? "resolved"
            : "resolved_no_change";
    byFinding.set(targetId, {
      finding_id: targetId,
      status,
      evidence: mergedEvidence.length > 0 ? mergedEvidence : undefined,
      failure_reason: existing.failure_reason ?? normalized.failure_reason,
      clarification_question:
        existing.clarification_question ?? normalized.clarification_question,
      clarification_category:
        existing.clarification_category ?? normalized.clarification_category,
    });
  }
  return { collapsed: [...byFinding.values()], unresolved };
}

// ---------------------------------------------------------------------------
// Merge-seam: per-node disposition (INV-DS-15) + sibling-red routing (INV-DS-14)
// ---------------------------------------------------------------------------

export type NodeDispositionStatus =
  | "verified_complete"
  | "blocked"
  | "skipped"
  | "missing_result";

export interface NodeDisposition {
  node_id: string;
  block_id: string;
  disposition: NodeDispositionStatus;
  /** The state status the node's finding(s) ended in. */
  finding_status: string;
  /** Reconciliation expectations the node was responsible for honoring (INV-DS-12). */
  reconciliation_expectations: string[];
  /** Why the node landed in this disposition (failure_reason / skip reason). */
  reason?: string;
}

/**
 * Build the per-node disposition for a block (INV-DS-15). A SKIP disposition
 * (user-skipped: `ignored` / `deemed_inappropriate`) is NEVER reported as
 * `verified_complete`. Each block maps 1:1 to a node, so the disposition keys on
 * the block's first finding (the node id).
 */
export function buildNodeDisposition(
  block: RemediationBlock,
  state: RemediationState,
): NodeDisposition {
  const nodeId = block.items[0] ?? block.block_id;
  const finding = state.plan?.findings.find((f) => f.id === nodeId);
  // Resolve the block's overall status from its items.
  const statuses = block.items.map((id) => state.items?.[id]?.status ?? "pending");
  const isSkip = statuses.some((s) => isSkipStatus(s));
  const allResolved =
    statuses.length > 0 && statuses.every((s) => isVerifiedCompleteStatus(s));
  const anyBlocked = statuses.some((s) => s === "blocked");
  let disposition: NodeDispositionStatus;
  if (isSkip) {
    // INV-DS-15: a skipped node is never verified_complete.
    disposition = "skipped";
  } else if (anyBlocked) {
    disposition = "blocked";
  } else if (allResolved) {
    disposition = "verified_complete";
  } else {
    disposition = "missing_result";
  }
  const reason = block.items
    .map((id) => state.items?.[id]?.failure_reason)
    .find((r): r is string => typeof r === "string" && r.length > 0);
  return {
    node_id: nodeId,
    block_id: block.block_id,
    disposition,
    finding_status: statuses.join(","),
    reconciliation_expectations: finding ? reconciliationExpectationsOf(finding) : [],
    reason,
  };
}

/**
 * Attribute a post-merge sibling-block failure (INV-DS-14). Given the repo-
 * relative paths implicated by a red sibling and the merged blocks' declared
 * write scopes, return the exactly-one block whose scope contains an implicated
 * file (attributable → route THAT sibling to triage). When zero or more than one
 * merged block could own the failure, the red is unattributable and is deferred
 * to the rolling-scheduler's coarse backstop (return null).
 */
export function attributeSiblingRed(
  implicatedFiles: string[],
  mergedBlockScopes: Array<{ block_id: string; write_paths: string[] }>,
  root: string,
): string | null {
  const implicated = new Set(implicatedFiles.map((p) => toRepoRelative(p, root)));
  const owners = new Set<string>();
  for (const { block_id, write_paths } of mergedBlockScopes) {
    for (const wp of write_paths) {
      if (implicated.has(toRepoRelative(wp, root))) {
        owners.add(block_id);
        break;
      }
    }
  }
  // Attributable only when a single merged block owns the implicated surface.
  return owners.size === 1 ? [...owners][0] : null;
}

// ---------------------------------------------------------------------------
// Merge-seam: lost-update / overlapping-edit detection (ARC-f378135d-2 / ARC-c1693139)
// ---------------------------------------------------------------------------

/** A merged block's ACTUAL edited file set (resolved from its worktree branch diff). */
export interface BlockEditedFiles {
  block_id: string;
  /** Repo-relative forward-slash paths the block's worker actually changed. */
  files: Set<string>;
}

/** One detected overlap: two merged blocks whose actual edits hit the same file. */
export interface OverlappingEdit {
  path: string;
  block_ids: string[];
}

/**
 * Detect lost-update hazards across concurrently-merged blocks (ARC-f378135d-2 /
 * ARC-c1693139). When the rolling engine dispatches multiple nodes in flight and
 * each worker edits in its own worktree, two workers can both modify the SAME
 * file; cherry-picking both branches silently drops one worker's change to that
 * file (lost update). This pure function returns every repo-relative path that
 * appears in more than one merged block's ACTUAL edit set, with the owning block
 * ids. The caller routes the involved blocks to triage so the conflict is
 * reconciled rather than silently losing an edit. Result-file artifacts and the
 * agent-feedback file are sanctioned side outputs and are never counted as
 * overlaps.
 */
export function detectOverlappingEdits(
  editedByBlock: BlockEditedFiles[],
): OverlappingEdit[] {
  const pathToBlocks = new Map<string, Set<string>>();
  for (const { block_id, files } of editedByBlock) {
    for (const file of files) {
      const rel = file.replace(/\\/g, "/");
      // Sanctioned non-source outputs never constitute a lost-update conflict.
      if (rel.endsWith(".result.json")) continue;
      if (rel.endsWith(AGENT_FEEDBACK_FILENAME)) continue;
      let owners = pathToBlocks.get(rel);
      if (!owners) {
        owners = new Set<string>();
        pathToBlocks.set(rel, owners);
      }
      owners.add(block_id);
    }
  }
  const overlaps: OverlappingEdit[] = [];
  for (const [path, owners] of pathToBlocks) {
    if (owners.size > 1) {
      overlaps.push({ path, block_ids: [...owners].sort() });
    }
  }
  // Deterministic ordering so the diagnostic + tests are stable.
  return overlaps.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The contract-pipeline obligation ids a finding covers — the union of its
 * `contract_obligation_ids` (satisfied) and `verification_obligation_ids`
 * (verified). Empty for audit-findings intake (no contract overlay), so the DC-5
 * verify gate is inert there.
 */
function obligationIdsForFinding(
  state: RemediationState,
  findingId: string,
): string[] {
  const finding = state.plan?.findings.find((f) => f.id === findingId);
  if (!finding) return [];
  return [
    ...(finding.contract_obligation_ids ?? []),
    ...(finding.verification_obligation_ids ?? []),
  ];
}

export async function mergeImplementResults(
  options: DispatchOptions,
  runId: string,
): Promise<RemediationState> {
  const plan = await readJsonFile<RemediationDispatchPlan>(
    dispatchPlanPath(options.artifactsDir, runId, "implement"),
  );
  if (
    plan.contract_version !== REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION ||
    plan.phase !== "implement"
  ) {
    throw new Error("Implement dispatch plan has an unsupported contract.");
  }

  const store = new StateStore(options.artifactsDir);

  // OBL-INV-RSD-02 / OBL-SEAM-RSD-04: the entire read-modify-write of state.json
  // is performed under a single held lock via StateStore.mutate, and committed
  // exactly once after the full item loop. No partial state.json write happens
  // mid-loop — a malformed/unknown finding_id no longer leaves a half-applied
  // state (and never throws past the loop; see OBL-INV-RSD-01 below). Evidence
  // artifacts (result_<id>_verify_code_against_documentation.json, the orphan
  // diagnostic) are separate sidecar files, not state.json, so writing them
  // inside the loop does not violate the single-state-commit invariant.
  return store.mutate(async (loaded) => {
    if (!loaded) {
      throw new Error(
        `No remediation state found at ${join(options.artifactsDir, "state.json")}.`,
      );
    }
    const state = loaded;
    if (!state.items) {
      throw new Error("Cannot merge implement results without items.");
    }

    return mergeImplementResultsIntoState(options, runId, plan, state);
  });
}

/**
 * Apply every dispatched implement worker result to `state` (mutated in place)
 * and return it. Runs inside the StateStore.mutate lock so the caller commits
 * the result exactly once (OBL-INV-RSD-02 / OBL-SEAM-RSD-04). Pure with respect
 * to state.json: it mutates the in-memory `state` and writes only sidecar
 * evidence/diagnostic artifacts.
 */
async function mergeImplementResultsIntoState(
  options: DispatchOptions,
  runId: string,
  plan: RemediationDispatchPlan,
  state: RemediationState,
): Promise<RemediationState> {
  if (!state.items) {
    throw new Error("Cannot merge implement results without items.");
  }
  const dir = runDir(options.artifactsDir, runId, "implement");

  // DC-5 verify gate: load the obligation_ledger + test_validator_plan once so a
  // resolved finding that covers a behavior-CHANGE obligation can be re-blocked
  // when its test specs are only one polarity (a positive without a scoped
  // negative, or a negative-only set). Absent for non-contract-pipeline runs
  // (audit-findings intake), where the gate is inert. Read defensively: the
  // payloads are the validated artifact bodies, or `undefined` when missing.
  const obligationLedgerPayload =
    (await readContractArtifact(options.artifactsDir, "obligation_ledger"))?.payload;
  const testValidatorPlanPayload =
    (await readContractArtifact(options.artifactsDir, "test_validator_plan"))?.payload;

  const plannedBlockIds = new Set(
    plan.items.map((item) => item.block_id).filter((id): id is string => typeof id === "string"),
  );
  const itemsToMerge = [...plan.items];
  for (const block of state.plan?.blocks ?? []) {
    if (plannedBlockIds.has(block.block_id)) {
      continue;
    }
    const hasDocumentedWork = block.items.some((findingId) => {
      const stateItem = state.items?.[findingId];
      return stateItem?.status === "pending";
    });
    if (!hasDocumentedWork) {
      continue;
    }

    const item = buildImplementDispatchItem(block, state, dir);
    const existingResult = await tryLoadExistingImplementResult(item.result_path);
    const pendingFindingIds = pendingOrDocumentedFindingIdsForBlock(block, state);
    if (
      !existingResult ||
      !implementResultCoversFindings(existingResult, pendingFindingIds)
    ) {
      continue;
    }

    itemsToMerge.push(item);
  }

  // Build a lightweight ownership registry seeded from each block's declared
  // write_paths so amended_files checks are correct even when no rolling-dispatch
  // registry was persisted (interim path, until rollingDispatch replaces this).
  const mergeRegistry = new OwnershipRegistry();
  const dagNodes = itemsToMerge.flatMap((item) => {
    if (!item.block_id || !item.access) return [];
    return [{ node_id: item.block_id, write_paths: item.access.write_paths }];
  });
  mergeRegistry.initialize(dagNodes);

  // OBL-INV-RSD-01: a worker result whose finding_id is not in state.items is
  // never silently dropped and never throws past the loop. Each such id is
  // recorded here; if it belongs to a known block (via the result's owning
  // task block_id) that block's non-terminal items are blocked, otherwise it is
  // a true orphan recorded in the diagnostic artifact below. Either way the run
  // cannot advance past an unaccounted result.
  const orphanResults: Array<{
    finding_id: string;
    result_path: string;
    owning_block_id: string | null;
    disposition: "blocked_owning_block" | "orphan";
    worker_status: string;
  }> = [];

  // Per-block ACTUAL edited file sets (resolved from each block's worktree
  // branch), collected for post-loop lost-update / overlapping-edit detection
  // (ARC-f378135d-2 / ARC-c1693139). Only blocks dispatched through an isolated
  // worktree (their branch exists) contribute; the interim main-tree path has no
  // per-worker diff to attribute, so it cannot be checked for cross-block overlap.
  const editedByBlock: BlockEditedFiles[] = [];

  for (const item of itemsToMerge) {
    if (!existsSync(item.result_path)) {
      console.warn(`Missing implement worker result: ${item.result_path} — marking items blocked.`);
      const block = item.block_id
        ? state.plan?.blocks.find((b) => b.block_id === item.block_id)
        : undefined;
      for (const findingId of block?.items ?? []) {
        const stateItem = state.items[findingId];
        // Don't flip a terminal item (resolved, or user-skipped
        // deemed_inappropriate/ignored) to blocked — only items that were
        // actually awaiting this worker's result.
        if (!stateItem || isTerminalStatus(stateItem.status)) continue;
        stateItem.status = "blocked";
        markTerminal(stateItem);
        stateItem.failure_reason =
          `Implementation worker did not produce a result file: ${item.result_path}`;
      }
      continue;
    }
    const result = await readJsonFile<unknown>(item.result_path);
    assertImplementWorkerResult(result, item.result_path);

    // Gate amended_files through the ownership registry (N-R22).
    // Unowned amended paths are granted and added to this block's effective scope
    // for verification; owned/contended paths block the item with a seam conflict.
    const blockId = item.block_id ?? "";
    if (result.amended_files && result.amended_files.length > 0) {
      const { granted, seam_routed } = routeAmendmentRequest(
        mergeRegistry,
        blockId,
        result.amended_files,
      );
      if (granted.length > 0 && item.access) {
        // Expand the block's effective write scope for downstream verification.
        item.access.write_paths = uniquePaths([...item.access.write_paths, ...granted]);
      }
      if (seam_routed.length > 0) {
        // Mark all non-terminal items in this block as blocked with seam conflict detail.
        const block = state.plan?.blocks.find((b) => b.block_id === blockId);
        for (const findingId of block?.items ?? []) {
          const stateItem = state.items[findingId];
          if (!stateItem || isTerminalStatus(stateItem.status)) continue;
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason =
            `Seam conflict on amended_files: ${seam_routed
              .map((r) => {
                const reason = r.reason;
                if (reason.outcome === "owned") {
                  return `${r.path} owned by ${reason.owner_node_id}`;
                } else if (reason.outcome === "contended") {
                  return `${r.path} contended by ${reason.sibling_node_id}`;
                }
                return r.path;
              })
              .join("; ")}`;
        }
        // Release any grants we just made before moving on (best-effort cleanup).
        mergeRegistry.releaseAmendments(blockId);
        continue;
      }
    }

    // Tolerant seam: remap an obligation/node-alias finding_id to the owning
    // node's finding, and collapse multi-entry results onto one entry per
    // finding (blocked dominates), before applying any status. A mislabel can
    // only ever resolve to a finding that belongs to THIS block.
    const owningBlock = blockId
      ? state.plan?.blocks.find((b) => b.block_id === blockId)
      : undefined;
    const aliasMap = owningBlock
      ? buildBlockAliasMap(owningBlock, state)
      : new Map<string, string>();
    const knownFindingIds = new Set(Object.keys(state.items));
    const { collapsed, unresolved } = collapseItemResults(
      result.item_results,
      aliasMap,
      knownFindingIds,
    );

    // Track which findings in this block this worker flipped to a resolved
    // status, so the write-scope gate below can re-block them if the worker's
    // ACTUAL git edits fall outside the declared scope.
    const resolvedFindingIds: string[] = [];

    for (const itemResult of unresolved) {
      // OBL-INV-RSD-01: do NOT throw on an unknown finding_id that did not remap
      // to a known node alias. Block the owning block's non-terminal items so the
      // run cannot advance past an unaccounted result; record a diagnostic.
      if (owningBlock) {
        for (const findingId of owningBlock.items) {
          const owningItem = state.items[findingId];
          if (!owningItem || isTerminalStatus(owningItem.status)) continue;
          owningItem.status = "blocked";
          markTerminal(owningItem);
          owningItem.failure_reason =
            `Implementation worker for block ${blockId} reported an unknown ` +
            `finding_id "${itemResult.finding_id}" not present in this plan ` +
            `(and not a known obligation/node alias of this block); blocking the ` +
            `block's items so the run does not advance past an unaccounted result.`;
        }
        orphanResults.push({
          finding_id: itemResult.finding_id,
          result_path: item.result_path,
          owning_block_id: blockId,
          disposition: "blocked_owning_block",
          worker_status: itemResult.status,
        });
      } else {
        orphanResults.push({
          finding_id: itemResult.finding_id,
          result_path: item.result_path,
          owning_block_id: null,
          disposition: "orphan",
          worker_status: itemResult.status,
        });
      }
    }

    for (const itemResult of collapsed) {
      const stateItem = state.items[itemResult.finding_id];
      if (!stateItem) continue;
      // A worker may report a finding that is already terminal (user-skipped, or
      // resolved in a prior wave) — never let a result resurrect or overwrite it.
      if (isTerminalStatus(stateItem.status)) {
        continue;
      }
      if (itemResult.status === "resolved" || itemResult.status === "resolved_no_change") {
        const spec = stateItem.item_spec;
        // The worker's explicit `resolved_no_change` is a no-change signal in its
        // own right; the spec heuristic is the fallback for a plain `resolved`.
        const isNoChange =
          itemResult.status === "resolved_no_change" || specIndicatesNoChange(spec);
        // DC-5 verify gate: an actual-change closure for a finding that covers a
        // behavior-CHANGE obligation must have a paired positive+scoped-negative
        // test spec; only-one-polarity (or an unscoped repo-wide negative) is
        // blocked, never silently resolved. The same single-source pairing/scoping
        // evaluation the test-plan derivation gate uses. A no-change closure makes
        // no edits, so it is exempt (the closure path above already proves it).
        const pairingBlockReason = isNoChange
          ? null
          : verifyPairingForFinding(
              obligationIdsForFinding(state, itemResult.finding_id),
              obligationLedgerPayload,
              testValidatorPlanPayload,
            );
        if (isNoChange && !hasExecutableEvidence(itemResult.evidence)) {
          // No-prose closure: a "verified-already-satisfied" (no-change) claim must
          // be backed by an executable assertion (a test/build/check command +
          // result), not prose — otherwise a real requirement silently no-ops.
          // Route an unproven no-change claim to triage instead of closing it.
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason =
            "verified-already-satisfied requires an executable regression test proving " +
            "the behavior (a test/build/check command + result in evidence), not prose.";
        } else if (pairingBlockReason) {
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason = pairingBlockReason;
        } else {
          stateItem.status = isNoChange ? "resolved_no_change" : "resolved";
          markTerminal(stateItem);
          // A no-change closure makes no edits, so it is exempt from the
          // git-diff write-scope gate; an actual fix is subject to it.
          if (!isNoChange) {
            resolvedFindingIds.push(itemResult.finding_id);
          }
          // OBL-INV-RSD-06 / OBL-SEAM-RSD-03: use the shared REMEDIATION_STEP
          // constant, never the bare string literal, so this path and any other
          // verify-against-documentation writer agree on one source of truth.
          stateItem.last_successful_step =
            REMEDIATION_STEP.VERIFY_AGAINST_DOCUMENTATION;
          if (itemResult.evidence?.length) {
            await writeJsonFile(
              join(
                options.artifactsDir,
                `result_${itemResult.finding_id}_verify_code_against_documentation.json`,
              ),
              {
                finding_id: itemResult.finding_id,
                passed: true,
                reason: itemResult.evidence,
              },
            );
          }
        }
      } else if (itemResult.status === "needs_clarification") {
        // Mid-run escape hatch (note 3, part B): the worker hit scoping/judgment
        // ambiguity. Route it to a clarification round (a real user question), not
        // to triage's retry/ignore/halt. NOT terminal — the answer re-opens it.
        stateItem.status = "needs_clarification";
        const question =
          itemResult.clarification_question ??
          itemResult.failure_reason ??
          "The worker reported unresolved scoping/judgment ambiguity.";
        stateItem.failure_reason = question;
        const category = isClarificationCategory(itemResult.clarification_category)
          ? itemResult.clarification_category
          : "scope_of_fix";
        const clarifications = state.clarifications ?? [];
        if (!clarifications.some((c) => c.finding_id === itemResult.finding_id)) {
          clarifications.push({
            finding_id: itemResult.finding_id,
            category,
            description: question,
          });
        }
        state.clarifications = clarifications;
        // The run is paused for the batched clarification round at the single
        // post-loop status decision below (a needs_clarification item outranks
        // implementing/triage), so the answer is applied before any more work.
      } else {
        stateItem.status = "blocked";
        markTerminal(stateItem);
        stateItem.failure_reason =
          itemResult.failure_reason ?? "Implementation worker blocked.";
      }
    }

    // Per-block ACTUAL worktree-branch edits, collected for the post-loop
    // lost-update / overlapping-edit detection (a file edited by more than one
    // merged block). The write-scope gate itself is NOT applied here: it runs at
    // ACCEPT time (`acceptNodeWorktree` → `enforceAcceptWriteScope`), BEFORE the
    // cherry-pick, so an out-of-scope edit is prevented from landing rather than
    // reported once already merged — and a node it blocks reaches the merge as
    // `merged:false`, routed to triage by the merge-state gate below (with the
    // write-scope reason carried in its diagnostic). A missing branch means the
    // interim main-tree path was used (no per-worker diff): nothing to collect.
    const worktreeBranch = worktreeBranchForBlock(blockId, runId);
    const branchEdited = gitBranchExists(options.root, worktreeBranch)
      ? gitEditedFilesForBranch(options.root, worktreeBranch)
      : null;
    if (branchEdited?.available) {
      editedByBlock.push({ block_id: blockId, files: branchEdited.files });
    }

    // Merge-state gate (authoritative, OBL-DS-06): a node that self-reported a
    // finding "resolved" but whose tool-owned verify/merge did NOT land its edits
    // (acceptNodeWorktree returned merged:false — verify failed, a cherry-pick
    // conflict, or no actual edit) must never stand as resolved: its fix is not in
    // the main tree. The recorded per-node accept outcome is the ground truth, never
    // the worker's result file. Keyed on resolvedFindingIds, so a legitimate
    // no-change closure (which makes no edits by design, and is not in that set)
    // stays exempt. Worktree-dispatched blocks have a record; the interim main-tree
    // path writes none, so this gate is inert there.
    if (resolvedFindingIds.length > 0) {
      const acceptOutcome = await loadNodeAcceptOutcome(options.artifactsDir, runId, blockId);
      if (acceptOutcome && !acceptOutcome.merged) {
        for (const findingId of resolvedFindingIds) {
          const stateItem = state.items[findingId];
          if (!stateItem) continue;
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason =
            `Node ${blockId} reported finding ${findingId} resolved, but its tool-owned ` +
            `verify/merge did not land the edits (outcome=${acceptOutcome.outcome}, ` +
            `verify_passed=${acceptOutcome.verifyPassed}, merged=false); the fix is not in ` +
            `the main tree. Routed to triage.` +
            (acceptOutcome.diagnostic
              ? `\nFailing command output:\n${acceptOutcome.diagnostic}`
              : "");
        }
      }
    }

    // Release this block's amendment claims after it has been merged or blocked.
    mergeRegistry.releaseAmendments(blockId);
  }

  // OBL-INV-RSD-01: persist a deterministic diagnostic for every unmatched
  // worker result so an orphan is auditable and never silently dropped. This is
  // a sidecar artifact (not state.json), so it does not affect the single
  // state-commit invariant (RSD-02).
  if (orphanResults.length > 0) {
    await writeJsonFile(join(dir, "orphaned-implement-results.json"), {
      schema_version: "remediate-code-implement/orphaned-results/v1alpha1",
      run_id: runId,
      created_at: new Date().toISOString(),
      orphans: orphanResults,
    });
    process.stderr.write(
      `[remediate-code] dispatch: ${orphanResults.length} unmatched implement ` +
        `result finding_id(s) recorded as orphan dispositions (not dropped): ` +
        `${orphanResults.map((o) => o.finding_id).join(", ")}\n`,
    );
  }

  // Lost-update / overlapping-edit detection (ARC-f378135d-2 / ARC-c1693139):
  // when the rolling engine had multiple nodes in flight, two workers can each
  // edit the SAME file in their own worktree; cherry-picking both would silently
  // drop one change. Any file edited by more than one merged block is a
  // lost-update hazard — block every involved block's still-non-terminal items
  // and route them to triage so the conflict is reconciled, never lost. Recorded
  // as a sidecar diagnostic. Single-block runs (the proven host-wave path)
  // produce zero overlaps, so this is inert on the current default path.
  const overlappingEdits = detectOverlappingEdits(editedByBlock);
  if (overlappingEdits.length > 0) {
    const involvedBlockIds = new Set(
      overlappingEdits.flatMap((o) => o.block_ids),
    );
    for (const blockId of involvedBlockIds) {
      const block = state.plan?.blocks.find((b) => b.block_id === blockId);
      const conflictPaths = overlappingEdits
        .filter((o) => o.block_ids.includes(blockId))
        .map((o) => o.path);
      for (const findingId of block?.items ?? []) {
        const stateItem = state.items[findingId];
        if (!stateItem || isTerminalStatus(stateItem.status)) continue;
        stateItem.status = "blocked";
        markTerminal(stateItem);
        stateItem.failure_reason =
          `Lost-update hazard: this block's worker edited file(s) also edited by ` +
          `another concurrently-dispatched block (${conflictPaths.join(", ")}). ` +
          `Blocking both so the overlapping change is reconciled in triage rather ` +
          `than silently dropped by a cherry-pick.`;
      }
    }
    await writeJsonFile(join(dir, "overlapping-edits.json"), {
      schema_version: "remediate-code-implement/overlapping-edits/v1alpha1",
      run_id: runId,
      created_at: new Date().toISOString(),
      overlaps: overlappingEdits,
    });
    process.stderr.write(
      `[remediate-code] dispatch: ${overlappingEdits.length} overlapping-edit ` +
        `conflict(s) across concurrently-merged blocks; involved blocks routed to ` +
        `triage: ${[...involvedBlockIds].join(", ")}\n`,
    );
  }

  // Re-baseline affected-file hashes: the implement phase legitimately rewrites
  // these files, so a later integrity check must not flag the run's own edits as
  // a stale plan when re-attempting any remaining blocked findings.
  if (state.plan?.findings?.length) {
    resnapshotAffectedFileHashes(options.root, state.plan.findings);
  }

  // Per-node dispositions (INV-DS-15). One disposition per merged block/node; a
  // SKIP disposition is never reported as verified_complete. This is a sidecar
  // artifact (not state.json).
  const mergedBlocks = itemsToMerge.flatMap((item) => {
    if (!item.block_id) return [];
    const block = state.plan?.blocks.find((b) => b.block_id === item.block_id);
    return block ? [{ block, item }] : [];
  });
  const dispositions = mergedBlocks.map(({ block }) =>
    buildNodeDisposition(block, state),
  );

  // Sibling-red routing (INV-DS-14). For each merged block that ended red
  // (blocked), attribute the failure against the OTHER merged blocks' write
  // scopes: an attributable red (exactly one sibling owns the implicated
  // surface) routes that sibling to triage; an unattributable red is deferred to
  // the rolling-scheduler's coarse backstop. The state already advances to
  // triage below; this records the attribution decision deterministically.
  const siblingRedRoutes: Array<{
    red_block_id: string;
    implicated_files: string[];
    routed_to_triage_block_id: string | null;
    backstop: "rolling_scheduler_coarse" | null;
  }> = [];
  for (const { block, item } of mergedBlocks) {
    const disposition = dispositions.find((d) => d.block_id === block.block_id);
    if (!disposition || disposition.disposition !== "blocked") continue;
    // The files implicated by this red node = its declared write scope.
    const implicatedFiles = item.access?.write_paths ?? [];
    const siblingScopes = mergedBlocks
      .filter((m) => m.block.block_id !== block.block_id)
      .map((m) => ({
        block_id: m.block.block_id,
        write_paths: m.item.access?.write_paths ?? [],
      }));
    const attributed = attributeSiblingRed(implicatedFiles, siblingScopes, options.root);
    siblingRedRoutes.push({
      red_block_id: block.block_id,
      implicated_files: implicatedFiles.map((p) => toRepoRelative(p, options.root)),
      routed_to_triage_block_id: attributed,
      backstop: attributed ? null : "rolling_scheduler_coarse",
    });
  }
  if (dispositions.length > 0) {
    await writeJsonFile(join(dir, "node-dispositions.json"), {
      schema_version: "remediate-code-implement/node-dispositions/v1alpha1",
      run_id: runId,
      created_at: new Date().toISOString(),
      dispositions,
      sibling_red_routes: siblingRedRoutes,
    });
  }

  const mergedFindingIds = new Set(
    itemsToMerge.flatMap((item) => {
      if (!item.block_id) return [];
      const block = state.plan?.blocks.find((b) => b.block_id === item.block_id);
      return block?.items ?? [];
    }),
  );
  let implementResolved = 0;
  let implementRejected = 0;
  for (const findingId of mergedFindingIds) {
    const status = state.items[findingId]?.status;
    if (isVerifiedCompleteStatus(status)) implementResolved++;
    else if (status === "blocked") implementRejected++;
  }
  process.stderr.write(
    `[remediate-code] dispatch: merged ${implementResolved} implement result(s), ` +
      `${implementRejected} rejected\n`,
  );

  // A worker that reported needs_clarification (note 3, part B) outranks both
  // implementing and triage: pause the run for the batched clarification round so
  // the user's answer is applied before any more work is dispatched or triaged.
  // Otherwise route back to implementing while pending work remains (later
  // dependency waves, or blocks deferred this wave because a prerequisite was
  // still running); else advance to triage.
  const needsClarification = Object.values(state.items).some(
    (it) => it.status === "needs_clarification",
  );
  const moreToImplement = Object.values(state.items).some(
    (it) => it.status === "pending",
  );
  state.status = needsClarification
    ? "waiting_for_clarification"
    : moreToImplement
      ? "implementing"
      : "triage";
  // Single commit: StateStore.mutate writes the returned state once, under the
  // lock it already holds (OBL-INV-RSD-02 / OBL-SEAM-RSD-04). No saveState here.
  return state;
}

export async function readExtractedPlanIfPresent(
  artifactsDir: string,
): Promise<unknown | undefined> {
  return readOptionalJsonFile(join(artifactsDir, "extracted-plan.json"));
}

export async function readDispatchPlan(
  artifactsDir: string,
  runId: string,
  phase: "implement",
): Promise<RemediationDispatchPlan> {
  return readJsonFile(dispatchPlanPath(artifactsDir, runId, phase));
}
