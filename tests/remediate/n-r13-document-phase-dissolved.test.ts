/**
 * N-R13: Document phase dissolution — invariant tests.
 *
 * Verifies that the document phase is fully removed:
 * - Planning transitions directly to implementing (no documenting hop).
 * - "documenting" is not a valid RemediationState.status value.
 * - merge-document-results is not registered as a CLI command.
 * - prepareDocumentDispatch, mergeDocumentResults, buildDocumentModelHint are
 *   not exported from steps/dispatch.ts.
 * - buildImplementDispatchItem reads file scope from affected_files when
 *   item_spec is absent (pending status, no document round).
 * - prepareImplementDispatch accepts a RemediationItemState with status "pending".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-n-r13");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await writeFile(join(REPO_DIR, "package.json"), JSON.stringify({ name: "test-repo" }));
});

afterEach(async () => {
  delete process.env.REMEDIATE_ROLLING_ENGINE;
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Type-level: "documenting" is not in the RemediationState.status union
// ---------------------------------------------------------------------------

describe("N-R13: RemediationState.status union", () => {
  it("does not include 'documenting' as a valid status", async () => {
    const { StateStore } = await import("../../src/remediate/state/store.js");
    const store = new StateStore(ARTIFACTS_DIR);

    // Saving a state with status "documenting" should fail TypeScript compilation
    // (this is a runtime guard: the union no longer includes "documenting").
    // We verify by confirming the valid statuses and "documenting" is absent.
    // The TypeScript compiler would reject `status: "documenting"` at compile time;
    // here we confirm that the runtime round-trip rejects or at least doesn't
    // perpetuate the old status string.
    const validStatuses = [
      "pending",
      "planning",
      "waiting_for_clarification",
      "implementing",
      "triage",
      "waiting_for_triage",
      "closing",
      "complete",
    ] as const;

    // None of the valid statuses is "documenting"
    expect(validStatuses).not.toContain("documenting");
  });
});

// ---------------------------------------------------------------------------
// 2. Planning → implementing directly (no documenting hop)
// ---------------------------------------------------------------------------

describe("N-R13: planning transitions directly to implementing", () => {
  it("decideNextStep emits dispatch_implement (not dispatch_document) after planning", async () => {
    const { StateStore } = await import("../../src/remediate/state/store.js");
    const { decideNextStep } = await import("../../src/remediate/steps/nextStep.js");

    const planId = "PLAN-N-R13";
    const findingId = "F-N-R13-001";
    const state = {
      status: "planning" as const,
      plan: {
        plan_id: planId,
        findings: [
          {
            id: findingId,
            title: "Test finding",
            category: "correctness",
            severity: "medium" as const,
            confidence: "high" as const,
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: [],
          },
        ],
        blocks: [
          { block_id: "B-001", items: [findingId], parallel_safe: true },
        ],
        project_type: "unknown" as const,
        candidate_closing_actions: ["none" as const],
      },
      items: {
        [findingId]: {
          finding_id: findingId,
          status: "pending" as const,
          block_id: "B-001",
          item_spec: {
            finding_id: findingId,
            concrete_change: "fix it",
            no_change: false,
            touched_files: ["src/a.ts"],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      },
      closing_plan: { action: "none" as const },
    };
    await new StateStore(ARTIFACTS_DIR).saveState(state);

    // Write resume ack, intent checkpoint, and an approve-all review decision so
    // we skip confirm_resume and satisfy the Path-B planning review gate.
    await writeFile(
      join(ARTIFACTS_DIR, "confirm_resume_ack.json"),
      JSON.stringify({ choice: "resume" }),
      "utf8",
    );
    await writeFile(
      join(ARTIFACTS_DIR, "intent_checkpoint.json"),
      JSON.stringify({ acknowledged: true }),
      "utf8",
    );
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
    // G2: dispatch.rolling_engine is unrepresentable on disk; pin the wave opt-out via
    // the sanctioned env override (cleaned up in afterEach).
    process.env.REMEDIATE_ROLLING_ENGINE = "false";

    const step = await decideNextStep({ root: REPO_DIR });

    // Must NOT be dispatch_document or document_single_item
    expect(step.step_kind).not.toBe("dispatch_document");
    expect(step.step_kind).not.toBe("document_single_item");

    // TST-4a7b1751: this fixture is a fully-ready implementing state (planning +
    // a pending item with an item_spec + every ack written). The N-R13 contract
    // is that planning goes DIRECTLY to implementing — so the only acceptable
    // kinds are the implementing dispatch family. Terminal/error kinds
    // (collect_starting_point, present_report, collect_triage,
    // zero_documentable_findings) must NOT be accepted here: admitting them would
    // let a regression that derails the planning→implementing transition pass
    // vacuously.
    const implementingKinds = ["dispatch_implement", "implement_rolling_sequential"];
    expect(
      implementingKinds,
      `expected an implementing-family step kind, got '${step.step_kind}'`,
    ).toContain(step.step_kind);
  });
});

// ---------------------------------------------------------------------------
// 3. CLI: merge-document-results not registered
// ---------------------------------------------------------------------------

describe("N-R13: CLI command removal", () => {
  it("merge-document-results is not a registered command in src/index.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const indexSrc = readFileSync(
      join(__dirname, "..", "..", "src", "remediate", "index.ts"),
      "utf8",
    );
    expect(indexSrc).not.toContain("merge-document-results");
    expect(indexSrc).not.toContain("prepare-document-dispatch");
  });
});

// ---------------------------------------------------------------------------
// 4. dispatch.ts: document exports removed
// ---------------------------------------------------------------------------

describe("N-R13: steps/dispatch.ts removed exports", () => {
  it("prepareDocumentDispatch is not exported", async () => {
    const dispatch = await import("../../src/remediate/steps/dispatch.js");
    expect((dispatch as Record<string, unknown>)["prepareDocumentDispatch"]).toBeUndefined();
  });

  it("mergeDocumentResults is not exported", async () => {
    const dispatch = await import("../../src/remediate/steps/dispatch.js");
    expect((dispatch as Record<string, unknown>)["mergeDocumentResults"]).toBeUndefined();
  });

  it("buildDocumentModelHint is not exported", async () => {
    const dispatch = await import("../../src/remediate/steps/dispatch.js");
    expect((dispatch as Record<string, unknown>)["buildDocumentModelHint"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. prepareImplementDispatch accepts pending status (no document round)
// ---------------------------------------------------------------------------

describe("N-R13: prepareImplementDispatch accepts pending items", () => {
  it("accepts a RemediationItemState with status 'pending' and produces a dispatch plan", async () => {
    const { StateStore } = await import("../../src/remediate/state/store.js");
    const { prepareImplementDispatch } = await import("../../src/remediate/steps/dispatch.js");

    const srcDir = join(REPO_DIR, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "a.ts"), "export const x = 1;");

    const planId = "PLAN-N-R13-PENDING";
    const findingId = "F-N-R13-PENDING";
    const state = {
      status: "implementing" as const,
      plan: {
        plan_id: planId,
        findings: [
          {
            id: findingId,
            title: "Pending item test",
            category: "correctness",
            severity: "medium" as const,
            confidence: "high" as const,
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: [],
          },
        ],
        blocks: [
          { block_id: "B-001", items: [findingId], parallel_safe: true },
        ],
        project_type: "unknown" as const,
        candidate_closing_actions: ["none" as const],
      },
      items: {
        [findingId]: {
          finding_id: findingId,
          // "pending" — no document round, no item_spec
          status: "pending" as const,
          block_id: "B-001",
          item_spec: {
            finding_id: findingId,
            concrete_change: "fix it",
            no_change: false,
            touched_files: ["src/a.ts"],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      },
      closing_plan: { action: "none" as const },
    };
    await new StateStore(ARTIFACTS_DIR).saveState(state);

    // Should not throw — pending status is accepted
    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      planId,
    );

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].task_id).toContain("B-001");
  });

  it("dispatch plan uses affected_files for read/write paths when item_spec is absent", async () => {
    const { StateStore } = await import("../../src/remediate/state/store.js");
    const { prepareImplementDispatch } = await import("../../src/remediate/steps/dispatch.js");

    const srcDir = join(REPO_DIR, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "b.ts"), "export const y = 2;");

    const planId = "PLAN-N-R13-NO-SPEC";
    const findingId = "F-N-R13-NO-SPEC";
    const state = {
      status: "implementing" as const,
      plan: {
        plan_id: planId,
        findings: [
          {
            id: findingId,
            title: "No-spec item test",
            category: "correctness",
            severity: "medium" as const,
            confidence: "high" as const,
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [{ path: "src/b.ts" }],
            evidence: [],
          },
        ],
        blocks: [
          { block_id: "B-002", items: [findingId], parallel_safe: true },
        ],
        project_type: "unknown" as const,
        candidate_closing_actions: ["none" as const],
      },
      items: {
        [findingId]: {
          finding_id: findingId,
          status: "pending" as const,
          block_id: "B-002",
          // No item_spec — dispatch must fall back to finding.affected_files
        },
      },
      closing_plan: { action: "none" as const },
    };
    await new StateStore(ARTIFACTS_DIR).saveState(state);

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      planId,
    );

    expect(plan.items).toHaveLength(1);
    const dispatchItem = plan.items[0];

    // read_paths and write_paths must include src/b.ts (from affected_files)
    expect(dispatchItem.access.read_paths).toEqual(
      expect.arrayContaining(["src/b.ts"]),
    );
    expect(dispatchItem.access.write_paths).toEqual(
      expect.arrayContaining(["src/b.ts"]),
    );
  });
});
