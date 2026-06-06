// Invalidation map keyed by UPSTREAM artifact → the list of DOWNSTREAM
// artifacts that depend on it (and so become stale when it changes). The name
// reflects the actual direction: each entry's value is that key's *dependents*.
// `buildArtifactDependenciesMap` flips this to the "X depends on Y" view used by
// computeArtifactMetadata. (Renamed from the misleading ARTIFACT_DEPENDENCY_MAP,
// which read as "X's dependencies" — the opposite of what it stores.)
export const ARTIFACT_DEPENDENTS_MAP: Record<string, string[]> = {
  "tooling_manifest.json": [
    "repo_manifest.json",
  ],
  "repo_manifest.json": [
    "file_disposition.json",
    "unit_manifest.json",
    "surface_manifest.json",
    "graph_bundle.json",
    "critical_flows.json",
    "risk_register.json",
    "coverage_matrix.json",
    "flow_coverage.json",
    "audit_tasks.json",
    "audit_plan_metrics.json",
    "review_packets.json",
    "requeue_tasks.json",
    "runtime_validation_tasks.json",
    "runtime_validation_report.json",
    "audit-report.md",
  ],
  // The optional graph-enrichment pass layers analyzer edges onto graph_bundle
  // and records provenance in analyzer_capability.json. A re-built (structure)
  // graph re-stales the marker so enrichment re-runs. No cycle: the enrichment
  // executor writes graph_bundle AND the marker in one advanceAudit call, and
  // computeArtifactMetadata is dependency-first, so the marker records the
  // post-enrichment graph_bundle revision (mirrors audit-findings → narrative).
  "graph_bundle.json": [
    "analyzer_capability.json",
  ],
  "file_disposition.json": [
    "unit_manifest.json",
    "surface_manifest.json",
    "graph_bundle.json",
    "critical_flows.json",
    "risk_register.json",
    "coverage_matrix.json",
    "flow_coverage.json",
    "audit_tasks.json",
    "audit_plan_metrics.json",
    "review_packets.json",
    "requeue_tasks.json",
    "runtime_validation_tasks.json",
    "runtime_validation_report.json",
    "audit-report.md",
  ],
  "unit_manifest.json": [
    "risk_register.json",
    "design_assessment.json",
    "coverage_matrix.json",
    "audit_tasks.json",
    "audit_plan_metrics.json",
    "review_packets.json",
    "runtime_validation_tasks.json",
    "requeue_tasks.json",
    "audit-report.md",
  ],
  "surface_manifest.json": [
    "critical_flows.json",
    "risk_register.json",
    "runtime_validation_tasks.json",
    "audit-report.md",
  ],
  "critical_flows.json": [
    "flow_coverage.json",
    "risk_register.json",
    "design_assessment.json",
    "audit_tasks.json",
    "audit_plan_metrics.json",
    "review_packets.json",
    "requeue_tasks.json",
    "runtime_validation_tasks.json",
    "runtime_validation_report.json",
    "audit-report.md",
  ],
  "design_assessment.json": [
    "audit-report.md",
  ],
  "external_analyzer_results.json": [
    "coverage_matrix.json",
    "flow_coverage.json",
    "audit_tasks.json",
    "audit_plan_metrics.json",
    "review_packets.json",
    "requeue_tasks.json",
    "runtime_validation_tasks.json",
    "runtime_validation_report.json",
    "audit-report.md",
  ],
  "syntax_resolution_status.json": [
    "audit-report.md",
  ],
  "audit_results.jsonl": [
    "coverage_matrix.json",
    "flow_coverage.json",
    "requeue_tasks.json",
    "audit_plan_metrics.json",
    "review_packets.json",
    "runtime_validation_tasks.json",
    "runtime_validation_report.json",
    "audit-report.md",
  ],
  // Phase 3 delta scope. scope.json is produced by the planning executor (full
  // or delta) and gates coverage: in delta mode it decides which coverage
  // entries are (re)queued vs. inherited-complete/excluded. A changed scope
  // (different `--since`/seed set → new content hash) re-stales coverage so the
  // plan rebuilds. No cycle: planning writes scope.json AND coverage_matrix.json
  // in one advanceAudit call, and computeArtifactMetadata is dependency-first,
  // so coverage records the post-write scope revision (mirrors graph_bundle →
  // analyzer_capability and audit-findings → narrative).
  "scope.json": [
    "coverage_matrix.json",
  ],
  "coverage_matrix.json": [
    "flow_coverage.json",
    "audit_plan_metrics.json",
    "review_packets.json",
    "requeue_tasks.json",
    "runtime_validation_tasks.json",
    "runtime_validation_report.json",
    "audit-report.md",
  ],
  "flow_coverage.json": [
    "requeue_tasks.json",
    "runtime_validation_tasks.json",
    "runtime_validation_report.json",
    "audit-report.md",
  ],
  "audit_tasks.json": [
    "audit_plan_metrics.json",
    "review_packets.json",
  ],
  "audit_plan_metrics.json": [],
  "review_packets.json": [],
  "runtime_validation_report.json": [
    "audit-report.md",
  ],
  // The canonical machine contract is co-produced with audit-report.md by the
  // synthesis executor. The optional narrative pass tracks its revision: a fresh
  // (re-synthesized) audit-findings.json re-stales the narrative marker so the
  // themes/executive-summary/top-risks regenerate. See spec/dependency-map.md.
  "audit-findings.json": [
    "synthesis-narrative.json",
  ],
};
