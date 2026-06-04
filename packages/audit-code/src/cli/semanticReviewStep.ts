import { join } from "node:path";
import type { SessionConfig } from "@audit-tools/shared";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { createFreshSessionProvider } from "../providers/index.js";
import { renderCommand } from "./args.js";
import { writeCurrentStep } from "./steps.js";
import {
  mergeAndIngestCommand,
  nextStepCommand,
  renderDispatchReviewPrompt,
  renderSingleTaskFallbackStepPrompt,
} from "./prompts.js";
import { prepareDispatchArtifacts } from "./dispatch.js";
import { packageRoot } from "./paths.js";

// Renders the actionable semantic-review step (packet dispatch or single-task
// fallback) and writes steps/current-step.json. Shared by next-step and
// run-to-completion so the backend produces the actionable step itself rather
// than handing the host a second command. Host dispatch capability is resolved
// by the caller (flag -> session config -> env -> default true) and is never
// required from the host to make progress.
export async function renderSemanticReviewStep(params: {
  root: string;
  artifactsDir: string;
  activeReviewRun: ActiveReviewRun;
  hostCanDispatch: boolean;
  hostMaxActiveSubagents: number | null;
  hostCanRestrictSubagentTools: boolean;
  hostCanSelectSubagentModel: boolean;
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

  const sessionConfig = await loadSessionConfig(artifactsDir).catch(
    () => ({} as SessionConfig),
  );
  const provider = createFreshSessionProvider(undefined, sessionConfig);
  const dispatch = await prepareDispatchArtifacts({
    packageRoot,
    runId: activeReviewRun.run_id,
    artifactsDir,
    root,
    sessionConfig,
    hostModel: sessionConfig.block_quota?.host_model ?? null,
    queryLimits: provider.queryLimits?.bind(provider),
    hostActiveSubagentLimit: params.hostMaxActiveSubagents,
  });
  const mergeCommand = mergeAndIngestCommand(artifactsDir, activeReviewRun.run_id);
  const continueCommand = nextStepCommand(root, artifactsDir);
  return writeCurrentStep({
    artifactsDir,
    stepKind: "dispatch_review",
    status: "ready",
    runId: activeReviewRun.run_id,
    allowedCommands: [mergeCommand, continueCommand],
    allowedMcpTools: ["auditor_merge_and_ingest", "auditor_continue_audit"],
    progress: {
      summary:
        (dispatch.phase === "canary"
          ? `Canary: dispatching only the top-priority packet (${dispatch.canary_packet_id}) before fan-out. `
          : "") +
        `Dispatching ${dispatch.packet_count} review packet(s) covering ` +
        `${dispatch.task_count} task(s) in waves of ${dispatch.wave_size}` +
        (dispatch.skipped_task_count > 0
          ? `; ${dispatch.skipped_task_count} task(s) already completed.`
          : "."),
      pending_packets: dispatch.packet_count,
      pending_tasks: dispatch.task_count,
      completed_tasks: dispatch.skipped_task_count,
      wave_size: dispatch.wave_size,
      phase: dispatch.phase,
      canary_packet_id: dispatch.canary_packet_id,
      agent_count: dispatch.agent_count,
      wave_count: dispatch.wave_count,
      confirmation_recommended: dispatch.confirmation_recommended,
      dispatch_summary: dispatch.dispatch_summary,
    },
    stopCondition:
      "Dispatch every packet, run merge-and-ingest once, then run next-step.",
    repoRoot: root,
    artifactPaths: {
      dispatch_plan: dispatch.dispatch_plan_path,
      dispatch_quota: dispatch.dispatch_quota_path,
      dispatch_warnings: dispatch.dispatch_warnings_path,
      active_review_task: activeReviewRun.task_path,
      pending_audit_tasks: activeReviewRun.pending_audit_tasks_path ?? null,
    },
    prompt: renderDispatchReviewPrompt({
      root,
      artifactsDir,
      activeReviewRun,
      dispatchPlanPath: dispatch.dispatch_plan_path,
      dispatchQuotaPath: dispatch.dispatch_quota_path,
      hostCanRestrictSubagentTools: params.hostCanRestrictSubagentTools,
      hostCanSelectSubagentModel: params.hostCanSelectSubagentModel,
      phase: dispatch.phase,
      canaryPacketId: dispatch.canary_packet_id,
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
