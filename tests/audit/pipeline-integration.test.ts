/**
 * N-A08: Audit pipeline integration tests.
 *
 * Five integration scenarios:
 *   1. Batch-deterministic block — all five sub-steps complete in a single
 *      next-step invocation; no intermediate deterministic pauses returned.
 *   2. Intent-checkpoint gating — planning_artifacts stays missing until the
 *      checkpoint is written; disposition overrides prune files before coverage
 *      initialises; lens_selection restricts tasks to effective lenses only.
 *   3. Parallel design review — both contract and conceptual host_delegation
 *      entries are present before either is consumed.
 *   4. Semantic review — ingestion folds inline; synthesis follows directly
 *      after results; semantic_review_executor owns audit_tasks_completed.
 *   5. Narrative omission — synthesis_narrative writes status='omitted' when no
 *      optional narrative is submitted; the run terminates cleanly.
 */
import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type IntentCheckpoint,
} from "audit-tools/shared";

import type { AuditTask } from "../../src/audit/types.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { deriveAuditState } from "../../src/audit/orchestrator/state.js";
import { decideNextStep, PRIORITY } from "../../src/audit/orchestrator/nextStep.js";
import { EXECUTOR_REGISTRY, isHostDelegationExecutor } from "../../src/audit/orchestrator/executors.js";
import {
  runSynthesisExecutor,
  runSynthesisNarrativeExecutor,
} from "../../src/audit/orchestrator/synthesisExecutors.js";
import { runPlanningExecutor } from "../../src/audit/orchestrator/planningExecutors.js";
import {
  renderContractReviewPrompt,
  renderConceptualReviewPrompt,
} from "../../src/audit/orchestrator/designReviewPrompt.js";
import { runIntentEquivalenceResolve } from "../../src/audit/orchestrator/intentEquivalenceExecutor.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { resolveEffectiveLenses } from "../../src/audit/orchestrator/lensSelection.js";

// Settle the DD-9 intent-equivalence baseline: stamp artifact_metadata.intent_baseline
// from the live checkpoint (deterministic first-contact arm) so
// intent_equivalence_current — which sits directly after intent_checkpoint_current —
// is satisfied and the decision reaches the obligation the test targets. The full
// computeArtifactMetadata manifest (not an empty one) keeps the staleness pass clean.
function settleIntentBaseline(bundle: ArtifactBundle): ArtifactBundle {
  return runIntentEquivalenceResolve({
    ...bundle,
    artifact_metadata: computeArtifactMetadata(bundle),
  }).updated;
}

// ── Shared bundle factory helpers ─────────────────────────────────────────────

interface PostDesignAssessmentOptions {
  contract_reviewed?: boolean;
  conceptual_reviewed?: boolean;
  designOverrides?: Record<string, unknown>;
}

/** Bundle ready for intent_checkpoint (all deterministic obligations satisfied). */
function makePostDesignAssessmentBundle(opts: PostDesignAssessmentOptions = {}): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "integration-fixture" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [
        { path: "src/a.ts", language: "typescript", size_bytes: 100 },
        { path: "src/b.ts", language: "typescript", size_bytes: 120 },
        { path: "vendor/lib.ts", language: "typescript", size_bytes: 80 },
      ],
    },
    file_disposition: {
      files: [
        { path: "src/a.ts", status: "included" },
        { path: "src/b.ts", status: "included" },
        { path: "vendor/lib.ts", status: "vendor" },
      ],
    },
    auto_fixes_applied: { fixes: [] },
    syntax_resolution_status: { resolved: true },
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { status: "omitted", analyzers: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      contract_reviewed: opts.contract_reviewed ?? false,
      conceptual_reviewed: opts.conceptual_reviewed ?? false,
      ...opts.designOverrides,
    },
    docs_digest: { generated_at: "2026-01-01T00:00:00.000Z", docs: [] },
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 0,
      source_ids: [],
      consensus: [],
      contested: [],
      findings: [],
    },
    // Phase C charter layer: an omitted (shallow-ceiling) register so
    // charter_extraction_current is satisfied and the design-review/planning
    // obligations these tests target are reachable. Only consulted after the
    // checkpoint is present (charter extraction sits between them).
    charter_register: {
      schema_version: "charter-register/v2",
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "charter",
      ceiling: { rung: "shallow" },
      status: "omitted",
      subsystems: [],
      goal_graph: { nodes: [], edges: [] },
      deltas: [],
      findings: [],
      triangulated: [],
      disagreement: [],
      validation_issues: [],
    },
    // Phase D charter-clarification triangulation loop: an omitted (shallow-ceiling)
    // register so charter_clarification_current is satisfied and the planning
    // obligations these tests target are reachable. Sits between the design-review
    // passes and planning.
    charter_clarification: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "charter_clarification",
      ceiling: { rung: "shallow" },
      attention: 0,
      status: "omitted",
      asked: [],
      banked: [],
      findings: [],
      validation_issues: [],
    },
    // Phase E systemic challenge loop: an omitted (shallow-ceiling) register so
    // systemic_challenge_current is satisfied (converged) and the planning obligations
    // these tests target are reachable. Sits between charter-clarification and planning.
    systemic_challenge: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "systemic_challenge",
      ceiling: { rung: "shallow" },
      status: "omitted",
      rounds: [],
      converged: true,
      findings: [],
      validation_issues: [],
    },
  };
}

function makeValidCheckpoint(opts: Partial<IntentCheckpoint> = {}): IntentCheckpoint {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "full audit",
    intent_summary: "full-audit",
    ...opts,
  };
}

interface PostDesignReviewOptions {
  checkpointOverrides?: Partial<IntentCheckpoint>;
  extra?: Partial<ArtifactBundle>;
}

/** Bundle ready for planning (all obligations up to and including design reviews satisfied). */
function makePostDesignReviewBundle(opts: PostDesignReviewOptions = {}): ArtifactBundle {
  return {
    ...makePostDesignAssessmentBundle({
      contract_reviewed: true,
      conceptual_reviewed: true,
    }),
    intent_checkpoint: makeValidCheckpoint(opts.checkpointOverrides),
    ...(opts.extra ?? {}),
  };
}

// ── Scenario 1: Batch-deterministic block ─────────────────────────────────────
//
// The pipeline halts at the FIRST host_delegation after the deterministic block.
// Since design_review obligations require host delegation, and they come before
// planning in PRIORITY, we verify that the decision selects a host_delegation
// executor (not a deterministic one) after design_assessment is satisfied.

test("S1: after design_assessment, decideNextStep selects a host_delegation executor (batch halts)", () => {
  const bundle = makePostDesignAssessmentBundle();
  const decision = decideNextStep(bundle);
  expect(decision.selected_executor, "a selected_executor must be returned when obligations remain").toBeTruthy();
  expect(isHostDelegationExecutor(decision.selected_executor!), `expected a host_delegation executor after deterministic block; got "${decision.selected_executor}"`).toBeTruthy();
});

test("S1: deterministic obligations (structure_artifacts etc.) are satisfied before design review pauses", () => {
  const bundle = makePostDesignAssessmentBundle();
  const state = deriveAuditState(bundle);

  const deterministic = [
    "repo_manifest",
    "file_disposition",
    "auto_fixes_applied",
    "syntax_resolved",
    "external_analyzers_current",
    "structure_artifacts",
    "graph_enrichment_current",
    "design_assessment_current",
  ];
  for (const id of deterministic) {
    const obl = state.obligations.find((o) => o.id === id);
    if (obl) {
      expect(obl.state === "satisfied" || obl.state === "present", `Obligation ${id} should be satisfied; got "${obl.state}"`).toBeTruthy();
    }
    // If absent, it was satisfied and pruned — acceptable.
  }
});

test("S1: decideNextStep does NOT return intent_checkpoint before design_assessment is present", () => {
  // Bundle without design_assessment → design_assessment_current is missing/stale.
  const bundleNoDa: ArtifactBundle = {
    repo_manifest: {
      repository: { name: "integration-fixture" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [],
    },
    file_disposition: { files: [] },
    auto_fixes_applied: { fixes: [] },
    syntax_resolution_status: { resolved: true },
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { status: "omitted", analyzers: [] },
    // design_assessment deliberately absent
  };
  const decision = decideNextStep(bundleNoDa);
  expect(decision.selected_obligation, "intent_checkpoint_current must not be selected while design_assessment_current is missing").not.toBe("intent_checkpoint_current");
});

// ── Scenario 2: Intent-checkpoint gating ─────────────────────────────────────

test("S2: planning_artifacts is missing when intent_checkpoint is absent", () => {
  // Bundle with design reviews done but no intent_checkpoint
  const bundle = {
    ...makePostDesignAssessmentBundle({
      contract_reviewed: true,
      conceptual_reviewed: true,
    }),
    // No intent_checkpoint
  };
  const decision = decideNextStep(bundle);
  // Should halt at intent_checkpoint_current
  expect(decision.selected_obligation, "decideNextStep must select intent_checkpoint_current when checkpoint is absent").toBe("intent_checkpoint_current");
  expect(isHostDelegationExecutor(decision.selected_executor!), "intent_checkpoint_executor is a host_delegation executor").toBe(true);
});

test("S2: planning_artifacts obligation advances past intent_checkpoint once the checkpoint is written", () => {
  const bundle = settleIntentBaseline(makePostDesignReviewBundle());
  const decision = decideNextStep(bundle);
  expect(decision.selected_obligation, "After checkpoint is written, intent_checkpoint_current must be satisfied").not.toBe("intent_checkpoint_current");
  // planning_artifacts should now be the selected obligation
  expect(decision.selected_obligation, "After checkpoint, the next obligation should be planning_artifacts").toBe("planning_artifacts");
});

test("S2: disposition_override excludes a file before coverage initialises — that file never appears in audit_tasks", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "pipeline-s2-override-"));
  try {
    const bundle = makePostDesignReviewBundle({
      checkpointOverrides: {
        disposition_overrides: [
          { path: "src/b.ts", status: "excluded", reason: "manual override" },
        ],
      },
      extra: {
        // Minimal unit_manifest needed by planning
        unit_manifest: { units: [] },
        surface_manifest: { surfaces: [] },
        critical_flows: { flows: [] },
        risk_register: { items: [] },
        graph_bundle: { graphs: {} },
        analyzer_capability: { status: "omitted", analyzers: [] },
      },
    });

    const result = await runPlanningExecutor(bundle, tmpDir, {});
    const tasks = result.updated.audit_tasks ?? [];
    const overriddenTask = tasks.find((t) =>
      t.file_paths?.some((p) => p === "src/b.ts"),
    );
    expect(overriddenTask, "src/b.ts was overridden to excluded — must not appear in any audit_task").toBe(undefined);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

type TaskWithOptionalRequiredLenses = AuditTask & { required_lenses?: string[] };

test("S2: lens_selection restricts tasks to effective lenses (mandatory always included)", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "pipeline-s2-lens-"));
  try {
    const bundle = makePostDesignReviewBundle({
      checkpointOverrides: {
        lens_selection: { include: ["performance"] },
      },
      extra: {
        unit_manifest: { units: [] },
        surface_manifest: { surfaces: [] },
        critical_flows: { flows: [] },
        risk_register: { items: [] },
        graph_bundle: { graphs: {} },
        analyzer_capability: { status: "omitted", analyzers: [] },
      },
    });

    const result = await runPlanningExecutor(bundle, tmpDir, {});
    const tasks: TaskWithOptionalRequiredLenses[] = result.updated.audit_tasks ?? [];
    // All tasks must only use lenses in the effective set (performance + mandatory)
    const MANDATORY = new Set(["security", "correctness", "reliability", "data_integrity"]);
    const ALLOWED = new Set(["performance", ...MANDATORY]);
    for (const task of tasks) {
      if (task.lens) {
        expect(ALLOWED.has(task.lens), `task ${task.task_id} has lens "${task.lens}" which is not in the allowed set`).toBeTruthy();
      }
      if (task.required_lenses) {
        for (const l of task.required_lenses) {
          expect(ALLOWED.has(l), `task ${task.task_id} has required_lens "${l}" which is not in the allowed set`).toBeTruthy();
        }
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("S2: mandatory lenses cannot be excluded — correctness always in effective set", async () => {
  // This tests the resolveEffectiveLenses invariant that mandatory lenses survive
  // the exclude filter — the planning executor honours this via resolveEffectiveLenses.
  // Even if the user explicitly includes and then excludes correctness,
  // resolveEffectiveLenses re-unions mandatory lenses after the exclude filter.
  const baseSelected = ["performance", "correctness"];
  const resolved = resolveEffectiveLenses(baseSelected);
  const afterExclude = resolved.filter((l) => l !== "correctness");
  const reResolved = resolveEffectiveLenses(afterExclude);

  expect(reResolved.includes("correctness"), "correctness (mandatory) must be present even after exclude — resolveEffectiveLenses invariant").toBeTruthy();
  expect(reResolved.includes("security"), "security (mandatory) must always be present").toBeTruthy();
  expect(reResolved.includes("reliability"), "reliability (mandatory) must always be present").toBeTruthy();
  expect(reResolved.includes("data_integrity"), "data_integrity (mandatory) must always be present").toBeTruthy();
});

// ── Scenario 3: Parallel design review ───────────────────────────────────────

test("S3: both design_review_contract_completed and design_review_conceptual_completed are in PRIORITY", () => {
  const contractIdx = PRIORITY.indexOf("design_review_contract_completed");
  const conceptualIdx = PRIORITY.indexOf("design_review_conceptual_completed");
  expect(contractIdx >= 0, "design_review_contract_completed must be in PRIORITY").toBeTruthy();
  expect(conceptualIdx >= 0, "design_review_conceptual_completed must be in PRIORITY").toBeTruthy();
});

test("S3: design_review_contract executor is a host_delegation with contract categories", () => {
  const bundle = makePostDesignAssessmentBundle();
  const contractEntry = EXECUTOR_REGISTRY.find(
    (e) => e.obligation_ids.includes("design_review_contract_completed"),
  );
  expect(contractEntry, "must have an executor for design_review_contract_completed").toBeTruthy();
  expect(contractEntry!.kind).toBe("host_delegation");

  // The prompt rendered for this executor must include contract categories
  const prompt = renderContractReviewPrompt(bundle);
  expect(prompt).toMatch(/inferred_contract_gap|trust_boundary_gap/);
  expect(prompt).not.toMatch(/tool_opportunity/);
  expect(prompt).not.toMatch(/architecture_pattern/);
});

test("S3: design_review_conceptual executor is a host_delegation with conceptual categories", () => {
  const bundle = makePostDesignAssessmentBundle();
  const conceptualEntry = EXECUTOR_REGISTRY.find(
    (e) => e.obligation_ids.includes("design_review_conceptual_completed"),
  );
  expect(conceptualEntry, "must have an executor for design_review_conceptual_completed").toBeTruthy();
  expect(conceptualEntry!.kind).toBe("host_delegation");

  const prompt = renderConceptualReviewPrompt(bundle);
  expect(prompt).toMatch(/tool_opportunity|architecture_pattern/);
  expect(prompt).not.toMatch(/inferred_contract_gap/);
  expect(prompt).not.toMatch(/trust_boundary_gap/);
});

test("S3: both design review obligations are present as host_delegation before either is consumed", () => {
  // In the PRIORITY chain, design_review_contract comes before design_review_conceptual.
  // Both must be missing simultaneously in the pre-review state.
  const bundle = makePostDesignAssessmentBundle({
    // design_assessment present but neither reviewed flag set
  });
  // Add intent_checkpoint so it doesn't block first
  const bundleWithCheckpoint = {
    ...bundle,
    intent_checkpoint: makeValidCheckpoint(),
  };

  const contractOblState = deriveAuditState(bundleWithCheckpoint).obligations.find(
    (o) => o.id === "design_review_contract_completed",
  );
  const conceptualOblState = deriveAuditState(bundleWithCheckpoint).obligations.find(
    (o) => o.id === "design_review_conceptual_completed",
  );

  expect(contractOblState?.state, "design_review_contract_completed must be missing before contract review").toBe("missing");
  expect(conceptualOblState?.state, "design_review_conceptual_completed must be missing before conceptual review").toBe("missing");
});

test("S3: after contract review completes, conceptual review is still missing (sequential within design phase)", () => {
  const bundle = settleIntentBaseline({
    ...makePostDesignAssessmentBundle(),
    intent_checkpoint: makeValidCheckpoint(),
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      contract_reviewed: true,   // done
      conceptual_reviewed: false, // not yet
    },
  });
  const decision = decideNextStep(bundle);
  expect(decision.selected_obligation, "After contract review, conceptual review should be next").toBe("design_review_conceptual_completed");
});

// ── Scenario 4: Semantic review ──────────────────────────────────────────────

test("S4: semantic_review_executor is the sole owner of audit_tasks_completed", () => {
  const owners = EXECUTOR_REGISTRY.filter((e) =>
    e.obligation_ids.includes("audit_tasks_completed"),
  );
  expect(owners.length, "exactly one executor must own audit_tasks_completed").toBe(1);
  expect(owners[0].id).toBe("semantic_review_executor");
  expect(owners[0].kind).toBe("host_delegation");
});

test("S4: result_ingestion_executor is deterministic (ingestion folds inline, not a separate host pause)", () => {
  const ingestionEntry = EXECUTOR_REGISTRY.find(
    (e) => e.id === "result_ingestion_executor",
  );
  expect(ingestionEntry, "result_ingestion_executor must exist").toBeTruthy();
  expect(ingestionEntry!.kind).toBe("deterministic");
});

test("S4: after review completion, audit_results_ingested is next toward synthesis", () => {
  const bundle = settleIntentBaseline({
    ...makePostDesignReviewBundle(),
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [
      { task_id: "T1", unit_id: "U1", pass_id: "P1", lens: "security", file_paths: ["src/a.ts"], rationale: "security test", status: "complete" as const },
    ],
    requeue_tasks: [],
  });
  const decision = decideNextStep(bundle);
  const state = deriveAuditState(bundle);
  const auditTasksObl = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(auditTasksObl?.state, "audit_tasks_completed must be satisfied").toBe("satisfied");
  expect(decision.selected_obligation).toBe("audit_results_ingested");
});

test("S4: synthesis follows ingestion without an intermediate host pause between them", () => {
  // Verify PRIORITY chain: audit_results_ingested comes before synthesis_current
  const ingestionIdx = PRIORITY.indexOf("audit_results_ingested");
  const synthesisIdx = PRIORITY.indexOf("synthesis_current");
  expect(ingestionIdx >= 0, "audit_results_ingested must be in PRIORITY").toBeTruthy();
  expect(synthesisIdx >= 0, "synthesis_current must be in PRIORITY").toBeTruthy();
  expect(ingestionIdx < synthesisIdx, `audit_results_ingested (${ingestionIdx}) must precede synthesis_current (${synthesisIdx})`).toBeTruthy();

  // Both ingestion and synthesis executors are deterministic
  const ingestEntry = EXECUTOR_REGISTRY.find((e) => e.id === "result_ingestion_executor");
  const synthEntry = EXECUTOR_REGISTRY.find((e) => e.id === "synthesis_executor");
  expect(ingestEntry?.kind).toBe("deterministic");
  expect(synthEntry?.kind).toBe("deterministic");
});

// ── Scenario 5: Narrative omission ───────────────────────────────────────────

test("S5: runSynthesisNarrativeExecutor writes status='omitted' when no narrative is supplied", () => {
  const synth = runSynthesisExecutor({ audit_results: [] });
  const run = runSynthesisNarrativeExecutor(synth.updated, undefined);

  expect(run.updated.synthesis_narrative?.status, "synthesis_narrative must be status='omitted' when no narrative is supplied").toBe("omitted");
  expect(run.artifacts_written.includes("synthesis-narrative.json"), "synthesis-narrative.json must be in artifacts_written").toBeTruthy();
});

test("S5: after synthesis_narrative with status='omitted', deriveAuditState shows synthesis_narrative_current satisfied", () => {
  const synth = runSynthesisExecutor({ audit_results: [] });
  const run = runSynthesisNarrativeExecutor(synth.updated, undefined);
  const bundle = run.updated;

  const state = deriveAuditState(bundle);
  const narrativeObl = state.obligations.find(
    (o) => o.id === "synthesis_narrative_current",
  );
  expect(narrativeObl?.state, "synthesis_narrative_current must be satisfied after omitted narrative").toBe("satisfied");
});

test("S5: omitted narrative run terminates cleanly — audit_report present, synthesis is the final step", () => {
  // Start from a fully-satisfied post-synthesis bundle (all upstream obligations
  // present) so that synthesis_narrative is the only remaining obligation.
  // The key assertion: after synthesis_narrative omits, no further steps are needed.
  const synthReadyBundle: ArtifactBundle = {
    // All upstream obligations satisfied
    repo_manifest: { repository: { name: "test" }, generated_at: "2026-01-01T00:00:00Z", files: [] },
    file_disposition: { files: [] },
    auto_fixes_applied: { fixes: [] },
    syntax_resolution_status: { resolved: true },
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { status: "omitted", analyzers: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      contract_reviewed: true,
      conceptual_reviewed: true,
    },
    intent_checkpoint: makeValidCheckpoint(),
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [],
    requeue_tasks: [],
    audit_results: [],
    // Synthesis already complete
    audit_findings: {
      contract_version: "v1",
      summary: {
        finding_count: 0,
        work_block_count: 0,
        severity_breakdown: {},
        audited_file_count: 0,
        excluded_file_count: 0,
        runtime_validation_status_breakdown: {},
      },
      findings: [],
      coherence_trace: {
        normalized_items: [],
        pair_scores: [],
        eligible_candidates: [],
        merge_trace: [],
        merge_decisions: [],
        components: [],
      },
      work_blocks: [],
      work_block_seams: [],
    },
    audit_report: "# Audit Report\n\nNo findings.\n",
    // synthesis_narrative NOT yet present — that's what we're testing
  };

  const run = runSynthesisNarrativeExecutor(synthReadyBundle, undefined);
  const bundle = run.updated;

  // audit_report must be retained (from synthesis)
  expect(bundle.audit_report, "audit_report must be present").toBeTruthy();
  expect(bundle.synthesis_narrative?.status, "narrative status must be omitted").toBe("omitted");

  // After omit, synthesis_narrative_current is satisfied
  const state = deriveAuditState(bundle);
  const narrativeObl = state.obligations.find((o) => o.id === "synthesis_narrative_current");
  expect(narrativeObl?.state, "synthesis_narrative_current must be satisfied").toBe("satisfied");

  // No further obligations requiring host delegation should remain
  // (synthesis_narrative was the last host-delegation step in the pipeline)
  const postNarrativeHostObl = state.obligations.filter(
    (o) =>
      (o.state === "missing" || o.state === "stale") &&
      PRIORITY.indexOf(o.id) > PRIORITY.indexOf("synthesis_narrative_current") &&
      isHostDelegationExecutor(
        EXECUTOR_REGISTRY.find((e) => e.obligation_ids.includes(o.id))?.id ?? "",
      ),
  );
  expect(postNarrativeHostObl.length, `No host-delegation obligations should come after synthesis_narrative; found: ${postNarrativeHostObl.map((o) => o.id).join(", ")}`).toBe(0);
});

test("S5: omitted narrative does not inject narrative sections into audit-findings.json", () => {
  const synth = runSynthesisExecutor({ audit_results: [] });
  const run = runSynthesisNarrativeExecutor(synth.updated, undefined);
  const findings = run.updated.audit_findings;

  expect(findings?.themes, "themes must be absent when narrative is omitted").toBe(undefined);
  expect(findings?.executive_summary, "executive_summary must be absent when narrative is omitted").toBe(undefined);
});
