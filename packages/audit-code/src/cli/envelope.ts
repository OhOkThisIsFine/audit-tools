import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditState } from "../types/auditState.js";
import { LOCAL_SUBPROCESS_PROVIDER_NAME } from "../providers/constants.js";
import {
  buildAuditCodeHandoff,
  writeAuditCodeHandoffArtifacts,
  type AuditCodeHandoff,
  type ActiveReviewRun,
} from "../supervisor/operatorHandoff.js";

export const ADVANCE_AUDIT_CONTRACT_VERSION = "audit-code/v1alpha1";

export function buildEnvelope(params: {
  audit_state: unknown;
  selected_obligation: string | null;
  selected_executor: string | null;
  progress_made: boolean;
  artifacts_written: string[];
  progress_summary: string;
  next_likely_step: string | null;
  handoff: AuditCodeHandoff;
}) {
  return {
    contract_version: ADVANCE_AUDIT_CONTRACT_VERSION,
    audit_state: params.audit_state,
    selected_obligation: params.selected_obligation,
    selected_executor: params.selected_executor,
    progress_made: params.progress_made,
    artifacts_written: params.artifacts_written,
    progress_summary: params.progress_summary,
    next_likely_step: params.next_likely_step,
    handoff: params.handoff,
  };
}

export async function emitEnvelope(params: {
  root: string;
  artifactsDir: string;
  bundle: ArtifactBundle;
  audit_state: AuditState;
  selected_obligation: string | null;
  selected_executor: string | null;
  progress_made: boolean;
  artifacts_written: string[];
  progress_summary: string;
  next_likely_step: string | null;
  providerName?: string | null;
  isConfigError?: boolean;
  activeReviewRun?: ActiveReviewRun;
}): Promise<void> {
  const handoff = buildAuditCodeHandoff({
    root: params.root,
    artifactsDir: params.artifactsDir,
    state: params.audit_state,
    bundle: params.bundle,
    providerName: params.providerName,
    progressSummary: params.progress_summary,
    isConfigError: params.isConfigError,
    activeReviewRun: params.activeReviewRun,
  });
  await writeAuditCodeHandoffArtifacts(handoff);
  console.log(
    JSON.stringify(
      buildEnvelope({
        audit_state: params.audit_state,
        selected_obligation: params.selected_obligation,
        selected_executor: params.selected_executor,
        progress_made: params.progress_made,
        artifacts_written: params.artifacts_written,
        progress_summary: params.progress_summary,
        next_likely_step: params.next_likely_step,
        handoff,
      }),
      null,
      2,
    ),
  );
}

export function buildManualReviewBlocker(providerName: string): string {
  return providerName === LOCAL_SUBPROCESS_PROVIDER_NAME
    ? "Ready for LLM semantic review. If the host exposes a callable subagent tool, prepare dispatch and fan out packets. " +
      "If not, use single-task fallback: review only the first pending task, write one AuditResult to the run audit-results path, execute worker_command, then stop."
    : "Audit blocked: waiting for manual audit results or interactive provider configuration.";
}

export function shouldRunInlineExecutor(selectedExecutor: string | null): boolean {
  return selectedExecutor !== null && selectedExecutor !== "agent";
}

export function buildBlockedAuditState(params: {
  state: AuditState;
  obligationId: string | null;
  executor: string | null;
  blocker: string;
}): AuditState {
  return {
    ...params.state,
    status: "blocked",
    last_executor: params.executor ?? params.state.last_executor,
    last_obligation: params.obligationId ?? params.state.last_obligation,
    blockers: [...new Set([...(params.state.blockers ?? []), params.blocker])],
    obligations: params.state.obligations.map((item) =>
      item.id === params.obligationId
        ? {
            ...item,
            state: "blocked",
            reason: params.blocker,
          }
        : item,
    ),
  };
}
