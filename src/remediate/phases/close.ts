import { assertApprovedRuntimePlan, RemediationPlanAuthorityError } from "../contractPipeline/runtimePlanAuthority.js";
import { executionPlanContextIssues } from "../contractPipeline/executionPlan.js";
import { contentSha256 } from "../../shared/submission/hostHandoffCore.js";
import { AcceptedConformanceReviewSchema, ContractReviewOutcomeSchema, type ContractReviewOutcome } from "../../shared/types/reviewIndependence.js";
import { readContractReviewOutcomes } from "./closeReviewProvenance.js";
// sites-pinned: tests/remediate/landing-gates-close.test.ts, tests/remediate/phase-close.test.ts
//   The landing-gate close leg (run once per declared gate, folded into
//   `fullyGreen`, rendered in the report) is pinned by the landing-gates suite;
//   the existing close behaviour around it is pinned by phase-close.
import { RemediationState } from "../state/store.js";
import { OrchestratorOptions } from "../types/options.js";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  AGENT_FEEDBACK_FILENAME,
  normalizeRepoPath,
  parseReflectionsNdjson,
  readOptionalJsonFile,
  readOptionalTextFile,
  renderProcessFeedbackSection,
  reportDiscardedReflections,
  stagedAndUntracked,
  writeJsonFile,
  writeTextFile,
  RemediationOutcomeStatusSchema,
  REMEDIATION_OUTCOMES_CONTRACT_VERSION,
  countBy,
  commandLeavesDeclaredShape,
  parseCommandString,
  runTrackedAsync,
  compareCodeUnits,
  runAdmittedProjectTestCommand,
  runAdmittedProjectE2eCommand,
  readSubmissionLedger,
  assertValidRemediationOutcomesReport,
} from "audit-tools/shared";
import type {
  AgentReflection,
  RemediationOutcome,
  RemediationOutcomeStatus,
  RemediationOutcomesReport,
  RunLogger,
  VerificationReport,
  FindingVerificationTrace,
  VerificationTraceEntry,
} from "audit-tools/shared";
import { CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION } from "audit-tools/shared";
import { FAILURE_OUTPUT_TAIL_CHARS } from "./constants.js";
import { verifyAnalyzerLeads } from "./closeVerifyAnalyzerLeads.js";
import {
  verifyLandingGates,
  type LandingGateVerifyOutcome,
} from "./closeVerifyLandingGates.js";
import {
  bindSourceVerification,
  verifyHeadEvidenceAgainstFindings,
  type HeadEvidenceOutcome,
} from "./closeVerifyHeadEvidence.js";
import type { ClosingAction } from "audit-tools/shared";
import type {
  CoverageLedgerEntry,
  Finding,
  NeverPlannedDropReason,
  OutcomeCoverageEntry,
  OutcomeCoverageLedger,
  RemediationItemState,
  RemediationOutcomeFinalStatus,
  RemediationOutcomeItem,
} from "../state/types.js";
import { intakePaths, readSourceManifest, type IntakeSourceManifest } from "../intake.js";
import { isAuditFindingsReport } from "./plan.js";
import {
  dispositionToOutcomeStatus,
  isSkipStatus,
  isTerminalStatus,
  isUnsuccessfulEndStatus,
  isVerifiedCompleteStatus,
  requiresVerificationEvidence,
  resolveDisposition,
} from "../state/itemStatus.js";
// Brand-new exports of `src/shared/types/remediationOutcome.ts` (CDC-25/
// CDC-28), not yet re-exported through the `audit-tools/shared` barrel
// (outside this module's file_scope and this work item's allowed_files) — see
// the identical note in `src/remediate/state/types.ts`.
import {
  ABSENT_FINAL_GATE_REPORT,
  FinalGateReportSchema,
  NO_RECOVERY,
  carriesGateVerdict,
  isCompleteEvidence,
  mechanismContradictsOutcome,
  missingEvidenceParts,
  type Evidence,
  type FinalGateReport,
  type RecoveryMark,
  type RunRecovery,
} from "../../shared/types/remediationOutcome.js";
// The gate record's PATH is single-sourced by the module that writes it. Leaf
// import (finalGate.ts imports only gateCommands.ts + shared), so this adds no
// cycle — and the alternative, a second `"final-gate-outcome.json"` literal
// here, is exactly the drift the layout registry exists to prevent.
import { finalGateOutcomePath } from "../steps/finalGate.js";
import { runCloseAcceptance, type CombinedTestResult } from "./closeAcceptance.js";

// Derived from the single source so the key list can never drift from the
// RemediationOutcomeStatus contract (A6).
const OUTCOME_KEYS: RemediationOutcomeStatus[] = [
  ...RemediationOutcomeStatusSchema.options,
];

/**
 * Retry-oriented final status per outcome (see RemediationOutcomeFinalStatus).
 * `verified_already_fixed` (CDC-25) joins `resolved`/`verified_no_change`
 * under `fixed` — the code was already correct at HEAD, requiring no diff, the
 * same shape as a no-change fix. `refuted` joins `inappropriate` under
 * `skipped` — investigation determined the finding is not a real problem, so
 * like a deemed-inappropriate finding it needs no retry; the substantive "why"
 * for both new members lives in the outcome's `evidence` triple, not in this
 * coarse four-value retry bucket.
 */
const FINAL_STATUS_BY_OUTCOME: Record<
  RemediationOutcomeStatus,
  RemediationOutcomeFinalStatus
> = {
  resolved: "fixed",
  verified_no_change: "fixed",
  inappropriate: "skipped",
  ignored: "ignored",
  blocked: "failed",
  pending: "pending",
  deferred: "deferred",
  verified_already_fixed: "fixed",
  refuted: "skipped",
};

// Skipped and ignored outcomes must always carry a non-empty reason in the
// outcomes contract; these defaults cover items whose state lost the rationale.
const DEFAULT_REASON_BY_OUTCOME: Partial<
  Record<RemediationOutcomeStatus, string>
> = {
  inappropriate: "Deemed inappropriate during remediation.",
  ignored: "Ignored by user.",
};

/**
 * How this run was recovered, as read from the submission ledger at close.
 *
 * THE LEDGER'S READER. Every append site writes the ledger; until this existed,
 * no CLOSE-phase surface read it, so a run repaired through a recovery verb — a
 * lower evidence bar than the normal lane's — produced a completion report
 * byte-identical to a clean one. The facts were durable and unreadable at the
 * same time.
 *
 * Read once, here, and THREADED into both the outcomes contract and the
 * markdown render rather than re-read by either: {@link
 * cleanupTempBranchesAndArtifacts} deletes the artifacts directory (and the
 * ledger under it) on a green close, so a builder that re-read would be reading
 * a deleted file.
 *
 * Scoped to this run by `state.plan.plan_id` — the SAME id the remediate host
 * handoff mints its ledger events under (`stateRunId` in
 * `src/remediate/steps/nextStep.ts`), so the scope is the producer's own
 * identity rather than a second spelling of it. `submissions/` sits under the
 * artifacts directory and is removed with it on a green close, but a preserved
 * (non-green) directory may outlive a later run, and another run's recovery
 * must never mark this one.
 *
 * An absent ledger reads as NO recovery rather than throwing: this is
 * bookkeeping on a reporting path, and a run that recorded no ledger recorded
 * no drift. A READ FAILURE is not laundered into that same empty answer —
 * `readSubmissionLedger` documents that it never throws, and the `catch` here
 * exists only so that a future change to that guarantee cannot turn an
 * unreadable ledger into a clean-looking run.
 */
export async function readRunRecoveryFacts(
  artifactsDir: string,
  state: RemediationState | null,
): Promise<RunRecovery> {
  const runId = state?.plan?.plan_id;
  let ledger;
  try {
    ledger = await readSubmissionLedger(artifactsDir);
  } catch {
    return { ...NO_RECOVERY };
  }
  const marksFor = (kind: RecoveryMark["kind"]): RecoveryMark[] =>
    ledger
      .filter(
        (event) => event.kind === kind && (runId === undefined || event.run_id === runId),
      )
      .map((event) => ({
        kind,
        submission_id: event.submission_id,
        lane: event.lane,
        ...(event.issue_code ? { issue_code: event.issue_code } : {}),
        recorded_at: event.recorded_at,
      }));
  return {
    // Arrival order is the ledger's own and the filters above preserve it.
    recovered_by_hand: marksFor("recovered_by_hand"),
    accepted_via_recovery: marksFor("accepted_via_recovery"),
    // A per-read count: `dropped` names lines this read could not parse, and no
    // run scoping applies to it. Carried so a surface cannot report a run
    // cleaner than the ledger actually was.
    dropped_lines: ledger.dropped.length,
  };
}

/**
 * Phase 7B — capture one outcome per finding (lens, affected file types, how it
 * landed, rework count, closing status). Surface only: the auditor does not
 * consume this automatically.
 */
function closingStatusReason(closingResult: ClosingResult): string | undefined {
  if (closingResult.status === "skipped" && closingResult.action === "none") {
    return "closing action is 'none' — no commit/push/publish configured";
  }
  if (closingResult.status === "failed") {
    return `closing action '${closingResult.action}' failed`;
  }
  return undefined;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function durationBetweenMs(
  startedAt: string | undefined,
  completedAt: string | undefined,
): number | undefined {
  const started = parseTimestamp(startedAt);
  const completed = parseTimestamp(completedAt);
  if (started === undefined || completed === undefined || completed < started) {
    return undefined;
  }
  return completed - started;
}

/**
 * Read the run's tool-owned gate outcome for the report.
 *
 * The gate WRITES `final-gate-outcome.json` on every evaluation; until this
 * reader existed, nothing consumed it — so a scoped-out or suppressed run
 * produced a completion report byte-identical to one written after a green
 * floor, which is the whole defect the record was added to close. A record that
 * is missing, unreadable, or fails its schema degrades to
 * {@link ABSENT_FINAL_GATE_REPORT}: stated as absent, never as green.
 */
export async function readFinalGateReport(
  artifactsDir: string,
): Promise<FinalGateReport> {
  const raw = await readOptionalJsonFile<unknown>(
    finalGateOutcomePath(artifactsDir),
  ).catch(() => undefined);
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return ABSENT_FINAL_GATE_REPORT;
  }
  // The on-disk record carries its own `schema_version`; the REPORT field does
  // not (the outcomes contract has one of its own). Drop that key and keep the
  // schema `.strict()` for everything else, so an unknown field is still a
  // refusal rather than something that rides silently into the contract.
  const { schema_version: _recordVersion, ...body } = raw as Record<string, unknown>;
  const parsed = FinalGateReportSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ...ABSENT_FINAL_GATE_REPORT,
      reason:
        "a gate outcome record exists but does not match the outcome contract; " +
        "treated as no verdict",
    };
  }
  // Defense in depth against a hand-edited or older record: only a
  // verdict-bearing kind may carry a verdict — `executed` because a judge just
  // ran, `history` because one ruled on this exact tree content and the answer
  // cannot have changed. A not-run kind asserting `passed: true` is normalized
  // away here rather than reprinted into the report.
  return carriesGateVerdict(parsed.data.outcome)
    ? parsed.data
    : { ...parsed.data, passed: null, commands_run: 0 };
}

/**
 * Surface the read-at-HEAD evidence leg's verdicts. Recorded, never silent:
 * an item the leg DECLINED to determine is exactly the case a reader must be
 * able to tell apart from one it determined, so the reason is stated even
 * though the item's outcome is unchanged.
 *
 * The WITHHELD reason is the whole point of this function on a real run. The
 * leg's rule needs the two reads (the audit's commit `B` and HEAD), and no
 * audit artifact records `B` — so every candidate is withheld with that reason,
 * and an operator reading only stderr must not be left guessing whether the leg
 * ran and found nothing or never ran at all.
 */
function reportHeadEvidence(
  outcome: HeadEvidenceOutcome,
  runLogger: RunLogger | undefined,
): void {
  if (!outcome.ran) {
    if (outcome.withheld.length > 0) {
      console.warn(
        `Read-at-HEAD evidence leg did not run: ${
          outcome.head === null ? "no resolvable HEAD" : "no candidate items"
        }.`,
      );
    }
    return;
  }
  const determined = Object.values(outcome.recorded);
  for (const record of determined) {
    if (!record.determined) continue;
    console.log(
      `[head-evidence] ${record.finding_id}: ${record.disposition} (${record.evidence.file}:${record.evidence.line || "?"})`,
    );
  }
  for (const record of outcome.withheld) {
    console.warn(
      `[head-evidence] ${record.finding_id}: no determination recorded — ${
        record.determined ? "" : record.reason
      }`,
    );
  }
  if (determined.length > 0 || outcome.withheld.length > 0) {
    runLogger?.event({
      phase: "close",
      kind: "state",
      obligation: "closing",
      note:
        `Read-at-HEAD evidence leg: recorded ${determined.length} terminal disposition(s) ` +
        `against audit-read commit ${outcome.base ?? "(none recorded)"} and HEAD ${outcome.head}` +
        `${outcome.withheld.length > 0 ? `, withheld ${outcome.withheld.length}` : ""}.`,
    });
  }
}

export function buildRemediationOutcomesReport(
  state: RemediationState,
  closingResult: ClosingResult,
  // Defaults to ABSENT so every existing caller keeps compiling AND keeps
  // telling the truth: a caller that supplies no gate outcome is a run with no
  // gate outcome, which the contract now states outright.
  finalGate: FinalGateReport = ABSENT_FINAL_GATE_REPORT,
  // Same discipline one field over: a caller that supplies no recovery facts is
  // a caller that read no ledger, and the honest statement for that is the
  // empty set — never an omitted key, which a reader could not tell from a
  // release that did not record recovery at all.
  recovery: RunRecovery = NO_RECOVERY,
  contractReviews: readonly ContractReviewOutcome[] = [],
): RemediationOutcomesReport {
  const outcomes: RemediationOutcome[] = [];
  const closeReason = closingStatusReason(closingResult);
  const executionOutcomes = (state.plan?.units ?? []).map(unit => {
    const item = state.items?.[unit.id];
    return {
      unit_id: unit.id, title: unit.title, source_finding_ids: [...unit.source_finding_ids],
      status: item?.status ?? "pending",
      required_tests: [...unit.required_tests], evidence: [...(item?.host_result_evidence ?? [])],
      rework_count: item?.rework_count ?? 0,
      ...(item?.host_landed_commit ? {landed_commit:item.host_landed_commit} : {}),
      ...(item?.host_landed_files ? {landed_files:[...item.host_landed_files]} : {}),
      ...(item?.failure_reason ? { reason: item.failure_reason } : !item ? {reason:"No execution state was recorded for this reviewed unit."} : !isVerifiedCompleteStatus(item.status) && !isSkipStatus(item.status) ? {reason:`Execution unit remains ${item.status}.`} : {}),
      ...(item?.conformance_review ? { conformance_review: AcceptedConformanceReviewSchema.parse(item.conformance_review) } : {}),
      ...(item?.started_at ? { started_at: item.started_at } : {}),
      ...(item?.completed_at ? { completed_at: item.completed_at } : {}),
    };
  });
  let requestOutcome: RemediationOutcomesReport["request_outcome"];
  const requestDisposition = state.plan?.request_disposition;
  if (state.plan?.request || requestDisposition) {
    const units = state.plan?.units ?? [];
    const items = units.map(unit => state.items?.[unit.id]);
    const settled = items.length > 0 && items.every(item => item && (isVerifiedCompleteStatus(item.status) || isSkipStatus(item.status)));
    const skipped = items.filter(item => item && isSkipStatus(item.status));
    const status = requestDisposition?.status ??
      (items.some(item => !item || isUnsuccessfulEndStatus(item.status)) ? "blocked" :
       settled && skipped.length > 0 ? "ignored" : settled ? "resolved" : "pending");
    requestOutcome = {
      status,
      reason:requestDisposition?.reason ?? (status === "ignored"
        ? skipped.map(item => item!.failure_reason ?? "Owner declined this execution unit").join("; ")
        : status === "resolved" ? "All reviewed execution units were verified."
        : "The request still has unfinished execution work."),
      evidence:requestDisposition?.evidence ?? executionOutcomes.flatMap(unit => unit.evidence),
      unit_ids:units.map(unit => unit.id),
    };
  }
  const sourceFindings = new Map((state.plan?.findings ?? []).map(finding => [finding.id, finding]));
  for (const entry of state.plan_coverage?.entries ?? []) {
    const original = sourceFindings.get(entry.finding_id);
    if (entry.finding && original && contentSha256(entry.finding) !== contentSha256(original)) {
      throw new Error(`Conflicting original source payload for ${entry.finding_id}; refusing an ambiguous outcome.`);
    }
    if (entry.finding && !original) sourceFindings.set(entry.finding_id, entry.finding);
  }
  for (const finding of sourceFindings.values()) {
    const units = (state.plan?.units ?? []).filter(unit => unit.source_finding_ids.includes(finding.id));
    const linked = units.map(unit => state.items?.[unit.id]);
    const coverage = state.plan_coverage?.entries.find(entry => entry.finding_id === finding.id);
    const coverageDrop = coverage && DROP_REASON_BY_DISPOSITION[coverage.disposition];
    const settledWithOwnerSkip = linked.length > 0 && linked.every(item => item && (isVerifiedCompleteStatus(item.status) || isSkipStatus(item.status))) && linked.some(item => item && isSkipStatus(item.status));
    const unitOwnerDisposition = settledWithOwnerSkip ? {
      status:linked.every(item => item?.status === "deemed_inappropriate") ? "declined" as const : "ignored" as const,
      reason:linked.filter(item => item && isSkipStatus(item.status)).map(item => item!.failure_reason ?? "Owner declined this execution unit").join("; "),
    } : undefined;
    const ownerDisposition = state.finding_dispositions?.[finding.id] ?? unitOwnerDisposition ??
      (coverageDrop ? {status:"ignored" as const, reason:coverage.rationale ?? `Source was not scheduled: ${coverageDrop}`} : undefined);
    const semanticDisposition = state.plan?.source_dispositions?.find(entry => entry.finding_id === finding.id);
    const recorded = state.source_verifications?.[finding.id];
    const verified = recorded?.review_revision_sha256 === state.plan?.review_revision_sha256 &&
      recorded?.source_sha256 === contentSha256(finding) ? recorded : undefined;
    const allVerified = linked.length > 0 && linked.every(item => item && isVerifiedCompleteStatus(item.status));
    const starts = linked.flatMap(item => item?.started_at ? [item.started_at] : []).sort();
    const ends = linked.flatMap(item => item?.completed_at ? [item.completed_at] : []).sort();
    const hasBlocked = linked.some(item => !item || isUnsuccessfulEndStatus(item.status));
    const sourceDeferred = semanticDisposition?.status === "deferred";
    const sourcePending = !ownerDisposition && !semanticDisposition && units.length > 0 && !hasBlocked && !sourceDeferred && !allVerified;
    const sharedStatus = linked.length > 0 && linked.every(item => item?.status === linked[0]?.status) ? linked[0]?.status : undefined;
    const status: RemediationItemState["status"] = ownerDisposition ? ownerDisposition.status === "declined" ? "deemed_inappropriate" : "ignored"
      : semanticDisposition?.status === "deferred" ? "blocked"
      : semanticDisposition ? "resolved_no_change"
      : allVerified ? linked.every(item => item?.status === "resolved_no_change") ? "resolved_no_change" : "resolved"
      : sourcePending ? sharedStatus ?? "pending" : sharedStatus && isUnsuccessfulEndStatus(sharedStatus) ? sharedStatus : "blocked";
    // A source aggregation is not an execution item. Evidence remains keyed by
    // original source identity, so shared units cannot overwrite another source.
    const item = {
      status,
      ...verified,
      disposition_override: ownerDisposition ? undefined : semanticDisposition?.status === "already_fixed" ? "verified_already_fixed" as const
        : semanticDisposition?.status === "refuted" ? "refuted" as const : verified?.disposition_override,
      failure_reason: ownerDisposition?.reason ?? semanticDisposition?.reason ??
        (!allVerified ? units.length === 0 ? "No reviewed execution unit or source disposition covers this finding."
          : "Not every required execution unit was verified: " + units.map((unit, i) => `${unit.id}=${linked[i]?.status ?? "missing"}${linked[i]?.failure_reason ? ` (${linked[i]!.failure_reason})` : ""}`).join(", ") : undefined),
      rework_count: linked.reduce((sum, item) => sum + (item?.rework_count ?? 0), 0),
      started_at: starts[0], completed_at: linked.length > 0 && ends.length === linked.length ? ends.at(-1) : undefined,
    };
    // Source verdicts retain pending/deferred separately from blocked. A
    // successful source requires every linked unit verified, or an independently
    // corroborated explicit source disposition; an empty link set never passes.
    let outcome: RemediationOutcomeStatus;
    let originalState: RemediationItemState["status"] | undefined;
    let evidence: Evidence | undefined;
    let recordedByModule: string | undefined;
    let evidenceRefusalReason: string | undefined;
    if (sourceDeferred && !ownerDisposition) {
      outcome = "deferred";
    } else if (sourcePending) {
      outcome = "pending";
      originalState = sharedStatus;
    } else if (!isTerminalStatus(item.status)) {
      outcome = "blocked";
      originalState = sharedStatus;
    } else {
      const disposition = resolveDisposition(item.status, item.disposition_override);
      if (requiresVerificationEvidence(disposition)) {
        // INV-ISC-EVIDENCE-EMITTED — the writer-side backstop. REFUSE a
        // `verified_already_fixed`/`refuted` terminal disposition whose
        // evidence triple is incomplete, or whose complete triple's mechanism
        // CONTRADICTS the disposition it is meant to establish (RED
        // condition (4)'s mechanism-contradiction leg, the W4 witness) —
        // record a non-terminal `blocked` outcome naming the missing or
        // contradicting part instead of a green close on the audit's
        // assertion alone.
        const missing = missingEvidenceParts(item.evidence);
        if (missing.length > 0 || !isCompleteEvidence(item.evidence)) {
          outcome = "blocked";
          evidenceRefusalReason = `incomplete verification evidence for disposition '${disposition}' (missing: ${missing.join(", ")})`;
        } else {
          const candidateOutcome = dispositionToOutcomeStatus(disposition);
          if (mechanismContradictsOutcome(candidateOutcome, item.evidence.mechanism)) {
            outcome = "blocked";
            evidenceRefusalReason = `evidence mechanism '${item.evidence.mechanism}' contradicts disposition '${disposition}'`;
          } else {
            outcome = candidateOutcome;
            evidence = item.evidence;
            recordedByModule = item.recorded_by_module;
          }
        }
      } else {
        outcome = dispositionToOutcomeStatus(disposition);
        // Evidence is optional decoration for the original five dispositions,
        // but when a module DID record it, round-trip it byte-exact (the
        // ATTRIBUTION ROUND-TRIP) rather than silently dropping it.
        if (isCompleteEvidence(item.evidence)) {
          evidence = item.evidence;
          recordedByModule = item.recorded_by_module;
        }
      }
    }
    const fileExts = [
      ...new Set(
        (finding?.affected_files ?? [])
          .map((file) => extname(file.path).toLowerCase())
          .filter((ext) => ext.length > 0),
      ),
    ].sort();
    const durationMs = durationBetweenMs(item.started_at, item.completed_at);
    const isSuccessfulOutcome =
      outcome === "resolved" ||
      outcome === "verified_no_change" ||
      outcome === "verified_already_fixed" ||
      outcome === "refuted";
    let reason = !isSuccessfulOutcome ? item.failure_reason : undefined;
    if (evidenceRefusalReason) {
      reason = `INV-ISC-EVIDENCE-EMITTED refusal: ${evidenceRefusalReason}.${
        item.failure_reason ? ` ${item.failure_reason}` : ""
      }`;
    } else if (originalState) {
      reason = `Force-closed while non-terminal (original state '${originalState}').${
        item.failure_reason ? ` ${item.failure_reason}` : ""
      }`;
    } else if (!isSuccessfulOutcome && !reason) {
      reason = DEFAULT_REASON_BY_OUTCOME[outcome];
    }
    const base: RemediationOutcome = {
      finding_id: finding.id,
      lens: finding?.lens ?? "unknown",
      file_exts: fileExts,
      outcome,
      rework_count: item.rework_count ?? 0,
      closing_status: closingResult.status,
      ...(closeReason ? { closing_status_reason: closeReason } : {}),
      ...(reason ? { reason } : {}),
      ...(item.started_at ? { started_at: item.started_at } : {}),
      ...(item.completed_at ? { completed_at: item.completed_at } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      ...(item.mechanical_verification
        ? { mechanical_verification: item.mechanical_verification }
        : {}),
      ...(evidence ? { evidence } : {}),
      ...(recordedByModule ? { recorded_by_module: recordedByModule } : {}),
    };
    const enriched: RemediationOutcomeItem = {
      ...base,
      finding,
      unit_ids: units.map(unit => unit.id),
      unit_dependencies: [...new Set(units.flatMap(unit => unit.dependencies))],
      unit_statuses: Object.fromEntries(units.map((unit,i) => [unit.id,linked[i]?.status ?? "missing"])),
      final_status: FINAL_STATUS_BY_OUTCOME[outcome],
      original_state: originalState,
    };
    outcomes.push(enriched);
  }
  outcomes.sort((a, b) => compareCodeUnits(a.finding_id, b.finding_id));

  // Zero-filled so every outcome status appears even when unused (byOutcome),
  // countBy(...) supplies the actual counts on top. Spreading the zero-filled
  // base first, then counts, preserves OUTCOME_KEYS insertion order — spread
  // only overwrites an existing key's value, never reorders or appends
  // (outcome is a closed enum, so counts can't introduce an unseen key).
  const byOutcome = {
    ...(Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0])) as Record<
      RemediationOutcomeStatus,
      number
    >),
    ...countBy(outcomes, (entry) => entry.outcome),
  } as Record<RemediationOutcomeStatus, number>;

  // Group outcomes by lens (preserving first-appearance order), then countBy
  // outcome status within each group — same per-lens/per-status counts and
  // insertion order as the original single-pass nested reduce, since
  // `by_lens` is only ever consumed key-sorted downstream (renderOutcomesSummary).
  const lensGroups = new Map<string, typeof outcomes>();
  for (const entry of outcomes) {
    const group = lensGroups.get(entry.lens);
    if (group) {
      group.push(entry);
    } else {
      lensGroups.set(entry.lens, [entry]);
    }
  }
  const byLens: Record<
    string,
    Partial<Record<RemediationOutcomeStatus, number>>
  > = {};
  for (const [lens, group] of lensGroups) {
    byLens[lens] = countBy(group, (entry) => entry.outcome) as Partial<
      Record<RemediationOutcomeStatus, number>
    >;
  }

  const startedEntries = outcomes
    .map((outcome) => ({
      value: outcome.started_at,
      timestamp: parseTimestamp(outcome.started_at),
    }))
    .filter(
      (entry): entry is { value: string; timestamp: number } =>
        entry.value !== undefined && entry.timestamp !== undefined,
    );
  const completedEntries = outcomes
    .map((outcome) => ({
      value: outcome.completed_at,
      timestamp: parseTimestamp(outcome.completed_at),
    }))
    .filter(
      (entry): entry is { value: string; timestamp: number } =>
        entry.value !== undefined && entry.timestamp !== undefined,
    );
  const aggregateStarted = startedEntries.reduce<
    { value: string; timestamp: number } | undefined
  >(
    (earliest, entry) =>
      !earliest || entry.timestamp < earliest.timestamp ? entry : earliest,
    undefined,
  );
  const aggregateCompleted = completedEntries.reduce<
    { value: string; timestamp: number } | undefined
  >(
    (latest, entry) =>
      !latest || entry.timestamp > latest.timestamp ? entry : latest,
    undefined,
  );
  const aggregateDuration =
    aggregateStarted && aggregateCompleted
      ? durationBetweenMs(aggregateStarted.value, aggregateCompleted.value)
      : undefined;

  return {
    contract_version: REMEDIATION_OUTCOMES_CONTRACT_VERSION,
    total: outcomes.length,
    by_outcome: byOutcome,
    by_lens: byLens,
    ...(aggregateStarted ? { started_at: aggregateStarted.value } : {}),
    ...(aggregateCompleted ? { completed_at: aggregateCompleted.value } : {}),
    ...(aggregateDuration !== undefined ? { duration_ms: aggregateDuration } : {}),
    final_gate: finalGate,
    recovery,
    ...(contractReviews.length > 0 ? { contract_reviews: contractReviews.map(review => ContractReviewOutcomeSchema.parse(review)) } : {}),
    outcomes,
    execution_outcomes: executionOutcomes,
    ...(requestDisposition ? {request_disposition:requestDisposition} : {}),
    ...(requestOutcome ? {request_outcome:requestOutcome} : {}),
    ...(state.plan ? {objective:state.plan.objective, ...(state.plan.request ? {request:state.plan.request} : {})} : {}),
  };
}

/** Drop-reason discriminator per never-planned coverage disposition. */
const DROP_REASON_BY_DISPOSITION: Partial<
  Record<CoverageLedgerEntry["disposition"], NeverPlannedDropReason>
> = {
  folded_into: "cross_lens_dedup",
  dropped_by_checkpoint: "intent_checkpoint",
  dropped_no_evidence: "no_evidence",
  dropped_phantom_paths: "phantom_paths",
  declined_by_review: "review_gate",
};

/**
 * Best-effort recovery of full Finding payloads for never-planned findings:
 * re-read the run's structured-audit intake source(s) (recorded in
 * intake/source-manifest.json) and index their findings by id. Never-planned
 * findings were removed from the plan before state.json was written, so the
 * intake source is the remaining payload authority for them. Any failure
 * (missing manifest, moved input, free-form source) degrades to an empty map —
 * the coverage entry then keeps its id/title without a payload.
 */
async function loadStructuredSourceFindingsById(
  options: OrchestratorOptions,
): Promise<Map<string, Finding>> {
  const findingsById = new Map<string, Finding>();
  let manifest: IntakeSourceManifest | undefined;
  try {
    manifest = await readSourceManifest(intakePaths(options.artifactsDir).sourceManifest);
  } catch {
    return findingsById;
  }
  for (const source of manifest?.sources ?? []) {
    if (source.type !== "structured_audit") continue;
    const sourcePath = isAbsolute(source.path)
      ? source.path
      : join(options.root, source.path);
    try {
      const parsed: unknown = JSON.parse(readFileSync(sourcePath, "utf8"));
      if (!isAuditFindingsReport(parsed)) continue;
      for (const finding of parsed.findings) {
        if (finding && typeof finding.id === "string" && !findingsById.has(finding.id)) {
          findingsById.set(finding.id, finding);
        }
      }
    } catch {
      // Best-effort: an unreadable source just means no payload recovery.
    }
  }
  return findingsById;
}

/**
 * Build the outcomes file's coverage-ledger section: the plan's coverage ledger
 * with every never-planned entry (cross-lens-deduped, checkpoint-dropped,
 * no-evidence, phantom-paths) enriched with a `drop_reason` discriminator and
 * its full `Finding` payload. Payloads resolve from, in order: the ledger entry
 * itself (when the plan recorded one), the live plan findings, and the
 * structured-audit intake source. Must run BEFORE close deletes state.json /
 * the artifacts dir — they are the only payload sources.
 */
export async function buildOutcomeCoverageLedger(
  state: RemediationState,
  options: OrchestratorOptions,
): Promise<OutcomeCoverageLedger | undefined> {
  const ledger = state.plan_coverage;
  if (!ledger) return undefined;
  const plannedById = new Map(
    (state.plan?.findings ?? []).map((finding) => [finding.id, finding]),
  );
  const needsSourcePayloads = ledger.entries.some(
    (entry) =>
      DROP_REASON_BY_DISPOSITION[entry.disposition] !== undefined &&
      !entry.finding &&
      !plannedById.has(entry.finding_id),
  );
  const sourceById = needsSourcePayloads
    ? await loadStructuredSourceFindingsById(options)
    : new Map<string, Finding>();
  const entries: OutcomeCoverageEntry[] = ledger.entries.map((entry) => {
    const dropReason = DROP_REASON_BY_DISPOSITION[entry.disposition];
    if (!dropReason) return entry;
    const finding =
      entry.finding ??
      plannedById.get(entry.finding_id) ??
      sourceById.get(entry.finding_id);
    return {
      ...entry,
      ...(finding ? { finding } : {}),
      drop_reason: dropReason,
    };
  });
  return { ...ledger, entries };
}

export interface ClosingCommandResult {
  command: string[];
  exit_code: number | null;
  stdout?: string;
  stderr?: string;
}

export interface ClosingResult {
  contract_version: "remediate-code-closing-result/v1alpha1";
  action: ClosingAction;
  status: "success" | "failed" | "skipped";
  commands: ClosingCommandResult[];
  /** See `ClosingActionPreviewSchema.leftover_files` — same untouched-dirt set, at execute time. */
  leftover_files?: string[];
}

/**
 * Whether a closing action genuinely COMPLETED (COR-fb656e3f): it succeeded, OR
 * it was a skipped no-op (`action === "none"` — nothing was configured to do).
 * A *skipped nonnone* close did NOT complete; treating that as green would
 * pass the verification report and delete the (gitignored,
 * unrecoverable) artifacts dir for a run that never landed. Single-sourced here
 * so the verification trace, the report-level verdict, and the fully-green
 * cleanup gate can never drift on the classification.
 */
export function closingActionCompleted(closingResult: ClosingResult): boolean {
  return (
    closingResult.status === "success" ||
    (closingResult.status === "skipped" && closingResult.action === "none")
  );
}

function trimOutput(value: unknown): string | undefined {
  const text = Buffer.isBuffer(value) ? value.toString() : String(value ?? "");
  const trimmed = text.trim().slice(-FAILURE_OUTPUT_TAIL_CHARS);
  return trimmed.length > 0 ? trimmed : undefined;
}

function commandResult(
  command: string[],
  result: Awaited<ReturnType<typeof runTrackedAsync>>,
): ClosingCommandResult {
  return {
    command,
    exit_code: result.status,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
  };
}

/**
 * Spawn ONE closing-action command.
 *
 * ASYNC, for the same reason {@link runCombinedTestSuite} is, and it is not an
 * ornament: every closing command runs inside `advanceUnderPhaseLock`, with the
 * phase lock HELD. That lock's soundness rests on a `setInterval` mtime
 * heartbeat — a lock whose mtime stops advancing for ~30s is classified stale
 * and STOLEN by a second acquirer. A synchronous child blocks the event loop for
 * the entire spawn, so the heartbeat cannot fire, and the closing commands are
 * exactly the long ones: `git push` over the network, `gh pr create`, `npm
 * publish`, and an operator-authored `custom_command` of arbitrary duration. Any
 * one of them could out-sit the stale threshold and have the run's own lock
 * taken out from under it mid-close. Awaiting {@link runTrackedAsync} keeps the
 * loop turning for the whole command, so the heartbeat keeps the lock live.
 */
/**
 * Deadline for one closing-phase child: a closing command (`git push`,
 * `npm publish`, an operator `custom_command`) or a declared full/e2e suite.
 * These legitimately run minutes, so the bound matches the final gate's
 * one-hour suite bound — a bound against a child that never exits, not a
 * budget. Async keeps the held phase lock's heartbeat beating throughout;
 * without a declared timeout `runTrackedAsync` arms NO timer at all (INV-SSF
 * residual), which is what let a hung closing child wedge the fold.
 */
const CLOSING_CHILD_DEADLINE_MS = 3_600_000;

async function runTrackedCommand(
  root: string,
  command: string,
  args: string[],
): Promise<ClosingCommandResult> {
  const result = await runTrackedAsync([command, ...args], {
    cwd: root,
    windowsHide: true,
    timeout: CLOSING_CHILD_DEADLINE_MS,
  });
  return commandResult([command, ...args], result);
}

function isSuccess(result: ClosingCommandResult): boolean {
  return result.exit_code === 0;
}

// .env* is an absolute hard-exclude: never stageable under any circumstance
// (secrets safety net), regardless of manifest or deliverable membership.
const ENV_EXCLUDE_PATTERN = /^\.env($|\.)/;
// .audit-tools/ scratch (state.json, locks, per-run steps/results) is excluded
// UNLESS the exact path is one of this run's own tool
// deliverables (see `toolDeliverablePaths`) — those are eligible for staging
// like any other manifest file.
const AUDIT_TOOLS_EXCLUDE_PATTERN = /^\.audit-tools\//;

/**
 * The run's authoritative edit-surface manifest — the ONLY files
 * `collectStagingFiles` may stage (invariant: "remediation close must never
 * commit files the run didn't touch").
 *
 * `state.applied_edit_surface` is the ground truth: the union of files from each
 *    prompt-bound host result whose landed commit, ancestry, changed-file set,
 *    write scope, and required tests were mechanically corroborated by the
 *    provider-neutral host handoff ingestion boundary.
 *
 * RUN-START-DIRTY GUARD: a file that was ALREADY dirty when the run started
 * (`state.run_start_dirty`, captured at the extracted-plan join site before any
 * remediation edit exists) cannot be the run's edit, so it is excluded here —
 * otherwise closing could sweep pre-existing user WIP into a later commit. A landed commit proves
 * which paths the commit changed; it does not prove the tool owns any
 * still-dirty pre-run content at those paths. Excluding source (1) paths too
 * prevents a merge attestation from sweeping the user's earlier WIP into a
 * later closing commit. A state without
 * `run_start_dirty` (pre-field) means no exclusions.
 *
 * An empty surface is legitimate (e.g. a run that only produced
 * `resolved_no_change` / skipped items) and correctly yields an empty
 * manifest: nothing but tool deliverables gets staged.
 *
 * Membership semantics: entries are compared via the canonical
 * `normalizeRepoPath` key (forward-slash, `./`-stripped, lowercased — the
 * repo's single path normalizer), so a declared `./Src/Foo.ts` matches git's
 * `Src/Foo.ts`. The RETURNED strings keep their original casing; the
 * normalized form is only ever a comparison key (see `collectStagingFiles`).
 */
function resolveEditSurfaceManifest(state: RemediationState): string[] {
  const files = new Set<string>();
  const runStartDirtyKeys = new Set(
    (state.run_start_dirty ?? []).map(normalizeRepoPath),
  );
  const addUnlessPreexistingDirt = (path: string): void => {
    if (!runStartDirtyKeys.has(normalizeRepoPath(path))) files.add(path);
  };
  for (const path of state.applied_edit_surface ?? []) {
    addUnlessPreexistingDirt(path);
  }
  return [...files];
}

/**
 * Repo-relative paths of the tool-emitted root deliverables `.gitignore`
 * re-includes for tracking (`!.audit-tools/remediation-report.md`,
 * `!.audit-tools/remediation-outcomes.json`) — the two files this close phase
 * itself writes (see the end of `runClosePhase`) that are meant to be
 * committed. Computed from `options` (never a hardcoded `.audit-tools/…`
 * literal) so a non-default `--artifacts-dir` resolves correctly.
 *
 * Deliberately excludes `verification_report.json` / `remediation-state.
 * complete.json`: `.gitignore` does NOT re-include those, so they are never
 * visible to `stagedAndUntracked` (which honours `--exclude-standard`) and
 * need no carve-out here.
 *
 * KNOWN ORDERING NOTE: `runClosePhase` calls `executeClosingAction` (which is
 * where `collectStagingFiles` actually runs) BEFORE it writes these two
 * deliverables to disk — their own content describes THIS closing action's
 * outcome (status/commands), so they cannot exist yet at commit time without
 * describing a commit that hasn't happened. Carving them out of the exclude
 * pattern here does not retroactively stage them into the SAME commit; it
 * means that if they are already dirty for any other reason when
 * `collectStagingFiles` runs (re-included per `.gitignore`, tracked from a
 * prior run, hand-edited, etc.), they are correctly treated as legitimate
 * tool output rather than swept out by the blanket `.audit-tools/` exclude.
 */
function toolDeliverablePaths(options: OrchestratorOptions): string[] {
  const outputDir = dirname(options.artifactsDir);
  return ["remediation-report.md", "remediation-outcomes.json"].map((name) =>
    relative(options.root, join(outputDir, name)).replace(/\\/g, "/"),
  );
}

/** `collectStagingFiles`'s manifest-scoped result. */
export interface StagingSelection {
  /** Manifest (or deliverable) files that are currently dirty — safe to stage. */
  files: string[];
  /**
   * Currently-dirty files that are NEITHER in `manifest` nor a deliverable —
   * pre-existing/unrelated dirt the run never touched. Never staged; surfaced
   * so the host/user can see what was deliberately left alone.
   */
  leftover: string[];
}

/**
 * INVARIANT (V2 fix): remediation close must never commit files the run
 * didn't touch. This is the single chokepoint both the preview
 * (`checkClosingPreview`) and the execute path (`executeClosingAction`) stage
 * through — never a repo-wide `git diff`/`ls-files` sweep.
 *
 * Formula: `files = manifest ∩ currently-dirty` (plus `deliverables`, which
 * are unioned into the effective manifest so they stage like any other
 * manifest entry — see `toolDeliverablePaths`). Any currently-dirty path
 * outside that set is `leftover`: reported, never staged, never committed —
 * committing LESS than a dirty tree is always safe, so a leftover never blocks
 * or aborts the close (a full-abort-on-unrelated-dirt policy would make the
 * tool unusable against a routinely-dirty working tree).
 *
 * TOCTOU note: this recomputes "currently-dirty" fresh on every call (by
 * design — a file the user touched between preview and execute must be
 * re-observed). What it can NEVER do is widen `files` beyond `manifest ∪
 * deliverables`: a newly-dirtied path outside the manifest can only ever land
 * in `leftover`, never `files`. `pre_authorized: true` (see
 * `checkClosingPreview`) only skips the interactive preview step; it does not
 * — and structurally cannot — enlarge what this function is willing to stage.
 *
 * `.env*` is excluded even from an explicit manifest entry (defense-in-depth
 * against ever committing a secret); `.audit-tools/` scratch is excluded
 * unless the path is exactly a caller-supplied deliverable.
 *
 * Path comparison is TWO-TIER: an exact case-preserving key first
 * (`repoPathExactKey` — forward-slash, `./`-stripped), then the canonical
 * lowercased `normalizeRepoPath` key as a fallback ONLY when unambiguous
 * (exactly one dirty path folds to it). The fold tier is what makes a
 * <!-- comment-citation-exempt: illustrative case-variant paths -->
 * declared `./Src/Foo.ts` match git's `src/Foo.ts` on win32; the exact tier +
 * ambiguity guard is what stops a case-SIBLING pair on a case-sensitive
 * checkout (`Foo.ts` real, `foo.ts` also real and user-dirty) from sweeping
 * the user's file in through the fold. The STAGED output is always git's
 * original-cased path string (never a normalized key — `git add` needs the
 * real on-disk case), and the exclude regexes are tested against the folded
 * key so `.ENV` / `.Audit-Tools/` casing games cannot bypass them.
 *
 * ACCEPTED RESIDUAL (inherent to declared surfaces): in the conversation-first
 * flow a declared-but-never-edited file that the USER dirties DURING the run
 * window (post-plan, pre-close) is indistinguishable from the run's own
 * hand-applied edit — `run_start_dirty` only fences dirt that predates the
 * run. Closing it fully requires per-edit git ground truth, which that flow
 * does not have.
 */
export async function collectStagingFiles(
  root: string,
  manifest: string[],
  deliverables: string[] = [],
): Promise<StagingSelection> {
  const entries = [...manifest, ...deliverables];
  // Two-tier membership: EXACT (case-preserving) match first; the lowercased
  // normalizeRepoPath key only as a fallback, and only when it is UNAMBIGUOUS —
  // i.e. exactly one currently-dirty path folds to that key. On a
  // case-sensitive checkout two REAL files can differ only by case
  // (Foo.ts / foo.ts); a fold-only match would admit the user's case-sibling
  // of a manifest file into the commit — the exact over-inclusion this
  // function exists to prevent. An ambiguous fold therefore stages only the
  // exact-cased match (or none), never both.
  const exactKeys = new Set(entries.map(repoPathExactKey));
  const foldedKeys = new Set(entries.map(normalizeRepoPath));
  const exactDeliverableKeys = new Set(deliverables.map(repoPathExactKey));
  const foldedDeliverableKeys = new Set(deliverables.map(normalizeRepoPath));
  const dirty = [...(await stagedAndUntracked(root))];
  const foldedDirtyCount = new Map<string, number>();
  for (const f of dirty) {
    const k = normalizeRepoPath(f);
    foldedDirtyCount.set(k, (foldedDirtyCount.get(k) ?? 0) + 1);
  }
  const unambiguous = (foldedKey: string): boolean =>
    (foldedDirtyCount.get(foldedKey) ?? 0) === 1;
  const files: string[] = [];
  const leftover: string[] = [];
  for (const f of dirty) {
    const exact = repoPathExactKey(f);
    const folded = normalizeRepoPath(f);
    if (ENV_EXCLUDE_PATTERN.test(folded)) continue;
    const isDeliverable =
      exactDeliverableKeys.has(exact) ||
      (foldedDeliverableKeys.has(folded) && unambiguous(folded));
    if (AUDIT_TOOLS_EXCLUDE_PATTERN.test(folded) && !isDeliverable) continue;
    const inManifest =
      exactKeys.has(exact) || (foldedKeys.has(folded) && unambiguous(folded));
    if (inManifest) {
      files.push(f); // original-cased git path — never a normalized key
    } else {
      leftover.push(f);
    }
  }
  return { files: files.sort(), leftover: leftover.sort() };
}

/**
 * Case-PRESERVING repo-path comparison key (forward slashes, `./` stripped) —
 * the exact-match tier of `collectStagingFiles`'s two-tier membership. The
 * lowercased `normalizeRepoPath` remains the fold-fallback tier.
 */
function repoPathExactKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Generate a commit message derived from item summaries and finding titles.
 * Falls back to a generic message when there are no findings to summarize.
 */
function generateCommitMessage(state: RemediationState): string {
  const resolved = (state.plan?.units ?? []).filter(unit => {
    const item = state.items?.[unit.id];
    return item && isVerifiedCompleteStatus(item.status);
  });
  if (resolved.length === 0) return "Remediation complete";
  const titles = resolved.slice(0, 3).map(unit => unit.title).join(", ");
  return `Fix: ${titles}${resolved.length > 3 ? ` (+${resolved.length - 3} more)` : ""}`;
}

/**
 * Actions that require user confirmation before executing. `custom` is not
 * here: its command is host-authored (attached on the confirmed intent
 * checkpoint as `closing_custom_command`, owner decision 92b0e2dd7cfdc06d, or
 * by hand on `closing_plan.custom_command`), and writing the command IS the
 * authorization.
 */
const PREVIEW_ACTIONS = new Set<string>(["commit", "push", "open-pr", "publish"]);

/**
 * Check whether the closing action needs a confirmation preview. Returns the
 * preview data if confirmation is needed, or undefined if the action may
 * proceed immediately (pre_authorized, action === 'none'/'tag'/'custom', or
 * no files to stage).
 */
async function checkClosingPreview(
  state: RemediationState,
  options: OrchestratorOptions,
): Promise<
  { action: ClosingAction; custom_command?: string[]; files: string[]; commit_message: string; leftover_files?: string[] } | undefined
> {
  const closingPlan = state.closing_plan!;
  if (closingPlan.pre_authorized === true) return undefined;
  if (!PREVIEW_ACTIONS.has(closingPlan.action)) return undefined;
  const { files, leftover } = await collectStagingFiles(
    options.root,
    resolveEditSurfaceManifest(state),
    toolDeliverablePaths(options),
  );
  const commitMessage = generateCommitMessage(state);
  const preview = {
    action: closingPlan.action,
    ...(closingPlan.custom_command ? { custom_command: closingPlan.custom_command } : {}),
    files,
    commit_message: commitMessage,
    ...(leftover.length > 0 ? { leftover_files: leftover } : {}),
  };
  if (options.finalizeClosing && closingPlan.closing_action_preview &&
      JSON.stringify(preview) === JSON.stringify(closingPlan.closing_action_preview)) {
    closingPlan.pre_authorized = true;
    return undefined;
  }
  return preview;
}

/**
 * Commit exactly the closing `files`, never another staged path.
 *
 * The normal form is a pathspec'd commit. Git cannot take one when two of the
 * paths differ only by case on a case-insensitive checkout (a case-only
 * rename): it refuses "will not add file alias". The whole index is then the
 * only commit that records the rename — and it is taken ONLY when nothing
 * outside `files` is staged. Otherwise the close refuses with the reason
 * recorded, rather than sweep the user's staged work into its commit.
 */
async function commitClosingFiles(
  root: string,
  files: readonly string[],
  message: string,
  run: (command: string, args: string[]) => Promise<boolean>,
  commands: ClosingCommandResult[],
): Promise<boolean> {
  const foldCollision = new Set(files.map(normalizeRepoPath)).size < files.length;
  if (!foldCollision) {
    return run("git", ["commit", "-m", message, "--", ...files]);
  }
  const listed = await runTrackedAsync(
    ["git", "diff", "--cached", "--name-only", "--no-renames", "-z"],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: CLOSING_CHILD_DEADLINE_MS },
  );
  const own = new Set(files);
  const foreign = listed.status === 0
    ? String(listed.stdout).split("\0").filter((path) => path && !own.has(path))
    : null;
  if (foreign === null || foreign.length > 0) {
    commands.push({
      command: [],
      exit_code: null,
      stderr:
        "closing commit refused: a case-only rename cannot be committed by path, and the index " +
        (foreign === null
          ? "could not be listed to prove nothing else is staged"
          : `also holds staged paths outside this run: ${foreign.join(", ")}`) +
        ". Commit the rename by hand, or unstage those paths and re-run the close.",
    });
    return false;
  }
  return run("git", ["commit", "-m", message]);
}

/**
 * Execute the run's closing action.
 *
 * ASYNC because every command it spawns is awaited — see
 * {@link runTrackedCommand} for why a synchronous child under the held phase
 * lock is a liveness hazard rather than a style preference.
 */
export async function executeClosingAction(
  state: RemediationState,
  options: OrchestratorOptions,
): Promise<ClosingResult> {
  const action = state.closing_plan!.action;
  if (action === "none") {
    return {
      contract_version: "remediate-code-closing-result/v1alpha1",
      action,
      status: "skipped",
      commands: [],
    };
  }

  const commands: ClosingCommandResult[] = [];
  const run = async (command: string, args: string[]): Promise<boolean> => {
    const result = await runTrackedCommand(options.root, command, args);
    commands.push(result);
    return isSuccess(result);
  };
  // Populated only on the commit/push/open-pr branch below; threaded into
  // every return of this function so the caller always sees the same
  // untouched-user-dirt set the preview (checkClosingPreview) computed.
  let leftoverFiles: string[] = [];

  if (action === "commit" || action === "push" || action === "open-pr") {
    // Recomputed here (not reused from the preview) so a file the user
    // touched between preview and execute is re-observed — but ONLY within
    // the same manifest ∪ deliverables the preview used, never a wider sweep
    // (see collectStagingFiles's doc comment: this is the TOCTOU fix, not a
    // TOCTOU reintroduction).
    const staging = await collectStagingFiles(
      options.root,
      resolveEditSurfaceManifest(state),
      toolDeliverablePaths(options),
    );
    leftoverFiles = staging.leftover;
    const files = staging.files;
    // Nothing to stage → vacuous success: no commit, push, or PR is attempted,
    // so `commands` stays empty and the status is success.
    if (files.length === 0) {
      console.warn("No modified files to stage — skipping commit.");
      return {
        contract_version: "remediate-code-closing-result/v1alpha1",
        action,
        status: "success",
        commands: [],
        ...(leftoverFiles.length > 0 ? { leftover_files: leftoverFiles } : {}),
      };
    }
    const commitMessage = state.closing_plan!.closing_action_preview?.commit_message
      ?? generateCommitMessage(state);
    // Awaited stepwise so the `&&` short-circuit survives the async migration:
    // a promise is truthy, so a bare `a() && b()` over async runs would have
    // run BOTH commands and dropped the failure gate.
    //
    // The commit carries the SAME pathspec as the add. Without it, git records
    // the whole index, so a path the user staged before the close (reported as
    // `leftover`, never added here) would ride into this commit. With it, git
    // commits only these paths and leaves the user's other staged entries
    // staged and untouched.
    //
    // A path gone from the working tree is a DELETION, and `git add` refuses it
    // outright ("pathspec did not match") once the deletion is already staged —
    // a `git rm`, or the old half of a `git mv`. `git rm --cached` records the
    // deletion when the index still holds the path and is a no-op when it does
    // not, so every manifest path reaches the commit without failing the add.
    const present = files.filter((file) => existsSync(join(options.root, file)));
    const absent = files.filter((file) => !present.includes(file));
    const staged =
      (present.length === 0 || (await run("git", ["add", "--", ...present]))) &&
      (absent.length === 0 ||
        (await run("git", ["rm", "--cached", "--ignore-unmatch", "-q", "--", ...absent])));
    const committed = staged && (await commitClosingFiles(options.root, files, commitMessage, run, commands));
    if (committed && action === "push") {
      await run("git", ["push"]);
    } else if (committed && action === "open-pr") {
      if (await run("git", ["push"])) {
        await run("gh", ["pr", "create", "--fill"]);
      }
    }
  } else if (action === "publish") {
    await run("npm", ["publish"]);
  } else if (action === "tag") {
    await run("git", ["tag", "auto-remediation"]);
  } else if (action === "custom") {
    const custom = state.closing_plan!.custom_command;
    if (custom?.length) {
      await run(custom[0], custom.slice(1));
    } else {
      // A chosen `custom` with no command attached must never read as a green
      // no-op: nothing ran, and the result says so. `custom` is reachable from
      // the checkpoint since owner decision 92b0e2dd7cfdc06d.
      commands.push({
        command: [],
        exit_code: null,
        stderr: "closing action `custom` has no custom_command attached — nothing was run",
      });
    }
  }

  return {
    contract_version: "remediate-code-closing-result/v1alpha1",
    action,
    status: commands.every(isSuccess) ? "success" : "failed",
    commands,
    ...(leftoverFiles.length > 0 ? { leftover_files: leftoverFiles } : {}),
  };
}


/**
 * Run the plan's combined test suite over the fully merged post-remediation
 * state. Returns pass/fail plus the failure-output tail. No test_command =>
 * `ran:false` (never-ran, distinct from a real pass) — `passed` still reports
 * `true` so existing gates that fold `combinedTest.passed` into `fullyGreen`
 * keep their vacuously-green behavior for a run with no configured suite;
 * `ran` is what lets a caller (buildVerificationReport's trace) tell the two
 * apart rather than rendering "combined test suite passed" for a suite that
 * never executed.
 *
 * The declared command passes the single-invocation shape gate BEFORE any
 * spawn — the same rule that guards a block's `targeted_commands`. A command
 * that chains, redirects or substitutes is REFUSED as a non-run
 * (`ran:false, passed:false`), never executed and never silently treated as a
 * pass, so a malformed suite declaration fails the close rather than handing a
 * shell an extra process.
 *
 * ⚠ BEHAVIOUR CHANGE, and a NARROWING — declarations this used to run now fail
 * the close instead. The gate refuses `' \ ^ % $` and backtick in EVERY
 * position, so two shapes that `shell: true` accepted are now refused outright:
 *
 *   - an absolute Windows interpreter/script path (`C:\Program
 *     Files\nodejs\node.exe …`) — backslashes;
 *   - a single-quoted argument (`pytest -k 'not slow'`, `node -e "x('y')"`).
 *
 * Both are re-expressible: use the bare shim name (`node`, `npm`) and let
 * `resolveExecArgv` find it, and pass an argument as a DOUBLE-quoted token
 * rather than a nested single-quoted literal. The refusal is deliberate — a
 * declaration whose meaning depends on which shell reads it is exactly what the
 * shape rule exists to reject — but it IS a migration for anyone whose
 * `test_command` / `e2e_command` carries either shape.
 *
 * ASYNC, and that is the point: the close phase holds the state lock across
 * this call, and a synchronous child blocks the event loop for the whole spawn
 * — starving the lock's own mtime heartbeat until a live lock reads as stale
 * and is stolen mid-close. Awaiting {@link runTrackedAsync} keeps the loop
 * turning for the entire suite.
 */
export async function runCombinedTestSuite(
  state: RemediationState,
  options: OrchestratorOptions,
): Promise<CombinedTestResult> {
  console.log("Running full test suite on combined post-remediation state...");
  if (!state.plan?.test_command) {
    return { ran: false, passed: true, duration_ms: 0, output: "" };
  }
  const suiteName = Array.isArray(state.plan.test_command)
    ? state.plan.test_command.join(" ")
    : state.plan.test_command;

  if (commandLeavesDeclaredShape(suiteName)) {
    return {
      ran: false,
      passed: false,
      suite_name: suiteName,
      duration_ms: 0,
      output: `refused: the declared test_command leaves the single-invocation command shape: ${suiteName}`,
    };
  }

  const startedAt = Date.now();
  if (state.plan.test_command_source === "project_facts") {
    const admitted = await runAdmittedProjectTestCommand(parseCommandString(suiteName), options.root, {
      timeoutMs: CLOSING_CHILD_DEADLINE_MS,
    });
    if (!admitted.admitted) {
      return { ran: false, passed: false, suite_name: suiteName, duration_ms: 0, output: admitted.refusal_reason ?? "refused" };
    }
    const passed = admitted.exit_code === 0 && !admitted.timed_out && !admitted.spawn_error;
    return {
      ran: true,
      passed,
      exit_code: admitted.exit_code,
      suite_name: suiteName,
      duration_ms: Date.now() - startedAt,
      output: passed
        ? ""
        : (admitted.spawn_error ?? admitted.output).trim().slice(-FAILURE_OUTPUT_TAIL_CHARS) ||
          (admitted.timed_out
            ? `default test command timed out after ${CLOSING_CHILD_DEADLINE_MS}ms`
            : "default test command failed without output"),
    };
  }
  // argv, never a shell string: the shape gate admits only single invocations,
  // and `resolveExecArgv` inside the shared runner is what makes an `npm`/`npx`
  // shim resolve on win32 without one.
  const result = await runTrackedAsync(parseCommandString(suiteName), {
    cwd: options.root,
    windowsHide: true,
    timeout: CLOSING_CHILD_DEADLINE_MS,
  });
  const durationMs = Date.now() - startedAt;
  if (result.status === 0) {
    return { ran: true, passed: true, exit_code: result.status, suite_name: suiteName, duration_ms: durationMs, output: "" };
  }
  const output = (
    (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "")
  )
    .trim()
    .slice(-FAILURE_OUTPUT_TAIL_CHARS);
  return { ran: true, passed: false, exit_code: result.status, suite_name: suiteName, duration_ms: durationMs, output };
}

/**
 * Parse test output to extract implicated file paths. Looks for common test
 * runner patterns (e.g. "FAIL src/foo.ts", "at src/foo.ts:12", "● foo.ts").
 */
function extractImplicatedPaths(testOutput: string): string[] {
  const paths = new Set<string>();
  // Match patterns like: FAIL src/foo.ts, at Object.<anonymous> (src/foo.ts:12),
  // src/foo.ts:12:3, ● src/foo.ts
  const pathPattern = /(?:FAIL\s+|at\s+\S+\s+\(|●\s+)?([^\s()]+\.[a-z]{1,6})(?::\d+)?/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(testOutput)) !== null) {
    const candidate = match[1]!;
    // Only keep plausible repo-relative paths (contain at least one slash or look like a file)
    if (candidate.includes("/") || candidate.includes("\\") || /\.[a-z]{1,6}$/.test(candidate)) {
      const normalized = safeAttributionPath(candidate);
      if (
        normalized &&
        !normalizeRepoPath(normalized).startsWith("node_modules/")
      ) {
        paths.add(normalized);
      }
    }
  }
  return [...paths];
}

/**
 * Normalize separators without resolving path syntax. Attribution evidence is
 * untrusted test output. One common leading `./` test-runner prefix is
 * removed; every later `.` segment and every `..` segment is rejected instead
 * of being collapsed into a different block's declared scope.
 */
function safeAttributionPath(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, "/");
  const withoutLeadingDot = normalized.startsWith("./")
    ? normalized.slice(2)
    : normalized;
  return withoutLeadingDot
    .split("/")
    .some((segment) => segment === "." || segment === "..")
    ? null
    : withoutLeadingDot;
}

/**
 * Whether a touched file `tf` and an implicated path `ip` (extracted from test
 * output, which may be a bare/partial path) refer to the same file: exact
 * match after normalization, or one is a path-SEPARATOR-anchored suffix of the
 * other. Never a bare string-suffix test — `"src/myfoo.ts".endsWith("foo.ts")`
 * is true but the two are unrelated files; anchoring the match to a `/`
 * boundary (via `normalizeRepoPath`, which also folds case/slash direction) is
 * what a real path-key join requires and a substring test does not give.
 */
function touchedPathMatchesImplicated(tf: string, ip: string): boolean {
  const safeTouched = safeAttributionPath(tf);
  const safeImplicated = safeAttributionPath(ip);
  if (!safeTouched || !safeImplicated) return false;
  const a = normalizeRepoPath(safeTouched);
  const b = normalizeRepoPath(safeImplicated);
  if (a.endsWith("/")) {
    return b.startsWith(a) || b.includes(`/${a}`);
  }
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * On a combined-test failure, selectively re-block items whose touched_files
 * overlap with the failing tests' implicated paths. When attribution is
 * ambiguous (no overlap found), falls back to re-blocking all resolved items.
 * Returns whether any item was blocked — the caller transitions back to triage.
 *
 * The surface is read from the item's BLOCK (`block.touched_files`), which is
 * REQUIRED on the block contract and is the same scope the host binds an
 * implementer to. It previously read a per-item `item_spec.touched_files`;
 * nothing in production ever wrote an item_spec, so that expression was always
 * `[]`, attribution could never succeed, and the ambiguity fallback re-blocked
 * EVERY resolved item on any combined-suite failure. Reading the block is what
 * makes the attribution arm reachable at all.
 */
export function blockResolvedItemsOnCombinedFailure(
  state: RemediationState,
  testOutput: string,
): boolean {
  const resolvedItems = Object.values(state.items ?? {}).filter(
    (i) => isVerifiedCompleteStatus(i.status),
  );
  if (resolvedItems.length === 0) return false;

  const implicatedPaths = extractImplicatedPaths(testOutput);
  const now = new Date().toISOString();
  const touchedFilesByUnit = new Map(
    (state.plan?.units ?? []).map((unit) => [unit.id, unit.allowed_files]),
  );

  // Attempt attribution: find items whose block touched an implicated path.
  let attributed: typeof resolvedItems = [];
  if (implicatedPaths.length > 0) {
    for (const item of resolvedItems) {
      const touchedFiles = touchedFilesByUnit.get(item.unit_id) ?? [];
      const overlaps = touchedFiles.some((tf) =>
        implicatedPaths.some((ip) => touchedPathMatchesImplicated(tf, ip)),
      );
      if (overlaps) attributed.push(item);
    }
  }

  const fallback = attributed.length === 0;
  const toBlock = fallback ? resolvedItems : attributed;
  const attributionNote = fallback
    ? `Attribution attempt found no touched_files overlap with failing paths [${implicatedPaths.slice(0, 5).join(", ")}]; falling back to re-blocking all resolved items.`
    : `Attributed to ${attributed.length} item(s) with overlapping touched_files [${implicatedPaths.slice(0, 5).join(", ")}].`;

  for (const item of toBlock) {
    item.status = "blocked";
    item.completed_at = now;
    item.failure_reason = `Combined test suite failed after remediation. ${attributionNote}${testOutput ? `\n\nTest output:\n${testOutput}` : ""}`;
  }

  return true;
}

export interface E2eTestResult {
  ran: boolean;
  passed: boolean;
  output: string;
}

/**
 * Run end-to-end tests on the fully merged state. E2e runs once here (not
 * per-block) because interdependent refactors can break e2e flows even when
 * per-item unit tests pass. Returns `{ ran: false }` when no e2e_command is
 * configured. Never throws — failure is returned as `passed: false`.
 *
 * Shape-gated and async for the same two reasons as
 * {@link runCombinedTestSuite}: a declaration that leaves the single-invocation
 * shape is REFUSED as a non-run rather than handed to a shell, and the spawn is
 * awaited so the state lock's heartbeat keeps beating while e2e runs.
 */
async function runE2eTests(
  state: RemediationState,
  options: OrchestratorOptions,
): Promise<E2eTestResult> {
  if (!state.plan?.e2e_command) {
    return { ran: false, passed: true, output: "" };
  }

  if (commandLeavesDeclaredShape(state.plan.e2e_command)) {
    return {
      ran: false,
      passed: false,
      output: `refused: the declared e2e_command leaves the single-invocation command shape: ${state.plan.e2e_command}`,
    };
  }

  console.log("Running end-to-end tests on combined post-remediation state...");
  if (state.plan.e2e_command_source === "project_facts") {
    const admitted = await runAdmittedProjectE2eCommand(parseCommandString(state.plan.e2e_command), options.root, {
      timeoutMs: CLOSING_CHILD_DEADLINE_MS,
    });
    if (!admitted.admitted) return { ran: false, passed: false, output: admitted.refusal_reason ?? "refused" };
    const passed = admitted.exit_code === 0 && !admitted.timed_out && !admitted.spawn_error;
    return {
      ran: true,
      passed,
      output: passed
        ? ""
        : (admitted.spawn_error ?? admitted.output).trim().slice(-FAILURE_OUTPUT_TAIL_CHARS) ||
          (admitted.timed_out
            ? `default e2e command timed out after ${CLOSING_CHILD_DEADLINE_MS}ms`
            : "default e2e command failed without output"),
    };
  }
  const e2eResult = await runTrackedAsync(
    parseCommandString(state.plan.e2e_command),
    {
      cwd: options.root,
      windowsHide: true,
      timeout: CLOSING_CHILD_DEADLINE_MS,
    },
  );
  const e2ePassed = e2eResult.status === 0;
  if (!e2ePassed) {
    const e2eOutput = (
      (e2eResult.stdout?.toString() ?? "") +
      (e2eResult.stderr?.toString() ?? "")
    )
      .trim()
      .slice(-FAILURE_OUTPUT_TAIL_CHARS);
    console.warn("End-to-end tests failed after remediation. Transitioning to triage.");
    return { ran: true, passed: false, output: e2eOutput };
  }
  console.log("End-to-end tests passed.");
  return { ran: true, passed: true, output: "" };
}

interface ResolvedReportEntry {
  unit_id: string;
  summary: string;
  verification_evidence?: string[];
}
interface RationaleReportEntry {
  unit_id: string;
  rationale: string;
}
interface ReportEntries {
  resolved: ResolvedReportEntry[];
  verifiedNoChange: ResolvedReportEntry[];
  inappropriate: RationaleReportEntry[];
  ignored: RationaleReportEntry[];
  blocked: RationaleReportEntry[];
}

/**
 * Partition the terminal items into the report's resolved / verified-no-change
 * / inappropriate / ignored buckets, pulling each resolved item's verification
 * evidence from its `verify_code_against_documentation` result file when present.
 */
function collectReportEntries(
  state: RemediationState,
  options: OrchestratorOptions,
): ReportEntries {
  const entries: ReportEntries = {
    resolved: [],
    verifiedNoChange: [],
    inappropriate: [],
    ignored: [],
    blocked: [],
  };
  for (const item of Object.values(state.items ?? {})) {
    if (isVerifiedCompleteStatus(item.status)) {
      const unit = state.plan?.units.find((u) => u.id === item.unit_id);
      const title = unit?.title ?? item.unit_id;
      let verificationEvidence: string[] | undefined =
        item.host_result_evidence;

      const verificationResultPath = join(
        options.artifactsDir,
        `result_${item.unit_id}_verify_code_against_documentation.json`,
      );
      if (existsSync(verificationResultPath)) {
        try {
          const verRes = JSON.parse(readFileSync(verificationResultPath, "utf8"));
          if (Array.isArray(verRes.reason) && verRes.reason.length > 0) {
            verificationEvidence = verRes.reason;
          }
        } catch (error) {
          console.warn(
            `Failed to parse verification result ${verificationResultPath}.`,
            error,
          );
        }
      }

      const entry: ResolvedReportEntry = {
        unit_id: item.unit_id,
        summary: title,
        verification_evidence: verificationEvidence,
      };
      if (item.status === "resolved_no_change") {
        entries.verifiedNoChange.push(entry);
      } else {
        entries.resolved.push(entry);
      }
    } else if (item.status === "deemed_inappropriate") {
      entries.inappropriate.push({
        unit_id: item.unit_id,
        rationale: item.failure_reason ?? "Deemed inappropriate",
      });
    } else if (item.status === "ignored") {
      entries.ignored.push({
        unit_id: item.unit_id,
        rationale: item.failure_reason ?? "Ignored by user",
      });
    } else if (item.status === "blocked") {
      entries.blocked.push({
        unit_id: item.unit_id,
        rationale: item.failure_reason ?? "Blocked",
      });
    }
  }
  return entries;
}

/**
 * Render `remediation-report.md` from the partitioned entries, closing action,
 * e2e result, and per-finding outcomes. Pure string builder (no I/O).
 */
export function buildRemediationReportMarkdown(
  state: RemediationState,
  entries: ReportEntries,
  closingResult: ClosingResult,
  e2ePassed: boolean | undefined,
  outcomesReport: RemediationOutcomesReport,
  combinedTest: CombinedTestResult,
  reflections: AgentReflection[] = [],
  landingGates: LandingGateVerifyOutcome = { commands: [], gates: [], passed: true },
): string {
  let reportContent = `# Remediation Report\n\n`;

  if (outcomesReport.request_outcome) {
    const request = outcomesReport.request_outcome;
    reportContent += `## Request outcome\n\n${request.status}: ${request.reason}\n`;
    for (const evidence of request.evidence) reportContent += `- ${evidence}\n`;
    reportContent += "\n";
  }
  const executionUnits = outcomesReport.execution_outcomes;
  const completedUnits = executionUnits.filter(unit => unit.status === "resolved" || unit.status === "resolved_no_change").length;
  const skippedUnits = executionUnits.filter(unit => unit.status === "ignored" || unit.status === "deemed_inappropriate").length;
  reportContent += `## Execution units\n\n${executionUnits.length} unit(s): ${completedUnits} verified complete, ${skippedUnits} skipped, ${executionUnits.length - completedUnits - skippedUnits} unfinished.\n\n`;
  for (const unit of outcomesReport.execution_outcomes ?? []) {
    reportContent += `- **${unit.unit_id}** ${unit.title}: ${unit.status}${unit.reason ? ` — ${unit.reason}` : ""}\n`;
  }
  if (!(outcomesReport.execution_outcomes ?? []).length) reportContent += "No execution units were required.\n";
  reportContent += "\n";

  // Host results are accepted only after the claimed commit is mechanically
  // corroborated as reachable from HEAD. A no-change/skip-only run has no
  // changed commit to review.
  if (entries.resolved.length > 0) {
    reportContent += `## Review\n\nAll code changes were accepted through the provider-neutral host handoff and corroborated as landed commits reachable from the repository HEAD. Review the resulting diff and commit history.\n\n`;
  }

  const resultReviews = outcomesReport.execution_outcomes.filter(outcome => outcome.conformance_review);
  if (outcomesReport.contract_reviews?.length || resultReviews.length) {
    reportContent += `## Declared Review Context\n\nThese are host-declared review contexts bound to accepted artifacts/results, not verified reviewer identities.\n\n`;
    for (const review of outcomesReport.contract_reviews ?? []) {
      reportContent += `- ${review.role} (${review.artifact}): required ${review.requirement}; declared ${review.review.mode}. ${review.review.reason}\n`;
    }
    for (const outcome of resultReviews) {
      const review = outcome.conformance_review!;
      reportContent += `- ${outcome.unit_id} conformance: required independent; declared ${review.review.mode}. ${review.summary}\n`;
    }
    reportContent += "\n";
  }

  reportContent += `## Resolved — Changed Files\n\n`;
  if (entries.resolved.length === 0) {
    reportContent += `None.\n`;
  } else {
    for (const entry of entries.resolved) {
      reportContent += `- **${entry.unit_id}**: ${entry.summary}\n`;
      if (entry.verification_evidence) {
        for (const check of entry.verification_evidence) {
          reportContent += `  - *Verification*: ${check}\n`;
        }
      }
    }
  }

  if (entries.verifiedNoChange.length > 0) {
    reportContent += `\n## Verified Already Correct (no changes made)\n\n`;
    for (const entry of entries.verifiedNoChange) {
      reportContent += `- **${entry.unit_id}**: ${entry.summary}\n`;
      if (entry.verification_evidence) {
        for (const check of entry.verification_evidence) {
          reportContent += `  - *Verification*: ${check}\n`;
        }
      }
    }
  }

  if (entries.inappropriate.length > 0) {
    reportContent += `\n## Deemed Inappropriate\n\n`;
    for (const entry of entries.inappropriate) {
      reportContent += `- **${entry.unit_id}**: ${entry.rationale}\n`;
    }
  }

  if (entries.ignored.length > 0) {
    reportContent += `\n## Ignored\n\n`;
    for (const entry of entries.ignored) {
      reportContent += `- **${entry.unit_id}**: ${entry.rationale}\n`;
    }
  }

  const skippedByCheckpoint = (state.plan_coverage?.entries ?? []).filter(
    (e) => e.disposition === "dropped_by_checkpoint",
  );
  if (skippedByCheckpoint.length > 0) {
    reportContent += `\n## Skipped by Intent Checkpoint\n\n`;
    reportContent += `${skippedByCheckpoint.length} finding(s) were excluded from remediation by the intent checkpoint (severity/lens/package/theme filters or excluded scope):\n`;
    for (const entry of skippedByCheckpoint) {
      reportContent += `- **${entry.finding_id}**${entry.title ? `: ${entry.title}` : ""}\n`;
    }
  }

  const droppedByGrounding = (state.plan_coverage?.entries ?? []).filter(
    (e) => e.disposition === "dropped_phantom_paths",
  );
  if (droppedByGrounding.length > 0) {
    reportContent += `\n## Dropped by Grounding\n\n`;
    reportContent += `${droppedByGrounding.length} extracted finding(s) were dropped because every cited path was phantom (does not exist in this repository):\n`;
    for (const entry of droppedByGrounding) {
      const phantoms = entry.phantom_paths_removed?.join(", ");
      reportContent += `- **${entry.finding_id}**${entry.title ? `: ${entry.title}` : ""}${phantoms ? ` (cited: ${phantoms})` : ""}\n`;
    }
  }

  const ungroundedEvidence = (state.plan_coverage?.entries ?? []).filter(
    (e) => e.disposition === "planned" && e.evidence_grounded === false,
  );
  if (ungroundedEvidence.length > 0) {
    reportContent += `\n## Ungrounded Evidence\n\n`;
    reportContent += `${ungroundedEvidence.length} planned finding(s) carried no evidence citing a real repo path and were downgraded to low confidence:\n`;
    for (const entry of ungroundedEvidence) {
      reportContent += `- **${entry.finding_id}**${entry.title ? `: ${entry.title}` : ""}\n`;
    }
  }

  reportContent += `\n## Closing Action\n\nAction: ${state.closing_plan!.action}\n`;
  reportContent += `Status: ${closingResult.status}\n`;

  // V2 staging-manifest fix, finding 3: leftover (untouched user dirt) must be
  // visible in the HUMAN report too — on a pre_authorized/autonomous run there
  // is no interactive preview, so this section is the only place the user sees
  // what the close deliberately did not commit.
  if (closingResult.leftover_files?.length) {
    reportContent += `\n## Files Left Untouched (not part of this run's edit surface)\n\n`;
    reportContent += `${closingResult.leftover_files.length} dirty file(s) were NOT staged or committed because they are outside this run's edit-surface manifest (pre-existing or unrelated changes — yours to keep, commit, or discard):\n\n`;
    for (const f of closingResult.leftover_files) {
      reportContent += `- \`${f}\`\n`;
    }
  }

  // The tool-owned repository gate, ALWAYS rendered. A run whose gate was
  // scoped out, suppressed, or never reached used to produce a report identical
  // to one written after a green floor — "the suite passed" and "no suite ran"
  // were the same document. Every branch below names which happened.
  // The SPLIT is `carriesGateVerdict`, NOT `outcome === "executed"`. A `history`
  // outcome carries a REAL verdict — a judge ruled on this exact tree content —
  // so branching on the executed literal sent it to the not-run arm, which
  // printed "the repository floor did NOT run (0 commands) … This is not a pass"
  // directly beside a `commands_run` of 4, contradicting itself in one section.
  // The question the render asks is the one the shared predicate answers: did
  // anything JUDGE this tree? Only the not-run kinds get the not-a-pass
  // sentence, and the predicate — not a second literal list here — is what draws
  // that line.
  const gate = outcomesReport.final_gate;
  reportContent += `\n## Repository Gate\n\n`;
  if (gate.outcome === "executed") {
    reportContent += `Outcome: executed — the repository build/typecheck/test floor RAN (${gate.commands_run} command(s)) and ${gate.passed ? "PASSED" : "FAILED"}.\n`;
  } else if (carriesGateVerdict(gate.outcome)) {
    // Reached only for a verdict-bearing kind that is NOT `executed` — i.e.
    // `history`, told apart from `executed` because the FACT is distinct: the
    // floor ran, on this same tree content, and this evaluation was served its
    // recorded verdict instead of re-spawning it. Saying "RAN" would claim a
    // judge executed in this evaluation; saying "did NOT run" would claim the
    // tree is unjudged. Neither is true.
    reportContent += `Outcome: ${gate.outcome} — the repository floor ran on an UNCHANGED tree and this evaluation was served the recorded verdict (${gate.commands_run} command(s) held by that record), which ${gate.passed ? "PASSED" : "FAILED"}.\n`;
  } else if (gate.outcome === "absent") {
    reportContent += `Outcome: absent — NO gate outcome was recorded for this run, so nothing here corroborates it. This is not a pass.\n`;
  } else {
    // Reachable only for a kind `carriesGateVerdict` rejects — i.e. a gate that
    // ran nothing. Stated as its own line rather than folded into the `absent`
    // sentence above, which is about the RECORD being missing, not the floor.
    reportContent += `Outcome: ${gate.outcome} — the repository floor did NOT run (0 commands), so nothing here corroborates this run. This is not a pass.\n`;
  }
  if (gate.reason) reportContent += `Reason: ${gate.reason}\n`;
  if (gate.scope) reportContent += `Scope: ${gate.scope}\n`;

  // The run's recovery record, ALWAYS rendered — the same reason the gate
  // section is: a run whose submission had to be readmitted through a recovery
  // verb ran at a LOWER evidence bar than the normal lane's, and until this
  // section existed that run produced a report identical to a clean one. The
  // ledger has recorded every one of these since it was written; this is the
  // human render of the read that finally consumes it.
  reportContent += `\n## Recovery\n\n`;
  const recoveryLabel = (kind: RecoveryMark["kind"]): string =>
    kind === "accepted_via_recovery"
      ? "Accepted via recovery (a corroboration check was relaxed)"
      : "Recovered by hand (re-landed through the recovery verb)";
  const marks: Array<RecoveryMark> = [
    ...outcomesReport.recovery.accepted_via_recovery,
    ...outcomesReport.recovery.recovered_by_hand,
  ];
  if (marks.length === 0) {
    reportContent += `None — no submission was readmitted; every accepted submission passed the normal lane's checks.\n`;
  } else {
    reportContent += `${marks.length} submission(s) were READMITTED after the normal lane did not accept them. Findings fixed through a recovered submission are less corroborated than the rest of this run's:\n\n`;
    for (const mark of marks) {
      reportContent += `- \`${mark.submission_id}\` (lane \`${mark.lane}\`): ${recoveryLabel(mark.kind)}${mark.issue_code ? ` — \`${mark.issue_code}\`` : ""}\n`;
    }
  }
  if (outcomesReport.recovery.dropped_lines > 0) {
    reportContent += `\nWarning: ${outcomesReport.recovery.dropped_lines} ledger line(s) could not be read (torn, or written by another release), so an unread recovery event may be missing from this section.\n`;
  }

  if (e2ePassed !== undefined) {
    reportContent += `\n## End-to-End Tests\n\nResult: ${e2ePassed ? "passed" : "failed"}\n`;
  }

  const o = outcomesReport.by_outcome;
  reportContent += `\n## Remediation Outcomes\n\n`;
  reportContent += `Of ${outcomesReport.total} finding(s): ${o.resolved} resolved, ${o.verified_no_change} verified already correct, ${o.inappropriate} deemed inappropriate, ${o.ignored} ignored, ${o.blocked} blocked, ${o.pending} pending, ${o.deferred} deferred.\n`;
  const lensNames = Object.keys(outcomesReport.by_lens).sort();
  if (lensNames.length > 0) {
    reportContent += `\nBy lens:\n`;
    for (const lens of lensNames) {
      const counts = outcomesReport.by_lens[lens]!;
      const parts = OUTCOME_KEYS.filter((key) => (counts[key] ?? 0) > 0).map(
        (key) => `${key} ${counts[key]}`,
      );
      reportContent += `- ${lens}: ${parts.join(", ")}\n`;
    }
  }

  // Item C — mechanical re-verify summary (render of the per-outcome
  // `mechanical_verification` field; present only when the leg ran).
  const mechanical = outcomesReport.outcomes.filter((o) => o.mechanical_verification);
  if (mechanical.length > 0) {
    const count = (status: string) =>
      mechanical.filter((o) => o.mechanical_verification!.status === status).length;
    reportContent += `\nMechanical re-verify (analyzer-born findings): ${count("verified_mechanically")} verified by analyzer re-run, ${count("lead_persists")} lead(s) persisting, ${count("skipped")} skipped (analyzer unavailable/unadmitted).\n`;
  }

  if (!combinedTest.passed) {
    reportContent += `\n## Combined Test Suite Failure\n\nThe full test suite failed after remediation. No items with a resolved status were available to re-block, so the run completed, but the following failure was recorded:\n\n`;
    if (combinedTest.output) reportContent += `\`\`\`\n${combinedTest.output}\n\`\`\`\n`;
  }

  // THE LANDING GATES. Every discovered gate is reported, not only the failures:
  // a reader has to be able to tell "the tree-wide gates ran and passed" from
  // "no gate was ever run", and an absent gate set is a real fact about a target
  // repository that declares none (see `verifyLandingGates`).
  reportContent += `\n## Landing Gates\n\n`;
  if (landingGates.commands.length === 0) {
    reportContent +=
      "No landing gates were discovered: this repository's `package.json` scripts declare none of the gate roles this tool knows. The per-item required tests were the only checks run at this close.\n";
  } else {
    for (const gate of landingGates.gates) {
      reportContent += `- \`${gate.command}\` — ${gate.passed ? "passed" : "**FAILED**"}${gate.refuses ? ` (refuses ${gate.refuses})` : ""}\n`;
      if (!gate.passed) {
        if (gate.spawn_error) reportContent += `  - ${gate.spawn_error}\n`;
        if (gate.output) reportContent += `\n\`\`\`\n${gate.output}\n\`\`\`\n`;
      }
    }
  }

  // Opt-in worker reflections, aggregated into the same "Process Feedback"
  // section audit-code renders (parity). Empty → no section.
  const feedbackLines = renderProcessFeedbackSection(reflections);
  if (feedbackLines.length > 0) {
    reportContent += `\n${feedbackLines.join("\n")}`;
  }

  return reportContent;
}

/**
 * {@link cleanupTempBranchesAndArtifacts}'s result — lets a caller observe a
 * cleanup residue programmatically rather than only through console/log
 * output. Absent (`{}`) on a clean removal, a not-fully-green close (nothing
 * was attempted), or a final-state-persist failure alone.
 */
export interface CleanupResult {
  /**
   * Set to the artifacts directory path when its recursive removal failed
   * after an otherwise fully-green close — the caller must remove it
   * manually. The same fact is also written to the durable structured run log
   * (`runLogger`) and to the console; this field is what surfaces it in the
   * function's OWN returned result too, so a caller does not have to parse
   * log/console output to detect the residue.
   */
  artifacts_residue?: string;
}

/**
 * Persist the completed state and clean up the artifact directory.
 *
 * The artifacts directory is only deleted on a fully-green close (no blocked
 * items, combined + e2e tests passed, EVERY declared landing gate passed, and
 * the closing action genuinely completed — succeeded, or was the
 * `action === "none"` no-op). When the run is not fully green — e2e failed,
 * combined test failed, a landing gate failed, an item is blocked, or the
 * closing action failed OR was skipped without completing — the artifacts
 * directory is preserved for diagnosis.
 *
 * A repository that declares NO landing gate leaves `landingGates.passed` at
 * its vacuous `true`, so the leg narrows nothing for a target it does not
 * apply to — the same rule the combined-suite leg follows for a run with no
 * configured suite.
 */
export async function cleanupTempBranchesAndArtifacts(
  options: OrchestratorOptions,
  completeState: RemediationState,
  combinedTest: CombinedTestResult,
  e2eResult: E2eTestResult,
  closingResult: ClosingResult,
  runLogger?: RunLogger,
  landingGates: LandingGateVerifyOutcome = { commands: [], gates: [], passed: true },
  sourceOutcomes: RemediationOutcomesReport = buildRemediationOutcomesReport(completeState, closingResult),
): Promise<CleanupResult> {
  // Write final state before deleting the artifacts directory so the completion
  // is durable even if cleanup partially fails.
  try {
    const { StateStore } = await import("../state/store.js");
    const store = new StateStore(options.artifactsDir);
    await store.saveState(completeState);
  } catch (error) {
    // Non-fatal — we still return complete. But NEVER silently (OBS-89a57cbd):
    // a failed final-state persist means a restart resumes from the PRE-close
    // state and re-runs closing actions (re-commit/re-push) with no operator
    // clue why. Surface it on the console and in the structured run log.
    // kind:"error" — see the matching note on the branch-cleanup catch above:
    // this is a run-level diagnostic (the final-state persist itself failed),
    // never a per-finding outcome, so it must not share the "outcome" kind
    // the per-finding loop below emits.
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `Failed to persist the final remediation state — a resumed run may re-execute closing actions: ${reason}`,
    );
    runLogger?.event({
      phase: "close",
      kind: "error",
      obligation: "closing",
      note: `Final state persist FAILED (run still reported complete): ${reason}`,
    });
  }

  // Only delete artifacts on a fully-green close. When any test or closing
  // action failed, preserve the directory for diagnosis.
  //
  // Force-close guard: a `blocked` or `abandoned` item means the run did NOT
  // fully succeed. It reaches close that way through triage exhausting an item's
  // retries, an operator halt, or the force-close backstop converting a
  // still-non-terminal item — NOT through the tool-owned gate, which no longer
  // mutates item statuses at all (a red pauses the run instead of re-blocking or
  // abandoning). The guard is unchanged and still needed; only its causes are.
  // Such a run must never be "landed green" (artifacts deleted as if complete); a
  // vacuous/unset plan.test_command (combinedTest vacuously passing) cannot mask
  // it. Preserve
  // the artifacts so the partial outcome is diagnosable. The predicate is
  // single-sourced in itemStatus so this guard cannot drift from the seam that
  // produces the statuses it defends against.
  const anyBlocked = Object.values(completeState.items ?? {}).some((it) =>
    isUnsuccessfulEndStatus(it.status),
  );
  // A closing action genuinely completed only per the single-sourced
  // classification (see closingActionCompleted): success, or the skipped
  // action=none no-op — never a skipped non-none close.
  const closingCompleted = closingActionCompleted(closingResult);
  const unresolvedSources = sourceOutcomes.outcomes.some(outcome => ["blocked", "pending", "deferred"].includes(outcome.outcome));
  const unresolvedRequest = sourceOutcomes.request_outcome && ["blocked", "pending", "deferred"].includes(sourceOutcomes.request_outcome.status);
  const unresolvedUnits = (completeState.plan?.units ?? []).some(unit => {
    const item = completeState.items?.[unit.id];
    return !item || (!isVerifiedCompleteStatus(item.status) && !isSkipStatus(item.status));
  });
  const fullyGreen =
    combinedTest.passed &&
    e2eResult.passed &&
    landingGates.passed &&
    closingCompleted &&
    !anyBlocked &&
    !unresolvedSources &&
    !unresolvedRequest &&
    !unresolvedUnits;

  if (!fullyGreen) {
    runLogger?.event({
      phase: "close",
      kind: "artifact_write",
      obligation: "closing",
      artifact: options.artifactsDir,
      note: `Artifacts directory preserved for diagnosis (combinedTest.passed=${combinedTest.passed}, e2e.passed=${e2eResult.passed}, landingGates.passed=${landingGates.passed}, closing=${closingResult.status}, closingAction=${closingResult.action}, anyBlocked=${anyBlocked}, unresolvedSources=${unresolvedSources}, unresolvedUnits=${unresolvedUnits})`,
    });
    return {};
  }

  // Archive the friction close-out record with the promoted deliverables BEFORE
  // deleting the artifacts dir — same property as the audit side's
  // promoteFinalAuditReport: the record must outlive the run it walked.
  //
  // AN ARCHIVE THAT DID NOT HAPPEN MUST NOT LICENSE THE DELETE. `archiveFrictionRecords`
  // deliberately PROPAGATES an unlistable directory rather than reporting it as an
  // empty one (see `listFrictionRecordFilenames`), because `[]` reads as "nothing
  // to archive" — and the rm below would then destroy records the archive never
  // saw. The two sides were built the same errno-blind way once (the CP-NODE-3
  // residual); the audit promote walk refuses the delete outright, and so does
  // this one. The difference is what "refuse" costs here: this is the run's own
  // scratch under `.audit-tools/`, deleted only on a fully-green close, and a
  // non-green close already preserves it — so the answer is to KEEP the
  // directory and say why, not to abort a close that has already written its
  // report.
  const { archiveFrictionRecords, outputDirFor } = await import("audit-tools/shared");
  try {
    await archiveFrictionRecords({
      artifactsDir: options.artifactsDir,
      destDir: outputDirFor(options.artifactsDir),
      prefix: "remediation-friction",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      "Friction close-out records could not be enumerated, so the artifacts " +
        "directory is kept rather than deleted: " +
        reason,
    );
    runLogger?.event({
      phase: "close",
      kind: "artifact_write",
      obligation: "closing",
      artifact: options.artifactsDir,
      note: `friction archive listing failed — artifacts dir preserved (records may exist and were NOT archived): ${reason}`,
    });
    return { artifacts_residue: options.artifactsDir };
  }
  try {
    const { rm } = await import("node:fs/promises");
    await rm(options.artifactsDir, { recursive: true, force: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      "Failed to clean up artifacts directory — manual removal may be needed.",
    );
    runLogger?.event({
      phase: "close",
      kind: "artifact_write",
      obligation: "closing",
      artifact: options.artifactsDir,
      note: `Failed to clean up artifacts directory (manual removal may be needed): ${reason}`,
    });
    return { artifacts_residue: options.artifactsDir };
  }
  return {};
}

/**
 * Build a VerificationReport from the post-remediation state. One
 * FindingVerificationTrace per terminal finding, with trace entries for:
 *   - combined test suite result (task kind)
 *   - each item's verification evidence from result files (file kind)
 *   - closing action outcome (command kind)
 *
 * Overall status is "passed" when combined tests passed and all resolved
 * items have at least one passing trace. "failed" otherwise.
 */
export function buildVerificationReport(
  state: RemediationState,
  options: OrchestratorOptions,
  closingResult: ClosingResult,
  combinedTest: CombinedTestResult,
): VerificationReport {
  const units = (state.plan?.units ?? []).map(unit => {
    const item = state.items?.[unit.id];
    const passed = !!item && isVerifiedCompleteStatus(item.status) && combinedTest.passed;
    const skipped = !!item && isSkipStatus(item.status);
    const traces: VerificationTraceEntry[] = [{
      trace_id: `${unit.id}:combined-tests`, kind: "task", label: combinedTest.suite_name ?? "combined test suite",
      evidence: [combinedTest.ran ? combinedTest.passed ? "Suite passed" : combinedTest.output : "No combined suite ran"],
      status: combinedTest.ran && combinedTest.passed ? "passed" : "failed",
    }];
    for (const requirementId of unit.requirement_ids) traces.push({
      trace_id: `${unit.id}:requirement:${requirementId}`, kind: "requirement", label: requirementId,
      evidence: [...(item?.host_result_evidence ?? [])], status: passed ? "passed" : "failed",
    });
    for (const [i, command] of unit.required_tests.entries()) traces.push({
      trace_id: `${unit.id}:command:${i}`, kind: "command", label: command,
      evidence: [...(item?.host_result_evidence ?? [])], status: passed ? "passed" : "failed",
    });
    const verificationResultPath = join(options.artifactsDir, `result_${unit.id}_verify_code_against_documentation.json`);
    if (existsSync(verificationResultPath)) {
      try {
        const result = JSON.parse(readFileSync(verificationResultPath, "utf8"));
        const evidence = Array.isArray(result.reason) ? result.reason.filter((v: unknown) => typeof v === "string") : [];
        traces.push({trace_id: `${unit.id}:verify-doc`, kind:"file", label:"verify_code_against_documentation", evidence, status:evidence.length ? "passed":"failed"});
      } catch { /* malformed optional evidence cannot establish a passing trace */ }
    }
    if (closingResult.action !== "none") traces.push({
      trace_id: `${unit.id}:closing`, kind: "command", label: `closing action: ${closingResult.action}`,
      evidence: [`status=${closingResult.status}`], status: closingActionCompleted(closingResult) ? "passed" : "failed",
    });
    return {unit_id:unit.id, source_finding_ids:[...unit.source_finding_ids], traces,
      overall_status: skipped ? "skipped" as const : passed ? "passed" as const : "failed" as const};
  });
  const outcomeReport = buildRemediationOutcomesReport(state, closingResult);
  const findings: FindingVerificationTrace[] = outcomeReport.outcomes.map(outcome => ({
    finding_id: outcome.finding_id,
    traces: [
      ...units.filter(unit => unit.source_finding_ids.includes(outcome.finding_id)).flatMap(unit => unit.traces),
      ...(outcome.evidence ? [{trace_id:`${outcome.finding_id}:source-verification`, kind:"file" as const,
        label:outcome.evidence.mechanism, evidence:[`${outcome.evidence.file}:${outcome.evidence.line}`,outcome.evidence.mechanism_detail ?? ""],
        status:outcome.outcome === "verified_already_fixed" || outcome.outcome === "refuted" ? "passed" as const : "failed" as const}] : []),
      ...(outcome.reason ? [{trace_id:`${outcome.finding_id}:source-disposition`,kind:"task" as const,label:outcome.outcome,evidence:[outcome.reason],status:"failed" as const}] : []),
    ],
    overall_status: outcome.outcome === "ignored" || outcome.outcome === "inappropriate" ? "skipped"
      : ["blocked", "pending", "deferred"].includes(outcome.outcome) ? "failed" : "passed",
  }));
  const requestUnfinished = outcomeReport.request_outcome && ["blocked","pending","deferred"].includes(outcomeReport.request_outcome.status);
  const overallPassed = !requestUnfinished && combinedTest.passed && closingActionCompleted(closingResult) &&
    units.every(unit => unit.overall_status !== "failed") && findings.every(finding => finding.overall_status !== "failed");
  return {
    contract_version: CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION,
    ...(state.plan?.goal_id ? {goal_id:state.plan.goal_id} : {}),
    findings, units,
    overall_status: overallPassed ? "passed" : "failed",
    created_at: new Date().toISOString(),
  };
}

// sites-pinned: tests/remediate/close-plan-authority.test.ts
/** Closing observes reviewed context, allowing only changes explained by accepted landed work. */
async function assertClosingPlanAuthority(state: RemediationState, options: OrchestratorOptions): Promise<void> {
  const approved = await assertApprovedRuntimePlan(options.artifactsDir, state);
  const accepted = approved.canonical.plan.units.flatMap(unit => {
    const item = state.items?.[unit.id];
    return item?.host_landed_commit ? [{ allowed_files: [...unit.allowed_files], landed_commit: item.host_landed_commit }] : [];
  });
  const issues = await executionPlanContextIssues(options.root, approved.canonical, accepted);
  if (issues.length) throw new RemediationPlanAuthorityError(issues.join("; "));
}

export async function runClosePhase(
  state: RemediationState,
  options: OrchestratorOptions,
  runLogger?: RunLogger,
): Promise<RemediationState> {
  console.log("Running Close Phase...");

  if (!state.plan || !state.items || !state.closing_plan) {
    throw new Error(
      "Cannot run close phase: missing plan, items, or closing_plan from state.",
    );
  }

  // Check before preview, verification, state mutation, action execution or promotion.
  await assertClosingPlanAuthority(state, options);

  // CDC-19 (advisory): a planned finding with no corresponding item in
  // state.items would be left uncounted by every module's INV-COVERAGE join
  // — a module that was blocked or never dispatched must not silently vanish
  // from the coverage set. Diagnostic-only: never throws, and a no-op unless a
  // runLogger is actually wired, so it changes nothing for a caller that
  // doesn't ask for it.
  {
    const findingIds = new Set((state.plan.units ?? []).map((unit) => unit.id));
    const itemIds = new Set(Object.keys(state.items));
    const uncounted = [...findingIds].filter((id) => !itemIds.has(id));
    if (uncounted.length > 0) {
      runLogger?.event({
        phase: "close",
        kind: "error",
        obligation: "closing",
        note: `${uncounted.length} planned execution unit(s) have no corresponding item in state.items and would be left uncounted by every module's coverage join: ${uncounted.slice(0, 10).join(", ")}`,
      });
    }
  }

  // 1. Check whether closing action requires user confirmation (preview).
  // When not pre-authorized and action is confirmable, generate the file list +
  // commit message, attach them to closing_plan.closing_action_preview, and
  // return the updated state so the host can present the preview. The host sets
  // closing_plan.pre_authorized = true before the next next-step call.
  const preview = await checkClosingPreview(state, options);
  if (preview) {
    runLogger?.event({
      phase: "close",
      kind: "state",
      obligation: "closing",
      note: `Closing action '${state.closing_plan.action}' requires confirmation before proceeding — preview attached, awaiting pre_authorized.`,
    });
    const updatedClosingPlan = { ...state.closing_plan, closing_action_preview: preview };
    return { ...state, closing_plan: updatedClosingPlan };
  }

  // 2. Acceptance begins only after preview/host pauses. The floor owns its
  // failure: stop before the combined-suite triage branch can re-block items.
  const acceptance = await runCloseAcceptance({
    state, options, runLogger,
    runCombined: () => runCombinedTestSuite(state, options),
  });
  if (acceptance.gate && !acceptance.gate.passed) {
    await options.onFinalGateRed?.(acceptance.gate);
    return state;
  }
  const combinedTest = acceptance.combinedTest ?? await runCombinedTestSuite(state, options);
  if (!combinedTest.passed) {
    console.log("Full test suite failed. Transitioning back to triage.");
    if (blockResolvedItemsOnCombinedFailure(state, combinedTest.output)) {
      runLogger?.event({
        phase: "close",
        kind: "state",
        obligation: "closing",
        note: "Combined test suite failed — re-blocked resolved item(s), transitioning to triage.",
      });
      return { ...state, status: "triage" };
    }
    console.warn(
      "Combined test suite failed but no resolved items to re-block — completing with test failure recorded in report.",
    );
  }

  // 2b. Item C — mechanical re-verify of analyzer-born leads: re-run the same
  // pinned analyzer per provenance-carrying resolved item and check the exact
  // content-anchored identity no longer fires. Attribution is exact, so a
  // persisting lead re-blocks only ITS item (objective evidence to triage) —
  // never the whole resolved set the way a suite-level red must.
  const analyzerVerify = await verifyAnalyzerLeads({
    state,
    root: options.root,
    ...(options.analyzerLeadVerifyOverrides
      ? { overrides: options.analyzerLeadVerifyOverrides }
      : {}),
  });
  if (analyzerVerify.ran) {
    const now = new Date().toISOString();
    for (const [findingId, verdict] of Object.entries(analyzerVerify.verdicts)) {
      state.source_verifications ??= {};
      const source = state.plan.findings.find(finding => finding.id === findingId)!;
      state.source_verifications[findingId] = bindSourceVerification(
        state.source_verifications[findingId],
        { review_revision_sha256: state.plan.review_revision_sha256, source_sha256: contentSha256(source) },
        { mechanical_verification: verdict },
      );
      if (verdict.status === "lead_persists") {
        for (const unit of state.plan.units.filter(unit => unit.source_finding_ids.includes(findingId))) {
          const item = state.items[unit.id];
          if (!item || !isVerifiedCompleteStatus(item.status)) continue;
          item.status = "blocked";
          item.completed_at = now;
          item.failure_reason = `Mechanical re-verify: analyzer '${verdict.analyzer_id}' still reports source ${findingId}. Rework the linked execution unit.`;
        }
      }
    }
    if (analyzerVerify.persisting.length > 0) {
      console.log(
        `Analyzer lead re-verify: ${analyzerVerify.persisting.length} lead(s) persist ` +
        `(${analyzerVerify.persisting.join(", ")}). Transitioning back to triage.`,
      );
      runLogger?.event({
        phase: "close",
        kind: "state",
        obligation: "closing",
        note: `Mechanical re-verify: ${analyzerVerify.persisting.length} analyzer lead(s) persist (${analyzerVerify.persisting.join(", ")}) — transitioning to triage.`,
      });
      return { ...state, status: "triage" };
    }
  }

  // 2c. CDC-25/CDC-26 — the read-at-HEAD evidence leg: the PRODUCER for the two
  // evidence-bearing terminal dispositions (`verified_already_fixed` /
  // `refuted`), which were otherwise reachable only through a hand-transcribed
  // document no code reads. For each item the host resolved `resolved_no_change`
  // it re-reads the finding's own cited anchor at the AUDIT's commit and at HEAD
  // and records the file/line/mechanism triple plus its module stamp, so the
  // writer can emit a real disposition rather than a generic one.
  //
  // THE AUDIT'S COMMIT is `state.plan.audit_read` — the findings contract's
  // `audit_read`, stamped by the tool at plan application. It is read from
  // state, never passed in, so no caller can substitute a remediation-side
  // commit (a span absent at the remediation's own baseline can be a fix made
  // since the audit, not a misquote). With none recorded the leg withholds every
  // candidate and records nothing. An item whose finding carries too little evidence to
  // decide keeps the disposition it already had — the leg withholds and says
  // why, it never guesses. No qualifying item is a no-op.
  const headEvidence = await verifyHeadEvidenceAgainstFindings({
    state,
    root: options.root,
    ...(options.headEvidenceOverrides
      ? { overrides: options.headEvidenceOverrides }
      : {}),
  });
  reportHeadEvidence(headEvidence, runLogger);

  // 3. Run end-to-end tests on the fully merged post-remediation state. Mirrors
  // the combined-test-failure branch's own guard above: a failure transitions
  // to triage ONLY when something was actually re-blocked for triage to act
  // on, never unconditionally (a failure with zero verified-complete items has
  // nothing to re-block, so an unconditional triage transition would enter a
  // state with no newly-blocked item to drive it forward).
  const e2eResult = await runE2eTests(state, options);
  if (!e2eResult.passed) {
    console.log("End-to-end tests failed. Transitioning back to triage.");
    if (blockResolvedItemsOnCombinedFailure(state, e2eResult.output)) {
      runLogger?.event({
        phase: "close",
        kind: "state",
        obligation: "closing",
        note: "End-to-end tests failed — re-blocked resolved item(s), transitioning to triage.",
      });
      return { ...state, status: "triage" };
    }
    console.warn(
      "End-to-end tests failed but no resolved items to re-block — completing with e2e failure recorded in report.",
    );
  }

  // 3b. The LANDING GATES, on the now-fully-merged tree. `targeted_commands` is
  // module-scoped, so three landings reddened CI after green per-item runs on
  // gates no per-item command covers (a tree-wide path-guard suite, a
  // case-sensitivity assertion, an import cycle `check:depgraph` refuses). This
  // leg runs each discovered gate ONCE, here, where the merged-tree fact it
  // states actually exists — see `closeVerifyLandingGates.ts` for why it is not
  // folded into the per-item required tests.
  //
  // A red gate does NOT re-block items the way a red suite does: the gates are
  // tree-wide, so a failure is attributable to no single item, and guessing one
  // would send a worker to fix another item's fault. It folds into `fullyGreen`
  // below instead, which is what keeps the artifacts dir — the same treatment a
  // red `combinedTest` gets when it has no items to re-block.
  const landingGates = await verifyLandingGates({
    root: options.root,
    timeoutMs: CLOSING_CHILD_DEADLINE_MS,
    ...(options.landingGateVerifyOverrides
      ? { overrides: options.landingGateVerifyOverrides }
      : {}),
  });
  if (landingGates.commands.length === 0) {
    console.log("No landing gates declared by this repository's package.json scripts.");
  } else {
    for (const gate of landingGates.gates) {
      console.log(
        `Landing gate ${gate.command}: ${gate.passed ? "passed" : "FAILED"}`,
      );
      if (!gate.passed) {
        runLogger?.event({
          phase: "close",
          kind: "error",
          obligation: "closing",
          note: `Landing gate failed: ${gate.command}${gate.refuses ? ` (${gate.refuses})` : ""}`,
        });
      }
    }
  }

  // Verification may await arbitrary repository commands. Revalidate the same
  // current authority immediately before the consequential closing boundary.
  // Once the authorized action runs, its real outcome is persisted and reported;
  // expected publish/version effects do not retroactively revoke that operation.
  const contractReviews = await readContractReviewOutcomes(options.artifactsDir);
  await assertClosingPlanAuthority(state, options);

  // 4. Execute the closing action and record exact command outcomes before
  // reporting success.
  console.log(`Executing closing action: ${state.closing_plan.action}`);
  const closingResult = await executeClosingAction(state, options);
  await writeJsonFile(
    join(options.artifactsDir, "remediation-closing-result.json"),
    closingResult,
  );

  // 4. Generate remediation-report.md and remediation-report.json
  const entries = collectReportEntries(state, options);

  // Phase 7B: capture per-finding outcomes (surface only), carrying the run's
  // tool-owned gate outcome so the report can say which of executed / scoped-out
  // / disabled / absent this run actually was.
  // The run's recovery record, read HERE — the single point from which both the
  // outcomes contract and the markdown render take it. Read before
  // `cleanupTempBranchesAndArtifacts`, which deletes the artifacts directory
  // (and the ledger under it) on a green close; the value is THREADED into the
  // builders rather than re-read by them, so neither can resurrect a deleted
  // file. A read failure is stated, never laundered into a clean-looking empty
  // set: the alternative makes "the ledger was unreadable" report as "this run
  // was clean", which is the collapse the ledger exists to prevent.
  const recovery = await readRunRecoveryFacts(options.artifactsDir, state);

  // Hydrate original coverage-only sources before ANY outcome or verification
  // projection. Reading them after building outcomes silently loses excluded
  // originals from the otherwise self-contained source report.
  const outcomeCoverage = await buildOutcomeCoverageLedger(state, options);
  if (outcomeCoverage) state.plan_coverage = outcomeCoverage;

  const finalGate = await readFinalGateReport(options.artifactsDir);
  const outcomesReport = buildRemediationOutcomesReport(
    state,
    closingResult,
    finalGate,
    recovery,
    contractReviews,
  );
  // No run-log line for the gate here ON PURPOSE: the gate already records its
  // own outcome at evaluation time (`recordFinalGateOutcome`), so a second line
  // at close would be a duplicate — and `kind: "outcome"` at close means "one
  // per finding", which a run-level line would quietly break.
  // One run-log line per outcome, plus a summary line for the artifact write.
  for (const outcome of outcomesReport.outcomes) {
    runLogger?.event({
      phase: "close",
      kind: "outcome",
      obligation: "closing",
      note: `${outcome.finding_id} [${outcome.lens}] → ${outcome.outcome} (rework ${outcome.rework_count})`,
    });
  }

  const endedAt = new Date().toISOString();
  // Workers may have appended opt-in reflections during document/implement
  // dispatch; parse leniently (malformed lines skipped) and surface them in the
  // report. Workers own the file — it is read-only here.
  const feedbackText = await readOptionalTextFile(
    join(options.artifactsDir, AGENT_FEEDBACK_FILENAME),
  );
  const closeFeedback = feedbackText
    ? parseReflectionsNdjson(feedbackText)
    : { reflections: [], discarded: [] };
  reportDiscardedReflections(closeFeedback.discarded, "remediate-code");
  const reportContent = buildRemediationReportMarkdown(
    state,
    entries,
    closingResult,
    e2eResult.ran ? e2eResult.passed : undefined,
    outcomesReport,
    combinedTest,
    closeFeedback.reflections,
    landingGates,
  );

  const outcomesFile: RemediationOutcomesReport & {
    started_at?: string;
    ended_at: string;
    step_count: number;
    combined_test_result: {
      passed: boolean;
      suite_name?: string;
      duration_ms: number;
      failure_summary?: string;
    };
    e2e_result?: { passed: boolean };
    closing_result: {
      action: ClosingAction;
      status: string;
      commands: ClosingCommandResult[];
      leftover_files?: string[];
    };
    plan_coverage?: OutcomeCoverageLedger;
  } = {
    ...outcomesReport,
    ...(state.started_at ? { started_at: state.started_at } : {}),
    ended_at: endedAt,
    step_count: state.step_count ?? 0,
    combined_test_result: {
      passed: combinedTest.passed,
      ...(combinedTest.suite_name ? { suite_name: combinedTest.suite_name } : {}),
      duration_ms: combinedTest.duration_ms,
      ...(combinedTest.output ? { failure_summary: combinedTest.output } : {}),
    },
    ...(e2eResult.ran ? { e2e_result: { passed: e2eResult.passed } } : {}),
    closing_result: {
      action: state.closing_plan.action,
      status: closingResult.status,
      commands: closingResult.commands,
      // Untouched-user-dirt set collectStagingFiles left alone (never staged) —
      // see ClosingResult.leftover_files / ClosingActionPreviewSchema.leftover_files.
      ...(closingResult.leftover_files?.length
        ? { leftover_files: closingResult.leftover_files }
        : {}),
    },
    ...(outcomeCoverage ? { plan_coverage: outcomeCoverage } : {}),
  };

  // Serialized-output boundary: the close phase is the producer of
  // `remediation-outcomes.json`, so it runs its own finished value through the
  // owning schema before persisting it. The on-disk shape is a superset of the
  // shared subset, so the non-strict schema tolerates the run-level extras and
  // refuses only a missing/malformed REQUIRED field of the owning contract —
  // here, BEFORE the write, so a refusal leaves none of the four artifacts
  // written for a consumer to find much later.
  assertValidRemediationOutcomesReport(outcomesFile);

  const outputDir = dirname(options.artifactsDir);

  // 5. Write verification_report.json for the contract pipeline closing phase.
  const verificationReport = buildVerificationReport(state, options, closingResult, combinedTest);
  const verificationReportPath = join(outputDir, "verification_report.json");
  const completeState: RemediationState = { ...state, status: "complete" };

  await Promise.all([
    writeTextFile(join(outputDir, "remediation-report.md"), reportContent),
    writeJsonFile(join(outputDir, "remediation-outcomes.json"), outcomesFile),
    writeJsonFile(verificationReportPath, verificationReport),
    writeJsonFile(join(outputDir, "remediation-state.complete.json"), completeState),
  ]);
  runLogger?.event({
    phase: "close",
    kind: "artifact_write",
    obligation: "closing",
    artifact: "remediation-outcomes.json",
    note: `${outcomesReport.total} outcome(s)`,
  });
  runLogger?.event({
    phase: "close",
    kind: "artifact_write",
    obligation: "closing",
    artifact: "verification_report.json",
    note: `overall_status=${verificationReport.overall_status}, findings=${verificationReport.findings.length}`,
  });
  runLogger?.event({
    phase: "close",
    kind: "artifact_write",
    obligation: "closing",
    artifact: "remediation-state.complete.json",
    note: "complete remediation state preserved for retry/recovery",
  });
  console.log("Remediation report generated.");

  // 6. Clean up temporary branches and artifact directory (only when fully green).
  await cleanupTempBranchesAndArtifacts(
    options,
    completeState,
    combinedTest,
    e2eResult,
    closingResult,
    runLogger,
    landingGates,
    outcomesReport,
  );

  return completeState;
}
