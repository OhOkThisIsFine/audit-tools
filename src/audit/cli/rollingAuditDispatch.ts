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
  writeJsonFile,
  advancePausedState,
  finalizeProviderLaunchResult,
  type SessionConfig,
  type CapacityPool,
  type ProviderSlot,
  type RollingDispatchPacket,
  type RollingDispatchResult,
  type PartialCompletionTerminal,
  type RollingEngineLifecycleState,
  type SettledExclusionSet,
  type FreshSessionProvider,
  type HostModelRosterEntry,
  type DispatchableSource,
  withSourceConfig,
  sourceByPoolId,
  captureStepBoundaryFriction,
  captureCostDriftFriction,
  resolveHostProviderName,
  resolveConversationHostProvider,
  resolveRollingEngineFlag,
  type ResolvedProviderName,
} from "audit-tools/shared";
import type { AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import {
  type ActiveDispatchState,
  type DispatchPausedState,
  ACTIVE_DISPATCH_FILENAME,
} from "../types/activeDispatch.js";
import { runRollingDispatch } from "../orchestrator/rollingDispatch.js";
import { createFreshSessionProvider } from "../providers/index.js";
import { prepareDispatchArtifacts, type DispatchPlanEntry } from "./dispatch.js";
import { mergeAndIngest, type MergeAndIngestResult } from "./mergeAndIngestCommand.js";
import { packageRoot } from "./paths.js";
import { artifactNameForId } from "./args.js";
import { renderWorkerJsonSchema } from "../contracts/workerSchemas.js";

/**
 * The worker's result contract as a JSON Schema, derived ONCE from the canonical
 * zod source (`renderWorkerJsonSchema`, single-sourced — never a forked hand copy).
 * Plumbed into each launch as `input.outputSchema` so a schema-constrained backend
 * (openai-compatible / NIM guided_json) constrains decoding to the AuditResult[]
 * shape at emit time (CE-004 build lever). Providers with no schema-constrained
 * decoding ignore it. Memoized so the schema is rendered at most once per process.
 */
let cachedWorkerResultSchema: Record<string, unknown> | null | undefined;
function workerResultOutputSchema(): Record<string, unknown> | null {
  if (cachedWorkerResultSchema === undefined) {
    try {
      cachedWorkerResultSchema = renderWorkerJsonSchema("audit_results.schema.json");
    } catch {
      // A schema-derivation failure must never break dispatch — degrade to no
      // constraint (the emit-validate-repair seam still guards result shape).
      cachedWorkerResultSchema = null;
    }
  }
  return cachedWorkerResultSchema;
}

/**
 * Backends the orchestrator can drive IN-PROCESS as the per-packet review worker
 * via `driveRollingAuditDispatch` (it resolves + launches the provider headless
 * against the repo root). Restricted to the SELF-CONTAINED headless backends whose
 * launch needs only the packet prompt: the API-driven `openai-compatible` (the
 * validated NIM path) and the headless CLIs `codex` / `opencode` (which build their
 * own invocation from the prompt). Deliberately NARROWER than remediate's set:
 * `worker-command` / `subprocess-template` are excluded because they require a
 * per-worker `worker_command` that a read-only review packet does not carry, and
 * `worker-command` is audit's conventional host-dispatch default provider (so
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
 * The identity of the auditor DRIVING the host-review fan-out this invocation —
 * what the host-review dispatch pool is keyed to (and charged against). When
 * `sessionConfig.provider` names a headless in-process backend (codex / opencode /
 * openai-compatible), that provider is the WORKER, never the driver: the
 * conversation host that reached the host-review path is `claude-code` (or an
 * explicit IDE host). So a headless-backend provider — or an unset / `auto`
 * provider — resolves to the conversation host.
 *
 * This is the founding-bug fix ([[capability-is-per-auditor-not-per-audit]]): a run
 * started with `provider: codex` and later resumed by a Claude host never keys or
 * charges the host fan-out against codex's meter. `sessionConfig.provider` is thus
 * demoted to the headless in-process pool only. An explicit conversation-host
 * provider (vscode-task / antigravity / worker-command / claude-code) IS a driver
 * and passes through unchanged.
 *
 * B1: when a headless backend is demoted, the driver is the CONVERSATION HOST —
 * auto-detected (codex when the run is inside a Codex session, else claude-code)
 * and overridable via `--host-provider` / `sessionConfig.host_provider`, NOT the
 * literal `claude-code` (which mis-charged a Codex host's fan-out to the Claude
 * pool). [[host-provider-misattribution-nim-codex]].
 */
export function resolveHostDispatchProviderName(
  sessionConfig: SessionConfig | null | undefined,
): ResolvedProviderName {
  if (resolvesToInProcessDispatchProvider(sessionConfig)) {
    return resolveConversationHostProvider({ sessionConfig });
  }
  return resolveHostProviderName(sessionConfig);
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
  return resolveRollingEngineFlag({
    explicit: options.rollingEngine,
    sessionConfig: options.sessionConfig,
    envVarName: "AUDIT_CODE_ROLLING_ENGINE",
    env: options.env,
  });
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
  /**
   * - `complete` — every packet dispatched.
   * - `paused`   — the pool exhausted and the run is paused on a resumable
   *                `waiting_for_provider` state (DC-4): re-invoking re-discovers
   *                capacity and resumes, rather than stranding the packets. Pauses
   *                ONLY after the engine's in-pass spill + reactive re-route already
   *                failed (a full strand), so spill is always tried first.
   * - `partial`  — terminal: the pause limit was reached (livelock) and the
   *                stranded packets are yielded to synthesis on partial coverage.
   */
  status: "complete" | "paused" | "partial";
  /** Number of packets dispatched this pass (0 = nothing eligible). */
  packet_count: number;
  /** Packet ids stranded when status === "partial", or held while `paused`. */
  stranded_ids: string[];
  /**
   * Result of the deterministic ingestion that folds the worker results in, or
   * null when no packet produced a result (a full strand — there is nothing to
   * ingest, and the recorded partial-completion terminal lets the pipeline proceed
   * to synthesis on partial coverage without a spurious "all results missing" block).
   */
  ingest: MergeAndIngestResult | null;
  /**
   * The resumable paused state recorded when `status === "paused"` (the live
   * `waiting_for_provider` lifecycle + the accumulated settled-exclusion set), so
   * the caller can render a resumable "waiting for provider" handoff. Absent for
   * `complete` / `partial`.
   */
  paused_state?: DispatchPausedState;
}

/**
 * Re-discover the provider ids currently available to the run. Injected by the
 * caller (and stubbable in tests); the default — used in production wiring — is
 * supplied by the orchestrator from the live provider roster. Returns the bare
 * provider/pool ids so `filterNewProviders` can diff them against the persisted
 * `SettledExclusionSet`.
 */
export type ProviderRediscovery = () => Promise<string[]> | string[];

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
  /**
   * Per-pool dispatchable source (A-8 generic sources), keyed by `slot.poolId`. When a
   * packet's pool is source-backed, its review worker is built FROM that source's config
   * (its own endpoint/model/parameters), not the global per-provider block.
   */
  sourceByPoolId?: Map<string, DispatchableSource>;
}): AuditPacketDispatcher {
  return async (packet, slot) => {
    const entry = packet.payload;
    const resolveProvider = params.createProvider ?? createFreshSessionProvider;
    // A-8 generic sources: build the per-packet worker FROM its pool's source config.
    const source = params.sourceByPoolId?.get(slot?.poolId ?? "");
    const cfg = withSourceConfig(params.sessionConfig, source);
    const provider = resolveProvider(slot?.providerName || cfg.provider, cfg);

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
        // CE-004: additively constrain a schema-capable backend to the AuditResult[]
        // shape; backends without schema-constrained decoding ignore this.
        outputSchema: workerResultOutputSchema(),
      });
      return await finalizeProviderLaunchResult(launch, {
        packet,
        providerName: provider.name,
        entityLabel: `packet ${packet.id}`,
        resultPath,
        stdoutPath,
        stderrPath,
        artifactsDir: params.artifactsDir,
        runId: params.runId,
        packetId: packet.id,
        poolId: slot?.poolId ?? null,
      });
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
  /**
   * Re-discover the provider ids currently available. Probed only when the run is
   * already paused on a `waiting_for_provider` state, to decide resume vs. stay
   * paused vs. terminal/livelock (DC-4). Defaults to the run's confirmed pool ids
   * (the dispatch plan's pools), i.e. "the same pools that were just exhausted" —
   * so with no external re-discovery wiring the run still advances toward livelock
   * rather than spinning forever, while a caller that can re-probe a live roster
   * (or a8's coordinator that adds a spilled-in pool) supplies real net-new ids.
   */
  discoverProviders?: ProviderRediscovery;
  /** Override the livelock pause limit (defaults to the shared `LIVELOCK_PAUSE_LIMIT`). */
  livelockLimit?: number;
  /**
   * A-8 hybrid: review ONLY this task subset (the coordinator-assigned backend/NIM
   * partition), packetized + dispatched against {@link poolsOverride}, WITHOUT
   * touching the shared `pending-audit-tasks.json` the host-review path owns for its
   * complementary subset.
   */
  tasksOverride?: AuditTask[];
  /** A-8 hybrid: size + dispatch against these backend (NIM) pool(s), not the host pool. */
  poolsOverride?: CapacityPool[];
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
    tasksOverride: params.tasksOverride,
    poolsOverride: params.poolsOverride,
    // In-process path: the rolling engine admits + leases per packet itself, so the
    // host grant must NOT lease (no double-count of the same work).
    grantLeases: false,
    // Retained host-session source (audit-side parity with remediate's
    // driveRollingImplementDispatch): feeds the bounded re-limit escalation
    // chain a reviewable friction record instead of only a stderr line.
    onEscalation: (escalation) => {
      void captureStepBoundaryFriction(
        artifactsDir,
        runId,
        {
          eventType: "quota_escalation",
          discriminator: escalation.packet_id,
          note: escalation.reason,
          severity: "high",
          category: "trap",
          area: "dispatch/quota",
        },
        "audit-code",
      );
    },
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
      // A packet on a source-backed pool launches FROM that source's config.
      sourceByPoolId: sourceByPoolId(dispatch.pools as CapacityPool[]),
    });

  const run = await runRollingDispatch<DispatchPlanEntry>(
    packets,
    dispatch.pools as CapacityPool[],
    sessionConfig,
    {
      // Write side: feed the retained host-session source from the worker
      // ERROR/STATUS channel evidence carried on a rate_limited result (now
      // populated by makeAuditProviderPacketDispatcher above). Read side:
      // an already-escalated packet is stranded instead of re-queued.
      recordRateLimit: (packet, result) => {
        if (result.rateLimit) {
          dispatch.hostSession.recordLimit(
            result.rateLimit.channel,
            result.rateLimit.text,
            packet.id,
          );
        }
      },
      isPacketEscalated: (packetId) => dispatch.hostSession.isEscalated(packetId),
      // Reactive cost verification: a declared-free source pool observed charging
      // has been demoted by the engine; surface it as reviewable friction so the
      // operator reconciles the stale `cost_per_mtok:0` (routed through the single
      // step-boundary chokepoint with this run's artifactsDir/runId, like escalation).
      onCostDrift: (info) => {
        captureCostDriftFriction(artifactsDir, runId, info, "audit-code");
      },
    },
    dispatchPacket,
  );

  // Stranded packets (the engine's in-pass spill + reactive re-route already failed
  // — a FULL strand): rather than immediately stranding to a partial-completion
  // terminal, enter (or advance) the resumable `waiting_for_provider` pause so a
  // quota-exhausted run resumes when capacity returns instead of giving up (DC-4).
  // The pause is promoted to a partial-completion terminal only once the livelock
  // guard fires (capacity never returned within the pause limit), at which point the
  // pipeline proceeds to synthesis on partial coverage. Because this branch is
  // reached ONLY on a full strand, spill is always exhausted before any pause.
  let pausedState: DispatchPausedState | undefined;
  if (run.status === "partial" && run.stranded_ids.length > 0) {
    pausedState = await advanceRollingPause({
      artifactsDir,
      runId,
      strandedIds: run.stranded_ids,
      exhaustedPoolIds: run.exhausted_pool_ids,
      discoverProviders: params.discoverProviders,
      livelockLimit: params.livelockLimit,
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
  // A resumable pause is its own status so the caller renders a "waiting for
  // provider" handoff rather than a terminal partial. The terminal (livelock)
  // strand keeps `run.status` ("partial") — `advanceRollingPause` already stamped
  // the partial-completion terminal that lets synthesis proceed on partial coverage.
  return {
    status: pausedState ? "paused" : run.status,
    packet_count: packets.length,
    stranded_ids: run.stranded_ids,
    ingest: ingestResult,
    paused_state: pausedState,
  };
}

/**
 * Advance the resumable `waiting_for_provider` pause for a full-strand pass (DC-4).
 *
 * On the FIRST strand there is no prior paused state, so the run enters
 * `waiting_for_provider` (pause_count 0) carrying the freshly-exhausted pool ids as
 * its `SettledExclusionSet`. On a SUBSEQUENT strand a prior paused state exists, so
 * the persisted settled set is UNIONED with this pass's exhausted ids (CE-001 — the
 * shared set is co-derived/accumulated, never shrunk), the available providers are
 * re-discovered, and `advancePausedState` decides:
 *   - genuinely-new capacity (a provider not in the settled set) → `running` →
 *     pause cleared, the next pass re-dispatches the stranded packets;
 *   - still no new capacity, below the limit → bump `pause_count`, stay paused;
 *   - at/over the limit → `terminal/livelock` → record the partial-completion
 *     terminal so the pipeline proceeds to synthesis on partial coverage.
 *
 * Returns the live paused state when the run stays paused, or `undefined` when it
 * resumed or went terminal (both clear the paused state on the artifact).
 */
async function advanceRollingPause(params: {
  artifactsDir: string;
  runId: string;
  strandedIds: string[];
  exhaustedPoolIds: string[];
  discoverProviders?: ProviderRediscovery;
  livelockLimit?: number;
}): Promise<DispatchPausedState | undefined> {
  const { artifactsDir, runId, strandedIds, exhaustedPoolIds } = params;
  const prior = await readActiveDispatch(artifactsDir, runId);
  const priorPaused = prior?.paused_state;

  // Accumulate the shared settled-exclusion set: prior settled ∪ this pass's
  // exhausted pools. Never shrinks — a pool that has been spilled-then-exhausted
  // stays settled so re-discovery cannot re-offer it as net-new (INV-S03 / CE-001).
  const settled: SettledExclusionSet = new Set([
    ...(priorPaused?.settled_exclusions ?? []),
    ...exhaustedPoolIds,
  ]);
  const settledArray = [...settled].sort();

  // First strand: enter the paused state. No re-discovery yet — the pool was just
  // exhausted this very pass, so probing now would only re-surface the same ids.
  if (!priorPaused) {
    const lifecycle: Extract<
      RollingEngineLifecycleState,
      { kind: "waiting_for_provider" }
    > = {
      kind: "waiting_for_provider",
      paused_at: new Date().toISOString(),
      pause_count: 0,
      stranded_node_ids: strandedIds,
    };
    const pausedState: DispatchPausedState = {
      lifecycle,
      settled_exclusions: settledArray,
    };
    await persistPausedState(artifactsDir, runId, pausedState);
    return pausedState;
  }

  // Already paused: re-discover and let advancePausedState transition.
  const rediscovered = params.discoverProviders
    ? await params.discoverProviders()
    : exhaustedPoolIds; // default: the same (already-settled) pools → no net-new.
  const next = advancePausedState({
    current: priorPaused.lifecycle,
    rediscoveredProviders: rediscovered,
    settledExclusions: settled,
    livelockLimit: params.livelockLimit,
  });

  if (next.kind === "running") {
    // Capacity returned: clear the pause so the next pass re-dispatches.
    await clearPausedState(artifactsDir, runId);
    return undefined;
  }

  if (next.kind === "terminal") {
    // Livelock: clear the pause and record the partial-completion terminal so the
    // pipeline proceeds to synthesis on partial coverage (the no-indefinite-stall
    // guard, CE-003/CE-205). The terminal carries the stranded ids it gave up on.
    await clearPausedState(artifactsDir, runId);
    await recordPartialCompletionTerminal(artifactsDir, runId, {
      reason: "livelock_guard",
      stranded_ids: next.stranded_node_ids,
    });
    return undefined;
  }

  // Still waiting (pause_count bumped). Persist the advanced state + settled set.
  const pausedState: DispatchPausedState = {
    lifecycle: next,
    settled_exclusions: settledArray,
  };
  await persistPausedState(artifactsDir, runId, pausedState);
  return pausedState;
}

/** Read the run's active-dispatch artifact, or null when absent / for another run. */
async function readActiveDispatch(
  artifactsDir: string,
  runId: string,
): Promise<ActiveDispatchState | null> {
  const path = join(artifactsDir, ACTIVE_DISPATCH_FILENAME);
  const existing = await readJsonFile<ActiveDispatchState>(path).catch(() => null);
  return existing && existing.run_id === runId ? existing : null;
}

/** Persist the resumable paused state onto the active-dispatch artifact. */
async function persistPausedState(
  artifactsDir: string,
  runId: string,
  pausedState: DispatchPausedState,
): Promise<void> {
  const existing = await readActiveDispatch(artifactsDir, runId);
  if (!existing) return;
  await writeJsonFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), {
    ...existing,
    paused_state: pausedState,
  } satisfies ActiveDispatchState);
}

/** Clear the paused state (run resumed or went terminal). */
async function clearPausedState(
  artifactsDir: string,
  runId: string,
): Promise<void> {
  const existing = await readActiveDispatch(artifactsDir, runId);
  if (!existing || !existing.paused_state) return;
  const { paused_state: _dropped, ...rest } = existing;
  await writeJsonFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), {
    ...rest,
  } satisfies ActiveDispatchState);
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
