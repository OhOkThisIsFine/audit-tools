// sites-pinned: tests/audit-smoke.test.mjs
import type { Finding } from "../types.js";
import type { AuditScopeManifest } from "../types/auditScope.js";
import type {
  CharterPacketCoverage,
  IntentCheckpoint,
  SubmissionLedgerEvent,
} from "audit-tools/shared";
import type { ConceptualReviewAdjudication } from "../types/conceptualAdjudication.js";
import {
  degradedAnalyzerEntries,
  type AnalyzerCapabilityRecord,
} from "../types/analyzerCapability.js";
import type { CharterPacketArchiveRow } from "../orchestrator/charterPacketArchive.js";
import type {
  AuditFindingsReport,
  Finding as SharedFinding,
  FindingTheme,
  SynthesisNarrative,
  WorkBlockSeam,
} from "audit-tools/shared";
import {
  AUDITOR_REPORT_MARKER,
  renderProcessFeedbackSection,
  renderFindingBlockLines,
  compareCodeUnits,
  countBy,
  isIngestEvent,
  SEVERITIES,
  uniqueSorted,
  type AgentReflection,
  type LensCoverageEntry,
  type MeasuredOutcome,
} from "audit-tools/shared";
import type { WorkBlock } from "./workBlocks.js";
import {
  type QuestionReviewReport,
  canonicalQuestionFindingId, questionClaimKey, questionPartHasSupport,
} from "../../shared/types/questionReviewReport.js";

import { severityRank, confidenceRank } from "../../shared/types/lens.js";

const CONCEPTUAL_ATTRIBUTION_IDS = Symbol("conceptual-attribution-ids");

type ConceptualAttributionIdMap = ReadonlyMap<string, string>;
type ConceptualAttributionCarrier = {
  [CONCEPTUAL_ATTRIBUTION_IDS]?: ConceptualAttributionIdMap;
};
/**
 * The findings {@link applyCriticalEvidenceBar} ran over on THIS report object,
 * so the renderer's disclosure line states that the bar ran rather than
 * inferring it from the payload it is printing (F2).
 *
 * A non-enumerable-by-convention symbol rather than a wire field: this is
 * process-local provenance for a render decision, and persisting it into
 * `audit-findings.json` would make an internal marker part of the machine
 * contract.
 *
 * Re-deriving the answer from `severity_downgraded_from` was the tempting
 * alternative and it answers a different question — "did the bar change
 * anything?" A report whose criticals all cleared the bar would then be
 * indistinguishable from one where the bar never ran, which is the confusion
 * this exists to end.
 */
const CRITICAL_EVIDENCE_BAR = "substantive-evidence" as const;
const CRITICAL_EVIDENCE_BAR_APPLIED = Symbol("critical-evidence-bar-applied");
type CriticalBarCarrier = {
  [CRITICAL_EVIDENCE_BAR_APPLIED]?: readonly Finding[];
};

/** Fields consumed by the canonical and legacy Markdown report renderers. */
export interface RenderableAuditReport {
  question_review?: QuestionReviewReport;
  summary: AuditReportSummary;
  findings: SharedFinding[];
  work_blocks: WorkBlock[];
  work_block_seams: WorkBlockSeam[];
  /** Tool-REFUTED findings excluded from the admitted set (B4); rendered separately. */
  quarantined_findings?: SharedFinding[];
  themes?: FindingTheme[];
  executive_summary?: string;
  top_risks?: string[];
}

export interface AuditReportSummary {
  finding_count: number;
  work_block_count: number;
  severity_breakdown: Record<string, number>;
  lens_breakdown?: Record<string, number>;
  audited_file_count: number;
  excluded_file_count: number;
  runtime_validation_status_breakdown: Record<string, number>;
  /**
   * Per-status counts (grounded/ungrounded) of the S7 grounding pass. Optional
   * so the shared `AuditFindingsSummary` (which also makes it optional) stays
   * assignable to this render shape; absent when no finding carried a verdict.
   */
  grounding_status_breakdown?: Record<string, number>;
  /**
   * Per-status counts of the judge's defect-presence claim over the findings.
   * Optional for the same reason as the grounding breakdown — the shared
   * `AuditFindingsSummary` makes it optional, so this render shape must too.
   */
  verification_status_breakdown?: Record<string, number>;
  /**
   * What every selected lens delivered. Optional for the same reason as the
   * breakdowns above — the shared `AuditFindingsSummary` makes it optional, so
   * this render shape must too — and absent on a run that carried no selection.
   */
  lens_coverage?: LensCoverageEntry[];
}

function formatSeverityList(summary: Record<string, number>): string {
  const parts = SEVERITIES
    .filter((severity) => (summary[severity] ?? 0) > 0)
    .map((severity) => `${severity}: ${summary[severity]}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function formatCountList(summary: Record<string, number>): string {
  const parts = Object.entries(summary)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, count]) => `${key}: ${count}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * Merge an LLM synthesis narrative into the canonical findings report: tag each
 * covered finding with its (first-claiming) `theme_id`, and attach the
 * executive summary / top risks. Deterministic and idempotent — the same
 * narrative yields the same report.
 *
 * Uniform id-join contract, both halves REFUSING (owner review 2026-09-17,
 * docs/reviews/prompt-refinement-2026-09-13.md prompt 14):
 *
 *  • a `finding_ids` entry that names no finding in the report refuses the whole
 *    narrative (throws, naming the unknown ids) — never a silent drop, which
 *    would present a theme as covering findings it does not; and
 *  • a finding claimed by TWO themes refuses it too. That case was previously
 *    repaired in silence: the first theme to list the id kept it and the later
 *    theme had it stripped, so the stored narrative differed from the submitted
 *    one and nobody was told. It also made the result ORDER-DEPENDENT, which the
 *    convergence obligation (legacy tests/audit/synthesis-narrative-convergence.test.ts)
 *    wants the narrative free of: two semantically identical narratives supplied
 *    in different theme order would resolve the overlap differently.
 *
 * A repeat of one id INSIDE a single theme is not an overlap — it breaks no
 * rule — so it is deduplicated without comment.
 */
export function applyNarrative(
  report: AuditFindingsReport,
  narrative: SynthesisNarrative,
): AuditFindingsReport {
  const validFindingIds = new Set(report.findings.map((finding) => finding.id));
  const themeByFinding = new Map<string, string>();
  const themes: FindingTheme[] = [];

  const unknownIds = (narrative.themes ?? []).flatMap((theme) =>
    (theme.finding_ids ?? []).filter((id) => !validFindingIds.has(id)),
  );
  if (unknownIds.length > 0) {
    throw new Error(
      `synthesis narrative refused — theme finding_ids name ${unknownIds.length} unknown ` +
        `finding id(s): ${[...new Set(unknownIds)].join(", ")}. Every finding_ids entry ` +
        `must be one of the ${validFindingIds.size} ids in audit-findings.json (copy ` +
        `exactly, never retype); re-submit the whole narrative.`,
    );
  }

  // Each id's claiming themes, in the order they appear. Deduplicated within a
  // theme first, so a theme that lists one id three times claims it once.
  const claimants = new Map<string, string[]>();
  for (const theme of narrative.themes ?? []) {
    for (const id of new Set(theme.finding_ids ?? [])) {
      const claiming = claimants.get(id);
      if (claiming === undefined) claimants.set(id, [theme.theme_id]);
      else claiming.push(theme.theme_id);
    }
  }
  const overlaps = [...claimants.entries()].filter(
    ([, claiming]) => claiming.length > 1,
  );
  if (overlaps.length > 0) {
    throw new Error(
      `synthesis narrative refused — ${overlaps.length} finding(s) are claimed by more than ` +
        `one theme: ${overlaps
          .map(([id, claiming]) => `${id} (${claiming.join(", ")})`)
          .join("; ")}. A finding belongs to at most one theme; assign each ` +
        `contested finding to the single theme whose root cause explains it, and ` +
        `re-submit the whole narrative.`,
    );
  }

  for (const theme of narrative.themes ?? []) {
    // Unknown ids and cross-theme overlaps were both refused above, so the only
    // repair left is the within-theme repeat, which breaks no rule.
    const findingIds = [...new Set(theme.finding_ids ?? [])];
    themes.push({
      theme_id: theme.theme_id,
      title: theme.title,
      root_cause: theme.root_cause,
      finding_ids: findingIds,
      suggested_fix_pattern: theme.suggested_fix_pattern,
    });
    for (const id of findingIds) {
      themeByFinding.set(id, theme.theme_id);
    }
  }

  const findings = report.findings.map((finding) =>
    themeByFinding.has(finding.id)
      ? { ...finding, theme_id: themeByFinding.get(finding.id) }
      : finding,
  );

  return {
    ...report,
    findings,
    themes,
    executive_summary: narrative.executive_summary,
    top_risks: narrative.top_risks,
  };
}

export interface RenderAuditReportOptions {
  /** Scope manifest for the run; when delta, the report header reports it honestly. */
  scope?: AuditScopeManifest;
  /**
   * Opt-in agent meta-audit reflections to surface in a "Process Feedback"
   * section. Omitted/empty renders nothing. Populated from the parsed
   * `agent-feedback.jsonl` (`bundle.agent_reflections`) by the synthesis
   * executors.
   */
  reflections?: AgentReflection[];
  /** Deep conceptual judge provenance and semantic attribution record. */
  conceptual_adjudication?: ConceptualReviewAdjudication;
  /** Report identity map reconstructed after JSON reload, when needed. */
  conceptual_attribution_id_source?: RenderableAuditReport;
  /**
   * The accepted intent checkpoint; its `excluded_scope` is surfaced in an
   * "Excluded / Out-of-Scope" section so omissions are explicit in the report.
   */
  intent_checkpoint?: IntentCheckpoint;
  /**
   * The submission ledger's events, in arrival order. Rendered as per-kind
   * totals in the process section so a run that drifted and was repaired stays
   * distinguishable, in the DELIVERABLE, from one that was clean on the first
   * try — the fact the ledger exists to preserve, previously readable only by
   * opening the ledger itself.
   */
  submission_ledger?: readonly SubmissionLedgerEvent[];
  /**
   * The graph-enrichment capability record. Read for its DEGRADED entries,
   * which become *Audit Limitations* lines: a requested analyzer that could not
   * run means the dependency graph these findings were reasoned over is the
   * regex floor for those languages, and a report that does not say so lets a
   * weaker run read as a complete one.
   */
  analyzer_capability?: AnalyzerCapabilityRecord;
  /**
   * What each blind charter lane's evidence packet actually delivered, folded
   * from `charter_register.evidence_coverage`. Rendered UNCONDITIONALLY — see
   * {@link renderCharterCoverageSection}.
   */
  charter_evidence_coverage?: readonly CharterPacketCoverage[];
  /**
   * Retention rows for this run's charter packets. A row with `archived: false`
   * is a STATED retention failure and is surfaced beside the coverage figures.
   */
  charter_packet_archive?: readonly CharterPacketArchiveRow[];
}

/**
 * Name the selected lenses with no findings, distinguishing reviewed from uninspected.
 *
 * Rendered whenever a selected lens produced no findings, with its outcome, so
 * `clean` ("reviewed, nothing found") and `not_run` ("no qualifying inspection") stay legible as
 * the different statements they are. Nothing to say — every selected lens
 * produced findings, or no selection was made — renders nothing.
 */
function renderUnexercisedLensLine(
  coverage: readonly LensCoverageEntry[] | undefined,
): string[] {
  const unexercised = (coverage ?? []).filter(
    (entry) => entry.selected && entry.outcome !== "findings" && entry.source_sample === undefined,
  );
  if (unexercised.length === 0) return [];
  const byOutcome = new Map<MeasuredOutcome, string[]>();
  for (const entry of unexercised) {
    const bucket = byOutcome.get(entry.outcome);
    if (bucket) bucket.push(entry.lens);
    else byOutcome.set(entry.outcome, [entry.lens]);
  }
  const parts = [...byOutcome.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(
      ([outcome, lenses]) =>
        `${outcome === "not_run" ? "no qualifying inspection" : "reviewed, no findings"}: ${lenses.join(", ")}`,
    );
  return [`- Selected lenses without findings: ${parts.join("; ")}`];
}

function renderArchitectureSourceSample(coverage: readonly LensCoverageEntry[] | undefined): string[] {
  const entry = coverage?.find((item) => item.lens === "architecture");
  switch (entry?.source_sample) {
    case "not_planned":
      return ["- Architecture source sample: no cross-component workflow sample was planned."];
    case "planned_not_run":
      return ["- Architecture source sample: planned, but no current qualifying result."];
    case "reviewed_no_findings":
      return ["- Architecture source sample: reviewed one bounded workflow with no findings; not a whole-repository inspection."];
    case "reviewed_with_findings":
      return ["- Architecture source sample: reviewed one bounded workflow and reported findings; not a whole-repository inspection."];
    default:
      return [];
  }
}

/**
 * Name every finding the tool re-graded, with the severity it claimed — the
 * report-level statement that a severity in the breakdown was MOVED rather than
 * judged. Empty (one line, no section) when the tool moved nothing.
 *
 * Ordered by id so the line is stable across renders: the findings arrive in
 * merge order, and an incidental order here would churn the report's bytes on
 * every re-synthesis for no change in content.
 */
function renderSeverityDowngradeLine(findings: readonly Finding[]): string[] {
  const downgraded = findings
    .filter((finding) => finding.severity_downgraded_from !== undefined)
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  if (downgraded.length === 0) return [];
  const parts = downgraded.map(
    (finding) =>
      `\`${finding.id}\` ${finding.severity_downgraded_from} → ${finding.severity}`,
  );
  return [
    `- Severity re-graded by the tool: ${parts.join("; ")} — the claimed severity is recorded here; the finding is still admitted and still actionable.`,
  ];
}

/**
 * The *Audit Limitations* body for a degraded graph-enrichment channel.
 *
 * Names each analyzer that was ASKED FOR and could not run, with its own note —
 * the honest per-analyzer row that `analyzer_capability.json` has always carried
 * and that, until now, nothing in the tree ever opened. The scalar roll-up is
 * deliberately not the sentence: it cannot say "1932 edges added AND two
 * analyzers degraded", so the entries are listed rather than summarized.
 */
function renderAnalyzerDegradationLines(
  record: AnalyzerCapabilityRecord | undefined,
): string[] {
  const degraded = degradedAnalyzerEntries(record);
  if (degraded.length === 0) return [];
  return [
    `${degraded.length} language analyzer(s) were requested and could not run, so parser-grade extraction was OFF for them and the weaker deterministic regex floor was used instead. Findings that depend on the dependency graph are correspondingly weaker for these languages:`,
    "",
    ...degraded.map(
      (entry) =>
        `- \`${entry.id}\` (requested \`${entry.setting}\`, resolution \`${entry.resolution}\`)` +
        (entry.note ? ` — ${entry.note}` : ""),
    ),
    "",
  ];
}

/**
 * What the charter lanes were actually GIVEN, per evidence class.
 *
 * This renders UNCONDITIONALLY, deliberately diverging from the drift section
 * above where clean is the expected case and presence is the statement. Here the
 * measured case was 0 of 72 source-comment blocks delivered while the register
 * and the report said nothing at all — so a silent section would leave
 * "complete" indistinguishable from "not measured", which is the exact
 * false-green this block exists to close. A run with no charter layer says so.
 */
function renderCharterCoverageSection(
  coverage: readonly CharterPacketCoverage[],
  archive: readonly CharterPacketArchiveRow[],
  reportVerifiedRetention = false,
): string[] {
  // Its OWN top-level section, not a sub-head of "Process Feedback": coverage is
  // a delivery measurement about the tool's inputs, not feedback about the host —
  // and nesting it there would force that heading to render on every report,
  // silently inverting the drift section's "presence is the statement" contract.
  const lines = ["## Evidence Coverage", "", "### Charter evidence coverage", ""];
  if (coverage.length === 0) {
    lines.push(
      "No charter evidence packets were measured in this run (the charter layer " +
        "is opt-in at a `deep` ceiling). This is a stated absence, not a clean bill.",
      "",
    );
  }
  for (const packet of coverage) {
    lines.push(`- \`${packet.kind}\` channel:`);
    for (const entry of packet.classes) {
      lines.push(
        `  - ${entry.evidence_class}: ${entry.delivered} of ${entry.named} delivered` +
          (entry.omitted.length > 0
            ? ` — omitted: ${entry.omitted
                .map((row) => `${row.path} (${row.reason})`)
                .join(", ")}`
            : ""),
      );
    }
  }
  const unarchived = archive.filter((row) => !row.archived);
  if (unarchived.length > 0) {
    lines.push(
      "",
      "⚠ Packet retention FAILED for " +
        unarchived
          .map((row) => `\`${row.kind}\` (${row.reason ?? "unstated reason"})`)
          .join(", ") +
        ". No verified archive is available for these records.",
    );
  }
  if (reportVerifiedRetention) {
    const retained = archive.filter(row => row.archived);
    if (!retained.length) lines.push("", "No verified charter packet retention record is available.");
    else for (const row of retained) lines.push("", "- Verified retained packet: " + row.kind +
      " (" + row.byte_length + " bytes; SHA-256 " + row.sha256 + ").");
  }
  lines.push("");
  return lines;
}

/**
 * What happened to this run's submissions, when something went wrong.
 *
 * DRIFT is a refusal or a hand repair — never an acceptance, which is the happy
 * path and says nothing. So a run that was clean on the first try renders no
 * section at all, and the section's PRESENCE is itself the statement that this
 * run was not.
 *
 * Counted PER SUBMISSION, not per event, and "repaired" is read off each
 * submission's own trailing state. A bare `rejected N / accepted M` pair would
 * invite reading M as "of those N" while the two totals cover different
 * populations (a gate lane records every acceptance; a host work item records
 * one only where a refusal precedes it), so a fully-repaired run could render
 * as `rejected 3, accepted 0`. Per-submission trailing state has no such
 * ambiguity. Totals are sorted by content, never arrival: a derived summary may
 * sort; the ledger file it derives from may not.
 */
/**
 * What this run actually DISPATCHED, and how much of it came back.
 *
 * The drift section below renders only when something was refused, so a run in
 * which five lanes silently under-delivered — exit 0, nothing written, then
 * re-dispatched until they succeeded — produced zero `rejected` events and read
 * as clean. This is the other half: dispatched versus delivered, per round, so
 * a lane that reported success and wrote nothing is a printed fact rather than
 * something recoverable only from the host's transcript.
 *
 * A dispatch is DELIVERED when its submission has any terminal record other
 * than a `lane_outcome` of `not_run`: an ingest event (the tool consumed it) or
 * an observed outcome. No terminal row at all is `not_run` too — the absence IS
 * the record, never an inference that something arrived.
 */
function renderLaneDeliverySection(
  events: readonly SubmissionLedgerEvent[],
): string[] {
  const dispatched = events.filter((event) => event.kind === "dispatched");
  if (dispatched.length === 0) return [];
  const outcomeById = new Map<string, MeasuredOutcome>();
  for (const event of events) {
    if (event.kind === "lane_outcome" && event.outcome !== undefined) {
      outcomeById.set(event.submission_id, event.outcome);
    } else if (isIngestEvent(event.kind) && !outcomeById.has(event.submission_id)) {
      // The tool ingested it, so it was delivered; the ledger does not record
      // how much was in it, and this must not invent a count.
      outcomeById.set(event.submission_id, "findings");
    }
  }
  const byRound = new Map<string, SubmissionLedgerEvent[]>();
  for (const event of dispatched) {
    const round = event.round_id ?? "";
    const bucket = byRound.get(round);
    if (bucket) bucket.push(event);
    else byRound.set(round, [event]);
  }
  const lines = [
    "### Lane dispatch and delivery",
    "",
    `${dispatched.length} lane(s) were dispatched this run. A dispatched lane that wrote nothing at the bound path the tool declared is recorded \`not_run\` — the absence is the record, not an inference.`,
    "",
  ];
  // Sorted by content, never arrival: a derived summary may sort; the ledger
  // file it derives from may not.
  for (const round of [...byRound.keys()].sort(compareCodeUnits)) {
    const rows = byRound.get(round)!;
    const outcomes = rows.map(
      (event) => outcomeById.get(event.submission_id) ?? "not_run",
    );
    const delivered = outcomes.filter(
      (outcome) => outcome !== "not_run",
    ).length;
    const tally = new Map<MeasuredOutcome, number>();
    for (const outcome of outcomes) {
      tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
    }
    const breakdown = [...tally.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([outcome, count]) => `${outcome} ${count}`)
      .join(", ");
    lines.push(
      `- ${round === "" ? "this run's gate lanes" : `round \`${round}\``}: ` +
        `${delivered} of ${rows.length} delivered (${breakdown})`,
    );
  }
  lines.push("");
  return lines;
}

function renderSubmissionDriftSection(
  events: readonly SubmissionLedgerEvent[],
): string[] {
  const rejected = events.filter((event) => event.kind === "rejected");
  const refusedIds = new Set(rejected.map((event) => event.submission_id));
  const handRepairedIds = new Set(
    events
      .filter((event) => event.kind === "recovered_by_hand")
      .map((event) => event.submission_id),
  );
  if (refusedIds.size === 0 && handRepairedIds.size === 0) return [];
  // Trailing state per submission, over the INGEST events only: a refusal
  // followed by an acceptance or a hand recovery is RESOLVED; one that is still
  // the last word is not. It used to be "everything except `expected`", so a
  // `dispatched` row appended when the still-pending lane was re-materialized
  // would have become the trailing event and made this claim the refusal "was
  // later accepted or re-landed by hand" when nothing had accepted it.
  const trailing = new Map<string, string>();
  for (const event of events) {
    if (!isIngestEvent(event.kind)) continue;
    trailing.set(event.submission_id, event.kind);
  }
  const resolved = [...refusedIds].filter(
    (id) => trailing.get(id) !== "rejected",
  ).length;
  const lines = [
    "### Submission drift and repair",
    "",
    `${refusedIds.size} submission(s) were refused at least once during this run; ` +
      `${resolved} of them were later accepted or re-landed by hand` +
      (handRepairedIds.size > 0
        ? ` (${handRepairedIds.size} by an operator's hand recovery)`
        : "") +
      ". A refusal stays on the record after the later acceptance lands, so this run " +
      "is distinguishable from one that was clean on the first try.",
    "",
  ];
  if (rejected.length > 0) {
    const byCode = new Map<string, number>();
    for (const event of rejected) {
      const code = event.issue_code ?? "unspecified";
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }
    lines.push(
      `- Refusals by reason: ${[...byCode.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([code, count]) => `${code} ${count}`)
        .join(", ")}`,
      "",
    );
  }
  return lines;
}

/**
 * Standardized per-finding render (dogfood note 2). Every finding — admitted,
 * ungrounded, or refuted/quarantined — uses the ONE shared `renderFindingBlock`
 * (single-sourced in `audit-tools/shared` so the auditor report and the
 * remediator's host prompts can never drift apart). Decision-first defaults: a
 * one-line lead, a fixed-order labelled badge body, files trimmed to a `+N more`
 * count and evidence summarized with a pointer to `audit-findings.json` (the full
 * source of truth).
 */
function pushFindingBlock(finding: SharedFinding, lines: string[]): void {
  lines.push(...renderFindingBlockLines(finding));
}

function reportFindingIds(report: RenderableAuditReport): Set<string> {
  return new Set([
    ...report.findings.map((finding) => finding.id),
    ...(report.quarantined_findings ?? []).map((finding) => finding.id),
  ]);
}

export function canonicalizeConceptualAttributionIds(
  report: RenderableAuditReport,
  adjudication: ConceptualReviewAdjudication,
  idSource: RenderableAuditReport = report,
): ConceptualReviewAdjudication {
  const canonicalIds = reportFindingIds(report);
  const idMap = (idSource as RenderableAuditReport & ConceptualAttributionCarrier)[
    CONCEPTUAL_ATTRIBUTION_IDS
  ];
  const resolve = (id: string): string => {
    if (canonicalIds.has(id)) return id;
    const canonicalId = idMap?.get(id);
    if (canonicalId !== undefined && canonicalIds.has(canonicalId)) {
      return canonicalId;
    }
    throw new Error(
      `Conceptual attribution refused: final finding id "${id}" does not resolve ` +
        "to a canonical finding in audit-findings.json.",
    );
  };

  // Translate judge-local IDs only for this report. Accepted adjudication
  // is a premise of systemic review, not a synthesis output.
  const sharesByCanonicalId = new Map<
    string,
    Array<{
      sourceFinalFindingId: string;
      share: ConceptualReviewAdjudication["final_finding_shares"][number];
    }>
  >();
  for (const share of adjudication.final_finding_shares) {
    const sourceFinalFindingId = share.final_finding_id;
    const canonicalId = resolve(sourceFinalFindingId);
    const entries = sharesByCanonicalId.get(canonicalId) ?? [];
    entries.push({ sourceFinalFindingId, share });
    sharesByCanonicalId.set(canonicalId, entries);
  }
  const resolvedFinalFindingShares = [...sharesByCanonicalId.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([canonicalId, entries]) => {
      if (entries.length === 1) {
        return { ...entries[0]!.share, final_finding_id: canonicalId };
      }

      const orderedEntries = [...entries].sort((left, right) =>
        compareCodeUnits(left.sourceFinalFindingId, right.sourceFinalFindingId),
      );
      const contributions = new Map<
        string,
        Array<{
          sourceFinalFindingId: string;
          contribution: ConceptualReviewAdjudication["final_finding_shares"][number]["contributors"][number];
        }>
      >();
      for (const entry of orderedEntries) {
        for (const contribution of entry.share.contributors) {
          const contributorEntries =
            contributions.get(contribution.contributor_id) ?? [];
          contributorEntries.push({
            sourceFinalFindingId: entry.sourceFinalFindingId,
            contribution,
          });
          contributions.set(contribution.contributor_id, contributorEntries);
        }
      }

      const orderedContributions = [...contributions.entries()].sort(
        ([left], [right]) => compareCodeUnits(left, right),
      );
      // Each judge-local final has its own 100% allocation. Once several local
      // finals collapse to one canonical finding, the canonical allocation is
      // their equal-weight mean (a missing contributor contributes 0%). Allocate
      // power-of-two micro-percent units by largest remainder: division back to
      // numbers is exact in binary, every result stays bounded, and the common
      // denominator makes the sum exactly 100 rather than approximately 100.
      // Source-local percentages/rationales remain verbatim in rationale below.
      const unitsPerPercent = 2 ** 20;
      const totalUnits = 100 * unitsPerPercent;
      const allocationInputs = orderedContributions.map(
        ([contributorId, contributorEntries]) => {
          const sourcePercent = contributorEntries.reduce(
            (sum, entry) => sum + entry.contribution.contribution_percent,
            0,
          );
          return { contributorId, contributorEntries, sourcePercent };
        },
      );
      const totalSourcePercent = allocationInputs.reduce(
        (sum, item) => sum + item.sourcePercent,
        0,
      );
      if (!Number.isFinite(totalSourcePercent) || totalSourcePercent <= 0) {
        throw new Error(
          "Conceptual attribution percentage allocation has no positive total.",
        );
      }
      const allocations = allocationInputs.map(
        ({ contributorId, contributorEntries, sourcePercent }) => {
          const exactUnits =
            (sourcePercent / totalSourcePercent) * totalUnits;
          const units = Math.floor(exactUnits);
          return {
            contributorId,
            contributorEntries,
            units,
            remainder: exactUnits - units,
          };
        },
      );
      const remainingUnits =
        totalUnits - allocations.reduce((sum, item) => sum + item.units, 0);
      if (remainingUnits < 0 || remainingUnits > allocations.length) {
        throw new Error(
          "Conceptual attribution percentage allocation exceeded bounded remainder.",
        );
      }
      const remainderOrder = [...allocations].sort(
        (left, right) =>
          right.remainder - left.remainder ||
          compareCodeUnits(left.contributorId, right.contributorId),
      );
      for (let index = 0; index < remainingUnits; index += 1) {
        remainderOrder[index]!.units += 1;
      }
      const contributors = orderedContributions.map(
        ([contributorId, contributorEntries]) => {
          const allocation = allocations.find(
            (item) => item.contributorId === contributorId,
          )!;
          return {
            contributor_id: contributorId,
            source_candidate_ids: uniqueSorted(
              contributorEntries.flatMap(
                (entry) => entry.contribution.source_candidate_ids,
              ),
            ),
            contribution_percent: allocation.units / unitsPerPercent,
            rationale: contributorEntries
              .map(
                (entry) =>
                  `${entry.sourceFinalFindingId} ` +
                  `(${entry.contribution.contribution_percent}%): ` +
                  entry.contribution.rationale,
              )
              .join(" | "),
          };
        },
      );
      return {
        final_finding_id: canonicalId,
        contributors,
      };
    });
  const resolvedCandidateDispositions = adjudication.candidate_dispositions.map(
    (disposition) => ({
      ...disposition,
      target_final_finding_ids: [
        ...new Set(disposition.target_final_finding_ids.map(resolve)),
      ],
    }),
  );

  return {
    ...adjudication,
    final_finding_shares: resolvedFinalFindingShares,
    candidate_dispositions: resolvedCandidateDispositions,
  };
}

function renderConceptualAttributionSection(
  report: RenderableAuditReport,
  accepted: ConceptualReviewAdjudication | undefined,
  idSource: RenderableAuditReport | undefined,
): string[] {
  if (!accepted) return [];
  const adjudication = canonicalizeConceptualAttributionIds(report, accepted, idSource);
  const contributors = new Map(
    adjudication.contributors.map((contributor) => [
      contributor.contributor_id,
      contributor,
    ]),
  );
  const lines = [
    "## Conceptual Review Attribution",
    "",
    `Round: \`${adjudication.round_id}\`. Contribution and modification percentages are judge-authored semantic estimates; tooling verified references, bounds, complete candidate coverage, and 100% contribution totals. \`verification_status\` is likewise judge-authored — the tool enforces that a claim is present, consistent and published, never that it is true. Note that a conceptual finding's \`grounded\` verdict certifies component-path existence ONLY; the defect-presence claim is carried by \`verification_status\`, not by grounding.`,
    "",
    // The aggregate the live run had to be obtained by counting the artifact by
    // hand. Both populations are CANDIDATE-scoped here and are not reconciled
    // with the finding-scoped Summary counts: the post-adjudication grounding
    // quarantine can drop a merged candidate's final finding, so they
    // legitimately differ and each is labelled by its population.
    `- Candidate dispositions: ${formatCountList(adjudication.candidate_disposition_breakdown)}`,
    `- Candidate verification: ${formatCountList(adjudication.candidate_verification_status_breakdown)}`,
    "",
  ];
  for (const finalShare of adjudication.final_finding_shares) {
    lines.push(`### ${finalShare.final_finding_id}`, "");
    for (const share of finalShare.contributors) {
      const contributor = contributors.get(share.contributor_id);
      const label = contributor?.perspective
        ? `${contributor.perspective} (${share.contributor_id})`
        : `Judge (${share.contributor_id})`;
      lines.push(
        `- **${label}: ${share.contribution_percent}%** — ${share.rationale}`,
      );
      if (share.source_candidate_ids.length > 0) {
        lines.push(`  - Source candidates: ${share.source_candidate_ids.join(", ")}`);
      }
    }
    lines.push("");
  }
  lines.push("### Candidate dispositions", "");
  for (const disposition of adjudication.candidate_dispositions) {
    lines.push(
      `- \`${disposition.candidate_id}\` — **${disposition.disposition}**; \`${disposition.verification_status}\`; modified ${disposition.modification_percent}%; targets ${disposition.target_final_finding_ids.join(", ") || "none"}. ${disposition.rationale}${disposition.verification_note ? ` _Verified:_ ${disposition.verification_note}` : ""}`,
    );
  }
  lines.push("");
  return lines;
}

/**
 * Re-escape the C0 control characters a report must never carry as raw bytes.
 *
 * The report is assembled from strings the HOST authored — finding prose,
 * themes, the executive summary, work-block rationales, operator notes — and a
 * contract-valid finding may legitimately contain one: a worker summary
 * carrying a JSON-escaped backspace (a mangled regex word boundary) parses
 * fine, stores fine in `audit-findings.json` (JSON escapes it), and then lands
 * as a literal 0x08 in `audit-report.md`, where `check:control-bytes` correctly
 * reds the build. Scrubbed by hand once already; this is the mechanism instead.
 *
 * The permitted set is EXACTLY the byte gate's — tab, LF, CR — so this
 * function's contract and the gate that checks it cannot disagree: everything
 * else below 0x20 is re-escaped as its printable `\uXXXX` form rather than
 * deleted. Deleting would silently rewrite the worker's text (a mangled word
 * boundary loses the mangling, which is the signal a reader needs); the escape
 * keeps the information AND the file text.
 *
 * Written as a code-point test rather than a control-character regex: the
 * literal bytes are exactly what must not appear in this source file, and a
 * regex range spelling them is the trap being fixed, one level up.
 *
 * Applied as ONE final pass over the assembled document rather than per field:
 * a per-field scrub only covers the fields someone remembered, and the whole
 * point is that an unreviewed host-authored string cannot reach the deliverable
 * raw. It runs at the render boundary, so every present and future field is
 * covered by construction.
 */
export function escapeControlCharacters(markdown: string): string {
  return Array.from(markdown, (character) => {
    const code = character.codePointAt(0)!;
    if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      return character;
    }
    return `\\u${code.toString(16).padStart(4, "0")}`;
  }).join("");
}

export function renderAuditReportMarkdown(
  report: RenderableAuditReport,
  options: RenderAuditReportOptions = {},
): string {
  if (report.question_review !== undefined) return renderQuestionReport(report, report.question_review, options);
  const lines: string[] = [
    AUDITOR_REPORT_MARKER,
    "# Audit Report",
    "",
  ];
  // The findings the bar was applied to, or `undefined` on a report that never
  // went through it — see {@link CRITICAL_EVIDENCE_BAR_APPLIED}.
  const barAppliedFindings = (report as CriticalBarCarrier)[
    CRITICAL_EVIDENCE_BAR_APPLIED
  ];

  if (report.executive_summary && report.executive_summary.trim().length > 0) {
    lines.push("## Executive Summary", "", report.executive_summary.trim(), "");
  }

  lines.push(
    "## Summary",
    "",
    `- Findings: ${report.summary.finding_count}`,
    `- Work blocks: ${report.summary.work_block_count}`,
    `- Severity breakdown: ${formatSeverityList(report.summary.severity_breakdown)}`,
    // Gated on the bar having ACTUALLY RUN over the findings being printed,
    // which is what {@link CRITICAL_EVIDENCE_BAR_APPLIED} records.
    //
    // The previous gate ("a critical exists") was the F2 defect: `cmdResynthesize`
    // renders a promoted record the bar had not yet touched, so the report could
    // claim the bar was enforced beside an un-barred critical. Keyed on the
    // apply-set, the line is printed when a barred report carries a critical —
    // under both draws, including the criticals that CLEARED the bar, which is
    // precisely the set the sentence is about — and omitted on a report that
    // never went through the bar at all. Omission is not a claim: a run with no
    // criticals has nothing to qualify.
    ...(barAppliedFindings !== undefined &&
    barAppliedFindings.some((finding) => finding.severity === "critical")
      ? [
          `- Critical severity is judge-authored. The tool enforces the \`${CRITICAL_EVIDENCE_BAR}\` ` +
            "bar — a critical from the per-file lane must carry at least one non-blank " +
            "evidence entry — and does not decide whether the claimed mechanism is sound; " +
            "that is carried by the adversarial cross-check, never by a tool verdict.",
        ]
      : []),
    // The counts alone cannot show that a severity was MOVED rather than judged,
    // so a re-graded finding is named here with the severity it claimed. Named at
    // the finding-set level rather than repeated per finding section because the
    // question ("did the tool re-grade anything, and what") is a property of the
    // report, and answering it once is what stops a reader diffing two runs.
    ...renderSeverityDowngradeLine(report.findings),
    ...(report.summary.lens_breakdown && Object.keys(report.summary.lens_breakdown).length > 0
      ? [`- Lens breakdown: ${formatCountList(report.summary.lens_breakdown)}`]
      : []),
    // The line the breakdown structurally cannot carry: a selected lens with no
    // findings has no key in a `countBy`, so it used to be invisible. Named
    // here rather than in *Audit Limitations* (owner working assumption) — terse
    // and always in front of the reader, beside the counts it qualifies.
    ...renderUnexercisedLensLine(report.summary.lens_coverage),
    ...renderArchitectureSourceSample(report.summary.lens_coverage),
    ...(report.summary.grounding_status_breakdown &&
    Object.keys(report.summary.grounding_status_breakdown).length > 0
      ? [
          `- Grounding (S7): ${formatCountList(report.summary.grounding_status_breakdown)}` +
            [
              (report.summary.grounding_status_breakdown.ungrounded ?? 0) > 0
                ? "ungrounded findings are surfaced-not-confirmed below"
                : null,
              (report.summary.grounding_status_breakdown.refuted ?? 0) > 0
                ? "refuted findings are quarantined-excluded below"
                : null,
            ]
              .filter(Boolean)
              .reduce((acc, note, i) => acc + (i === 0 ? " — " : "; ") + note, ""),
        ]
      : []),
    ...(report.summary.verification_status_breakdown &&
    Object.keys(report.summary.verification_status_breakdown).length > 0
      ? [
          `- Verification: ${formatCountList(report.summary.verification_status_breakdown)}` +
            " — judge-authored claims about whether each defect is present at HEAD, not tool runs",
        ]
      : []),
    `- Files marked complete in the review ledger: ${report.summary.audited_file_count}`,
    "- File coverage is a reviewer declaration checked against assigned paths and line counts, not proof that every line was inspected.",
    `- Excluded non-auditable files: ${report.summary.excluded_file_count}`,
    "",
  );

  if (report.top_risks && report.top_risks.length > 0) {
    lines.push("## Top Risks", "");
    for (const risk of report.top_risks) {
      lines.push(`- ${risk}`);
    }
    lines.push("");
  }

  if (report.themes && report.themes.length > 0) {
    lines.push("## Themes", "");
    for (const theme of report.themes) {
      lines.push(`### ${theme.theme_id} — ${theme.title}`);
      lines.push("");
      lines.push(`- Root cause: ${theme.root_cause}`);
      lines.push(
        `- Findings: ${theme.finding_ids.length > 0 ? theme.finding_ids.join(", ") : "none"}`,
      );
      lines.push(`- Suggested fix pattern: ${theme.suggested_fix_pattern}`);
      lines.push("");
    }
  }

  lines.push("## Work Blocks", "");

  if (report.work_blocks.length === 0) {
    lines.push("No remediation work blocks were generated.", "");
  } else {
    for (const block of report.work_blocks) {
      lines.push(`### ${block.id}`);
      lines.push("");
      lines.push(`- Max severity: ${block.max_severity}`);
      lines.push(`- Role: ${block.role}`);
      lines.push(`- Units: ${block.unit_ids.join(", ")}`);
      lines.push(`- Owned files: ${block.owned_files.join(", ")}`);
      lines.push(`- Findings: ${block.finding_ids.join(", ")}`);
      lines.push(
        `- Depends on: ${block.depends_on.length > 0 ? block.depends_on.join(", ") : "none"}`,
      );
      lines.push(`- Rationale: ${block.rationale}`);
      lines.push("");
    }
  }

  const workBlockSeams = report.work_block_seams ?? [];
  if (workBlockSeams.length > 0) {
    lines.push("## Work Block Seams", "");
    for (const seam of workBlockSeams) {
      lines.push(`### ${seam.id} — ${seam.kind}`);
      lines.push("");
      lines.push(`- Contested file: ${seam.file}`);
      lines.push(`- Blocks: ${seam.block_ids.join(", ")}`);
      lines.push(`- Seam preparation required: yes`);
      lines.push(`- Rationale: ${seam.rationale}`, "");
    }
  }

  lines.push("## Findings", "");
  if (report.findings.length === 0) {
    lines.push("No findings were recorded.", "");
  } else {
    for (const finding of report.findings) {
      pushFindingBlock(finding, lines);
    }
  }

  // S7 surfacing: list the findings the grounding pass could not re-verify
  // against disk in a dedicated, visually-separated section so they are never
  // silently confirmed. They remain in the main findings list (and in the machine
  // contract / work blocks) but are explicitly marked not-confirmed.
  const ungroundedFindings = report.findings.filter(
    (finding) => finding.grounding?.status === "ungrounded",
  );
  if (ungroundedFindings.length > 0) {
    lines.push("## Ungrounded Findings (not confirmed)", "");
    lines.push(
      `${ungroundedFindings.length} finding(s) could not be re-verified against the source on disk (S7 grounding: the cited verbatim span was not found, or no span was provided). They appear above with the other findings but are **not confirmed** — treat them with skepticism and check the code before acting.`,
      "",
    );
    for (const finding of ungroundedFindings) {
      lines.push(
        `- **${finding.id}** — ${finding.title} (${finding.severity}, ${finding.lens})`,
      );
      if (finding.grounding?.reason) {
        lines.push(`  - Reason: ${finding.grounding.reason}`);
      }
    }
    lines.push("");
  }

  // B4: tool-REFUTED findings — an executable anchor actively DISPROVED the claim.
  // Unlike ungrounded findings, these are EXCLUDED from the admitted findings and
  // work blocks (never actionable), but recorded here (quarantine, not delete) so
  // the disproof is auditable.
  const refutedFindings = report.quarantined_findings ?? [];
  if (refutedFindings.length > 0) {
    lines.push("## Refuted Findings (quarantined — excluded)", "");
    lines.push(
      `${refutedFindings.length} finding(s) were DISPROVED by a tool-executable anchor (S7 tier-2). They are **excluded** from the findings and work blocks above — a disproven claim is never actionable — and are listed here only for auditability.`,
      "",
    );
    for (const finding of refutedFindings) {
      pushFindingBlock(finding, lines);
    }
  }

  const ledgerEvents = options.submission_ledger ?? [];
  const driftLines = [
    ...renderLaneDeliverySection(ledgerEvents),
    ...renderSubmissionDriftSection(ledgerEvents),
  ];
  lines.push(
    ...renderConceptualAttributionSection(
      report, options.conceptual_adjudication, options.conceptual_attribution_id_source,
    ),
  );
  const reflections = options.reflections ?? [];
  // Structural capability limitations are report limitations, not process
  // feedback. Keep the machine contract untouched: this only partitions the
  // human-readable render.
  const capabilityLimitations = reflections.filter(isCapabilityLimitationReflection);
  const processFeedback = reflections.filter(
    (reflection) => !capabilityLimitations.includes(reflection),
  );
  // *Audit Limitations* states what this run could NOT do. It has two sources
  // now, and the section is CREATED by either — it used to be the process-
  // feedback heading renamed, so it existed only when a capability-preflight
  // reflection happened to be present.
  const analyzerLimitationLines = renderAnalyzerDegradationLines(
    options.analyzer_capability,
  );
  const reflectionLimitationLines =
    renderProcessFeedbackSection(capabilityLimitations);
  if (reflectionLimitationLines.length > 0) {
    reflectionLimitationLines[0] = "## Audit Limitations";
  }
  const limitationLines =
    analyzerLimitationLines.length > 0
      ? [
          "## Audit Limitations",
          "",
          ...analyzerLimitationLines,
          // A reflection-sourced block that follows keeps its own body but must
          // not re-open the heading it is now inside.
          ...reflectionLimitationLines.slice(
            reflectionLimitationLines.length > 0 ? 2 : 0,
          ),
        ]
      : reflectionLimitationLines;
  const feedbackLines = renderProcessFeedbackSection(processFeedback);
  const coverageLines = renderCharterCoverageSection(
    options.charter_evidence_coverage ?? [],
    options.charter_packet_archive ?? [],
  );
  lines.push(...limitationLines, ...feedbackLines);
  if (driftLines.length > 0 && feedbackLines.length === 0) {
    lines.push("## Process Feedback", "");
  }
  lines.push(...driftLines, ...coverageLines);

  const excludedScope = options.intent_checkpoint?.excluded_scope ?? [];
  if (excludedScope.length > 0) {
    lines.push("## Excluded / Out-of-Scope", "");
    lines.push(
      `${excludedScope.length} path(s) were excluded from this audit per the intent checkpoint:`,
      "",
    );
    for (const entry of excludedScope) {
      lines.push(`- \`${entry.path}\` — ${entry.reason}`);
    }
    lines.push("");
  }

  lines.push("## Scope and Coverage", "");
  const scope = options.scope;
  if (scope && scope.mode === "delta") {
    lines.push(
      `**Delta audit since \`${scope.since}\`.** This run audited ${scope.seed_files.length} changed file(s) and ${scope.expanded_files.length} graph neighbour(s); all other auditable files were left out of scope (inherited from a prior audit where complete, otherwise excluded from this run). **A full audit is advised before release.**`,
    );
    if (scope.dropped_note) {
      lines.push("", scope.dropped_note);
    }
  } else {
    lines.push(
      "This report is deterministic output from the completed audit. Non-auditable files were excluded from scope before task generation.",
    );
  }
  lines.push("");
  // The ONE place the deliverable becomes a string, and therefore the ONE place
  // the byte contract can be guaranteed: a host-authored string above cannot
  // reach `audit-report.md` raw, whatever field it arrived in.
  return escapeControlCharacters(lines.join("\n"));
}

function isCapabilityLimitationReflection(reflection: AgentReflection): boolean {
  return reflection.task_id === "audit-capability-preflight" &&
    (reflection.severity === "high" || reflection.severity === "critical");
}

/** Keep history in input order, including multiple records for one question. */
function indexQuestionHistory<T>(rows: readonly T[], questionIdOf: (row: T) => string): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const row of rows) {
    const questionId = questionIdOf(row);
    const history = index.get(questionId);
    if (history) history.push(row);
    else index.set(questionId, [row]);
  }
  return index;
}

function renderQuestionReport(report: RenderableAuditReport, review: QuestionReviewReport, options: RenderAuditReportOptions): string {
  const reflections = options.reflections ?? [];
  const lines = [
    AUDITOR_REPORT_MARKER, "# Audit Report", "",
    `Coverage: **${review.completion}**. Snapshot: ${review.snapshot_id}.`,
    "Coverage tracks accepted answers to planned questions. Source references and evidence are checked, but the reported inspection is not independently observed.",
    `Actionable confirmed defects: ${report.findings.length}. Repair work blocks: ${report.work_blocks.length}.`,
  ];
  if (report.executive_summary?.trim() || report.themes?.length || report.top_risks?.length) {
    lines.push("", "## Narrative (does not change coverage or findings)", "");
    if (report.executive_summary?.trim()) lines.push(report.executive_summary.trim());
    for (const theme of report.themes ?? []) {
      lines.push(`- ${theme.title}: ${theme.root_cause} [${theme.finding_ids.join(", ")}]`);
    }
    for (const risk of report.top_risks ?? []) lines.push(`- Risk: ${risk}`);
  }
  if (review.file_coverage) {
    const { admitted_count, inspected_count, gaps } = review.file_coverage;
    lines.push("", "## Admitted file inspection", "",
      `${inspected_count} of ${admitted_count} admitted files have current accepted inspection evidence. ${gaps.length} missing.`);
    if (gaps.length) lines.push("", ...gaps.map(path => "- " + path));
  }
  if (review.analyzer_coverage_gaps?.length) {
    lines.push("", "## Unresolved analyzer coverage", "",
      "These checks were incomplete or unavailable. This is separate from reviewer coverage.",
      ...review.analyzer_coverage_gaps.map(gap => "- " + gap));
  }
  lines.push("", "## Lens coverage", "");
  for (const lens of review.lens_decisions) {
    const questions = review.questions.filter(row => row.lens === lens.lens);
    const counts = Object.entries(countBy(questions, question => question.state))
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([state, count]) => `${state}: ${count}`).join(", ");
    lines.push(`- ${lens.lens}: ${lens.decision}. ${lens.reason}${counts ? ` (${counts})` : ""}`);
  }
  const questions = new Map(review.questions.map(row => [row.question_id, row]));
  const evidence = new Map(review.evidence.map(row => [row.evidence_id, row]));
  const opportunityIds = new Set(review.accepted.flatMap(({ submission, dependency_bindings }) => {
    const row = questions.get(submission.question_id);
    if (!dependency_bindings.length || !row || row.plan_status === "blocked" || row.plan_status === "deferred" ||
        row.state === "conflicted" ||
        row.revision_id !== submission.revision_id || !row.accepted_answer_ids.includes(submission.submission_id)) return [];
    const findingCounts = countBy(submission.answer.findings, claim => claim.finding_id);
    return submission.answer.findings.filter(claim => claim.kind === "design_opportunity" && claim.source_refs.length > 0 &&
      claim.question_id === submission.question_id && claim.revision_id === submission.revision_id &&
      findingCounts[claim.finding_id] === 1 &&
      submission.answer.parts.some(part => part.outcome === "findings" &&
        row.parts.some(projected => projected.part_id === part.part_id && projected.state === "findings" &&
          projected.accepted_answer_ids.includes(submission.submission_id)) &&
        questionPartHasSupport(submission.answer, part, evidence, claim.observation_ids ?? [])))
      .map(claim => canonicalQuestionFindingId([questionClaimKey(submission.submission_id, claim.finding_id)]));
  }));
  const opportunities = review.findings.filter(group => opportunityIds.has(group.canonical_finding_id) &&
    group.kind === "design_opportunity" && !group.actionable).sort((a, b) =>
    severityRank(b.sources[0]!.severity) - severityRank(a.sources[0]!.severity) ||
    confidenceRank(b.sources[0]!.confidence) - confidenceRank(a.sources[0]!.confidence) ||
    compareCodeUnits(a.canonical_finding_id, b.canonical_finding_id));
  if (opportunities.length) {
    lines.push("", "## Supported design opportunities", "",
      "These evidence-supported improvements are prioritized separately from confirmed defects. Weigh their tradeoffs and decide which to pursue; listing one does not approve implementation.", "");
    for (const group of opportunities) {
      const source = group.sources[0]!;
      lines.push(`- ${group.canonical_finding_id} (${source.finding_id}; ${source.severity}; ${source.confidence} confidence), question ${source.question_id}: ${source.claim}`,
        `  - Effect: ${source.consequence}`, `  - Next step: ${source.next_step}`,
        `  - Sources: ${source.source_refs.map(ref => ref.start_line === undefined ? ref.path : `${ref.path}:${ref.start_line}`).join(", ")}`);
    }
  }
  if (review.signal_dispositions?.length) {
    lines.push("", "## Candidate dispositions", "",
      "Planning decisions and linked review outcomes are separate; one grouped candidate does not independently confirm the finding.", "");
    for (const signal of review.signal_dispositions) {
      const question = signal.question_id && questions.get(signal.question_id);
      const part = question ? question.parts.find(row => row.part_id === signal.signal_id) : undefined;
      const state = part?.state ?? (signal.signal_id.startsWith("design-lead:") ? undefined : (question || undefined)?.state);
      const linked = question ? ` Linked question ${question.question_id}${part ? " review part" : ""}: ${state === "clean"
        ? "scoped clean / no change substantiated" : state ?? "no matching review part"}.` : "";
      lines.push(`- ${signal.signal_id}: ${signal.outcome.replaceAll("_", " ")}. ${signal.reason}.${linked}`);
      if (signal.source_refs?.length) lines.push(`  - Sources: ${signal.source_refs.map(ref => ref.start_line === undefined ? ref.path : `${ref.path}:${ref.start_line}`).join(", ")}`);
    }
  }
  const answersByQuestion = indexQuestionHistory(review.accepted, ({ submission }) => submission.question_id);
  const decisionsByQuestion = indexQuestionHistory(review.adjudications, decision => decision.question_id);
  const assignedInventory = new Set(review.questions.flatMap(q => q.inventory_item_ids));
  lines.push("", "## Questions and review limits", "");
  for (const row of review.questions) {
    lines.push(`### ${row.question_id} (${row.lens}): ${row.state}`, "", row.expected_outcome);
    if (row.plan_reason) lines.push(`- Planning: ${row.plan_status}: ${row.plan_reason}`);
    const answers = answersByQuestion.get(row.question_id) ?? [];
    for (const part of row.parts) {
      lines.push(`- ${part.part_id}: **${part.state}**. ${part.expectation}`);
      for (const reason of part.reasons) lines.push(`  - ${reason}`);
      if (row.plan_status !== "blocked" && row.plan_status !== "deferred" &&
          (part.state === "inconclusive" || part.state === "unreviewed")) {
        const needed = uniqueSorted(answers.flatMap(({ submission }) =>
          !part.accepted_answer_ids.includes(submission.submission_id) ? [] :
            submission.answer.observations.flatMap(observation =>
              observation.part_id !== part.part_id || !part.observation_ids.includes(observation.observation_id)
                ? [] : observation.evidence_refs.flatMap(ref => {
                  const record = evidence.get(ref.evidence_id);
                  const label = ref.observation_id ? `${ref.evidence_id}/${ref.observation_id}` : ref.evidence_id;
                  const gap = !record ? "is missing"
                    : record.status === "not_run" ? "was not run"
                    : record.status === "unavailable" ? "is unavailable"
                    : observation.kind === "runtime_observed" && record.execution?.executed !== true ? "has no observed execution"
                    : ref.observation_id && !record.observations?.some(item => item.observation_id === ref.observation_id)
                      ? "has no matching observation" : undefined;
                  return gap ? [`${label} ${gap}. Capture the ${ref.observation_id ? "named observation" : "referenced evidence"} or leave this part open.`] : [];
                }),
            ),
        ));
        for (const gap of needed.length ? needed : [`Collect evidence for the expectation: ${part.expectation}`]) {
          lines.push(`  - Evidence needed for ${part.part_id}: ${gap}`);
        }
      }
    }
    for (const conflict of row.conflicts) {
      lines.push(`- Unresolved disagreement on ${conflict.part_id}: ${conflict.answer_ids.join(", ")}.`);
    }
    for (const answer of answers) {
      const submission = answer.submission;
      const current = row.accepted_answer_ids.includes(submission.submission_id);
      lines.push(`- ${current ? "Accepted" : "Historical"} answer ${submission.submission_id}${current ? " (recorded, not a resolution)" : ""}`);
      for (const limit of submission.limitations) lines.push(`  - Limitation: ${limit}`);
      for (const observation of submission.answer.observations) {
        const refs = observation.evidence_refs.map(ref => ref.observation_id
          ? `${ref.evidence_id}/${ref.observation_id}` : ref.evidence_id);
        lines.push(`  - ${observation.kind} (${observation.part_id}): ${observation.statement}${refs.length ? ` [evidence: ${refs.join(", ")}]` : ""}`);
      }
    }
    for (const decision of decisionsByQuestion.get(row.question_id) ?? []) {
      lines.push(`- Recorded decision ${decision.adjudication_id} (${decision.decision}, ${decision.reviewer}): ${decision.rationale}`);
    }
    lines.push("");
  }
  lines.push("## Scope and omissions", "");
  for (const item of review.inventory) {
    if (item.scope !== "in_scope") lines.push(`- ${item.title}: ${item.scope}. ${item.scope_reason ?? ""}`);
    else if (!assignedInventory.has(item.inventory_item_id)) {
      lines.push(`- ${item.title}: in scope, no question planned.`);
    }
  }
  for (const omission of review.omissions) lines.push(`- ${omission.surface_id}: ${omission.reason}`);
  lines.push("", "## Findings and leads", "");
  const selectedOpportunities = new Set(opportunities);
  const findingsById = new Map<string, RenderableAuditReport["findings"][number]>();
  for (const finding of report.findings) {
    if (!findingsById.has(finding.id)) findingsById.set(finding.id, finding);
  }
  for (const group of review.findings) {
    if (selectedOpportunities.has(group)) continue;
    const finding = findingsById.get(group.canonical_finding_id);
    lines.push(`- ${group.canonical_finding_id}: ${group.kind} (${finding ? `actionable; ${finding.severity}` : "not actionable"}).`);
    for (const source of group.sources) {
      lines.push(`  - ${source.finding_id} on ${source.question_id}: ${source.claim}. ${source.consequence}`);
      lines.push(`    - Next step: ${source.next_step}`);
      if (source.verification.length) lines.push(`    - Verification: ${source.verification.map(v => v.obligation_id).join(", ")}.`);
    }
  }
  lines.push("", "## Evidence", "");
  for (const evidence of review.evidence) {
    const execution = evidence.execution;
    lines.push(`- ${evidence.evidence_id}: ${evidence.status} (${evidence.kind}). ${evidence.description}`);
    if (execution) lines.push(execution.executed
      ? `  - Executed: ${execution.tool} ${execution.tool_version}${execution.elapsed_ms === undefined ? "" : ` (${execution.elapsed_ms} ms observed)`}.`
      : `  - Not executed: ${execution.tool} ${execution.tool_version}.`);
  }
  const limitations = reflections.filter(isCapabilityLimitationReflection);
  const limitationLines = renderProcessFeedbackSection(limitations);
  if (limitationLines.length > 0) limitationLines[0] = "## Audit Limitations";
  lines.push("", ...limitationLines, ...renderProcessFeedbackSection(reflections.filter(reflection => !isCapabilityLimitationReflection(reflection))));
  if (options.charter_evidence_coverage !== undefined || options.charter_packet_archive !== undefined) {
    lines.push("", ...renderCharterCoverageSection(options.charter_evidence_coverage ?? [], options.charter_packet_archive ?? [], true));
  }
  return escapeControlCharacters(lines.join("\n").trimEnd() + "\n");
}
