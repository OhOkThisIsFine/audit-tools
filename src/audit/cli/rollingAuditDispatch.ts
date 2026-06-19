/**
 * In-process, provider-backed rolling audit dispatch (A8(a)).
 *
 * The symmetric counterpart of remediate's `driveRollingImplementDispatch`: when
 * the rolling engine is enabled AND the operator explicitly configured a
 * programmatic backend provider (openai-compatible / codex / opencode / …), the
 * orchestrator drives the WHOLE semantic-review dispatch ITSELF — the configured
 * provider is the per-packet worker — instead of emitting a host-subagent dispatch
 * step. It reuses the SAME `prepareDispatchArtifacts` packetization + quota pool
 * the host path uses, the SHARED `runRollingDispatch` engine, and the SAME
 * deterministic `mergeAndIngest` ingestion, so the in-process and host-subagent
 * paths stay behaviourally identical apart from who runs the worker.
 *
 * KEY DIFFERENCE FROM REMEDIATE: audit dispatch is READ-ONLY review (packet →
 * AuditResult[]), not worktree edits. So there is NO per-node worktree, NO commit,
 * NO cherry-pick merge — every worker is launched with `repoRoot` = the actual
 * repo root and writes only its result file. The merge step is result ingestion,
 * not a git merge.
 */

import { dirname, join } from "node:path";
import {
  readJsonFile,
  readOptionalJsonFile,
  writeJsonFile,
  type SessionConfig,
  type CapacityPool,
  type ProviderSlot,
  type RollingDispatchPacket,
  type RollingDispatchResult,
  type PartialCompletionTerminal,
  type FreshSessionProvider,
  type HostModelRosterEntry,
} from "audit-tools/shared";
import type { AuditResult } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import {
  type ActiveDispatchState,
  ACTIVE_DISPATCH_FILENAME,
} from "../types/activeDispatch.js";
import { runRollingDispatch } from "../orchestrator/rollingDispatch.js";
import { createFreshSessionProvider } from "../providers/index.js";
import { prepareDispatchArtifacts, type DispatchPlanEntry } from "./dispatch.js";
import { mergeAndIngest, type MergeAndIngestResult } from "./mergeAndIngestCommand.js";
import { packageRoot } from "./paths.js";
import { artifactNameForId } from "./args.js";

/**
 * Backends the orchestrator can drive IN-PROCESS as the per-packet review worker
 * via `driveRollingAuditDispatch` (it resolves + launches the provider headless
 * against the repo root). Restricted to the SELF-CONTAINED headless backends whose
 * launch needs only the packet prompt: the API-driven `openai-compatible` (the
 * validated NIM path) and the headless CLIs `codex` / `opencode` (which build their
 * own invocation from the prompt). Deliberately NARROWER than remediate's set:
 * `local-subprocess` / `subprocess-template` are excluded because they require a
 * per-worker `worker_command` that a read-only review packet does not carry, and
 * `local-subprocess` is audit's conventional host-dispatch default provider (so
 * routing it in-process would hijack the host-subagent `dispatch_review` path). The
 * conversation host (claude-code) and IDE backends (vscode-task / antigravity) are
 * excluded for the same reasons as remediate. "auto" is intentionally absent, so
 * the in-process driver is opt-in via an EXPLICIT headless backend in session
 * config; when one is set it takes precedence over the host-subagent dispatch step.
 */
const IN_PROCESS_DISPATCH_PROVIDERS: ReadonlySet<string> = new Set([
  "openai-compatible",
  "codex",
  "opencode",
]);

/**
 * Whether session config names an EXPLICIT backend provider the orchestrator can
 * drive in-process as the per-packet review worker. The mirror of remediate's
 * `resolvesToInProcessDispatchProvider`.
 */
export function resolvesToInProcessDispatchProvider(
  sessionConfig: SessionConfig | null | undefined,
): boolean {
  const provider = sessionConfig?.provider;
  return provider !== undefined && IN_PROCESS_DISPATCH_PROVIDERS.has(provider);
}

/**
 * Whether the in-process rolling engine drives audit's semantic-review dispatch.
 * Mirrors remediate's `resolveRollingEngineEnabled` resolution order: explicit
 * option → `sessionConfig.dispatch.rolling_engine` → `AUDIT_CODE_ROLLING_ENGINE`
 * env → default true (the rolling drivers are validated end-to-end and are the
 * default; the host-subagent dispatch step is the opt-OUT). Honoured only when an
 * explicit in-process backend provider is also configured (the conversation host,
 * which fans out its own subagents, keeps using the host-subagent dispatch step).
 */
export function resolveAuditRollingEngineEnabled(options: {
  rollingEngine?: boolean;
  sessionConfig?: SessionConfig | null;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (options.rollingEngine !== undefined) return options.rollingEngine;
  const cfg = options.sessionConfig?.dispatch?.rolling_engine;
  if (cfg !== undefined) return cfg;
  const envValue = (options.env ?? process.env).AUDIT_CODE_ROLLING_ENGINE;
  if (envValue === "true") return true;
  if (envValue === "false") return false;
  return true;
}

/** Per-packet provider dispatcher — packet → launched provider → AuditResult[] file. */
export type AuditPacketDispatcher = (
  packet: RollingDispatchPacket<DispatchPlanEntry>,
  slot: ProviderSlot,
) => Promise<RollingDispatchResult<DispatchPlanEntry>>;

/** The deterministic ingestion the driver folds worker results in with. */
export type AuditResultIngestor = (params: {
  runId: string;
  artifactsDir: string;
}) => Promise<MergeAndIngestResult>;

/** Outcome of an in-process rolling audit dispatch pass. */
export interface DriveRollingAuditDispatchResult {
  /** complete = every packet dispatched; partial = some stranded (empty pool / livelock). */
  status: "complete" | "partial";
  /** Number of packets dispatched this pass (0 = nothing eligible). */
  packet_count: number;
  /** Packet ids stranded when status === "partial". */
  stranded_ids: string[];
  /**
   * Result of the deterministic ingestion that folds the worker results in, or
   * null when no packet produced a result (a full strand — there is nothing to
   * ingest, and the recorded partial-completion terminal lets the pipeline proceed
   * to synthesis on partial coverage without a spurious "all results missing" block).
   */
  ingest: MergeAndIngestResult | null;
}

/**
 * Map a packet's deterministic priority to a complexity score in [0, 1] so the
 * rolling engine routes high-priority packets to the most-capable pool first
 * (`selectProvider`'s capability axis). Priority is the packet's max member
 * priority — provider-neutral, never a model name.
 */
function packetComplexityScore(entry: DispatchPlanEntry): number {
  switch (entry.complexity.priority) {
    case "high":
      return 1;
    case "low":
      return 0;
    default:
      return 0.5;
  }
}

/**
 * Build the live, provider-backed per-packet dispatcher — the programmatic worker
 * the rolling engine drives. It resolves the `FreshSessionProvider` the scheduler
 * SELECTED for the slot (falling back to the configured provider) and launches it
 * with the packet's self-contained review prompt, `repoRoot` = the actual repo
 * (read-only review — no worktree), and the packet's result path. The worker reads
 * the cited files and writes its `AuditResult[]` to the result file; the
 * deterministic `mergeAndIngest` downstream is the authority on the contents.
 */
export function makeAuditProviderPacketDispatcher(params: {
  root: string;
  artifactsDir: string;
  runId: string;
  sessionConfig: SessionConfig;
  timeoutMs: number;
  /** Injectable for tests so the engine runs without spawning a real worker. */
  createProvider?: (
    name: string | undefined,
    sessionConfig: SessionConfig,
  ) => FreshSessionProvider;
}): AuditPacketDispatcher {
  return async (packet, slot) => {
    const entry = packet.payload;
    const resolveProvider = params.createProvider ?? createFreshSessionProvider;
    const provider = resolveProvider(
      slot?.providerName || params.sessionConfig.provider,
      params.sessionConfig,
    );

    const resultPath = entry.result_path;
    const dir = dirname(resultPath);
    // Sidecar files share the packet's canonical FS-safe stem. Packet ids embed
    // ':' (e.g. "root-config:correctness:packet-3"), which is an invalid filename
    // character on Windows (NTFS reads it as an alternate-data-stream separator),
    // so a raw `${packet.id}.task.json` throws on the write — before any launch,
    // erroring every packet. `artifactNameForId` is the same sanitizer the
    // prompt/result files use (stem + digest), keeping the sidecars co-named and
    // OS-agnostic (INV everything-agnostic / Windows-aware).
    const taskPath = join(dir, artifactNameForId(packet.id, "task.json"));
    const stdoutPath = join(dir, artifactNameForId(packet.id, "stdout.txt"));
    const stderrPath = join(dir, artifactNameForId(packet.id, "stderr.txt"));

    const task: WorkerTask = {
      contract_version: "audit-code-worker/v1alpha1",
      run_id: `${params.runId}:${packet.id}`,
      repo_root: params.root,
      artifacts_dir: params.artifactsDir,
      obligation_id: "audit_tasks_completed",
      preferred_executor: provider.name,
      result_path: resultPath,
      worker_command: [],
      timeout_ms: params.sessionConfig.timeout_ms ?? params.timeoutMs,
      max_retries: 0,
      access: entry.access,
    };
    await writeJsonFile(taskPath, task);

    try {
      const launch = await provider.launch({
        // Read-only review: the actual repo root, NOT an isolated worktree. The
        // worker reads the cited files and emits findings; it must not edit source.
        repoRoot: params.root,
        runId: task.run_id,
        obligationId: task.obligation_id,
        promptPath: entry.prompt_path,
        taskPath,
        resultPath,
        stdoutPath,
        stderrPath,
        uiMode: "headless",
        timeoutMs: params.sessionConfig.timeout_ms ?? params.timeoutMs,
      });
      if (!launch.accepted) {
        return {
          packet,
          outcome: "error",
          error: new Error(
            launch.error ??
              `provider ${provider.name} rejected packet ${packet.id}`,
          ),
        };
      }
      // The worker writes its AuditResult[] per the prompt; confirm it landed and
      // parses. Contents are adjudicated by the deterministic merge downstream.
      const result = await readOptionalJsonFile<AuditResult[]>(resultPath);
      if (!result) {
        return {
          packet,
          outcome: "error",
          error: new Error(
            `worker for packet ${packet.id} wrote no result at ${resultPath}`,
          ),
        };
      }
      return { packet, outcome: "success" };
    } catch (err) {
      return { packet, outcome: "error", error: err };
    }
  };
}

/**
 * Drive the semantic-review phase through the in-process rolling engine. Prepares
 * the dispatch plan (the SAME quota-sized packetization the host path uses), runs
 * each packet through the configured provider via the shared `runRollingDispatch`
 * engine (quota-derived concurrency + transient-429 re-queue + cross-pool spill),
 * records a partial-completion terminal when packets strand so the audit can still
 * proceed to synthesis on partial coverage, and finally folds the worker results
 * in through the deterministic `mergeAndIngest`.
 *
 * SAFETY: every worker is launched read-only against the real repo and writes only
 * its result file; the deterministic ingestion validates each result and leaves
 * unanswered tasks pending (re-dispatchable next pass) rather than fabricating
 * coverage.
 */
export async function driveRollingAuditDispatch(params: {
  root: string;
  artifactsDir: string;
  activeReviewRun: ActiveReviewRun;
  sessionConfig: SessionConfig;
  timeoutMs: number;
  hostMaxActiveSubagents?: number | null;
  hostContextTokens?: number | null;
  hostOutputTokens?: number | null;
  hostModelRoster?: HostModelRosterEntry[] | null;
  hostModelId?: string | null;
  /** Injectable per-packet dispatcher for tests (defaults to the provider-backed one). */
  dispatchPacket?: AuditPacketDispatcher;
  /**
   * Injectable terminal ingestion (defaults to the deterministic `mergeAndIngest`).
   * The rolling engine treats ingestion as a consumer-owned terminal hook, so it is
   * a seam here rather than an inline call.
   */
  ingest?: AuditResultIngestor;
}): Promise<DriveRollingAuditDispatchResult> {
  const { root, artifactsDir, sessionConfig } = params;
  const runId = params.activeReviewRun.run_id;
  const ingest = params.ingest ?? mergeAndIngest;

  const provider = createFreshSessionProvider(undefined, sessionConfig);
  const dispatch = await prepareDispatchArtifacts({
    packageRoot,
    runId,
    artifactsDir,
    root,
    sessionConfig,
    hostModel: sessionConfig.block_quota?.host_model ?? null,
    queryLimits: provider.queryLimits?.bind(provider),
    hostActiveSubagentLimit: params.hostMaxActiveSubagents,
    hostContextTokens: params.hostContextTokens,
    hostOutputTokens: params.hostOutputTokens,
    hostModelRoster: params.hostModelRoster,
    hostModelId: params.hostModelId,
  });

  // Nothing eligible this pass (every task already answered / budget-capped):
  // ingest whatever landed and let the loop re-derive state.
  if (dispatch.plan.length === 0) {
    return {
      status: "complete",
      packet_count: 0,
      stranded_ids: [],
      ingest: await ingest({ runId, artifactsDir }),
    };
  }

  const packets: RollingDispatchPacket<DispatchPlanEntry>[] = dispatch.plan.map(
    (entry) => ({
      id: entry.packet_id,
      payload: entry,
      estimatedTokens: entry.complexity.estimated_tokens,
      complexity: packetComplexityScore(entry),
    }),
  );

  const dispatchPacket =
    params.dispatchPacket ??
    makeAuditProviderPacketDispatcher({
      root,
      artifactsDir,
      runId,
      sessionConfig,
      timeoutMs: params.timeoutMs,
    });

  const run = await runRollingDispatch<DispatchPlanEntry>(
    packets,
    dispatch.pools as CapacityPool[],
    sessionConfig,
    {},
    dispatchPacket,
  );

  // Stranded packets (empty pool / livelock): record a partial-completion terminal
  // on the active-dispatch artifact so `deriveAuditState` treats
  // `audit_tasks_completed` as satisfied and the pipeline proceeds to synthesis on
  // partial coverage rather than re-dispatching tasks that can never land.
  if (run.status === "partial" && run.stranded_ids.length > 0) {
    await recordPartialCompletionTerminal(artifactsDir, runId, {
      reason: run.partial_reason ?? "empty_pool",
      stranded_ids: run.stranded_ids,
    });
  }

  // Ingest only when at least one packet produced a result. A full strand (every
  // packet stranded on an exhausted pool) has nothing to fold in, and ingesting
  // would block on "all assigned results missing" — the recorded terminal already
  // lets the pipeline proceed to synthesis on partial coverage.
  //
  // A packet `outcome:"success"` only means the provider WROTE a result file, not
  // that the result is contract-valid. When every provider-accepted result is
  // ingestion-invalid (e.g. a weak/unreliable backend returned wrong line counts
  // or a malformed AuditResult), `mergeAndIngest` raises a hard "all assigned
  // results invalid" block — correct for the synchronous CLI worker, but in the
  // rolling driver that must degrade to a NO-PROGRESS pass (ingest:null) so the
  // host-delegation fold's convergence guard emits a clean block instead of an
  // unhandled throw crashing next-step (INV enforce-in-tooling: the path must be
  // robust to ANY-strength provider).
  const anySuccess = run.results.some((r) => r.outcome === "success");
  let ingestResult: MergeAndIngestResult | null = null;
  if (anySuccess) {
    try {
      ingestResult = await ingest({ runId, artifactsDir });
    } catch (err) {
      ingestResult = null;
      process.stderr.write(
        `[rollingAuditDispatch] ingestion produced no usable results for run ${runId} ` +
          `(every provider-accepted result was invalid): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return {
    status: run.status,
    packet_count: packets.length,
    stranded_ids: run.stranded_ids,
    ingest: ingestResult,
  };
}

/**
 * Stamp the rolling engine's partial-completion terminal onto the run's
 * active-dispatch artifact. `prepareDispatchArtifacts` already wrote the artifact;
 * this only augments it, leaving every other field intact.
 */
async function recordPartialCompletionTerminal(
  artifactsDir: string,
  runId: string,
  terminal: PartialCompletionTerminal,
): Promise<void> {
  const path = join(artifactsDir, ACTIVE_DISPATCH_FILENAME);
  const existing = await readJsonFile<ActiveDispatchState>(path).catch(
    () => null,
  );
  if (!existing || existing.run_id !== runId) return;
  await writeJsonFile(path, {
    ...existing,
    partial_completion_terminal: terminal,
  } satisfies ActiveDispatchState);
}
