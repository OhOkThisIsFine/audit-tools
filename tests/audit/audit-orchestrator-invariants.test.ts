import { captureCompletedDesignReviews } from "./helpers/designReviewSnapshotFixture.js";
/**
 * Invariant tests for the audit orchestrator module.
 * Covers: INV-audit-orchestrator-01..08
 *
 * INV-01: PRIORITY ↔ EXECUTOR_REGISTRY ↔ advance.ts switch lockstep
 *         → covered by executor-registry-sync.test.mjs (not duplicated here)
 * INV-02: unknown executor → no-progress handoff, never silently claims progress
 *         → covered by advance-error-paths.test.mjs (not duplicated here)
 * INV-03: staleness DAG covers scope.json → review_plan.json → report and
 *         the dependents map matches executor write sets
 * INV-04: computeStaleArtifacts is fixpoint-idempotent (re-running on its own output
 *         produces the same stale set, no synthesis↔runtime oscillation)
 * INV-05: the dependency graph (ARTIFACT_DEPENDENCIES_MAP) is acyclic; every present
 *         artifact set can be dependency-first-ordered without a cycle
 * INV-06: review obligations follow the active question plan and bound-answer
 *         ledger; retired obligations do not appear.
 * INV-07: obligation/planning code stays language-neutral — no per-ecosystem branches
 * INV-08: no hardcoded model identities anywhere in orchestrator source
 */

import { test, expect } from "vitest";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ARTIFACT_DEPENDENTS_MAP, ARTIFACT_DEPENDS_ON_MAP } from "../../src/audit/orchestrator/dependencyMap.js";
import { computeStaleArtifacts } from "../../src/audit/orchestrator/staleness.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { deriveAuditState } from "../../src/audit/orchestrator/state.js";
import { ARTIFACT_DEFINITIONS, AUDIT_REPORT_FILENAME, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { AGENT_FEEDBACK_FILENAME, hashContent } from "audit-tools/shared";
import { publishAuditQuestionWorkload, submitAuditQuestionResult } from "../../src/audit/cli/dispatch/hostHandoff.js";
import { deriveQuestionCycleUnlocked } from "../../src/audit/cli/questionReviewCycle.js";
import { buildQuestionPlanArtifacts } from "../../src/audit/orchestrator/questionPlanExecutor.js";
import { fullAuditScope } from "../../src/audit/orchestrator/scope.js";
import { REVIEW_QUESTION_CONTRACT_VERSION, type ReviewSubmission } from "../../src/shared/types/reviewQuestion.js";
import { withTempRepo } from "./helpers/next-step-harness.js";
import type { AuditTask, RepoManifest } from "../../src/audit/types.js";
import type { DesignAssessment } from "../../src/audit/types/designAssessment.js";
import type { AuditScopeManifest } from "../../src/audit/types/auditScope.js";
import type { AuditPlanMetrics } from "../../src/audit/types/reviewPlanning.js";

const here = dirname(fileURLToPath(import.meta.url));
const orchestratorDir = join(here, "..", "..", "src", "audit", "orchestrator");

function makeRepoManifest(overrides: Partial<RepoManifest> = {}): RepoManifest {
  return {
    repository: { name: "fixture" },
    generated_at: "2026-01-01T00:00:00Z",
    files: [],
    ...overrides,
  };
}

function makeAuditPlanMetrics(overrides: Partial<AuditPlanMetrics> = {}): AuditPlanMetrics {
  return {
    generated_at: "2026-01-01T00:00:00Z",
    task_count: 0,
    packet_count: 0,
    estimated_agent_reduction: 0,
    estimated_agent_reduction_ratio: 0,
    unique_file_count: 0,
    task_file_reference_count: 0,
    repeated_file_reference_count: 0,
    total_task_lines: 0,
    total_packet_lines: 0,
    repeated_line_reference_count: 0,
    min_task_lines: 0,
    max_task_lines: 0,
    average_task_lines: 0,
    lens_task_counts: {},
    priority_task_counts: {},
    packet_quality: {
      average_cohesion_score: 1,
      boundary_crossing_count: 0,
      boundary_edge_kind_counts: {},
      orphan_task_count: 0,
      high_fan_in_file_count: 0,
      high_fan_out_file_count: 0,
      weakly_explained_gap_counts: {},
      weakly_explained_file_extension_counts: {},
      weakly_explained_packet_count: 0,
      weakly_explained_packet_ids: [],
      weakly_explained_packet_samples: [],
      largest_unexplained_packet_files: 0,
    },
    packet_size: {
      single_task_packets: 0,
      multi_task_packets: 0,
      max_tasks_per_packet: 0,
      max_files_per_packet: 0,
    },
    ...overrides,
  };
}

function makeAuditScope(overrides: Partial<AuditScopeManifest> = {}): AuditScopeManifest {
  return {
    mode: "full",
    since: null,
    seed_files: [],
    expanded_files: [],
    budget: { max_files: 100 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// INV-03: staleness DAG — scope.json → review plan and report
// ---------------------------------------------------------------------------

test("INV-03: scope.json directly invalidates the question plan", () => {
  expect(ARTIFACT_DEPENDENTS_MAP["scope.json"]).toContain("review_plan.json");
  expect(ARTIFACT_DEPENDS_ON_MAP["review_plan.json"]).toContain("scope.json");
});

test("INV-03: frozen source and confirmed intent directly invalidate the question plan", () => {
  for (const parent of ["repo_manifest.json", "intent_checkpoint.json"] as const) {
    expect(ARTIFACT_DEPENDENTS_MAP[parent]).toContain("review_plan.json");
  }
});

test("INV-03: scope transitively reaches both machine and human reports", () => {
  const visited = new Set<string>();
  const queue = ["scope.json"];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...((ARTIFACT_DEPENDENTS_MAP as Record<string, readonly string[] | undefined>)[current] ?? []));
  }
  expect(visited).toContain("review_plan.json");
  expect(visited).toContain("audit-findings.json");
  expect(visited).toContain(AUDIT_REPORT_FILENAME);
});

test("INV-03: question planner writes exactly the scope and its question plan", () => {
  const result = buildQuestionPlanArtifacts({ repo_manifest: makeRepoManifest() }, fullAuditScope());
  expect(result.artifacts_written).toEqual(["scope.json", "review_plan.json"]);
  expect(result.updated.scope).toBeDefined();
  expect(result.updated.review_plan).toBeDefined();
});

test("INV-03: synthesis_executor write set is reachable from planning artifacts in the dependency DAG", () => {
  // synthesis writes audit-findings.json and audit-report.md. Both must be
  // reachable (as downstreams) from upstream planning artifacts, ensuring the
  // full chain closes.
  const synthesisOutputs = ["audit-report.md", "audit-findings.json"];
  const allDownstreams = new Set((Object.values(ARTIFACT_DEPENDENTS_MAP).filter(Boolean) as string[][]).flat());
  for (const artifact of synthesisOutputs) {
    expect(allDownstreams.has(artifact) || Object.keys(ARTIFACT_DEPENDENTS_MAP).includes(artifact), `synthesis output "${artifact}" must appear in ARTIFACT_DEPENDENTS_MAP`).toBeTruthy();
  }
});

// ---------------------------------------------------------------------------
// INV-04: computeStaleArtifacts fixpoint idempotence
// ---------------------------------------------------------------------------

test("INV-04: computeStaleArtifacts is fixpoint-idempotent on an unchanged bundle", () => {
  // A bundle with metadata that is self-consistent (computed once).
  const bundle: ArtifactBundle = {
    repo_manifest: makeRepoManifest({
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [{ path: "src/auth.ts", language: "ts", size_bytes: 100 }],
    }),
    file_disposition: {
      files: [{ path: "src/auth.ts", status: "included" as const }],
    },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { items: [] },
  };
  // Compute metadata first
  const metadata = computeArtifactMetadata(bundle);
  const withMeta: ArtifactBundle = { ...bundle, artifact_metadata: metadata };

  // First derivation
  const stale1 = computeStaleArtifacts(withMeta);

  // Second derivation on identical bundle — must produce identical result
  const stale2 = computeStaleArtifacts(withMeta);

  expect([...stale1].sort(), "computeStaleArtifacts must be idempotent: same input produces same stale set").toEqual([...stale2].sort());
});

test("INV-04: a self-consistent bundle produces an empty stale set (no false positive staleness)", () => {
  // When all artifacts are present and metadata is freshly computed, nothing
  // should be stale (no synthesis↔runtime oscillation from an unchanged state).
  const bundle: ArtifactBundle = {
    repo_manifest: makeRepoManifest({
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [{ path: "src/auth.ts", language: "ts", size_bytes: 100 }],
    }),
    file_disposition: {
      files: [{ path: "src/auth.ts", status: "included" as const }],
    },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { items: [] },
  };
  const metadata = computeArtifactMetadata(bundle);
  const withMeta: ArtifactBundle = { ...bundle, artifact_metadata: metadata };
  const stale = computeStaleArtifacts(withMeta);

  expect(stale.size, `A self-consistent bundle should have no stale artifacts, but got: [${[...stale].join(", ")}]`).toBe(0);
});

test("INV-04: re-deriving staleness after a no-op advance yields identical stale set (no oscillation)", () => {
  // Simulate a full planning bundle with self-consistent metadata and no changes.
  // Running computeStaleArtifacts twice must be idempotent — this is the
  // synthesis↔runtime no-oscillation assertion.
  const base: ArtifactBundle = {
    repo_manifest: makeRepoManifest({ generated_at: "t" }),
    file_disposition: { files: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { items: [] },
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [],
    requeue_tasks: [],
    audit_plan_metrics: makeAuditPlanMetrics(),
  };
  const meta1 = computeArtifactMetadata(base);
  const bundleWithMeta: ArtifactBundle = { ...base, artifact_metadata: meta1 };

  const stale1 = computeStaleArtifacts(bundleWithMeta);
  // Second run: re-derive on the exact same bundle
  const stale2 = computeStaleArtifacts(bundleWithMeta);

  expect([...stale1].sort(), "staleness fixpoint must be stable").toEqual([...stale2].sort());
  expect(stale1.size, `expected empty stale set for consistent bundle, got [${[...stale1].join(", ")}]`).toBe(0);
});

// ---------------------------------------------------------------------------
// INV-05: dependency graph is acyclic
// ---------------------------------------------------------------------------

test("INV-05: ARTIFACT_DEPENDS_ON_MAP (the canonical X-depends-on-Y table) is acyclic", () => {
  // ARC-cebe3421: the canonical dependency table is the single source of truth.
  const depsMap = ARTIFACT_DEPENDS_ON_MAP;

  // DFS cycle detection: if we can compute a topological order (no permanent→temporary revisit)
  // the graph is acyclic.
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const cycles: string[][] = [];

  function visit(node: string, path: string[]) {
    if (permanent.has(node)) return;
    if (temporary.has(node)) {
      cycles.push([...path, node]);
      return;
    }
    temporary.add(node);
    for (const dep of (depsMap as Record<string, string[] | undefined>)[node] ?? []) {
      visit(dep, [...path, node]);
    }
    temporary.delete(node);
    permanent.add(node);
  }

  for (const node of Object.keys(depsMap)) {
    visit(node, []);
  }

  expect(cycles.length, `ARTIFACT_DEPENDENCIES_MAP must be acyclic. Detected cycle(s):\n${cycles.map((c) => c.join(" → ")).join("\n")}`).toBe(0);
});

test("INV-05: computeArtifactMetadata processes a full planning bundle without throwing (dependency-first order works)", () => {
  // If computeDependencyFirstOrder hit a cycle, computeArtifactMetadata would
  // loop infinitely or silently mis-order artifacts. Verify it completes.
  const bundle: ArtifactBundle = {
    repo_manifest: makeRepoManifest({ generated_at: "t" }),
    file_disposition: { files: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { items: [] },
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [],
    requeue_tasks: [],
    audit_plan_metrics: makeAuditPlanMetrics(),
    audit_report: "# Report\n",
    synthesis_narrative: {
      status: "omitted",
      theme_count: 0,
      executive_summary_present: false,
      top_risk_count: 0,
    },
  };

  // Should complete without throwing and return a valid metadata manifest.
  const metadata = computeArtifactMetadata(bundle);
  expect(metadata && typeof metadata === "object" && typeof metadata.artifacts === "object", "computeArtifactMetadata must return a valid ArtifactMetadataManifest").toBeTruthy();
  expect(Object.keys(metadata.artifacts).length > 0, "metadata must contain at least one artifact entry").toBeTruthy();
});

test("INV-05: malformed archived affinity cannot change active metadata", () => {
  const base = buildQuestionPlanArtifacts({ repo_manifest: makeRepoManifest() }, fullAuditScope()).updated;
  const baseline = computeArtifactMetadata(base);
  const archived = { ...base, task_affinity_graph: {
    nodes: [{ task_id: "t1", file_paths: ["a.ts"] }],
    edges: [{ from: "t1", to: "MISSING", kind: "cochange", weight: 0.5 }],
  } } as unknown as ArtifactBundle;
  const compared = computeArtifactMetadata(archived, baseline, []);
  expect(compared.artifacts["review_plan.json"]).toEqual(baseline.artifacts["review_plan.json"]);
  expect(compared.artifacts["task_affinity_graph.json"]).toBeUndefined();
  expect(computeStaleArtifacts({ ...archived, artifact_metadata: compared })).toEqual(
    computeStaleArtifacts({ ...base, artifact_metadata: baseline }),
  );
});

// ---------------------------------------------------------------------------
// INV-06: obligation derivation reflects real content
// ---------------------------------------------------------------------------

test("INV-06: an unplanned review is missing rather than already complete", () => {
  const state = deriveAuditState({});
  expect(state.obligations.find(o => o.id === "planning_artifacts")?.state).toBe("missing");
  expect(state.obligations.find(o => o.id === "audit_tasks_completed")?.state).toBe("missing");
  expect(state.obligations.map(o => o.id)).not.toContain("audit_results_ingested");
  expect(state.obligations.map(o => o.id)).not.toContain("runtime_validation_current");
});

// ---------------------------------------------------------------------------
// INV-07: orchestrator obligation/planning code is language-neutral
// ---------------------------------------------------------------------------

test("INV-07: orchestrator source files contain no per-ecosystem conditional branches (language-neutral check)", async () => {
  // The obligation-derivation (state.ts), next-step selection (nextStep.ts),
  // and planning executor (planningExecutors.ts) must not branch on specific
  // programming languages. Language-specific logic belongs in extractors/.
  // Check that these core files don't contain patterns like
  // 'language === "typescript"' / 'language === "python"' / 'lang.toLowerCase()' etc.
  const filesToCheck = [
    join(orchestratorDir, "state.ts"),
    join(orchestratorDir, "nextStep.ts"),
    join(orchestratorDir, "advance.ts"),
    join(orchestratorDir, "dependencyMap.ts"),
  ];

  // Patterns that would indicate per-ecosystem forking in obligation/planning code.
  // Note: "ts" alone is too generic (TypeScript file extension), so use word-boundary patterns.
  const forbiddenPatterns = [
    /language\s*===\s*["'](typescript|python|go|java|rust|ruby|swift|kotlin)/,
    /lang\s*===\s*["'](ts|py|go|java|rs|rb)/,
    /\.language\s*===\s*["'](?:typescript|python|go)/,
  ];

  for (const filePath of filesToCheck) {
    const src = await readFile(filePath, "utf8");
    for (const pattern of forbiddenPatterns) {
      expect(!pattern.test(src), `${filePath} contains a per-ecosystem language branch (pattern: ${pattern}) — obligation/planning code must be language-neutral`).toBeTruthy();
    }
  }
});

// ---------------------------------------------------------------------------
// INV-08: no hardcoded model identities in orchestrator source
// ---------------------------------------------------------------------------

test("INV-08: orchestrator source files contain no hardcoded model names or window/limit tables", async () => {
  // Model names must never appear as string literals in orchestrator code.
  // Tiering is relative (cheapest/mid/top), not by identity. KNOWN_MODEL_LIMITS
  // is a legacy table that should not exist in orchestrator modules.
  const files = await readdir(orchestratorDir);
  const tsFiles = files.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

  // Patterns that indicate hardcoded model identity:
  // - well-known model name strings (claude-3, gpt-4, gemini, llama, etc.)
  // - KNOWN_MODEL_LIMITS reference
  // - context_window or output_window as numeric literal table
  const modelNamePattern = /["'`](claude-[0-9]|gpt-4|gpt-3\.5|gemini-|llama-|mistral-|o[13]-mini|o1-preview)/;
  const knownLimitsPattern = /KNOWN_MODEL_LIMITS/;

  const violations: string[] = [];
  for (const file of tsFiles) {
    const src = await readFile(join(orchestratorDir, file), "utf8");
    if (modelNamePattern.test(src)) {
      violations.push(`${file}: contains hardcoded model name string`);
    }
    if (knownLimitsPattern.test(src)) {
      violations.push(`${file}: references KNOWN_MODEL_LIMITS (legacy table to retire)`);
    }
  }

  expect(violations.length, `Orchestrator source must not hardcode model identities. Violations:\n${violations.join("\n")}`).toBe(0);
});

// ---------------------------------------------------------------------------
// INV-09: the pre-split artifact is invalidated at load (ARC-14c59af5-2)
// ---------------------------------------------------------------------------

/**
 * A pre-split `design_assessment.json` as it exists ON DISK: the combined
 * `reviewed` flag and nothing else. Built here rather than inline because the
 * field is deliberately gone from the type — the shape has exactly one
 * legitimate producer left (an artifact written by the previous release), so the
 * cast IS the point: this is foreign bytes being read back, not a fixture the
 * current release could author.
 */
function preSplitDesignAssessment(): DesignAssessment {
  return {
    generated_at: "2026-01-01T00:00:00Z",
    findings: [],
    reviewed: true,
  } as unknown as DesignAssessment;
}

test("INV-09: a stale pre-split design_assessment.json leaves both review obligations missing", () => {
  // A design_assessment with reviewed:true but no contract_reviewed/conceptual_reviewed
  // is a pre-split artifact. It cannot satisfy either modern obligation whether or
  // not it is stale — the combined verdict answers a different question from the
  // two the tool now asks. Staleness is irrelevant to that answer; this case pins
  // that it stays irrelevant rather than becoming the only thing that saves it.
  //
  // We need a bundle where design_assessment.json is stale. To produce staleness we
  // give it computed metadata then change a dependency (unit_manifest).
  const base: ArtifactBundle = {
    repo_manifest: makeRepoManifest({ generated_at: "t" }),
    file_disposition: { files: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { items: [] },
    // Pre-split: only `reviewed`, neither contract_reviewed nor conceptual_reviewed
    design_assessment: preSplitDesignAssessment(),
  };
  const metadata = computeArtifactMetadata(base);
  // Simulate a structural change: unit_manifest content changes, which stales design_assessment.json
  // (unit_manifest.json → design_assessment.json is an edge in ARTIFACT_DEPENDENTS_MAP).
  const staleBundle: ArtifactBundle = {
    ...base,
    unit_manifest: { units: [{ unit_id: "x", name: "x", kind: "module", files: ["x.ts"], required_lenses: [], risk_score: 1, critical_flows: [] }] },
    artifact_metadata: metadata,
  };
  const state = deriveAuditState(staleBundle);
  const contract = state.obligations.find((o) => o.id === "design_review_contract_completed");
  const conceptual = state.obligations.find((o) => o.id === "design_review_conceptual_completed");
  expect(contract, "design_review_contract_completed must be present").toBeTruthy();
  expect(conceptual, "design_review_conceptual_completed must be present").toBeTruthy();
  expect(contract!.state, "a pre-split verdict cannot satisfy the contract pass").toBe("missing");
  expect(conceptual!.state, "a pre-split verdict cannot satisfy the conceptual pass").toBe("missing");
});

test("INV-09: a NON-stale pre-split design_assessment (reviewed:true) satisfies neither obligation either", () => {
  // Freshness is not what disqualifies it. The pair of assertions below is the
  // one that matters: the invalidation is TOTAL, so a resumed pre-split run is
  // re-asked for both passes rather than having its old combined verdict read as
  // two.
  const bundle: ArtifactBundle = { design_assessment: preSplitDesignAssessment() };
  const state = deriveAuditState(bundle);
  const contract = state.obligations.find((o) => o.id === "design_review_contract_completed");
  const conceptual = state.obligations.find((o) => o.id === "design_review_conceptual_completed");
  expect(contract, "design_review_contract_completed must be present").toBeTruthy();
  expect(conceptual, "design_review_conceptual_completed must be present").toBeTruthy();
  // Without metadata the stale set is empty, so nothing about staleness applies
  // here — the obligations are missing on the flag alone.
  expect(contract!.state, "non-stale pre-split reviewed:true must NOT satisfy the contract pass").toBe("missing");
  expect(conceptual!.state, "non-stale pre-split reviewed:true must NOT satisfy the conceptual pass").toBe("missing");
});

test("INV-09: split design_assessment with matching snapshots satisfies both obligations", () => {
  // Completed flags are backed by snapshots of this exact reviewed context.
  const bundle: ArtifactBundle = {
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      contract_reviewed: true,
      conceptual_reviewed: true,
    },
  };
  const reviewed = captureCompletedDesignReviews(bundle);
  const state = deriveAuditState(reviewed);
  const contract = state.obligations.find((o) => o.id === "design_review_contract_completed");
  const conceptual = state.obligations.find((o) => o.id === "design_review_conceptual_completed");
  expect(contract?.state, "contract_reviewed=true must satisfy contract obligation").toBe("satisfied");
  expect(conceptual?.state, "conceptual_reviewed=true must satisfy conceptual obligation").toBe("satisfied");

  const changed = deriveAuditState({
    ...reviewed,
    repo_manifest: { repository: { name: "changed-context" }, generated_at: "now", files: [] },
  });
  expect(changed.obligations.find((o) => o.id === "design_review_contract_completed")?.state).toBe("stale");
  expect(changed.obligations.find((o) => o.id === "design_review_conceptual_completed")?.state).toBe("stale");
});

// ---------------------------------------------------------------------------
// INV-10: scope.json → review_plan.json direct staleness edge
// ---------------------------------------------------------------------------

test("INV-10: changed confirmed scope stales the plan with the same included source", () => {
  const path = "src/auth.ts";
  const input: ArtifactBundle = {
    repo_manifest: makeRepoManifest({ files: [{ path, language: "typescript", size_bytes: 10, hash: "source-a" }] }),
    file_disposition: { files: [{ path, status: "included" }] },
    surface_manifest: { surfaces: [{ id: "auth", kind: "interface", entrypoint: path }] },
  };
  const full = buildQuestionPlanArtifacts(input, fullAuditScope()).updated;
  const deltaScope = makeAuditScope({ mode: "delta", since: "base", seed_files: [path] });
  const delta = buildQuestionPlanArtifacts(input, deltaScope).updated;
  expect(delta.scope).not.toEqual(full.scope);
  expect(delta.review_plan).toEqual(full.review_plan);
  const metadata = computeArtifactMetadata(full);
  expect(computeStaleArtifacts({ ...full, artifact_metadata: metadata }).has("review_plan.json")).toBe(false);
  const changed = { ...full, scope: delta.scope, artifact_metadata: metadata };
  expect(computeStaleArtifacts(changed).has("review_plan.json")).toBe(true);
});

// ---------------------------------------------------------------------------
// INV-11: ARTIFACT_DEPENDENTS_MAP keys and values are all known artifact filenames
//         (FND-MNT-e5eb0dfc — runtime counterpart of the compile-time ArtifactFileName type constraint)
// ---------------------------------------------------------------------------

test("INV-11: all ARTIFACT_DEPENDENTS_MAP keys and values are known artifact filenames", () => {
  // Build the canonical set from ARTIFACT_DEFINITIONS (the single source of truth)
  // plus the two special-cased files that participate in the staleness DAG.
  const knownFileNames = new Set([
    ...Object.values(ARTIFACT_DEFINITIONS).map((def) => def.fileName),
    AGENT_FEEDBACK_FILENAME,
    AUDIT_REPORT_FILENAME,
  ]);

  const unknownKeys: string[] = [];
  const unknownValues: string[] = [];
  for (const [key, dependents] of Object.entries(ARTIFACT_DEPENDENTS_MAP)) {
    if (!knownFileNames.has(key)) {
      unknownKeys.push(key);
    }
    for (const dep of dependents ?? []) {
      if (!knownFileNames.has(dep)) {
        unknownValues.push(`${key} → ${dep}`);
      }
    }
  }

  expect(unknownKeys, `ARTIFACT_DEPENDENTS_MAP keys that are not known artifact filenames: ${unknownKeys.join(", ")}`).toEqual([]);
  expect(unknownValues, `ARTIFACT_DEPENDENTS_MAP values that are not known artifact filenames: ${unknownValues.join(", ")}`).toEqual([]);
});

// ---------------------------------------------------------------------------
// INV-STATE-PURE: deriveAuditState stays synchronous and pending work remains
// actionable until strictly bound results are ingested.
// ---------------------------------------------------------------------------

function pendingTaskFixture(taskId = "u:security"): AuditTask {
  return {
    task_id: taskId,
    unit_id: "u",
    pass_id: "p",
    lens: "security",
    file_paths: ["src/a.ts"],
    rationale: "r",
    status: "pending",
  };
}

test("INV-STATE-REACHABLE: pending work remains active without execution state", () => {
  const bundle: ArtifactBundle = {
    repo_manifest: makeRepoManifest(),
    audit_tasks: [pendingTaskFixture()],
  };
  const state = deriveAuditState(bundle);
  expect(state.obligations.some((o) => o.state === "blocked")).toBeFalsy();
  expect(state.status).toBe("active");
});

test("INV-STATE-PURE: deriveAuditState is synchronous (returns a state object, not a Promise)", () => {
  const result = deriveAuditState({});
  expect(result instanceof Promise, "deriveAuditState must stay sync — ~20 call sites incl. the drain loop rely on it").toBeFalsy();
  expect(Array.isArray(result.obligations)).toBeTruthy();
});

// ---------------------------------------------------------------------------
// INV-PENDING-SINGLE-SOURCE: use the actual projection that drives host dispatch
// and obligation derivation, including a durable bound submission and resume.
// ---------------------------------------------------------------------------

test("INV-PENDING-SINGLE-SOURCE: scoped host work remains owed until its current binding is answered", async () => {
  await withTempRepo(async root => {
    const path = "src/api/auth.ts";
    const source = "export const online = true;\n";
    await writeFile(join(root, path), source);
    const planned = buildQuestionPlanArtifacts({
      repo_manifest: makeRepoManifest({ files: [
        { path, language: "typescript", size_bytes: Buffer.byteLength(source), hash: hashContent(source) },
      ] }),
      file_disposition: { files: [{ path, status: "included" }] },
      surface_manifest: { surfaces: [{ id: "fixture-operation", kind: "interface", entrypoint: path }] },
      intent_checkpoint: {
        schema_version: "intent-checkpoint/v1", confirmed_at: "2026-01-01T00:00:00Z",
        confirmed_by: "host", scope_summary: "Fixture source", intent_summary: "Review behavior",
        lens_selection: { include: ["behavior"] },
      },
    }, fullAuditScope()).updated;
    const boundary = { root, sourceRoot: root, artifactsDir: join(root, ".audit-tools", "audit") };
    const first = await deriveQuestionCycleUnlocked({ ...boundary, bundle: planned });
    expect(first.pending).toHaveLength(1);
    const binding = first.pending[0]!;
    const { question, assignment } = binding;
    expect(question.lens).toBe("behavior");
    expect(assignment.suggested_sources.map(ref => ref.path)).toContain(path);

    const stateFor = (cycle: typeof first) => deriveAuditState({ ...planned, question_cycle: cycle }).obligations;
    expect(stateFor(first).find(o => o.id === "planning_artifacts")?.state).toBe("satisfied");
    expect(stateFor(first).find(o => o.id === "audit_tasks_completed")?.state).toBe("missing");
    await publishAuditQuestionWorkload({ ...boundary, runId: first.runId, bindings: first.pending });

    const submission: ReviewSubmission = {
      schema_version: REVIEW_QUESTION_CONTRACT_VERSION,
      submission_id: "invariant-bound-answer",
      assignment_id: assignment.assignment_id, question_id: question.question_id,
      revision_id: question.revision_id, snapshot_id: question.snapshot_id,
      inspected_sources: [{ path, start_line: 1 }], evidence_ids: [],
      limitations: ["Synthetic fixture has no runtime evidence."],
      answer: { outcome: "inconclusive", findings: [], observations: [], parts: [{
        part_id: question.requested_parts[0]!.part_id, outcome: "inconclusive",
        observation_ids: [], reason: "No runtime evidence.",
      }] },
    };
    const send = (answer: ReviewSubmission) => submitAuditQuestionResult({
      ...boundary, runId: first.runId, assignmentId: assignment.assignment_id, source: JSON.stringify(answer),
    });
    await expect(send({ ...submission, revision_id: hashContent("different revision") }))
      .rejects.toThrow(/does not match the current issued assignment, question revision and snapshot/);
    const stillOwed = await deriveQuestionCycleUnlocked({ ...boundary, bundle: structuredClone(planned) });
    expect(stillOwed.pending.map(item => item.assignment.assignment_id)).toEqual([assignment.assignment_id]);
    expect(stateFor(stillOwed).find(o => o.id === "audit_tasks_completed")?.state).toBe("missing");

    expect((await send(submission)).kind).toBe("accepted");
    const resumed = await deriveQuestionCycleUnlocked({ ...boundary, bundle: structuredClone(planned) });
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.answers.map(({ submission }) => submission)).toEqual([submission]);
    expect(resumed.pending).toEqual([]);
    expect(stateFor(resumed).find(o => o.id === "audit_tasks_completed")?.state).toBe("satisfied");
  });
});
