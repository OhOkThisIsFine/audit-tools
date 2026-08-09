import type { HostModelRosterEntry, AuditorDescriptor } from "audit-tools/shared";
import { resolveSessionConfig, renderHostWallExplanation } from "audit-tools/shared";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { writeCurrentStep } from "./steps.js";
import {
  mergeAndIngestCommand,
  nextStepCommand,
  renderDispatchReviewPrompt,
} from "./prompts.js";
import { prepareDispatchArtifacts } from "./dispatch.js";
import { packageRoot } from "./paths.js";

// Renders the actionable semantic-review step and writes
// steps/current-step.json, so the backend produces the actionable step itself
// rather than handing the host a second command.
//
// ALWAYS-MATERIALIZED (design resolution 2, 2026-08-05): there is no capability
// branch here. Every host — subagent-capable or not — receives the SAME
// materialized dispatch step (packet prompt files on disk, dispatch plan in
// artifact_paths) with a capability-neutral prompt; a host with no subagent
// facility executes the packets sequentially itself. A handshake-less host is
// sized degenerately (one task per packet, no fit claim) rather than refused —
// see `buildDispatchPool`. The retired `single_task_fallback` step kind was
// this branch's other arm; the smoke-flow ambiguity it caused (a capable host
// silently landing on the fallback) is structurally gone with it.
//
// When selectedExecutor is 'rolling_dispatch_executor', uses the rolling
// dispatch prompt (inline AuditResult[] emit, no submit-packet shell command).
export async function renderSemanticReviewStep(params: {
  root: string;
  artifactsDir: string;
  activeReviewRun: ActiveReviewRun;
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
   * G2: the RESOLVED per-auditor descriptor for this invocation (the same forward
   * descriptor `nextStepCommand` rides on continue-commands) — its `self.provider` /
   * launch blocks + `sources[]` are resolved over the disk-loaded repo INTENT below
   * (`resolveSessionConfig`) so the host-review dispatch pool/provider come from the
   * handshake, never the repo config. This descriptor param is why `persistHostProvider`
   * is retired: the driver's provider rides here, not a disk re-read
   * (spec/unified-dispatch-worker-model.md, [[capability-is-per-auditor-not-per-audit]]).
   */
  descriptor: AuditorDescriptor;
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

  // Fail closed: an invalid/tampered session-config must abort the step, never
  // silently degrade to an empty (permissive) default. `loadSessionConfig`
  // throws on a config that fails validation (e.g. a spoofed provider or a
  // command-injection-shaped provider command); swallowing that here would let
  // the dispatch path run against an attacker-influenced config. Matches every
  // sibling caller (advanceAuditCommand/nextStepCommand/prepareDispatchCommand/
  // quotaCommand), which all let the error propagate.
  // G2: resolve the per-auditor descriptor over the freshly-loaded (and re-validated,
  // fail-closed) repo INTENT, so the host-review dispatch provider/pool below read the
  // descriptor's `self.provider` + `sources[]`, never the repo config's dispatch fields.
  const sessionConfig = resolveSessionConfig(
    await loadSessionConfig(artifactsDir),
    params.descriptor,
  );
  // The host owns provider selection, failover, quota, and
  // concurrency. Use the non-LLM bookkeeping identity only to let the shared
  // packet sizer apply the host handshake; never auto-resolve or instantiate a
  // second provider here (especially not Codex).
  const providerName = "worker-command" as const;
  const dispatch = await prepareDispatchArtifacts({
    packageRoot,
    runId: activeReviewRun.run_id,
    artifactsDir,
    root,
    sessionConfig,
    providerName,
    hostModel: sessionConfig.block_quota?.host_model ?? null,
    queryLimits: undefined,
    hostActiveSubagentLimit: params.hostMaxActiveSubagents,
    hostContextTokens: params.hostContextTokens,
    hostOutputTokens: params.hostOutputTokens,
    hostModelRoster: params.hostModelRoster,
    hostModelId: params.hostModelId,
    inProcessMadeProgress: params.inProcessMadeProgress,
    // The conversation host owns execution, quota, and concurrency.
    // audit-tools still packetizes and records the plan, but must not reserve a
    // host lease or turn its cold-start probe into a host-facing pause/cap.
    grantLeases: false,
    hostOwnedDispatch: true,
    recordAttemptedGrant: true,
  });
  const mergeCommand = mergeAndIngestCommand(artifactsDir, activeReviewRun.run_id);
  // The current driver's RESOLVED descriptor rides the continue-command so a bare
  // re-invocation preserves this invocation's capability + provider + sources instead
  // of falling back to the stored config (auditor-agnostic robustness — the founding-bug
  // fix). It is the same descriptor resolved over intent above, so what dispatched and
  // what a resume re-resolves cannot drift.
  const hostDescriptor: AuditorDescriptor = params.descriptor;
  const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);

  // Increment B — host-path quota wall. When admission granted zero OR a cooldown is
  // active, `prepareDispatchArtifacts` recorded the resumable pause on the run's
  // active-dispatch state; emit a resumable pause step (its own producer, kept separate
  // from remediate's `quota_paused` terminal per the non-unification decision) instead
  // of a dispatch step. Re-running next-step re-evaluates admission against a fresh
  // snapshot — a genuine reset clears the wall and resumes; a livelock has already
  // recorded the partial-completion terminal, so re-running routes to synthesis.
  if (dispatch.host_pause) {
    const { earliestResetAt, livelocked, strandedCount, emptyGrantCause, bindingWindow, perPacketCost } =
      dispatch.host_pause;
    const resetClause = earliestResetAt ? ` (resets at ${earliestResetAt})` : "";
    const wallExplain = livelocked
      ? ""
      : renderHostWallExplanation(bindingWindow, perPacketCost);
    // Honest wall (unified-routing step E / item C): "exhausted" is claimed ONLY for a
    // classified budget wall. A cap_reached zero-grant is transient ledger contention;
    // a no_capable_pool zero-grant is a structural fit failure that waiting cannot
    // clear. The old blanket message labeled a ~56%-headroom host "exhausted" with no
    // explanation (2026-07-17 dogfood).
    const wallSummary =
      emptyGrantCause === "cap_reached"
        ? `Host in-flight cap fully held (concurrent wave/admitter); ${strandedCount} review packet(s) paused, frees shortly.`
        : emptyGrantCause === "no_capable_pool"
          ? `No available pool holds this wave's packets (window/capability mismatch); ${strandedCount} packet(s) paused.`
          : `Provider quota wall${resetClause}; ${strandedCount} review packet(s) paused, resumable.`;
    const wallPrompt =
      emptyGrantCause === "cap_reached"
        ? `The host's in-flight dispatch cap is fully held — most likely a concurrent wave or a second admitter ` +
          `on the same account — so no new packets were granted this pass. ${strandedCount} packet(s) remain ` +
          `pending. This frees in seconds-to-minutes as in-flight work lands; re-run \`next-step\` shortly.`
        : emptyGrantCause === "no_capable_pool"
          ? `No available pool can hold this wave's packets: every blocked packet exceeds the context window (or ` +
            `capability) of every pool currently available — this is a fit mismatch, NOT a quota wall, and waiting ` +
            `for a reset will not clear it. ${strandedCount} packet(s) are pending.${wallExplain} Options: free a ` +
            `larger declared pool, or re-run \`next-step\` after upstream ` +
            `re-planning shrinks the packets.`
          : `The provider session limit is exhausted${resetClause}, so no review packets can be dispatched this ` +
            `pass. ${strandedCount} packet(s) remain pending.${wallExplain} This is a graceful, resumable pause — ` +
            `nothing was dispatched and no work was lost. Wait for the quota to reset, then run \`next-step\`; the ` +
            `tool re-checks the live quota and re-grants the pending packets when capacity returns.`;
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
          : wallSummary,
        pending_packets: strandedCount,
        granted_count: 0,
      },
      stopCondition: livelocked
        ? "Coverage bound reached at the quota wall — run next-step to synthesize the audit on partial coverage."
        : emptyGrantCause === "no_capable_pool"
          ? `No available pool fits this wave's packets.${wallExplain} Free a larger pool or let re-planning shrink the packets, then run next-step.`
          : `Provider quota is at its wall${resetClause}.${wallExplain} Wait for the reset, then run next-step to resume — the tool re-grants automatically when capacity returns.`,
      repoRoot: root,
      artifactPaths: {
        dispatch_quota: dispatch.dispatch_quota_path,
        pending_audit_tasks: activeReviewRun.pending_audit_tasks_path ?? null,
      },
      prompt: livelocked
        ? `The provider session limit stayed at its wall across repeated attempts, so the audit is giving up ` +
          `on ${strandedCount} unreviewed packet(s) and will synthesize on the coverage it has. Run \`next-step\` to continue to synthesis.`
        : wallPrompt,
    });
  }

  // Every packet in this host-owned path is emitted. There is no audit-tools
  // dispatch driver, cap, or admission subset for the host to interpret.
  return writeCurrentStep({
    artifactsDir,
    stepKind: "dispatch_review",
    status: "ready",
    runId: activeReviewRun.run_id,
    allowedCommands: [mergeCommand, continueCommand],
    allowedMcpTools: ["auditor_merge_and_ingest", "auditor_continue_audit"],
    progress: {
      summary:
        `Prepared ${dispatch.packet_count} review packet(s) covering ` +
        `${dispatch.task_count} task(s) for host dispatch` +
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
      "Dispatch every packet in the plan through the host/relay, run merge-and-ingest once, then run next-step.",
    repoRoot: root,
      artifactPaths: {
        dispatch_plan: dispatch.dispatch_plan_path,
        ...(dispatch.dispatch_quota_path
          ? { dispatch_quota: dispatch.dispatch_quota_path }
          : {}),
        dispatch_warnings: dispatch.dispatch_warnings_path,
      active_review_task: activeReviewRun.task_path,
      pending_audit_tasks: activeReviewRun.pending_audit_tasks_path ?? null,
    },
    prompt: renderDispatchReviewPrompt({
      root,
      artifactsDir,
      activeReviewRun,
      dispatchPlanPath: dispatch.dispatch_plan_path,
      // The quota artifact remains diagnostic, but its admission subset is not
      // an instruction: host/relay own the complete packet fan-out.
      dispatchQuotaPath: null,
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
