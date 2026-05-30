import { spawn } from "node:child_process";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditResult, AuditTask } from "../types.js";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import {
  buildFileDisposition,
  isAuditExcludedStatus,
} from "../extractors/disposition.js";
import {
  buildGraphBundle,
  buildGraphBundleFromFs,
} from "../extractors/graph.js";
import { buildCriticalFlowManifest } from "../extractors/flows.js";
import { buildRiskRegister } from "../extractors/risk.js";
import { buildSurfaceManifest } from "../extractors/surfaces.js";
import { initializeCoverageFromPlan } from "./planning.js";
import { buildFlowCoverage } from "./flowCoverage.js";
import { buildRequeuePayload } from "./requeueCommand.js";
import {
  buildRuntimeValidationTasks,
  discoverRuntimeValidationCommand,
  mergeRuntimeValidationReport,
} from "./runtimeValidation.js";
import {
  applyNarrative,
  buildAuditFindingsReport,
  buildAuditReportModel,
  renderAuditReportMarkdown,
} from "../reporting/synthesis.js";
import type { SynthesisNarrative } from "@audit-tools/shared";
import type { SynthesisNarrativeRecord } from "../types/synthesisNarrative.js";
import {
  buildChunkedAuditTasks,
} from "./taskBuilder.js";
import {
  buildAuditPlanMetrics,
  buildReviewPackets,
  sizeIndexFromManifest,
} from "./reviewPackets.js";
import { buildUnitManifest } from "./unitBuilder.js";
import { buildRepoManifestFromFs } from "../extractors/fsIntake.js";
import { loadIgnoreFile } from "../extractors/ignore.js";
import {
  ingestAuditResults,
  updateAuditTaskStatuses,
} from "./resultIngestion.js";
import { buildDesignAssessment } from "../extractors/designAssessment.js";
import { buildSelectiveDeepeningTasks } from "./selectiveDeepening.js";
import { updateRuntimeValidationReport } from "./runtimeValidationUpdate.js";
import { autoCompleteTrivialCoverage } from "./trivialAudit.js";

export interface ExecutorRunResult {
  updated: ArtifactBundle;
  artifacts_written: string[];
  progress_summary: string;
}

function lineIndexFromTasks(tasks: AuditTask[] | undefined): Record<string, number> {
  return Object.fromEntries(
    (tasks ?? []).flatMap((task) => Object.entries(task.file_line_counts ?? {})),
  );
}

function appendSelectiveDeepeningTasks(params: {
  bundle: ArtifactBundle;
  results: AuditResult[];
  runtimeValidationReport?: RuntimeValidationReport;
}): { bundle: ArtifactBundle; taskCount: number; artifacts: string[] } {
  if (!params.bundle.audit_tasks) {
    return { bundle: params.bundle, taskCount: 0, artifacts: [] };
  }

  const lineIndex = lineIndexFromTasks(params.bundle.audit_tasks);
  const sizeIndex = sizeIndexFromManifest(params.bundle.repo_manifest);
  const selectiveDeepeningTasks = buildSelectiveDeepeningTasks({
    existingTasks: params.bundle.audit_tasks,
    results: params.results,
    lineIndex,
    runtimeValidationTasks: params.bundle.runtime_validation_tasks,
    runtimeValidationReport:
      params.runtimeValidationReport ?? params.bundle.runtime_validation_report,
    externalAnalyzerResults: params.bundle.external_analyzer_results,
  });

  if (selectiveDeepeningTasks.length === 0) {
    return { bundle: params.bundle, taskCount: 0, artifacts: [] };
  }

  const auditTasks = [...params.bundle.audit_tasks, ...selectiveDeepeningTasks];
  return {
    bundle: {
      ...params.bundle,
      audit_tasks: auditTasks,
      audit_plan_metrics: buildAuditPlanMetrics(auditTasks, {
        graphBundle: params.bundle.graph_bundle,
        lineIndex,
        sizeIndex,
      }),
      review_packets: buildReviewPackets(auditTasks, {
        graphBundle: params.bundle.graph_bundle,
        lineIndex,
        sizeIndex,
      }),
    },
    taskCount: selectiveDeepeningTasks.length,
    artifacts: ["audit_tasks.json", "audit_plan_metrics.json", "review_packets.json"],
  };
}

function resolveOpentokenWrap(
  resolved: { command: string; args: string[] },
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const shell = process.env.ComSpec ?? "cmd.exe";
    const inner = [resolved.command, ...resolved.args]
      .map((v) => (/^[A-Za-z0-9_./:=@+-]+$/.test(v) ? v : `"${v.replace(/(["^&|<>%])/g, "^$1")}"`))
      .join(" ");
    return { command: shell, args: ["/d", "/s", "/c", `opentoken wrap ${inner}`] };
  }
  return { command: "opentoken", args: ["wrap", resolved.command, ...resolved.args] };
}

async function runCommand(
  command: string[],
  cwd: string,
  options: { opentoken?: boolean } = {},
): Promise<{
  status: "confirmed" | "not_confirmed" | "inconclusive";
  summary: string;
  evidence: string[];
}> {
  let spawnCommand = resolveRuntimeValidationSpawnCommand(command);
  if (options.opentoken) {
    spawnCommand = resolveOpentokenWrap(spawnCommand);
  }
  const displayCommand = command.join(" ");
  return await new Promise((resolve) => {
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        status: "inconclusive",
        summary: `Failed to execute ${displayCommand}: ${error.message}`,
        evidence: [],
      });
    });
    child.on("exit", (code) => {
      const output = `${stdout}\n${stderr}`.trim();
      const evidence = output.length > 0 ? output.split(/\r?\n/).slice(-10) : [];
      resolve({
        status: code === 0 ? "confirmed" : "not_confirmed",
        summary:
          code === 0
            ? `Deterministic runtime command succeeded: ${displayCommand}`
            : `Deterministic runtime command failed with exit code ${code}: ${displayCommand}`,
        evidence,
      });
    });
  });
}

export function resolveRuntimeValidationSpawnCommand(
  command: string[],
  platform: NodeJS.Platform = process.platform,
  shellCommand = process.env.ComSpec ?? "cmd.exe",
): { command: string; args: string[] } {
  const [executable, ...args] = command;
  if (!executable) {
    return { command: "", args: [] };
  }
  if (platform !== "win32") {
    return { command: executable, args };
  }
  const packageManager = executable.replace(/\.(cmd|bat)$/i, "").toLowerCase();
  if (["npm", "npx", "pnpm", "yarn"].includes(packageManager)) {
    return {
      command: shellCommand,
      args: ["/d", "/s", "/c", command.map(quoteCmdArg).join(" ")],
    };
  }
  return { command: executable, args };
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["^&|<>%])/g, "^$1")}"`;
}

export async function runIntakeExecutor(
  bundle: ArtifactBundle,
  root: string,
): Promise<ExecutorRunResult> {
  const ignore = await loadIgnoreFile(root);
  const repoManifest = await buildRepoManifestFromFs({
    root,
    ignore,
    hash_files: true,
  });
  const disposition = buildFileDisposition(repoManifest);
  const auditableCount = disposition.files.filter(
    (file) => !isAuditExcludedStatus(file.status),
  ).length;

  if (auditableCount === 0) {
    throw new Error(
      `No auditable files found in ${root}. The repository may be empty, generated-only, documentation-only, or filtered by .auditorignore.`,
    );
  }

  return {
    updated: {
      ...bundle,
      repo_manifest: repoManifest,
      file_disposition: disposition,
    },
    artifacts_written: ["repo_manifest.json", "file_disposition.json"],
    progress_summary: `Created intake artifacts for ${repoManifest.files.length} files.`,
  };
}

export async function runStructureExecutor(
  bundle: ArtifactBundle,
  root?: string,
): Promise<ExecutorRunResult> {
  if (!bundle.repo_manifest) {
    throw new Error("Cannot run structure executor without repo_manifest");
  }

  const externalAnalyzerResults = bundle.external_analyzer_results;
  const disposition =
    bundle.file_disposition ?? buildFileDisposition(bundle.repo_manifest);
  const unitManifest = buildUnitManifest(bundle.repo_manifest, disposition);
  const graphBundle = root
    ? await buildGraphBundleFromFs(bundle.repo_manifest, root, disposition, {
        externalAnalyzerResults,
      })
    : buildGraphBundle(bundle.repo_manifest, disposition, {
        externalAnalyzerResults,
      });
  const surfaceManifest = buildSurfaceManifest(
    bundle.repo_manifest,
    disposition,
    { graphBundle },
  );
  const criticalFlows = buildCriticalFlowManifest(
    bundle.repo_manifest,
    surfaceManifest,
    disposition,
  );
  const riskRegister = buildRiskRegister(
    unitManifest,
    criticalFlows,
    externalAnalyzerResults,
  );

  return {
    updated: {
      ...bundle,
      file_disposition: disposition,
      unit_manifest: unitManifest,
      surface_manifest: surfaceManifest,
      graph_bundle: graphBundle,
      critical_flows: criticalFlows,
      risk_register: riskRegister,
    },
    artifacts_written: [
      "file_disposition.json",
      "unit_manifest.json",
      "surface_manifest.json",
      "graph_bundle.json",
      "critical_flows.json",
      "risk_register.json",
    ],
    progress_summary:
      `Built structure artifacts for ${unitManifest.units.length} units and ${criticalFlows.flows.length} critical flows.` +
      (criticalFlows.fallback_required
        ? " Deterministic flow inference did not fully meet the confidence bar."
        : ""),
  };
}

export function runDesignAssessmentExecutor(
  bundle: ArtifactBundle,
): ExecutorRunResult {
  if (
    !bundle.unit_manifest ||
    !bundle.graph_bundle ||
    !bundle.critical_flows ||
    !bundle.risk_register
  ) {
    throw new Error(
      "Cannot run design assessment executor without structure artifacts",
    );
  }

  const designAssessment = buildDesignAssessment({
    unitManifest: bundle.unit_manifest,
    graphBundle: bundle.graph_bundle,
    criticalFlows: bundle.critical_flows,
    riskRegister: bundle.risk_register,
  });

  const previous = bundle.design_assessment;
  if (previous?.reviewed) {
    designAssessment.reviewed = true;
    designAssessment.review_findings = previous.review_findings ?? [];
  }

  return {
    updated: {
      ...bundle,
      design_assessment: designAssessment,
    },
    artifacts_written: ["design_assessment.json"],
    progress_summary: `Design assessment complete: ${designAssessment.findings.length} structural finding(s).`,
  };
}

export function runDesignReviewAutoComplete(
  bundle: ArtifactBundle,
): ExecutorRunResult {
  const existing = bundle.design_assessment;
  if (!existing) {
    throw new Error(
      "Cannot auto-complete design review without design_assessment artifact",
    );
  }

  const updated = {
    ...existing,
    reviewed: true,
    review_findings: existing.review_findings ?? [],
  };

  return {
    updated: {
      ...bundle,
      design_assessment: updated,
    },
    artifacts_written: ["design_assessment.json"],
    progress_summary:
      "Design review auto-completed (host-agent review available via next-step).",
  };
}

export async function runPlanningExecutor(
  bundle: ArtifactBundle,
  root: string,
  lineIndex: Record<string, number> = {},
  sizeIndex?: Record<string, number>,
): Promise<ExecutorRunResult> {
  if (!bundle.repo_manifest) {
    throw new Error("Cannot run planning executor without repo_manifest");
  }
  const resolvedSizeIndex = sizeIndex ?? sizeIndexFromManifest(bundle.repo_manifest);
  if (
    !bundle.file_disposition ||
    !bundle.unit_manifest ||
    !bundle.surface_manifest ||
    !bundle.critical_flows ||
    !bundle.risk_register
  ) {
    throw new Error(
      "Cannot run planning executor without current structure artifacts",
    );
  }

  const externalAnalyzerResults = bundle.external_analyzer_results;
  const coverage = initializeCoverageFromPlan(
    bundle.repo_manifest,
    bundle.unit_manifest,
    bundle.file_disposition,
    externalAnalyzerResults,
  );
  const skippedTrivialPaths = autoCompleteTrivialCoverage(
    coverage,
    lineIndex,
    externalAnalyzerResults,
  );
  const flowCoverage = buildFlowCoverage(bundle.critical_flows, coverage);
  const runtimeCommand = await discoverRuntimeValidationCommand(root);
  const runtimeValidationTasks = buildRuntimeValidationTasks({
    unitManifest: bundle.unit_manifest,
    criticalFlows: bundle.critical_flows,
    flowCoverage,
    command: runtimeCommand,
  });
  const runtimeValidationReport = runtimeValidationTasks.tasks.length > 0
    ? mergeRuntimeValidationReport(
        runtimeValidationTasks,
        bundle.runtime_validation_report,
      )
    : undefined;
  const auditTasks = buildChunkedAuditTasks(coverage, lineIndex, {
    external_analyzer_results: externalAnalyzerResults,
    critical_flows: bundle.critical_flows,
  });
  const taggedAuditTasks = auditTasks.map((task) => ({
    ...task,
    status: task.status ?? ("pending" as const),
  }));
  const reviewPackets = buildReviewPackets(taggedAuditTasks, {
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex: resolvedSizeIndex,
  });
  const auditPlanMetrics = buildAuditPlanMetrics(taggedAuditTasks, {
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex: resolvedSizeIndex,
  });
  const requeuePayload = buildRequeuePayload(
    coverage,
    bundle.critical_flows,
    flowCoverage,
    externalAnalyzerResults,
  );

  return {
    updated: {
      ...bundle,
      coverage_matrix: coverage,
      flow_coverage: flowCoverage,
      runtime_validation_tasks: runtimeValidationTasks,
      runtime_validation_report: runtimeValidationReport,
      audit_tasks: taggedAuditTasks,
      audit_plan_metrics: auditPlanMetrics,
      review_packets: reviewPackets,
      requeue_tasks: requeuePayload.tasks,
      audit_report: undefined,
    },
    artifacts_written: [
      "coverage_matrix.json",
      "flow_coverage.json",
      "runtime_validation_tasks.json",
      ...(runtimeValidationReport ? ["runtime_validation_report.json"] : []),
      "audit_tasks.json",
      "audit_plan_metrics.json",
      "review_packets.json",
      "requeue_tasks.json",
    ],
    progress_summary:
      `Built planning artifacts; generated ${taggedAuditTasks.length} review tasks in ${reviewPackets.length} packet(s) and ${requeuePayload.task_count} requeue tasks.` +
      (skippedTrivialPaths.length > 0
        ? ` Skipped ${skippedTrivialPaths.length} trivial path${skippedTrivialPaths.length === 1 ? "" : "s"} from semantic review.`
        : "") +
      (runtimeCommand
        ? ` Runtime validation will use: ${runtimeCommand.join(" ")}.`
        : " No deterministic runtime validation command was discovered."),
  };
}

export function runResultIngestionExecutor(
  bundle: ArtifactBundle,
  results: AuditResult[],
): ExecutorRunResult {
  if (!bundle.coverage_matrix) {
    throw new Error("Cannot ingest results without coverage_matrix");
  }

  const updatedCoverageMatrix = ingestAuditResults(bundle.coverage_matrix, results);
  const flowCoverage = bundle.critical_flows
    ? buildFlowCoverage(bundle.critical_flows, updatedCoverageMatrix)
    : bundle.flow_coverage;
  const runtimeCommand = bundle.runtime_validation_tasks?.tasks.find(
    (task) => task.command && task.command.length > 0,
  )?.command;
  const runtimeValidationTasks =
    bundle.unit_manifest && flowCoverage
      ? buildRuntimeValidationTasks({
          unitManifest: bundle.unit_manifest,
          criticalFlows: bundle.critical_flows,
          flowCoverage,
          command: runtimeCommand,
        })
      : bundle.runtime_validation_tasks;
  const runtimeValidationReport = runtimeValidationTasks
    ? mergeRuntimeValidationReport(
        runtimeValidationTasks,
        bundle.runtime_validation_report,
      )
    : bundle.runtime_validation_report;
  const mergedResults = [...(bundle.audit_results ?? []), ...results];
  const completedAuditTasks = updateAuditTaskStatuses(
    bundle.audit_tasks,
    mergedResults,
  );
  const baseUpdatedBundle: ArtifactBundle = {
    ...bundle,
    coverage_matrix: updatedCoverageMatrix,
    flow_coverage: flowCoverage,
    runtime_validation_tasks: runtimeValidationTasks,
    runtime_validation_report: runtimeValidationReport,
    audit_results: mergedResults,
    audit_tasks: completedAuditTasks,
    audit_report: undefined,
  };
  const selectiveDeepening = appendSelectiveDeepeningTasks({
    bundle: baseUpdatedBundle,
    results: mergedResults,
    runtimeValidationReport,
  });
  const requeuePayload = buildRequeuePayload(
    updatedCoverageMatrix,
    selectiveDeepening.bundle.critical_flows,
    selectiveDeepening.bundle.flow_coverage,
    selectiveDeepening.bundle.external_analyzer_results,
  );
  const finalBundle: ArtifactBundle = {
    ...selectiveDeepening.bundle,
    requeue_tasks: requeuePayload.tasks,
  };

  return {
    updated: finalBundle,
    artifacts_written: [
      "coverage_matrix.json",
      "flow_coverage.json",
      ...(runtimeValidationTasks ? ["runtime_validation_tasks.json"] : []),
      ...(runtimeValidationReport ? ["runtime_validation_report.json"] : []),
      "audit_results.jsonl",
      "audit_tasks.json",
      ...selectiveDeepening.artifacts.filter(
        (artifact) => artifact !== "audit_tasks.json",
      ),
      "requeue_tasks.json",
    ],
    progress_summary:
      `Ingested ${results.length} audit result entries and refreshed dependent artifacts.` +
      (selectiveDeepening.taskCount > 0
        ? ` Added ${selectiveDeepening.taskCount} selective deepening task(s).`
        : ""),
  };
}

export async function runRuntimeValidationExecutor(
  bundle: ArtifactBundle,
  root: string,
  options: { opentoken?: boolean } = {},
): Promise<ExecutorRunResult> {
  if (!bundle.runtime_validation_tasks) {
    throw new Error("Cannot execute runtime validation without runtime_validation_tasks");
  }

  const existing = bundle.runtime_validation_report ?? { results: [] };
  const byTaskId = new Map(existing.results.map((result) => [result.task_id, result]));
  const byCommand = new Map<string, Awaited<ReturnType<typeof runCommand>>>();

  for (const task of bundle.runtime_validation_tasks.tasks) {
    const prior = byTaskId.get(task.id);
    if (
      prior &&
      ["confirmed", "not_confirmed", "inconclusive", "not_required"].includes(
        prior.status,
      )
    ) {
      continue;
    }
    if (!task.command || task.command.length === 0) {
      byTaskId.set(task.id, {
        task_id: task.id,
        status: "not_required",
        summary: `No deterministic runtime command was available for ${task.id}.`,
        evidence: [],
        notes: ["Runtime validation was not planned for this task."],
      });
      continue;
    }

    const signature = task.command.join("\0");
    const outcome =
      byCommand.get(signature) ?? (await runCommand(task.command, root, { opentoken: options.opentoken }));
    byCommand.set(signature, outcome);
    byTaskId.set(task.id, {
      task_id: task.id,
      status: outcome.status,
      summary: outcome.summary,
      evidence: outcome.evidence,
      notes: [`Target paths: ${task.target_paths.join(", ")}`],
    });
  }

  const runtimeValidationReport: RuntimeValidationReport = {
    results: [...byTaskId.values()].sort((a, b) => a.task_id.localeCompare(b.task_id)),
  };
  const baseUpdatedBundle: ArtifactBundle = {
    ...bundle,
    runtime_validation_report: runtimeValidationReport,
    audit_report: undefined,
  };
  const selectiveDeepening = appendSelectiveDeepeningTasks({
    bundle: baseUpdatedBundle,
    results: bundle.audit_results ?? [],
    runtimeValidationReport,
  });

  return {
    updated: selectiveDeepening.bundle,
    artifacts_written: [
      "runtime_validation_report.json",
      ...selectiveDeepening.artifacts,
    ],
    progress_summary:
      `Executed deterministic runtime validation for ${bundle.runtime_validation_tasks.tasks.length} task(s).` +
      (selectiveDeepening.taskCount > 0
        ? ` Added ${selectiveDeepening.taskCount} selective deepening task(s).`
        : ""),
  };
}

export function runRuntimeValidationUpdateExecutor(
  bundle: ArtifactBundle,
  updates: RuntimeValidationReport,
): ExecutorRunResult {
  if (!bundle.runtime_validation_tasks) {
    throw new Error(
      "Cannot update runtime validation without runtime_validation_tasks",
    );
  }
  const existingReport =
    bundle.runtime_validation_report ?? { results: [] };
  const mergedReport = updateRuntimeValidationReport(
    bundle.runtime_validation_tasks,
    existingReport,
    updates,
  );
  const baseUpdatedBundle: ArtifactBundle = {
    ...bundle,
    runtime_validation_report: mergedReport,
    audit_report: undefined,
  };
  const selectiveDeepening = appendSelectiveDeepeningTasks({
    bundle: baseUpdatedBundle,
    results: bundle.audit_results ?? [],
    runtimeValidationReport: mergedReport,
  });

  return {
    updated: selectiveDeepening.bundle,
    artifacts_written: [
      "runtime_validation_report.json",
      ...selectiveDeepening.artifacts,
    ],
    progress_summary:
      `Merged ${updates.results.length} runtime validation updates.` +
      (selectiveDeepening.taskCount > 0
        ? ` Added ${selectiveDeepening.taskCount} selective deepening task(s).`
        : ""),
  };
}

function buildBaseFindingsReport(
  bundle: ArtifactBundle,
  results: AuditResult[],
) {
  return buildAuditFindingsReport(
    buildAuditReportModel({
      results,
      unitManifest: bundle.unit_manifest,
      graphBundle: bundle.graph_bundle,
      criticalFlows: bundle.critical_flows,
      coverageMatrix: bundle.coverage_matrix,
      runtimeValidationReport: bundle.runtime_validation_report,
      externalAnalyzerResults: bundle.external_analyzer_results,
      designAssessment: bundle.design_assessment,
    }),
  );
}

export function runSynthesisExecutor(
  bundle: ArtifactBundle,
  results?: AuditResult[],
): ExecutorRunResult {
  const finalResults = results ?? bundle.audit_results ?? [];
  // Emit the canonical machine contract and render the human report from it.
  // No narrative yet — that is layered by the synthesis-narrative obligation.
  const findings = buildBaseFindingsReport(bundle, finalResults);

  return {
    updated: {
      ...bundle,
      audit_results: finalResults,
      audit_findings: findings,
      audit_report: renderAuditReportMarkdown(findings),
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
      audit_report: renderAuditReportMarkdown(enriched),
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

export function runExternalAnalyzerImportExecutor(
  bundle: ArtifactBundle,
  externalResults: ExternalAnalyzerResults,
): ExecutorRunResult {
  const summary = `Imported ${externalResults.results.length} normalized findings from ${externalResults.tool}.`;
  return {
    updated: {
      ...bundle,
      external_analyzer_results: externalResults,
      coverage_matrix: undefined,
      flow_coverage: undefined,
      runtime_validation_tasks: undefined,
      runtime_validation_report: undefined,
      audit_tasks: undefined,
      audit_plan_metrics: undefined,
      review_packets: undefined,
      requeue_tasks: undefined,
      audit_report: undefined,
    },
    artifacts_written: ["external_analyzer_results.json"],
    progress_summary: summary,
  };
}
