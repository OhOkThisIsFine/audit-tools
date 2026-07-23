/**
 * Invariant tests for the audit orchestrator module.
 * Covers: INV-audit-orchestrator-01..08
 *
 * INV-01: PRIORITY ↔ EXECUTOR_REGISTRY ↔ advance.ts switch lockstep
 *         → covered by executor-registry-sync.test.mjs (not duplicated here)
 * INV-02: unknown executor → no-progress handoff, never silently claims progress
 *         → covered by advance-error-paths.test.mjs (not duplicated here)
 * INV-03: staleness DAG covers scope.json→coverage/audit_tasks/flow_coverage and
 *         the dependents map matches executor write sets
 * INV-04: computeStaleArtifacts is fixpoint-idempotent (re-running on its own output
 *         produces the same stale set, no synthesis↔runtime oscillation)
 * INV-05: the dependency graph (ARTIFACT_DEPENDENCIES_MAP) is acyclic; every present
 *         artifact set can be dependency-first-ordered without a cycle
 * INV-06: obligation derivation reflects real content: audit_results_ingested is
 *         satisfied on zero-task runs; missing when tasks present but results absent
 * INV-07: obligation/planning code stays language-neutral — no per-ecosystem branches
 * INV-08: no hardcoded model identities anywhere in orchestrator source
 */

import { test, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const orchestratorDir = join(here, "..", "..", "src", "audit", "orchestrator");

const { ARTIFACT_DEPENDENTS_MAP, ARTIFACT_DEPENDS_ON_MAP } = await import("../../src/audit/orchestrator/dependencyMap.ts");
const { computeStaleArtifacts } = await import("../../src/audit/orchestrator/staleness.ts");
const { computeArtifactMetadata } = await import("../../src/audit/orchestrator/artifactMetadata.ts");
const { deriveAuditState } = await import("../../src/audit/orchestrator/state.ts");
const { ARTIFACT_DEFINITIONS, AUDIT_REPORT_FILENAME } = await import("../../src/audit/io/artifacts.ts");
const { AGENT_FEEDBACK_FILENAME } = await import("audit-tools/shared");
const { buildPendingAuditTasks } = await import("../../src/audit/cli/dispatch/packetFilter.ts");

// ---------------------------------------------------------------------------
// INV-03: staleness DAG — scope.json → coverage_matrix chain
// ---------------------------------------------------------------------------

test("INV-03: scope.json → coverage_matrix is in ARTIFACT_DEPENDENTS_MAP", () => {
  const scopeDeps = ARTIFACT_DEPENDENTS_MAP["scope.json"];
  expect(Array.isArray(scopeDeps), "scope.json must have a dependents entry in ARTIFACT_DEPENDENTS_MAP").toBeTruthy();
  expect(scopeDeps.includes("coverage_matrix.json"), "scope.json must list coverage_matrix.json as a dependent so a scope change re-stales coverage").toBeTruthy();
});

test("INV-03: scope.json has direct edges to coverage_matrix.json AND audit_tasks.json", () => {
  // ARC-cebe3421-3: without a direct scope→audit_tasks edge, a scope change that
  // produces coverage_matrix with identical content (same files/buckets) silently
  // carries stale tasks built under the old scope — the transitive path
  // scope→coverage_matrix→audit_tasks only fires when coverage_matrix content changes.
  const scopeDeps = ARTIFACT_DEPENDENTS_MAP["scope.json"] ?? [];
  expect(scopeDeps.includes("coverage_matrix.json"), "scope.json must list coverage_matrix.json as a direct dependent").toBeTruthy();
  expect(scopeDeps.includes("audit_tasks.json"), "scope.json must list audit_tasks.json as a DIRECT dependent (ARC-cebe3421-3: scope change that produces identical coverage_matrix content must still re-stale tasks)").toBeTruthy();
});

test("INV-03: coverage_matrix.json is downstream of scope.json transitively to flow_coverage.json and audit-report.md", () => {
  // scope → coverage_matrix → [flow_coverage, audit-report.md, ...]
  const dependents = ARTIFACT_DEPENDENTS_MAP;

  function transitiveDownstream(start) {
    const visited = new Set();
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      for (const dep of dependents[current] ?? []) {
        queue.push(dep);
      }
    }
    return visited;
  }

  const fromScope = transitiveDownstream("scope.json");
  expect(fromScope.has("coverage_matrix.json"), "scope.json must transitively reach coverage_matrix.json").toBeTruthy();
  expect(fromScope.has("flow_coverage.json"), "scope.json must transitively reach flow_coverage.json (via coverage_matrix)").toBeTruthy();
  expect(fromScope.has("audit-report.md"), "scope.json must transitively reach audit-report.md so scope changes re-stale synthesis").toBeTruthy();
});

test("INV-03: planning_executor write set is covered by ARTIFACT_DEPENDENTS_MAP as upstream sources", () => {
  // The planning executor writes: scope.json, coverage_matrix.json, flow_coverage.json,
  // runtime_validation_tasks.json, runtime_validation_report.json (conditional),
  // audit_tasks.json, audit_plan_metrics.json, requeue_tasks.json.
  // Each of these must either appear as a key in ARTIFACT_DEPENDENTS_MAP (upstream)
  // OR appear in some entry's value (downstream of something) so staleness propagates.
  const planningWriteSet = [
    "scope.json",
    "coverage_matrix.json",
    "flow_coverage.json",
    "runtime_validation_tasks.json",
    "audit_tasks.json",
    "audit_plan_metrics.json",
    "requeue_tasks.json",
  ];
  const allKnownArtifacts = new Set([
    ...Object.keys(ARTIFACT_DEPENDENTS_MAP),
    ...Object.values(ARTIFACT_DEPENDENTS_MAP).flat(),
  ]);
  for (const artifact of planningWriteSet) {
    expect(allKnownArtifacts.has(artifact), `planning_executor writes "${artifact}" but it is absent from ARTIFACT_DEPENDENTS_MAP (neither key nor value) — staleness cannot propagate to/from it`).toBeTruthy();
  }
});

test("INV-03: synthesis_executor write set is reachable from planning artifacts in the dependency DAG", () => {
  // synthesis writes audit-findings.json and audit-report.md. Both must be
  // reachable (as downstreams) from upstream planning artifacts, ensuring the
  // full chain closes.
  const synthesisOutputs = ["audit-report.md", "audit-findings.json"];
  const allDownstreams = new Set(Object.values(ARTIFACT_DEPENDENTS_MAP).flat());
  for (const artifact of synthesisOutputs) {
    expect(allDownstreams.has(artifact) || Object.keys(ARTIFACT_DEPENDENTS_MAP).includes(artifact), `synthesis output "${artifact}" must appear in ARTIFACT_DEPENDENTS_MAP`).toBeTruthy();
  }
});

// ---------------------------------------------------------------------------
// INV-04: computeStaleArtifacts fixpoint idempotence
// ---------------------------------------------------------------------------

test("INV-04: computeStaleArtifacts is fixpoint-idempotent on an unchanged bundle", () => {
  // A bundle with metadata that is self-consistent (computed once).
  const bundle = {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [{ path: "src/auth.ts", language: "ts", size_bytes: 100 }],
    },
    file_disposition: {
      files: [{ path: "src/auth.ts", status: "included" }],
    },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { items: [] },
  };
  // Compute metadata first
  const metadata = computeArtifactMetadata(bundle);
  const withMeta = { ...bundle, artifact_metadata: metadata };

  // First derivation
  const stale1 = computeStaleArtifacts(withMeta);

  // Second derivation on identical bundle — must produce identical result
  const stale2 = computeStaleArtifacts(withMeta);

  expect([...stale1].sort(), "computeStaleArtifacts must be idempotent: same input produces same stale set").toEqual([...stale2].sort());
});

test("INV-04: a self-consistent bundle produces an empty stale set (no false positive staleness)", () => {
  // When all artifacts are present and metadata is freshly computed, nothing
  // should be stale (no synthesis↔runtime oscillation from an unchanged state).
  const bundle = {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [{ path: "src/auth.ts", language: "ts", size_bytes: 100 }],
    },
    file_disposition: {
      files: [{ path: "src/auth.ts", status: "included" }],
    },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { items: [] },
  };
  const metadata = computeArtifactMetadata(bundle);
  const withMeta = { ...bundle, artifact_metadata: metadata };
  const stale = computeStaleArtifacts(withMeta);

  expect(stale.size, `A self-consistent bundle should have no stale artifacts, but got: [${[...stale].join(", ")}]`).toBe(0);
});

test("INV-04: re-deriving staleness after a no-op advance yields identical stale set (no oscillation)", () => {
  // Simulate a full planning bundle with self-consistent metadata and no changes.
  // Running computeStaleArtifacts twice must be idempotent — this is the
  // synthesis↔runtime no-oscillation assertion.
  const base = {
    repo_manifest: { repository: { name: "f" }, generated_at: "t", files: [] },
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
    audit_plan_metrics: { task_count: 0, packet_count: 0, priority_counts: {} },
  };
  const meta1 = computeArtifactMetadata(base);
  const bundleWithMeta = { ...base, artifact_metadata: meta1 };

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
  const permanent = new Set();
  const temporary = new Set();
  const cycles = [];

  function visit(node, path) {
    if (permanent.has(node)) return;
    if (temporary.has(node)) {
      cycles.push([...path, node]);
      return;
    }
    temporary.add(node);
    for (const dep of depsMap[node] ?? []) {
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
  const bundle = {
    repo_manifest: { repository: { name: "f" }, generated_at: "t", files: [] },
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
    audit_plan_metrics: { task_count: 0, packet_count: 0, priority_counts: {} },
    audit_report: "# Report\n",
    "synthesis-narrative": { status: "omitted" },
  };

  // Should complete without throwing and return a valid metadata manifest.
  const metadata = computeArtifactMetadata(bundle);
  expect(metadata && typeof metadata === "object" && typeof metadata.artifacts === "object", "computeArtifactMetadata must return a valid ArtifactMetadataManifest").toBeTruthy();
  expect(Object.keys(metadata.artifacts).length > 0, "metadata must contain at least one artifact entry").toBeTruthy();
});

// ---------------------------------------------------------------------------
// INV-06: obligation derivation reflects real content
// ---------------------------------------------------------------------------

test("INV-06: audit_results_ingested is satisfied for a zero-task run (no tasks, no results needed)", () => {
  // When audit_tasks is empty (or absent), audit_results_ingested must be
  // satisfied regardless of whether audit_results is present. This is the
  // zero-task bypass: no work to ingest = trivially complete.
  const zeroTaskBundle = { audit_tasks: [] };
  const state = deriveAuditState(zeroTaskBundle);
  const obligation = state.obligations.find((o) => o.id === "audit_results_ingested");
  expect(obligation, "audit_results_ingested obligation must be present").toBeTruthy();
  expect(obligation.state, "audit_results_ingested must be 'satisfied' when audit_tasks is empty (zero-task bypass)").toBe("satisfied");
});

test("INV-06: audit_results_ingested is satisfied when audit_tasks is absent (no tasks planned)", () => {
  const bundle = {};
  const state = deriveAuditState(bundle);
  const obligation = state.obligations.find((o) => o.id === "audit_results_ingested");
  expect(obligation, "audit_results_ingested must be derived").toBeTruthy();
  expect(obligation.state, "audit_results_ingested must be 'satisfied' when no tasks are planned").toBe("satisfied");
});

test("INV-06: audit_results_ingested is missing when tasks are present but audit_results is absent", () => {
  const bundle = {
    audit_tasks: [
      {
        task_id: "u:security",
        unit_id: "u",
        pass_id: "p",
        lens: "security",
        file_paths: ["src/a.ts"],
        rationale: "r",
        status: "pending",
      },
    ],
    // audit_results deliberately absent
  };
  const state = deriveAuditState(bundle);
  const obligation = state.obligations.find((o) => o.id === "audit_results_ingested");
  expect(obligation, "audit_results_ingested must be derived").toBeTruthy();
  expect(obligation.state, "audit_results_ingested must be 'missing' when tasks are present but audit_results is absent").toBe("missing");
});

test("INV-06: audit_results_ingested is satisfied when all tasks have matching results", () => {
  const task = {
    task_id: "u:security",
    unit_id: "u",
    pass_id: "p",
    lens: "security",
    file_paths: ["src/a.ts"],
    rationale: "r",
    status: "pending",
  };
  const bundle = {
    audit_tasks: [task],
    audit_results: [
      {
        task_id: task.task_id,
        unit_id: task.unit_id,
        pass_id: task.pass_id,
        lens: task.lens,
        file_coverage: [{ path: "src/a.ts", total_lines: 10 }],
        findings: [],
      },
    ],
  };
  const state = deriveAuditState(bundle);
  const obligation = state.obligations.find((o) => o.id === "audit_results_ingested");
  expect(obligation?.state, "audit_results_ingested must be satisfied when results are present").toBe("satisfied");
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

  const violations = [];
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
// INV-09: legacyReviewed staleness gate (ARC-14c59af5-2)
// ---------------------------------------------------------------------------

test("INV-09: stale design_assessment.json does NOT activate legacyReviewed — both review obligations are missing", () => {
  // A design_assessment with reviewed:true but no contract_reviewed/conceptual_reviewed
  // is a pre-split legacy artifact. When the artifact is NOT stale (no upstream change),
  // the backward-compat path should still apply (satisfies both obligations).
  // When it IS stale, the obligations must be missing (trigger fresh review passes).
  //
  // We need a bundle where design_assessment.json is stale. To produce staleness we
  // give it computed metadata then change a dependency (unit_manifest).
  const base = {
    repo_manifest: { repository: { name: "f" }, generated_at: "t", files: [] },
    file_disposition: { files: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { items: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      // Legacy pre-split: only `reviewed`, neither contract_reviewed nor conceptual_reviewed
      reviewed: true,
    },
  };
  const metadata = computeArtifactMetadata(base);
  // Simulate a structural change: unit_manifest content changes, which stales design_assessment.json
  // (unit_manifest.json → design_assessment.json is an edge in ARTIFACT_DEPENDENTS_MAP).
  const staleBundle = {
    ...base,
    unit_manifest: { units: [{ unit_id: "x", name: "x", kind: "module", files: ["x.ts"], required_lenses: [], risk_score: 1, critical_flows: [] }] },
    artifact_metadata: metadata,
  };
  const state = deriveAuditState(staleBundle);
  const contract = state.obligations.find((o) => o.id === "design_review_contract_completed");
  const conceptual = state.obligations.find((o) => o.id === "design_review_conceptual_completed");
  expect(contract, "design_review_contract_completed must be present").toBeTruthy();
  expect(conceptual, "design_review_conceptual_completed must be present").toBeTruthy();
  expect(contract.state, "design_review_contract_completed must be missing when design_assessment.json is stale (legacyReviewed gate)").toBe("missing");
  expect(conceptual.state, "design_review_conceptual_completed must be missing when design_assessment.json is stale (legacyReviewed gate)").toBe("missing");
});

test("INV-09: non-stale legacy design_assessment (reviewed:true) still satisfies both review obligations", () => {
  // The backward-compat path must remain active when the artifact is present and fresh.
  const bundle = {
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      reviewed: true,
      // no contract_reviewed or conceptual_reviewed
    },
  };
  const state = deriveAuditState(bundle);
  const contract = state.obligations.find((o) => o.id === "design_review_contract_completed");
  const conceptual = state.obligations.find((o) => o.id === "design_review_conceptual_completed");
  expect(contract, "design_review_contract_completed must be present").toBeTruthy();
  expect(conceptual, "design_review_conceptual_completed must be present").toBeTruthy();
  // Without metadata, computeStaleArtifacts returns an empty stale set,
  // so design_assessment.json is NOT in the stale set → legacyReviewed fires.
  expect(contract.state, "non-stale legacy reviewed:true must satisfy design_review_contract_completed").toBe("satisfied");
  expect(conceptual.state, "non-stale legacy reviewed:true must satisfy design_review_conceptual_completed").toBe("satisfied");
});

test("INV-09: split design_assessment (contract_reviewed + conceptual_reviewed) satisfies both obligations regardless of staleness", () => {
  // New-format artifacts with explicit split flags always satisfy the obligations
  // as long as the flags are true (the staleness gate only applies to the legacy path).
  const bundle = {
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      contract_reviewed: true,
      conceptual_reviewed: true,
    },
  };
  const state = deriveAuditState(bundle);
  const contract = state.obligations.find((o) => o.id === "design_review_contract_completed");
  const conceptual = state.obligations.find((o) => o.id === "design_review_conceptual_completed");
  expect(contract?.state, "contract_reviewed=true must satisfy contract obligation").toBe("satisfied");
  expect(conceptual?.state, "conceptual_reviewed=true must satisfy conceptual obligation").toBe("satisfied");
});

// ---------------------------------------------------------------------------
// INV-10: scope.json → audit_tasks.json direct staleness edge (ARC-cebe3421-3)
// ---------------------------------------------------------------------------

test("INV-10: a scope change stales audit_tasks.json even when coverage_matrix content is unchanged", () => {
  // This is the ARC-cebe3421-3 regression guard. Without a direct scope→audit_tasks edge,
  // if scope changes but coverage_matrix content happens to be identical, audit_tasks
  // would not re-stale (the transitive path never fires). The direct edge ensures
  // scope revision changes always propagate to audit_tasks.

  // Build initial bundle with scope.json and audit_tasks.json present.
  const base = {
    scope: { mode: "full", seed_files: [], generated_at: "2026-01-01T00:00:00Z" },
    coverage_matrix: { files: [] },
    audit_tasks: [],
    requeue_tasks: [],
    audit_plan_metrics: { task_count: 0, packet_count: 0, priority_counts: {} },
  };
  const metadata = computeArtifactMetadata(base);

  // Simulate scope content change (different --since produces different seed_files).
  const changedScopeBundle = {
    ...base,
    scope: { mode: "delta", seed_files: ["src/auth.ts"], generated_at: "2026-01-01T00:00:00Z" },
    artifact_metadata: metadata,
  };

  const stale = computeStaleArtifacts(changedScopeBundle);
  expect(stale.has("coverage_matrix.json"), "coverage_matrix.json must be stale when scope changes").toBeTruthy();
  expect(stale.has("audit_tasks.json"), "audit_tasks.json must be stale when scope changes (direct edge guards against identical-coverage no-fire)").toBeTruthy();
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

  const unknownKeys = [];
  const unknownValues = [];
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
// INV-STATE-PURE-AND-REACHABLE (COR-b019d3b9): deriveAuditState is sync + pure,
// and every AuditTopLevelStatus value is reachable from it — in particular the
// "blocked" branch must be LIVE: a persisted DC-4 dispatch pause
// (active_dispatch.paused_state) with still-pending audit tasks derives a
// blocked (non-actionable) obligation, so the top-level status becomes
// "blocked" from state derivation alone, not only from step-write paths.
// ---------------------------------------------------------------------------

function pendingTaskFixture(taskId = "u:security") {
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

function pausedActiveDispatchFixture() {
  return {
    run_id: "run-paused",
    created_at: "2026-01-01T00:00:00.000Z",
    packet_count: 0,
    task_count: 1,
    status: "active",
    paused_state: {
      lifecycle: { kind: "waiting_for_provider", pause_count: 1 },
      settled_exclusions: [],
    },
  };
}

test("INV-STATE-REACHABLE: a persisted dispatch pause with pending tasks derives top-level 'blocked'", () => {
  const bundle = {
    repo_manifest: { repository: { name: "f" }, files: [] },
    audit_tasks: [pendingTaskFixture()],
    active_dispatch: pausedActiveDispatchFixture(),
  };
  const state = deriveAuditState(bundle);
  expect(
    state.obligations.some((o) => o.state === "blocked"),
    "a paused dispatch with pending tasks must derive at least one blocked obligation",
  ).toBeTruthy();
  expect(state.status, "top-level status must be 'blocked' while the dispatch pause holds").toBe("blocked");
});

test("INV-STATE-REACHABLE: the blocked derivation never masks the resume path — audit_tasks_completed stays actionable ('missing')", () => {
  const bundle = {
    repo_manifest: { repository: { name: "f" }, files: [] },
    audit_tasks: [pendingTaskFixture()],
    active_dispatch: pausedActiveDispatchFixture(),
  };
  const state = deriveAuditState(bundle);
  const completed = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(completed?.state, "audit_tasks_completed must remain 'missing' (actionable) so re-running next-step re-drives dispatch and DC-4 resume works").toBe("missing");
});

test("INV-STATE-REACHABLE: a pause with NO pending tasks does not block (moot pause)", () => {
  const task = pendingTaskFixture();
  const bundle = {
    repo_manifest: { repository: { name: "f" }, files: [] },
    audit_tasks: [{ ...task, status: "complete" }],
    audit_results: [
      {
        task_id: task.task_id,
        unit_id: task.unit_id,
        pass_id: task.pass_id,
        lens: task.lens,
        file_coverage: [{ path: "src/a.ts", total_lines: 10 }],
        findings: [],
      },
    ],
    active_dispatch: pausedActiveDispatchFixture(),
  };
  const state = deriveAuditState(bundle);
  expect(
    state.obligations.some((o) => o.state === "blocked"),
    "a moot pause (no pending tasks) must not derive a blocked obligation",
  ).toBeFalsy();
  expect(state.status).not.toBe("blocked");
});

test("INV-STATE-REACHABLE: no pause => no blocked obligation (default path unchanged)", () => {
  const bundle = {
    repo_manifest: { repository: { name: "f" }, files: [] },
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
// INV-PENDING-SINGLE-SOURCE: buildPendingAuditTasks (dispatch) and
// deriveAuditState's audit_tasks_completed obligation must agree on the pending
// set — one shared derivation, so dispatch and the completion gate can never
// disagree on which tasks still need work.
// ---------------------------------------------------------------------------

test("INV-PENDING-SINGLE-SOURCE: dispatch pending set and audit_tasks_completed agree (pending case)", () => {
  const t1 = pendingTaskFixture("u:security");
  const t2 = pendingTaskFixture("u:correctness");
  const bundle = {
    repo_manifest: { repository: { name: "f" }, files: [] },
    audit_tasks: [t1, t2],
    audit_results: [
      {
        task_id: t1.task_id,
        unit_id: t1.unit_id,
        pass_id: t1.pass_id,
        lens: t1.lens,
        file_coverage: [{ path: "src/a.ts", total_lines: 10 }],
        findings: [],
      },
    ],
  };
  const pendingIds = buildPendingAuditTasks(bundle).map((t) => t.task_id);
  expect(pendingIds).toEqual([t2.task_id]);
  const state = deriveAuditState(bundle);
  const completed = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(completed?.state, "gate must see the same pending set dispatch sees").toBe("missing");
});

test("INV-PENDING-SINGLE-SOURCE: dispatch pending set and audit_tasks_completed agree (all-complete case)", () => {
  const t1 = pendingTaskFixture("u:security");
  const bundle = {
    repo_manifest: { repository: { name: "f" }, files: [] },
    audit_tasks: [t1],
    audit_results: [
      {
        task_id: t1.task_id,
        unit_id: t1.unit_id,
        pass_id: t1.pass_id,
        lens: t1.lens,
        file_coverage: [{ path: "src/a.ts", total_lines: 10 }],
        findings: [],
      },
    ],
  };
  expect(buildPendingAuditTasks(bundle)).toEqual([]);
  const state = deriveAuditState(bundle);
  const completed = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(completed?.state).toBe("satisfied");
});

// ---------------------------------------------------------------------------
// INV-CLAIM-LIFECYCLE pin: AUDIT_TASK_CLAIM_LEASE_MS is single-sourced in
// cli/dispatch.ts; the merge-side ownership gate imports it rather than
// defining its own lease window (liveness judged against ONE window, never two).
// INV-CLAIM-ROUND-FACTS pin: PrepareDispatchResult exposes the claim-round
// facts (candidate_task_count, granted_task_ids) alongside packet_count.
// ---------------------------------------------------------------------------

test("INV-CLAIM-LIFECYCLE pin: the claim lease window is defined exactly once (cli/dispatch.ts) and imported by the merge gate", async () => {
  const auditSrcDir = join(here, "..", "..", "src", "audit");
  const definitionSites = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) {
        const text = await readFile(full, "utf8");
        if (/AUDIT_TASK_CLAIM_LEASE_MS\s*=/.test(text)) definitionSites.push(entry.name);
      }
    }
  }
  await walk(auditSrcDir);
  expect(definitionSites, "exactly one definition site for the claim lease").toEqual(["dispatch.ts"]);
  const mergeText = await readFile(join(auditSrcDir, "cli", "mergeAndIngestCommand.ts"), "utf8");
  expect(/AUDIT_TASK_CLAIM_LEASE_MS/.test(mergeText), "merge gate must consume the single-sourced lease").toBeTruthy();
});

test("INV-CLAIM-ROUND-FACTS pin: PrepareDispatchResult declares candidate_task_count and granted_task_ids and dispatch returns them", async () => {
  const typesText = await readFile(join(here, "..", "..", "src", "audit", "cli", "dispatch", "types.ts"), "utf8");
  expect(/candidate_task_count\s*:\s*number/.test(typesText)).toBeTruthy();
  expect(/granted_task_ids\s*:\s*string\[\]/.test(typesText)).toBeTruthy();
  const dispatchText = await readFile(join(here, "..", "..", "src", "audit", "cli", "dispatch.ts"), "utf8");
  expect(/candidate_task_count:\s*candidateTasks\.length/.test(dispatchText), "claim-round candidate fact must come from the eligible set").toBeTruthy();
  expect(/granted_task_ids:\s*grantedTaskIds/.test(dispatchText), "claim-round granted fact must come from the claim grant").toBeTruthy();
});

test("INV-WALL-PAUSE pin: prepare-dispatch consults detectHostDispatchWall and pauses the at-wall round", async () => {
  const dispatchText = await readFile(join(here, "..", "..", "src", "audit", "cli", "dispatch.ts"), "utf8");
  expect(/detectHostDispatchWall\(/.test(dispatchText), "the wall detector must gate the host dispatch round").toBeTruthy();
  expect(/advanceHostDispatchPause\(/.test(dispatchText), "an at-wall round must advance the persisted pause").toBeTruthy();
  expect(/reconcileAdmissionLeasesFromQuotaFile\(/.test(dispatchText), "pausing must release the granted leases (C3)").toBeTruthy();
});
