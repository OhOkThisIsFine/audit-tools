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
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "../../../src/remediate/state/store.js";
import type { RemediationState } from "../../../src/remediate/state/store.js";
import { writeContractArtifact } from "../../../src/remediate/contractPipeline/artifactStore.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
  CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
  CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
  CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
  CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
} from "audit-tools/shared";
import {
  CP_MODULE_DECOMPOSITION_VERSION,
  CP_MODULE_CONTRACTS_VERSION,
  CP_SEAM_RECONCILIATION_REPORT_VERSION,
  CP_FINALIZED_MODULE_CONTRACTS_VERSION,
  CP_CYCLIC_SEAM_RESOLUTION_VERSION,
} from "../../../src/remediate/validation/contractPipeline.js";

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = dirname(HELPERS_DIR);

/** Path to the canonical structured audit-findings fixture (simple two-finding). */
export const AUDIT_FIXTURE = join(
  TESTS_DIR,
  "fixtures",
  "audit-findings-simple.json",
);
/** Path to the richer auditor-contract fixture (with work_blocks + themes). */
export const AUDITOR_CONTRACT_FIXTURE = join(
  TESTS_DIR,
  "fixtures",
  "auditor-contract-audit-findings.json",
);
/** Path to the CLI wrapper used by the spawnSync end-to-end checks. */
export const WRAPPER = join(TESTS_DIR, "..", "..", "remediate-code.mjs");

// ---------------------------------------------------------------------------
// Pure state builders — no filesystem dependency, safe to share verbatim.
// ---------------------------------------------------------------------------

/** A two-finding planning state with both items pending in separate blocks. */
export function makePlanningState(
  overrides: Partial<RemediationState> = {},
): RemediationState {
  return {
    status: "planning",
    plan: {
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
      blocks: [
        { block_id: "B-001", items: ["F-001"], parallel_safe: true },
        { block_id: "B-002", items: ["F-002"], parallel_safe: true },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
      "F-002": { finding_id: "F-002", status: "pending", block_id: "B-002" },
    },
    closing_plan: { action: "none" },
    ...overrides,
  } as RemediationState;
}

/** The planning state advanced to `implementing` with item_specs attached. */
export function makeImplementingState(
  overrides: Partial<RemediationState> = {},
): RemediationState {
  return makePlanningState({
    status: "implementing",
    items: {
      "F-001": {
        finding_id: "F-001",
        status: "pending",
        block_id: "B-001",
        item_spec: {
          finding_id: "F-001",
          concrete_change: "fix a",
          no_change: false,
          touched_files: ["src/a.ts"],
          tests_to_write: [],
          not_applicable_steps: [],
        },
      },
      "F-002": {
        finding_id: "F-002",
        status: "pending",
        block_id: "B-002",
        item_spec: {
          finding_id: "F-002",
          concrete_change: "fix b",
          no_change: false,
          touched_files: ["src/b.ts"],
          tests_to_write: [],
          not_applicable_steps: [],
        },
      },
    },
    ...overrides,
  });
}

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
  writeCompleteContractPipelineDag(): Promise<void>;
}

/**
 * Build a harness rooted at a per-file scratch directory.
 *
 * @param dirName Unique scratch dir name (e.g. ".test-next-step-lifecycle").
 *   Two files MUST NOT share a name, or their parallel runs will collide.
 */
export function createNextStepHarness(dirName: string): NextStepHarness {
  const TEST_DIR = join(TESTS_DIR, dirName);
  const REPO_DIR = join(TEST_DIR, "repo");
  const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

  async function saveState(state: RemediationState): Promise<void> {
    await new StateStore(ARTIFACTS_DIR).saveState(state);
  }

  async function resetTestRepo(): Promise<void> {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
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
      JSON.stringify({
        schema_version: "remediate-code-intake-summary/v1alpha1",
        ready: true,
        source_type: "structured_audit",
        goals: ["Remediate the structured audit findings."],
        non_goals: [],
        constraints: [],
        affected_files: [],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "remediation-brief.md"),
      "# Structured intake\n",
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
   * structured-audit run proceeds straight into the contract pipeline. Writing
   * `declined: []` leaves every finding included (the gate filters by the
   * declined set), so the downstream behaves exactly as a fully-approved run.
   */
  async function approveReviewGate(): Promise<void> {
    await writeFile(
      join(ARTIFACTS_DIR, "review_decision.json"),
      JSON.stringify({
        schema_version: "remediate-code-review-decision/v1",
        plan_id: "path-a-review",
        approved_ids: [],
        declined: [],
        created_at: new Date().toISOString(),
      }),
      "utf8",
    );
  }

  async function writeCompleteContractPipelineDag(): Promise<void> {
    const created_at = "2026-01-01T00:00:00.000Z";
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1",
      objective: "Clean up the auth flow.",
      non_goals: [],
      success_criteria: ["Auth flow cleanup is implemented."],
      source_type: "documents",
      created_at,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", {
      contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
      goal_id: "G1",
      entries: [],
      context_summary: "Auth flow context.",
      created_at,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", {
      contract_version: CP_MODULE_DECOMPOSITION_VERSION,
      goal_id: "G1",
      modules: [
        {
          name: "auth-module",
          responsibilities: "Handles auth flow.",
          file_scope: ["src/auth.ts"],
        },
      ],
      created_at,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", {
      contract_version: CP_MODULE_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: [
        {
          name: "auth-module",
          inputs: ["credentials"],
          outputs: ["session"],
          invariants: [],
          side_effects: [],
          validation_boundary: "validates credentials",
          failure_modes: [],
          neighbor_needs: [],
        },
      ],
      created_at,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", {
      contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
      goal_id: "G1",
      mismatches: [],
      created_at,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", {
      contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: [
        {
          name: "auth-module",
          inputs: ["credentials"],
          outputs: ["session"],
          invariants: [],
          side_effects: [],
          validation_boundary: "validates credentials",
          failure_modes: [],
          seam_adjustments: [],
        },
      ],
      created_at,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", {
      contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
      goal_id: "G1",
      items: [],
      verdict: "approved",
      created_at,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [
        {
          id: "O-1",
          description: "the authFlow cleanup is implemented",
          kind: "behavioral",
          depends_on: [],
          status: "pending",
          // DC-5: a behavior CHANGE touching `authFlow`; its paired negative must
          // be scoped to that symbol (an unscoped repo-wide negative fails the gate).
          change_classification: {
            change_kind: "change",
            touched_symbols: ["authflow"],
            determined_by: "touches_existing_symbol",
          },
        },
      ],
      created_at,
    });
    // cyclic_seam_resolution is auto-written by the pipeline when no cycles
    // exist, but we write it explicitly here so the pipeline sees it and proceeds.
    await writeContractArtifact(ARTIFACTS_DIR, "cyclic_seam_resolution", {
      contract_version: CP_CYCLIC_SEAM_RESOLUTION_VERSION,
      goal_id: "G1",
      status: "no_cycles",
      cycles: [],
      created_at,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "test_validator_plan", {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      // O-1 is behavioral (testable): the paired-obligation gate requires a spec
      // covering both the satisfied path and the failure path before the
      // implementation DAG can promote.
      test_specs: [
        {
          obligation_id: "O-1",
          name: "auth flow cleanup holds and rejects the failure case",
          kind: "invariant",
          assertions: [
            "authFlow returns the cleaned-up flow on the satisfied path",
            "authFlow rejects the invalid request on the failure path",
          ],
        },
      ],
      created_at,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "contract_assessment_report", {
      contract_version: CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
      goal_id: "G1",
      findings: [],
      verdict: "passed",
      created_at,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "counterexample", {
      contract_version: CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
      goal_id: "G1",
      counterexamples: [],
      created_at,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "judge_report", {
      contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id: "G1",
      verdict: "approved",
      classifications: [],
      created_at,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [
        {
          id: "CP-001",
          title: "Update auth flow",
          description: "Implement the auth flow cleanup.",
          satisfies_obligations: ["O-1"],
          depends_on: [],
          verification_obligation_ids: ["O-1"],
          targeted_commands: ["npm test"],
          status: "pending",
        },
      ],
      edges: [],
      created_at,
    });
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
    writeCompleteContractPipelineDag,
  };
}
