import { cp, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  AuditResult,
  AuditTask,
  CoverageMatrix,
  RepoManifest,
  UnitManifest,
} from "../types.js";
import type { AuditState } from "../types/auditState.js";
import type { ArtifactMetadataManifest } from "../types/artifactMetadata.js";
import type { AuditFindingsReport, FileDisposition, CriticalFlowManifest, GraphBundle, RiskRegister, SurfaceManifest } from "@audit-tools/shared";
import type { SynthesisNarrativeRecord } from "../types/synthesisNarrative.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { FlowCoverageManifest } from "../types/flowCoverage.js";
import type {
  AuditPlanMetrics,
  ReviewPacket,
} from "../types/reviewPlanning.js";
import type {
  RuntimeValidationReport,
  RuntimeValidationTaskManifest,
} from "../types/runtimeValidation.js";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { AnalyzerCapabilityRecord } from "../types/analyzerCapability.js";
import type { AuditScopeManifest } from "../types/auditScope.js";
import type { ToolingManifest } from "../types/toolingManifest.js";
import type { ActiveDispatchState } from "../types/activeDispatch.js";
import {
  isFileMissingError,
  readOptionalJsonFile,
  readOptionalNdjsonFile,
  readOptionalTextFile,
  writeJsonFile,
  writeNdjsonFile,
  writeTextFile,
} from "@audit-tools/shared";
import { buildToolingManifest } from "./toolingManifest.js";

type ArtifactPayloadMap = {
  // --- Phase 1: Intake & classification ---
  repo_manifest: RepoManifest;
  file_disposition: FileDisposition;
  auto_fixes_applied: unknown;

  // --- Phase 2: Structural analysis ---
  unit_manifest: UnitManifest;
  graph_bundle: GraphBundle;
  surface_manifest: SurfaceManifest;
  critical_flows: CriticalFlowManifest;
  flow_coverage: FlowCoverageManifest;
  risk_register: RiskRegister;
  design_assessment: DesignAssessment;
  analyzer_capability: AnalyzerCapabilityRecord;

  // --- Phase 3: Audit execution ---
  scope: AuditScopeManifest;
  coverage_matrix: CoverageMatrix;
  runtime_validation_tasks: RuntimeValidationTaskManifest;
  runtime_validation_report: RuntimeValidationReport;
  external_analyzer_results: ExternalAnalyzerResults;
  syntax_resolution_status: unknown;
  audit_results: AuditResult[];
  audit_tasks: AuditTask[];
  audit_plan_metrics: AuditPlanMetrics;
  review_packets: ReviewPacket[];
  requeue_tasks: AuditTask[];

  // --- Phase 4: Reporting ---
  audit_report: string;
  audit_findings: AuditFindingsReport;
  synthesis_narrative: SynthesisNarrativeRecord;

  // --- Supervisor metadata ---
  audit_state: AuditState;
  artifact_metadata: ArtifactMetadataManifest;
  tooling_manifest: ToolingManifest;
};

/**
 * Audit artifacts accumulate phase-by-phase as the orchestrator advances.
 * Missing keys mean the corresponding artifact has not been produced yet.
 *
 * `active_dispatch` is loaded specially (like `tooling_manifest`): it lives at
 * the artifacts root rather than as a standard pruned artifact, and carries the
 * in-flight dispatch phase plus any budget-deferred task ids the completion
 * obligation must exclude.
 */
export type ArtifactBundle = Partial<ArtifactPayloadMap> & {
  active_dispatch?: ActiveDispatchState;
};
export type ArtifactBundleKey = keyof ArtifactPayloadMap;
type ArtifactPhase =
  | "intake"
  | "analysis"
  | "execution"
  | "reporting"
  | "supervisor";

interface ArtifactDefinition<K extends ArtifactBundleKey = ArtifactBundleKey> {
  fileName: string;
  phase: ArtifactPhase;
  read: (path: string) => Promise<ArtifactPayloadMap[K] | undefined>;
  write: (path: string, value: ArtifactPayloadMap[K]) => Promise<void>;
}

// Canonical filename for the rendered findings report. Single source of truth
// for path construction. The dependency table below still lists it as plain
// data alongside its sibling artifact-name literals.
export const AUDIT_REPORT_FILENAME = "audit-report.md";

function jsonArtifact<K extends ArtifactBundleKey>(
  fileName: string,
  phase: ArtifactPhase,
): ArtifactDefinition<K> {
  return {
    fileName,
    phase,
    read: (path) => readOptionalJsonFile<ArtifactPayloadMap[K]>(path),
    write: (path, value) => writeJsonFile(path, value),
  };
}

function ndjsonArtifact<K extends ArtifactBundleKey>(
  fileName: string,
  phase: ArtifactPhase,
): ArtifactDefinition<K> {
  type NdjsonItem = ArtifactPayloadMap[K] extends Array<infer Item>
    ? Item
    : never;
  return {
    fileName,
    phase,
    read: (path) =>
      readOptionalNdjsonFile<NdjsonItem>(path) as Promise<
        ArtifactPayloadMap[K] | undefined
      >,
    write: (path, value) => writeNdjsonFile(path, value as NdjsonItem[]),
  };
}

function textArtifact<K extends ArtifactBundleKey>(
  fileName: string,
  phase: ArtifactPhase,
): ArtifactDefinition<K> {
  return {
    fileName,
    phase,
    read: (path) => readOptionalTextFile(path) as Promise<ArtifactPayloadMap[K] | undefined>,
    write: (path, value) => writeTextFile(path, value as string),
  };
}

export const ARTIFACT_DEFINITIONS = {
  repo_manifest: jsonArtifact("repo_manifest.json", "intake"),
  file_disposition: jsonArtifact("file_disposition.json", "intake"),
  auto_fixes_applied: jsonArtifact("auto_fixes_applied.json", "intake"),
  unit_manifest: jsonArtifact("unit_manifest.json", "analysis"),
  graph_bundle: jsonArtifact("graph_bundle.json", "analysis"),
  surface_manifest: jsonArtifact("surface_manifest.json", "analysis"),
  critical_flows: jsonArtifact("critical_flows.json", "analysis"),
  flow_coverage: jsonArtifact("flow_coverage.json", "analysis"),
  risk_register: jsonArtifact("risk_register.json", "analysis"),
  design_assessment: jsonArtifact("design_assessment.json", "analysis"),
  analyzer_capability: jsonArtifact("analyzer_capability.json", "analysis"),
  scope: jsonArtifact("scope.json", "execution"),
  coverage_matrix: jsonArtifact("coverage_matrix.json", "execution"),
  runtime_validation_tasks: jsonArtifact(
    "runtime_validation_tasks.json",
    "execution",
  ),
  runtime_validation_report: jsonArtifact(
    "runtime_validation_report.json",
    "execution",
  ),
  external_analyzer_results: jsonArtifact(
    "external_analyzer_results.json",
    "execution",
  ),
  syntax_resolution_status: jsonArtifact(
    "syntax_resolution_status.json",
    "execution",
  ),
  audit_results: ndjsonArtifact("audit_results.jsonl", "execution"),
  audit_tasks: jsonArtifact("audit_tasks.json", "execution"),
  audit_plan_metrics: jsonArtifact("audit_plan_metrics.json", "execution"),
  review_packets: jsonArtifact("review_packets.json", "execution"),
  requeue_tasks: jsonArtifact("requeue_tasks.json", "execution"),
  audit_report: textArtifact(AUDIT_REPORT_FILENAME, "reporting"),
  audit_findings: jsonArtifact("audit-findings.json", "reporting"),
  synthesis_narrative: jsonArtifact("synthesis-narrative.json", "reporting"),
  audit_state: jsonArtifact("audit_state.json", "supervisor"),
  artifact_metadata: jsonArtifact("artifact_metadata.json", "supervisor"),
  tooling_manifest: jsonArtifact("tooling_manifest.json", "supervisor"),
} as const satisfies { [K in ArtifactBundleKey]: ArtifactDefinition<K> };

type ArtifactDefinitionEntry = {
  [K in ArtifactBundleKey]: [K, ArtifactDefinition<K>];
}[ArtifactBundleKey];

const ARTIFACT_ENTRIES = Object.entries(
  ARTIFACT_DEFINITIONS,
) as ArtifactDefinitionEntry[];

export const ARTIFACT_FILE_TO_BUNDLE_KEY: Record<string, ArtifactBundleKey> =
  Object.fromEntries(
    ARTIFACT_ENTRIES.map(([key, definition]) => [definition.fileName, key]),
  );

export function getArtifactValue(
  bundle: ArtifactBundle,
  artifactName: string,
): unknown {
  const key = ARTIFACT_FILE_TO_BUNDLE_KEY[artifactName];
  return key ? bundle[key] : undefined;
}

export async function loadArtifactBundle(
  root: string,
): Promise<ArtifactBundle> {
  const bundle: ArtifactBundle = {};
  const bundleRecord = bundle as Partial<Record<ArtifactBundleKey, unknown>>;
  for (const entry of ARTIFACT_ENTRIES) {
    const [key, definition] = entry;
    const value = await definition.read(join(root, definition.fileName));
    if (value !== undefined) {
      bundleRecord[key] = value;
    }
  }

  bundle.tooling_manifest = await buildToolingManifest();

  // active-dispatch.json is written by prepare-dispatch at the artifacts root
  // (not a standard ARTIFACT_DEFINITIONS entry). Load it so the completion
  // obligation can exclude budget-deferred tasks. Absent on a fresh run.
  const activeDispatch = await readOptionalJsonFile<ActiveDispatchState>(
    join(root, "active-dispatch.json"),
  );
  if (activeDispatch !== undefined) {
    bundle.active_dispatch = activeDispatch;
  }

  return bundle;
}

export async function writeCoreArtifacts(
  root: string,
  bundle: ArtifactBundle,
  options: { prune?: boolean } = {},
): Promise<void> {
  const bundleRecord = bundle as Partial<Record<ArtifactBundleKey, unknown>>;
  for (const entry of ARTIFACT_ENTRIES) {
    const [key, definition] = entry;
    const value = bundleRecord[key];
    const path = join(root, definition.fileName);
    if (value !== undefined) {
      await definition.write(path, value as never);
    } else if (options.prune) {
      // The bundle is authoritative. An executor that clears an artifact to
      // `undefined` (to force a downstream rebuild — e.g. planning/ingestion
      // reset audit_report) intends the file gone; if it lingers it reloads as a
      // stale "present" artifact with no metadata entry, which deriveAuditState
      // reads as satisfied — masking the invalidation and stranding a stale
      // report. Only callers passing the full accumulated bundle may prune.
      try {
        await unlink(path);
      } catch (error) {
        if (!isFileMissingError(error)) throw error;
      }
    }
  }
}

export async function cleanupIntermediateArtifacts(
  root: string,
): Promise<string[]> {
  const deleted: string[] = [];
  for (const [, definition] of ARTIFACT_ENTRIES) {
    const path = join(root, definition.fileName);
    try {
      await unlink(path);
      deleted.push(definition.fileName);
    } catch (error) {
      if (isFileMissingError(error)) {
        continue;
      }
      throw error;
    }
  }
  return deleted;
}

export async function promoteFinalAuditReport(params: {
  artifactsDir: string;
  repoRoot: string;
}, options: {
  copy?: typeof cp;
  remove?: typeof rm;
  warn?: (message: string) => void;
} = {}): Promise<{ promoted: boolean; cleaned: boolean; warning?: string }> {
  const source = join(params.artifactsDir, AUDIT_REPORT_FILENAME);
  const destination = join(params.repoRoot, AUDIT_REPORT_FILENAME);
  const copy = options.copy ?? cp;
  const remove = options.remove ?? rm;
  const warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  try {
    await copy(source, destination, { force: true });
  } catch (error) {
    const warning =
      `audit-code: completed audit but could not promote final report to ${destination}: ` +
      (error instanceof Error ? error.message : String(error));
    warn(warning);
    return { promoted: false, cleaned: false, warning };
  }
  // Promote the canonical machine contract alongside the human report. Missing
  // (e.g. legacy bundle) or unreadable: best-effort, never blocks completion.
  try {
    await copy(
      join(params.artifactsDir, "audit-findings.json"),
      join(params.repoRoot, "audit-findings.json"),
      { force: true },
    );
  } catch (error) {
    // audit-findings.json is optional output; absence must not fail promotion.
    // Log so operators can distinguish a partial promotion from a clean one.
    warn(
      `audit-code: could not promote audit-findings.json to ${join(params.repoRoot, "audit-findings.json")}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  try {
    await remove(params.artifactsDir, { recursive: true, force: true });
    return { promoted: true, cleaned: true };
  } catch (error) {
    const warning =
      `audit-code: promoted final report to ${destination}, but could not remove ${params.artifactsDir}: ` +
      (error instanceof Error ? error.message : String(error));
    warn(warning);
    return { promoted: true, cleaned: false, warning };
  }
}
