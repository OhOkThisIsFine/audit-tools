import { dirname } from "node:path";
import {
  writeJsonFile,
  finalizeProviderLaunchResult,
  type SessionConfig,
  type ProviderSlot,
  type RollingDispatchResult,
  type FreshSessionProvider,
  type DispatchableSource,
  resolveDispatchProvider,
} from "audit-tools/shared";
import { createFreshSessionProvider } from "../providers/index.js";
import {
  createRemediationWorkerTask,
  createLaunchInputForTask,
} from "../phases/workerTasks.js";
import { nodeArtifactPathsIn } from "./dispatch/nodeArtifacts.js";
import type { RemediationBlock } from "../state/types.js";

export interface ProviderNodeDispatcherParams {
  root: string;
  artifactsDir: string;
  runId: string;
  sessionConfig: SessionConfig | null;
  /** Per-block worktree-rooted prompt path written by `prepareImplementDispatch`. */
  promptPathByBlock: Map<string, string>;
  /**
   * Per-block granted read set (repo-relative `access.read_paths`). A single-shot /
   * no-file-access provider (openai-compatible / NIM) inlines these files' current
   * contents into the prompt and refuses the node if it cannot; the agentic-CLI
   * providers ignore it and read the worktree themselves. Absent for the injected
   * test dispatcher.
   */
  referencedFilesByBlock?: Map<string, string[]>;
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

    // Shared prep head — provider resolution (the scheduler's slot choice, so
    // cross-pool spill (INV-QD-14) really routes to a peer pool's backend) and
    // sidecar naming are one algorithm across both draws. Only the task contract
    // and the worktree-rooted launch below are remediation-specific.
    const provider = resolveDispatchProvider(params, slot, createFreshSessionProvider);
    // Sidecars resolve through `nodeArtifacts`, the one owner of every per-node
    // run-dir name, so the merge's diagnosis — which independently resolves the
    // same paths — can never disagree with what was written here.
    const dir = dirname(resultPath);
    const { taskPath, stdoutPath, stderrPath } = nodeArtifactPathsIn(dir, block.block_id);

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
        // The node's granted read set (repo-relative), for a single-shot worker to
        // inline the current contents of; absent → the provider's prose-scavenge
        // fallback still runs.
        referencedFiles: params.referencedFilesByBlock?.get(block.block_id),
      });
      return await finalizeProviderLaunchResult(launch, {
        packet,
        providerName: provider.name,
        entityLabel: `node ${block.block_id}`,
        resultPath,
        stdoutPath,
        stderrPath,
        artifactsDir: params.artifactsDir,
        runId: params.runId,
        packetId: block.block_id,
        poolId: slot?.poolId ?? null,
      });
    } catch (err) {
      return { packet, outcome: "error", error: err };
    }
  };
}
