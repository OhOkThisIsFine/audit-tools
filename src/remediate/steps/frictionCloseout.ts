// sites-pinned: tests/remediate/friction-capture-closeout.test.ts
import {
  decideFrictionTriage,
  buildFrictionTriageBlock,
  type FrictionTriageDecision,
} from "audit-tools/shared";
import type { RemediationState } from "../state/store.js";
import type { RemediationStep } from "./types.js";
import { writeCurrentStep } from "./stepWriter.js";

/**
 * The run's friction-record key: the plan id, or `null` when there is no plan.
 *
 * There is DELIBERATELY no fallback key. A fallback ("run") is a path every
 * planless state shares, and `decideFrictionTriage` MATERIALIZES the record it
 * is handed — so a planless caller could MINT a fresh empty record under it,
 * which the close gate then blocks on. That is the 2026-08-24 defect exactly.
 *
 * The key is therefore the plan id or nothing, and a caller handed `null` has
 * no walk to key: the walk ran before the close archived the plan-keyed record,
 * and the plan is where its identity came from.
 */
export function stateRunId(state: RemediationState | null): string | null {
  return state?.plan?.plan_id ?? null;
}

/**
 * The run key for a caller holding a LOADED state that must carry a plan id —
 * the host-handoff/ingest paths, whose contracts declare `run_id: string`.
 *
 * It throws rather than inventing a key: an absent plan id there is a
 * reachable-but-unexpected state, and silently falling back would mint a
 * shared path exactly as the fallback key did. Callers that can legitimately
 * hold a planless state use {@link stateRunId} and handle the `null`.
 */
export function requireStateRunId(state: RemediationState): string {
  const runId = stateRunId(state);
  if (!runId) {
    throw new Error("remediate: a loaded state with no plan id cannot name a run");
  }
  return runId;
}

/**
 * Render the friction-TRIAGE step.
 *
 * It runs under the run's plan-keyed record — the record the
 * decision just materialized — and so the run's identity in that path is the
 * plan id, not a fallback. The step is a `closing`-phase gate: `next-step`
 * re-decides the same walk on the next call, and only a disposed walk lets the
 * close proceed.
 */
export async function buildFrictionWalkStep(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  triage: FrictionTriageDecision,
): Promise<RemediationStep> {
  return writeCurrentStep({
    stepKind: "close_run",
    status: "ready",
    runId: requireStateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `# Remediation Run Friction Triage\n\nComplete the friction close-out walk before the run may close.\n${buildFrictionTriageBlock(triage)}`,
    allowedCommands: [],
    stopCondition:
      "Complete friction triage (write dispositions and open_observations), then call next-step again.",
    artifactPaths: { friction_record: triage.recordPath },
  });
}

/**
 * The terminal friction-TRIAGE close-out for the remediate half. Thin delegation to
 * the single-sourced `decideFrictionTriage` (`audit-tools/shared`) — the exact analog
 * of audit-code's `decideAuditFrictionCloseout`, so the triage shape, disposition
 * vocabulary, blocking semantics, and close-out logic cannot drift between the two
 * halves. Drops the former false-green (an empty up-front record no longer satisfies):
 * the blocking triage stays unsatisfied ("dispose") until every captured mechanical
 * event AND every surfaced agent-feedback reflection carries a disposition; an empty
 * set (zero events AND zero reflections) is trivially "disposed". Keyed only off
 * `(artifactsDir, runId)`; never coupled to any repo's backlog doc.
 *
 * A state with NO plan id can name no run, and since the decision MATERIALIZES
 * the record it keys, guessing a key there would mint one. It returns `null`
 * instead — "there is no run here to close out", which is the truthful answer
 * for a state whose plan is gone. Callers that hold the run's plan get a
 * decision; callers past the run boundary get nothing to render.
 */
export async function decideRemediateFrictionCloseout(
  artifactsDir: string,
  state: RemediationState | null,
): Promise<FrictionTriageDecision | null> {
  const runId = stateRunId(state);
  if (!runId) return null;
  return decideFrictionTriage(artifactsDir, runId, "remediate-code");
}
