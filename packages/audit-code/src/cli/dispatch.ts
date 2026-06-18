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
import { readJsonFile, writeJsonFile } from "@audit-tools/shared";
import type { SessionConfig } from "@audit-tools/shared";
import type { HostModelRosterEntry, ProviderRateLimits } from "@audit-tools/shared";
import { isFileMissingError } from "@audit-tools/shared";
import type { WorkerTask } from "../types/workerSession.js";
import { loadArtifactBundle } from "../io/artifacts.js";
import { writePacketSchemaFiles } from "../io/runArtifacts.js";
import type { AuditTask } from "../types.js";
import { sizeIndexFromManifest, orderTasksForPacketReview, buildReviewPacketsFromPartition } from "../orchestrator/reviewPackets.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { taskResultPath, packetPromptPath, artifactNameForId } from "./args.js";
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



export async function prepareDispatchArtifacts(params: {
  packageRoot: string;
  runId: string;
  artifactsDir: string;
  root?: string;
  sessionConfig?: SessionConfig;
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
  const tasks = await readJsonFile<AuditTask[]>(tasksPath).catch(async (error) => {
    if (isFileMissingError(error)) {
      const generated = buildPendingAuditTasks(bundle);
      await writeJsonFile(tasksPath, generated);
      return generated;
    }
    throw error;
  });
  const sessionConfig: SessionConfig =
    params.sessionConfig ?? (await loadSessionConfig(artifactsDir).catch(() => ({} as SessionConfig)));
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
  const dispatchTasks = priorResultTaskIds.size > 0
    ? tasks.filter((task) => !priorResultTaskIds.has(task.task_id))
    : tasks;

  const lineIndex = Object.fromEntries(
    dispatchTasks.flatMap((task) =>
      Object.entries(task.file_line_counts ?? {}),
    ),
  );
  const sizeIndex = sizeIndexFromManifest(bundle.repo_manifest);
  const orderedTasks = orderTasksForPacketReview(dispatchTasks, {
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex,
  });

  // Quota-before-packetization: resolve the dispatching model's context budget
  // first, then partition the provider-neutral task-affinity graph into packets
  // sized to that budget (JIT). This replaces the frozen plan-time packet cap —
  // a run started under one model re-partitions cleanly under another's window.
  const dispatchPool = await buildDispatchPool({
    sessionConfig,
    hostModel: params.hostModel,
    queryLimits: params.queryLimits,
    hostActiveSubagentLimit: params.hostActiveSubagentLimit,
    hostContextTokens: params.hostContextTokens,
    hostOutputTokens: params.hostOutputTokens,
    hostModelRoster: params.hostModelRoster,
    hostModelId: params.hostModelId,
  });
  const taskGraph = resolveDispatchTaskGraph(bundle, orderedTasks);
  let packets = buildReviewPacketsFromPartition(orderedTasks, {
    graph: taskGraph,
    contextTokenBudget: dispatchPool.contextBudgetTokens,
    riskMassBudget: sessionConfig.dispatch?.risk_mass_budget,
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex,
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
    const taskSections = buildTaskSections(packetTasks, lensDefs, lineIndex);
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
        write_paths: packetWritePaths,
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

  const perPacketTokens = plan.map((p) => p.complexity.estimated_tokens);
  // Size the dispatch just-in-time against the partitioned packet layout (one
  // token estimate per emitted packet) and the host pool resolved above, rather
  // than a preset wave size. `parallel_workers` is no longer the ambition — it
  // is folded into hostConcurrencyLimit as a ceiling. Today there is a single
  // pool (the conversation host's subagents); a heterogeneous provider pool
  // slots in here without changing the call.
  const { dispatchQuotaPath, waveSchedule, dispatchCapacity } = await finalizeDispatchQuota({
    runId,
    runDir,
    sessionConfig,
    pools: dispatchPool.pools,
    hostModel: dispatchPool.hostModel,
    perPacketTokens,
    hostModelRoster: params.hostModelRoster,
    tierBudgets: dispatchPool.tierBudgets,
  });

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
  };
  await writeJsonFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), activeDispatch);

  // FINDING-012: pure-arithmetic fan-out summary the loader can gate on.
  const fanout = computeDispatchFanout({
    agentCount: plan.length,
    maxConcurrent: dispatchCapacity.total_slots,
    confirmThreshold: sessionConfig.dispatch?.confirm_threshold,
  });

  return {
    run_id: runId,
    dispatch_plan_path: dispatchPlanPath,
    dispatch_quota_path: dispatchQuotaPath,
    packet_count: plan.length,
    task_count: orderedTasks.length,
    skipped_task_count: priorResultTaskIds.size,
    max_concurrent_agents: dispatchCapacity.total_slots,
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
  };
}
