import { assertNoPendingFoldReceipt } from "./foldReceiptPath.js";
// sites-pinned: tests/audit/producer-contract-boundaries.test.ts, tests/audit/io-remediation.test.ts, tests/audit/seam-atomic-promote-findings.test.ts
import { z, type ZodTypeAny } from "zod";
import { cp, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "../../shared/io/json.js";
import { hashContent } from "../../shared/hash.js";
import { hashArtifactValue } from "../../shared/artifactFreshness.js";
import { GraphBundleSchema } from "audit-tools/shared";
import { RepoManifestSchema } from "../types.js";
import { buildReviewerGraph } from "../cli/reviewGraphCommand.js";
import { auditNavigationGraphPath, navigationSourceDigest } from "./navigationGraph.js";
import { auditRunConsentPath } from "../../shared/analyzerRunConsent.js";
import {
  AuditFindingsReportSchema,
  AUDIT_REPORT_FILENAME,
  AUDIT_FINDINGS_FILENAME,
  archiveFrictionRecords,
  listFrictionRecordFilenames,
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
import type { SubmissionLedgerEvent } from "audit-tools/shared";
// Deep, not through the `audit-tools/shared` barrel, which does not re-export
// this type. Adding it there is a one-line edit to a file outside this module's
// write scope; the deep form is already the convention in this file (see the
// affinityArtifacts import below) so no barrel change is needed.
import type { SubmissionLedgerDrop } from "../../shared/submission/submissionLedger.js";
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
import type { ConceptualReviewAdjudication } from "../types/conceptualAdjudication.js";
import type { DocsDigest } from "../types/docsDigest.js";
import type { StructureDecomposition } from "../types/structureDecomposition.js";
import type { CharterRegister } from "../types/charterRegister.js";
import type { CharterClarificationRegister } from "../types/charterClarification.js";
import type { SystemicChallengeRegister } from "../types/systemicChallenge.js";
import type { AnalyzerCapabilityRecord } from "../types/analyzerCapability.js";
import type { AuditScopeManifest } from "../types/auditScope.js";
import { ReviewPlanSchema, type CurrentQuestionDependencies, type ReviewAcceptedAnswer, type ReviewAdjudication, type ReviewEvidence, type ReviewPlan, type ReviewQuestion, type ReviewReopenEvent, type ReviewToolingQualification, type ReviewToolingTransition } from "../../shared/types/reviewQuestion.js";
import { QuestionAuditFindingsReportSchema, QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION, type ReviewFindingConsolidation } from "../../shared/types/questionReviewReport.js";
import { readVerifiedCharterPacketIndex } from "../orchestrator/charterPacketArchive.js";
import { renderAuditReportMarkdown, type RenderAuditReportOptions } from "../reporting/synthesis.js";
import { qualifyQuestionReviewTooling, readQuestionReviewRunId } from "../cli/questionReviewSession.js";
import { stableStringify } from "audit-tools/shared";
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
  readOptionalTextFile,
  reportDiscardedReflections,
  throwOnSchemaVersionMismatch,
  writeJsonFile,
  writeTextFile,
  type AgentReflection,
} from "audit-tools/shared";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../types/charterRegister.js";
import { buildToolingManifest } from "./toolingManifest.js";

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
  conceptual_review_adjudication: ConceptualReviewAdjudication;
  docs_digest: DocsDigest;
  structure_decomposition: StructureDecomposition;
  charter_register: CharterRegister;
  charter_clarification: CharterClarificationRegister;
  systemic_challenge: SystemicChallengeRegister;
  analyzer_capability: AnalyzerCapabilityRecord;

  // --- Phase 3: Audit execution ---
  scope: AuditScopeManifest;
  review_plan: ReviewPlan;
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
  /** Historical producer binding for an explicitly qualified active review. */
  review_tooling_qualification?: ReviewToolingQualification;
  /** Transient projection from the one accepted ledger, owned by this fold. */
  question_cycle?: {
    pending: readonly { question: ReviewQuestion }[];
    answers: readonly ReviewAcceptedAnswer[];
    evidence: readonly ReviewEvidence[];
    adjudications: readonly ReviewAdjudication[];
    dependenciesByQuestion: ReadonlyMap<string, CurrentQuestionDependencies>;
    consolidations: readonly ReviewFindingConsolidation[];
    reopens?: readonly ReviewReopenEvent[];
  };
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
  validate?: (value: unknown) => void;
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
  schema?: ZodTypeAny,
): ArtifactDefinition<K> {
  const validate = schema ? (value: unknown): void => { schema.parse(value); } : undefined;
  return {
    fileName,
    phase,
    validate,
    read: (path) => readOptionalJsonFile<ArtifactPayloadMap[K]>(path),
    write: async (path, value) => {
      validate?.(value);
      await writeJsonFile(path, value);
    },
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
  risk_register: jsonArtifact("risk_register.json", "analysis"),
  git_history: jsonArtifact("git_history.json", "analysis"),
  design_assessment: jsonArtifact("design_assessment.json", "analysis"),
  conceptual_review_adjudication: jsonArtifact(
    "conceptual_review_adjudication.json",
    "analysis",
  ),
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
  review_plan: jsonArtifact("review_plan.json", "execution", ReviewPlanSchema),
  audit_report: textArtifact(AUDIT_REPORT_FILENAME, "reporting"),
  audit_findings: jsonArtifact(AUDIT_FINDINGS_FILENAME, "reporting", z.union([
    QuestionAuditFindingsReportSchema,
    AuditFindingsReportSchema.refine((report) => report.contract_version !== QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION),
  ])),
  synthesis_narrative: jsonArtifact("synthesis-narrative.json", "reporting"),
  audit_state: jsonArtifact("audit_state.json", "supervisor"),
  artifact_metadata: jsonArtifact("artifact_metadata.json", "supervisor"),
  tooling_manifest: jsonArtifact("tooling_manifest.json", "supervisor"),
} as const satisfies Partial<{ [K in ArtifactBundleKey]: ArtifactDefinition<K> }>;

type ActiveArtifactKey = keyof typeof ARTIFACT_DEFINITIONS;

type ArtifactDefinitionEntry = {
  [K in ActiveArtifactKey]: [K, ArtifactDefinition<K>];
}[ActiveArtifactKey];

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
  review?: { requestedTooling?: ReviewToolingTransition },
): Promise<ArtifactBundle> {
  await assertNoPendingFoldReceipt(root);
  const bundle: ArtifactBundle = {};
  const bundleRecord = bundle as Partial<Record<ArtifactBundleKey, unknown>>;
  for (const entry of ARTIFACT_ENTRIES) {
    const [key, definition] = entry;
    const value = await definition.read(join(root, definition.fileName));
    if (value !== undefined) {
      bundleRecord[key] = value;
    }
  }

  if (bundle.review_plan !== undefined) {
    bundle.review_plan = ReviewPlanSchema.parse(bundle.review_plan);
    if (bundle.audit_findings !== undefined) {
      bundle.audit_findings = QuestionAuditFindingsReportSchema.parse(bundle.audit_findings);
    }
  }
  const currentTooling = await buildToolingManifest();
  const qualification = await qualifyQuestionReviewTooling({
    artifactsDir: root,
    snapshotId: bundle.review_plan?.snapshot_id,
    prior: bundle.tooling_manifest,
    current: currentTooling,
    recordedToolingHash: bundle.artifact_metadata?.artifacts?.["tooling_manifest.json"]?.content_hash,
    requested: review?.requestedTooling,
    allowQualifiedReview: review !== undefined,
  });
  if (qualification) bundle.review_tooling_qualification = qualification;
  // Existing graph/evidence keeps its proved producer identity. The running
  // tool's different identity is recorded in the append-only qualification.
  bundle.tooling_manifest = qualification?.prior ?? currentTooling;

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
    const feedback = parseReflectionsNdjson(feedbackText);
    bundle.agent_reflections = feedback.reflections;
    reportDiscardedReflections(feedback.discarded, "audit-code");
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

export type CoreArtifactPlan = {
  writes: Partial<Record<ArtifactBundleKey, unknown>>;
  prunes: ArtifactBundleKey[];
  graphEdgeCache?: GraphEdgeCache;
};

export function planCoreArtifacts(bundle: ArtifactBundle, prune: boolean): CoreArtifactPlan {
  const writes: CoreArtifactPlan["writes"] = {};
  const prunes: ArtifactBundleKey[] = [];
  const record = bundle as Partial<Record<ArtifactBundleKey, unknown>>;
  for (const [key, definition] of ARTIFACT_ENTRIES) {
    const value = record[key];
    if (value !== undefined) definition.validate?.(value);
    if (key === "tooling_manifest" && bundle.review_tooling_qualification) continue;
    if (value !== undefined) writes[key] = value;
    else if (prune) prunes.push(key);
  }
  return { writes, prunes, graphEdgeCache: bundle.graph_edge_cache };
}

export async function applyCoreArtifactPlan(
  root: string, plan: CoreArtifactPlan, assertOwnership?: () => Promise<void>,
): Promise<void> {
  const allowed = new Set<string>(ARTIFACT_ENTRIES.map(([key]) => key));
  if ([...Object.keys(plan.writes), ...plan.prunes].some(key => !allowed.has(key))) {
    throw new Error("The fold receipt names an unknown core artifact.");
  }
  const prunes = new Set(plan.prunes);
  for (const [key, definition] of ARTIFACT_ENTRIES) {
    if (!Object.hasOwn(plan.writes, key)) continue;
    if (prunes.has(key) || plan.writes[key] === undefined) {
      throw new Error("The fold receipt contains an ambiguous core artifact operation.");
    }
    definition.validate?.(plan.writes[key]);
  }
  for (const [key, definition] of ARTIFACT_ENTRIES) {
    const path = join(root, definition.fileName);
    if (Object.hasOwn(plan.writes, key)) {
      await assertOwnership?.();
      await definition.write(path, plan.writes[key] as never);
    } else if (prunes.has(key)) {
      await assertOwnership?.();
      try {
        await unlink(path);
      } catch (error) {
        if (!isFileMissingError(error)) throw error;
      }
    }
  }
  // The per-file graph cache is written separately and is never pruned.
  if (plan.graphEdgeCache !== undefined) {
    await assertOwnership?.();
    await writeGraphEdgeCache(root, plan.graphEdgeCache);
  }
}

export async function writeCoreArtifacts(
  root: string,
  bundle: ArtifactBundle,
  options: { prune?: boolean } = {},
): Promise<void> {
  await assertNoPendingFoldReceipt(root);
  await applyCoreArtifactPlan(root, planCoreArtifacts(bundle, options.prune === true));
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
      errorMessage(error) + ")";
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

// Archive-only v1 bytes; never load these into an active question bundle.
const RETIRED_RUN_FILES = [
  "audit_plan_metrics.json",
  "audit_results.jsonl",
  "audit_tasks.json",
  "coverage_matrix.json",
  "flow_coverage.json",
  "requeue_tasks.json",
  "runtime_validation_report.json",
  "runtime_validation_tasks.json",
  "task_affinity_graph.json",
] as const;

// sites-pinned: tests/audit/rollover-legacy-archive.test.ts
async function optionalArchiveStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
    return undefined;
  }
}

async function ensurePlainArchiveDir(path: string, verifyOnly: boolean): Promise<void> {
  if (!verifyOnly && !(await optionalArchiveStat(path))) await mkdir(path);
  if (!(await lstat(path)).isDirectory()) throw new Error(`Not an archive directory: ${path}`);
}

/** A current audit graph which can survive removal of the audit snapshot and workspace. */
// sites-pinned: tests/remediate/planning-graph.test.ts
export async function readWorkingAuditNavigationGraph(artifactsDir: string, expectedSource?: string): Promise<string | undefined> {
  const repoName = ARTIFACT_DEFINITIONS.repo_manifest.fileName;
  const graphName = ARTIFACT_DEFINITIONS.graph_bundle.fileName;
  const dependencyNames = [
    ARTIFACT_DEFINITIONS.file_disposition.fileName,
    ARTIFACT_DEFINITIONS.external_analyzer_results.fileName,
  ];
  const metadataPath = join(artifactsDir, ARTIFACT_DEFINITIONS.artifact_metadata.fileName);
  const [rawRepo, rawGraph, metadata] = await Promise.all([
    readOptionalJsonFile<unknown>(join(artifactsDir, repoName)),
    readOptionalJsonFile<unknown>(join(artifactsDir, graphName)),
    readOptionalJsonFile<ArtifactMetadataManifest>(metadataPath),
  ]);
  const repo = RepoManifestSchema.safeParse(rawRepo);
  const graph = GraphBundleSchema.safeParse(rawGraph);
  const repoStamp = metadata?.artifacts?.[repoName];
  const graphStamp = metadata?.artifacts?.[graphName];
  if (!repo.success || !graph.success || !repoStamp || !graphStamp ||
      repoStamp.content_hash !== hashArtifactValue(repoName, rawRepo) ||
      graphStamp.content_hash !== hashArtifactValue(graphName, rawGraph) ||
      graphStamp.dependency_revisions?.[repoName] !== repoStamp.revision ||
      Object.entries(graphStamp.dependency_revisions ?? {}).some(([name, revision]) => (metadata?.artifacts[name]?.revision ?? 0) !== revision)) return undefined;
  const source = navigationSourceDigest(repo.data.files);
  if (!source || (expectedSource && source !== expectedSource)) return undefined;
  // An artifact can change before (or without) its metadata being replaced.
  // Read only the graph's known dependencies, never paths supplied by stamps.
  const dependenciesCurrent = await Promise.all(dependencyNames.map(async name => {
    const payload = await readOptionalJsonFile<unknown>(join(artifactsDir, name));
    const stamp = metadata?.artifacts[name];
    const revision = graphStamp.dependency_revisions?.[name] ?? 0;
    return payload === undefined
      ? stamp === undefined && revision === 0
      : stamp !== undefined && revision === stamp.revision && stamp.content_hash === hashArtifactValue(name, payload);
  }));
  if (!dependenciesCurrent.every(Boolean)) return undefined;
  return buildReviewerGraph(graph.data, repo.data.files.map(file => file.path), undefined, source);
}

/** Archive-only v1 bytes. Never feed these files back into an audit bundle. */
async function archiveRetiredRunFiles(
  artifactsDir: string,
  outputDir: string,
  copy: typeof cp,
  verifyOnly: boolean,
): Promise<void> {
  const sources: Array<{ name: string; path: string }> = [];
  for (const name of RETIRED_RUN_FILES) {
    const path = join(artifactsDir, name);
    const stat = await optionalArchiveStat(path);
    if (!stat) continue;
    if (!stat.isFile()) throw new Error(`Not a regular historical file: ${path}`);
    sources.push({ name, path });
  }
  if (sources.length === 0) return;

  const consentPath = auditRunConsentPath(artifactsDir);
  const consentStat = await optionalArchiveStat(consentPath);
  if (consentStat && !consentStat.isFile()) throw new Error("Run identity is not a regular file");
  const runId: unknown = consentStat ? JSON.parse(await readFile(consentPath, "utf8"))?.run_id : undefined;
  if (runId !== undefined && !z.string().uuid().safeParse(runId).success) {
    throw new Error("Historical audit run identity is not a UUID");
  }
  const archiveId = typeof runId === "string" ? runId.toLowerCase() : `legacy-${hashContent(JSON.stringify(
    await Promise.all(sources.map(async ({ name, path }) => [name, hashContent(await readFile(path))])),
  ))}`;
  const archiveRoot = join(outputDir, "archive");
  const runArchive = join(archiveRoot, archiveId);
  if (!(await lstat(outputDir)).isDirectory()) throw new Error(`Not an archive parent directory: ${outputDir}`);
  await ensurePlainArchiveDir(archiveRoot, verifyOnly);
  await ensurePlainArchiveDir(runArchive, verifyOnly);
  for (const { name, path } of sources) {
    const target = join(runArchive, name);
    const prior = await optionalArchiveStat(target);
    if (prior && !prior.isFile()) throw new Error(`Not a regular historical archive member: ${target}`);
    const mismatch = prior || verifyOnly
      ? await verifyArchivedBytes(target, await readFile(path))
      : await archiveVerified((from, to) => copy(from, to, { force: false, errorOnExist: true }), path, target);
    if (mismatch) throw new Error(mismatch);
  }
}


/** The junk-dir sweep cannot infer custody from a not_started state marker. */
export async function retiredRunEvidenceIsArchived(artifactsDir: string): Promise<boolean> {
  try {
    await archiveRetiredRunFiles(artifactsDir, dirname(promotedAuditReportPath(artifactsDir)), cp, true);
    return true;
  } catch {
    return false;
  }
}


/**
 * Archive the run's append-only diagnostics one level up — agent feedback,
 * friction records and the submission ledger — and name every member that did
 * not archive. Promotion runs it; so does the next run's rollover
 * (`rollOverFinishedRun`), because a host may append to these after promotion
 * and the rollover deletes them.
 */
export async function archiveRunDiagnostics(params: {
  artifactsDir: string;
}, options: {
  copy?: typeof cp;
  warn?: (message: string) => void;
  verifyOnly?: boolean;
} = {}): Promise<{ lost: string[]; ledger_dropped: SubmissionLedgerDrop[] }> {
  const lost: string[] = [];
  const destination = promotedAuditReportPath(params.artifactsDir);
  const copy = options.copy ?? cp;
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  // agent-feedback.jsonl is worker-owned, append-only, and lives inside
  // artifactsDir — so the rollover destroys it. It had no archive step at all
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
        `${AGENT_FEEDBACK_FILENAME} (${errorMessage(error)})`,
      );
    }
  }
  // Archive captured diagnostics with the promoted deliverables BEFORE cleanup.
  // Records may be untriaged: development reflection is not a product gate.
  // The RETURN is consumed, not discarded. `archiveFrictionRecords` warns per
  // failed file and simply omits it from the archived list, so dropping the
  // return meant a friction record that failed to copy was destroyed by the
  // delete with nothing gating it - the same class as the findings and ledger
  // archives beside it. Comparing the archived count against what is on disk
  // surfaces a per-file failure without reaching into that module's internals.
  // The listing is the SAME helper `archiveFrictionRecords` walks, so the two
  // counts cannot drift into under-reporting a destroyed record.
  //
  // AN UNLISTABLE DIR IS A SHORTFALL, not an empty one. The listing used to
  // return `[]` for every readdir failure alike, and the archive that walks the
  // same helper degraded the same way — so both sides read zero, the comparison
  // below was satisfied, and the delete destroyed a directory full of records
  // with nothing gating it. It now throws on anything but ENOENT: an absent dir
  // really has nothing to lose, any other errno means records may exist and
  // were NOT archived, so the rollover is refused — the same answer an
  // unarchivable FILE already gets (the CP-NODE-3 residual: "an unlistable
  // directory refuses the delete, same as an unarchivable file").
  let frictionNames: string[] = [];
  let archivedFriction: string[] = [];
  try {
    frictionNames = await listFrictionRecordFilenames(params.artifactsDir);
    archivedFriction = await archiveFrictionRecords({
      artifactsDir: params.artifactsDir,
      destDir: dirname(destination),
      prefix: "audit-friction",
      copyFile: copy,
      warn: (message) => warn(`audit-code: ${message}`),
    });
  } catch (error) {
    lost.push(
      `the friction directory listing (${errorMessage(error)})`,
    );
  }
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
  // recovery — so letting the rollover take it would mean the distinction
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
    // that this run drifted is about to be destroyed by the rollover — so it is
    // announced, exactly as the friction-archive seam announces its own copy
    // failures. Still best-effort: bookkeeping must not fail a completed audit.
    if (!isFileMissingError(error)) {
      // GATES THE ROLLOVER, like every other member of the archive set. Warning
      // and falling through meant the one durable statement that this run
      // drifted and was repaired got destroyed by the rollover - the exact loss
      // the ledger exists to prevent, with only a console line left behind.
      lost.push(
        "the submission ledger (" +
          errorMessage(error) + ")",
      );
    }
  }
  try {
    await archiveRetiredRunFiles(
      params.artifactsDir, dirname(destination), copy, options.verifyOnly === true,
    );
  } catch (error) {
    lost.push(`historical audit evidence (${errorMessage(error)})`);
  }
  return { lost, ledger_dropped: [...ledgerDropped] };
}

/**
 * Promote the run's deliverables one level up and ARCHIVE every member that
 * the next run's rollover (`rollOverFinishedRun`) will delete: the findings
 * contract, agent feedback, friction records and the submission ledger. The
 * working dir itself is KEPT (owner decision 2026-10-08, "keep the artifacts
 * dir"): the next run reuses its derived artifacts through the staleness DAG.
 * `archived` is the rollover's gate (through `isWorkingDirFullyPromoted`): a
 * member that did not archive keeps the dir from being rolled over, so its only
 * copy is never deleted.
 */
export async function promoteFinalAuditReport(params: {
  artifactsDir: string;
}, options: {
  copy?: typeof cp;
  warn?: (message: string) => void;
  verifyOnly?: boolean;
} = {}): Promise<{
  promoted: boolean;
  /** Every archive member is verified one level up (INV 1). */
  archived: boolean;
  warning?: string;
  /**
   * Artifacts that could NOT be archived. Non-empty means `archived` is false,
   * so a caller reading { promoted: true, archived: true } can trust that
   * nothing will be lost — which is exactly what it could not do while a
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
  if (!(await hasCurrentQuestionReport(params.artifactsDir))) {
    const warning = "Current question review has no valid matching machine report; promotion refused.";
    options.warn?.(warning);
    return { promoted: false, archived: false, warning };
  }
  const destination = promotedAuditReportPath(params.artifactsDir);
  const copy = options.copy ?? cp;
  const warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  try {
    await copy(source, destination, { force: true });
  } catch (error) {
    const warning =
      `audit-code: completed audit but could not promote final report to ${destination}: ` +
      errorMessage(error);
    warn(warning);
    return { promoted: false, archived: false, warning };
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
    // machine contract is about to be destroyed by the rollover with no copy
    // anywhere, and warning-and-proceeding turned that into silent data loss
    // reported as { promoted: true, cleaned: true }.
    warn(
      `audit-code: could not promote ${AUDIT_FINDINGS_FILENAME} to ${promotedAuditFindingsPath(params.artifactsDir)}: ` +
        errorMessage(error),
    );
    // An ABSENT findings file (the legacy-bundle case) has nothing to lose. Any
    // other failure means the machine contract is about to be destroyed by the
    // rollover with no copy anywhere — DAT-4802dc9e-2 / -3 — so it is recorded
    // as loss and gates the delete.
    if (!isFileMissingError(error)) {
      lost.push(
        `${AUDIT_FINDINGS_FILENAME} (${errorMessage(error)})`,
      );
    }
  }
  // sites-pinned: tests/remediate/planning-graph.test.ts
  // Missing, malformed, or unreadable advisory input supplies no graph.
  // Failure to preserve a usable graph remains a normal archival failure.
  const graph = await readWorkingAuditNavigationGraph(params.artifactsDir).catch(() => undefined);
  try {
    if (graph !== undefined) {
      const path = auditNavigationGraphPath(dirname(destination));
      if (!options.verifyOnly) await writeTextFile(path, graph);
      const mismatch = await verifyArchivedBytes(path, Buffer.from(graph));
      if (mismatch) lost.push("the audit navigation graph (" + mismatch + ")");
    }
  } catch (error) {
    lost.push("the audit navigation graph (" + errorMessage(error) + ")");
  }
  const diagnostics = await archiveRunDiagnostics({ artifactsDir: params.artifactsDir }, { copy, warn, verifyOnly: options.verifyOnly });
  lost.push(...diagnostics.lost);
  const ledgerDropped = diagnostics.ledger_dropped;
  const dropped = ledgerDropped.length > 0 ? { ledger_dropped: ledgerDropped } : {};
  // THE ROLLOVER IS CONDITIONED ON VERIFIED COPIES (INV 1). Anything that failed
  // to archive still exists only inside artifactsDir, so rolling it over
  // destroys the sole copy. Keeping the run is always recoverable; the delete
  // is not — REL-4802dc9e.
  if (lost.length > 0) {
    const warning =
      `audit-code: promoted final report to ${destination}, but could NOT archive ` +
      `${lost.join("; ")} — the next audit will not roll ${params.artifactsDir} over ` +
      "while it holds the only copy. Recover those files, then run `audit-code cleanup --force`.";
    warn(warning);
    return { promoted: true, archived: false, warning, unarchived: lost, ...dropped };
  }
  return { promoted: true, archived: true, ...dropped };
}

/**
 * Has the completion transition NOTHING left to do for this working dir — is
 * every artifact `promoteFinalAuditReport` archives already one level up,
 * byte-identical? This is the stale-dir rule's question
 * (`cleanupStaleArtifactsDir`), and it is answered by promotion's OWN archive
 * walk rather than by a second enumeration of the archive set: the walk runs
 * with its copy replaced by a byte comparison against what is already at each
 * destination, so "fully promoted" means exactly "the archive gate (INV 1)
 * would pass without copying anything". A
 * member promotion archives is a member this walk checks; the two cannot drift.
 *
 * Identity, not existence: a destination that is missing, or that differs from
 * its in-place source, is work left — so a PREVIOUS audit's promoted report
 * never qualifies THIS run (the dogfood 2026-07-30 false-green), and a dir with
 * no in-place render has no identity to prove and is never "already promoted".
 * A missing in-place member of the tolerant set (findings, feedback, ledger,
 * friction records) is what promotion itself tolerates: nothing to archive.
 */
export async function readQuestionReportReflections(artifactsDir: string): Promise<AgentReflection[]> {
  const feedback = await readOptionalTextFile(join(artifactsDir, AGENT_FEEDBACK_FILENAME));
  return feedback === undefined ? [] : parseReflectionsNdjson(feedback).reflections;
}

export type QuestionReportCharterOptions = Pick<RenderAuditReportOptions,
  "charter_evidence_coverage" | "charter_packet_archive">;

export async function readQuestionReportCharterOptions(
  artifactsDir: string,
): Promise<QuestionReportCharterOptions> {
  const registry = discardOnSchemaVersionMismatch(
    await readOptionalJsonFile<CharterRegister>(join(artifactsDir, "charter_register.json")),
    CHARTER_REGISTER_SCHEMA_VERSION);
  return {
    charter_evidence_coverage: registry?.evidence_coverage,
    charter_packet_archive: await readVerifiedCharterPacketIndex(artifactsDir),
  };
}

/** A surviving working machine contract still identifies the run even if its plan and session were lost. */
export async function hasWorkingQuestionReportMarker(artifactsDir: string): Promise<boolean> {
  const raw = await readOptionalJsonFile<unknown>(auditFindingsPath(artifactsDir));
  return z.object({ contract_version: z.literal(QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION) }).safeParse(raw).success;
}

// null denotes a legacy run without any question markers; undefined means a v2 mismatch.
async function expectedQuestionMarkdown(artifactsDir: string): Promise<string | null | undefined> {
  const unparsed = await readOptionalJsonFile<unknown>(join(artifactsDir, ARTIFACT_DEFINITIONS.review_plan.fileName));
  if (unparsed === undefined) {
    const questionRun = await readQuestionReviewRunId(artifactsDir, { includeEnded: true }) ||
      await hasWorkingQuestionReportMarker(artifactsDir);
    return questionRun ? undefined : null;
  }
  const plan = ReviewPlanSchema.safeParse(unparsed);
  if (!plan.success) return undefined;
  const report = QuestionAuditFindingsReportSchema.safeParse(await readOptionalJsonFile<unknown>(auditFindingsPath(artifactsDir)));
  if (!report.success || report.data.question_review.snapshot_id !== plan.data.snapshot_id) return undefined;
  const revisions = new Map(report.data.question_review.questions.map(q => [q.question_id, q.revision_id]));
  if (revisions.size !== plan.data.questions.length ||
      !plan.data.questions.every(q => revisions.get(q.question_id) === q.revision_id)) return undefined;
  const runId = await readQuestionReviewRunId(artifactsDir, { includeEnded: true });
  if (!runId) return undefined;
  const ledger = await readOptionalJsonFile<{
    contract_version: string; run_id: string; answers: unknown[]; adjudications: unknown[]; consolidations?: unknown[]; reopens?: unknown[];
  }>(join(artifactsDir, "runs", runId, "host-accepted-results-ledger.json"));
  if (ledger !== undefined && (ledger.contract_version !== "audit-tools/question-review/v1" ||
      ledger.run_id !== runId || !Array.isArray(ledger.answers) || !Array.isArray(ledger.adjudications) ||
      (ledger.consolidations !== undefined && !Array.isArray(ledger.consolidations)) ||
      (ledger.reopens !== undefined && !Array.isArray(ledger.reopens)))) return undefined;
  const sorted = (rows: readonly unknown[]) => rows.map(row => stableStringify(row)).sort();
  const actual = report.data.question_review;
  if (stableStringify(actual.signal_dispositions ?? []) !== stableStringify(plan.data.signal_dispositions ?? []) ||
      stableStringify(sorted(actual.accepted)) !== stableStringify(sorted(ledger?.answers ?? [])) ||
      stableStringify(sorted(actual.adjudications)) !== stableStringify(sorted(ledger?.adjudications ?? [])) ||
      stableStringify(sorted(actual.consolidations)) !== stableStringify(sorted(ledger?.consolidations ?? [])) ||
      stableStringify(actual.reopens ?? []) !== stableStringify(ledger?.reopens ?? [])) return undefined;
  return renderAuditReportMarkdown(report.data, {
    reflections: await readQuestionReportReflections(artifactsDir),
    ...await readQuestionReportCharterOptions(artifactsDir),
  });
}

export async function hasCurrentQuestionReport(artifactsDir: string): Promise<boolean> {
  const expected = await expectedQuestionMarkdown(artifactsDir);
  return expected === null || (expected !== undefined &&
    await readOptionalTextFile(auditReportPath(artifactsDir)) === expected);
}

/** Rollover holds the artifact-tree lock. An ended v2 run no longer has a
 * frozen checkout: refresh only the human render from the verified promoted
 * machine report and current render-only evidence, without rewriting the
 * accepted ledger, question plan, or machine report. */
export async function refreshEndedQuestionReport(artifactsDir: string): Promise<boolean> {
  const expected = await expectedQuestionMarkdown(artifactsDir);
  if (expected === null) return true;
  if (expected === undefined) return false;
  const working = await readFile(auditFindingsPath(artifactsDir));
  if (await verifyArchivedBytes(promotedAuditFindingsPath(artifactsDir), working) !== null) return false;

  const workingReport = auditReportPath(artifactsDir);
  const promotedReport = promotedAuditReportPath(artifactsDir);
  if (await readOptionalTextFile(workingReport) !== expected) await writeTextFile(workingReport, expected);
  if (await readOptionalTextFile(promotedReport) !== expected) await writeTextFile(promotedReport, expected);
  return await verifyArchivedBytes(workingReport, Buffer.from(expected)) === null &&
    await verifyArchivedBytes(promotedReport, Buffer.from(expected)) === null;
}

export async function isWorkingDirFullyPromoted(artifactsDir: string): Promise<boolean> {
  const verifyOnly: typeof cp = async (from, to) => {
    // ENOENT from the SOURCE propagates as-is: promotion's own catch reads it as
    // "absent, nothing to archive" for the tolerant members, and the report
    // step, which tolerates nothing, reads it as a failed promotion.
    const source = await readFile(from);
    let destination: Buffer;
    try {
      destination = await readFile(to);
    } catch (error) {
      // Deliberately NOT the ENOENT itself: promotion's catch would otherwise
      // mistake a missing DESTINATION for an absent source and wave it through.
      throw new Error(
        `not promoted: ${String(to)} is missing (${errorMessage(error)})`,
      );
    }
    if (Buffer.compare(source, destination) !== 0) {
      throw new Error(`not promoted: ${String(to)} differs from ${String(from)}`);
    }
  };
  const result = await promoteFinalAuditReport(
    { artifactsDir },
    { copy: verifyOnly, warn: () => {}, verifyOnly: true },
  );
  return result.promoted && result.archived;
}
