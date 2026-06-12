import { mkdir, rename } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { OwnershipRegistry } from "../dispatch/ownershipRegistry.js";
import { routeAmendmentRequest } from "../dispatch/amendmentClaim.js";
import { spawnSync } from "node:child_process";
import { StateStore, type RemediationState } from "../state/store.js";
import type {
  ClarificationRequest,
  Finding,
  ItemSpec,
  RemediationBlock,
} from "../state/types.js";
import type {
  SessionConfig,
  HostConcurrencyLimit,
  WaveSchedule,
  QuotaStateEntry,
  BackoffState,
  ResolvedProviderName,
  DispatchCapacityPoolSummary,
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
  dependenciesSatisfied,
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

export async function scheduleWave(input: ScheduleWaveInput): Promise<WaveScheduleResult> {
  const sessionConfig = input.sessionConfig ?? {};
  const providerName = input.providerName ?? (sessionConfig as { provider?: ResolvedProviderName }).provider ?? "claude-code";
  const hostModel = input.hostModel ?? (sessionConfig as { block_quota?: { host_model?: string | null } }).block_quota?.host_model ?? null;

  const hostLimit = resolveHostConcurrencyLimit({
    hostMaxConcurrent: input.hostMaxConcurrent,
    sessionConfig,
    env: input.env,
  });

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
        context_tokens: 32_000,
        output_tokens: 4_096,
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
      capacity_pools: [_capacityPoolSummary(buildProviderModelKey(providerName, hostModel), waveSize, schedule)],
    };
  }

  let quotaStateEntry: QuotaStateEntry | null = null;
  try {
    const key = buildProviderModelKey(providerName, hostModel);
    const state = await readQuotaState();
    quotaStateEntry = state.entries[key] ?? null;
  } catch (err) {
    process.stderr.write(`[waveScheduler] readQuotaState failed; falling back to default wave size. ${err instanceof Error ? err.message : String(err)}\n`);
  }

  const capacity = computeDispatchCapacity({
    pools: [
      {
        id: buildProviderModelKey(providerName, hostModel),
        providerName,
        hostModel,
        hostConcurrencyLimit: hostLimit,
        quotaStateEntry,
      },
    ],
    sessionConfig,
    pendingItemTokens: normalizeSlotTokens(input.estimatedSlotTokens, input.itemCount),
  });

  return {
    ...capacity.primary.schedule,
    capacity_pools: summarizeDispatchCapacityPools(capacity),
  };
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
  const deepReasons: string[] = [];
  let allSafe = true;
  let maxSeverityRank = 0;
  const severityRanks: Record<string, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };

  for (const findingId of block.items) {
    const item = state.items?.[findingId];
    const finding = state.plan?.findings.find((f) => f.id === findingId);
    if (!finding) continue;
    const rank = severityRanks[finding.severity] ?? 0;
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
executes. Before and after editing, follow these steps:

1. **Snapshot dist (rollback artefact):** Before editing any file, copy
   \`packages/remediate-code/dist/\` to a temporary path (e.g. append
   \`.infra-snapshot-<timestamp>\` to the dist path). Record that snapshot
   path in your result evidence so the run can roll back if needed. The
   copy must be an atomic rename, not an overwrite-in-place.

2. **Build after editing:** After completing all edits, run:
   \`\`\`
   npm run build -w packages/remediate-code
   \`\`\`
   from \`${rootDisplay}\`. If the build fails, **restore the snapshotted dist**
   (rename the snapshot back to \`dist/\`) before writing your result, mark the
   item blocked, and record the build failure in \`failure_reason\`.

3. **Live-surface smoke:** After a successful build, run:
   \`\`\`
   npm test -w packages/remediate-code
   \`\`\`
   from \`${rootDisplay}\` to exercise the rebuilt dispatcher (not the stale
   global bin). If any test fails, restore the dist snapshot, mark the item
   blocked, and record the failure in \`failure_reason\`.

4. **Dist swap is atomic:** If you need to restore the snapshot, use a rename
   (atomic replace) rather than overwriting files in-place, so the live engine
   is never in a partial state during the swap.
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
${spec ? `- Concrete change: ${spec.concrete_change}
- Tests to write: ${spec.tests_to_write
      .map((test) => `${test.name}: ${test.assertions.join("; ")}`)
      .join(" | ")}` : ""}
${contractPipelineTraceBullets(finding)}
`,
  )
  .join("\n")}
${conventions ? `\n${conventions}\n` : ""}${isInfraModifyingBlock(blockWriteFiles(block, state)) ? infraModifyingSection(repoRoot) : ""}
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

\`\`\`json
{
  "contract_version": "${REMEDIATION_WORKER_RESULT_CONTRACT_VERSION}",
  "phase": "implement",
  "item_results": [
    {
      "finding_id": "FINDING-ID",
      "status": "resolved",
      "evidence": ["test or verification evidence"]
    }
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
  waveOptions?: { hostMaxConcurrent?: number; sessionConfig?: SessionConfig | null },
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
    // Honor block dependencies: a dependent block is not dispatched until every
    // prerequisite block is fully resolved, so dependency-ordered work runs in
    // separate waves rather than racing on the main tree.
    if (!dependenciesSatisfied(block, state)) return false;
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
    // (mergeBlocksSharingFiles) and dependency ordering (dependenciesSatisfied).
    // Workers operate in isolated worktrees; verification prevents bad merges from
    // dirtying the main tree.

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
  const state = await loadStateOrThrow(options.artifactsDir);
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

    for (const itemResult of result.item_results) {
      const stateItem = state.items[itemResult.finding_id];
      if (!stateItem) {
        throw new Error(`Unknown finding_id in implement result: ${itemResult.finding_id}`);
      }
      // A worker may report a finding that is already terminal (user-skipped, or
      // resolved in a prior wave) — never let a result resurrect or overwrite it.
      if (isTerminalStatus(stateItem.status)) {
        continue;
      }
      if (itemResult.status === "resolved") {
        const spec = stateItem.item_spec;
        const isNoChange = specIndicatesNoChange(spec);
        stateItem.status = isNoChange ? "resolved_no_change" : "resolved";
        markTerminal(stateItem);
        stateItem.last_successful_step = "Verify Code Against Documentation";
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
      } else {
        stateItem.status = "blocked";
        markTerminal(stateItem);
        stateItem.failure_reason =
          itemResult.failure_reason ?? "Implementation worker blocked.";
      }
    }

    // Release this block's amendment claims after it has been merged or blocked.
    mergeRegistry.releaseAmendments(blockId);
  }

  // Re-baseline affected-file hashes: the implement phase legitimately rewrites
  // these files, so a later integrity check must not flag the run's own edits as
  // a stale plan when re-attempting any remaining blocked findings.
  if (state.plan?.findings?.length) {
    resnapshotAffectedFileHashes(options.root, state.plan.findings);
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
  state.status = moreToImplement ? "implementing" : "implementing";
  await store.saveState(state);
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
