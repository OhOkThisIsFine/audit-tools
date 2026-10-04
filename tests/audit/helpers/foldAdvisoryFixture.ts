import { captureCompletedDesignReviews, persistDesignReviewSnapshots } from "./designReviewSnapshotFixture.js";
import { declineDefaultAcquiredAnalyzers } from "../../helpers/analyzerConsentFixture.js";
import { EMPTY_REGISTER_BODY } from "../../helpers/charterRegisterFixture.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../../src/audit/types/charterRegister.js";
// Shared fixture for the host-delegation-fold-carries-advisories contract files:
// the seeded planning-shaped bundle and the real next-step driver.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ArtifactBundle } from "../../../src/audit/io/artifacts.js";

const cleanupRoots: string[] = [];

/** Register with `afterEach` in each consuming file. */
export async function cleanupFoldFixtures(): Promise<void> {
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
}

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
export async function callNextStep(root: string, artifactsDir: string): Promise<unknown> {
  const { cmdNextStep } = await import("../../../src/audit/cli/nextStepCommand.js");
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
export async function advanceToDispatchReview(root: string, artifactsDir: string) {
  const { walkStepsUntilTerminal } = await import("./step-driver.js");
  return walkStepsUntilTerminal({
    transport: () => callNextStep(root, artifactsDir),
    terminalKinds: new Set(["dispatch_review"]),
    label: "fold-advisory",
  });
}

export async function setup() {
  const { ensureSupervisorDirs } = await import(
    "../../../src/audit/io/runArtifacts.js"
  );
  const { GATE_LANES, laneSubmissionPath } = await import(
    "../../../src/audit/cli/laneSubmissions.js"
  );
  const { submissionsDir } = await import(
    "../../../src/shared/io/auditToolsPaths.js"
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
    analyzer_capability: { coverage: "not_applicable", analyzers: [] },
    design_assessment: {
      generated_at: "2026-04-22T00:00:00Z",
      findings: [],
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
      schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "charter",
      ceiling: { rung: "shallow" },
      status: "omitted",
      ...EMPTY_REGISTER_BODY,
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
    "../../../src/audit/orchestrator/artifactMetadata.js"
  );
  const { runIntentEquivalenceResolve } = await import(
    "../../../src/audit/orchestrator/intentEquivalenceExecutor.js"
  );
  const settled = captureCompletedDesignReviews(runIntentEquivalenceResolve({
    ...bundle,
    artifact_metadata: computeArtifactMetadata(bundle as never),
  }).updated);
  const { writeCoreArtifacts } = await import("../../../src/audit/io/artifacts.js");
  await writeCoreArtifacts(artifactsDir, settled as never);
  await persistDesignReviewSnapshots(artifactsDir, settled);

  // The real fold may refresh the seeded acquisition artifact as context moves.
  // State the same current-run decline used by every shared CLI fixture, rather
  // than relying on an enabled:false artifact to suppress external acquisition.
  await declineDefaultAcquiredAnalyzers(root);
  return { root, artifactsDir };
}

/** True when the carry file is still on disk (presence is the carry's signal). */
export async function carryFileStillPresent(carryPath: string): Promise<boolean> {
  try {
    await readFile(carryPath, "utf8");
    return true;
  } catch {
    return false;
  }
}

export const CONTRACT_NAME =
  "contract:host-delegation-fold-carries-advisories-to-the-next-emission";
