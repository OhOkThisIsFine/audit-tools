// Shared scaffolding for the next-step test suite.
//
// The next-step tests were originally one ~2800-line monolith
// (`tests/next-step.test.ts`). They are now split into focused per-concern
// files (lifecycle, contract-pipeline dispatch, implementation dispatch,
// resume/intent gates, preview-ack, outcomes contract). Every split file shares
// the same fixtures and state/artifact helpers, which live here so the split
// files stay tight and cannot drift apart.
//
// Hermeticity: each split file MUST call `createNextStepHarness` with its OWN
// unique directory name. The returned harness owns a private TEST_DIR; the
// `resetTestRepo`/cleanup helpers operate only on that dir, so files running in
// parallel under vitest never clobber each other's scratch state.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSyncHidden as spawnSync } from "../../helpers/spawn.mjs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "../../../src/remediate/state/store.js";
import type { RemediationState } from "../../../src/remediate/state/store.js";
import { intakeSummaryFixture } from "./intakeSummaryFixture.js";
import { canonicalPlanFixture, canonicalUnitFixture } from "./canonicalPlanFixture.js";
import { buildNextContractPipelineStep } from "../../../src/remediate/steps/contractPipeline.js";
import { executionPlanPaths, readPlanSource, readCanonicalPlan } from "../../../src/remediate/contractPipeline/executionPlan.js";
import { scratchDir } from "../../helpers/scratch.js";
// The friction vocabulary is single-sourced in shared; the walk helper below
// attests every category by iterating it, so a new category cannot leave this
// fixture writing an incomplete record.
import { FRICTION_CATEGORIES } from "audit-tools/shared";
// The gate seam is PRODUCTION code owned by remediate-nextstep-and-final-gate;
// the harness consumes it, never reimplements it (the seam edge runs this way
// only).
import {
  runToolOwnedFinalGate,
  type GateRunner,
  type ToolOwnedFinalGateResult,
} from "../../../src/remediate/steps/finalGate.js";

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = dirname(HELPERS_DIR);

/** Path to the canonical structured audit-findings fixture (simple two-finding). */
export const AUDIT_FIXTURE = join(
  TESTS_DIR,
  "fixtures",
  "audit-findings-simple.json",
);
// ---------------------------------------------------------------------------
// Pure state builders — no filesystem dependency, safe to share verbatim.
// ---------------------------------------------------------------------------

/** Two original findings, each linked to one independently executable unit. */
export function makePlanningState(
  overrides: Partial<RemediationState> = {},
): RemediationState {
  return {
    status: "planning",
    plan: canonicalPlanFixture({
      plan_id: "PLAN-1",
      findings: [
        {
          id: "F-001",
          title: "First",
          category: "correctness",
          severity: "high",
          confidence: "high",
          lens: "correctness",
          summary: "Fix first.",
          affected_files: [{ path: "src/a.ts" }],
          evidence: ["src/a.ts:1 evidence"],
        },
        {
          id: "F-002",
          title: "Second",
          category: "tests",
          severity: "low",
          confidence: "medium",
          lens: "tests",
          summary: "Fix second.",
          affected_files: [{ path: "src/b.ts" }],
          evidence: ["src/b.ts:1 evidence"],
        },
      ],
      units: [
        canonicalUnitFixture("B-001", { source_finding_ids: ["F-001"], read_paths: ["src/a.ts"], allowed_files: ["src/a.ts"] }),
        canonicalUnitFixture("B-002", { source_finding_ids: ["F-002"], read_paths: ["src/b.ts"], allowed_files: ["src/b.ts"] }),
      ],
      requirements: [
        { id: "REQ-B-001", description: "Fix first", source_finding_ids: ["F-001"], change_kind: "addition",
          assertions: [{ kind: "positive", description: "First finding's acceptance condition holds", scope_paths: ["src/a.ts"] }] },
        { id: "REQ-B-002", description: "Fix second", source_finding_ids: ["F-002"], change_kind: "addition",
          assertions: [{ kind: "positive", description: "Second finding's acceptance condition holds", scope_paths: ["src/b.ts"] }] },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    }),
    items: {
      "B-001": { unit_id: "B-001", status: "pending" },
      "B-002": { unit_id: "B-002", status: "pending" },
    },
    closing_plan: { action: "none" },
    ...overrides,
    // No `as RemediationState`: the return-type annotation is the CHECK. A cast
    // here asserted the contract instead of verifying it, so a fixture missing a
    // required field (e.g. a block with no `touched_files`) sailed past
    // `check:tests` — the gate that exists to catch exactly that.
  };
}

/**
 * The hermetic gate runner every harness-driven run gets.
 *
 * INV-THH-THREADS-GATE-RUNNER. The tool-owned final gate spawns the repository's
 * whole build/typecheck/test floor, so a suite that drives `decideNextStep` to a
 * gate has to do something about it. There are two ways, and only one of them is
 * honest:
 *
 *   - the ENVIRONMENT SKIP (the final-gate env var `finalGateDisabledReason` in
 *     nextStep.ts reads — deliberately not spelled here, because the guard in
 *     final-gate-extraction-equivalence.test.ts scans tests/ for that literal
 *     and a commented mention is one uncomment away from a use) or
 *     `skipFinalGate` suppresses the gate, and a suppressed gate produces NO
 *     verdict — the run transitions as if a floor had passed while nothing ran;
 *   - this INJECTED RUNNER lets the gate execute its real command list and
 *     record a real outcome, with the spawn replaced.
 *
 * The harness supplies the second so no suite needs the first. `status: 0` by
 * default (a green floor); a suite wanting a red one passes its own runner to
 * {@link NextStepHarness.runFinalGate} or to `decideNextStep`.
 */
export const HARNESS_GATE_RUNNER: GateRunner = () => ({ status: 0 });

/** Directory-bound helpers + path constants for one next-step test file. */
export interface NextStepHarness {
  TEST_DIR: string;
  REPO_DIR: string;
  ARTIFACTS_DIR: string;
  saveState(state: RemediationState): Promise<void>;
  resetTestRepo(): Promise<void>;
  cleanupTestRepo(): Promise<void>;
  acknowledgeResume(): Promise<void>;
  writeIntentCheckpoint(): Promise<void>;
  writeReadyStructuredAuditIntake(inputPath: string): Promise<void>;
  approveReviewGate(): Promise<void>;
  writeApprovedExecutionPlan(): Promise<void>;
  /**
   * Write an optional development friction record for diagnostic/archive tests.
   */
  walkFriction(planId?: string): Promise<void>;
  /**
   * The injectable final-gate runner (`artifact:injectable-final-gate-runner`,
   * a PRODUCTION seam owned by remediate-nextstep-and-final-gate) this harness
   * threads into harness-driven runs. Pass it as `decideNextStep`'s
   * `finalGateRunner` — never set the environment skip, which is the one path
   * that records no gate outcome at all.
   */
  finalGateRunner: GateRunner;
  /**
   * Run the real tool-owned final gate against `root` (default: this harness's
   * REPO_DIR) through the injected runner, returning the real
   * `ToolOwnedFinalGateResult`. Spawns nothing.
   */
  runFinalGate(
    root?: string,
    runner?: GateRunner,
  ): Promise<ToolOwnedFinalGateResult>;
}

/**
 * Build a harness rooted at a per-file scratch directory.
 *
 * @param dirName Unique scratch dir name (e.g. ".test-next-step-lifecycle").
 *   Two files MUST NOT share a name, or their parallel runs will collide.
 */
export function createNextStepHarness(dirName: string): NextStepHarness {
  // Root scratch state under the OS temp dir, NOT the in-tree tests directory.
  // A fixture tree under `tests/` is walked by the INV-WH raw-spawn scanner
  // (`tests/shared/shared-tests-invariants.test.mjs`); a concurrently-running
  // next-step test creating/deleting its scratch tree mid-scan raced that walk
  // into a mid-scan ENOENT. Off-tree keeps the fixtures out of the scanned tree.
  //
  // Via `scratchDir`, not a fixed `tmpdir()/audit-tools-tests`: a constant root
  // is off-tree but still SHARED, so two concurrent vitest invocations raced
  // every one of these dirs. The root is now per-invocation.
  const TEST_DIR = scratchDir(dirName);
  const REPO_DIR = join(TEST_DIR, "repo");
  const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

  async function saveState(state: RemediationState): Promise<void> {
    await new StateStore(ARTIFACTS_DIR).saveState(state);
  }

  async function resetTestRepo(): Promise<void> {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: REPO_DIR, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "--no-gpg-sign", "-q", "-m", "fixture baseline");
  }

  async function cleanupTestRepo(): Promise<void> {
    await rm(TEST_DIR, { recursive: true, force: true });
  }

  async function acknowledgeResume(): Promise<void> {
    await writeFile(
      join(ARTIFACTS_DIR, "confirm_resume_ack.json"),
      JSON.stringify({ choice: "resume" }),
      "utf8",
    );
  }

  /**
   * Complete the run's friction close-out walk on the plan-keyed record.
   *
   * This is development diagnostic input, never a product completion gate.
   */
  async function walkFriction(planId = "PLAN-1"): Promise<void> {
    const dir = join(ARTIFACTS_DIR, "friction");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${planId}.json`),
      JSON.stringify({
        category_attestations: FRICTION_CATEGORIES.map((category) => ({
          category,
          note: "none this run",
        })),
      }) + "\n",
      "utf8",
    );
  }

  async function writeIntentCheckpoint(): Promise<void> {
    await writeFile(
      join(ARTIFACTS_DIR, "intent_checkpoint.json"),
      JSON.stringify({
        schema_version: "intent-checkpoint/v1",
        confirmed_at: new Date().toISOString(),
        scope_summary: "Test scope",
        intent_summary: "Test intent",
        confirmed_by: "host",
      }),
      "utf8",
    );
  }

  async function writeReadyStructuredAuditIntake(
    inputPath: string,
  ): Promise<void> {
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-source-manifest/v1alpha1",
        created_from: "input",
        sources: [
          {
            type: "structured_audit",
            path: inputPath,
            label: "audit-findings",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify(
        intakeSummaryFixture({
          source_type: "structured_audit",
          goals: ["Remediate the structured audit findings."],
          affected_files: [],
        }),
      ),
      "utf8",
    );
    // Materialize every cited affected_files path as a stub in the test repo, the
    // way the real audited repo contains them. The intake review-gate filter pass
    // runs phantom-path grounding and drops findings whose cited paths don't exist
    // on disk, so without these the findings would be filtered out before review.
    try {
      const report = JSON.parse(await readFile(inputPath, "utf8")) as {
        findings?: Array<{ affected_files?: Array<{ path?: string }> }>;
      };
      const citedPaths = new Set<string>();
      for (const finding of report.findings ?? []) {
        for (const file of finding.affected_files ?? []) {
          if (typeof file.path === "string" && file.path.length > 0) {
            citedPaths.add(file.path);
          }
        }
      }
      for (const relOrAbs of citedPaths) {
        const abs = isAbsolute(relOrAbs) ? relOrAbs : join(REPO_DIR, relOrAbs);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, `// stub for ${relOrAbs}\n`, "utf8");
      }
    } catch {
      // A non-JSON / unreadable input (e.g. a markdown brief) cites no paths.
    }
    await writeIntentCheckpoint();
  }

  /**
   * Satisfy the Path-A review-approval gate with an approve-all decision so a
   * structured-audit run proceeds straight into the contract pipeline. Writes
   * an EMPTY review_resolution.json (the attended approve-all answer) so the
   * TOOL consumes it and records the real decision — including the actual
   * approved_ids, which the decision REPLAY now honours (COR-227a02ae; a
   * hand-forged decision with `approved_ids: []` would approve nothing).
   */
  async function approveReviewGate(): Promise<void> {
    await writeFile(
      join(ARTIFACTS_DIR, "review_resolution.json"),
      JSON.stringify({}),
      "utf8",
    );
  }

  async function writeApprovedExecutionPlan(): Promise<void> {
    const file = "src/remediate/intake.ts";
    await mkdir(dirname(join(REPO_DIR, file)), { recursive: true });
    await writeFile(join(REPO_DIR, file), "export const authFlow = true;\n", "utf8");
    const git = (...args: string[]) => spawnSync("git", args, { cwd: REPO_DIR, encoding: "utf8" });
    git("add", file);
    const brief = join(ARTIFACTS_DIR, "fixture-request.md");
    await writeFile(brief, "Clean up the auth flow while retaining its behavior.\n");
    const options = { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR, runId: "PLAN-1", sourcePaths: [brief] };
    await buildNextContractPipelineStep(options);
    const source = await readPlanSource(ARTIFACTS_DIR);
    if (!source) throw new Error("Fixture planning source was not created");
    const paths = executionPlanPaths(ARTIFACTS_DIR);
    const sources = source.findings.map(finding => finding.id);
    const plan = {
      plan_id: source.plan_id, objective: "Clean up the auth flow", non_goals: [],
      requirements: [{ id: "REQ-auth", description: "Preserve the auth flow", source_finding_ids: sources,
        change_kind: "behavior_change", assertions: [
          { kind: "positive", description: "Valid credentials preserve the auth flow", scope_paths: [file] },
          { kind: "negative", description: "Invalid credentials cannot enter the auth flow", scope_paths: [file] },
        ] }],
      units: [canonicalUnitFixture("CP-001", { title: "Update auth flow", description: "Implement the auth flow cleanup",
        source_finding_ids: sources, requirement_ids: ["REQ-auth"], read_paths: [file], allowed_files: [file], required_tests: ["npm test"] })],
      source_dispositions: [],
    };
    await writeFile(paths.submission, JSON.stringify({ base_revision_sha256: null, plan, retired_requirements: [] }));
    await buildNextContractPipelineStep(options);
    const canonical = await readCanonicalPlan(ARTIFACTS_DIR);
    if (source.request && canonical) await writeFile(join(paths.directory, "owner-decision.json"), JSON.stringify({
      revision_sha256: canonical.revision_sha256, confirmed_by: "host", approved_unit_ids: plan.units.map(unit => unit.id), declined_units: [],
    }));
    for (const role of ["critique", "critic", "judge"] as const) {
      await buildNextContractPipelineStep(options);
      const request = JSON.parse(await readFile(paths.review(role).request, "utf8")) as { prompt_sha256: string };
      const result = role === "critique" ? { verdict: "approved", issues: [] }
        : role === "critic" ? { counterexamples: [] }
        : { verdict: "approved", classifications: [], disposition_assessments: [],
          requirement_assessments: [{ requirement_id: "REQ-auth", verdict: "satisfied", evidence: ["The scoped positive and negative assertions cover the source requirement"] }] };
      await writeFile(paths.review(role).submission, JSON.stringify({
        contract_version: "review-submission/v1", prompt_sha256: request.prompt_sha256,
        review: { mode: "independent", reason: "Fixture simulates a separate review context" }, result,
      }));
    }
    const remaining = await buildNextContractPipelineStep(options);
    if (remaining !== null) throw new Error(`Fixture plan did not reach approval: ${remaining.prompt_path}`);
  }

  return {
    TEST_DIR,
    REPO_DIR,
    ARTIFACTS_DIR,
    saveState,
    resetTestRepo,
    cleanupTestRepo,
    acknowledgeResume,
    writeIntentCheckpoint,
    writeReadyStructuredAuditIntake,
    approveReviewGate,
    writeApprovedExecutionPlan,
    walkFriction,
    finalGateRunner: HARNESS_GATE_RUNNER,
    runFinalGate: (root = REPO_DIR, runner = HARNESS_GATE_RUNNER) =>
      runToolOwnedFinalGate(root, { runner }),
  };
}
