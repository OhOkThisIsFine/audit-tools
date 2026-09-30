// sites-pinned: tests/remediate/friction-capture-closeout.test.ts
import { dirname, join } from "node:path";
import { decideFrictionTriage, buildFrictionTriageBlock, type FrictionTriageDecision } from "audit-tools/shared";
import type { RemediationState } from "../state/store.js";
import { stateRunId, requireStateRunId } from "../state/runIdentity.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { RemediationStep } from "./types.js";

/**
 * The BLOCKING friction close-out step for a run whose walk is still owed.
 *
 * Emitted from `handleClosing` BEFORE the close touches disk, so the record the
 * host is told to write (`triage.recordPath`) is the plan-keyed one this very
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

export async function presentReportStep(
  root: string,
  artifactsDir: string,
  state: RemediationState | null,
): Promise<RemediationStep> {
  const reportPath = join(dirname(artifactsDir), "remediation-report.md");
  // Terminal friction-TRIAGE close-out, folded into present_report (single-sourced in
  // `audit-tools/shared`). MANDATORY + BLOCKING: stays "dispose" until every mechanical
  // event + reflection is disposed AND ≥1 open observation written. Never trivially
  // satisfied by an empty event set — the host must actively confirm the friction state.
  //
  // NO FRICTION RECORD IS EVER MINTED HERE. The decision was made — and the
  // record, under the run's plan-keyed path, was walked — before the close
  // archived it: `handleClosing` consults `decideRemediateFrictionCloseout`
  // against the LIVE state and short-circuits the close until the walk is
  // disposed. So ON THE GREEN PATH — the close ran to `complete`, archived the
  // run and removed the artifacts dir — the walk was already completed when the
  // close started, the plan-keyed record left with the other deliverables, and
  // all that is left is to RENDER the already-recorded walk for the host.
  //
  // NOT-GREEN IS THE OTHER HALF, and it is not "mint nothing": a close that
  // returned a non-`complete` state PRESERVES the artifacts dir, so the record
  // this step decides remains where the run wrote it — the caller reaches here
  // with the saved state still carrying its plan id, `decideFrictionTriage`
  // materializes (or re-reads) that same plan-keyed file, and the walk is
  // rendered from the record that is still in place.
  //
  // It is decided — and so materialized — ONLY when the state names a run. The
  // guard is the plan id, not the artifacts dir: the dir is not evidence of
  // anything here, since `decideNextStepLoop` mkdirs it unconditionally on entry,
  // `RunLogger.event` mkdirs it again for `run.log.jsonl`, and `writeJsonFile`
  // mkdirs any parent it is handed. So a dir-existence test is true on every
  // path, including a run whose state the close deleted. Guarding on the dir was
  // the 2026-08-24 defect: the decider ran with a null state, took a fallback
  // key, and because `decideFrictionTriage` MATERIALIZES the record it is given,
  // minted a fresh EMPTY record inside the directory the close had just deleted —
  // re-blocking the run on the record it had created. `stateRunId` now answers
  // `null` for a planless state and this call therefore decides nothing.
  //
  // A `complete` state reaching here is a run that never ran the close walk (a
  // re-delivery of an already-complete run, whose plan the state still carries),
  // so the walk is genuinely still owed and deciding it here is correct — it
  // renders as the blocking step. Only a planless state renders nothing.
  const triage = await decideRemediateFrictionCloseout(artifactsDir, state);
  const frictionBlock = triage ? buildFrictionTriageBlock(triage) : "";
  const isBlocked = triage?.action === "dispose";
  return writeCurrentStep({
    stepKind: "present_report",
    status: isBlocked ? "ready" : "complete",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: isBlocked
      ? `# Remediation Run Friction Triage\n\nComplete friction triage before presenting the report.\n${frictionBlock}`
      : `# Present Remediation Report\n\nRead \`${reportPath}\` and summarize the remediation outcome.\nMention resolved, ignored, and deemed-inappropriate counts plus the closing action.\n${frictionBlock}`,
    allowedCommands: [],
    stopCondition: isBlocked
      ? "Complete friction triage (write dispositions and open_observations), then call next-step again."
      : "Present the remediation report summary and stop.",
    artifactPaths: {
      final_report: reportPath,
      ...(triage ? { friction_record: triage.recordPath } : {}),
    },
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
