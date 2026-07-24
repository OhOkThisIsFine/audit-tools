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
 * NO cherry-pick merge — the merge step is result ingestion, not a git merge.
 * Workers are launched against ONE shared, disposable, detached review-snapshot
 * worktree of HEAD (per drive, created lazily on first spawn) rather than the
 * real checkout: the snapshot is the MECHANICAL write-scope boundary for spawned
 * CLI lanes — see `makeAuditProviderPacketDispatcher`'s docblock. Each worker
 * writes only its result file, into the real artifacts dir.
 */

import { dirname, join } from "node:path";
import {
  writeJsonFile,
  advancePausedState,
  finalizeProviderLaunchResult,
  type SessionConfig,
  type CapacityPool,
  type ProviderSlot,
  type RollingDispatchPacket,
  type RollingDispatchResult,
  type RollingEngineLifecycleState,
  type SettledExclusionSet,
  type FreshSessionProvider,
  type HostModelRosterEntry,
  type DispatchableSource,
  withSourceConfig,
  sourceByPoolId,
  captureStepBoundaryFriction,
  captureCostDriftFriction,
  captureCreditExhaustionFriction,
  captureQuotaUnclassifiedFriction,
  captureModelUnavailableFriction,
  capturePacketTooLargeFriction,
  resolveRollingEngineFlag,
  createReviewSnapshot,
  removeReviewSnapshot,
  createDispatchDecisionLog,
} from "audit-tools/shared";
import type { AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import { type DispatchPausedState } from "../types/activeDispatch.js";
import {
  readActiveDispatch,
  persistPausedState,
  clearPausedState,
  recordPartialCompletionTerminal,
} from "./dispatch/pausePersist.js";
import { runRollingDispatch } from "../orchestrator/rollingDispatch.js";
import { createFreshSessionProvider } from "../providers/index.js";
import { prepareDispatchArtifacts, loadDispatchResultMap, releaseOwnedTaskClaims, type DispatchPlanEntry } from "./dispatch.js";
import { recordAttemptedPackets } from "./dispatchAttempted.js";
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

// The driver-identity resolver is single-sourced in shared (H2+H4 collapse, plan
// D5): audit's draw calls it with default policy (no command-shaped primaries — a
// read-only review packet carries no `worker_command`). Re-exported so audit call
// sites and tests keep one import point.
export { resolveHostDispatchProviderName } from "audit-tools/shared";

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
   * - `no_progress` — pending tasks exist but NONE could be planned this round
   *                (every one claimed by a live peer run, or fit no eligible
   *                pool). Deliberately NOT `complete`: reporting completion here
   *                (with a trivially-successful zero-result ingest) is what let
   *                the drain re-select the same obligation to maxTransitions —
   *                the observed completion livelock. `ingest` is null and
   *                `stranded_ids` empty so the caller's no-progress convergence
   *                guard emits a resumable block instead of transitioning.
   */
  status: "complete" | "paused" | "partial" | "no_progress";
  /** Why a `no_progress` round planned nothing (absent otherwise). */
  no_progress_cause?: "pending_tasks_unavailable";
  /** Pending (candidate) tasks this round — carried so the caller can render an honest no-progress reason. */
  pending_task_count?: number;
  /** Number of packets dispatched this pass (0 = nothing eligible). */
  packet_count: number;
  /** Packet ids stranded when status === "partial", or held while `paused`. */
  stranded_ids: string[];
  /**
   * Pool ids the engine PERMANENTLY excluded this pass — genuine terminal
   * exhaustion only (credit_exhausted / model_unavailable / a rate limit with no
   * parseable reset). The caller settles exactly THESE pools cross-cycle
   * (unified-routing step D): a transient failure (timeout, cooling 429,
   * quota_unclassified guess, per-packet 413) on pool A must never settle pool B —
   * the old any-non-complete ⇒ settle-ALL reaction is what collapsed a healthy
   * 3-pool frontier onto the walled host in the 2026-07-17 dogfood.
   */
  exhausted_pool_ids: string[];
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
 * with the packet's self-contained review prompt and the packet's result path.
 * The worker reads the cited files and writes its `AuditResult[]` to the result
 * file; the deterministic `mergeAndIngest` downstream is the authority on the
 * contents.
 *
 * WRITE SCOPE (mechanical, not prompt text): `repoRoot` for every spawned worker
 * is a DISPOSABLE detached review-snapshot worktree of HEAD, created lazily on
 * the first launch and shared by all packets — a worker-side `git checkout` /
 * reset / stray write mutates the throwaway copy, never the operator's real
 * checkout. Prompt-level "treat repo files as read-only" already failed live
 * (codex `workspace-write` roots the WRITABLE sandbox at the repo; agy has no
 * sandbox at all), and per-CLI flags cannot cover every lane — the launch root
 * is the one chokepoint that covers them uniformly
 * ([[enforce-robustness-in-tooling-not-host-discretion]]). Result/prompt/sidecar
 * paths stay absolute into the REAL artifacts dir. A failed snapshot creation
 * (non-git root) degrades loudly to the real root with a `write_scope_degraded`
 * friction record — a run is never blocked on the boundary, only un-shielded
 * with a visible reason. The drive removes the snapshot at its end.
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
  // Lazy per-dispatcher review snapshot, memoized as a promise so concurrent
  // first launches create exactly one. Resolves to the snapshot path, or to the
  // real root (loud degrade) when the snapshot cannot be created.
  let reviewRootPromise: Promise<string> | null = null;
  const resolveReviewRoot = (): Promise<string> => {
    reviewRootPromise ??= (async () => {
      const snapshot = await createReviewSnapshot(params.root, params.runId);
      if (snapshot.path !== null) return snapshot.path;
      process.stderr.write(
        `[rollingAuditDispatch] review-snapshot creation failed (${snapshot.reason}); ` +
          "spawned review workers DEGRADE to the real checkout — write-scope is prompt-only this run\n",
      );
      // Awaited (not fire-and-forget): the degrade is rare and cold, and an
      // unawaited write here races the caller's teardown.
      await captureStepBoundaryFriction(
        params.artifactsDir,
        params.runId,
        {
          eventType: "write_scope_degraded",
          discriminator: params.runId,
          note: `review-snapshot creation failed: ${snapshot.reason}`,
          severity: "high",
          category: "trap",
          area: "dispatch/write-scope",
        },
        "audit-code",
      );
      return params.root;
    })();
    return reviewRootPromise;
  };

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
        // Read-only review against the disposable snapshot worktree (real root
        // only on loud degrade) — see the dispatcher docblock. The worker reads
        // the cited files there and emits findings into the REAL artifacts dir.
        repoRoot: await resolveReviewRoot(),
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
        // The packet's REPO-RELATIVE source files under review. A single-shot /
        // no-file-access worker (openai-compatible / NIM) inlines these files'
        // current contents and refuses the dispatch if it cannot; the agentic-CLI
        // providers ignore it and read the files themselves. NOT `access.read_paths`
        // — that is the absolute host-scope grant (includes the prompt/result
        // artifacts), which would self-inline the prompt and false-refuse on an
        // out-of-repo artifacts dir.
        referencedFiles: entry.file_paths,
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
    // host grant must NOT lease (no double-count of the same work) — and for the
    // same reason the grant is not this path's ATTEMPTED set: the engine gets the
    // whole plan and decides per packet. This driver records what it actually
    // drove, below.
    grantLeases: false,
    recordAttemptedGrant: false,
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

  if (dispatch.plan.length === 0) {
    // Genuinely nothing eligible (every task already answered): ingest whatever
    // landed and let the loop re-derive state — this IS completion of the round.
    if (dispatch.candidate_task_count === 0) {
      return {
        status: "complete",
        packet_count: 0,
        stranded_ids: [],
        exhausted_pool_ids: [],
        ingest: await ingest({ runId, artifactsDir }),
      };
    }
    // Pending tasks exist but NONE could be planned — every candidate is claimed
    // by a live peer run, or the granted remainder fit no pool. Reporting
    // "complete" here (with a trivially-successful ingest) is the completion
    // livelock: the obligation stays unsatisfied, the drain re-selects it, and
    // each pass spins toward maxTransitions while the peer's claims run out
    // their 20-min lease. Release any claims we DID take this round
    // (granted-but-unfit) so a peer — or the next invocation under a new runId —
    // can plan them immediately.
    await releaseOwnedTaskClaims(artifactsDir, dispatch.granted_task_ids, runId);
    // SALVAGE FOLD (keeps the one useful thing the old empty-plan ingest did): a
    // prior pass of THIS run may have landed result files whose ingest then
    // threw — those tasks are excluded from `candidate_task_count` (prior-result
    // filter), so without a fold here they'd sit un-ingested for the rest of the
    // run. Try the fold; a run with nothing to fold throws ("all assigned
    // results missing") and that is exactly the no-progress case. Genuine
    // salvage (accepted > 0) IS progress and reports as a completed round so the
    // caller transitions; an idempotent replay (merge succeeds, 0 accepted) must
    // NOT count as progress or the fold would loop forever on its own replay.
    let salvage: MergeAndIngestResult | null = null;
    try {
      salvage = await ingest({ runId, artifactsDir });
    } catch {
      salvage = null;
    }
    const salvageAccepted = salvage?.summary?.["accepted_count"];
    if (typeof salvageAccepted === "number" && salvageAccepted > 0) {
      return {
        status: "complete",
        packet_count: 0,
        stranded_ids: [],
        exhausted_pool_ids: [],
        ingest: salvage,
      };
    }
    // Report NO PROGRESS (ingest null, nothing stranded) so the caller's
    // convergence guard emits a resumable block instead of transitioning.
    return {
      status: "no_progress",
      no_progress_cause: "pending_tasks_unavailable",
      pending_task_count: dispatch.candidate_task_count,
      packet_count: 0,
      stranded_ids: [],
      exhausted_pool_ids: [],
      ingest: null,
    };
  }

  const packets: RollingDispatchPacket<DispatchPlanEntry>[] = dispatch.plan.map(
    (entry) => ({
      id: entry.packet_id,
      payload: entry,
      estimatedTokens: entry.complexity.estimated_tokens,
      complexity: packetComplexityScore(entry),
      // F4: the packet's capability floor rides into the engine — the same
      // risk/complexity-derived tier the plan entry (and admission) carries.
      ...(entry.model_hint ? { requiredTier: entry.model_hint.tier } : {}),
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

  let run: Awaited<ReturnType<typeof runRollingDispatch<DispatchPlanEntry>>>;
  try {
    run = await runRollingDispatch<DispatchPlanEntry>(
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
      // Credit exhaustion: a pool out of prepaid usage credits (no reset timer,
      // distinct from a rate limit) has already been permanently excluded from
      // this run's admissible set by the engine; surface it as reviewable
      // friction so the operator knows to top up credits (single step-boundary
      // chokepoint, like the cost-drift hook above).
      onCreditExhausted: (info) => {
        captureCreditExhaustionFriction(artifactsDir, runId, info, "audit-code");
      },
      // Quota-unclassified harvest (Slice A2b): a pool death whose text was
      // quota-suspicious but matched no precise pattern degraded conservatively
      // (re-queued, never permanently excluded); surface the verbatim
      // (secret-scrubbed) text as reviewable friction so the operator can
      // classify it and improve errorParsing.ts's pattern set.
      onQuotaUnclassified: (info) => {
        captureQuotaUnclassifiedFriction(artifactsDir, runId, info, "audit-code");
      },
      // Model-unavailable exclusion (availability analog of cost drift): the
      // engine has already permanently excluded the 404ing pool from this run's
      // admissible set; surface it so the operator reconciles the stale registry
      // row (registry capability data is a lead, not reach).
      onModelUnavailable: (info) => {
        captureModelUnavailableFriction(artifactsDir, runId, info, "audit-code");
      },
      // Packet-too-large (per-packet sizing fault, HTTP 413): the engine skips
      // THIS pool for THIS packet only — no exclusion, no cooldown; surface each
      // (packet,pool) pair so partition-time sizing can be reconciled.
      onPacketTooLarge: (info) => {
        capturePacketTooLargeFriction(artifactsDir, runId, info, "audit-code");
      },
      // Legibility (spec Resolved decision 3): every engine dispatch decision
      // (admit / ledger block / strand, with its full constraint-outcome data)
      // appends to this run's dispatch-explains.jsonl.
      onAdmissionDecision: createDispatchDecisionLog(
        join(artifactsDir, "runs", runId, "dispatch-explains.jsonl"),
      ),
    },
    dispatchPacket,
    );
  } finally {
    // Best-effort removal of the disposable review-snapshot worktree the
    // dispatcher lazily created (no-op when no spawned launch happened, when an
    // injected test dispatcher ran, or on a non-git root). A straggler-held cwd
    // that defeats removal is swept by the next drive's pre-create pass.
    await removeReviewSnapshot(root, runId);
  }

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
  // Record what the engine actually drove, before ingest. `prepareDispatchArtifacts`
  // deliberately recorded nothing on this path (`recordAttemptedGrant: false`) —
  // the grant is not the attempted set here, because the engine receives the whole
  // plan and admits per packet itself. `run.results` is what reached a worker; a
  // packet stranded on an exhausted or paused pool is absent, which is exactly what
  // merge must see to defer its tasks instead of calling them missing.
  await recordAttemptedPackets(
    join(artifactsDir, "runs", runId),
    run.results.map((r) => r.packet.id),
  );

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
  // Release THIS run's still-held task claims (owner-scoped; terminal tasks were
  // already cleared by the inline merge). Whatever produced no ingested result —
  // stranded packets, provider errors, ingestion-invalid results — must not stay
  // claimed for the rest of the 20-min lease: every later `next-step` runs under
  // a NEW runId, so an unreleased claim reads as a live peer and starves the
  // whole frontier (the observed completion livelock's other half).
  await releaseOwnedTaskClaims(artifactsDir, dispatch.granted_task_ids, runId);

  // A resumable pause is its own status so the caller renders a "waiting for
  // provider" handoff rather than a terminal partial. The terminal (livelock)
  // strand keeps `run.status` ("partial") — `advanceRollingPause` already stamped
  // the partial-completion terminal that lets synthesis proceed on partial coverage.
  return {
    status: pausedState ? "paused" : run.status,
    packet_count: packets.length,
    stranded_ids: run.stranded_ids,
    exhausted_pool_ids: run.exhausted_pool_ids,
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
/**
 * Expand a set of PACKET ids to their constituent TASK ids via the run's dispatch
 * result map (one `{packet_id, task_id}` entry per (packet, task), rewritten each pass
 * over that pass's emitted packets). Callers MUST pass CURRENT-pass packet ids — the
 * map only covers this pass's packets, and packet ids embed a running ordinal that
 * re-indexes when the pending set shrinks, so a stale id from an earlier pass would not
 * be found. The in-process livelock terminal needs TASK ids because `deriveAuditState`
 * matches the terminal's `stranded_ids` against `task_id`. If the map is missing
 * (older run) or yields nothing, degrade to the packet ids themselves — no worse than
 * the prior behaviour, and the livelock guard still terminates.
 */
async function packetIdsToTaskIds(
  artifactsDir: string,
  runId: string,
  packetIds: string[],
): Promise<string[]> {
  const runDir = join(artifactsDir, "runs", runId);
  const resultMap = await loadDispatchResultMap(runDir);
  if (!resultMap) return packetIds;
  const byPacket = new Map<string, string[]>();
  for (const entry of resultMap.entries) {
    const list = byPacket.get(entry.packet_id) ?? [];
    list.push(entry.task_id);
    byPacket.set(entry.packet_id, list);
  }
  const taskIds = packetIds.flatMap((packetId) => byPacket.get(packetId) ?? []);
  // A packet maps to ≥1 tasks and two packets never share a task, so de-dupe is
  // defensive; keep first-seen order (content-derived, stable).
  return taskIds.length > 0 ? [...new Set(taskIds)] : packetIds;
}

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
    // guard, CE-003/CE-205). The terminal's `stranded_ids` are matched against
    // `task_id` by `deriveAuditState` (to satisfy `audit_tasks_completed`), so they
    // MUST be TASK ids, not the PACKET ids the in-process engine strands internally —
    // a packet id never matches, the tasks stay pending, and synthesis never unlocks
    // (an infinite pause loop, the exact stall this bound exists to end). Expand THIS
    // pass's stranded packet ids (`strandedIds`), never the pause's frozen first-pause
    // `next.stranded_node_ids`: an intervening partial completion re-packetizes the
    // remaining tasks (packet ids embed a running ordinal), so the frozen ids can be
    // absent from this pass's rewritten dispatch-result-map — a full lookup miss that
    // degrades to packet ids. The current stranded set IS the still-uncovered tasks and
    // is guaranteed present in this pass's result map (parity with the host path's
    // `advanceHostDispatchPause` `strandedTaskIds`, Increment B residual b).
    await clearPausedState(artifactsDir, runId);
    const strandedTaskIds = await packetIdsToTaskIds(artifactsDir, runId, strandedIds);
    await recordPartialCompletionTerminal(artifactsDir, runId, {
      reason: "livelock_guard",
      stranded_ids: strandedTaskIds,
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

