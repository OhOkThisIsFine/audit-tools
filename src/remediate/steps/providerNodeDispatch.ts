import { dirname, join } from "node:path";
import {
  readOptionalJsonFile,
  readOptionalTextFile,
  writeJsonFile,
  detectRateLimitFromChannel,
  withSourceConfig,
  type SessionConfig,
  type ProviderSlot,
  type RollingDispatchResult,
  type FreshSessionProvider,
  type DispatchableSource,
} from "audit-tools/shared";
import { createFreshSessionProvider } from "../providers/index.js";
import {
  createRemediationWorkerTask,
  createLaunchInputForTask,
} from "../phases/workerTasks.js";
import type { RemediationBlock } from "../state/types.js";
import type { ImplementWorkerResult } from "./types.js";

export interface ProviderNodeDispatcherParams {
  root: string;
  artifactsDir: string;
  runId: string;
  sessionConfig: SessionConfig | null;
  /** Per-block worktree-rooted prompt path written by `prepareImplementDispatch`. */
  promptPathByBlock: Map<string, string>;
  /**
   * Resolve the provider for a node launch. Defaults to `createFreshSessionProvider`
   * (the configured/auto-resolved backend). Injectable so the dispatch wiring can be
   * exercised in tests without spawning a real worker.
   */
  createProvider?: (
    name: string | undefined,
    sessionConfig: SessionConfig,
  ) => FreshSessionProvider;
  /**
   * Per-pool dispatchable source (A-8 generic sources), keyed by `slot.poolId`. When a
   * node's pool is backed by a source, its provider is built FROM that source's config
   * (its own endpoint/model/parameters) rather than the global per-provider block — so
   * two sources of the same provider (e.g. two NIM endpoints) launch distinctly.
   */
  sourceByPoolId?: Map<string, DispatchableSource>;
}

/**
 * Build the live, provider-backed per-node dispatcher — the programmatic worker
 * the rolling engine (`driveRollingImplementDispatch`) drives. It resolves the
 * configured `FreshSessionProvider` and launches it with the node's
 * worktree-rooted prompt and `repoRoot` set to the node's isolated worktree.
 *
 * The provider IS the worker: `spawnLoggedCommand` spawns the headless LLM CLI
 * (claude -p / codex / opencode run) with `cwd = input.repoRoot`, so pointing
 * `repoRoot` at the worktree confines every edit there — the worktree branch diff
 * is then the write-scope ground truth. The worker edits files and writes its
 * result JSON to `resultPath` (the prompt instructs the exact path); the engine
 * wrapper owns the create/commit/verify/merge lifecycle around this call, and the
 * deterministic `mergeImplementResults` is the authority on the result contents.
 *
 * No `worker-run` indirection: the remediation implement prompt is self-contained
 * for a fresh session, so the provider launch alone is the worker.
 */
export function makeProviderNodeDispatcher(
  params: ProviderNodeDispatcherParams,
): (args: {
  block: RemediationBlock;
  slot: ProviderSlot;
  worktreeRoot: string;
  resultPath: string;
}) => Promise<RollingDispatchResult<{ block_id: string }>> {
  const orchestratorOptions = {
    root: params.root,
    artifactsDir: params.artifactsDir,
  };
  return async ({ block, slot, worktreeRoot, resultPath }) => {
    const packet = {
      id: block.block_id,
      payload: { block_id: block.block_id },
      estimatedTokens: 0,
      complexity: 0.5,
    };
    const promptPath = params.promptPathByBlock.get(block.block_id);
    if (!promptPath) {
      return {
        packet,
        outcome: "error",
        error: new Error(`no dispatch prompt for node ${block.block_id}`),
      };
    }

    // Resolve the provider the scheduler SELECTED for this slot, not a fixed
    // configured one: that is what makes cross-pool spill (INV-QD-14) actually
    // route a node to a peer pool's backend (e.g. an openai-compatible/NIM pool
    // when the primary pool is quota-degraded). Falls back to the configured
    // provider when no slot provider is present.
    const resolveProvider = params.createProvider ?? createFreshSessionProvider;
    // A-8 generic sources: build the node's provider FROM its pool's source config
    // (its own endpoint/model/params) when the pool is source-backed, else the global
    // block — so two sources of the same provider (e.g. two NIM endpoints) launch distinctly.
    const source = params.sourceByPoolId?.get(slot?.poolId ?? "");
    const cfg = withSourceConfig(params.sessionConfig ?? {}, source);
    const provider = resolveProvider(slot?.providerName || cfg.provider, cfg);
    const dir = dirname(resultPath);
    const taskPath = join(dir, `${block.block_id}.task.json`);
    const stdoutPath = join(dir, `${block.block_id}.stdout.txt`);
    const stderrPath = join(dir, `${block.block_id}.stderr.txt`);

    const task = createRemediationWorkerTask({
      runId: `${params.runId}:${block.block_id}`,
      options: orchestratorOptions,
      obligationId: block.block_id,
      preferredExecutor: provider.name,
      resultPath,
      timeoutMs: params.sessionConfig?.timeout_ms,
    });
    await writeJsonFile(taskPath, task);

    try {
      const launch = await provider.launch({
        ...createLaunchInputForTask(orchestratorOptions, task, {
          promptPath,
          taskPath,
          stdoutPath,
          stderrPath,
        }),
        // Confine the worker to its isolated worktree (cwd = repoRoot in
        // spawnLoggedCommand). CLAUDECODE / CLAUDE_CODE_* are scrubbed from the
        // child env there, so the worker is graded on its own state.
        repoRoot: worktreeRoot,
      });
      if (!launch.accepted) {
        return {
          packet,
          outcome: "error",
          error: new Error(
            launch.error ??
              `provider ${provider.name} rejected node ${block.block_id}`,
          ),
        };
      }
      // Channel-isolated session-limit detection (CE-003): only the error/status
      // channel (stderr) is inspected — the result file is never scanned for limit
      // strings, so a healthy result quoting a limit never triggers a re-queue.
      const stderrText = (await readOptionalTextFile(stderrPath)) ?? "";
      const limitCheck = detectRateLimitFromChannel("error", stderrText);
      if (limitCheck.isRateLimited) {
        return { packet, outcome: "rate_limited", rateLimit: { channel: "error", text: stderrText } };
      }

      // Reactive cost verification: relay the endpoint-reported cost (when the
      // provider surfaced one) so `handleResult` can demote a declared-free pool
      // that started charging. Absent for providers that report no cost.
      const observedCost =
        launch.observedCostUsd != null ? { observedCostUsd: launch.observedCostUsd } : {};
      // The worker writes its result file per the prompt; confirm it landed and
      // parses. Contents are adjudicated by the deterministic merge downstream.
      const result = await readOptionalJsonFile<ImplementWorkerResult>(resultPath);
      if (!result) {
        // Also check stdout for a session-limit message before reporting as error
        // (some providers write their status to stdout, not stderr).
        const stdoutText = (await readOptionalTextFile(stdoutPath)) ?? "";
        const stdoutLimitCheck = detectRateLimitFromChannel("status", stdoutText);
        if (stdoutLimitCheck.isRateLimited) {
          return { packet, outcome: "rate_limited", rateLimit: { channel: "status", text: stdoutText } };
        }
        return {
          packet,
          outcome: "error",
          error: new Error(
            `worker for node ${block.block_id} wrote no result at ${resultPath}`,
          ),
        };
      }
      return { packet, outcome: "success", ...observedCost };
    } catch (err) {
      return { packet, outcome: "error", error: err };
    }
  };
}
