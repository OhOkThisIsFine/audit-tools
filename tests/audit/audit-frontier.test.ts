import { test, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cmdNextStep } from "../../src/audit/cli/nextStepCommand.js";
import { writeCoreArtifacts, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { captureCompletedDesignReviews, persistDesignReviewSnapshots } from "./helpers/designReviewSnapshotFixture.js";
import type { AuditHostWorkload, AuditHostWorkItem } from "../../src/audit/cli/dispatch/hostHandoff.js";
import type { AuditTask } from "../../src/audit/types.js";
import { withTempRepo } from "./helpers/next-step-harness.js";

function deepCeilingBundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/a.ts", language: "typescript", size_bytes: 100 },
        { path: "README.md", language: "markdown", size_bytes: 100 },
      ],
    },
    file_disposition: {
      files: [
        { path: "src/a.ts", status: "included" },
        { path: "README.md", status: "doc_only" },
      ],
    },
    auto_fixes_applied: {},
    syntax_resolution_status: {},
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    external_analyzer_results: [{ tool: "eslint", results: [] }],
    unit_manifest: { units: [{ unit_id: "source", name: "Source", files: ["src/a.ts"], required_lenses: ["correctness"] }] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { items: [] },
    analyzer_capability: { coverage: "not_applicable", analyzers: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [],
      contract_findings: [],
      contract_reviewed: true,
      conceptual_findings: [],
      conceptual_reviewed: true,
    },
    docs_digest: { generated_at: "2026-01-01T00:00:00.000Z", docs: [] },
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 1,
      source_ids: ["call_import"],
      consensus: [
        {
          node_id: "src/a.ts",
          members: ["src/a.ts"],
          agreed_across_source: 1,
          stable_across_scale: 1,
          contested: false,
        },
      ],
      contested: [],
      findings: [],
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "s",
      intent_summary: "i",
      design_review: { answered_at: "2026-01-01T00:00:00Z", ceiling: { rung: "deep" } },
    },
  } as ArtifactBundle;
}

test("deep architectural inquiry publishes ready scoped inspection without leaking its evidence into blind lanes", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Fixture\nThe implementation must preserve accepted inputs.\n");
    await writeFile(join(root, "src/a.ts"), "export function accept(value: string) {\n  return value.trim();\n}\n");
    const bundle = captureCompletedDesignReviews(deepCeilingBundle());
    await writeCoreArtifacts(artifactsDir, bundle);
    await persistDesignReviewSnapshots(artifactsDir, bundle);
    await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
    const step = JSON.parse(await readFile(join(artifactsDir, "steps/current-step.json"), "utf8"));
    expect(step.step_kind).toBe("charter_extraction");
    expect(step.artifact_paths.host_workload).toBeTypeOf("string");
    const workload = JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8"));
    expect(workload.work_items.length).toBeGreaterThan(0);
    expect(workload.work_items.some((item: { scope: { files: string[] } }) => item.scope.files.includes("src/a.ts"))).toBe(true);
    const hostPrompt = await readFile(step.prompt_path, "utf8");
    expect(hostPrompt).toContain("alongside");
    // The host sees the two ready work families. Blind readers still receive
    // only their own packet, never the host's combined dispatch envelope.
    const lanePrompts = Object.entries(step.artifact_paths).filter(([key]) => key.startsWith("charter_extraction_") && key.endsWith("_prompt"));
    for (const [, path] of lanePrompts) {
      const prompt = await readFile(path as string, "utf8");
      expect(prompt).not.toContain(step.artifact_paths.host_workload);
      expect(prompt).not.toContain("audit_results.jsonl");
    }
  });
});

test("architectural discovery adds only targeted follow-up and reconciliation is replay-stable", async () => {
  const { runPlanningExecutor } = await import("../../src/audit/orchestrator/planningExecutors.js");
  const { computeArtifactMetadata } = await import("../../src/audit/orchestrator/artifactMetadata.js");
  const { computeStaleArtifacts } = await import("../../src/audit/orchestrator/staleness.js");
  await withTempRepo(async (root) => {
    const source = deepCeilingBundle();
    const initialRun = await runPlanningExecutor(source, root, { "src/a.ts": 4, "README.md": 2 });
    const initial = { ...initialRun.updated, artifact_metadata: computeArtifactMetadata(initialRun.updated) };
    const beforeIds = initial.audit_tasks!.map((task) => task.task_id);
    const discovered: ArtifactBundle = { ...initial, design_assessment: {
      ...initial.design_assessment!, contract_findings: [{
        id: "ARCH-1", title: "Input ownership can be bypassed", category: "trust_boundary_gap",
        severity: "high", confidence: "medium", lens: "correctness",
        summary: "A caller can mutate an input after validation.", affected_files: [{ path: "src/a.ts" }],
      }],
    } };
    discovered.artifact_metadata = computeArtifactMetadata(discovered, initial.artifact_metadata, ["design_assessment.json"]);
    expect(computeStaleArtifacts(discovered, { emit: false }).has("audit_tasks.json")).toBe(true);
    const reconciledRun = await runPlanningExecutor(discovered, root, { "src/a.ts": 4, "README.md": 2 });
    const reconciled = { ...reconciledRun.updated, artifact_metadata: computeArtifactMetadata(
      reconciledRun.updated, discovered.artifact_metadata, reconciledRun.artifacts_written) };
    const additions = reconciled.audit_tasks!.filter((task) => !beforeIds.includes(task.task_id));
    expect(additions).toHaveLength(1);
    expect(additions[0]!.file_paths).toEqual(["src/a.ts"]);
    expect(additions[0]!.rationale).toContain("ARCH-1");
    expect(computeStaleArtifacts(reconciled, { emit: false }).has("audit_tasks.json")).toBe(false);
    const replay = (await runPlanningExecutor(reconciled, root, { "src/a.ts": 4, "README.md": 2 })).updated;
    expect(replay.audit_tasks!.map((task) => task.task_id)).toEqual(reconciled.audit_tasks!.map((task) => task.task_id));
  });
});

test("every input of the stored architecture-discovery tasks stales audit_tasks.json through the staleness DAG", async () => {
  const { runPlanningExecutor } = await import("../../src/audit/orchestrator/planningExecutors.js");
  const { computeArtifactMetadata } = await import("../../src/audit/orchestrator/artifactMetadata.js");
  const { computeStaleArtifacts } = await import("../../src/audit/orchestrator/staleness.js");
  await withTempRepo(async (root) => {
    const run = await runPlanningExecutor(deepCeilingBundle(), root, { "src/a.ts": 4, "README.md": 2 });
    const planned: ArtifactBundle = { ...run.updated, artifact_metadata: computeArtifactMetadata(run.updated) };
    expect(computeStaleArtifacts(planned, { emit: false }).has("audit_tasks.json")).toBe(false);
    const finding = { id: "ARCH-1", title: "Input ownership can be bypassed", category: "trust_boundary_gap",
      severity: "high" as const, confidence: "medium" as const, lens: "correctness", systemic: true,
      summary: "A caller can mutate an input after validation.", affected_files: [{ path: "src/a.ts" }] };
    const inputChanges: Record<string, Partial<ArtifactBundle>> = {
      "design_assessment.json": { design_assessment: { ...planned.design_assessment!, contract_findings: [finding] } },
      "charter_register.json": { charter_register: { findings: [finding] } as unknown as ArtifactBundle["charter_register"] },
      "charter_clarification.json": { charter_clarification: { asked: [{ request_id: "q1" }] } as unknown as ArtifactBundle["charter_clarification"] },
      "systemic_challenge.json": { systemic_challenge: { findings: [finding] } as unknown as ArtifactBundle["systemic_challenge"] },
      "audit_results.jsonl": { audit_results: [{ task_id: "source:correctness", unit_id: "source", pass_id: "base", lens: "correctness",
        file_coverage: [{ path: "src/a.ts", total_lines: 4 }], findings: [finding] }] },
    };
    for (const [artifact, change] of Object.entries(inputChanges)) {
      const changed: ArtifactBundle = { ...planned, ...change };
      changed.artifact_metadata = computeArtifactMetadata(changed, planned.artifact_metadata, [artifact]);
      expect(computeStaleArtifacts(changed, { emit: false }).has("audit_tasks.json"), artifact).toBe(true);
    }
  });
});

test("result ingestion stamps audit_tasks.json only with the discovery family its ingested ledger derives", async () => {
  const { runPlanningExecutor } = await import("../../src/audit/orchestrator/planningExecutors.js");
  const { runResultIngestionExecutor } = await import("../../src/audit/orchestrator/ingestionExecutors.js");
  const { architectureDiscoveryTasks, isArchitectureDiscoveryTask } = await import("../../src/audit/orchestrator/architectureDiscovery.js");
  await withTempRepo(async (root) => {
    // A discovery task's own result never earns a selective-deepening follow-up,
    // so a novel discovery it reports is planned only by the discovery family.
    const source = deepCeilingBundle();
    source.design_assessment!.contract_findings = [{ id: "ARCH-1", title: "Input ownership can be bypassed",
      category: "trust_boundary_gap", severity: "high", confidence: "medium", lens: "correctness",
      summary: "A caller can mutate an input after validation.", affected_files: [{ path: "src/a.ts" }] }];
    const planned = (await runPlanningExecutor(source, root, { "src/a.ts": 4, "README.md": 2 })).updated;
    const issued = planned.audit_tasks!.filter(isArchitectureDiscoveryTask);
    expect(issued).toHaveLength(1);
    const ingested = runResultIngestionExecutor(planned, [{
      task_id: issued[0]!.task_id, unit_id: issued[0]!.unit_id, pass_id: issued[0]!.pass_id, lens: issued[0]!.lens,
      file_coverage: [{ path: "src/a.ts", total_lines: 4 }], findings: [{ id: "SYS-1", title: "Unbounded cross-system retry",
        category: "correctness", severity: "high", confidence: "medium", lens: "correctness", systemic: true,
        summary: "Retries across the boundary never terminate.", affected_files: [{ path: "src/a.ts" }] }],
    }]).updated;
    const stored = ingested.audit_tasks!.filter(isArchitectureDiscoveryTask);
    expect(stored.map((task) => task.task_id)).toEqual(architectureDiscoveryTasks(ingested).map((task) => task.task_id));
    expect(stored).toHaveLength(2);
    // The issued task keeps its binding and its ingested completion.
    expect(stored.find((task) => task.task_id === issued[0]!.task_id)!.status).toBe("complete");
  });
});

async function plannedWithDiscovery(root: string, withDesignFinding: boolean): Promise<ArtifactBundle> {
  const { runPlanningExecutor } = await import("../../src/audit/orchestrator/planningExecutors.js");
  const { computeArtifactMetadata } = await import("../../src/audit/orchestrator/artifactMetadata.js");
  const source = deepCeilingBundle();
  if (withDesignFinding) source.design_assessment!.contract_findings = [ARCH_FINDING];
  const run = await runPlanningExecutor(source, root, { "src/a.ts": 4, "README.md": 2 });
  return { ...run.updated, artifact_metadata: computeArtifactMetadata(run.updated) };
}

const ARCH_FINDING = { id: "ARCH-1", title: "Input ownership can be bypassed", category: "trust_boundary_gap",
  severity: "high" as const, confidence: "medium" as const, lens: "correctness",
  summary: "A caller can mutate an input after validation.", affected_files: [{ path: "src/a.ts" }] };

test("an advanceAudit ingestion leaves audit_tasks.json fresh with the discovery family its ledger derives", async () => {
  const { advanceAudit } = await import("../../src/audit/orchestrator/advance.js");
  const { computeStaleArtifacts } = await import("../../src/audit/orchestrator/staleness.js");
  const { architectureDiscoveryTasks, isArchitectureDiscoveryTask } = await import("../../src/audit/orchestrator/architectureDiscovery.js");
  await withTempRepo(async (root) => {
    const planned = await plannedWithDiscovery(root, true);
    const issued = planned.audit_tasks!.filter(isArchitectureDiscoveryTask)[0]!;
    const advanced = (await advanceAudit(planned, { root, preferredExecutor: "result_ingestion_executor", auditResults: [{
      task_id: issued.task_id, unit_id: issued.unit_id, pass_id: issued.pass_id, lens: issued.lens,
      file_coverage: [{ path: "src/a.ts", total_lines: 4 }], findings: [{ id: "SYS-1", title: "Unbounded cross-system retry",
        category: "correctness", severity: "high", confidence: "medium", lens: "correctness", systemic: true,
        summary: "Retries across the boundary never terminate.", affected_files: [{ path: "src/a.ts" }] }],
    }] })).updated_bundle;
    expect(computeStaleArtifacts(advanced, { emit: false }).has("audit_tasks.json")).toBe(false);
    const stored = advanced.audit_tasks!.filter(isArchitectureDiscoveryTask).map((task) => task.task_id);
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(architectureDiscoveryTasks(advanced).map((task) => task.task_id));
  });
});

test("a runtime-validation rewrite of audit_tasks.json carries the discovery family a pending input derives", async () => {
  const { advanceAudit } = await import("../../src/audit/orchestrator/advance.js");
  const { computeArtifactMetadata } = await import("../../src/audit/orchestrator/artifactMetadata.js");
  const { computeStaleArtifacts } = await import("../../src/audit/orchestrator/staleness.js");
  const { architectureDiscoveryTasks, isArchitectureDiscoveryTask } = await import("../../src/audit/orchestrator/architectureDiscovery.js");
  await withTempRepo(async (root) => {
    const planned = await plannedWithDiscovery(root, false);
    const base = planned.audit_tasks!.find((task) => task.lens === "correctness" && task.file_paths.includes("src/a.ts"))!;
    // A discovery input moved (awaiting replan) and a high-severity result is on
    // the ledger, so the runtime-validation pass deepens and rewrites the tasks.
    const pending: ArtifactBundle = { ...planned,
      design_assessment: { ...planned.design_assessment!, contract_findings: [ARCH_FINDING] },
      audit_results: [{ task_id: base.task_id, unit_id: base.unit_id, pass_id: base.pass_id, lens: base.lens,
        file_coverage: [{ path: "src/a.ts", total_lines: 4 }], findings: [{ id: "BASE-1", title: "Invalid local input",
          category: "correctness", severity: "high", confidence: "medium", lens: "correctness",
          summary: "A local branch accepts invalid input.", affected_files: [{ path: "src/a.ts" }] }] }] };
    pending.artifact_metadata = computeArtifactMetadata(pending, planned.artifact_metadata, ["design_assessment.json", "audit_results.jsonl"]);
    expect(computeStaleArtifacts(pending, { emit: false }).has("audit_tasks.json")).toBe(true);
    const result = await advanceAudit(pending, { root, preferredExecutor: "runtime_validation_update_executor",
      runtimeValidationUpdates: { results: [] } });
    expect(result.artifacts_written).toContain("audit_tasks.json");
    const advanced = result.updated_bundle;
    const stored = advanced.audit_tasks!.filter(isArchitectureDiscoveryTask).map((task) => task.task_id);
    expect(stored).toHaveLength(1);
    expect(stored).toEqual(architectureDiscoveryTasks(advanced).map((task) => task.task_id));
    expect(computeStaleArtifacts(advanced, { emit: false }).has("audit_tasks.json")).toBe(false);
  });
});

test("a late discovery input defers audit_tasks.json while pending and stales it only when its content moves", async () => {
  const { computeArtifactMetadata } = await import("../../src/audit/orchestrator/artifactMetadata.js");
  const { computeStaleArtifacts } = await import("../../src/audit/orchestrator/staleness.js");
  await withTempRepo(async (root) => {
    const planned = await plannedWithDiscovery(root, false);
    const withSystemic: ArtifactBundle = { ...planned,
      conceptual_review_adjudication: { verdicts: [] } as unknown as ArtifactBundle["conceptual_review_adjudication"],
      systemic_challenge: { findings: [] } as unknown as ArtifactBundle["systemic_challenge"] };
    withSystemic.artifact_metadata = computeArtifactMetadata(withSystemic);
    expect(computeStaleArtifacts(withSystemic, { emit: false }).has("audit_tasks.json")).toBe(false);
    // An upstream of systemic_challenge moves: it is pending, and planning —
    // scheduled before it — cannot clear that, so audit_tasks is deferred.
    const pending: ArtifactBundle = { ...withSystemic,
      conceptual_review_adjudication: { verdicts: ["moved"] } as unknown as ArtifactBundle["conceptual_review_adjudication"] };
    pending.artifact_metadata = computeArtifactMetadata(pending, withSystemic.artifact_metadata, ["conceptual_review_adjudication.json"]);
    const deferred = computeStaleArtifacts(pending, { emit: false });
    expect(deferred.has("systemic_challenge.json")).toBe(true);
    expect(deferred.has("audit_tasks.json")).toBe(false);
    expect([...deferred.deferred]).toContain("audit_tasks.json");
    // The systemic pass re-derives the same findings: a revision-only move.
    const unchanged: ArtifactBundle = { ...pending };
    unchanged.artifact_metadata = computeArtifactMetadata(unchanged, pending.artifact_metadata, ["systemic_challenge.json"]);
    expect(unchanged.artifact_metadata.artifacts["systemic_challenge.json"]!.revision)
      .toBeGreaterThan(pending.artifact_metadata.artifacts["systemic_challenge.json"]!.revision);
    expect(computeStaleArtifacts(unchanged, { emit: false }).has("audit_tasks.json")).toBe(false);
    // It re-derives a new finding: discovery's input moved, so planning re-runs.
    const moved: ArtifactBundle = { ...pending,
      systemic_challenge: { findings: [ARCH_FINDING] } as unknown as ArtifactBundle["systemic_challenge"] };
    moved.artifact_metadata = computeArtifactMetadata(moved, pending.artifact_metadata, ["systemic_challenge.json"]);
    expect(computeStaleArtifacts(moved, { emit: false }).has("audit_tasks.json")).toBe(true);
  });
});

test("a named interpretation dependency holds only its task, never same-file evidence gathering", async () => {
  const { derivePendingTaskPartition } = await import("../../src/audit/orchestrator/pendingTasks.js");
  const base = { task_id: "base", unit_id: "source", pass_id: "base", lens: "correctness", file_paths: ["src/a.ts"], rationale: "Inspect behavior", status: "pending" as const };
  const bundle: ArtifactBundle = {
    audit_tasks: [base, { ...base, task_id: "interpretation", tags: ["requires_question:q1"] }],
    charter_clarification: { asked: [{ request_id: "q1" }] } as ArtifactBundle["charter_clarification"],
  };
  expect(derivePendingTaskPartition(bundle).readyTasks.map((task) => task.task_id)).toEqual(["base"]);
  expect(derivePendingTaskPartition(bundle).heldTasks.map((task) => task.task_id)).toEqual(["interpretation"]);
  bundle.charter_clarification!.asked[0]!.answer = "leave_open";
  expect(derivePendingTaskPartition(bundle).readyTasks).toHaveLength(2);
});

test("a temporarily empty ready frontier does not close a wave with held work", async () => {
  const { prepareAuditHostHandoff } = await import("../../src/audit/cli/dispatch/hostHandoff.js");
  const { reviewWaveClosedPath } = await import("../../src/audit/io/runArtifacts.js");
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await prepareAuditHostHandoff({ root, artifactsDir, runId: "held-wave", tasks: [], pendingTaskCount: 1 });
    expect(JSON.parse(await readFile(reviewWaveClosedPath(artifactsDir, "held-wave"), "utf8")).closed).toBe(false);
    await prepareAuditHostHandoff({ root, artifactsDir, runId: "held-wave", tasks: [], pendingTaskCount: 0 });
    expect(JSON.parse(await readFile(reviewWaveClosedPath(artifactsDir, "held-wave"), "utf8")).closed).toBe(true);
  });
});

test("concrete scoped discoveries cause targeted architectural inquiry without staling broad review", async () => {
  const { architectureDiscoveryTasks } = await import("../../src/audit/orchestrator/architectureDiscovery.js");
  const { projectDesignReviewTask } = await import("../../src/audit/orchestrator/designReviewTask.js");
  const before = deepCeilingBundle();
  const bundle: ArtifactBundle = { ...before, audit_results: [{
    task_id: "source:correctness", unit_id: "source", pass_id: "base", lens: "correctness",
    file_coverage: [{ path: "src/a.ts", total_lines: 4 }], findings: [{
      id: "SCOPED-1", title: "Shared input ownership", category: "correctness", severity: "high", confidence: "medium",
      lens: "correctness", systemic: true, summary: "The API and its consumer assume incompatible ownership.", affected_files: [{ path: "src/a.ts" }],
    }],
  }] };
  expect(architectureDiscoveryTasks(bundle, { "src/a.ts": 4 })).toHaveLength(1);
  expect(architectureDiscoveryTasks(bundle)[0]!.rationale).toContain("cross-system");
  expect(projectDesignReviewTask(bundle, "conceptual")).toEqual(projectDesignReviewTask(before, "conceptual"));
});

test("a novel follow-up discovery earns one task while an echo does not", async () => {
  const { architectureDiscoveryTasks } = await import("../../src/audit/orchestrator/architectureDiscovery.js");
  const source = { id: "A", title: "Wrong ownership", category: "architecture", severity: "high" as const, confidence: "medium" as const,
    lens: "correctness", systemic: true, summary: "Input mutation bypasses validation.", affected_files: [{ path: "src/a.ts" }] };
  const bundle: ArtifactBundle = { ...deepCeilingBundle(), audit_results: [{
    task_id: "base", unit_id: "source", pass_id: "base", lens: "correctness",
    file_coverage: [{ path: "src/a.ts", total_lines: 4 }], findings: [source],
  }] };
  const first = architectureDiscoveryTasks(bundle, { "src/a.ts": 4 });
  expect(first).toHaveLength(1);
  bundle.audit_tasks = first;
  bundle.audit_results!.push({ task_id: first[0]!.task_id, unit_id: first[0]!.unit_id, pass_id: first[0]!.pass_id, lens: "correctness",
    file_coverage: [{ path: "src/a.ts", total_lines: 4 }], findings: [
      { ...source, id: "echo-A", summary: "The same ownership mistake explained again." },
      { ...source, id: "B", title: "Unbounded cross-system retry", summary: "Retries across boundaries never terminate." },
    ] });
  const next = architectureDiscoveryTasks(bundle, { "src/a.ts": 4 });
  expect(next).toHaveLength(2);
  expect(next.filter((task) => task.task_id === first[0]!.task_id)).toHaveLength(1);
});

test("exported findings retain current contradictory follow-up evidence and exclude stale corroboration", async () => {
  const { architectureDiscoveryTasks } = await import("../../src/audit/orchestrator/architectureDiscovery.js");
  const { runResultIngestionExecutor } = await import("../../src/audit/orchestrator/ingestionExecutors.js");
  const { runSynthesisExecutor } = await import("../../src/audit/orchestrator/synthesisExecutors.js");
  const source: ArtifactBundle = deepCeilingBundle();
  source.repo_manifest!.files[0]!.hash = "source-version-one";
  source.design_assessment!.contract_findings = [{
    id: "A", title: "Ownership is unchecked", category: "inferred_contract_gap", severity: "high", confidence: "medium",
    lens: "correctness", summary: "Caller mutation reaches the owner.", affected_files: [{ path: "src/a.ts" }],
  }];
  source.coverage_matrix = { files: [] } as unknown as ArtifactBundle["coverage_matrix"];
  source.audit_tasks = architectureDiscoveryTasks(source, { "src/a.ts": 4 });
  const { computeArtifactMetadata } = await import("../../src/audit/orchestrator/artifactMetadata.js");
  source.artifact_metadata = computeArtifactMetadata(source);
  const task = source.audit_tasks[0]!;
  const accepted = runResultIngestionExecutor(source, [{
    task_id: task.task_id, unit_id: task.unit_id, pass_id: task.pass_id, lens: task.lens,
    file_coverage: [{ path: "src/a.ts", total_lines: 4 }], findings: [{
      id: "counterexample", title: "Ownership boundary has defensive copying", category: "counterevidence", severity: "info", confidence: "high",
      lens: "correctness", summary: "The defensive copy contradicts the original allegation; the claim is unresolved.",
      affected_files: [{ path: "src/a.ts" }], evidence: ["The boundary clones the supplied input."],
    }],
  }]).updated;
  const report = runSynthesisExecutor(accepted, undefined, { auditRead: null }).updated.audit_findings!;
  const original = report.findings.find((finding) => finding.title === "Ownership is unchecked")!;
  expect(original.verification_status).toBe("asserted");
  expect(original.evidence?.join("\n")).toContain("defensive copy contradicts");
  const revised: ArtifactBundle = { ...accepted, repo_manifest: { ...accepted.repo_manifest!, files: accepted.repo_manifest!.files.map((file) =>
    file.path === "src/a.ts" ? { ...file, hash: "source-version-two" } : file) } };
  const staleReport = runSynthesisExecutor(revised, undefined, { auditRead: null }).updated.audit_findings!;
  expect(staleReport.findings.find((finding) => finding.title === "Ownership is unchecked")!.evidence?.join("\n") ?? "").not.toContain("Independent follow-up");
});

async function startConcurrentAudit(root: string) {
  const artifactsDir = join(root, ".audit-tools", "audit");
  await writeFile(join(root, "README.md"), "# Fixture\nPreserve caller input.\n");
  await writeFile(join(root, "src/a.ts"), "export function accept(value: string) {\n  return value.trim();\n}\n");
  const source = captureCompletedDesignReviews(deepCeilingBundle());
  await writeCoreArtifacts(artifactsDir, source);
  await persistDesignReviewSnapshots(artifactsDir, source);
  await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
  const readStep = async () => JSON.parse(await readFile(join(artifactsDir, "steps/current-step.json"), "utf8"));
  const step = await readStep();
  const workload: AuditHostWorkload = JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8"));
  const tasks: AuditTask[] = JSON.parse(await readFile(step.artifact_paths.pending_audit_tasks, "utf8"));
  return { artifactsDir, step, workload, tasks, readStep };
}

async function writeEmptyBoundResult(root: string, workload: AuditHostWorkload, item: AuditHostWorkItem, tasks: AuditTask[]) {
  const task = tasks.find((candidate) => candidate.task_id === item.id)!;
  await writeFile(resolve(root, item.result_path), JSON.stringify({
    contract_version: "audit-host-result/v1alpha1", result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`,
    run_id: workload.run_id, work_item_id: item.id, prompt_sha256: item.prompt.sha256,
    findings: [], file_coverage: item.scope.files.map((path) => ({
      path, reviewed_lines: task.file_line_counts![path], total_lines: task.file_line_counts![path],
    })),
  }));
}

test("an unchanged in-flight binding survives discovery refresh and ingests before architecture completes", async () => {
  const { loadArtifactBundle } = await import("../../src/audit/io/artifacts.js");
  const { computeArtifactMetadata } = await import("../../src/audit/orchestrator/artifactMetadata.js");
  await withTempRepo(async (root) => {
    const initial = await startConcurrentAudit(root);
    const item = initial.workload.work_items.find((candidate) => candidate.scope.files.includes("src/a.ts"))!;
    const bundle = await loadArtifactBundle(initial.artifactsDir);
    bundle.design_assessment!.contract_findings = [{
      id: "A", title: "Ownership mismatch", category: "inferred_contract_gap", severity: "high", confidence: "medium",
      lens: "correctness", summary: "Independent architecture evidence requires a focused check.", affected_files: [{ path: "src/a.ts" }],
    }];
    bundle.artifact_metadata = computeArtifactMetadata(bundle, bundle.artifact_metadata, ["design_assessment.json"]);
    await writeCoreArtifacts(initial.artifactsDir, bundle);
    await cmdNextStep(["--root", root, "--artifacts-dir", initial.artifactsDir]);
    const next = await initial.readStep();
    const refreshed: AuditHostWorkload = JSON.parse(await readFile(next.artifact_paths.host_workload, "utf8"));
    expect(refreshed.run_id).toBe(initial.workload.run_id);
    expect(refreshed.work_items.find((candidate) => candidate.id === item.id)).toEqual(item);
    expect(refreshed.work_items.length).toBeGreaterThan(initial.workload.work_items.length);
    await writeEmptyBoundResult(root, initial.workload, item, initial.tasks);
    await cmdNextStep(["--root", root, "--artifacts-dir", initial.artifactsDir]);
    const accepted = await loadArtifactBundle(initial.artifactsDir);
    expect(accepted.audit_results?.some((result) => result.task_id === item.id)).toBe(true);
    expect((await initial.readStep()).step_kind).toBe("charter_extraction");
  });
});

test("a changed source revision explicitly refuses the old prompt-bound result", async () => {
  const { loadArtifactBundle } = await import("../../src/audit/io/artifacts.js");
  const { prepareSemanticReviewWorkload } = await import("../../src/audit/cli/semanticReviewStep.js");
  const { ingestAuditHostResults } = await import("../../src/audit/cli/dispatch/hostHandoff.js");
  const { loadCurrentActiveReviewRun } = await import("../../src/audit/cli/reviewRun.js");
  await withTempRepo(async (root) => {
    const initial = await startConcurrentAudit(root);
    const item = initial.workload.work_items.find((candidate) => candidate.scope.files.includes("src/a.ts"))!;
    await writeEmptyBoundResult(root, initial.workload, item, initial.tasks);
    const bundle = await loadArtifactBundle(initial.artifactsDir);
    bundle.repo_manifest!.files.find((file) => file.path === "src/a.ts")!.hash = "new-source-revision";
    const { handoff } = await prepareSemanticReviewWorkload({ root, artifactsDir: initial.artifactsDir,
      bundle, activeReviewRun: (await loadCurrentActiveReviewRun(initial.artifactsDir))!,
    });
    expect(handoff.workload.work_items.find((candidate) => candidate.id === item.id)!.prompt.sha256).not.toBe(item.prompt.sha256);
    const ingested = await ingestAuditHostResults({ root, artifactsDir: initial.artifactsDir,
      runId: initial.workload.run_id, auditTasks: bundle.audit_tasks!,
    });
    expect(ingested.accepted_results.some((result) => result.task_id === item.id)).toBe(false);
    expect(ingested.issues.some((issue) => issue.work_item_id === item.id)).toBe(true);
  });
});

test("an existing same-question finding follow-up is reused without mutating its binding", async () => {
  const { architectureDiscoveryTasks } = await import("../../src/audit/orchestrator/architectureDiscovery.js");
  const { buildFindingFollowupTask } = await import("../../src/audit/orchestrator/selectiveDeepening/findingFollowup.js");
  const source: ArtifactBundle = deepCeilingBundle();
  source.repo_manifest!.files[0]!.hash = "source-one";
  const base: AuditTask = { task_id: "base", unit_id: "source", pass_id: "base", lens: "correctness",
    file_paths: ["src/a.ts"], file_line_counts: { "src/a.ts": 4 }, inputs: { "source:src/a.ts": "source-one" }, rationale: "Inspect the source" };
  const finding = { id: "A", title: "Cross-system ownership", category: "correctness", severity: "high" as const,
    confidence: "medium" as const, lens: "correctness", systemic: true, summary: "Shared input changes after validation.", affected_files: [{ path: "src/a.ts" }] };
  const result = { task_id: base.task_id, unit_id: base.unit_id, pass_id: base.pass_id, lens: base.lens,
    file_coverage: [{ path: "src/a.ts", total_lines: 4 }], findings: [finding] };
  const pending = buildFindingFollowupTask({ result, task: base, finding, triggers: ["high_severity"], lineIndex: { "src/a.ts": 4 } });
  const before = JSON.stringify(pending);
  source.audit_tasks = [base, pending];
  source.audit_results = [result];
  expect(architectureDiscoveryTasks(source, { "src/a.ts": 4 })).toEqual([]);
  expect(JSON.stringify(pending)).toBe(before);
});

test("reissued discovery work supersedes old findings after its source revision changes", async () => {
  const { architectureDiscoveryTasks } = await import("../../src/audit/orchestrator/architectureDiscovery.js");
  const { runResultIngestionExecutor } = await import("../../src/audit/orchestrator/ingestionExecutors.js");
  const { computeArtifactMetadata } = await import("../../src/audit/orchestrator/artifactMetadata.js");
  const { selectCurrentResults } = await import("../../src/audit/orchestrator/ledger.js");
  const source = deepCeilingBundle();
  source.repo_manifest!.files[0]!.hash = "version-one";
  source.coverage_matrix = { files: [] } as unknown as ArtifactBundle["coverage_matrix"];
  source.design_assessment!.contract_findings = [{ id: "A", title: "Ownership mismatch", category: "inferred_contract_gap",
    severity: "high", confidence: "medium", lens: "correctness", summary: "Check ownership transfer.", affected_files: [{ path: "src/a.ts" }] }];
  source.audit_tasks = architectureDiscoveryTasks(source, { "src/a.ts": 4 });
  source.artifact_metadata = computeArtifactMetadata(source);
  const task = source.audit_tasks[0]!;
  const result = { task_id: task.task_id, unit_id: task.unit_id, pass_id: task.pass_id, lens: task.lens,
    file_coverage: [{ path: "src/a.ts", total_lines: 4 }], findings: [{ id: "old", title: "Old-source concern", category: "correctness",
      severity: "info" as const, confidence: "medium" as const, lens: "correctness", summary: "Only true in source version one.", affected_files: [{ path: "src/a.ts" }] }] };
  const first = runResultIngestionExecutor(source, [result]).updated;
  first.repo_manifest!.files[0]!.hash = "version-two";
  first.audit_tasks = architectureDiscoveryTasks(first, { "src/a.ts": 4 });
  const second = runResultIngestionExecutor(first, [{ ...result, findings: [], reviewed_clean: true }]).updated;
  expect(second.audit_results).toHaveLength(2);
  expect(selectCurrentResults(second.audit_results!).find((item) => item.task_id === task.task_id)!.findings).toEqual([]);
  const replay = runResultIngestionExecutor(second, [{ ...result, findings: [], reviewed_clean: true }]).updated;
  expect(replay.audit_results).toHaveLength(2);
  replay.repo_manifest!.files[0]!.hash = "version-three";
  replay.audit_tasks = architectureDiscoveryTasks(replay, { "src/a.ts": 4 });
  const third = runResultIngestionExecutor(replay, [{ ...result, findings: [], reviewed_clean: true }]).updated;
  expect(third.audit_results).toHaveLength(3);
  expect(selectCurrentResults(third.audit_results!).find((item) => item.task_id === task.task_id)!.attempt).toBe(2);
});

test("ordinary finding follow-up is reissued after its source changes and supersedes its old result", async () => {
  const { runPlanningExecutor } = await import("../../src/audit/orchestrator/planningExecutors.js");
  const { runResultIngestionExecutor } = await import("../../src/audit/orchestrator/ingestionExecutors.js");
  const { derivePendingTaskPartition } = await import("../../src/audit/orchestrator/pendingTasks.js");
  const { selectCurrentResults } = await import("../../src/audit/orchestrator/ledger.js");
  await withTempRepo(async root => {
    const source = deepCeilingBundle();
    source.repo_manifest!.files[0]!.hash = "version-one";
    const planned = (await runPlanningExecutor(source, root, { "src/a.ts": 4, "README.md": 2 })).updated;
    const base = planned.audit_tasks!.find(task => task.lens === "correctness" && task.file_paths.includes("src/a.ts"))!;
    const baseResult = {
      task_id: base.task_id, unit_id: base.unit_id, pass_id: base.pass_id, lens: base.lens,
      file_coverage: [{ path: "src/a.ts", total_lines: 4 }],
      findings: [{ id: "BASE-1", title: "Invalid local input", category: "correctness", severity: "high" as const,
        confidence: "medium" as const, lens: "correctness", summary: "A local branch accepts invalid input.", affected_files: [{ path: "src/a.ts" }] }],
    };
    const deepened = runResultIngestionExecutor(planned, [baseResult]).updated;
    const followup = deepened.audit_tasks!.find(task => task.tags?.includes("finding:BASE-1"))!;
    expect(followup).toBeDefined();
    expect(followup.tags).not.toContain("architecture_discovery");
    const followupResult = {
      task_id: followup.task_id, unit_id: followup.unit_id, pass_id: followup.pass_id, lens: followup.lens,
      file_coverage: [{ path: "src/a.ts", total_lines: 4 }],
      findings: [{ ...baseResult.findings[0]!, id: "FOLLOWUP-1", severity: "info" as const, title: "Old-source evidence" }],
    };
    const accepted = runResultIngestionExecutor(deepened, [followupResult]).updated;
    expect(derivePendingTaskPartition(accepted).pendingTasks.some(task => task.task_id === followup.task_id)).toBe(false);

    accepted.repo_manifest!.files[0]!.hash = "version-two";
    const replanned = (await runPlanningExecutor(accepted, root, { "src/a.ts": 4, "README.md": 2 })).updated;
    const reissued = replanned.audit_tasks!.find(task => task.task_id === followup.task_id)!;
    expect(reissued.inputs?.["source:src/a.ts"]).toBe("version-two");
    expect(derivePendingTaskPartition(replanned).staleResultTaskIds.has(followup.task_id)).toBe(true);
    expect(derivePendingTaskPartition(replanned).readyTasks.some(task => task.task_id === followup.task_id)).toBe(true);

    const repairedResult = { ...followupResult, findings: [], reviewed_clean: true };
    const refreshed = runResultIngestionExecutor(replanned, [repairedResult]).updated;
    const current = selectCurrentResults(refreshed.audit_results!).find(result => result.task_id === followup.task_id)!;
    expect(current.findings).toEqual([]);
    expect(current.emit_source).toBe("redispatch");
    expect(current.attempt).toBe(1);
    expect(refreshed.audit_results!.filter(result => result.task_id === followup.task_id)).toHaveLength(2);
    expect(derivePendingTaskPartition(refreshed).pendingTasks.some(task => task.task_id === followup.task_id)).toBe(false);
    const replay = runResultIngestionExecutor(refreshed, [repairedResult]).updated;
    expect(replay.audit_results!.filter(result => result.task_id === followup.task_id)).toHaveLength(2);
  });
});
