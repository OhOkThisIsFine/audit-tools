import { cp, readdir, readFile, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  AUDIT_REPORT_FILENAME,
  AUDIT_FINDINGS_FILENAME,
  archiveFrictionRecords,
  frictionCaptureDir,
  auditReportPath,
  auditFindingsPath,
  promotedAuditReportPath,
  promotedAuditFindingsPath,
  readSubmissionLedger,
  submissionLedgerPath,
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
import type { AuditFindingsReport, FileDisposition, CriticalFlowManifest, CriticalFlowFallbackResult, GraphBundle, RiskRegister, SurfaceManifest, IntentCheckpoint, GitHistory } from "audit-tools/shared";
import type { AccessMemory, SubmissionLedgerEvent } from "audit-tools/shared";
// Deep, not through the `audit-tools/shared` barrel, which does not re-export
// this type. Adding it there is a one-line edit to a file outside this module's
// write scope; the deep form is already the convention in this file (see the
// affinityArtifacts import below) so no barrel change is needed.
import type { SubmissionLedgerDrop } from "../../shared/submission/submissionLedger.js";
// Deep for the same reason: `writeFileAtomic` is newly exported from json.ts and
// the `audit-tools/shared` barrel (outside this module's write scope) does not
// re-export it.
import { writeFileAtomic } from "../../shared/io/json.js";
import type { SynthesisNarrativeRecord } from "../types/synthesisNarrative.js";
import type {
  ExternalAnalyzerResults,
  ExternalAnalyzerAcquisitionMarker,
} from "audit-tools/shared";
import type { FlowCoverageManifest } from "../types/flowCoverage.js";
import type { AuditPlanMetrics } from "../types/reviewPlanning.js";
import type { TaskAffinityGraph } from "../orchestrator/taskAffinityGraph.js";
import type {
  RuntimeValidationReport,
  RuntimeValidationTaskManifest,
} from "../types/runtimeValidation.js";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { DocsDigest } from "../types/docsDigest.js";
import type { StructureDecomposition } from "../types/structureDecomposition.js";
import type { CharterRegister } from "../types/charterRegister.js";
import type { CharterClarificationRegister } from "../types/charterClarification.js";
import type { SystemicChallengeRegister } from "../types/systemicChallenge.js";
import type { AnalyzerCapabilityRecord } from "../types/analyzerCapability.js";
import type { AuditScopeManifest } from "../types/auditScope.js";
import type { ToolingManifest } from "../types/toolingManifest.js";
import {
  loadDesignReviewSnapshots,
  type DesignReviewSnapshotBundle,
} from "../orchestrator/designReviewSnapshot.js";
import {
  loadGraphEdgeCache,
  writeGraphEdgeCache,
} from "../orchestrator/graphEdgeCache.js";
import type { GraphEdgeCache } from "../extractors/graph.js";
import {
  AGENT_FEEDBACK_FILENAME,
  discardOnSchemaVersionMismatch,
  isFileMissingError,
  parseReflectionsNdjson,
  readOptionalJsonFile,
  readOptionalNdjsonFile,
  readOptionalTextFile,
  throwOnSchemaVersionMismatch,
  writeJsonFile,
  writeNdjsonFile,
  writeTextFile,
  type AgentReflection,
} from "audit-tools/shared";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../types/charterRegister.js";
import { buildToolingManifest } from "./toolingManifest.js";
import { canonicalizeAffinityArtifactValue } from "../../shared/affinityArtifacts.js";

// ---------------------------------------------------------------------------
// Schema-version guard (ARC-dd468422)
// ---------------------------------------------------------------------------

// The policy lives in `audit-tools/shared` so both orchestrators name the same
// two directions. Audit artifacts are COSTLY/authored state, so a mismatch
// throws rather than discarding: silently rebuilding here would drop an audit
// the operator paid for. Re-exported under the historical name so the error's
// identity is unchanged for existing consumers.
export { SchemaVersionMismatchError as ArtifactSchemaVersionError } from "audit-tools/shared";

type ArtifactPayloadMap = {
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
  // Durable host-authored critical-flow enrichment (the LLM fallback pass output).
  // An UPSTREAM input to critical_flows: the structure phase merges it so a
  // below-confidence-bar deterministic inference gets corrected/augmented flows.
  critical_flow_fallback: CriticalFlowFallbackResult;
  flow_coverage: FlowCoverageManifest;
  risk_register: RiskRegister;
  git_history: GitHistory;
  design_assessment: DesignAssessment;
  docs_digest: DocsDigest;
  structure_decomposition: StructureDecomposition;
  charter_register: CharterRegister;
  charter_clarification: CharterClarificationRegister;
  systemic_challenge: SystemicChallengeRegister;
  analyzer_capability: AnalyzerCapabilityRecord;

  // --- Phase 3: Audit execution ---
  scope: AuditScopeManifest;
  coverage_matrix: CoverageMatrix;
  runtime_validation_tasks: RuntimeValidationTaskManifest;
  runtime_validation_report: RuntimeValidationReport;
  external_analyzer_results: ExternalAnalyzerResults[];
  external_analyzer_acquisition: ExternalAnalyzerAcquisitionMarker;
  syntax_resolution_status: unknown;
  audit_results: AuditResult[];
  audit_tasks: AuditTask[];
  audit_plan_metrics: AuditPlanMetrics;
  task_affinity_graph: TaskAffinityGraph;
  requeue_tasks: AuditTask[];
  access_memory: AccessMemory;

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
 * `agent_reflections` is the parsed view of the worker-APPENDED
 * `agent-feedback.jsonl` (opt-in meta-audit feedback). Workers own that file;
 * the orchestrator only ever reads it, so it is deliberately NOT an
 * ARTIFACT_DEFINITIONS entry — writeCoreArtifacts must never rewrite it (a
 * round-trip would drop lines a worker appended after load, and prune would
 * delete a file the orchestrator does not own).
 */
export type ArtifactBundle = Partial<ArtifactPayloadMap> & {
  agent_reflections?: AgentReflection[];
  /**
   * The design-review pass snapshots (B2 parity port), keyed by pass. Loaded
   * specially — they live under
   * `design-review-snapshots/` rather than as standard pruned artifacts — so the
   * synchronous `deriveAuditState` can key each pass's staleness on the semantic
   * projection of the structural inputs it reviewed. Absent until first review.
   */
  design_review_snapshots?: DesignReviewSnapshotBundle;
  /**
   * Per-file graph-edge cache (C2 incremental graph-build). Loaded specially like
   * a single JSON file at the artifacts root, not an
   * `ARTIFACT_DEFINITIONS` entry — because it is an internal, self-describing
   * incremental-reuse cache, not a deliverable or a staleness-DAG node. The
   * structure executor reads it as the prior cache and returns a refreshed one.
   */
  graph_edge_cache?: GraphEdgeCache;
  /**
   * The submission ledger's events, in arrival order. Loaded specially for the
   * same reason as `agent_reflections`: it is an APPEND-only NDJSON record the
   * orchestrator only ever reads, so it must never become an
   * `ARTIFACT_DEFINITIONS` entry a write-back could round-trip (that would drop
   * events appended after load and re-sort a file whose order is its meaning).
   * Synthesis renders its per-kind totals, which is what makes "this run
   * drifted and was repaired" a fact the REPORT states rather than one that
   * lived only in a transcript.
   */
  submission_ledger?: readonly SubmissionLedgerEvent[];
  /**
   * Lines the ledger reader could NOT read — torn writes and foreign
   * contract versions — with their line numbers and classified reasons.
   *
   * A SEPARATE FIELD, not the `dropped` property riding on the reader's return
   * value. That property is non-enumerable by design (so an unadapted consumer's
   * `toEqual([])` still holds), and non-enumerable means `structuredClone`, JSON
   * round-trips, spread and `slice` all silently shed it. A bundle is exactly the
   * kind of value that gets cloned and serialized, so carrying the drops only as
   * a hidden property would lose them at the first transform. Read off the reader
   * ONCE, at load, into a field of its own.
   */
  submission_ledger_dropped?: readonly SubmissionLedgerDrop[];
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
  repo_manifest: jsonArtifact("repo_manifest.json", "intake"),
  file_disposition: jsonArtifact("file_disposition.json", "intake"),
  auto_fixes_applied: jsonArtifact("auto_fixes_applied.json", "intake"),
  intent_checkpoint: jsonArtifact("intent_checkpoint.json", "intake"),
  unit_manifest: jsonArtifact("unit_manifest.json", "analysis"),
  graph_bundle: jsonArtifact("graph_bundle.json", "analysis"),
  surface_manifest: jsonArtifact("surface_manifest.json", "analysis"),
  critical_flows: jsonArtifact("critical_flows.json", "analysis"),
  critical_flow_fallback: jsonArtifact("critical-flow-fallback.json", "analysis"),
  flow_coverage: jsonArtifact("flow_coverage.json", "analysis"),
  risk_register: jsonArtifact("risk_register.json", "analysis"),
  git_history: jsonArtifact("git_history.json", "analysis"),
  design_assessment: jsonArtifact("design_assessment.json", "analysis"),
  docs_digest: jsonArtifact("docs_digest.json", "analysis"),
  structure_decomposition: jsonArtifact(
    "structure_decomposition.json",
    "analysis",
  ),
  charter_register: jsonArtifact("charter_register.json", "analysis"),
  charter_clarification: jsonArtifact("charter_clarification.json", "analysis"),
  systemic_challenge: jsonArtifact("systemic_challenge.json", "analysis"),
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
  external_analyzer_acquisition: jsonArtifact(
    "external_analyzer_acquisition.json",
    "analysis",
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
  access_memory: jsonArtifact("access_memory.json", "execution"),
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

  // Design-review snapshots (B2 parity port): loaded specially so
  // deriveAuditState can key each pass's staleness on the
  // semantic projection of the structural inputs it reviewed. Absent on a fresh
  // run / before the first design review completes.
  const designReviewSnapshots = await loadDesignReviewSnapshots(root);
  if (Object.keys(designReviewSnapshots).length > 0) {
    bundle.design_review_snapshots = designReviewSnapshots;
  }

  // Per-file graph-edge cache (C2): loaded specially so the
  // structure executor can reuse unchanged files' contributions. Absent on a fresh
  // run / before the first structure build.
  const graphEdgeCache = await loadGraphEdgeCache(root);
  if (graphEdgeCache !== undefined) {
    bundle.graph_edge_cache = graphEdgeCache;
  }

  // Schema-version guards (ARC-dd468422): versioned artifacts must carry the
  // exact expected schema_version or the load fails with a diagnosable error.
  // Checked after the loop so the error message can name both values.
  throwOnSchemaVersionMismatch(
    bundle.intent_checkpoint,
    "intent_checkpoint.json",
    "intent-checkpoint/v1",
  );
  // charter_register is the one DISCARD-policy artifact (regenerable analysis
  // state): the v2 taxonomy rename (design resolution 4) means a v1/unstamped
  // register read under v2 semantics silently misroutes every persisted
  // `inferred` value, and the content-keyed staleness DAG cannot see a
  // code-taxonomy change — so a stale register degrades to ABSENT and the
  // extraction obligation rebuilds it (its upstream inputs all still exist).
  const charterRegister = discardOnSchemaVersionMismatch(
    bundle.charter_register,
    CHARTER_REGISTER_SCHEMA_VERSION,
  );
  if (charterRegister === undefined) {
    delete bundle.charter_register;
  } else {
    bundle.charter_register = charterRegister;
  }
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
  // The submission ledger rides the same read-only NDJSON seam: absent (a run
  // where nothing was ever submitted through a gate) reads as nothing to say.
  const ledger = await readSubmissionLedger(root);
  // BOTH halves, read off the value BEFORE anything transforms it. Gating on
  // `ledger.length > 0` alone meant a ledger whose every line was torn — events
  // empty, dropped non-empty — set no field at all, so the drop signal died on
  // precisely the worst case: the run whose record is least trustworthy looked
  // identical to the run that never drifted.
  const droppedLines = ledger.dropped;
  if (ledger.length > 0) {
    bundle.submission_ledger = ledger;
  }
  if (droppedLines.length > 0) {
    bundle.submission_ledger_dropped = droppedLines;
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
      const canonicalValue = canonicalizeAffinityArtifactValue(
        definition.fileName,
        value,
      );
      await definition.write(path, canonicalValue as never);
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

  // Per-file graph-edge cache (C2): written specially here — symmetric with the
  // special read in loadArtifactBundle — so every persist seam handles it without
  // per-seam edits. It is not an ARTIFACT_DEFINITIONS entry (internal cache, not a
  // staleness-DAG node); a stale cache is self-invalidating via its path_lookup_hash
  // / content_key, so it is never pruned, only overwritten on the next structure build.
  if (bundle.graph_edge_cache !== undefined) {
    await writeGraphEdgeCache(root, bundle.graph_edge_cache);
  }
}

/**
 * The ONE bar for "this archive is verified", used by BOTH the promotion archive
 * and the canonical write path.
 *
 * Read the copy back and BYTE-COMPARE it. "The copy call did not throw" is a
 * weaker bar, and it was the one guarding the DESTRUCTIVE path: a copy that
 * reported success but landed a truncated or empty file cleared the way for a
 * recursive delete of the only other copy. One helper, so the two paths cannot
 * drift to different standards again.
 *
 * Returns null when verified, or a reason string naming the mismatch.
 */
async function verifyArchivedBytes(
  archivePath: string,
  expected: Buffer,
): Promise<string | null> {
  let actual: Buffer;
  try {
    actual = await readFile(archivePath);
  } catch (error) {
    return archivePath + " could not be read back (" +
      (error instanceof Error ? error.message : String(error)) + ")";
  }
  return Buffer.compare(actual, expected) === 0
    ? null
    : archivePath + " did not read back byte-identical to its source";
}

/**
 * Copy one file into the archive and VERIFY the bytes landed. Throws exactly
 * what the copy threw (so an absent source stays distinguishable through
 * `isFileMissingError`); returns a reason string when the copy "succeeded" but
 * the bytes do not match.
 */
async function archiveVerified(
  copyFn: typeof cp,
  from: string,
  to: string,
): Promise<string | null> {
  const sourceBytes = await readFile(from);
  await copyFn(from, to, { force: true });
  return verifyArchivedBytes(to, sourceBytes);
}

/**
 * artifact:canonical-audit-deliverable-write-path -- the ONE write path to the
 * canonical `.audit-tools/audit-findings.json` + `audit-report.md` pair.
 *
 * ARCHIVE, THEN VERIFY, THEN REPLACE. An existing pair is copied into the
 * history directory and the copy is READ BACK and compared before either
 * destination is overwritten. A copy that is merely attempted-and-warned is not
 * an archive: it leaves the caller believing a prior deliverable was preserved
 * when it may not have been -- the same swallow-the-failure shape
 * DAT-4802dc9e-2 / -3 closed on the promotion side.
 *
 * Refuses rather than replaces: if the archive cannot be verified, the existing
 * pair stays exactly as it was and this throws. Keeping a stale deliverable is
 * recoverable; overwriting an unarchived one is not.
 *
 * CONSUMER DEFERRAL: `remediate-nextstep-and-final-gate` must route its own
 * leftover deliverable through this path and emit to a remediation-owned
 * location instead of writing this pair directly. That edit is CP-NODE-15's,
 * not this node's -- the same mechanical hand-off shape CP-NODE-5 used when it
 * deferred its ledger-read consumers here.
 */
export async function writeCanonicalAuditDeliverables(params: {
  artifactsDir: string;
  findings: unknown;
  report: string;
}): Promise<{ archived: readonly string[] }> {
  const findingsPath = promotedAuditFindingsPath(params.artifactsDir);
  const reportPath = promotedAuditReportPath(params.artifactsDir);
  const historyDir = join(
    dirname(reportPath),
    "audit-history",
    new Date().toISOString().replace(/[:.]/gu, "-"),
  );

  const archived: string[] = [];
  for (const existing of [findingsPath, reportPath]) {
    let priorBytes: Buffer;
    try {
      priorBytes = await readFile(existing);
    } catch (error) {
      // Nothing there is the ordinary first-write case and archives nothing.
      if (isFileMissingError(error)) continue;
      throw error;
    }
    const archivePath = join(historyDir, basename(existing));
    await writeFileAtomic(archivePath, priorBytes);
    // VERIFIED, not attempted: read the archive back and compare the bytes. A
    // write that reported success but landed nothing would otherwise clear the
    // way for the replace below.
    const mismatch = await verifyArchivedBytes(archivePath, priorBytes);
    if (mismatch) {
      throw new Error(
        `audit-code: refusing to replace ${existing} - ${mismatch}, so the existing ` +
          "deliverable is not safely preserved.",
      );
    }
    archived.push(archivePath);
  }

  // TWO ATOMIC WRITES, NOT ONE ATOMIC PAIR. Each destination is replaced
  // atomically, but a crash BETWEEN them leaves the findings JSON and the report
  // markdown skewed - a new machine contract beside a stale human render. That is
  // recoverable: the pre-write pair sits in the verified archive above, so both
  // sides of the skew are reconstructable. A genuinely atomic pair would need a
  // directory-level swap, which this path deliberately does not attempt.
  await writeFileAtomic(findingsPath, `${JSON.stringify(params.findings, null, 2)}
`);
  await writeFileAtomic(reportPath, params.report);
  return { archived };
}

export async function promoteFinalAuditReport(params: {
  artifactsDir: string;
}, options: {
  copy?: typeof cp;
  remove?: typeof rm;
  warn?: (message: string) => void;
} = {}): Promise<{
  promoted: boolean;
  cleaned: boolean;
  warning?: string;
  /**
   * Artifacts that could NOT be archived before the cleanup. Non-empty means the
   * delete was ABORTED, so a caller reading { promoted: true, cleaned: true } can
   * trust that nothing was lost — which is exactly what it could not do while a
   * findings-copy failure was a `warn()` with no effect on the returned shape
   * (INV 3 / DAT-4802dc9e-2, -3).
   */
  unarchived?: readonly string[];
  /**
   * Ledger lines the reader could not parse, surfaced so the promotion result
   * never describes a record cleaner than the run actually was.
   */
  ledger_dropped?: readonly SubmissionLedgerDrop[];
}> {
  const lost: string[] = [];
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
    const mismatch = await archiveVerified(
      copy,
      auditFindingsPath(params.artifactsDir),
      promotedAuditFindingsPath(params.artifactsDir),
    );
    if (mismatch) lost.push(AUDIT_FINDINGS_FILENAME + " (" + mismatch + ")");
  } catch (error) {
    // The warning is unchanged — an absent findings file (the legacy-bundle
    // case) still announces a partial promotion. What changed is the DELETE
    // GATE: an absent file has nothing to lose, but any OTHER failure means the
    // machine contract is about to be destroyed by the rm below with no copy
    // anywhere, and warning-and-proceeding turned that into silent data loss
    // reported as { promoted: true, cleaned: true }.
    warn(
      `audit-code: could not promote ${AUDIT_FINDINGS_FILENAME} to ${promotedAuditFindingsPath(params.artifactsDir)}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    // An ABSENT findings file (the legacy-bundle case) has nothing to lose. Any
    // other failure means the machine contract is about to be destroyed by the
    // rm below with no copy anywhere — DAT-4802dc9e-2 / -3 — so it is recorded
    // as loss and gates the delete.
    if (!isFileMissingError(error)) {
      lost.push(
        `${AUDIT_FINDINGS_FILENAME} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  // agent-feedback.jsonl is worker-owned, append-only, and lives inside
  // artifactsDir — so the rm below destroys it. It had no archive step at all
  // while the friction records and the ledger beside it both had one
  // (DAT-4802dc9e).
  try {
    const mismatch = await archiveVerified(
      copy,
      join(params.artifactsDir, AGENT_FEEDBACK_FILENAME),
      join(dirname(destination), `audit-${AGENT_FEEDBACK_FILENAME}`),
    );
    if (mismatch) lost.push(AGENT_FEEDBACK_FILENAME + " (" + mismatch + ")");
  } catch (error) {
    if (!isFileMissingError(error)) {
      lost.push(
        `${AGENT_FEEDBACK_FILENAME} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  // Archive the friction close-out record with the promoted deliverables BEFORE
  // the rm below destroys it — the walk completed (the close gate enforced it),
  // but no consumer has read the record yet. Best-effort, like the findings copy.
  // The RETURN is consumed, not discarded. `archiveFrictionRecords` warns per
  // failed file and simply omits it from the archived list, so dropping the
  // return meant a friction record that failed to copy was destroyed by the rm
  // below with nothing gating it - the same class as the findings and ledger
  // archives beside it. Comparing the archived count against what is on disk
  // surfaces a per-file failure without reaching into that module's internals.
  const frictionNames = await readdir(frictionCaptureDir(params.artifactsDir))
    .then((names) => names.filter((name) => name.endsWith(".json")))
    .catch(() => [] as string[]);
  const archivedFriction = await archiveFrictionRecords({
    artifactsDir: params.artifactsDir,
    destDir: dirname(destination),
    prefix: "audit-friction",
    copyFile: copy,
    warn: (message) => warn(`audit-code: ${message}`),
  });
  if (archivedFriction.length < frictionNames.length) {
    lost.push(
      String(frictionNames.length - archivedFriction.length) +
        " friction record(s) (archived " +
        String(archivedFriction.length) + " of " +
        String(frictionNames.length) + ")",
    );
  }
  // The submission ledger rides the same seam. It is the only durable statement
  // that a run drifted and was repaired — a rejection, a re-emit, a hand
  // recovery — so letting the tree rm take it would mean the distinction
  // between a clean run and a repaired one survives only in a transcript.
  // Best-effort: a run that never drifted has no ledger to archive.
  const ledgerSource = submissionLedgerPath(params.artifactsDir);
  const ledgerDestination = join(
    dirname(destination),
    "audit-submission-ledger.jsonl",
  );
  // Read the drops BEFORE the copy and off the reader's own return value: the
  // `dropped` property is non-enumerable, so it would not survive being passed
  // through anything that clones or serializes. The ARCHIVE itself stays a byte
  // copy — never a re-serialization of the parsed events — so the archived file
  // keeps the torn lines the reader could not use. Surfacing the drops is how the
  // RESULT stops claiming a cleaner record than the bytes contain.
  const ledgerDropped = (await readSubmissionLedger(params.artifactsDir)).dropped;
  try {
    const mismatch = await archiveVerified(copy, ledgerSource, ledgerDestination);
    if (mismatch) lost.push("the submission ledger (" + mismatch + ")");
  } catch (error) {
    // A missing ledger is the ordinary case (nothing was ever submitted through
    // a gate) and says nothing. Any OTHER failure means the one durable record
    // that this run drifted is about to be destroyed by the rm below — so it is
    // announced, exactly as the friction-archive seam announces its own copy
    // failures. Still best-effort: bookkeeping must not fail a completed audit.
    if (!isFileMissingError(error)) {
      // GATES THE DELETE, like every other member of the archive set. Warning
      // and falling through meant the one durable statement that this run
      // drifted and was repaired got destroyed by the rm below - the exact loss
      // the ledger exists to prevent, with only a console line left behind.
      lost.push(
        "the submission ledger (" +
          (error instanceof Error ? error.message : String(error)) + ")",
      );
    }
  }
  const dropped = ledgerDropped.length > 0 ? { ledger_dropped: ledgerDropped } : {};
  // THE DELETE IS CONDITIONED ON VERIFIED COPIES (INV 1). Anything that failed
  // to archive still exists only inside artifactsDir, so removing it destroys
  // the sole copy. Keeping the directory is always recoverable; the delete is
  // not — REL-4802dc9e.
  if (lost.length > 0) {
    const warning =
      `audit-code: promoted final report to ${destination}, but could NOT archive ` +
      `${lost.join("; ")} — leaving ${params.artifactsDir} in place rather than ` +
      "destroying the only copy. Recover those files, then remove the directory by hand.";
    warn(warning);
    return { promoted: true, cleaned: false, warning, unarchived: lost, ...dropped };
  }
  try {
    await remove(params.artifactsDir, { recursive: true, force: true });
    return { promoted: true, cleaned: true, ...dropped };
  } catch (error) {
    const warning =
      `audit-code: promoted final report to ${destination}, but could not remove ${params.artifactsDir}: ` +
      (error instanceof Error ? error.message : String(error));
    warn(warning);
    return { promoted: true, cleaned: false, warning, ...dropped };
  }
}
