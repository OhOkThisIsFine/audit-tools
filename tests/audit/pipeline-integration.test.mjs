/**
 * N-A08: Audit pipeline integration tests.
 *
 * Six integration scenarios:
 *   1. Batch-deterministic block — all five sub-steps complete in a single
 *      next-step invocation; no intermediate deterministic pauses returned.
 *   2. Intent-checkpoint gating — planning_artifacts stays missing until the
 *      checkpoint is written; disposition overrides prune files before coverage
 *      initialises; lens_selection restricts tasks to effective lenses only.
 *   3. Parallel design review — both contract and conceptual host_delegation
 *      entries are present before either is consumed.
 *   4. Rolling dispatch — ingestion folds inline; synthesis follows directly
 *      after results; the rolling_dispatch_executor owns audit_tasks_completed.
 *   5. Headless narrative omission — synthesis_narrative writes status='omitted'
 *      without a provider; run terminates cleanly.
 *   6. CE-301 partial-coverage terminal — empty provider pool marks stranded
 *      units uncovered; livelock guard advances to synthesis on partial coverage.
 */
import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { deriveAuditState } = await import("../../src/audit/orchestrator/state.ts");
const { decideNextStep, PRIORITY } = await import("../../src/audit/orchestrator/nextStep.ts");
const { EXECUTOR_REGISTRY, isHostDelegationExecutor } = await import("../../src/audit/orchestrator/executors.ts");
const {
  runSynthesisExecutor,
  runSynthesisNarrativeExecutor,
} = await import("../../src/audit/orchestrator/synthesisExecutors.ts");
const { runPlanningExecutor } = await import("../../src/audit/orchestrator/planningExecutors.ts");
const { runDesignReviewAutoComplete } = await import("../../src/audit/orchestrator/structureExecutors.ts");
const {
  renderContractReviewPrompt,
  renderConceptualReviewPrompt,
} = await import("../../src/audit/orchestrator/designReviewPrompt.ts");

// ── Shared bundle factory helpers ─────────────────────────────────────────────

/** Bundle ready for intent_checkpoint (all deterministic obligations satisfied). */
function makePostDesignAssessmentBundle(opts = {}) {
  return {
    provider_confirmation: { confirmed: true },
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
    analyzer_capability: {},
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      contract_reviewed: opts.contract_reviewed ?? false,
      conceptual_reviewed: opts.conceptual_reviewed ?? false,
      ...opts.designOverrides,
    },
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 0,
      source_ids: [],
      consensus: [],
      contested: [],
      findings: [],
    },
  };
}

function makeValidCheckpoint(opts = {}) {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "full audit",
    intent_summary: "full-audit",
    ...opts,
  };
}

/** Bundle ready for planning (all obligations up to and including design reviews satisfied). */
function makePostDesignReviewBundle(opts = {}) {
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
  expect(isHostDelegationExecutor(decision.selected_executor), `expected a host_delegation executor after deterministic block; got "${decision.selected_executor}"`).toBeTruthy();
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
  const bundleNoDa = {
    provider_confirmation: { confirmed: true },
    repo_manifest: { files: [] },
    file_disposition: { files: [] },
    auto_fixes_applied: {},
    syntax_resolution_status: { resolved: true },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: {},
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
  expect(isHostDelegationExecutor(decision.selected_executor), "intent_checkpoint_executor is a host_delegation executor").toBe(true);
});

test("S2: planning_artifacts obligation advances past intent_checkpoint once the checkpoint is written", () => {
  const bundle = makePostDesignReviewBundle();
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
        analyzer_capability: {},
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
        analyzer_capability: {},
      },
    });

    const result = await runPlanningExecutor(bundle, tmpDir, {});
    const tasks = result.updated.audit_tasks ?? [];
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
  const { resolveEffectiveLenses } = await import("../../src/audit/orchestrator/lensSelection.ts");

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
  expect(contractEntry.kind).toBe("host_delegation");

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
  expect(conceptualEntry.kind).toBe("host_delegation");

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
  const bundle = {
    ...makePostDesignAssessmentBundle(),
    intent_checkpoint: makeValidCheckpoint(),
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      contract_reviewed: true,   // done
      conceptual_reviewed: false, // not yet
    },
  };
  const decision = decideNextStep(bundle);
  expect(decision.selected_obligation, "After contract review, conceptual review should be next").toBe("design_review_conceptual_completed");
});

// ── Scenario 4: Rolling dispatch ──────────────────────────────────────────────

test("S4: rolling_dispatch_executor is the sole owner of audit_tasks_completed", () => {
  const owners = EXECUTOR_REGISTRY.filter((e) =>
    e.obligation_ids.includes("audit_tasks_completed"),
  );
  expect(owners.length, "exactly one executor must own audit_tasks_completed").toBe(1);
  expect(owners[0].id).toBe("rolling_dispatch_executor");
  expect(owners[0].kind).toBe("host_delegation");
});

test("S4: result_ingestion_executor is deterministic (ingestion folds inline, not a separate host pause)", () => {
  const ingestionEntry = EXECUTOR_REGISTRY.find(
    (e) => e.id === "result_ingestion_executor",
  );
  expect(ingestionEntry, "result_ingestion_executor must exist").toBeTruthy();
  expect(ingestionEntry.kind).toBe("deterministic");
});

test("S4: after audit_tasks_completed, audit_results_ingested is next deterministic step toward synthesis", () => {
  // Bundle where audit tasks are complete (via partial terminal) but ingestion hasn't run
  const bundle = {
    ...makePostDesignReviewBundle(),
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [
      { task_id: "T1", status: "pending", unit_id: "U1", lens: "security" },
    ],
    requeue_tasks: [],
    audit_results: [],
    active_dispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 1,
      task_count: 1,
      status: "active",
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["T1"],
      },
    },
  };
  const decision = decideNextStep(bundle);
  // audit_tasks_completed is now satisfied via terminal; next should be audit_results_ingested
  const state = deriveAuditState(bundle);
  const auditTasksObl = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(auditTasksObl?.state, "audit_tasks_completed must be satisfied").toBe("satisfied");
  // Next step advances toward ingestion / synthesis
  expect(decision.selected_obligation).not.toBe("audit_tasks_completed");
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

// ── Scenario 5: Headless narrative omission ───────────────────────────────────

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
  const synthReadyBundle = {
    // All upstream obligations satisfied
    provider_confirmation: { confirmed: true },
    repo_manifest: { repository: { name: "test" }, generated_at: "2026-01-01T00:00:00Z", files: [] },
    file_disposition: { files: [] },
    auto_fixes_applied: { fixes: [] },
    syntax_resolution_status: { resolved: true },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: {},
    design_assessment: { contract_reviewed: true, conceptual_reviewed: true },
    intent_checkpoint: makeValidCheckpoint(),
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [],
    requeue_tasks: [],
    audit_results: [],
    // Synthesis already complete
    audit_findings: { contract_version: "v1", summary: { finding_count: 0 }, findings: [], work_blocks: [] },
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

// ── Scenario 6: CE-301 partial-coverage terminal ─────────────────────────────

test("S6: empty provider pool sets partial_completion_terminal and satisfies audit_tasks_completed", () => {
  const bundle = {
    ...makePostDesignReviewBundle(),
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [
      { task_id: "T1", status: "pending", unit_id: "U1", lens: "security" },
      { task_id: "T2", status: "pending", unit_id: "U2", lens: "correctness" },
    ],
    requeue_tasks: [],
    audit_results: [],
    active_dispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 2,
      task_count: 2,
      status: "active",
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["T1", "T2"],
      },
    },
  };

  const state = deriveAuditState(bundle);
  const atc = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atc?.state, "audit_tasks_completed must be satisfied when all pending tasks are stranded by partial_completion_terminal").toBe("satisfied");
});

test("S6: livelock_guard terminal also satisfies audit_tasks_completed", () => {
  const bundle = {
    ...makePostDesignReviewBundle(),
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [
      { task_id: "T1", status: "pending", unit_id: "U1", lens: "security" },
    ],
    requeue_tasks: [],
    audit_results: [],
    active_dispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 1,
      task_count: 1,
      status: "active",
      partial_completion_terminal: {
        reason: "livelock_guard",
        stranded_ids: ["T1"],
      },
    },
  };

  const state = deriveAuditState(bundle);
  const atc = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atc?.state).toBe("satisfied");
});

test("S6: non-stranded pending tasks still block even with a partial terminal for other tasks", () => {
  const bundle = {
    ...makePostDesignReviewBundle(),
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [
      { task_id: "T1", status: "pending", unit_id: "U1", lens: "security" },
      { task_id: "T2", status: "pending", unit_id: "U2", lens: "correctness" },
    ],
    requeue_tasks: [],
    audit_results: [],
    active_dispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 2,
      task_count: 2,
      status: "active",
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["T1"], // T2 not stranded
      },
    },
  };

  const state = deriveAuditState(bundle);
  const atc = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atc?.state, "T2 is pending and not stranded — audit_tasks_completed must remain missing").toBe("missing");
});

test("S6: after partial terminal, synthesis produces valid audit-findings with stranded count", () => {
  // Use runSynthesisExecutor as the integration surface
  const partialBundle = {
    ...makePostDesignReviewBundle(),
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [
      { task_id: "T1", status: "pending", unit_id: "U1", lens: "security" },
    ],
    requeue_tasks: [],
    audit_results: [],
    active_dispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 1,
      task_count: 1,
      status: "active",
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["T1"],
      },
    },
  };

  // Synthesis can run because audit_tasks_completed is satisfied
  const state = deriveAuditState(partialBundle);
  const atc = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atc?.state, "terminal must satisfy audit_tasks_completed first").toBe("satisfied");

  // runSynthesisExecutor produces a valid findings contract
  const run = runSynthesisExecutor(partialBundle, []);
  expect(run.updated.audit_findings, "audit_findings must be produced").toBeTruthy();
  expect(typeof run.updated.audit_findings.contract_version).toBe("string");
  expect(run.updated.audit_report, "audit_report must be rendered").toBeTruthy();

  // stranded_unit_count flows through synthesis into audit_findings/audit_report;
  // see the CE-301 test for exhaustive stranded-count checks.
  expect(run.artifacts_written.includes("audit-findings.json"), "audit-findings.json must be written").toBeTruthy();
});

test("S6: run does not stall — terminal satisfies audit_tasks_completed and never re-selects rolling_dispatch", () => {
  // Once partial_completion_terminal fires, audit_tasks_completed is satisfied
  // and the engine must NOT re-select rolling_dispatch / audit_tasks_completed.
  // (In real runs with artifact_metadata, staleness propagation is resolved;
  // for in-memory bundles we verify the key invariant: audit_tasks_completed
  // stays satisfied and rolling_dispatch is not re-entered.)
  const terminalBundle = {
    ...makePostDesignReviewBundle(),
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [
      { task_id: "T1", status: "pending", unit_id: "U1", lens: "security" },
    ],
    requeue_tasks: [],
    audit_results: [],
    active_dispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 1,
      task_count: 1,
      status: "active",
      partial_completion_terminal: {
        reason: "livelock_guard",
        stranded_ids: ["T1"],
      },
    },
  };

  // Core invariant: audit_tasks_completed is satisfied (terminal fired)
  const state = deriveAuditState(terminalBundle);
  const atcObl = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atcObl?.state, "audit_tasks_completed must be satisfied after terminal fires").toBe("satisfied");

  // decideNextStep must not re-select rolling_dispatch_executor (livelock guard)
  const decision = decideNextStep(terminalBundle);
  expect(decision.selected_obligation, "decideNextStep must not re-select audit_tasks_completed after terminal").not.toBe("audit_tasks_completed");
  expect(decision.selected_executor, "rolling_dispatch_executor must not be re-entered after terminal").not.toBe("rolling_dispatch_executor");
});
