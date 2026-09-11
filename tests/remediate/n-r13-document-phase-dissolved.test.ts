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
    // Read the SHIPPED vocabulary, never a literal re-written here. The previous
    // version of this block built a local `validStatuses` array and asserted it
    // did not contain "documenting" — a tautology over a literal the test itself
    // wrote, so a `documenting` status reintroduced into `RemediationState`
    // would have passed it silently. The array now comes from the module the
    // load gate and the type both derive from, so the assertion is made against
    // the shipped value: reintroducing `documenting` anywhere in that chain reds
    // here.
    const { REMEDIATION_RUN_STATUSES } = await import(
      "../../src/remediate/state/runStatus.js"
    );
    const { StateStore: _StateStore } = await import("../../src/remediate/state/store.js");

    expect(REMEDIATION_RUN_STATUSES).not.toContain("documenting");
    // Non-vacuous: the array is the real vocabulary, not an empty or shrunken
    // read that would make the assertion above true for the wrong reason.
    expect(REMEDIATION_RUN_STATUSES).toContain("planning");
    expect(REMEDIATION_RUN_STATUSES).toContain("implementing");
  });

  it("the load gate refuses 'documenting' as an unknown status", async () => {
    // The RUNTIME half of the same invariant — the tautology above could not
    // reach it. `validateState` is exercised through the store's own read path,
    // so this reds if the gate's vocabulary ever diverges from the shipped one.
    const { StateStore } = await import("../../src/remediate/state/store.js");
    await writeFile(
      join(ARTIFACTS_DIR, "state.json"),
      JSON.stringify({ status: "documenting" }),
      "utf8",
    );
    await expect(new StateStore(ARTIFACTS_DIR).loadState()).rejects.toThrow(
      /Unknown status "documenting"/,
    );
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

// (The steps/dispatch.ts barrel itself was deleted in CY-03 — the dispatch
// surface is now the hostHandoff submodule, so the retirement pin holds there.)
describe("N-R13: dispatch surface removed exports", () => {
  it("prepareDocumentDispatch is not exported", async () => {
    const dispatch = await import("../../src/remediate/steps/dispatch/hostHandoff.js");
    expect((dispatch as Record<string, unknown>)["prepareDocumentDispatch"]).toBeUndefined();
  });

  it("mergeDocumentResults is not exported", async () => {
    const dispatch = await import("../../src/remediate/steps/dispatch/hostHandoff.js");
    expect((dispatch as Record<string, unknown>)["mergeDocumentResults"]).toBeUndefined();
  });

  it("buildDocumentModelHint is not exported", async () => {
    const dispatch = await import("../../src/remediate/steps/dispatch/hostHandoff.js");
    expect((dispatch as Record<string, unknown>)["buildDocumentModelHint"]).toBeUndefined();
  });
});
