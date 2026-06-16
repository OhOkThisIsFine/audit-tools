import { mkdir, rename } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { OwnershipRegistry } from "../dispatch/ownershipRegistry.js";
import { routeAmendmentRequest } from "../dispatch/amendmentClaim.js";
import { toBlockId, fromBlockId } from "../contractPipeline/idRegistry.js";
import { spawnSync } from "node:child_process";
import { StateStore, type RemediationState } from "../state/store.js";
import {
  REMEDIATION_STEP,
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
} from "@audit-tools/shared";
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
  severityRank,
  findingNeedsVerificationBeforeFix,
  compareTier,
  mostCapableTier,
  type FindingTheme,
} from "@audit-tools/shared";
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
  isTerminalStatus,
} from "./stepUtils.js";
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

  // One capacity pool per reported roster rank (most capable first), each with
  // its own discovered window and quota key; a single pool for the scalar/
  // absent handshake. A rank's opaque `model_id` keys that pool's quota.
  const pools = (roster ?? [null]).map((entry) => {
    const poolKey = buildProviderModelKey(
      providerName,
      entry?.model_id ?? quotaModelKeySegment,
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
    };
  });
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

  return (roster ?? [null]).map((entry) => {
    const poolKey = buildProviderModelKey(
      providerName,
      entry?.model_id ?? quotaModelKeySegment,
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
    };
  });
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

/** Create an isolated git worktree on a fresh branch at HEAD. Throws on non-zero exit. */
export function createWorktree(root: string, worktreePath: string, branchName: string): void {
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

/** Run each targeted command in the worktree directory. Returns pass/fail and combined output. */
export function verifyNodeInWorktree(
  worktreePath: string,
  targetedCommands: string[],
): WorktreeVerifyResult {
  const outputs: string[] = [];
  for (const cmd of targetedCommands) {
    const [bin, ...args] = cmd.split(" ");
    const r = spawnSync(bin, args, {
      cwd: worktreePath,
      encoding: "utf8",
      shell: false,
    });
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

/** Worktree path for a remediation block. */
export function worktreePath(root: string, blockId: string, runId: string): string {
  return join(root, ".audit-tools", "worktrees", `remediate-${blockId}-${runId}`);
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
 * extra append-only path. Schema: schemas/agent_reflection.schema.json;
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
    return [{ finding, spec: item.item_spec }];
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
    ({ finding, spec }) => `
### ${finding.id} - ${finding.title}

- Files: ${itemReadFiles(finding, spec).map(resolveFilePath).join(", ")}
- Summary: ${finding.summary}
${groundingVerificationBullet(finding)}
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

For an item you cannot safely finish, set \`status\` to \`blocked\` and include
\`failure_reason\`. Stop after writing the result JSON.

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
    // Collapse: blocked dominates; merge evidence; keep first failure_reason.
    const mergedEvidence = [
      ...new Set([...(existing.evidence ?? []), ...(normalized.evidence ?? [])]),
    ];
    const status =
      existing.status === "blocked" || normalized.status === "blocked"
        ? "blocked"
        : "resolved";
    byFinding.set(targetId, {
      finding_id: targetId,
      status,
      evidence: mergedEvidence.length > 0 ? mergedEvidence : undefined,
      failure_reason: existing.failure_reason ?? normalized.failure_reason,
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
  const isSkip = statuses.some(
    (s) => s === "ignored" || s === "deemed_inappropriate",
  );
  const allResolved =
    statuses.length > 0 &&
    statuses.every((s) => s === "resolved" || s === "resolved_no_change");
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
      if (itemResult.status === "resolved") {
        const spec = stateItem.item_spec;
        const isNoChange = specIndicatesNoChange(spec);
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
      } else {
        stateItem.status = "blocked";
        markTerminal(stateItem);
        stateItem.failure_reason =
          itemResult.failure_reason ?? "Implementation worker blocked.";
      }
    }

    // Write-scope enforcement against the worker's ACTUAL git edits
    // (OBL-DS-06): never trust self-reported amended_files for the gate. The
    // enforcement ground truth is the worker's worktree diff; it is applied when
    // this block was dispatched into an isolated worktree (the rolling-dispatch
    // flow). On the interim main-tree path there is no per-worker isolation to
    // diff against, so the gate is skipped here rather than mistaking ambient
    // working-tree state for this worker's edits. The decision is a pure function
    // (`enforceWriteScope`) so it is unit-tested directly against a known edit
    // set, and fail-closed semantics apply when git is a repo but the probe fails.
    const worktreeBranch = worktreeBranchForBlock(blockId, runId);
    // Resolve this block's ACTUAL worktree-branch edits ONCE when the branch
    // exists — reused for the write-scope gate below AND the post-loop
    // lost-update detection. A missing branch means the interim main-tree path
    // was used (no per-worker diff): skip both checks for this block.
    const branchEdited = gitBranchExists(options.root, worktreeBranch)
      ? gitEditedFilesForBranch(options.root, worktreeBranch)
      : null;
    if (branchEdited?.available) {
      editedByBlock.push({ block_id: blockId, files: branchEdited.files });
    }
    // Activate the write-scope gate only when this block was actually dispatched
    // through an isolated worktree (its branch exists). A missing branch means
    // the interim main-tree path was used — there is no per-worker diff to
    // enforce against, so the gate is skipped (NOT fail-closed: fail-closed is
    // for a present repo whose diff genuinely errors).
    if (resolvedFindingIds.length > 0 && item.access && branchEdited) {
      const decision = enforceWriteScope(
        item.access.write_paths,
        branchEdited,
        options.root,
      );
      if (decision.blocked) {
        for (const findingId of resolvedFindingIds) {
          const stateItem = state.items[findingId];
          if (!stateItem) continue;
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason = decision.reason;
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
    if (status === "resolved" || status === "resolved_no_change") implementResolved++;
    else if (status === "blocked") implementRejected++;
  }
  process.stderr.write(
    `[remediate-code] dispatch: merged ${implementResolved} implement result(s), ` +
      `${implementRejected} rejected\n`,
  );

  // Route back to implementing while pending work remains (later dependency
  // waves, or blocks deferred this wave because a prerequisite was still
  // running) so the next next-step dispatches the now-ready blocks; otherwise
  // advance to implementing → triage.
  const moreToImplement = Object.values(state.items).some(
    (it) => it.status === "pending",
  );
  state.status = moreToImplement ? "implementing" : "triage";
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
