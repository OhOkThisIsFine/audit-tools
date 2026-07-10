// dispatch.ts — barrel re-export + prepareDispatchArtifacts orchestrator.
// The implementation is split into focused sub-modules under src/cli/dispatch/:
//   types.ts       — shared interfaces/constants/type re-exports
//   tierRouting.ts — resolveDispatchTier, resolveTierBudgets, computeDispatchFanout
//   packetFilter.ts — filterPackets, buildPendingAuditTasks, fitPacketsToTierBudgets, etc.
//   packetPrompt.ts — buildTaskSections, buildPacketPrompt, extractPacketAnchor
//   quotaPool.ts   — buildDispatchPool, finalizeDispatchQuota
//   paths.ts       — withinRoot, dispatchResultMapPath, loadDispatchResultMap, etc.
// All external imports of "./dispatch.js" continue to resolve here.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writeJsonFile, computeDispatchCapacity } from "audit-tools/shared";
import type {
  SessionConfig,
  CapacityPool,
  ResolvedProviderName,
} from "audit-tools/shared";
import type { HostModelRosterEntry, ProviderRateLimits } from "audit-tools/shared";
import { isFileMissingError, ClaimRegistry, taskClaimsPath, readConfirmedCostPositions, readConfirmedDispatchBias, emitBlindDispatchFrictionIfBlind } from "audit-tools/shared";
import { mergeOwnerTokens } from "./ownerTokens.js";
import type { WorkerTask } from "../types/workerSession.js";
import { loadArtifactBundle } from "../io/artifacts.js";
import { writePacketSchemaFiles } from "../io/runArtifacts.js";
import type { AuditTask } from "../types.js";
import { sizeIndexFromManifest, orderTasksForPacketReview, buildReviewPacketsFromPartition } from "../orchestrator/reviewPackets.js";
import { computeContinuityScores } from "../orchestrator/continuityScore.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { taskResultPath, packetPromptPath, artifactNameForId } from "./args.js";
import { resolveFreshSessionProviderName } from "../providers/index.js";
import { buildProviderModelKey } from "../quota/index.js";
import {
  HostSessionQuotaSource,
  type HostSessionEscalation,
} from "audit-tools/shared/quota/hostSessionQuotaSource";
import {
  type ActiveDispatchState,
  type DispatchResultMapEntry,
  type DispatchResultMap,
  DISPATCH_RESULT_MAP_FILENAME,
  ACTIVE_DISPATCH_FILENAME,
} from "./dispatch/types.js";
import {
  LARGE_FILE_PACKET_TARGET_LINES,
  type DispatchComplexity,
  type DispatchFanout,
  type PrepareDispatchResult,
  type DispatchPlanEntry,
  DEFAULT_DEEP_ROUTING_RISK,
  DEFAULT_STANDARD_ROUTING_RISK,
  DEFAULT_DISPATCH_CONFIRM_THRESHOLD,
  DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS,
} from "./dispatch/types.js";
import {
  resolveDispatchTier,
  resolveTierBudgets,
  computeDispatchFanout,
  TIER_RANK,
} from "./dispatch/tierRouting.js";
import {
  isIsolatedLargeFilePacket,
  buildDispatchComplexity,
  buildPendingAuditTasks,
  filterPackets,
  resolveDispatchTaskGraph,
  fitPacketsToTierBudgets,
  collectOversizedWarnings,
} from "./dispatch/packetFilter.js";
import {
  extractPacketAnchor,
  buildTaskSections,
  buildPacketPrompt,
  buildLargeFileSection,
} from "./dispatch/packetPrompt.js";
import { buildKnipGraphIndex } from "../orchestrator/knipGraphCrosscheck.js";
import { buildAnalyzerSignalAnchorIndex } from "../orchestrator/fileAnchors.js";
import {
  withinRoot,
  dispatchResultMapPath,
  loadDispatchResultMap,
  entriesByTaskId,
  resolveRunScopedArg,
} from "./dispatch/paths.js";
import {
  buildDispatchPool,
  finalizeDispatchQuota,
} from "./dispatch/quotaPool.js";

// Re-export everything for consumers of "./dispatch.js".
export type {
  ActiveDispatchState,
  DispatchResultMapEntry,
  DispatchResultMap,
  DispatchComplexity,
  DispatchFanout,
  PrepareDispatchResult,
  DispatchPlanEntry,
};
export {
  DISPATCH_RESULT_MAP_FILENAME,
  ACTIVE_DISPATCH_FILENAME,
  LARGE_FILE_PACKET_TARGET_LINES,
  DEFAULT_DEEP_ROUTING_RISK,
  DEFAULT_STANDARD_ROUTING_RISK,
  DEFAULT_DISPATCH_CONFIRM_THRESHOLD,
  DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS,
  resolveDispatchTier,
  resolveTierBudgets,
  computeDispatchFanout,
  TIER_RANK,
  isIsolatedLargeFilePacket,
  buildDispatchComplexity,
  buildPendingAuditTasks,
  filterPackets,
  fitPacketsToTierBudgets,
  collectOversizedWarnings,
  buildTaskSections,
  buildPacketPrompt,
  withinRoot,
  dispatchResultMapPath,
  loadDispatchResultMap,
  entriesByTaskId,
  resolveRunScopedArg,
};

// Lease window for a cooperative audit-task claim (slice 2). Long because the
// claim is held across an OUT-OF-PROCESS host worker run with no live heartbeat,
// so it must bound a worker's whole runtime; a genuinely-crashed peer's claim is
// reclaimed after this window. Correctness for the rare legitimate overrun rests
// on dedup-by-task_id at ingest, not on this value being exact. Exported so the
// merge-side ownership gate (mergeAndIngestCommand.ts) constructs its registry
// with the SAME lease — liveness must be judged against one window, never two.
export const AUDIT_TASK_CLAIM_LEASE_MS = 20 * 60_000;

export async function prepareDispatchArtifacts(params: {
  packageRoot: string;
  runId: string;
  artifactsDir: string;
  root?: string;
  sessionConfig?: SessionConfig;
  providerName?: ResolvedProviderName | null;
  hostModel?: string | null;
  queryLimits?: (model: string | null) => Promise<ProviderRateLimits | null>;
  hostActiveSubagentLimit?: number | null;
  /** Context window the host reports for its dispatch model (handshake). */
  hostContextTokens?: number | null;
  /** Output cap the host reports for its dispatch model (handshake). */
  hostOutputTokens?: number | null;
  /** Ordered model roster (lowest rank first); outranks the scalar pair. */
  hostModelRoster?: HostModelRosterEntry[] | null;
  /** Opaque model identity for the quota key when no model name resolves. */
  hostModelId?: string | null;
  /**
   * Restrict packetization to an explicit task subset (A-8 hybrid): the in-process
   * driver reviews ONLY its coordinator-assigned partition WITHOUT reading or
   * rewriting the shared `pending-audit-tasks.json` the host-review path owns for
   * its own (complementary) subset. Absent → the usual file-or-bundle task source.
   */
  tasksOverride?: AuditTask[];
  /**
   * Override the confirmed capacity pools (A-8 hybrid): the in-process driver sizes
   * + dispatches against the backend (NIM) pool(s) only, not the host pool it is
   * spilling off of. Absent → the host-model pools from `buildDispatchPool`.
   */
  poolsOverride?: CapacityPool[];
  /**
   * Fed to the retained host-session source (both branches below) so a bounded
   * account-wall escalation routes to the caller's friction chokepoint instead of
   * only the default stderr line. Omit to keep the prior silent-stderr behavior.
   */
  onEscalation?: (escalation: HostSessionEscalation) => void;
  /**
   * Whether the admission loop LEASES the granted set against the shared ledger
   * (host-subagent path). The in-process rolling driver passes `false` — it admits
   * + leases per packet through the rolling engine itself, so the host grant must
   * not double-lease. Defaults to true. See `finalizeDispatchQuota`.
   */
  grantLeases?: boolean;
}): Promise<PrepareDispatchResult> {
  const runId = params.runId;
  const artifactsDir = params.artifactsDir;
  const runDir = join(artifactsDir, "runs", runId);
  const taskResultsDir = join(runDir, "task-results");
  const dispatchPlanPath = join(runDir, "dispatch-plan.json");
  let reviewRoot = params.root;
  try {
    const workerTask = await readJsonFile<WorkerTask>(join(runDir, "task.json"));
    reviewRoot ??= workerTask.repo_root;
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
  }

  const bundle = await loadArtifactBundle(artifactsDir);
  const tasksPath = join(runDir, "pending-audit-tasks.json");
  // A-8 hybrid: an explicit task subset (the in-process driver's coordinator-assigned
  // partition) bypasses the shared pending-audit-tasks.json the host-review path owns
  // for its complementary subset — so the two drivers never review the same task.
  const tasks =
    params.tasksOverride ??
    (await readJsonFile<AuditTask[]>(tasksPath).catch(async (error) => {
      if (isFileMissingError(error)) {
        const generated = buildPendingAuditTasks(bundle);
        await writeJsonFile(tasksPath, generated);
        return generated;
      }
      throw error;
    }));
  // Fail closed: an invalid/tampered session-config must abort dispatch, never
  // silently degrade to an empty (permissive) default. `loadSessionConfig` throws
  // on a config that fails validation (spoofed provider, command-injection-shaped
  // provider command, non-boolean dangerously_skip_permissions, …); swallowing it
  // here would build the dispatch against an attacker-influenced config. Matches
  // the sibling callers, which all let the error propagate.
  const sessionConfig: SessionConfig =
    params.sessionConfig ?? (await loadSessionConfig(artifactsDir));
  const lensDefsPath = join(params.packageRoot, "dispatch", "lens-definitions.json");
  const lensDefs = await readJsonFile<Record<string, { description: string; do_not_report: string }>>(lensDefsPath);

  await mkdir(taskResultsDir, { recursive: true });

  // FINDING-009: make the AuditResult JSON-Schema (and the two sibling schemas
  // it $refs) reachable from this run's task-results directory so packet workers
  // can optionally self-validate before calling submit-packet.
  await writePacketSchemaFiles(taskResultsDir, params.packageRoot);

  const priorResultTaskIds = new Set<string>();
  for (const task of tasks) {
    if (existsSync(taskResultPath(taskResultsDir, task.task_id))) {
      priorResultTaskIds.add(task.task_id);
    }
  }
  const candidateTasks = priorResultTaskIds.size > 0
    ? tasks.filter((task) => !priorResultTaskIds.has(task.task_id))
    : tasks;

  // Cooperative multi-agent task claiming (slice 2,
  // spec/multi-ide-concurrent-runs-design.md). Claim each candidate task in the
  // shared per-run task-claims registry so concurrent peers dispatch DISJOINT
  // subsets: a task a live peer holds (in-flight on that peer's host) is omitted
  // here — its result will arrive via the shared ledger, and a crashed peer's
  // claim goes stale (long lease) for reclaim. Claims for tasks we end up NOT
  // emitting (deferred by the top-K budget cap) are released below so peers can
  // take them. The A-8 hybrid in-process driver (`tasksOverride`) is claimed
  // here too (D-66/67 slice-1, Part A: uniform ownership-gate coverage) — it is
  // a DIFFERENT registry from the coordinator's pre-assignment claim on
  // `runs/audit-node-claims.json` (see hybridDispatch.ts), so this is not a
  // double-claim hazard, and same-pool re-grant is idempotent-but-token-rotating
  // even if a peer momentarily held the same task_id here too.
  const taskClaims = new ClaimRegistry(taskClaimsPath(artifactsDir), undefined, AUDIT_TASK_CLAIM_LEASE_MS);
  // poolId = runId so THIS run's repeated dispatch re-grants its own in-flight
  // tasks (idempotent), while a different IDE's run (distinct runId) is
  // partitioned off. See ClaimRegistry.claimMany.
  const { granted: grantedTaskIds, ownerTokenByNode } = await taskClaims.claimMany(
    candidateTasks.map((task) => task.task_id),
    runId,
  );
  const grantedSet = new Set(grantedTaskIds);
  const dispatchTasks = candidateTasks.filter((task) => grantedSet.has(task.task_id));
  // A coordinator-assigned override task a live peer holds on task-claims.json is
  // skipped by the uniform claiming above — surface it (mirror of the merge-side
  // gate's warn) so the drop is never silent: the driver believed it owned this
  // partition, and the skipped task's result will arrive via the peer's ledger.
  if (params.tasksOverride) {
    const skippedOverride = candidateTasks
      .map((task) => task.task_id)
      .filter((taskId) => !grantedSet.has(taskId));
    if (skippedOverride.length > 0) {
      process.stderr.write(
        `[prepare-dispatch] Warning: ${skippedOverride.length} override task(s) skipped — task ` +
          `claim held live by a peer: ${skippedOverride.join(", ")}\n`,
      );
    }
  }
  // Part A (D-66/67 slice-1): persist the freshly-minted owner tokens into the
  // run-scoped sidecar (see ownerTokens.ts for why NOT active-dispatch.json) so
  // mergeAndIngest's ownership gate can verify each terminal task's claim is
  // still ours at merge time.
  if (grantedTaskIds.length > 0) {
    await mergeOwnerTokens(runDir, ownerTokenByNode);
  }

  const lineIndex = Object.fromEntries(
    dispatchTasks.flatMap((task) =>
      Object.entries(task.file_line_counts ?? {}),
    ),
  );
  const sizeIndex = sizeIndexFromManifest(bundle.repo_manifest);
  // Access-memory continuity bias (increment 2b): score files by how connected
  // they are to already-touched code, JIT from the persisted access_memory
  // counters + the dependency graph. Feeds packet ORDERING (a back-payload
  // selection concern) at the packetization sites below; empty when there's no
  // signal yet, in which case ordering is identical to pre-2b. Not threaded into
  // orderTasksForPacketReview — that task order is re-derived by the JIT
  // partitioner downstream, so biasing it would be discarded work.
  const continuityScores = computeContinuityScores(
    bundle.access_memory,
    bundle.graph_bundle,
  );
  const orderedTasks = orderTasksForPacketReview(dispatchTasks, {
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex,
  });

  // Quota-before-packetization: resolve the dispatching model's context budget
  // first, then partition the provider-neutral task-affinity graph into packets
  // sized to that budget (JIT). This replaces the frozen plan-time packet cap —
  // a run started under one model re-partitions cleanly under another's window.
  // A-8 hybrid: when the caller pins the backend (NIM) pool(s), size packetization to
  // THAT pool's window (through the shared capacity fold) and dispatch against it — so
  // the in-process driver reviews its partition on the backend it spilled onto, not the
  // host pool. Otherwise resolve the host-model pools from the handshake as usual.
  let dispatchPool: Awaited<ReturnType<typeof buildDispatchPool>>;
  if (params.poolsOverride && params.poolsOverride.length > 0) {
    const probe = computeDispatchCapacity({
      pools: params.poolsOverride,
      sessionConfig,
      pendingItemTokens: [],
    });
    const limits = probe.primary.schedule.resolved_limits;
    // This branch bypasses buildDispatchPool entirely (A-8 hybrid: sizing against
    // the caller-pinned backend pool, not the host-model handshake), so it must
    // construct its own retained host-session source rather than inheriting one.
    const overrideProviderName = resolveFreshSessionProviderName(undefined, sessionConfig);
    const overrideHostSession = new HostSessionQuotaSource({
      providerModelKey: buildProviderModelKey(
        overrideProviderName,
        params.hostModel ?? params.hostModelId ?? null,
      ),
      onEscalation: params.onEscalation,
    });
    dispatchPool = {
      pools: params.poolsOverride,
      hostModel: params.hostModel ?? null,
      contextBudgetTokens: Math.max(1, limits.context_tokens - limits.output_tokens),
      tierBudgets: null,
      hostSession: overrideHostSession,
    };
  } else {
    dispatchPool = await buildDispatchPool({
      sessionConfig,
      providerName: params.providerName,
      hostModel: params.hostModel,
      queryLimits: params.queryLimits,
      hostActiveSubagentLimit: params.hostActiveSubagentLimit,
      hostContextTokens: params.hostContextTokens,
      hostOutputTokens: params.hostOutputTokens,
      hostModelRoster: params.hostModelRoster,
      hostModelId: params.hostModelId,
      onEscalation: params.onEscalation,
    });
  }
  const taskGraph = resolveDispatchTaskGraph(bundle, orderedTasks);
  let packets = buildReviewPacketsFromPartition(orderedTasks, {
    graph: taskGraph,
    contextTokenBudget: dispatchPool.contextBudgetTokens,
    riskMassBudget: sessionConfig.dispatch?.risk_mass_budget,
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex,
    continuityScores,
  });
  if (dispatchPool.tierBudgets) {
    packets = fitPacketsToTierBudgets({
      packets,
      taskGraph,
      orderedTasks,
      tierBudgets: dispatchPool.tierBudgets,
      sessionConfig,
      lineIndex,
      sizeIndex,
      graphBundle: bundle.graph_bundle,
      continuityScores,
    });
  }
  const tasksById = new Map(orderedTasks.map((task) => [task.task_id, task]));
  const resultPathByTaskId = new Map(
    orderedTasks.map((task) => [
      task.task_id,
      taskResultPath(taskResultsDir, task.task_id),
    ]),
  );
  const resultPathSet = new Set(resultPathByTaskId.values());
  if (resultPathSet.size !== resultPathByTaskId.size) {
    throw new Error(
      "prepare-dispatch generated duplicate result paths; task ids must be uniquely addressable.",
    );
  }

  // Packets come back priority-ordered (high -> medium -> low), so packets[0] is
  // the top-priority packet. Budget cap (top-K) is the only filter.
  //
  // FINDING-013: top-K coverage budget. Budget defaults OFF (no cap) so default
  // behavior is unchanged.
  const { emitPackets, deferredPackets } =
    filterPackets(packets, sessionConfig);
  const budgetCapped = deferredPackets.length > 0;

  // Release claims we took on tasks that were NOT emitted this round (deferred by
  // the top-K budget cap): holding them would hoard deferred work a peer could
  // otherwise pick up. Only the emitted subset stays claimed (in-flight to us).
  {
    const emittedTaskIds = new Set(
      emitPackets.flatMap((packet) => packet.task_ids),
    );
    const deferredClaimed = dispatchTasks
      .map((task) => task.task_id)
      .filter((taskId) => !emittedTaskIds.has(taskId));
    if (deferredClaimed.length > 0) await taskClaims.clear(deferredClaimed);
  }

  const plan: DispatchPlanEntry[] = [];
  const resultMapEntries: DispatchResultMapEntry[] = [];
  for (const task of tasks) {
    if (priorResultTaskIds.has(task.task_id)) {
      resultMapEntries.push({
        packet_id: "__prior_dispatch__",
        task_id: task.task_id,
        result_path: taskResultPath(taskResultsDir, task.task_id),
      });
    }
  }
  let largestPacketId: string | null = null;
  let largestLines = 0;
  let largestEstimatedTokens = 0;
  const warnings: Array<{ code: string; message: string }> = [];

  const hasAnalyzerSignalTask = orderedTasks.some(
    (t) => t.tags?.includes("external_analyzer_signal"),
  );
  // Render-time knip↔graph cross-check index (CP-NODE-2): only needed when at
  // least one task carries an external_analyzer_signal tag (the rendering guards
  // on the same tag before consulting either index).
  const knipGraphIndex = hasAnalyzerSignalTask
    ? buildKnipGraphIndex({
        graphBundle: bundle.graph_bundle,
        surfaceManifest: bundle.surface_manifest,
        criticalFlows: bundle.critical_flows,
      })
    : undefined;
  const analyzerSignalIndex = hasAnalyzerSignalTask
    ? buildAnalyzerSignalAnchorIndex(bundle.external_analyzer_results)
    : undefined;

  for (const packet of emitPackets) {
    const promptPath = packetPromptPath(taskResultsDir, packet.packet_id);
    const packetTasks = packet.task_ids
      .map((taskId) => tasksById.get(taskId))
      .filter((task): task is AuditTask => task !== undefined);

    if (packet.total_lines > largestLines) {
      largestLines = packet.total_lines;
      largestEstimatedTokens = packet.estimated_tokens;
      largestPacketId = packet.packet_id;
    }
    const largeFileMode = isIsolatedLargeFilePacket(packet);
    if (packet.total_lines > LARGE_FILE_PACKET_TARGET_LINES && !largeFileMode) {
      warnings.push({
        code: "large_packet",
        message: `large packet ${packet.packet_id} (~${packet.total_lines} lines) may hit quota limits`,
      });
    }

    for (const task of packetTasks) {
      if (!lensDefs[task.lens]) {
        warnings.push({
          code: "missing_lens_definition",
          message: `no lens definition for '${task.lens}' (task ${task.task_id})`,
        });
      }
    }

    const fileList = packet.file_paths.map((path) => {
      const lines = packet.file_line_counts[path] ?? 0;
      return `- ${path} (${lines} lines)`;
    }).join("\n");
    const { anchorPath, anchorSummary } = largeFileMode
      ? await extractPacketAnchor({ packet, reviewRoot, bundle, taskResultsDir, warnings })
      : { anchorPath: null, anchorSummary: null };
    const largeFileSection = buildLargeFileSection(largeFileMode, anchorSummary, anchorPath);
    const taskSections = buildTaskSections(packetTasks, lensDefs, lineIndex, analyzerSignalIndex, knipGraphIndex);
    // The worker writes its AuditResult[] array directly to this packet result
    // file (its prompt's result_path == this entry's result_path); merge-and-
    // ingest recovers each task_id from that one array file. Per-task result
    // paths are kept in the result map as the canonical ingestion targets, but
    // the on-disk artifact is this single per-packet array (filename keeps the
    // historical "inline-result" stem the merge fallback already recognizes).
    const packetResultPath = join(taskResultsDir, artifactNameForId(packet.packet_id, "inline-result.json"));
    const complexity = buildDispatchComplexity(packet, largeFileMode);
    for (const task of packetTasks) {
      resultMapEntries.push({
        packet_id: packet.packet_id,
        task_id: task.task_id,
        result_path: resultPathByTaskId.get(task.task_id)!,
      });
    }

    const prompt = buildPacketPrompt({ packet, packetTasks, fileList, largeFileSection, taskSections, resultPath: packetResultPath, repoRoot: reviewRoot });
    await writeFile(promptPath, prompt, "utf8");
    const packetWritePaths = packetTasks
      .map((task) => resultPathByTaskId.get(task.task_id))
      .filter((p): p is string => p !== undefined);
    plan.push({
      packet_id: packet.packet_id,
      description:
        `Audit ${packet.file_paths.length} file(s), ${packet.task_ids.length} task(s), ${packet.lenses.length} lens(es) (~${packet.total_lines} lines)` +
        (largeFileMode ? " [isolated large-file mode]" : ""),
      prompt_path: promptPath,
      result_path: packetResultPath,
      complexity,
      model_hint: resolveDispatchTier({
        routingRisk: packet.routing_risk,
        complexity,
        routingTiers: sessionConfig.dispatch?.routing_tiers,
      }),
      access: {
        read_paths: [
          promptPath,
          ...(reviewRoot
            ? packet.file_paths.map((p) => join(reviewRoot, p))
            : packet.file_paths),
        ],
        // packetResultPath is the file the worker actually writes; per-task
        // paths are canonical ingestion targets. Both must be pre-approved so
        // hosts that enforce write_paths don't block the result write.
        write_paths: [...packetWritePaths, packetResultPath],
        forbidden_patterns: ["packet-*-result.json", "audit_result_*.json"],
      },
    });
  }

  await writeJsonFile(dispatchPlanPath, plan);
  await writeJsonFile(dispatchResultMapPath(runDir), {
    contract_version: "audit-code-dispatch-results/v1alpha1",
    run_id: runId,
    entries: resultMapEntries,
  } satisfies DispatchResultMap);

  // Admission control replaces the preset wave size: the loop GRANTS the affordable
  // admitted set (cost-first-capable, ledger-leased) from the priority-ordered plan
  // — highest-priority packets first, so a budget-limited grant admits the most
  // important work; the host dispatches exactly the granted set and re-invokes
  // next-step for the remainder. Today there is a single host pool; a heterogeneous
  // provider pool slots in through the same admission loop without changing the call.
  const packetPriorityScore = (entry: DispatchPlanEntry): number =>
    entry.complexity.priority === "high" ? 1 : entry.complexity.priority === "low" ? 0 : 0.5;
  const admissionPackets = plan
    .map((entry) => ({
      id: entry.packet_id,
      inputTokens: entry.complexity.estimated_tokens,
      complexity: packetPriorityScore(entry),
    }))
    .sort((a, b) => b.complexity - a.complexity);
  // Cost-first routing rung 1: honor the operator-confirmed cost ordering from the
  // shared Gate-0 confirmation (spec/cost-first-routing.md). Best-effort — absent /
  // unreadable / roster-changed confirmation ⇒ costRank falls to real price then tier.
  const confirmedCostPositions = await readConfirmedCostPositions(params.root, sessionConfig);
  // Cost↔speed dial: the operator's durable operating point from the same Gate-0
  // confirmation (spec/dispatch-cost-speed-dial.md). Absent ⇒ 0 (cost-first default).
  const dispatchBias = await readConfirmedDispatchBias(params.root, sessionConfig);
  const { dispatchQuotaPath, waveSchedule, dispatchCapacity, admission } = await finalizeDispatchQuota({
    runId,
    runDir,
    sessionConfig,
    pools: dispatchPool.pools,
    hostModel: dispatchPool.hostModel,
    packets: admissionPackets,
    hostModelRoster: params.hostModelRoster,
    tierBudgets: dispatchPool.tierBudgets,
    grantLeases: params.grantLeases,
    confirmedCostPositions,
    dispatchBias,
  });

  // Fail loud when self-quota monitoring is blind on the host-dispatch path (no live
  // snapshot ⇒ the fan-out is unpaced). Single-sourced with remediate so both emit the
  // identical stderr + run-ledger friction — the uncapped-but-LOUD half of the always-on
  // quota track. Host path only (grantLeases !== false); the in-process driver paces
  // reactively so a null proactive snapshot is not the same silent hazard there.
  if (params.grantLeases !== false) {
    await emitBlindDispatchFrictionIfBlind({
      artifactsDir,
      runId,
      schedule: waveSchedule,
      itemCount: plan.length,
      waveKind: "review",
      toolName: "audit-code",
    });
  }

  warnings.push(
    ...collectOversizedWarnings(plan, waveSchedule, dispatchPool.tierBudgets),
  );

  const warningsPath = warnings.length > 0
    ? join(runDir, "dispatch-warnings.json")
    : null;
  if (warningsPath) {
    await writeJsonFile(warningsPath, warnings);
  }

  // FINDING-013: record deferred packets/tasks so the completion obligation can
  // exclude them under a budget cap (present only when actually capped).
  const deferredPacketIds = deferredPackets.map((packet) => packet.packet_id);
  const deferredTaskIds = deferredPackets.flatMap((packet) => packet.task_ids);
  // Carry forward the resumable DC-4 pause across re-preparation: a paused rolling
  // run re-prepares its dispatch plan each pass, so a fresh artifact would clobber
  // the persisted `paused_state` (settled exclusions + pause_count) and reset the
  // run to pause-0 forever. Preserve it for the SAME run id so `advanceRollingPause`
  // reads the prior pause and advances it toward resume-or-livelock.
  const priorActiveDispatch = await readJsonFile<ActiveDispatchState>(
    join(artifactsDir, ACTIVE_DISPATCH_FILENAME),
  ).catch(() => null);
  const carriedPausedState =
    priorActiveDispatch?.run_id === runId
      ? priorActiveDispatch.paused_state
      : undefined;
  const activeDispatch: ActiveDispatchState = {
    run_id: runId,
    created_at: new Date().toISOString(),
    packet_count: plan.length,
    task_count: orderedTasks.length,
    status: "active",
    ...(budgetCapped
      ? {
          budget_packet_count: packets.length,
          deferred_packet_ids: deferredPacketIds,
          deferred_task_ids: deferredTaskIds,
        }
      : {}),
    ...(carriedPausedState ? { paused_state: carriedPausedState } : {}),
  };
  await writeJsonFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), activeDispatch);

  // FINDING-012: pure-arithmetic fan-out summary the loader can gate on. The width
  // is the GRANTED set size (emergent from budget + any declared cap), not a
  // computed concurrency number.
  const fanout = computeDispatchFanout({
    agentCount: plan.length,
    grantedCount: admission.granted_packet_ids.length,
    declaredCap: admission.declared_cap,
    confirmThreshold: sessionConfig.dispatch?.confirm_threshold,
  });

  return {
    run_id: runId,
    dispatch_plan_path: dispatchPlanPath,
    dispatch_quota_path: dispatchQuotaPath,
    packet_count: plan.length,
    task_count: orderedTasks.length,
    skipped_task_count: priorResultTaskIds.size,
    granted_count: admission.granted_packet_ids.length,
    declared_cap: admission.declared_cap,
    agent_count: fanout.agent_count,
    confirmation_recommended: fanout.confirmation_recommended,
    dispatch_summary: fanout.dispatch_summary,
    budget_capped: budgetCapped,
    deferred_packet_count: deferredPackets.length,
    largest_packet: largestPacketId
      ? {
          packet_id: largestPacketId,
          total_lines: largestLines,
          estimated_tokens: largestEstimatedTokens,
        }
      : null,
    warning_count: warnings.length,
    dispatch_warnings_path: warningsPath,
    plan,
    pools: dispatchPool.pools,
    hostSession: dispatchPool.hostSession,
  };
}
