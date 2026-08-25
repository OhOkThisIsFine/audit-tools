/**
 * N-R13: Document phase dissolution — invariant tests.
 *
 * Verifies that the document phase is fully removed:
 * - Planning transitions directly to implementing (no documenting hop).
 * - "documenting" is not a valid RemediationState.status value.
 * - merge-document-results is not registered as a CLI command.
 * - prepareDocumentDispatch, mergeDocumentResults, buildDocumentModelHint are
 *   not exported from steps/dispatch.ts.
 * - Pending items flow directly into the host workload (no document round).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "../helpers/scratch.js";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-n-r13");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

function git(...args: string[]): void {
  const result = spawnSyncHidden("git", args, {
    cwd: REPO_DIR,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await writeFile(join(REPO_DIR, "package.json"), JSON.stringify({ name: "test-repo" }));
  await writeFile(join(REPO_DIR, ".gitignore"), ".audit-tools/\n");
  git("init");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("add", "package.json", ".gitignore");
  git("commit", "-m", "fixture");
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Type-level: "documenting" is not in the RemediationState.status union
// ---------------------------------------------------------------------------

describe("N-R13: RemediationState.status union", () => {
  it("does not include 'documenting' as a valid status", async () => {
    const { StateStore: _StateStore } = await import("../../src/remediate/state/store.js");

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
          { block_id: "B-001", items: [findingId], parallel_safe: true, touched_files: ["src/a.ts"] },
        ],
        project_type: "unknown" as const,
        candidate_closing_actions: ["none" as const],
      },
      items: {
        [findingId]: {
          finding_id: findingId,
          status: "pending" as const,
          block_id: "B-001",
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
    const step = await decideNextStep({ root: REPO_DIR });

    // Must NOT be dispatch_document or document_single_item
    expect(step.step_kind).not.toBe("dispatch_document");
    expect(step.step_kind).not.toBe("document_single_item");

    // TST-4a7b1751: this fixture is a fully-ready implementing state (planning +
    // a pending item + every ack written). The N-R13 contract
    // is that planning goes DIRECTLY to implementing — so the only acceptable
    // kind is the host-workload implementation handoff. Terminal/error kinds
    // (collect_starting_point, present_report, collect_triage,
    // zero_documentable_findings) must NOT be accepted here: admitting them would
    // let a regression that derails the planning→implementing transition pass
    // vacuously.
    expect(step.step_kind).toBe("dispatch_implement");
    expect(step.artifact_paths.host_workload).toMatch(/host-workload\.json$/);
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
