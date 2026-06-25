import { cp, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AUDIT_REPORT_FILENAME,
  AUDIT_FINDINGS_FILENAME,
  auditReportPath,
  auditFindingsPath,
  promotedAuditReportPath,
  promotedAuditFindingsPath,
} from "audit-tools/shared";
import type {
  AuditResult,
  AuditTask,
  CoverageMatrix,
  RepoManifest,
  UnitManifest,
} from "../types.js";
import type { AuditState } from "../types/auditState.js";
import type { ArtifactMetadataManifest } from "../types/artifactMetadata.js";
import type { AuditFindingsReport, FileDisposition, CriticalFlowManifest, GraphBundle, RiskRegister, SurfaceManifest, IntentCheckpoint, GitHistory } from "audit-tools/shared";
import type { ProviderConfirmationResult } from "audit-tools/shared";
import { PROVIDER_CONFIRMATION_RESULT_VERSION } from "audit-tools/shared";
import type { SynthesisNarrativeRecord } from "../types/synthesisNarrative.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { FlowCoverageManifest } from "../types/flowCoverage.js";
import type { AuditPlanMetrics } from "../types/reviewPlanning.js";
import type { TaskAffinityGraph } from "../orchestrator/taskAffinityGraph.js";
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
  loadDesignReviewSnapshots,
  type DesignReviewSnapshotBundle,
} from "../orchestrator/designReviewSnapshot.js";
import {
  AGENT_FEEDBACK_FILENAME,
  isFileMissingError,
  parseReflectionsNdjson,
  readOptionalJsonFile,
  readOptionalNdjsonFile,
  readOptionalTextFile,
  writeJsonFile,
  writeNdjsonFile,
  writeTextFile,
  type AgentReflection,
} from "audit-tools/shared";
import { buildToolingManifest } from "./toolingManifest.js";

// ---------------------------------------------------------------------------
// Schema-version guard (ARC-dd468422)
// ---------------------------------------------------------------------------

/**
 * Thrown when a versioned artifact is loaded from disk with a schema_version
 * field that does not match the expected version constant.  The message names
 * the artifact and both the expected and actual versions so the operator has
 * an actionable diagnosis.
 */
export class ArtifactSchemaVersionError extends Error {
  constructor(
    public readonly artifactName: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Artifact "${artifactName}" has schema_version "${actual}" but expected "${expected}". ` +
        `This likely means the artifact was produced by an incompatible version of audit-code. ` +
        `Delete ${artifactName} from the artifacts directory to regenerate it.`,
    );
    this.name = "ArtifactSchemaVersionError";
  }
}

/**
 * Verify the schema_version field of a loaded artifact against the expected
 * value.  Throws {@link ArtifactSchemaVersionError} on mismatch; silently
 * returns on `undefined` (artifact not yet produced).
 */
function assertArtifactSchemaVersion(
  artifact: { schema_version?: string } | undefined,
  artifactName: string,
  expected: string,
): void {
  if (artifact === undefined) return;
  const actual = (artifact as Record<string, unknown>).schema_version;
  if (typeof actual !== "string") {
    throw new ArtifactSchemaVersionError(artifactName, expected, String(actual));
  }
  if (actual !== expected) {
    throw new ArtifactSchemaVersionError(artifactName, expected, actual);
  }
}

type ArtifactPayloadMap = {
  // --- Phase 0: Session gate ---
  provider_confirmation: ProviderConfirmationResult;

  // --- Phase 1: Intake & classification ---
  repo_manifest: RepoManifest;
  file_disposition: FileDisposition;
  auto_fixes_applied: unknown;
  intent_checkpoint: IntentCheckpoint;

  // --- Phase 2: Structural analysis ---
  unit_manifest: UnitManifest;
  graph_bundle: GraphBundle;
  surface_manifest: SurfaceManifest;
  critical_flows: CriticalFlowManifest;
  flow_coverage: FlowCoverageManifest;
  risk_register: RiskRegister;
  git_history: GitHistory;
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
  task_affinity_graph: TaskAffinityGraph;
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
 *
 * `agent_reflections` is the parsed view of the worker-APPENDED
 * `agent-feedback.jsonl` (opt-in meta-audit feedback). Workers own that file;
 * the orchestrator only ever reads it, so it is deliberately NOT an
 * ARTIFACT_DEFINITIONS entry — writeCoreArtifacts must never rewrite it (a
 * round-trip would drop lines a worker appended after load, and prune would
 * delete a file the orchestrator does not own).
 */
export type ArtifactBundle = Partial<ArtifactPayloadMap> & {
  active_dispatch?: ActiveDispatchState;
  agent_reflections?: AgentReflection[];
  /**
   * The design-review pass snapshots (B2 parity port), keyed by pass. Loaded
   * specially like `active_dispatch` — they live under
   * `design-review-snapshots/` rather than as standard pruned artifacts — so the
   * synchronous `deriveAuditState` can key each pass's staleness on the semantic
   * projection of the structural inputs it reviewed. Absent until first review.
   */
  design_review_snapshots?: DesignReviewSnapshotBundle;
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

// Canonical filename for the rendered findings report. Single-sourced in the
// shared `auditToolsPaths` module so the synthesis writer, the promote
// source/dest, and the present_report prompt path cannot drift to different
// spellings. Re-exported here for the audit-side consumers (and tests) that
// already import it from this module. The dependency table below still lists it
// as plain data alongside its sibling artifact-name literals.
export { AUDIT_REPORT_FILENAME };

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
  provider_confirmation: jsonArtifact("provider_confirmation.json", "intake"),
  repo_manifest: jsonArtifact("repo_manifest.json", "intake"),
  file_disposition: jsonArtifact("file_disposition.json", "intake"),
  auto_fixes_applied: jsonArtifact("auto_fixes_applied.json", "intake"),
  intent_checkpoint: jsonArtifact("intent_checkpoint.json", "intake"),
  unit_manifest: jsonArtifact("unit_manifest.json", "analysis"),
  graph_bundle: jsonArtifact("graph_bundle.json", "analysis"),
  surface_manifest: jsonArtifact("surface_manifest.json", "analysis"),
  critical_flows: jsonArtifact("critical_flows.json", "analysis"),
  flow_coverage: jsonArtifact("flow_coverage.json", "analysis"),
  risk_register: jsonArtifact("risk_register.json", "analysis"),
  git_history: jsonArtifact("git_history.json", "analysis"),
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
  task_affinity_graph: jsonArtifact("task_affinity_graph.json", "execution"),
  requeue_tasks: jsonArtifact("requeue_tasks.json", "execution"),
  audit_report: textArtifact(AUDIT_REPORT_FILENAME, "reporting"),
  audit_findings: jsonArtifact(AUDIT_FINDINGS_FILENAME, "reporting"),
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
  // Worker-appended feedback participates in the staleness DAG (its content
  // hash re-stales audit-report.md) without being a writable registry entry.
  if (artifactName === AGENT_FEEDBACK_FILENAME) {
    return bundle.agent_reflections;
  }
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

  // Design-review snapshots (B2 parity port): loaded specially like
  // active-dispatch so deriveAuditState can key each pass's staleness on the
  // semantic projection of the structural inputs it reviewed. Absent on a fresh
  // run / before the first design review completes.
  const designReviewSnapshots = await loadDesignReviewSnapshots(root);
  if (Object.keys(designReviewSnapshots).length > 0) {
    bundle.design_review_snapshots = designReviewSnapshots;
  }

  // Schema-version guards (ARC-dd468422): versioned artifacts must carry the
  // exact expected schema_version or the load fails with a diagnosable error.
  // Checked after the loop so the error message can name both values.
  assertArtifactSchemaVersion(
    bundle.intent_checkpoint,
    "intent_checkpoint.json",
    "intent-checkpoint/v1",
  );
  assertArtifactSchemaVersion(
    bundle.provider_confirmation,
    "provider_confirmation.json",
    PROVIDER_CONFIRMATION_RESULT_VERSION,
  );

  // agent-feedback.jsonl is appended by workers (opt-in reflections), never
  // written by the orchestrator. Parse leniently: malformed lines are skipped,
  // a present-but-unusable file is just an empty list. Synthesis surfaces the
  // parsed reflections as the report's "Process Feedback" section.
  const feedbackText = await readOptionalTextFile(
    join(root, AGENT_FEEDBACK_FILENAME),
  );
  if (feedbackText !== undefined) {
    bundle.agent_reflections = parseReflectionsNdjson(feedbackText);
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
}, options: {
  copy?: typeof cp;
  remove?: typeof rm;
  warn?: (message: string) => void;
} = {}): Promise<{ promoted: boolean; cleaned: boolean; warning?: string }> {
  const source = auditReportPath(params.artifactsDir);
  const destination = promotedAuditReportPath(params.artifactsDir);
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
      auditFindingsPath(params.artifactsDir),
      promotedAuditFindingsPath(params.artifactsDir),
      { force: true },
    );
  } catch (error) {
    // audit-findings.json is optional output; absence must not fail promotion.
    // Log so operators can distinguish a partial promotion from a clean one.
    warn(
      `audit-code: could not promote ${AUDIT_FINDINGS_FILENAME} to ${promotedAuditFindingsPath(params.artifactsDir)}: ` +
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
