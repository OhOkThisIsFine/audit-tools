// CP-NODE-1 / CP-NODE-2 red-green regression suite — remediate-state-machine
// module contract (item-status-partition-and-close owns this file).
//
// One test group per finding cluster, POSITIVE/NEGATIVE-prefixed assertions per
// the test_validator_plan style. Written FIRST (red on the unfixed tree), then
// the fixes turn them green. CP-NODE-2 converted the three describes that used
// to reach close.ts's exported symbols via `(await import(...)) as Record<string,
// unknown>` plus a hand-written signature cast to ordinary static typed imports
// (INV-ISC inv-8): the symbols were already static exports by the time those
// three landed, so the dynamic-import-plus-cast bought nothing and opted the
// describes out of this file's own typecheck gate — a rename in close.ts is now
// a `npm run check:tests` compile error here, not a silent runtime miss.
//
// Covered clusters:
//   COR-8c497987   verifyCommands.ts  — per-invocation build-free validation
//   DAT-017d52ff   store.ts           — status-conditional state completeness
//   COR-46fff0ec   plan.ts            — split preserves verification + phase metadata
//   COR-87f78167/-2 triage.ts         — post-resolution still-blocked guard + closing_plan
//   COR-fb656e3f/-2 close.ts          — skipped-non-none closing is not complete
//   OBS-89a57cbd/-2 close.ts          — final-state persist failure is surfaced
//   COR-0b906e37/-2 reviewGate.ts     — resolution/request plan_id correlation
//   COR-227a02ae   nextStep.ts        — decision replay honours approved_ids
//   CDC-402 pin    stepWriter          — current-step writes route through the shared writer
//   CP-NODE-2 (OBL-item-status-partition-and-close-*) — exhaustive item-status
//   partition, needs_clarification's home, the evidence-triple/vocabulary
//   widening (CDC-25/26/28/30), and the close-phase fixes each obligation names
//   (inv-1..inv-12, fail-1..fail-5) — see the dedicated section near the end of
//   this file.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { runTriagePhase } from "../../src/remediate/phases/triage.js";
import {
  buildReviewRequest,
  applyReviewResolution,
} from "../../src/remediate/review/reviewGate.js";
import { writeCurrentStep } from "../../src/remediate/steps/stepWriter.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import {
  createNextStepHarness,
  AUDIT_FIXTURE,
} from "./helpers/nextStepHarness.js";
import type { Finding } from "../../src/remediate/state/types.js";

// ── CP-NODE-2 static imports (INV-ISC inv-8) ────────────────────────────────
import {
  blockResolvedItemsOnCombinedFailure,
  buildRemediationOutcomesReport,
  buildVerificationReport,
  cleanupTempBranchesAndArtifacts,
  closingActionCompleted,
  runClosePhase,
  runCombinedTestSuite,
  type ClosingResult,
  type CombinedTestResult,
  type E2eTestResult,
} from "../../src/remediate/phases/close.js";
import {
  dispositionToOutcomeStatus,
  ITEM_STATUSES,
  isInProgressStatus,
  isSkipStatus,
  isUnsuccessfulEndStatus,
  isVerifiedCompleteStatus,
  requiresVerificationEvidence,
  resolveDisposition,
} from "../../src/remediate/state/itemStatus.js";
import type { RemediationItemState } from "../../src/remediate/state/types.js";
import { RemediationBlockSchema } from "../../src/remediate/state/types.js";
import { FindingSchema } from "audit-tools/shared";
import type { RunLogEvent, RunLogger } from "audit-tools/shared";
import { applyIntentOrdering } from "../../src/remediate/intent/intentOrdering.js";
import {
  isCompleteEvidence,
  mechanismContradictsOutcome,
  missingEvidenceParts,
  type Evidence,
  type EvidenceMechanismKind,
} from "../../src/shared/types/remediationOutcome.js";
import type { OrchestratorOptions } from "../../src/remediate/types/options.js";

/** A minimal fake RunLogger — `event()` records into `events`; cast because RunLogger has private fields and is not otherwise structurally assignable. */
function fakeRunLogger(): { runLogger: RunLogger; events: RunLogEvent[] } {
  const events: RunLogEvent[] = [];
  const runLogger = { event: (e: RunLogEvent) => { events.push(e); } } as unknown as RunLogger;
  return { runLogger, events };
}

// Scratch off the repo tree (the worktree may itself live under .audit-tools —
// tests must never root fixtures inside the tree the shared paths guard scans).
const SCRATCH = join(tmpdir(), "audit-tools-tests", ".cp-node-1-regressions");

function mkFinding(id: string, path: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    title: `Finding ${id}`,
    category: "correctness",
    severity: "high",
    confidence: "high",
    lens: "correctness",
    summary: `Fix ${id}.`,
    affected_files: [{ path }],
    evidence: [`${path}:1 evidence`],
    ...overrides,
  } as Finding;
}

beforeAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });
});

afterAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// DAT-017d52ff — INV-RSM-STATE-COMPLETE: status-conditional load validation
// ─────────────────────────────────────────────────────────────────────────────

describe("DAT-017d52ff StateStore rejects status-incomplete persisted states", () => {
  async function writeRawState(dirName: string, payload: unknown): Promise<StateStore> {
    const dir = join(SCRATCH, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), JSON.stringify(payload), "utf8");
    return new StateStore(dir);
  }

  const fullPlan = {
    plan_id: "PLAN-1",
    findings: [mkFinding("F-A", "src/a.ts")],
    blocks: [
      { block_id: "B-1", items: ["F-A"], parallel_safe: true, touched_files: [] },
    ],
    project_type: "unknown",
    candidate_closing_actions: ["none"],
  };
  const fullItems = {
    "F-A": { finding_id: "F-A", status: "pending", block_id: "B-1" },
  };

  it("NEGATIVE: an 'implementing' state with no plan/items fails load validation", async () => {
    const store = await writeRawState("store-impl-incomplete", {
      status: "implementing",
    });
    await expect(store.loadState()).rejects.toThrow(/schema validation/);
  });

  it("NEGATIVE: an item missing its identity fields fails load validation", async () => {
    const store = await writeRawState("store-item-identity", {
      status: "implementing",
      plan: fullPlan,
      items: { "F-A": { status: "pending" } },
    });
    await expect(store.loadState()).rejects.toThrow(/schema validation/);
  });

  it("NEGATIVE: a block omitting touched_files fails load validation", async () => {
    // `touched_files` is REQUIRED on the block contract (state/types.ts) and
    // `validateRemediationBlock` enforces it — but that validator is only reached
    // through `validateRemediationPlan`, never on the LOAD path. The load gate
    // checked only that `plan.blocks` is an array, so a block with no declared
    // surface loaded clean and every reader normalized the omission away with
    // `?? []` — i.e. a producer bug presenting as "collides with nothing" to the
    // host workload's declared edit surface. Two validators for one object,
    // disagreeing, with the weaker one on the load path.
    const store = await writeRawState("store-block-no-touched-files", {
      status: "implementing",
      plan: {
        ...fullPlan,
        blocks: [{ block_id: "B-1", items: ["F-A"], parallel_safe: true }],
      },
      items: fullItems,
    });
    await expect(store.loadState()).rejects.toThrow(/touched_files/);
  });

  it("POSITIVE: an EMPTY touched_files array stays legal on load", async () => {
    // The contract rejects an OMITTED field, not an empty one — a block may
    // legitimately declare an empty surface. Guards the obvious over-correction.
    const store = await writeRawState("store-block-empty-touched-files", {
      status: "implementing",
      plan: fullPlan,
      items: fullItems,
    });
    await expect(store.loadState()).resolves.toMatchObject({
      status: "implementing",
    });
  });

  it("NEGATIVE: a 'closing' state without a closing_plan fails load validation", async () => {
    const store = await writeRawState("store-closing-incomplete", {
      status: "closing",
      plan: fullPlan,
      items: fullItems,
    });
    await expect(store.loadState()).rejects.toThrow(/schema validation/);
  });

  it("POSITIVE: pending/planning/complete states have no completeness requirement", async () => {
    for (const status of ["pending", "planning", "complete"]) {
      const store = await writeRawState(`store-ok-${status}`, { status });
      await expect(store.loadState()).resolves.toMatchObject({ status });
    }
  });

  it("POSITIVE: a complete 'implementing'/'closing' state loads", async () => {
    const implStore = await writeRawState("store-ok-implementing", {
      status: "implementing",
      plan: fullPlan,
      items: fullItems,
    });
    await expect(implStore.loadState()).resolves.toMatchObject({
      status: "implementing",
    });
    const closingStore = await writeRawState("store-ok-closing", {
      status: "closing",
      plan: fullPlan,
      items: fullItems,
      closing_plan: { action: "none" },
    });
    await expect(closingStore.loadState()).resolves.toMatchObject({
      status: "closing",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COR-87f78167/-2 — triage post-resolution still-blocked guard + closing_plan
// ─────────────────────────────────────────────────────────────────────────────

describe("COR-87f78167 runTriagePhase re-batches still-blocked items after a partial resolution", () => {
  function triageState(): RemediationState {
    return {
      status: "triage",
      plan: {
        plan_id: "PLAN-T",
        findings: [mkFinding("F-A", "src/a.ts"), mkFinding("F-B", "src/b.ts")],
        blocks: [
          { block_id: "B-1", items: ["F-A"], parallel_safe: true, touched_files: [] },
          { block_id: "B-2", items: ["F-B"], parallel_safe: true, touched_files: [] },
        ],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-A": {
          finding_id: "F-A",
          status: "blocked",
          block_id: "B-1",
          failure_reason: "contract failure A",
        },
        "F-B": {
          finding_id: "F-B",
          status: "blocked",
          block_id: "B-2",
          failure_reason: "contract failure B",
        },
      },
    } as RemediationState;
  }

  async function setupTriageDir(name: string): Promise<{ root: string; artifactsDir: string }> {
    const root = join(SCRATCH, name);
    const artifactsDir = join(root, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    return { root, artifactsDir };
  }

  it("NEGATIVE: a resolution covering only SOME blocked items must NOT transition to closing", async () => {
    const { root, artifactsDir } = await setupTriageDir("triage-partial");
    await writeFile(
      join(artifactsDir, "triage_resolution.json"),
      JSON.stringify({ items: [{ finding_id: "F-A", action: "ignore" }] }),
      "utf8",
    );
    const result = await runTriagePhase(triageState(), { root, artifactsDir });
    // F-B is still blocked with no decision — closing would force-close it.
    expect(result.status).not.toBe("closing");
    expect(result.status).toBe("waiting_for_triage");
    // The still-blocked remainder is re-batched for the host.
    const batch = JSON.parse(
      await readFile(join(artifactsDir, "triage_batch.json"), "utf8"),
    ) as { items: Array<{ finding_id: string }> };
    expect(batch.items.map((i) => i.finding_id)).toEqual(["F-B"]);
    expect(result.items?.["F-A"]?.status).toBe("ignored");
  });

  it("POSITIVE: a resolution covering every blocked item transitions to closing WITH a closing_plan", async () => {
    const { root, artifactsDir } = await setupTriageDir("triage-full");
    await writeFile(
      join(artifactsDir, "triage_resolution.json"),
      JSON.stringify({
        items: [
          { finding_id: "F-A", action: "ignore" },
          { finding_id: "F-B", action: "ignore" },
        ],
      }),
      "utf8",
    );
    const result = await runTriagePhase(triageState(), { root, artifactsDir });
    expect(result.status).toBe("closing");
    // INV-RSM-STATE-COMPLETE: a closing state must persist a closing_plan.
    expect(result.closing_plan).toBeDefined();
  });

  it("POSITIVE: a halt resolution transitions to closing WITH a closing_plan", async () => {
    const { root, artifactsDir } = await setupTriageDir("triage-halt");
    await writeFile(
      join(artifactsDir, "triage_resolution.json"),
      JSON.stringify({ items: [{ finding_id: "F-A", action: "halt" }] }),
      "utf8",
    );
    const result = await runTriagePhase(triageState(), { root, artifactsDir });
    expect(result.status).toBe("closing");
    expect(result.closing_context).toBe("user_halted");
    expect(result.closing_plan).toBeDefined();
  });

  it("NEGATIVE: a stale triage_resolution (plan_id mismatch) is archived and treated as absent", async () => {
    const { root, artifactsDir } = await setupTriageDir("triage-stale");
    await writeFile(
      join(artifactsDir, "triage_resolution.json"),
      JSON.stringify({
        plan_id: "SOME-OLDER-RUN",
        items: [
          { finding_id: "F-A", action: "ignore" },
          { finding_id: "F-B", action: "ignore" },
        ],
      }),
      "utf8",
    );
    const result = await runTriagePhase(triageState(), { root, artifactsDir });
    // The stale resolution must not ignore this run's items.
    expect(result.items?.["F-A"]?.status).not.toBe("ignored");
    expect(result.items?.["F-B"]?.status).not.toBe("ignored");
    expect(existsSync(join(artifactsDir, "triage_resolution.json"))).toBe(false);
  });

  it("POSITIVE: a resolution carrying the matching plan_id is honoured", async () => {
    const { root, artifactsDir } = await setupTriageDir("triage-matching");
    await writeFile(
      join(artifactsDir, "triage_resolution.json"),
      JSON.stringify({
        plan_id: "PLAN-T",
        items: [
          { finding_id: "F-A", action: "ignore" },
          { finding_id: "F-B", action: "ignore" },
        ],
      }),
      "utf8",
    );
    const result = await runTriagePhase(triageState(), { root, artifactsDir });
    expect(result.status).toBe("closing");
    expect(result.items?.["F-A"]?.status).toBe("ignored");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COR-fb656e3f/-2 + OBS-89a57cbd/-2 — close-phase verdict + observability
// ─────────────────────────────────────────────────────────────────────────────

describe("COR-fb656e3f closingActionCompleted single-sources skipped-non-none-is-not-complete", () => {
  it("NEGATIVE→POSITIVE: closingActionCompleted exists and classifies correctly", () => {
    expect(typeof closingActionCompleted).toBe("function");
    expect(closingActionCompleted({ contract_version: "remediate-code-closing-result/v1alpha1", status: "success", action: "commit", commands: [] })).toBe(true);
    expect(closingActionCompleted({ contract_version: "remediate-code-closing-result/v1alpha1", status: "skipped", action: "none", commands: [] })).toBe(true);
    expect(closingActionCompleted({ contract_version: "remediate-code-closing-result/v1alpha1", status: "skipped", action: "publish", commands: [] })).toBe(false);
    expect(closingActionCompleted({ contract_version: "remediate-code-closing-result/v1alpha1", status: "failed", action: "commit", commands: [] })).toBe(false);
  });

  it("NEGATIVE: a skipped non-none closing action fails the verification report", () => {
    const state: RemediationState = {
      status: "closing",
      plan: {
        plan_id: "PLAN-V",
        findings: [mkFinding("F-A", "src/a.ts")],
        blocks: [
          { block_id: "B-1", items: ["F-A"], parallel_safe: true, touched_files: [] },
        ],
        project_type: "unknown",
        candidate_closing_actions: ["publish"],
      },
      items: {
        "F-A": { finding_id: "F-A", status: "resolved", block_id: "B-1" },
      },
      closing_plan: { action: "publish" },
    } as RemediationState;
    const artifactsDir = join(SCRATCH, "verif-report");
    const report = buildVerificationReport(
      state,
      { root: SCRATCH, artifactsDir } as OrchestratorOptions,
      {
        contract_version: "remediate-code-closing-result/v1alpha1",
        action: "publish",
        status: "skipped",
        commands: [],
      },
      { ran: true, passed: true, duration_ms: 0, output: "" },
    );
    const closingTrace = report.findings[0]!.traces.find((t) =>
      t.trace_id.endsWith(":closing"),
    );
    // The run never landed: the closing trace and the report verdict must be red.
    expect(closingTrace?.status).toBe("failed");
    expect(report.overall_status).toBe("failed");
  });

  it("POSITIVE: a successful closing action keeps the report green", () => {
    const state: RemediationState = {
      status: "closing",
      plan: {
        plan_id: "PLAN-V2",
        findings: [mkFinding("F-A", "src/a.ts")],
        blocks: [
          { block_id: "B-1", items: ["F-A"], parallel_safe: true, touched_files: [] },
        ],
        project_type: "unknown",
        candidate_closing_actions: ["commit"],
      },
      items: {
        "F-A": { finding_id: "F-A", status: "resolved", block_id: "B-1" },
      },
      closing_plan: { action: "commit" },
    } as RemediationState;
    const report = buildVerificationReport(
      state,
      { root: SCRATCH, artifactsDir: join(SCRATCH, "verif-report-green") } as OrchestratorOptions,
      {
        contract_version: "remediate-code-closing-result/v1alpha1",
        action: "commit",
        status: "success",
        commands: [],
      },
      { ran: true, passed: true, duration_ms: 0, output: "" },
    );
    expect(report.overall_status).toBe("passed");
  });
});

describe("OBS-89a57cbd final-state persist failure is surfaced, never silently swallowed", () => {
  it("NEGATIVE→POSITIVE: a failing final-state persist warns and emits a structured run-log event", async () => {
    expect(typeof cleanupTempBranchesAndArtifacts).toBe("function");
    const dir = join(SCRATCH, "obs-persist");
    await mkdir(dir, { recursive: true });
    // artifactsDir nested UNDER a regular file → StateStore.saveState must fail.
    await writeFile(join(dir, "blocker"), "not a directory", "utf8");
    const { runLogger, events } = fakeRunLogger();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await cleanupTempBranchesAndArtifacts(
        { root: dir, artifactsDir: join(dir, "blocker", "nested") } as OrchestratorOptions,
        { status: "complete" } as RemediationState,
        // combinedTest failed → the not-fully-green path (no artifacts delete).
        { ran: true, passed: false, duration_ms: 0, output: "boom" },
        { ran: false, passed: true, output: "" },
        {
          contract_version: "remediate-code-closing-result/v1alpha1",
          action: "none",
          status: "skipped",
          commands: [],
        },
        runLogger,
      );
      const persistEvents = events.filter((e) =>
        /final state|persist/i.test(e.note ?? ""),
      );
      expect(persistEvents.length).toBeGreaterThan(0);
      expect(
        warnSpy.mock.calls.some((call) =>
          call.some((arg) => /final state|persist/i.test(String(arg))),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("friction record outlives the fully-green close (archive-with-deliverables wiring)", () => {
  it("archives friction/<run>.json beside the promoted deliverables before deleting the artifacts dir", async () => {
    const root = join(SCRATCH, "friction-archive");
    const artifactsDir = join(root, ".audit-tools", "remediation");
    await mkdir(join(artifactsDir, "friction"), { recursive: true });
    const record = { open_observations: [{ category: "tool_should_decide" }] };
    await writeFile(
      join(artifactsDir, "friction", "run-77.json"),
      JSON.stringify(record),
      "utf8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let cleanupResult: Awaited<ReturnType<typeof cleanupTempBranchesAndArtifacts>>;
    try {
      cleanupResult = await cleanupTempBranchesAndArtifacts(
        { root, artifactsDir } as OrchestratorOptions,
        { status: "complete", items: {} } as RemediationState,
        { ran: true, passed: true, duration_ms: 0, output: "" },
        { ran: true, passed: true, output: "" },
        {
          contract_version: "remediate-code-closing-result/v1alpha1",
          action: "none",
          status: "skipped",
          commands: [],
        },
      );
    } finally {
      warnSpy.mockRestore();
    }
    expect(existsSync(artifactsDir), "fully-green close still deletes the artifacts dir").toBe(false);
    const archived = join(root, ".audit-tools", "remediation-friction-run-77.json");
    expect(existsSync(archived), "friction record must be archived beside the deliverables").toBe(true);
    expect(JSON.parse(await readFile(archived, "utf8"))).toEqual(record);
    // fail-4 (CleanupResult): a clean removal reports no residue.
    expect(cleanupResult.artifacts_residue).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COR-0b906e37/-2 — INV-RSM-RESOLUTION-CORRELATE (review side)
// ─────────────────────────────────────────────────────────────────────────────

describe("COR-0b906e37 review resolution/request plan_id correlation", () => {
  const request = buildReviewRequest([mkFinding("F-A", "src/a.ts")], "REVIEW-123");

  it("NEGATIVE: a resolution carrying a mismatched plan_id is rejected", () => {
    expect(() =>
      applyReviewResolution(request, {
        plan_id: "REVIEW-FROM-ANOTHER-RUN",
        disapproved_findings: ["F-A"],
      }),
    ).toThrow(/plan_id/);
  });

  it("POSITIVE: a resolution with the matching plan_id is honoured", () => {
    const decision = applyReviewResolution(request, {
      plan_id: "REVIEW-123",
      disapproved_findings: ["F-A"],
    });
    expect(decision.declined.map((d) => d.finding_id)).toEqual(["F-A"]);
  });

  it("POSITIVE: a resolution without a plan_id is still accepted (host-lenient)", () => {
    const decision = applyReviewResolution(request, {
      disapproved_findings: ["F-A"],
    });
    expect(decision.declined.map((d) => d.finding_id)).toEqual(["F-A"]);
    const approveAll = applyReviewResolution(request, null);
    expect(approveAll.approved_ids).toEqual(["F-A"]);
  });

  it("NEGATIVE→POSITIVE: isResolutionForRequest classifies correlation", async () => {
    const gate = (await import("../../src/remediate/review/reviewGate.js")) as Record<
      string,
      unknown
    >;
    expect(typeof gate.isResolutionForRequest).toBe("function");
    const isFor = gate.isResolutionForRequest as (
      request: unknown,
      resolution: unknown,
    ) => boolean;
    expect(isFor(request, { plan_id: "REVIEW-123" })).toBe(true);
    expect(isFor(request, {})).toBe(true);
    expect(isFor(request, null)).toBe(true);
    expect(isFor(request, { plan_id: "REVIEW-OTHER" })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COR-227a02ae — review decision replay honours approved_ids
// ─────────────────────────────────────────────────────────────────────────────

describe("COR-227a02ae review-gate replay honours the recorded approved_ids", () => {
  const h = createNextStepHarness(".cp-node-1-replay");

  afterAll(async () => {
    await h.cleanupTestRepo();
  });

  it("NEGATIVE: a decision approving only a subset must not re-approve the leftovers on replay", async () => {
    await h.resetTestRepo();
    await h.writeReadyStructuredAuditIntake(AUDIT_FIXTURE);
    // An autonomous-shaped decision: approved subset, declined EMPTY (leftovers
    // live but NOT approved). The replay must key on approved_ids, not declined.
    await writeFile(
      join(h.ARTIFACTS_DIR, "review_decision.json"),
      JSON.stringify({
        schema_version: "remediate-code-review-decision/v1",
        plan_id: "REVIEW-REPLAY",
        approved_ids: ["F-001"],
        declined: [],
        created_at: new Date().toISOString(),
      }),
      "utf8",
    );
    await decideNextStep({ root: h.REPO_DIR });
    // approved (1) < originals (2) ⇒ the pipeline source is swapped to the
    // approved-only filtered file. If the replay wrongly re-approves both, the
    // swap never happens (no approved-findings.json) — the red.
    const approvedPath = join(
      h.ARTIFACTS_DIR,
      "intake",
      "contract",
      "approved-findings.json",
    );
    expect(existsSync(approvedPath)).toBe(true);
    const approved = JSON.parse(await readFile(approvedPath, "utf8")) as {
      findings: Array<{ id: string }>;
    };
    expect(approved.findings.map((f) => f.id)).toEqual(["F-001"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CDC-402 pin — INV-RSM-STEP-WRITE-ROUTE holds on the remediate write path
// ─────────────────────────────────────────────────────────────────────────────

describe("CDC-402 pin: remediate current-step writes route through the shared step-contract writer", () => {
  it("POSITIVE: canonical current_step/current_prompt paths win over caller-supplied overrides", async () => {
    const artifactsDir = join(SCRATCH, "stepwriter-pin");
    await mkdir(artifactsDir, { recursive: true });
    const step = (await writeCurrentStep({
      stepKind: "collect_review_approval",
      status: "blocked",
      runId: "PIN-1",
      repoRoot: SCRATCH,
      artifactsDir,
      prompt: "pinned prompt",
      stopCondition: "stop",
      artifactPaths: {
        // A caller must never be able to repoint the host at a different
        // current-step.json (the shared writer's canonical-paths-win guard).
        current_step: "C:/evil/elsewhere/current-step.json",
        current_prompt: "C:/evil/elsewhere/current-prompt.md",
      },
    })) as unknown as {
      artifact_paths: Record<string, string>;
      prompt_path: string;
    };
    expect(step.artifact_paths.current_step).not.toContain("evil");
    expect(step.artifact_paths.current_prompt).not.toContain("evil");
    expect(step.artifact_paths.current_step!.replace(/\\/g, "/")).toContain("/steps/");
    // The prompt actually landed at the canonical path.
    expect(existsSync(step.prompt_path)).toBe(true);
    expect(await readFile(step.prompt_path, "utf8")).toContain("pinned prompt");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CP-NODE-2 (OBL-item-status-partition-and-close-*) — the exhaustive item-status
// partition, needs_clarification's home, the evidence-triple/vocabulary
// widening, and the close-phase fixes each obligation names. One describe per
// obligation (inv-1..inv-12, fail-1..fail-5); fail-3 is covered by the
// pre-existing OBS-89a57cbd describe above (unchanged behavior, only its
// `ran` field needed fixing to compile under the widened CombinedTestResult).
// ═════════════════════════════════════════════════════════════════════════════

/** A resolved-item OrchestratorOptions-shaped root/artifactsDir pair, freshly created under SCRATCH. */
async function makeCloseDirs(name: string): Promise<{ root: string; artifactsDir: string }> {
  const root = join(SCRATCH, name);
  const artifactsDir = join(root, ".audit-tools", "remediation");
  await mkdir(artifactsDir, { recursive: true });
  return { root, artifactsDir };
}

// ─────────────────────────────────────────────────────────────────────────────
// itemStatus.ts — resolveDisposition / requiresVerificationEvidence / dispositionToOutcomeStatus
// (direct unit coverage of the new pure functions inv-11/inv-12 build on)
// ─────────────────────────────────────────────────────────────────────────────

describe("itemStatus — resolveDisposition / requiresVerificationEvidence / dispositionToOutcomeStatus (CDC-25)", () => {
  it("POSITIVE: resolveDisposition falls back to statusToDisposition when no override is given", () => {
    expect(resolveDisposition("resolved")).toBe("resolved");
    expect(resolveDisposition("blocked")).toBe("abandoned");
  });

  it("NEGATIVE: resolveDisposition honours an explicit override over the status-derived default", () => {
    expect(resolveDisposition("resolved_no_change", "verified_already_fixed")).toBe("verified_already_fixed");
    expect(resolveDisposition("resolved", "refuted")).toBe("refuted");
  });

  it("POSITIVE: requiresVerificationEvidence is true for exactly the two CDC-25 members", () => {
    expect(requiresVerificationEvidence("verified_already_fixed")).toBe(true);
    expect(requiresVerificationEvidence("refuted")).toBe(true);
  });

  it("NEGATIVE: requiresVerificationEvidence is false for every original disposition — no new evidence requirement was imposed on them", () => {
    for (const d of ["resolved", "resolved_no_change", "ignored", "deemed_inappropriate", "abandoned"] as const) {
      expect(requiresVerificationEvidence(d), `${d} must not require evidence`).toBe(false);
    }
  });

  it("POSITIVE: dispositionToOutcomeStatus maps the two new members to their own, identically-named persisted form", () => {
    expect(dispositionToOutcomeStatus("verified_already_fixed")).toBe("verified_already_fixed");
    expect(dispositionToOutcomeStatus("refuted")).toBe("refuted");
    // Never collapsed onto verified_no_change (CDC-25's whole point).
    expect(dispositionToOutcomeStatus("verified_already_fixed")).not.toBe("verified_no_change");
    expect(dispositionToOutcomeStatus("refuted")).not.toBe("verified_no_change");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inv-1 — every RemediationItemStatus is classified by exactly one partition
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-inv-1: exhaustive per-axis partition", () => {
  it("POSITIVE: each of the 12 ITEM_STATUSES scores true on exactly one of {isInProgressStatus, isVerifiedCompleteStatus, isSkipStatus, isUnsuccessfulEndStatus}", () => {
    expect(ITEM_STATUSES.length).toBe(12);
    for (const status of ITEM_STATUSES) {
      const scores = [
        isInProgressStatus(status),
        isVerifiedCompleteStatus(status),
        isSkipStatus(status),
        isUnsuccessfulEndStatus(status),
      ].filter(Boolean).length;
      expect(scores, `status '${status}' must score exactly 1, scored ${scores}`).toBe(1);
    }
  });

  it("NEGATIVE: needs_clarification scores exactly 1 (isUnsuccessfulEndStatus only) — the HEAD defect (COR-d518cd60) this locks", () => {
    expect(isInProgressStatus("needs_clarification")).toBe(false);
    expect(isVerifiedCompleteStatus("needs_clarification")).toBe(false);
    expect(isSkipStatus("needs_clarification")).toBe(false);
    expect(isUnsuccessfulEndStatus("needs_clarification")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inv-2 — needs_clarification counts toward anyBlocked / blocks a green close
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-inv-2: needs_clarification blocks cleanupTempBranchesAndArtifacts's fullyGreen", () => {
  const closingResult: ClosingResult = {
    contract_version: "remediate-code-closing-result/v1alpha1",
    action: "none",
    status: "skipped",
    commands: [],
  };
  const combinedTest: CombinedTestResult = { ran: true, passed: true, duration_ms: 0, output: "" };
  const e2eResult: E2eTestResult = { ran: true, passed: true, output: "" };

  it("POSITIVE: a single resolved item computes fullyGreen and deletes the artifacts dir", async () => {
    const { root, artifactsDir } = await makeCloseDirs("isc-inv2-green");
    const result = await cleanupTempBranchesAndArtifacts(
      { root, artifactsDir } as OrchestratorOptions,
      { status: "complete", items: { "F-A": { finding_id: "F-A", status: "resolved", block_id: "B-1" } } } as RemediationState,
      combinedTest,
      e2eResult,
      closingResult,
    );
    expect(existsSync(artifactsDir)).toBe(false);
    expect(result.artifacts_residue).toBeUndefined();
  });

  it("NEGATIVE: a needs_clarification-only item computes anyBlocked and preserves the artifacts dir", async () => {
    const { root, artifactsDir } = await makeCloseDirs("isc-inv2-blocked");
    await cleanupTempBranchesAndArtifacts(
      { root, artifactsDir } as OrchestratorOptions,
      { status: "complete", items: { "F-A": { finding_id: "F-A", status: "needs_clarification", block_id: "B-1" } } } as RemediationState,
      combinedTest,
      e2eResult,
      closingResult,
    );
    expect(existsSync(artifactsDir), "artifacts dir must survive a needs_clarification-only close").toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inv-3 — original_state preserved for every non-terminal status; evidence
// floor shape; verified_already_fixed/refuted don't close the enum
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-inv-3: original_state preservation + the evidence-triple floor", () => {
  const closingResult: ClosingResult = {
    contract_version: "remediate-code-closing-result/v1alpha1",
    action: "none",
    status: "skipped",
    commands: [],
  };

  it("POSITIVE: buildRemediationOutcomesReport preserves original_state for a needs_clarification item (not only the five in-progress statuses)", () => {
    const state = {
      status: "closing",
      plan: {
        plan_id: "PLAN-NC",
        findings: [mkFinding("F-NC", "src/nc.ts")],
        blocks: [{ block_id: "B-1", items: ["F-NC"], parallel_safe: true, touched_files: [] }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: { "F-NC": { finding_id: "F-NC", status: "needs_clarification", block_id: "B-1" } },
    } as RemediationState;
    const report = buildRemediationOutcomesReport(state, closingResult);
    const outcome = report.outcomes.find((o) => o.finding_id === "F-NC")! as { outcome: string; original_state?: string };
    expect(outcome.outcome).toBe("blocked");
    expect(outcome.original_state).toBe("needs_clarification");
  });

  it("POSITIVE: the widened outcome record admits an evidence triple + attributing module as a floor, not a closed shape", () => {
    const evidence: Evidence = { file: "src/remediate/phases/close.ts", line: "146-149", mechanism: "red_green_test" };
    const state = {
      status: "closing",
      plan: {
        plan_id: "PLAN-EV",
        findings: [mkFinding("F-EV", "src/ev.ts")],
        blocks: [{ block_id: "B-1", items: ["F-EV"], parallel_safe: true, touched_files: [] }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-EV": { finding_id: "F-EV", status: "resolved", block_id: "B-1", evidence, recorded_by_module: "item-status-partition-and-close" },
      },
    } as unknown as RemediationState;
    const report = buildRemediationOutcomesReport(state, closingResult);
    const outcome = report.outcomes.find((o) => o.finding_id === "F-EV")!;
    expect(outcome.outcome).toBe("resolved");
    expect(outcome.evidence).toEqual(evidence);
    expect(outcome.recorded_by_module).toBe("item-status-partition-and-close");
    // Floor, not closed: the pre-existing fields are unaffected by evidence's presence.
    expect(outcome.finding_id).toBe("F-EV");
    expect(outcome.lens).toBe("correctness");
  });

  it("NEGATIVE: verified_already_fixed is expressible distinct from verified_no_change — the CDC-25 enum is not collapsed", () => {
    const evidence: Evidence = { file: "scripts/nightly/items.mjs", line: "69-76", mechanism: "read_at_head_verification" };
    const state = {
      status: "closing",
      plan: {
        plan_id: "PLAN-VAF",
        findings: [mkFinding("F-VAF", "src/vaf.ts")],
        blocks: [{ block_id: "B-1", items: ["F-VAF"], parallel_safe: true, touched_files: [] }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-VAF": {
          finding_id: "F-VAF",
          status: "resolved_no_change",
          block_id: "B-1",
          disposition_override: "verified_already_fixed",
          evidence,
        },
      },
    } as unknown as RemediationState;
    const report = buildRemediationOutcomesReport(state, closingResult);
    const outcome = report.outcomes.find((o) => o.finding_id === "F-VAF")!;
    expect(outcome.outcome).toBe("verified_already_fixed");
    expect(outcome.outcome).not.toBe("verified_no_change");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inv-4 — runCombinedTestSuite distinguishes never-ran from ran-and-passed
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-inv-4: never-ran vs ran-and-passed", () => {
  it("POSITIVE: a configured, passing test_command reports ran:true, passed:true, and a real suite_name", async () => {
    const state = { plan: { test_command: `node -e "process.exit(0)"` } } as unknown as RemediationState;
    const result = await runCombinedTestSuite(state, { root: SCRATCH, artifactsDir: SCRATCH } as OrchestratorOptions);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.suite_name).toBeTruthy();
  });

  it("NEGATIVE: an unset test_command reports ran:false — never a bare passed:true masquerading as a real run", async () => {
    const state = { plan: {} } as unknown as RemediationState;
    const result = await runCombinedTestSuite(state, { root: SCRATCH, artifactsDir: SCRATCH } as OrchestratorOptions);
    expect(result.ran).toBe(false);
    // passed stays true so pre-existing fullyGreen callers keep their
    // vacuously-green behavior for "nothing configured" (backward compatible);
    // `ran` is what lets a caller distinguish this from a genuine pass.
    expect(result.passed).toBe(true);
  });

  it("NEGATIVE: buildVerificationReport never labels a never-ran suite 'passed'", () => {
    const state = {
      status: "closing",
      plan: {
        plan_id: "PLAN-NR",
        findings: [mkFinding("F-NR", "src/nr.ts")],
        blocks: [{ block_id: "B-1", items: ["F-NR"], parallel_safe: true, touched_files: [] }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: { "F-NR": { finding_id: "F-NR", status: "resolved", block_id: "B-1" } },
    } as RemediationState;
    const combinedTest: CombinedTestResult = { ran: false, passed: true, duration_ms: 0, output: "" };
    const report = buildVerificationReport(
      state,
      { root: SCRATCH, artifactsDir: join(SCRATCH, "isc-inv4-report") } as OrchestratorOptions,
      { contract_version: "remediate-code-closing-result/v1alpha1", action: "none", status: "skipped", commands: [] },
      combinedTest,
    );
    const combinedTrace = report.findings[0]!.traces.find((t) => t.trace_id.endsWith(":combined-tests"))!;
    expect(combinedTrace.status).not.toBe("passed");
    expect(combinedTrace.evidence.join(" ")).not.toContain("combined test suite passed");
    expect(combinedTrace.evidence.join(" ")).toContain("no combined test suite configured");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inv-5 / fail-2 — the e2e-failure path transitions to triage ONLY when
// something was actually re-blocked, mirroring the combined-test-failure guard
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-inv-5 (+ fail-2): e2e-failure triage guard", () => {
  it("POSITIVE: runClosePhase transitions to triage when e2e fails and a resolved item is re-blocked", async () => {
    const { root, artifactsDir } = await makeCloseDirs("isc-inv5-triage");
    const state = {
      status: "closing",
      plan: {
        plan_id: "PLAN-E1",
        findings: [mkFinding("F-E1", "src/e1.ts")],
        blocks: [{ block_id: "B-1", items: ["F-E1"], parallel_safe: true, touched_files: ["src/e1.ts"] }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
        // The e2e child must REALLY RUN and REALLY FAIL. The single-quoted
        // form this used to carry is unconditionally refused by the declared-
        // shape gate, so runE2eTests returned the refusal without spawning —
        // and the test still went green ONLY because the refusal message echoes
        // the offending command verbatim, so the echoed `src/e1.ts` satisfied
        // the path-key join. That is passing on the wording of a refusal, not
        // on the invariant this test names. Failure text as a double-quoted
        // ARGUMENT instead.
        e2e_command:
          'node -e "process.stderr.write(process.argv[1]); process.exit(1)" "FAIL src/e1.ts"',
      },
      items: {
        "F-E1": {
          finding_id: "F-E1",
          status: "resolved",
          block_id: "B-1",
        },
      },
      closing_plan: { action: "none", pre_authorized: true },
    } as unknown as RemediationState;
    const next = await runClosePhase(state, { root, artifactsDir } as OrchestratorOptions);
    expect(next.status).toBe("triage");
    expect(next.items?.["F-E1"]?.status).toBe("blocked");
    // The recorded failure is the CHILD's stderr, never a shape-gate refusal
    // that skipped the spawn: without this pair the assertions above are
    // satisfied by a non-run whose refusal text happens to echo the path.
    expect(next.items?.["F-E1"]?.failure_reason).toContain("FAIL src/e1.ts");
    expect(next.items?.["F-E1"]?.failure_reason).not.toContain(
      "leaves the single-invocation command shape",
    );
  });

  it("NEGATIVE: runClosePhase does NOT transition to triage when e2e fails and nothing can be re-blocked", async () => {
    const { root, artifactsDir } = await makeCloseDirs("isc-inv5-no-block");
    const state = {
      status: "closing",
      plan: {
        plan_id: "PLAN-E2",
        findings: [mkFinding("F-E2", "src/e2.ts")],
        blocks: [{ block_id: "B-1", items: ["F-E2"], parallel_safe: true, touched_files: [] }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
        e2e_command: `node -e "process.exit(1)"`,
      },
      // No resolved/resolved_no_change items -> nothing for
      // blockResolvedItemsOnCombinedFailure to re-block.
      items: { "F-E2": { finding_id: "F-E2", status: "blocked", block_id: "B-1", failure_reason: "prior" } },
      closing_plan: { action: "none", pre_authorized: true },
    } as unknown as RemediationState;
    const next = await runClosePhase(state, { root, artifactsDir } as OrchestratorOptions);
    expect(next.status).not.toBe("triage");
    expect(next.status).toBe("complete");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inv-6 — blockResolvedItemsOnCombinedFailure uses a real path-key join
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-inv-6: real path-key join, never a bare substring test", () => {
  it("POSITIVE: an exact path-anchored match attributes the failure to only the matching item", () => {
    const state = {
      plan: {
        blocks: [
          { block_id: "B-1", items: ["F-1"], parallel_safe: true, touched_files: ["src/foo.ts"] },
          { block_id: "B-2", items: ["F-2"], parallel_safe: true, touched_files: ["src/unrelated.ts"] },
        ],
      },
      items: {
        "F-1": { finding_id: "F-1", status: "resolved", block_id: "B-1" },
        "F-2": { finding_id: "F-2", status: "resolved", block_id: "B-2" },
      },
    } as unknown as RemediationState;
    const blocked = blockResolvedItemsOnCombinedFailure(state, "FAIL src/foo.ts");
    expect(blocked).toBe(true);
    expect(state.items!["F-1"]!.status).toBe("blocked");
    expect(state.items!["F-2"]!.status).toBe("resolved");
  });

  it("NEGATIVE: a shared bare suffix ('myfoo.ts' vs implicated 'foo.ts') must NOT falsely attribute — the ambiguous-attribution fallback must instead block every resolved item, never leave the true culprit clear", () => {
    const state = {
      plan: {
        blocks: [
          { block_id: "B-1", items: ["F-innocent"], parallel_safe: true, touched_files: ["src/myfoo.ts"] },
          { block_id: "B-2", items: ["F-guilty"], parallel_safe: true, touched_files: ["src/other.ts"] },
        ],
      },
      items: {
        // Under the historical `ip.endsWith(tf) || tf.endsWith(ip)` bug,
        // "src/myfoo.ts" wrongly matches implicated "foo.ts" (bare suffix, no
        // '/' anchor), suppressing the conservative fallback and leaving
        // F-guilty (the genuinely unrelated item) incorrectly `resolved`.
        "F-innocent": { finding_id: "F-innocent", status: "resolved", block_id: "B-1" },
        "F-guilty": { finding_id: "F-guilty", status: "resolved", block_id: "B-2" },
      },
    } as unknown as RemediationState;
    const blocked = blockResolvedItemsOnCombinedFailure(state, "FAIL foo.ts");
    expect(blocked).toBe(true);
    // Fixed: no false match on "myfoo.ts" -> attribution is genuinely
    // ambiguous -> the conservative fallback blocks EVERY resolved item.
    expect(state.items!["F-innocent"]!.status).toBe("blocked");
    expect(state.items!["F-guilty"]!.status).toBe("blocked");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inv-7 — every close-phase early return emits a runLogger event
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-inv-7: every early return emits a runLogger event, not console-only", () => {
  it("POSITIVE: the preview-pause early return emits a runLogger event", async () => {
    const { root, artifactsDir } = await makeCloseDirs("isc-inv7-preview");
    const state = {
      status: "closing",
      plan: { plan_id: "PLAN-P1", findings: [], blocks: [], project_type: "unknown", candidate_closing_actions: ["commit"] },
      items: {},
      closing_plan: { action: "commit" }, // not pre_authorized -> preview pause
    } as unknown as RemediationState;
    const { runLogger, events } = fakeRunLogger();
    const next = await runClosePhase(state, { root, artifactsDir } as OrchestratorOptions, runLogger);
    expect(next.closing_plan?.closing_action_preview).toBeDefined();
    expect(events.some((e) => e.kind === "state")).toBe(true);
  });

  it("NEGATIVE: the combined-test-failure-to-triage early return emits a runLogger event (HEAD emitted nothing here)", async () => {
    const { root, artifactsDir } = await makeCloseDirs("isc-inv7-combined");
    const state = {
      status: "closing",
      plan: {
        plan_id: "PLAN-P2",
        findings: [mkFinding("F-P2", "src/p2.ts")],
        blocks: [{ block_id: "B-1", items: ["F-P2"], parallel_safe: true, touched_files: [] }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
        test_command: `node -e "process.exit(1)"`,
      },
      items: { "F-P2": { finding_id: "F-P2", status: "resolved", block_id: "B-1" } },
      closing_plan: { action: "none", pre_authorized: true },
    } as unknown as RemediationState;
    const { runLogger, events } = fakeRunLogger();
    const next = await runClosePhase(state, { root, artifactsDir } as OrchestratorOptions, runLogger);
    expect(next.status).toBe("triage");
    expect(events.some((e) => e.kind === "state" && /combined test suite failed/i.test(e.note ?? ""))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inv-9 — INV-ISC-CLOSE-PHASE-PRECONDITION
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-inv-9: INV-ISC-CLOSE-PHASE-PRECONDITION", () => {
  it("NEGATIVE: a needs_clarification item present means runClosePhase never deletes the artifacts dir, even with a completed closing action", async () => {
    const { root, artifactsDir } = await makeCloseDirs("isc-inv9");
    const state = {
      status: "closing",
      plan: {
        plan_id: "PLAN-P9",
        findings: [mkFinding("F-P9", "src/p9.ts")],
        blocks: [{ block_id: "B-1", items: ["F-P9"], parallel_safe: true, touched_files: [] }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: { "F-P9": { finding_id: "F-P9", status: "needs_clarification", block_id: "B-1" } },
      closing_plan: { action: "none", pre_authorized: true },
    } as unknown as RemediationState;
    await runClosePhase(state, { root, artifactsDir } as OrchestratorOptions);
    expect(existsSync(artifactsDir), "artifacts dir must survive: the coarse-reblock backstop never ran, and runClosePhase takes no dependency on it having run").toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inv-10 — INV-ISC-FINDING-BLOCK-SHAPE-PIN
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-inv-10: INV-ISC-FINDING-BLOCK-SHAPE-PIN", () => {
  it("POSITIVE: the schema-derived field set (not a hand-copied literal) contains id/severity/lens/affected_files and block.items", () => {
    const findingKeys = Object.keys(FindingSchema.shape);
    const blockKeys = Object.keys(RemediationBlockSchema.shape);
    for (const key of ["id", "severity", "lens", "affected_files"]) {
      expect(findingKeys, `FindingSchema must declare '${key}'`).toContain(key);
    }
    expect(blockKeys, "RemediationBlockSchema must declare 'items'").toContain("items");
  });

  it("NEGATIVE: applyIntentOrdering actually reads finding.severity and block.items to compute non-trivial ordering", () => {
    const low = mkFinding("F-LOW", "src/low.ts", { severity: "low" });
    const critical = mkFinding("F-CRIT", "src/crit.ts", { severity: "critical" });
    const blocks = [
      { block_id: "B-LOW", items: ["F-LOW"], parallel_safe: true, touched_files: [] },
      { block_id: "B-CRIT", items: ["F-CRIT"], parallel_safe: true, touched_files: [] },
    ];
    // A non-empty priority signal is required: `applyIntentOrdering` is a
    // strict no-op (returns the inputs unchanged) when the interpreted intent
    // carries no signal at all (empty lensWeights/prioritySignals/scopeEmphasis).
    const intent = { lensWeights: {}, prioritySignals: ["urgent"], scopeEmphasis: [] } as unknown as Parameters<typeof applyIntentOrdering>[2];
    const result = applyIntentOrdering([low, critical], blocks, intent);
    // critical must sort before low purely from severity — proves severity is read.
    expect(result.findings.map((f) => f.id)).toEqual(["F-CRIT", "F-LOW"]);
    expect(result.blocks.map((b) => b.block_id)).toEqual(["B-CRIT", "B-LOW"]);
  });

  // NO-REJECTION-OUTCOME: the remediate-side READER of `verification_status`.
  // Without one the field is write-only data that still reads as authoritative.
  it("orders a judge_confirmed finding ahead of an asserted one at equal severity", () => {
    const asserted = mkFinding("F-ASSERTED", "src/a.ts", {
      severity: "high",
      verification_status: "asserted",
    });
    const confirmed = mkFinding("F-CONFIRMED", "src/b.ts", {
      severity: "high",
      verification_status: "judge_confirmed",
    });
    const intent = {
      lensWeights: {},
      prioritySignals: ["urgent"],
      scopeEmphasis: [],
    } as unknown as Parameters<typeof applyIntentOrdering>[2];

    // Input order puts the asserted one first, so a pass-through would keep it
    // first: the tie-break is what moves the confirmed finding ahead.
    const result = applyIntentOrdering([asserted, confirmed], [], intent);
    expect(result.findings.map((f) => f.id)).toEqual([
      "F-CONFIRMED",
      "F-ASSERTED",
    ]);
  });

  it("never lets verification override severity", () => {
    const criticalAsserted = mkFinding("F-CRIT", "src/a.ts", {
      severity: "critical",
      verification_status: "asserted",
    });
    const lowConfirmed = mkFinding("F-LOW", "src/b.ts", {
      severity: "low",
      verification_status: "judge_confirmed",
    });
    const intent = {
      lensWeights: {},
      prioritySignals: ["urgent"],
      scopeEmphasis: [],
    } as unknown as Parameters<typeof applyIntentOrdering>[2];

    const result = applyIntentOrdering([lowConfirmed, criticalAsserted], [], intent);
    expect(result.findings.map((f) => f.id)).toEqual(["F-CRIT", "F-LOW"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inv-11 — INV-ISC-EVIDENCE-EMITTED
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-inv-11: INV-ISC-EVIDENCE-EMITTED", () => {
  function stateFor(item: Partial<RemediationItemState> & { finding_id: string }): RemediationState {
    return {
      status: "closing",
      plan: {
        plan_id: "PLAN-EVT",
        findings: [mkFinding(item.finding_id, "src/evt.ts")],
        blocks: [{ block_id: "B-1", items: [item.finding_id], parallel_safe: true, touched_files: [] }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: { [item.finding_id]: { block_id: "B-1", status: "resolved_no_change", ...item } },
    } as unknown as RemediationState;
  }
  const closingResult: ClosingResult = {
    contract_version: "remediate-code-closing-result/v1alpha1",
    action: "none",
    status: "skipped",
    commands: [],
  };

  it("POSITIVE: a complete evidence triple with a non-contradicting mechanism round-trips byte-exact and is attributed to the recording module", () => {
    const evidence: Evidence = { file: "src/remediate/phases/close.ts", line: "146-149", mechanism: "read_at_head_verification" };
    const state = stateFor({ finding_id: "F-COMPLETE", disposition_override: "verified_already_fixed", evidence, recorded_by_module: "moduleA" });
    const report = buildRemediationOutcomesReport(state, closingResult);
    const outcome = report.outcomes.find((o) => o.finding_id === "F-COMPLETE")!;
    expect(outcome.outcome).toBe("verified_already_fixed");
    expect(outcome.evidence).toEqual(evidence);
    expect(outcome.recorded_by_module).toBe("moduleA");
  });

  it("NEGATIVE: an incomplete evidence triple (missing file) refuses the terminal disposition, naming the missing part", () => {
    const state = stateFor({
      finding_id: "F-INCOMPLETE",
      disposition_override: "verified_already_fixed",
      evidence: { file: "", line: "10", mechanism: "read_at_head_verification" } as Evidence,
    });
    const report = buildRemediationOutcomesReport(state, closingResult);
    const outcome = report.outcomes.find((o) => o.finding_id === "F-INCOMPLETE")!;
    expect(outcome.outcome).toBe("blocked");
    expect(outcome.outcome).not.toBe("verified_already_fixed");
    expect(outcome.reason).toContain("INV-ISC-EVIDENCE-EMITTED refusal");
    expect(outcome.reason).toContain("missing");
  });

  it("NEGATIVE (the W4 witness): a verified_already_fixed disposition paired with a read-at-HEAD REFUTATION mechanism is refused as a WRONG VALUE, never emitted", () => {
    const state = stateFor({
      finding_id: "F-W4",
      disposition_override: "verified_already_fixed",
      evidence: { file: "src/a.ts", line: "1", mechanism: "read_at_head_refutation" },
    });
    const report = buildRemediationOutcomesReport(state, closingResult);
    const outcome = report.outcomes.find((o) => o.finding_id === "F-W4")!;
    expect(outcome.outcome).toBe("blocked");
    expect(outcome.reason).toContain("contradicts disposition");
  });

  it("POSITIVE: the same mechanism, correctly paired with refuted instead, is accepted (not a matter of interpretation)", () => {
    const state = stateFor({
      finding_id: "F-REFUTED",
      disposition_override: "refuted",
      evidence: { file: "src/a.ts", line: "1", mechanism: "read_at_head_refutation" },
    });
    const report = buildRemediationOutcomesReport(state, closingResult);
    const outcome = report.outcomes.find((o) => o.finding_id === "F-REFUTED")!;
    expect(outcome.outcome).toBe("refuted");
  });

  it("NEGATIVE: the ordinary five dispositions never require evidence — an unset evidence still lands a green resolved outcome", () => {
    const state = stateFor({ finding_id: "F-PLAIN", status: "resolved" });
    const report = buildRemediationOutcomesReport(state, closingResult);
    const outcome = report.outcomes.find((o) => o.finding_id === "F-PLAIN")!;
    expect(outcome.outcome).toBe("resolved");
    expect(outcome.evidence).toBeUndefined();
  });

  it("NEGATIVE: mutating the writer to drop the attributing-module stamp is what the ATTRIBUTION ROUND-TRIP guards against — asserted directly on isCompleteEvidence/missingEvidenceParts/mechanismContradictsOutcome", () => {
    // Direct unit coverage of the three shared predicates the writer composes.
    expect(isCompleteEvidence(undefined)).toBe(false);
    expect(isCompleteEvidence({ file: "a", line: "1", mechanism: "red_green_test" })).toBe(true);
    expect(missingEvidenceParts({ file: "", line: "", mechanism: undefined as unknown as EvidenceMechanismKind })).toEqual(["file", "line", "mechanism"]);
    expect(mechanismContradictsOutcome("refuted", "read_at_head_verification")).toBe(true);
    expect(mechanismContradictsOutcome("verified_already_fixed", "read_at_head_refutation")).toBe(true);
    expect(mechanismContradictsOutcome("refuted", "read_at_head_refutation")).toBe(false);
    expect(mechanismContradictsOutcome("resolved", "red_green_test")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inv-12 — INV-COVERAGE-item-status-partition-and-close
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-inv-12: INV-COVERAGE — this module's 9 owned ids", () => {
  const OWNED_IDS = [
    "COR-305e7ec5", "COR-305e7ec5-2", "COR-d518cd60", "MNT-305e7ec5",
    "MNT-ed925a61", "OBS-305e7ec5", "TST-305e7ec5", "TST-305e7ec5-2", "TST-305e7ec5-3",
  ];
  const TERMINAL_PERSISTED = new Set(["resolved", "verified_no_change", "verified_already_fixed", "refuted"]);
  const closingResult: ClosingResult = {
    contract_version: "remediate-code-closing-result/v1alpha1",
    action: "none",
    status: "skipped",
    commands: [],
  };

  it("POSITIVE: all 9 owned ids, dispositioned under T (mixing resolved / verified_already_fixed / refuted) with complete evidence, are GREEN-shaped records", () => {
    const findings = OWNED_IDS.map((id) => mkFinding(id, "src/close.ts"));
    const items: Record<string, unknown> = {};
    OWNED_IDS.forEach((id, i) => {
      const disposition = i % 3 === 0 ? "verified_already_fixed" : i % 3 === 1 ? "refuted" : undefined;
      const mechanism: EvidenceMechanismKind =
        disposition === "verified_already_fixed" ? "read_at_head_verification"
        : disposition === "refuted" ? "read_at_head_refutation"
        : "red_green_test";
      items[id] = {
        finding_id: id,
        status: "resolved_no_change",
        block_id: "B-1",
        ...(disposition ? { disposition_override: disposition } : {}),
        evidence: { file: "src/remediate/phases/close.ts", line: `${100 + i}`, mechanism },
        recorded_by_module: "item-status-partition-and-close",
      };
    });
    const state = {
      status: "closing",
      plan: {
        plan_id: "PLAN-COV",
        findings,
        blocks: [{ block_id: "B-1", items: OWNED_IDS, parallel_safe: true, touched_files: [] }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items,
    } as unknown as RemediationState;
    const report = buildRemediationOutcomesReport(state, closingResult);
    for (const id of OWNED_IDS) {
      const outcome = report.outcomes.find((o) => o.finding_id === id)!;
      expect(TERMINAL_PERSISTED.has(outcome.outcome), `${id} must persist a T-member, got '${outcome.outcome}'`).toBe(true);
      expect(outcome.evidence, `${id} must carry evidence`).toBeDefined();
      expect(outcome.evidence!.file.length, `${id} evidence.file must be non-empty`).toBeGreaterThan(0);
      expect(outcome.evidence!.line.length, `${id} evidence.line must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("NEGATIVE: the all-blocked witness — every owned id recorded blocked-with-reason falls outside the persisted terminal set", () => {
    const findings = OWNED_IDS.map((id) => mkFinding(id, "src/close.ts"));
    const items: Record<string, unknown> = {};
    for (const id of OWNED_IDS) {
      items[id] = { finding_id: id, status: "blocked", block_id: "B-1", failure_reason: "still open" };
    }
    const state = {
      status: "closing",
      plan: {
        plan_id: "PLAN-COV-RED",
        findings,
        blocks: [{ block_id: "B-1", items: OWNED_IDS, parallel_safe: true, touched_files: [] }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items,
    } as unknown as RemediationState;
    const report = buildRemediationOutcomesReport(state, closingResult);
    for (const id of OWNED_IDS) {
      const outcome = report.outcomes.find((o) => o.finding_id === id)!;
      expect(TERMINAL_PERSISTED.has(outcome.outcome), `${id} must NOT be in the persisted terminal set while blocked`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fail-1 — runClosePhase requires plan, items, and closing_plan
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-fail-1: runClosePhase's precondition guard", () => {
  it("NEGATIVE: missing closing_plan throws synchronously", async () => {
    const state = {
      plan: { plan_id: "P", findings: [], blocks: [], project_type: "unknown", candidate_closing_actions: [] },
      items: {},
    } as unknown as RemediationState;
    await expect(
      runClosePhase(state, { root: SCRATCH, artifactsDir: join(SCRATCH, "isc-fail1") } as OrchestratorOptions),
    ).rejects.toThrow(/missing plan, items, or closing_plan/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fail-5 — closingActionCompleted false keeps fullyGreen false
// ─────────────────────────────────────────────────────────────────────────────

describe("OBL-item-status-partition-and-close-fail-5: a skipped non-none closing action preserves the artifacts dir", () => {
  it("NEGATIVE: a skipped non-none closing action (not completed) preserves the artifacts dir even with passing tests and no blocked items", async () => {
    const { root, artifactsDir } = await makeCloseDirs("isc-fail5");
    const result = await cleanupTempBranchesAndArtifacts(
      { root, artifactsDir } as OrchestratorOptions,
      { status: "complete", items: { "F-1": { finding_id: "F-1", status: "resolved", block_id: "B-1" } } } as RemediationState,
      { ran: true, passed: true, duration_ms: 0, output: "" },
      { ran: true, passed: true, output: "" },
      { contract_version: "remediate-code-closing-result/v1alpha1", action: "publish", status: "skipped", commands: [] },
    );
    expect(existsSync(artifactsDir)).toBe(true);
    expect(result.artifacts_residue).toBeUndefined(); // removal never attempted, not a residue
  });

  it("POSITIVE: action:'none' skipped (the legitimate no-op) still deletes the artifacts dir", async () => {
    const { root, artifactsDir } = await makeCloseDirs("isc-fail5-green");
    await cleanupTempBranchesAndArtifacts(
      { root, artifactsDir } as OrchestratorOptions,
      { status: "complete", items: { "F-1": { finding_id: "F-1", status: "resolved", block_id: "B-1" } } } as RemediationState,
      { ran: true, passed: true, duration_ms: 0, output: "" },
      { ran: true, passed: true, output: "" },
      { contract_version: "remediate-code-closing-result/v1alpha1", action: "none", status: "skipped", commands: [] },
    );
    expect(existsSync(artifactsDir)).toBe(false);
  });
});
