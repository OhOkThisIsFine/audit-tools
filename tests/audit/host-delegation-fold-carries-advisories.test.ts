// N1 (A2 re-review F1-1): in `runHostDelegationObligation`, when the same fold
// ingests results for still-pending tasks, it returned `{ kind: "transition" }`
// through the result-ingestion path BEFORE the semantic_review emission that
// spreads `validationWarnings`/`ingestIssues` — so in the dominant live flow
// (a host that writes results one at a time) the advisory warnings and any
// classified ingest issues from that fold were silently dropped from the
// emitted step. The contract under test: a fold that accepts a warning-only
// result whose task is still pending must carry that fold's advisories onto the
// NEXT emitted step, so the host is told what was accepted-with-warning instead
// of receiving an identical workload with no statement of it.
//
// Driven through `cmdNextStep` — the real CLI path, whose emission is what
// materializes the host workload and renders the prompt — with every
// pre-planning obligation pre-satisfied so both calls land on the
// semantic-review dispatch.
//
// Kept to the ONE recorder invariant: `recordHostResultOutcomes` stays the only
// ledger writer, and a warning never becomes a rejection.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** The manifest hash convention (hashContent): sha256 over utf8 bytes. */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const TASK = {
  task_id: "task-a",
  unit_id: "unit-task-a",
  pass_id: "pass:correctness",
  lens: "correctness",
  file_paths: ["src/a.ts"],
  rationale: "Review src/a.ts",
};

/** cmdNextStep logs the step contract on stdout; silence it like the harnesses do. */
async function callNextStep(root: string, artifactsDir: string): Promise<unknown> {
  const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalStderr = process.stderr.write.bind(process.stderr);
  console.log = () => {};
  console.warn = () => {};
  process.stderr.write = () => true;
  try {
    await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    process.stderr.write = originalStderr;
  }
  return JSON.parse(
    await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
  );
}

/**
 * Drive next-step past the scripted host pauses (analyzer consent/install,
 * intent confirmation…) with the SHARED walker, stopping at dispatch_review.
 * The pauses are incidental to this test — only the dispatch emission matters.
 */
async function advanceToDispatchReview(root: string, artifactsDir: string) {
  const { walkStepsUntilTerminal } = await import("./helpers/step-driver.js");
  return walkStepsUntilTerminal({
    transport: () => callNextStep(root, artifactsDir),
    terminalKinds: new Set(["dispatch_review"]),
    label: "fold-advisory",
  });
}

async function setup() {
  const { ensureSupervisorDirs } = await import(
    "../../src/audit/io/runArtifacts.js"
  );
  const { GATE_LANES, laneSubmissionPath } = await import(
    "../../src/audit/cli/laneSubmissions.js"
  );
  const { submissionsDir } = await import(
    "../../src/shared/io/auditToolsPaths.js"
  );
  const root = await mkdtemp(join(tmpdir(), "audit-fold-advisory-"));
  cleanupRoots.push(root);
  const artifactsDir = join(root, ".audit-tools", "audit");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  // Real files on disk: the fold's file-integrity preamble re-checks every
  // pending task file against the manifest hashes, and an empty repo re-triggers
  // intake (which refuses a repo with no auditable files).
  const fileA = "one\ntwo\n";
  const fileB = "one\ntwo\n";
  await writeFile(join(root, "src", "a.ts"), fileA, "utf8");
  await writeFile(join(root, "src", "b.ts"), fileB, "utf8");
  await ensureSupervisorDirs(artifactsDir);

  // Pre-satisfy the critical-flow fallback host gate (as batch-deterministic-
  // block does): this minimal fixture's flow inference falls below the
  // confidence bar, and the drain would otherwise halt there instead of
  // reaching the semantic-review dispatch under test.
  await mkdir(submissionsDir(artifactsDir), { recursive: true });
  await writeFile(
    laneSubmissionPath(artifactsDir, GATE_LANES.critical_flow_fallback),
    JSON.stringify({ flows: [] }, null, 2) + "\n",
  );

  // A planning-shaped bundle with every PRE-planning obligation already
  // satisfied (mirroring orchestration.test's createDecisionBundle): audit_tasks
  // present, none complete → the fold's decision selects
  // audit_tasks_completed / semantic_review_executor directly, and the pending
  // set is non-empty both before AND after one warning-only acceptance.
  const tasks = [
    TASK,
    {
      ...TASK,
      task_id: "task-b",
      unit_id: "unit-task-b",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/b.ts"],
    },
  ];
  const bundle = {
    repo_manifest: {
      repository: { name: "fold-advisory-fixture" },
      generated_at: "2026-08-22T00:00:00.000Z",
      files: [
        { path: "src/a.ts", language: "ts", size_bytes: 8, hash: sha256(fileA) },
        { path: "src/b.ts", language: "ts", size_bytes: 8, hash: sha256(fileB) },
      ],
    },
    file_disposition: { files: [] },
    auto_fixes_applied: { applied: [] },
    external_analyzer_results: [{ tool: "eslint", results: [] }],
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    syntax_resolution_status: {
      tool: "syntax_resolution_executor",
      completed_at: "2026-04-22T00:00:00Z",
    },
    unit_manifest: {
      units: [
        { unit_id: "unit-a", name: "unit-a", files: ["src/a.ts"], required_lenses: ["correctness"] },
        { unit_id: "unit-b", name: "unit-b", files: ["src/b.ts"], required_lenses: ["security"] },
      ],
    },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: { imports: [], calls: [] } },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { items: [] },
    analyzer_capability: { status: "omitted", analyzers: [] },
    design_assessment: {
      generated_at: "2026-04-22T00:00:00Z",
      findings: [],
      review_findings: [],
      reviewed: true,
      contract_findings: [],
      contract_reviewed: true,
      conceptual_findings: [],
      conceptual_reviewed: true,
    },
    docs_digest: { generated_at: "2026-04-22T00:00:00Z", docs: [] },
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 0,
      source_ids: [],
      consensus: [],
      contested: [],
      findings: [],
    },
    charter_register: {
      schema_version: "charter-register/v3" as const,
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
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1" as const,
      confirmed_at: "2026-04-22T00:00:00Z",
      confirmed_by: "host" as const,
      scope_summary: "test scope",
      intent_summary: "full-audit",
    },
    coverage_matrix: {
      files: [
        {
          path: "src/a.ts",
          unit_ids: ["unit-a"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["correctness"],
          completed_lenses: [],
        },
        {
          path: "src/b.ts",
          unit_ids: ["unit-b"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: tasks,
    requeue_tasks: [],
  } as ArtifactBundle;
  const { computeArtifactMetadata } = await import(
    "../../src/audit/orchestrator/artifactMetadata.js"
  );
  const { runIntentEquivalenceResolve } = await import(
    "../../src/audit/orchestrator/intentEquivalenceExecutor.js"
  );
  const settled = runIntentEquivalenceResolve({
    ...bundle,
    artifact_metadata: computeArtifactMetadata(bundle as never),
  }).updated;
  const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.js");
  await writeCoreArtifacts(artifactsDir, settled as never);

  return { root, artifactsDir };
}

describe("contract:host-delegation-fold-carries-advisories-to-the-next-emission", () => {
  it("renders the advisory line for a warning-only accepted result on the emitted step", async () => {
    const { root, artifactsDir } = await setup();

    // First walk: answers the incidental host pauses (consent/install/intent),
    // then mints the review run and emits dispatch_review.
    const first = (await advanceToDispatchReview(root, artifactsDir)) as {
      step_kind: string;
      run_id: string;
    };
    expect(first.step_kind).toBe("dispatch_review");
    expect(first.run_id).toBeTruthy();

    // Host writes ONE warning-only result for the FIRST published work item
    // (its id is content-derived — planning canonicalizes tasks): a declared
    // total_lines one BELOW the disk count is a ±1 counting delta → advisory
    // warning, no error. At least one other item stays pending, so the fold's
    // ingest path takes the transition branch — the live shape under test.
    const workload = JSON.parse(
      await readFile(
        join(artifactsDir, "runs", first.run_id, "host-workload.json"),
        "utf8",
      ),
    ) as {
      work_items: {
        id: string;
        lens: string;
        result_path: string;
        prompt: { sha256: string };
        scope: { files: string[] };
      }[];
    };
    expect(
      workload.work_items.length,
      "the fixture must publish ≥2 items so one acceptance leaves the rest pending",
    ).toBeGreaterThanOrEqual(2);
    const item = workload.work_items[0];
    if (!item) throw new Error("workload published no work items");
    const coveredPath = item.scope.files[0];
    if (!coveredPath) throw new Error("work item declares no files");
    const resultPath = join(root, item.result_path);
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(
      resultPath,
      JSON.stringify({
        contract_version: "audit-host-result/v1alpha1",
        result_id: `result-${item.id}`,
        run_id: first.run_id,
        work_item_id: item.id,
        prompt_sha256: item.prompt.sha256,
        // Bound truth: the workload's line hints pin total_lines at 2, and the
        // envelope rule requires reviewed_lines == total_lines. So the ADVISORY
        // comes from the content gate's other warning class instead: a second
        // affected_files entry outside the declared coverage — out-of-scope
        // findings are retained with a warning (INV-09), never rejected.
        file_coverage: [
          { path: coveredPath, reviewed_lines: 2, total_lines: 2 },
        ],
        findings: [
          {
            id: "F-1",
            title: "Warning-only finding",
            category: "correctness",
            severity: "medium",
            confidence: "medium",
            lens: (item as unknown as { lens?: string }).lens,
            summary: "Accepted with an out-of-scope-file advisory.",
            affected_files: [{ path: coveredPath }, { path: "src/out-of-scope.ts" }],
            evidence: [`${coveredPath}:1-2 - boundary`],
          },
        ],
      }),
      "utf8",
    );

    // Second call: the fold ingests task-a (warning-only), transitions through
    // the result-ingestion executor because task-b is still pending, then emits…
    await callNextStep(root, artifactsDir);
    const second = JSON.parse(
      await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
    ) as { step_kind: string };
    expect(second.step_kind).toBe("dispatch_review");

    // …and the emitted prompt must STATE the advisory on task-a.
    const prompt = await readFile(
      join(artifactsDir, "steps", "current-prompt.md"),
      "utf8",
    );
    expect(
      prompt,
      "the emitted prompt must carry the advisory channel for the accepted-with-warning result",
    ).toContain("Advisory notes on accepted results");
    // The advisory names the WORK ITEM (its content-derived id), which is what
    // the host binds results to — not the internal audit task id.
    expect(
      prompt,
      "the emitted prompt must name the accepted-with-warning work item",
    ).toContain(item.id);
  });
});

