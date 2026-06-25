import { ARTIFACT_DEFINITIONS, AUDIT_REPORT_FILENAME } from "../io/artifacts.js";
import { AGENT_FEEDBACK_FILENAME } from "audit-tools/shared";

/**
 * The canonical set of artifact filenames, derived from ARTIFACT_DEFINITIONS
 * (the single source of truth) plus the two special-cased files that participate
 * in the staleness DAG but are not writable registry entries.
 *
 * Constraining the canonical map to this type means a typo or a stale filename
 * literal (after a rename) is caught at compile time rather than silently
 * producing a no-op staleness edge.
 */
type ArtifactFileName =
  | (typeof ARTIFACT_DEFINITIONS)[keyof typeof ARTIFACT_DEFINITIONS]["fileName"]
  | typeof AGENT_FEEDBACK_FILENAME
  | typeof AUDIT_REPORT_FILENAME;

type DependencyMap = Partial<Record<ArtifactFileName, ArtifactFileName[]>>;

/**
 * THE single canonical staleness DAG (ARC-cebe3421).
 *
 * Keyed by an artifact → the list of artifacts it DEPENDS ON (its upstream
 * inputs). When any upstream input's content hash or revision changes, this
 * artifact is stale and must be rebuilt. This is the natural direction for
 * `computeArtifactMetadata` (which records each artifact's dependency
 * revisions) and reduces stale detection to a single revision/hash compare
 * against the recorded upstream revisions.
 *
 * The forward "X → its dependents" view (`ARTIFACT_DEPENDENTS_MAP`, used by
 * `computeStaleArtifacts` to propagate staleness downstream) is DERIVED from
 * this table by `invertDependencyMap` — it is not maintained separately, so the
 * two can never drift. There is exactly one hand-authored adjacency
 * representation; everything else is computed from it.
 *
 * `satisfies` (rather than a type annotation) keeps the literal's precise keys
 * for downstream `keyof`-style derivations while still type-checking every key
 * and value against the known artifact filenames.
 */
export const ARTIFACT_DEPENDS_ON_MAP = {
  // Phase 1 — intake. repo_manifest is rebuilt when the tooling/environment
  // probe changes (a different analyzer version can classify files differently).
  "repo_manifest.json": ["tooling_manifest.json"],
  "file_disposition.json": ["repo_manifest.json"],

  // Phase 2 — structure. The graph is rebuilt from the manifest + disposition;
  // the optional analyzer-enrichment marker tracks the post-enrichment graph.
  // No cycle: the enrichment executor writes graph_bundle AND the marker in one
  // advanceAudit call, and computeArtifactMetadata is dependency-first, so the
  // marker records the post-enrichment graph_bundle revision (mirrors
  // audit-findings → narrative).
  "graph_bundle.json": ["repo_manifest.json", "file_disposition.json"],
  "analyzer_capability.json": ["graph_bundle.json"],
  "unit_manifest.json": ["repo_manifest.json", "file_disposition.json"],
  "surface_manifest.json": ["repo_manifest.json", "file_disposition.json"],
  "critical_flows.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "surface_manifest.json",
  ],
  "risk_register.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "unit_manifest.json",
    "surface_manifest.json",
    "critical_flows.json",
  ],
  // F6 git-history mining: deterministic co-change / churn / authorship mined
  // from the commit log, scoped to the audited file set. Declared upstream deps
  // {repo_manifest, file_disposition} so a manifest/disposition change re-mines.
  "git_history.json": ["repo_manifest.json", "file_disposition.json"],
  "design_assessment.json": ["unit_manifest.json", "critical_flows.json"],

  // Phase 3 — planning & execution. scope.json (delta vs. full) gates coverage;
  // it is also a DIRECT input to audit_tasks so a scope change that produces an
  // identical coverage_matrix (same files/buckets) still re-stales tasks
  // (ARC-cebe3421-3) — the transitive scope→coverage_matrix→audit_tasks path
  // only fires when coverage_matrix content changes. No cycle: planning writes
  // scope.json, coverage_matrix.json, and audit_tasks.json in one advanceAudit
  // call, dependency-first.
  "coverage_matrix.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "unit_manifest.json",
    "intent_checkpoint.json",
    "external_analyzer_results.json",
    "scope.json",
    "audit_results.jsonl",
  ],
  "audit_tasks.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "unit_manifest.json",
    "critical_flows.json",
    "intent_checkpoint.json",
    "external_analyzer_results.json",
    "scope.json",
  ],
  "audit_plan_metrics.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "unit_manifest.json",
    "critical_flows.json",
    "intent_checkpoint.json",
    "external_analyzer_results.json",
    "coverage_matrix.json",
    "audit_tasks.json",
    "audit_results.jsonl",
  ],
  // Provider-neutral task-affinity graph derived from audit_tasks (Phase A of
  // the plan/dispatch seam). Dispatch partitions it just-in-time and persists
  // nothing back. See docs/audit-workflow-design.md.
  "task_affinity_graph.json": ["audit_tasks.json"],
  "flow_coverage.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "critical_flows.json",
    "external_analyzer_results.json",
    "coverage_matrix.json",
    "audit_results.jsonl",
  ],
  "requeue_tasks.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "unit_manifest.json",
    "critical_flows.json",
    "intent_checkpoint.json",
    "external_analyzer_results.json",
    "coverage_matrix.json",
    "flow_coverage.json",
    "audit_results.jsonl",
  ],
  "runtime_validation_tasks.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "unit_manifest.json",
    "surface_manifest.json",
    "critical_flows.json",
    "external_analyzer_results.json",
    "coverage_matrix.json",
    "flow_coverage.json",
    "audit_results.jsonl",
  ],
  "runtime_validation_report.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "critical_flows.json",
    "external_analyzer_results.json",
    "coverage_matrix.json",
    "flow_coverage.json",
    "audit_results.jsonl",
  ],

  // Phase 4 — reporting. The human render depends on every analysis artifact;
  // the canonical machine contract (audit-findings.json) is co-produced by
  // synthesis. The optional narrative marker tracks audit-findings so a
  // re-synthesized contract re-stales the themes/exec-summary/top-risks pass.
  [AUDIT_REPORT_FILENAME]: [
    "repo_manifest.json",
    "file_disposition.json",
    "unit_manifest.json",
    "surface_manifest.json",
    "critical_flows.json",
    "design_assessment.json",
    "syntax_resolution_status.json",
    "external_analyzer_results.json",
    "coverage_matrix.json",
    "flow_coverage.json",
    "runtime_validation_report.json",
    "audit_results.jsonl",
    // Opt-in worker reflections (appended by workers, read-only to the
    // orchestrator). Only the markdown render's "Process Feedback" section
    // depends on it — NOT audit-findings.json, whose machine contract carries
    // no reflections. advanceAudit hashes it fresh every advance so a
    // reflection appended after synthesis re-stales the report exactly once and
    // an unchanged file never churns finalization.
    AGENT_FEEDBACK_FILENAME,
  ],
  "synthesis-narrative.json": ["audit-findings.json"],
} satisfies DependencyMap;

/**
 * Invert a `{ artifact: dependsOn[] }` map into a `{ upstream: dependents[] }`
 * map. The sole derivation from the canonical table — keeps the two adjacency
 * views in lockstep by construction.
 */
export function invertDependencyMap(dependsOn: DependencyMap): DependencyMap {
  const dependents: Record<string, ArtifactFileName[]> = {};
  for (const [artifact, upstreams] of Object.entries(dependsOn)) {
    if (!upstreams) continue;
    for (const upstream of upstreams) {
      (dependents[upstream] ??= []).push(artifact as ArtifactFileName);
    }
  }
  return dependents as DependencyMap;
}

/**
 * Forward staleness adjacency: keyed by an UPSTREAM artifact → the list of
 * DOWNSTREAM artifacts that depend on it (and so become stale when it changes).
 * DERIVED from `ARTIFACT_DEPENDS_ON_MAP` (the single canonical table) — never
 * hand-maintained, so it cannot drift from the dependency direction.
 * `computeStaleArtifacts` uses this view to propagate staleness downstream.
 */
export const ARTIFACT_DEPENDENTS_MAP: DependencyMap =
  invertDependencyMap(ARTIFACT_DEPENDS_ON_MAP);

/**
 * Every artifact participating in the staleness DAG — the union of those that
 * depend on something (`ARTIFACT_DEPENDS_ON_MAP` keys) and those that are
 * depended upon (`ARTIFACT_DEPENDENTS_MAP` keys, i.e. leaf inputs like
 * scope.json / intent_checkpoint.json that have no upstream of their own).
 * `computeArtifactMetadata` enumerates present artifacts from this set so a
 * pure-input artifact still gets a metadata entry (and so its dependents can
 * compare against its revision).
 */
export const ALL_DAG_ARTIFACTS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(ARTIFACT_DEPENDS_ON_MAP),
  ...Object.keys(ARTIFACT_DEPENDENTS_MAP),
]);
