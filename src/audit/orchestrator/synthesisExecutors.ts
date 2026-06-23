import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditResult } from "../types.js";
import type { ExecutorRunResult } from "./executorResult.js";
import {
  applyNarrative,
  buildAuditFindingsReport,
  buildAuditReportModel,
  renderAuditReportMarkdown,
} from "../reporting/synthesis.js";
import type { SynthesisNarrative } from "audit-tools/shared";
import type { SynthesisNarrativeRecord } from "../types/synthesisNarrative.js";

function buildBaseFindingsReport(
  bundle: ArtifactBundle,
  results: AuditResult[],
) {
  const report = buildAuditFindingsReport(
    buildAuditReportModel({
      results,
      unitManifest: bundle.unit_manifest,
      graphBundle: bundle.graph_bundle,
      criticalFlows: bundle.critical_flows,
      coverageMatrix: bundle.coverage_matrix,
      runtimeValidationReport: bundle.runtime_validation_report,
      runtimeValidationTaskManifest: bundle.runtime_validation_tasks,
      externalAnalyzerResults: bundle.external_analyzer_results,
      designAssessment: bundle.design_assessment,
      activeDispatch: bundle.active_dispatch,
    }),
  );
  // Record the host-confirmed exclusions in the machine contract so omissions
  // are explicit and machine-readable, not just rendered in the markdown.
  const excludedScope = bundle.intent_checkpoint?.excluded_scope;
  return excludedScope && excludedScope.length > 0
    ? { ...report, excluded_scope: excludedScope }
    : report;
}

export function runSynthesisExecutor(
  bundle: ArtifactBundle,
  results?: AuditResult[],
): ExecutorRunResult {
  const finalResults = results ?? bundle.audit_results ?? [];
  // Emit the canonical machine contract and render the human report from it.
  // No narrative yet — that is layered by the synthesis-narrative obligation.
  const findings = buildBaseFindingsReport(bundle, finalResults);

  // Synthesis renders findings; it does NOT own audit_results. Writing
  // audit_results back here desyncs it from its metadata entry (it isn't in
  // artifacts_written, so computeArtifactMetadata reuses the prior hash) and, in
  // the zero-result case, materializes an empty audit_results.jsonl that did not
  // exist before — both perpetually re-stale coverage_matrix → planning,
  // forcing a planning re-run that rewrites runtime_validation_report.json (the
  // finalization-oscillation engine). Leave audit_results as the ingested value.
  return {
    updated: {
      ...bundle,
      audit_findings: findings,
      audit_report: renderAuditReportMarkdown(findings, {
        scope: bundle.scope,
        intent_checkpoint: bundle.intent_checkpoint,
        reflections: bundle.agent_reflections,
      }),
    },
    artifacts_written: ["audit-findings.json", "audit-report.md"],
    progress_summary: `Rendered deterministic audit report and canonical findings for ${finalResults.length} audit result entries.`,
  };
}

/**
 * Resolve the optional synthesis-narrative obligation. When a host/provider
 * narrative is supplied it is merged into the canonical findings report and the
 * human report is re-rendered with themes/executive-summary/top-risks; without
 * one the narrative is recorded as omitted and the deterministic report stands.
 */
export function runSynthesisNarrativeExecutor(
  bundle: ArtifactBundle,
  narrative?: SynthesisNarrative,
): ExecutorRunResult {
  const baseReport =
    bundle.audit_findings ??
    buildBaseFindingsReport(bundle, bundle.audit_results ?? []);
  const needsBaseWrite = !bundle.audit_findings;

  const hasNarrative = Boolean(
    narrative &&
      ((narrative.themes?.length ?? 0) > 0 ||
        (narrative.executive_summary?.trim().length ?? 0) > 0 ||
        (narrative.top_risks?.length ?? 0) > 0),
  );

  if (!hasNarrative) {
    const record: SynthesisNarrativeRecord = {
      status: "omitted",
      theme_count: 0,
      executive_summary_present: false,
      top_risk_count: 0,
    };
    return {
      updated: {
        ...bundle,
        audit_findings: baseReport,
        synthesis_narrative: record,
      },
      artifacts_written: needsBaseWrite
        ? ["audit-findings.json", "synthesis-narrative.json"]
        : ["synthesis-narrative.json"],
      progress_summary:
        "Synthesis narrative omitted; deterministic findings report retained.",
    };
  }

  const enriched = applyNarrative(baseReport, narrative!);
  const record: SynthesisNarrativeRecord = {
    status: "applied",
    theme_count: enriched.themes?.length ?? 0,
    executive_summary_present:
      (enriched.executive_summary?.trim().length ?? 0) > 0,
    top_risk_count: enriched.top_risks?.length ?? 0,
  };
  return {
    updated: {
      ...bundle,
      audit_findings: enriched,
      audit_report: renderAuditReportMarkdown(enriched, {
        scope: bundle.scope,
        intent_checkpoint: bundle.intent_checkpoint,
        reflections: bundle.agent_reflections,
      }),
      synthesis_narrative: record,
    },
    artifacts_written: [
      "audit-findings.json",
      "audit-report.md",
      "synthesis-narrative.json",
    ],
    progress_summary: `Synthesis narrative applied: ${record.theme_count} theme(s), ${record.top_risk_count} top risk(s).`,
  };
}
