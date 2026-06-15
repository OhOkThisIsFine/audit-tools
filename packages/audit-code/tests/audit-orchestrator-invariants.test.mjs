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

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const orchestratorDir = join(here, "..", "src", "orchestrator");

const { ARTIFACT_DEPENDENTS_MAP, ARTIFACT_DEPENDS_ON_MAP } = await import("../src/orchestrator/dependencyMap.ts");
const { computeStaleArtifacts } = await import("../src/orchestrator/staleness.ts");
const { computeArtifactMetadata } = await import("../src/orchestrator/artifactMetadata.ts");
const { deriveAuditState } = await import("../src/orchestrator/state.ts");
const { ARTIFACT_DEFINITIONS, AUDIT_REPORT_FILENAME } = await import("../src/io/artifacts.ts");
const { AGENT_FEEDBACK_FILENAME } = await import("@audit-tools/shared");

// ---------------------------------------------------------------------------
// INV-03: staleness DAG — scope.json → coverage_matrix chain
// ---------------------------------------------------------------------------

test("INV-03: scope.json → coverage_matrix is in ARTIFACT_DEPENDENTS_MAP", () => {
  const scopeDeps = ARTIFACT_DEPENDENTS_MAP["scope.json"];
  assert.ok(
    Array.isArray(scopeDeps),
    "scope.json must have a dependents entry in ARTIFACT_DEPENDENTS_MAP",
  );
  assert.ok(
    scopeDeps.includes("coverage_matrix.json"),
    "scope.json must list coverage_matrix.json as a dependent so a scope change re-stales coverage",
  );
});

test("INV-03: scope.json has direct edges to coverage_matrix.json AND audit_tasks.json", () => {
  // ARC-cebe3421-3: without a direct scope→audit_tasks edge, a scope change that
  // produces coverage_matrix with identical content (same files/buckets) silently
  // carries stale tasks built under the old scope — the transitive path
  // scope→coverage_matrix→audit_tasks only fires when coverage_matrix content changes.
  const scopeDeps = ARTIFACT_DEPENDENTS_MAP["scope.json"] ?? [];
  assert.ok(
    scopeDeps.includes("coverage_matrix.json"),
    "scope.json must list coverage_matrix.json as a direct dependent",
  );
  assert.ok(
    scopeDeps.includes("audit_tasks.json"),
    "scope.json must list audit_tasks.json as a DIRECT dependent (ARC-cebe3421-3: scope change that produces identical coverage_matrix content must still re-stale tasks)",
  );
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
  assert.ok(
    fromScope.has("coverage_matrix.json"),
    "scope.json must transitively reach coverage_matrix.json",
  );
  assert.ok(
    fromScope.has("flow_coverage.json"),
    "scope.json must transitively reach flow_coverage.json (via coverage_matrix)",
  );
  assert.ok(
    fromScope.has("audit-report.md"),
    "scope.json must transitively reach audit-report.md so scope changes re-stale synthesis",
  );
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
    assert.ok(
      allKnownArtifacts.has(artifact),
      `planning_executor writes "${artifact}" but it is absent from ARTIFACT_DEPENDENTS_MAP (neither key nor value) — staleness cannot propagate to/from it`,
    );
  }
});

test("INV-03: synthesis_executor write set is reachable from planning artifacts in the dependency DAG", () => {
  // synthesis writes audit-findings.json and audit-report.md. Both must be
  // reachable (as downstreams) from upstream planning artifacts, ensuring the
  // full chain closes.
  const synthesisOutputs = ["audit-report.md", "audit-findings.json"];
  const allDownstreams = new Set(Object.values(ARTIFACT_DEPENDENTS_MAP).flat());
  for (const artifact of synthesisOutputs) {
    assert.ok(
      allDownstreams.has(artifact) || Object.keys(ARTIFACT_DEPENDENTS_MAP).includes(artifact),
      `synthesis output "${artifact}" must appear in ARTIFACT_DEPENDENTS_MAP`,
    );
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

  assert.deepEqual(
    [...stale1].sort(),
    [...stale2].sort(),
    "computeStaleArtifacts must be idempotent: same input produces same stale set",
  );
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

  assert.equal(
    stale.size,
    0,
    `A self-consistent bundle should have no stale artifacts, but got: [${[...stale].join(", ")}]`,
  );
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

  assert.deepEqual([...stale1].sort(), [...stale2].sort(), "staleness fixpoint must be stable");
  assert.equal(stale1.size, 0, `expected empty stale set for consistent bundle, got [${[...stale1].join(", ")}]`);
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

  assert.equal(
    cycles.length,
    0,
    `ARTIFACT_DEPENDENCIES_MAP must be acyclic. Detected cycle(s):\n${cycles.map((c) => c.join(" → ")).join("\n")}`,
  );
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
  assert.ok(
    metadata && typeof metadata === "object" && typeof metadata.artifacts === "object",
    "computeArtifactMetadata must return a valid ArtifactMetadataManifest",
  );
  assert.ok(
    Object.keys(metadata.artifacts).length > 0,
    "metadata must contain at least one artifact entry",
  );
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
  assert.ok(obligation, "audit_results_ingested obligation must be present");
  assert.equal(
    obligation.state,
    "satisfied",
    "audit_results_ingested must be 'satisfied' when audit_tasks is empty (zero-task bypass)",
  );
});

test("INV-06: audit_results_ingested is satisfied when audit_tasks is absent (no tasks planned)", () => {
  const bundle = {};
  const state = deriveAuditState(bundle);
  const obligation = state.obligations.find((o) => o.id === "audit_results_ingested");
  assert.ok(obligation, "audit_results_ingested must be derived");
  assert.equal(
    obligation.state,
    "satisfied",
    "audit_results_ingested must be 'satisfied' when no tasks are planned",
  );
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
  assert.ok(obligation, "audit_results_ingested must be derived");
  assert.equal(
    obligation.state,
    "missing",
    "audit_results_ingested must be 'missing' when tasks are present but audit_results is absent",
  );
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
  assert.equal(obligation?.state, "satisfied", "audit_results_ingested must be satisfied when results are present");
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
      assert.ok(
        !pattern.test(src),
        `${filePath} contains a per-ecosystem language branch (pattern: ${pattern}) — obligation/planning code must be language-neutral`,
      );
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

  assert.equal(
    violations.length,
    0,
    `Orchestrator source must not hardcode model identities. Violations:\n${violations.join("\n")}`,
  );
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
  assert.ok(contract, "design_review_contract_completed must be present");
  assert.ok(conceptual, "design_review_conceptual_completed must be present");
  assert.equal(
    contract.state,
    "missing",
    "design_review_contract_completed must be missing when design_assessment.json is stale (legacyReviewed gate)",
  );
  assert.equal(
    conceptual.state,
    "missing",
    "design_review_conceptual_completed must be missing when design_assessment.json is stale (legacyReviewed gate)",
  );
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
  assert.ok(contract, "design_review_contract_completed must be present");
  assert.ok(conceptual, "design_review_conceptual_completed must be present");
  // Without metadata, computeStaleArtifacts returns an empty stale set,
  // so design_assessment.json is NOT in the stale set → legacyReviewed fires.
  assert.equal(
    contract.state,
    "satisfied",
    "non-stale legacy reviewed:true must satisfy design_review_contract_completed",
  );
  assert.equal(
    conceptual.state,
    "satisfied",
    "non-stale legacy reviewed:true must satisfy design_review_conceptual_completed",
  );
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
  assert.equal(contract?.state, "satisfied", "contract_reviewed=true must satisfy contract obligation");
  assert.equal(conceptual?.state, "satisfied", "conceptual_reviewed=true must satisfy conceptual obligation");
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
  assert.ok(
    stale.has("coverage_matrix.json"),
    "coverage_matrix.json must be stale when scope changes",
  );
  assert.ok(
    stale.has("audit_tasks.json"),
    "audit_tasks.json must be stale when scope changes (direct edge guards against identical-coverage no-fire)",
  );
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

  assert.deepEqual(
    unknownKeys,
    [],
    `ARTIFACT_DEPENDENTS_MAP keys that are not known artifact filenames: ${unknownKeys.join(", ")}`,
  );
  assert.deepEqual(
    unknownValues,
    [],
    `ARTIFACT_DEPENDENTS_MAP values that are not known artifact filenames: ${unknownValues.join(", ")}`,
  );
});
