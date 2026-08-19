// CP-NODE-1 red-green regression suite — remediate-state-machine module contract.
//
// One test group per finding cluster, POSITIVE/NEGATIVE-prefixed assertions per
// the test_validator_plan style. Written FIRST (red on the unfixed tree), then
// the fixes turn them green. New symbols the fixes introduce
// (closingActionCompleted, buildVerificationReport export, isResolutionForRequest,
// cleanupTempBranchesAndArtifacts export) are reached via dynamic import so each
// cluster reds granularly instead of the whole file dying on a missing static
// import.
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
  it("NEGATIVE→POSITIVE: closingActionCompleted exists and classifies correctly", async () => {
    const close = (await import("../../src/remediate/phases/close.js")) as Record<
      string,
      unknown
    >;
    expect(typeof close.closingActionCompleted).toBe("function");
    const completed = close.closingActionCompleted as (r: unknown) => boolean;
    expect(completed({ status: "success", action: "commit", commands: [] })).toBe(true);
    expect(completed({ status: "skipped", action: "none", commands: [] })).toBe(true);
    expect(completed({ status: "skipped", action: "publish", commands: [] })).toBe(false);
    expect(completed({ status: "failed", action: "commit", commands: [] })).toBe(false);
  });

  it("NEGATIVE: a skipped non-none closing action fails the verification report", async () => {
    const close = (await import("../../src/remediate/phases/close.js")) as Record<
      string,
      unknown
    >;
    expect(typeof close.buildVerificationReport).toBe("function");
    const build = close.buildVerificationReport as (
      state: unknown,
      options: unknown,
      closingResult: unknown,
      combinedTest: unknown,
    ) => { overall_status: string; findings: Array<{ finding_id: string; traces: Array<{ trace_id: string; status: string }> }> };
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
    const report = build(
      state,
      { root: SCRATCH, artifactsDir },
      {
        contract_version: "remediate-code-closing-result/v1alpha1",
        action: "publish",
        status: "skipped",
        commands: [],
      },
      { passed: true, duration_ms: 0, output: "" },
    );
    const closingTrace = report.findings[0]!.traces.find((t) =>
      t.trace_id.endsWith(":closing"),
    );
    // The run never landed: the closing trace and the report verdict must be red.
    expect(closingTrace?.status).toBe("failed");
    expect(report.overall_status).toBe("failed");
  });

  it("POSITIVE: a successful closing action keeps the report green", async () => {
    const close = (await import("../../src/remediate/phases/close.js")) as Record<
      string,
      unknown
    >;
    const build = close.buildVerificationReport as (
      state: unknown,
      options: unknown,
      closingResult: unknown,
      combinedTest: unknown,
    ) => { overall_status: string };
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
    const report = build(
      state,
      { root: SCRATCH, artifactsDir: join(SCRATCH, "verif-report-green") },
      {
        contract_version: "remediate-code-closing-result/v1alpha1",
        action: "commit",
        status: "success",
        commands: [],
      },
      { passed: true, duration_ms: 0, output: "" },
    );
    expect(report.overall_status).toBe("passed");
  });
});

describe("OBS-89a57cbd final-state persist failure is surfaced, never silently swallowed", () => {
  it("NEGATIVE→POSITIVE: a failing final-state persist warns and emits a structured run-log event", async () => {
    const close = (await import("../../src/remediate/phases/close.js")) as Record<
      string,
      unknown
    >;
    expect(typeof close.cleanupTempBranchesAndArtifacts).toBe("function");
    const cleanup = close.cleanupTempBranchesAndArtifacts as (
      options: unknown,
      completeState: unknown,
      combinedTest: unknown,
      e2eResult: unknown,
      closingResult: unknown,
      runLogger?: unknown,
    ) => Promise<void>;
    const dir = join(SCRATCH, "obs-persist");
    await mkdir(dir, { recursive: true });
    // artifactsDir nested UNDER a regular file → StateStore.saveState must fail.
    await writeFile(join(dir, "blocker"), "not a directory", "utf8");
    const events: Array<{ note?: string }> = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await cleanup(
        { root: dir, artifactsDir: join(dir, "blocker", "nested") },
        { status: "complete" },
        // combinedTest failed → the not-fully-green path (no artifacts delete).
        { passed: false, duration_ms: 0, output: "boom" },
        { ran: false, passed: true, output: "" },
        {
          contract_version: "remediate-code-closing-result/v1alpha1",
          action: "none",
          status: "skipped",
          commands: [],
        },
        { event: (e: { note?: string }) => events.push(e) },
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
    const close = (await import("../../src/remediate/phases/close.js")) as Record<
      string,
      unknown
    >;
    const cleanup = close.cleanupTempBranchesAndArtifacts as (
      options: unknown,
      completeState: unknown,
      combinedTest: unknown,
      e2eResult: unknown,
      closingResult: unknown,
      runLogger?: unknown,
    ) => Promise<void>;
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
    try {
      await cleanup(
        { root, artifactsDir },
        { status: "complete", items: {} },
        { passed: true, duration_ms: 0, output: "" },
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
