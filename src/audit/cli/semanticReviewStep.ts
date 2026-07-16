import { join } from "node:path";
import type { HostModelRosterEntry, ResolvedProviderName, HostDispatchInventory, AuditorDescriptor } from "audit-tools/shared";
import { applyDispatchInventory, classifyProvider, selectDispatchDriver, renderDispatchDriverInstruction, renderHostWallExplanation } from "audit-tools/shared";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { createFreshSessionProvider } from "../providers/index.js";
import { resolveHostDispatchProviderName } from "./rollingAuditDispatch.js";
import { renderCommand } from "./args.js";
import { writeCurrentStep } from "./steps.js";
import {
  mergeAndIngestCommand,
  nextStepCommand,
  renderDispatchReviewPrompt,
  renderRollingDispatchPrompt,
  renderSingleTaskFallbackStepPrompt,
} from "./prompts.js";
import { prepareDispatchArtifacts } from "./dispatch.js";
import { packageRoot } from "./paths.js";

// Renders the actionable semantic-review step (packet dispatch or single-task
// fallback) and writes steps/current-step.json, so the backend produces the
// actionable step itself rather than handing the host a second command. Host
// dispatch capability is resolved by the caller (flag -> session config -> env
// -> default true) and is never required from the host to make progress.
//
// When selectedExecutor is 'rolling_dispatch_executor', uses the rolling
// dispatch prompt (inline AuditResult[] emit, no submit-packet shell command).
export async function renderSemanticReviewStep(params: {
  root: string;
  artifactsDir: string;
  activeReviewRun: ActiveReviewRun;
  hostCanDispatch: boolean;
  hostMaxActiveSubagents: number | null;
  /** Context window the host reports for its dispatch model (handshake). */
  hostContextTokens?: number | null;
  /** Output cap the host reports for its dispatch model (handshake). */
  hostOutputTokens?: number | null;
  /** Ordered model roster (lowest rank first); outranks the scalar pair. */
  hostModelRoster?: HostModelRosterEntry[] | null;
  /** Opaque model identity for the quota key when no model name resolves. */
  hostModelId?: string | null;
  /**
   * 2a-ii: the per-auditor dispatch inventory reported this invocation
   * (`--host-inventory`). Overlaid onto the disk-loaded session-config below so the
   * host-review dispatch pool/provider come from the handshake, not the repo config
   * (spec/unified-dispatch-worker-model.md). `null`/absent ⇒ the repo config is used
   * unchanged (deprecated fallback).
   */
  inventory?: HostDispatchInventory | null;
  hostCanRestrictSubagentTools: boolean;
  hostCanSelectSubagentModel: boolean;
  /** Which executor selected this step; controls prompt variant. */
  selectedExecutor?: string | null;
  /**
   * D2: true when the in-process (NIM) partition ingested results earlier in this
   * next-step (hybrid path) — resets the host-complement wall-pass counter so steady
   * in-process progress never trips the livelock give-up.
   */
  inProcessMadeProgress?: boolean;
}): Promise<Awaited<ReturnType<typeof writeCurrentStep>>> {
  const { root, artifactsDir, activeReviewRun } = params;
  if (!params.hostCanDispatch) {
    const singleTaskPromptPath = join(
      artifactsDir,
      "dispatch",
      "current-single-task-prompt.md",
    );
    const workerCommand = renderCommand(activeReviewRun.worker_command);
    return writeCurrentStep({
      artifactsDir,
      stepKind: "single_task_fallback",
      status: "ready",
      runId: activeReviewRun.run_id,
      allowedCommands: [workerCommand],
      stopCondition:
        "Run the exact worker_command after one result, then stop without looping.",
      repoRoot: root,
      artifactPaths: {
        active_review_task: activeReviewRun.task_path,
        active_review_prompt: activeReviewRun.prompt_path,
        pending_audit_tasks: activeReviewRun.pending_audit_tasks_path ?? null,
        audit_results: activeReviewRun.audit_results_path,
        single_task_prompt: singleTaskPromptPath,
      },
      prompt: renderSingleTaskFallbackStepPrompt({
        singleTaskPromptPath,
        activeReviewRun,
      }),
      access: {
        read_paths: [singleTaskPromptPath],
        write_paths: [activeReviewRun.audit_results_path],
      },
    });
  }

  // Fail closed: an invalid/tampered session-config must abort the step, never
  // silently degrade to an empty (permissive) default. `loadSessionConfig`
  // throws on a config that fails validation (e.g. a spoofed provider or a
  // command-injection-shaped provider command); swallowing that here would let
  // the dispatch path run against an attacker-influenced config. Matches every
  // sibling caller (advanceAuditCommand/nextStepCommand/prepareDispatchCommand/
  // quotaCommand), which all let the error propagate.
  // 2a-ii: overlay the per-auditor handshake inventory onto the freshly-loaded
  // (and re-validated, fail-closed) repo config, so the host-review dispatch
  // provider/pool below read the inventory, not the repo's dispatch fields. Inert
  // (returns the disk config unchanged) when no `--host-inventory` was reported.
  const sessionConfig = applyDispatchInventory(
    await loadSessionConfig(artifactsDir),
    params.inventory,
  );
  // The host-review dispatch pool is keyed to the CURRENT driver's identity, never
  // an inherited headless-backend `sessionConfig.provider` (the founding capability-
  // inheritance bug): a run started under `provider: codex` and resumed by a Claude
  // host must size/charge the fan-out against the host's meter, not codex's. See
  // `resolveHostDispatchProviderName` ([[capability-is-per-auditor-not-per-audit]]).
  const providerName = resolveHostDispatchProviderName(sessionConfig);
  const provider = createFreshSessionProvider(providerName, sessionConfig);
  const dispatch = await prepareDispatchArtifacts({
    packageRoot,
    runId: activeReviewRun.run_id,
    artifactsDir,
    root,
    sessionConfig,
    providerName,
    hostModel: sessionConfig.block_quota?.host_model ?? null,
    queryLimits: provider.queryLimits?.bind(provider),
    hostActiveSubagentLimit: params.hostMaxActiveSubagents,
    hostContextTokens: params.hostContextTokens,
    hostOutputTokens: params.hostOutputTokens,
    hostModelRoster: params.hostModelRoster,
    hostModelId: params.hostModelId,
    inProcessMadeProgress: params.inProcessMadeProgress,
  });
  const mergeCommand = mergeAndIngestCommand(artifactsDir, activeReviewRun.run_id);
  // The current driver's handshake rides the continue-command so a bare re-invocation
  // preserves this invocation's capability instead of falling back to the stored
  // session config (auditor-agnostic robustness — the founding-bug robustness fix).
  const hostDescriptor: AuditorDescriptor = {
    self: {
      can_dispatch_subagents: params.hostCanDispatch,
      ...(params.hostCanRestrictSubagentTools ? { can_restrict_subagent_tools: true } : {}),
      ...(params.hostCanSelectSubagentModel ? { can_select_subagent_model: true } : {}),
      ...(params.hostMaxActiveSubagents != null ? { max_active_subagents: params.hostMaxActiveSubagents } : {}),
      ...(params.hostContextTokens != null ? { context_tokens: params.hostContextTokens } : {}),
      ...(params.hostOutputTokens != null ? { output_tokens: params.hostOutputTokens } : {}),
      ...(params.hostModelRoster != null ? { roster: params.hostModelRoster } : {}),
      ...(params.hostModelId != null ? { model_id: params.hostModelId } : {}),
    },
    // 2a-ii: carry the dispatch inventory onto the continue-command this step emits, so
    // a bare resume preserves this driver's inventory instead of silently dropping it.
    inventory: params.inventory ?? null,
  };
  const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);

  // Increment B — host-path quota wall. When admission granted zero OR a cooldown is
  // active, `prepareDispatchArtifacts` recorded the resumable pause on the run's
  // active-dispatch state; emit a resumable pause step (its own producer, kept separate
  // from remediate's `quota_paused` terminal per the non-unification decision) instead
  // of a dispatch step. Re-running next-step re-evaluates admission against a fresh
  // snapshot — a genuine reset clears the wall and resumes; a livelock has already
  // recorded the partial-completion terminal, so re-running routes to synthesis.
  if (dispatch.host_pause) {
    const { earliestResetAt, livelocked, strandedCount, bindingWindow, perPacketCost } =
      dispatch.host_pause;
    const resetClause = earliestResetAt ? ` (resets at ${earliestResetAt})` : "";
    const wallExplain = livelocked
      ? ""
      : renderHostWallExplanation(bindingWindow, perPacketCost);
    return writeCurrentStep({
      artifactsDir,
      stepKind: "blocked",
      status: "ready",
      runId: activeReviewRun.run_id,
      allowedCommands: [continueCommand],
      allowedMcpTools: ["auditor_continue_audit"],
      progress: {
        summary: livelocked
          ? `Provider quota wall persisted past the coverage bound; ${strandedCount} packet(s) left unreviewed — the audit will synthesize on partial coverage.`
          : `Provider quota wall${resetClause}; ${strandedCount} review packet(s) paused, resumable.`,
        pending_packets: strandedCount,
        granted_count: 0,
      },
      stopCondition: livelocked
        ? "Coverage bound reached at the quota wall — run next-step to synthesize the audit on partial coverage."
        : `Provider quota is at its wall${resetClause}.${wallExplain} Wait for the reset, then run next-step to resume — the tool re-grants automatically when capacity returns.`,
      repoRoot: root,
      artifactPaths: {
        dispatch_quota: dispatch.dispatch_quota_path,
        pending_audit_tasks: activeReviewRun.pending_audit_tasks_path ?? null,
      },
      prompt: livelocked
        ? `The provider session limit stayed at its wall across repeated attempts, so the audit is giving up ` +
          `on ${strandedCount} unreviewed packet(s) and will synthesize on the coverage it has. Run \`next-step\` to continue to synthesis.`
        : `The provider session limit is exhausted${resetClause}, so no review packets can be dispatched this ` +
          `pass. ${strandedCount} packet(s) remain pending.${wallExplain} This is a graceful, resumable pause — ` +
          `nothing was dispatched and no work was lost. Wait for the quota to reset, then run \`next-step\`; the ` +
          `tool re-checks the live quota and re-grants the pending packets when capacity returns.`,
    });
  }

  // S-BROKER-WIRING: choose the dispatch DRIVER off the single classification +
  // the live packet frontier / concurrency cap, and render the matching host
  // instruction. Only meaningful when there is a quota (a real fan-out); the
  // no-quota path launches one subagent per entry with no rolling loop.
  const hostProvider: ResolvedProviderName = providerName;
  const driverInstruction = dispatch.dispatch_quota_path
    ? renderDispatchDriverInstruction(
        selectDispatchDriver({
          classification: classifyProvider(hostProvider),
          eligibleItemCount: dispatch.packet_count,
          // The admission width is the granted set size (emergent), not a computed
          // concurrency number; the driver is chosen off how many are granted now.
          slots: dispatch.granted_count,
        }),
        "the granted set (`admission.granted_packet_ids`)",
      )
    : undefined;
  return writeCurrentStep({
    artifactsDir,
    stepKind: "dispatch_review",
    status: "ready",
    runId: activeReviewRun.run_id,
    allowedCommands: [mergeCommand, continueCommand],
    allowedMcpTools: ["auditor_merge_and_ingest", "auditor_continue_audit"],
    progress: {
      summary:
        `Granting ${dispatch.granted_count} of ${dispatch.packet_count} review packet(s) covering ` +
        `${dispatch.task_count} task(s) this pass` +
        (dispatch.declared_cap != null ? ` (≤${dispatch.declared_cap} in flight)` : "") +
        (dispatch.skipped_task_count > 0
          ? `; ${dispatch.skipped_task_count} task(s) already completed.`
          : "."),
      pending_packets: dispatch.packet_count,
      pending_tasks: dispatch.task_count,
      completed_tasks: dispatch.skipped_task_count,
      granted_count: dispatch.granted_count,
      declared_cap: dispatch.declared_cap,
      agent_count: dispatch.agent_count,
      confirmation_recommended: dispatch.confirmation_recommended,
      dispatch_summary: dispatch.dispatch_summary,
    },
    stopCondition:
      "Dispatch exactly the granted packets, run merge-and-ingest once, then run next-step for the next grant.",
    repoRoot: root,
    artifactPaths: {
      dispatch_plan: dispatch.dispatch_plan_path,
      dispatch_quota: dispatch.dispatch_quota_path,
      dispatch_warnings: dispatch.dispatch_warnings_path,
      active_review_task: activeReviewRun.task_path,
      pending_audit_tasks: activeReviewRun.pending_audit_tasks_path ?? null,
    },
    prompt: params.selectedExecutor === "rolling_dispatch_executor"
      ? renderRollingDispatchPrompt({
          root,
          artifactsDir,
          runId: activeReviewRun.run_id,
          dispatchPlanPath: dispatch.dispatch_plan_path,
          dispatchQuotaPath: dispatch.dispatch_quota_path,
          hostCanRestrictSubagentTools: params.hostCanRestrictSubagentTools,
          hostCanSelectSubagentModel: params.hostCanSelectSubagentModel,
          driverInstruction,
          hostDescriptor,
        })
      : renderDispatchReviewPrompt({
          root,
          artifactsDir,
          activeReviewRun,
          dispatchPlanPath: dispatch.dispatch_plan_path,
          dispatchQuotaPath: dispatch.dispatch_quota_path,
          hostCanRestrictSubagentTools: params.hostCanRestrictSubagentTools,
          hostCanSelectSubagentModel: params.hostCanSelectSubagentModel,
          driverInstruction,
          hostDescriptor,
        }),
    access: {
      read_paths: [
        dispatch.dispatch_plan_path,
        ...(dispatch.dispatch_quota_path ? [dispatch.dispatch_quota_path] : []),
      ],
      write_paths: [],
    },
  });
}
