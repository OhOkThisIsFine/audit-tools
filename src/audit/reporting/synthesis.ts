import type { AuditResult, CoverageMatrix, Finding, UnitManifest } from "../types.js";
import type { AuditScopeManifest } from "../types/auditScope.js";
import type { IntentCheckpoint, SubmissionLedgerEvent } from "audit-tools/shared";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { ConceptualReviewAdjudication } from "../types/conceptualAdjudication.js";
import type { StructureDecomposition } from "../types/structureDecomposition.js";
import type { CharterRegister } from "../types/charterRegister.js";
import {
  degradedAnalyzerEntries,
  type AnalyzerCapabilityRecord,
} from "../types/analyzerCapability.js";
import type { SystemicChallengeRegister } from "../types/systemicChallenge.js";
import type { ExternalAnalyzerResults } from "audit-tools/shared";
import type {
  AuditFindingsReport,
  ContentCoherenceTrace,
  CriticalFlowManifest,
  Finding as SharedFinding,
  FindingTheme,
  GraphBundle,
  SynthesisNarrative,
  WorkBlockSeam,
} from "audit-tools/shared";
import {
  AUDIT_FINDINGS_CONTRACT_VERSION as SHARED_AUDIT_FINDINGS_CONTRACT_VERSION,
  AUDITOR_REPORT_MARKER,
  renderProcessFeedbackSection,
  renderFindingBlockLines,
  compareCodeUnits,
  countBy,
  deriveLensCoverage,
  isIngestEvent,
  reprojectLensCoverage,
  type AgentReflection,
  type LensCoverageEntry,
  type MeasuredOutcome,
} from "audit-tools/shared";
import { resolveIntentLensSelection } from "../orchestrator/lensSelection.js";
import type {
  RuntimeValidationReport,
  RuntimeValidationTaskManifest,
} from "../types/runtimeValidation.js";
import { buildWorkBlockPartition, type WorkBlock } from "./workBlocks.js";
import { mergeFindings } from "./mergeFindings.js";
import { selectCurrentResults } from "../orchestrator/ledger.js";
import { assignStableFindingIds } from "./findingIdentity.js";

const CONCEPTUAL_ATTRIBUTION_IDS = Symbol("conceptual-attribution-ids");
const CONCEPTUAL_ID_MARKER_PREFIX = "\u0000audit-tools:conceptual-final-id:";

type ConceptualAttributionIdMap = ReadonlyMap<string, string>;
type ConceptualAttributionCarrier = {
  [CONCEPTUAL_ATTRIBUTION_IDS]?: ConceptualAttributionIdMap;
};
type AttributionAwareReport = AuditFindingsReport & ConceptualAttributionCarrier;

/**
 * Contract version stamped onto the canonical `audit-findings.json`.
 * Single-sourced from `audit-tools/shared` so the auditor's output and the
 * remediator's validator can never drift (guarded by the
 * `seam-artifact-ipc-envelope` test).
 */
export const AUDIT_FINDINGS_CONTRACT_VERSION =
  SHARED_AUDIT_FINDINGS_CONTRACT_VERSION;

/**
 * Anything renderable as the deterministic audit report. Both `AuditReportModel`
 * (no narrative) and the canonical `AuditFindingsReport` (optionally carrying
 * themes/executive_summary/top_risks) satisfy this shape, so the same renderer
 * produces the base report and the narrative-enriched report.
 */
export interface RenderableAuditReport {
  summary: AuditReportSummary;
  // Widened to the shared Finding (lens: string) so both AuditReportModel (lens
  // narrowed to Lens) and the canonical AuditFindingsReport render unchanged.
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

export interface AuditReportModel {
  summary: AuditReportSummary;
  findings: Finding[];
  coherence_trace: ContentCoherenceTrace;
  work_blocks: WorkBlock[];
  work_block_seams: WorkBlockSeam[];
  /** Tool-REFUTED findings (S7 tier-2 disproof) excluded from the admitted set. */
  quarantined_findings?: Finding[];
}

type AttributionAwareModel = AuditReportModel & {
  [CONCEPTUAL_ATTRIBUTION_IDS]?: ConceptualAttributionIdMap;
};

function markConceptualFindingIds(designAssessment: DesignAssessment | undefined): {
  designAssessment: DesignAssessment | undefined;
  findingIdByMarker: ReadonlyMap<string, string>;
} {
  const conceptualFindings = designAssessment?.conceptual_findings ?? [];
  if (conceptualFindings.length === 0) {
    return { designAssessment, findingIdByMarker: new Map() };
  }

  const findingIdByMarker = new Map<string, string>();
  const markedFindings = conceptualFindings.map((finding, index) => {
    const marker = `${CONCEPTUAL_ID_MARKER_PREFIX}${index}:${finding.id}\u0000`;
    findingIdByMarker.set(marker, finding.id);
    return {
      ...finding,
      evidence: [...(finding.evidence ?? []), marker],
    };
  });

  return {
    designAssessment: { ...designAssessment!, conceptual_findings: markedFindings },
    findingIdByMarker,
  };
}

function extractConceptualAttributionIds(
  mergedFindings: Finding[],
  findingIdByMarker: ReadonlyMap<string, string>,
): string[][] {
  if (findingIdByMarker.size === 0) return mergedFindings.map(() => []);

  let recoveredMarkerCount = 0;
  const localIdsByFinding = mergedFindings.map((finding) => {
    const localIds: string[] = [];
    const evidence = (finding.evidence ?? []).filter((entry) => {
      const localId = findingIdByMarker.get(entry);
      if (localId === undefined) return true;
      localIds.push(localId);
      recoveredMarkerCount += 1;
      return false;
    });
    finding.evidence = evidence;
    return localIds;
  });

  if (recoveredMarkerCount !== findingIdByMarker.size) {
    throw new Error(
      "Conceptual attribution identity markers were not conserved through finding merge.",
    );
  }
  return localIdsByFinding;
}

function severityBreakdown(findings: Finding[]): Record<string, number> {
  return countBy(findings, (finding) => finding.severity);
}

function lensBreakdown(findings: Finding[]): Record<string, number> {
  return countBy(findings, (finding) => finding.lens);
}

/**
 * Per-status counts of the S7 grounding pass over the findings. Findings with no
 * grounding verdict (the pass did not run on them) are skipped by `countBy`, so
 * an empty result means "no finding was graded" and the caller omits the field.
 */
function groundingStatusBreakdown(findings: Finding[]): Record<string, number> {
  return countBy(findings, (finding) => finding.grounding?.status);
}

/**
 * Per-status counts of the judge's defect-presence claim. Findings with no
 * status (every deterministic finding — the conceptual pass is the only
 * producer) are skipped by `countBy`, so an empty result means "no finding
 * carried a claim" and the caller omits the field, exactly as for grounding.
 */
function verificationStatusBreakdown(
  findings: Finding[],
): Record<string, number> {
  return countBy(findings, (finding) => finding.verification_status);
}

function runtimeStatusBreakdown(
  report?: RuntimeValidationReport,
  taskManifest?: RuntimeValidationTaskManifest,
): Record<string, number> {
  const breakdown = countBy(report?.results ?? [], (result) => result.status);
  const resultTaskIds = new Set((report?.results ?? []).map((result) => result.task_id));
  for (const task of taskManifest?.tasks ?? []) {
    if (!resultTaskIds.has(task.id)) {
      breakdown.pending = (breakdown.pending ?? 0) + 1;
    }
  }
  return breakdown;
}

function coverageSummary(coverage?: CoverageMatrix): {
  audited_file_count: number;
  excluded_file_count: number;
} {
  const files = coverage?.files ?? [];
  return {
    audited_file_count: files.filter((file) => file.audit_status === "complete").length,
    excluded_file_count: files.filter((file) => file.audit_status === "excluded").length,
  };
}

function formatSeverityList(summary: Record<string, number>): string {
  const ordered = ["critical", "high", "medium", "low", "info"];
  const parts = ordered
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

export function buildAuditReportModel(params: {
  results: AuditResult[];
  unitManifest?: UnitManifest;
  graphBundle?: GraphBundle;
  criticalFlows?: CriticalFlowManifest;
  coverageMatrix?: CoverageMatrix;
  runtimeValidationReport?: RuntimeValidationReport;
  runtimeValidationTaskManifest?: RuntimeValidationTaskManifest;
  externalAnalyzerResults?: ExternalAnalyzerResults[];
  designAssessment?: DesignAssessment;
  structureDecomposition?: StructureDecomposition;
  charterRegister?: CharterRegister;
  systemicChallenge?: SystemicChallengeRegister;
  /** Intake manifest byte sizes used to estimate remediation source context. */
  sizeIndex?: Readonly<Record<string, number>>;
  /**
   * The accepted intent checkpoint. Read for its `lens_selection`, which is the
   * ONLY statement of what the operator asked to be reviewed — and which used
   * to reach synthesis's RENDER options while the model builder, the one site
   * that mints the summary, was never passed it at all.
   */
  intentCheckpoint?: IntentCheckpoint;
}): AuditReportModel {
  const markedConceptual = markConceptualFindingIds(params.designAssessment);
  // Re-key the finalized findings with globally-unique, content-addressed ids
  // before anything addresses them by id. mergeFindings emits exactly one
  // finding per file-independent identity (exact normalized lens|category|
  // title) across files, units, and passes, and assignStableFindingIds hashes
  // only stable identity signals — never line numbers, pass ids, or the merged
  // file list — so the same logical finding keeps one id across passes and
  // re-syntheses. Work partition coverage and seam identities key on finding.id,
  // so locally-scoped, collision-prone packet ids must be replaced here or
  // unrelated findings become indistinguishable in the partition contract.
  // O3 supersession: resolve the ledger to its CURRENT record per task lineage
  // before merging, so a re-dispatched result's fresh findings replace the stale
  // base record they superseded — including findings the re-audit dropped, which
  // a finding-id upsert alone would leave behind.
  const mergedFindings = mergeFindings(
    selectCurrentResults(params.results),
    params.runtimeValidationReport,
    params.externalAnalyzerResults,
    markedConceptual.designAssessment,
    params.structureDecomposition,
    params.charterRegister,
    params.systemicChallenge,
  );
  const conceptualIdsByFinding = extractConceptualAttributionIds(
    mergedFindings,
    markedConceptual.findingIdByMarker,
  );
  const allFindings = assignStableFindingIds(mergedFindings);
  const conceptualAttributionIds = new Map<string, string>();
  for (const [index, localIds] of conceptualIdsByFinding.entries()) {
    const canonicalId = allFindings[index]!.id;
    for (const localId of localIds) {
      const existing = conceptualAttributionIds.get(localId);
      if (existing !== undefined && existing !== canonicalId) {
        throw new Error(
          `Conceptual finding id "${localId}" resolved to multiple canonical findings.`,
        );
      }
      conceptualAttributionIds.set(localId, canonicalId);
    }
  }
  // B4: a tool-executable anchor that REFUTED a claim (status `refuted`, distinct
  // from `ungrounded`) is quarantined-EXCLUDED — kept out of the admitted findings
  // AND the work blocks so a disproven claim never merges as actionable fact. The
  // refuted findings are preserved in `quarantined_findings` (quarantine, not
  // delete) and rendered in their own report section. The exclusion happens AFTER
  // merge so a finding grounded on another pass (grounded-wins in mergeGrounding)
  // is never quarantined.
  const findings = allFindings.filter((f) => f.grounding?.status !== "refuted");
  const quarantinedRefuted = allFindings.filter((f) => f.grounding?.status === "refuted");
  const workBlocks = buildWorkBlockPartition({
    findings,
    unitManifest: params.unitManifest,
    graphBundle: params.graphBundle,
    criticalFlows: params.criticalFlows,
    sizeIndex: params.sizeIndex,
  });
  const coverage = coverageSummary(params.coverageMatrix);
  // A lens is only `clean` — "asked, and there was nothing there" — when at
  // least one LENS-OPEN channel came back. Per-file audit results are lens-gated
  // by planning (`required_lenses`), and the two design-review passes carry the
  // selection into their prompts and record their own completion. With none of
  // them ingested, a selected lens with no findings was never exercised, and
  // saying `clean` would be exactly the "absence of a finding reads as absence
  // of a defect" claim this field exists to refuse.
  const lensOpenChannelIngested =
    params.results.length > 0 ||
    params.designAssessment?.contract_reviewed === true ||
    params.designAssessment?.conceptual_reviewed === true;
  const selectedLenses = resolveIntentLensSelection(
    params.intentCheckpoint?.lens_selection,
  );
  // Count grounding over ALL findings (incl. quarantined-refuted) so the `refuted`
  // tally reflects findings dropped from the admitted set.
  const groundingBreakdown = groundingStatusBreakdown(allFindings);
  const verificationBreakdown = verificationStatusBreakdown(allFindings);
  const model: AttributionAwareModel = {
    summary: {
      finding_count: findings.length,
      work_block_count: workBlocks.blocks.length,
      severity_breakdown: severityBreakdown(findings),
      lens_breakdown: lensBreakdown(findings),
      // Presence is guaranteed HERE, at the one boundary that holds both the
      // operator's selection and the produced findings. Absent — deliberately —
      // when no selection resolved: "no limit" and "every lens" are different
      // answers, and inventing a map would be a claim nobody made.
      ...(selectedLenses === undefined
        ? {}
        : {
            lens_coverage: deriveLensCoverage({
              selectedLenses,
              findings,
              lensOpenChannelIngested,
            }),
          }),
      audited_file_count: coverage.audited_file_count,
      excluded_file_count: coverage.excluded_file_count,
      ...(Object.keys(groundingBreakdown).length > 0
        ? { grounding_status_breakdown: groundingBreakdown }
        : {}),
      ...(Object.keys(verificationBreakdown).length > 0
        ? { verification_status_breakdown: verificationBreakdown }
        : {}),
      runtime_validation_status_breakdown: runtimeStatusBreakdown(
        params.runtimeValidationReport,
        params.runtimeValidationTaskManifest,
      ),
    },
    findings,
    coherence_trace: workBlocks.coherence_trace,
    work_blocks: workBlocks.blocks,
    work_block_seams: workBlocks.seams,
    ...(quarantinedRefuted.length > 0 ? { quarantined_findings: quarantinedRefuted } : {}),
  };
  if (conceptualAttributionIds.size > 0) {
    model[CONCEPTUAL_ATTRIBUTION_IDS] = conceptualAttributionIds;
  }
  return model;
}

/**
 * Wrap the deterministic report model in the canonical `audit-findings.json`
 * contract — the machine hand-off consumed by the remediator. Narrative fields
 * are absent here; they are layered on later by {@link applyNarrative}.
 */
export function buildAuditFindingsReport(
  model: AuditReportModel,
): AuditFindingsReport {
  const report: AttributionAwareReport = {
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    summary: { ...model.summary },
    findings: model.findings,
    coherence_trace: model.coherence_trace,
    work_blocks: model.work_blocks,
    work_block_seams: model.work_block_seams,
    ...(model.quarantined_findings && model.quarantined_findings.length > 0
      ? { quarantined_findings: model.quarantined_findings }
      : {}),
  };
  const conceptualAttributionIds = (model as AttributionAwareModel)[
    CONCEPTUAL_ATTRIBUTION_IDS
  ];
  if (conceptualAttributionIds) {
    report[CONCEPTUAL_ATTRIBUTION_IDS] = conceptualAttributionIds;
  }
  return report;
}

/**
 * Merge an LLM synthesis narrative into the canonical findings report: tag each
 * covered finding with its (first-claiming) `theme_id`, and attach the
 * executive summary / top risks. Deterministic and idempotent — the same
 * narrative yields the same report.
 *
 * Uniform id-join contract: a `finding_ids` entry that names no finding in the
 * report REFUSES the whole narrative (throws, naming the unknown ids) — never a
 * silent drop, which would present a theme as covering findings it does not.
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

  for (const theme of narrative.themes ?? []) {
    // Deduplicate within the theme first, then drop ids already claimed by a
    // prior (first-claiming) theme. This enforces the "each finding belongs to
    // at most one theme" contract — the first theme in narrative.themes to list
    // a given id wins; later themes have it stripped. (Unknown ids were refused
    // wholesale above, so every id here is a real finding.)
    const findingIds = [
      ...new Set((theme.finding_ids ?? []).filter((id) => !themeByFinding.has(id))),
    ];
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
}

/**
 * Name the selected lenses this run did not exercise.
 *
 * Rendered whenever a selected lens produced no findings, with its outcome, so
 * `clean` ("asked, nothing found") and `not_run` ("never asked") stay legible as
 * the different statements they are. Nothing to say — every selected lens
 * produced findings, or no selection was made — renders nothing.
 */
function renderUnexercisedLensLine(
  coverage: readonly LensCoverageEntry[] | undefined,
): string[] {
  const unexercised = (coverage ?? []).filter(
    (entry) => entry.selected && entry.outcome !== "findings",
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
        `${outcome === "not_run" ? "never exercised" : "exercised, no findings"}: ${lenses.join(", ")}`,
    );
  return [`- Lenses not exercised: ${parts.join("; ")}`];
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
  const refusedIds = new Set(
    events
      .filter((event) => event.kind === "rejected")
      .map((event) => event.submission_id),
  );
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
  const rejected = events.filter((event) => event.kind === "rejected");
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

export function canonicalizeConceptualAttributionIds(
  report: RenderableAuditReport,
  adjudication: ConceptualReviewAdjudication,
  idSource: RenderableAuditReport = report,
): void {
  const canonicalIds = new Set([
    ...report.findings.map((finding) => finding.id),
    ...(report.quarantined_findings ?? []).map((finding) => finding.id),
  ]);
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

  // Canonicalize the carried adjudication itself, not only the markdown text.
  // The fold persists every carried core artifact, so subsequent narrative and
  // resynthesis renders reload canonical targets rather than reviving the
  // judge-local ids that existed before the synthesis boundary.
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
            source_candidate_ids: [
              ...new Set(
                contributorEntries.flatMap(
                  (entry) => entry.contribution.source_candidate_ids,
                ),
              ),
            ].sort(compareCodeUnits),
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

  // Commit both reference-bearing arrays only after every share and target has
  // resolved. A late unknown disposition target cannot leave half-canonical
  // attribution in the caller's carried bundle.
  adjudication.final_finding_shares = resolvedFinalFindingShares;
  adjudication.candidate_dispositions = resolvedCandidateDispositions;
}

function renderConceptualAttributionSection(
  report: RenderableAuditReport,
  adjudication: ConceptualReviewAdjudication | undefined,
): string[] {
  if (!adjudication) return [];
  canonicalizeConceptualAttributionIds(report, adjudication);
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

export function renderAuditReportMarkdown(
  report: RenderableAuditReport,
  options: RenderAuditReportOptions = {},
): string {
  const lines: string[] = [
    AUDITOR_REPORT_MARKER,
    "# Audit Report",
    "",
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
    ...(report.summary.lens_breakdown && Object.keys(report.summary.lens_breakdown).length > 0
      ? [`- Lens breakdown: ${formatCountList(report.summary.lens_breakdown)}`]
      : []),
    // The line the breakdown structurally cannot carry: a selected lens with no
    // findings has no key in a `countBy`, so it used to be invisible. Named
    // here rather than in *Audit Limitations* (owner working assumption) — terse
    // and always in front of the reader, beside the counts it qualifies.
    ...renderUnexercisedLensLine(report.summary.lens_coverage),
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
    `- Fully audited files: ${report.summary.audited_file_count}`,
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
    ...renderConceptualAttributionSection(report, options.conceptual_adjudication),
  );
  const reflections = options.reflections ?? [];
  // Structural capability limitations are report limitations, not process
  // feedback. Keep the machine contract untouched: this only partitions the
  // human-readable render.
  const capabilityLimitations = reflections.filter(
    (reflection) =>
      reflection.task_id === "audit-capability-preflight" &&
      (reflection.severity === "high" || reflection.severity === "critical"),
  );
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
  lines.push(...limitationLines, ...feedbackLines);
  if (driftLines.length > 0 && feedbackLines.length === 0) {
    lines.push("## Process Feedback", "");
  }
  lines.push(...driftLines);

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
  return lines.join("\n");
}

/**
 * Re-derive the summary fields that can be computed from the existing findings
 * and work_blocks, bump the contract_version to the current constant, and leave
 * upstream-derived fields that cannot be reconstructed (audited/excluded counts,
 * runtime validation breakdown) untouched.
 *
 * Safe to call on already-promoted `audit-findings.json` files without access to
 * the pruned `.audit-tools/audit` working-bundle intermediates.
 */
export function normalizeExistingFindingsReport(
  report: AuditFindingsReport,
): AuditFindingsReport {
  const groundingBreakdown = groundingStatusBreakdown(report.findings as Finding[]);
  const verificationBreakdown = verificationStatusBreakdown(
    report.findings as Finding[],
  );
  return {
    ...report,
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    work_block_seams: report.work_block_seams ?? [],
    summary: {
      ...report.summary,
      finding_count: report.findings.length,
      work_block_count: report.work_blocks.length,
      severity_breakdown: severityBreakdown(report.findings as Finding[]),
      lens_breakdown: lensBreakdown(report.findings as Finding[]),
      // The SELECTION is carried through — this function has no checkpoint and
      // must not invent one — while the counts and outcomes are re-derived over
      // the same findings `lens_breakdown` is re-counted from. Copying the map
      // untouched beside a re-derived breakdown is how the two come to
      // contradict each other, and the contradiction is refused downstream by
      // `projectApprovedFindings`, which throws.
      ...(report.summary.lens_coverage === undefined
        ? {}
        : {
            lens_coverage: reprojectLensCoverage(
              report.summary.lens_coverage,
              report.findings as Finding[],
            ),
          }),
      ...(Object.keys(groundingBreakdown).length > 0
        ? { grounding_status_breakdown: groundingBreakdown }
        : {}),
      ...(Object.keys(verificationBreakdown).length > 0
        ? { verification_status_breakdown: verificationBreakdown }
        : {}),
    },
  };
}
