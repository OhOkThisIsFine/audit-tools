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
  // critical-flow-fallback.json is a DURABLE HOST INPUT (a leaf, like
  // intent_checkpoint.json): the LLM fallback pass writes the host-authored flow
  // enrichment, and the structure phase merges it into critical_flows. Declaring
  // it upstream here is what makes the enrichment take effect cleanly — when the
  // host submits it, critical_flows re-stales and structure rebuilds critical_flows
  // AND risk_register atomically off the merged flows (no self-clobber loop from a
  // separate post-hoc rewrite). Absent on the common (bar-met) path → recorded at
  // revision 0, never stale.
  // critical_flows (like surface_manifest) reads the graph but deliberately does
  // NOT list graph_bundle.json: structure hands it the floor graph built in the
  // same call, whose inputs (repo_manifest, file_disposition) are declared here.
  // A direct edge would re-stale it after every graph enrichment, rebuild the
  // floor, re-stale analyzer_capability, and loop (spec/audit/dependency-map.md).
  "critical_flows.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "surface_manifest.json",
    "critical-flow-fallback.json",
  ],
  "risk_register.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "unit_manifest.json",
    "surface_manifest.json",
    "critical_flows.json",
  ],
  // Git-history mining: deterministic co-change / churn / authorship mined
  // from the commit log, scoped to the audited file set. Declared upstream deps
  // {repo_manifest, file_disposition} so a manifest/disposition change re-mines.
  "git_history.json": ["repo_manifest.json", "file_disposition.json"],
  // External-analyzer acquisition marker (Slice D): records THAT the acquisition
  // engine ran for the current intake + WITH WHAT per-candidate outcome. Declared
  // upstream deps {repo_manifest, file_disposition} so a manifest/disposition
  // change re-stales the marker → acquisition re-runs (and the freshly-written
  // external_analyzer_results.json re-stales its own downstreams). The findings
  // array (external_analyzer_results.json) stays a leaf upstream of planning; this
  // marker is the run-record + staleness anchor the obligation gates on.
  "external_analyzer_acquisition.json": [
    "repo_manifest.json",
    "file_disposition.json",
  ],
  "design_assessment.json": ["unit_manifest.json", "critical_flows.json"],
  "conceptual_review_adjudication.json": ["design_assessment.json"],
  // Change 3 (scope-confirmation context): bounded deterministic telos
  // extraction over the doc universe, rendered into the confirm-intent prompt.
  // Depends on what the extractor actually reads — the disposition (doc
  // universe via `isDocIntentFile`) plus repo_manifest, whose per-file hashes
  // re-stale this transitively when a doc's CONTENT changes. Deliberately NO
  // downstream edge, and NEVER an upstream of `intent_checkpoint.json` (a
  // durable host-input leaf whose revision mirrors the intent baseline — an
  // edge here would re-stale the confirmed checkpoint on every doc edit).
  "docs_digest.json": ["repo_manifest.json", "file_disposition.json"],
  // Phase B conceptual design-review: the deterministic structure-layer
  // decomposition (overlay-and-delta operator). Depends on the enriched graph
  // (co-change + analyzer edges land in graph_bundle) plus the manifest +
  // disposition — repo_manifest carries per-file hashes, so a source-content
  // change re-stales it transitively (comment/doc extraction reads that source).
  "structure_decomposition.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "graph_bundle.json",
  ],
  // Phase C conceptual design-review: the charter LAYER (three lane goal DAGs,
  // correspondences, differences, fidelity). Depends on unit_manifest (the
  // non-test files of its units ARE the members each lane reads,
  // `charterPacketReadSet`), the
  // confirmed intent checkpoint (the ceiling/consent dial that gates its depth),
  // repo_manifest (every lane packet is a projection of member/doc content — its
  // per-file hashes re-stale this transitively), and graph_bundle (the
  // STRUCTURAL lane's packet embeds the dependency edges among members, and
  // analyzer enrichment can merge new edges with NO file-content change —
  // without this edge that would under-stale; design resolution 4). No
  // structure_decomposition edge: no charter_register producer reads it.
  // Charters live in this OUTPUT artifact, never back on the checkpoint it
  // depends on, so there is no cycle.
  // sites-pinned: tests/audit/dependency-slices.test.ts
  "charter_register.json": [
    "unit_manifest.json",
    "intent_checkpoint.json",
    "repo_manifest.json",
    "graph_bundle.json",
  ],
  // Phase D conceptual design-review: the charter-alignment TRIANGULATION LOOP.
  // Depends on the Phase-C charter register (the differences it questions), the confirmed
  // intent checkpoint (the ceiling + attention dials that gate its depth/appetite),
  // and repo_manifest (a source-content change re-stales the register transitively).
  // It also reads structure_decomposition directly: each difference's report
  // grouping key is the consensus unit its files overlap most (`placeInSubsystem`),
  // so the edge is declared here (sliced to consensus membership,
  // dependencySlices.ts); the register itself has no decomposition edge.
  // Deterministic: the loop assembles from the register, so re-running is idempotent.
  // sites-pinned: tests/audit/dependency-slices.test.ts
  "charter_clarification.json": [
    "charter_register.json",
    "intent_checkpoint.json",
    "repo_manifest.json",
    "structure_decomposition.json",
  ],
  // Phase E systemic improvement-seeking challenge loop. Depends on the Phase-C
  // charter register (the lane goal DAGs its blast-radius ranking reuses), the confirmed
  // intent checkpoint (the ceiling that gates its depth), and repo_manifest (a
  // source-content change re-stales the register + re-grounds its findings). The
  // aggregate-metrics digest is derived from analysis artifacts but is advisory
  // context — the register's freshness is anchored on the same triad as
  // charter_clarification so the two conceptual-review outputs stale together.
  "systemic_challenge.json": [
    "charter_register.json",
    "conceptual_review_adjudication.json",
    "intent_checkpoint.json",
    "repo_manifest.json",
  ],

  // Phase 3: source, confirmed scope, and evidence freeze the question plan.
  "review_plan.json": [
    "repo_manifest.json",
    "file_disposition.json",
    "scope.json",
    "intent_checkpoint.json",
    "surface_manifest.json",
    "critical_flows.json",
    "unit_manifest.json",
    "graph_bundle.json",
    "charter_register.json",
    "design_assessment.json",
    "systemic_challenge.json",
    "external_analyzer_results.json",
  ],

  // Phase 4: the human report and its separate narrative marker.
  [AUDIT_REPORT_FILENAME]: [
    "review_plan.json",
    "repo_manifest.json",
    "file_disposition.json",
    "unit_manifest.json",
    "surface_manifest.json",
    "critical_flows.json",
    "design_assessment.json",
    "conceptual_review_adjudication.json",
    "structure_decomposition.json",
    "charter_register.json",
    "charter_clarification.json",
    "systemic_challenge.json",
    "syntax_resolution_status.json",
    "external_analyzer_results.json",
    // Opt-in worker reflections (appended by workers, read-only to the
    // orchestrator). Only the markdown render's "Process Feedback" section
    // depends on it — NOT audit-findings.json, whose machine contract carries
    // no reflections. advanceAudit hashes it fresh every advance so a
    // reflection appended after synthesis re-stales the report exactly once and
    // an unchanged file never churns finalization.
    AGENT_FEEDBACK_FILENAME,
  ],
  "audit-findings.json": ["review_plan.json"],
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
 * LATE-INPUT edges: declared dependencies whose upstream is (re)written by an
 * obligation the drain schedules AFTER the downstream's producer (planning runs
 * before the charter, clarification and systemic passes on purpose — inspection
 * needs scope and structure, not completed architecture inquiry).
 *
 * Each such edge carries a slice projection (dependencySlices.ts), the existing
 * machinery that already does what a late edge needs: `computeStaleArtifacts`
 * DEFERS the downstream rather than propagating a stale-and-pending upstream's
 * staleness (the downstream's producer could never clear it — the upstream
 * re-derives only later — so it would be re-selected forever), and once the
 * upstream has re-derived the per-edge slice compare decides on CONTENT, so a
 * revision-only re-derivation does not re-select planning either. A moved slice
 * stales the downstream, whose earlier-scheduled producer then re-derives.
 * `findPriorityOrderingViolations` (advance.ts) checks every declared pair is
 * genuinely late; an ordinary slice edge must be early instead.
 */
export const LATE_INPUT_EDGES: Partial<Record<ArtifactFileName, readonly ArtifactFileName[]>> = {};

/** True when `downstream ← upstream` is a declared late-input edge. */
export function isLateInputEdge(downstream: string, upstream: string): boolean {
  return (LATE_INPUT_EDGES as Partial<Record<string, readonly string[]>>)[downstream]?.includes(upstream) ?? false;
}

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
