// CP-NODE-1 red-green regression suite — remediate-state-machine module contract.
//
// One test group per finding cluster, POSITIVE/NEGATIVE-prefixed assertions per
// the test_validator_plan style. Written FIRST (red on the unfixed tree), then
// the fixes turn them green. New symbols the fixes introduce (rollbackBaseToOid,
// closingActionCompleted, buildVerificationReport export, isResolutionForRequest,
// cleanupTempBranchesAndArtifacts export) are reached via dynamic import so each
// cluster reds granularly instead of the whole file dying on a missing static
// import.
//
// Covered clusters:
//   COR-8c497987   verifyCommands.ts  — per-invocation build-free validation
//   COR-0ad18f1a/-2 ownershipRegistry — inFlightClaims + root round-trip
//   DAT-017d52ff   store.ts           — status-conditional state completeness
//   COR-46fff0ec   plan.ts            — split preserves verification + phase metadata
//   COR-87f78167/-2 triage.ts         — post-resolution still-blocked guard + closing_plan
//   COR-fb656e3f/-2 close.ts          — skipped-non-none closing is not complete
//   OBS-89a57cbd/-2 close.ts          — final-state persist failure is surfaced
//   COR-0b906e37/-2 reviewGate.ts     — resolution/request plan_id correlation
//   COR-227a02ae   nextStep.ts        — decision replay honours approved_ids
//   COR-5f8fb354   nextStep.ts        — session-config autonomous_mode reaches the gate
//   COR-586b493e   acceptNode.ts      — verified base rollback (rollbackBaseToOid)
//   CDC-402 pin    stepWriter          — current-step writes route through the shared writer

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

import { isBuildFreeVerifyCommand } from "../../src/remediate/steps/dispatch/verifyCommands.js";
import { OwnershipRegistry } from "../../src/remediate/dispatch/ownershipRegistry.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { splitBlocksByContextBudget } from "../../src/remediate/phases/plan.js";
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
import type { Finding, RemediationBlock } from "../../src/remediate/state/types.js";

// Scratch off the repo tree (the worktree may itself live under .audit-tools —
// tests must never root fixtures inside the tree the shared paths guard scans).
const SCRATCH = join(tmpdir(), "audit-tools-tests", ".cp-node-1-regressions");

function git(cwd: string, ...args: string[]): string {
  const r = spawnSyncHidden("git", args, { cwd, encoding: "utf8", shell: false });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr ?? r.error?.message}`);
  }
  return (r.stdout ?? "").toString().trim();
}

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
// COR-8c497987 — INV-RSM-VERIFY-01: per-invocation build-free validation
// ─────────────────────────────────────────────────────────────────────────────

describe("COR-8c497987 isBuildFreeVerifyCommand judges each invocation, not the whole string", () => {
  it("NEGATIVE: a compound command whose second tsc invocation emits is forbidden", () => {
    expect(
      isBuildFreeVerifyCommand("npx tsc --noEmit && npx tsc -p tsconfig.build.json"),
    ).toBe(false);
  });

  it("NEGATIVE: a semicolon-chained bare tsc after a noEmit segment is forbidden", () => {
    expect(isBuildFreeVerifyCommand("tsc --noEmit; tsc")).toBe(false);
  });

  it("NEGATIVE: a newline-chained npm run build hidden behind a check is forbidden", () => {
    expect(isBuildFreeVerifyCommand("npm run check\nnpm run build")).toBe(false);
  });

  it("NEGATIVE: a pipe-chained npm test segment is forbidden", () => {
    expect(isBuildFreeVerifyCommand("npm run check || npm test")).toBe(false);
  });

  it("POSITIVE: compound commands whose every invocation is build-free stay allowed", () => {
    expect(
      isBuildFreeVerifyCommand("npx tsc --noEmit && npx vitest run tests/x.test.ts"),
    ).toBe(true);
    expect(isBuildFreeVerifyCommand("npm run check")).toBe(true);
    expect(isBuildFreeVerifyCommand("npx vitest run tests/a.test.ts")).toBe(true);
  });

  it("POSITIVE: single-invocation build commands are still forbidden", () => {
    expect(isBuildFreeVerifyCommand("npm run build")).toBe(false);
    expect(isBuildFreeVerifyCommand("tsc -b")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm test")).toBe(false);
    expect(isBuildFreeVerifyCommand("")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COR-0ad18f1a / COR-70a46faa — OwnershipRegistry restart survival
// ─────────────────────────────────────────────────────────────────────────────

describe("COR-0ad18f1a/COR-70a46faa OwnershipRegistry serialize/fromJson round-trip", () => {
  it("NEGATIVE→POSITIVE: in-flight scheduling claims survive a serialize/fromJson restart", () => {
    const reg = new OwnershipRegistry();
    reg.initialize([
      { node_id: "N1", write_paths: ["src/a.ts"] },
      { node_id: "N2", write_paths: ["src/b.ts"] },
    ]);
    reg.claimInFlight("N1", ["src/a.ts"]);
    const restored = OwnershipRegistry.fromJson(
      reg.serialize(),
      new Set(["N1", "N2"]),
    );
    // INV-SOO-01: after a restart the in-flight writer claim must still be held,
    // or a foreign same-file node is admitted boundary-ungated.
    expect(restored.inFlightOwner("src/a.ts")).toBe("N1");
    expect(restored.isFileOwnershipDisjoint("N2", ["src/a.ts"])).toBe(false);
  });

  it("POSITIVE: stale in-flight claims (node no longer in the DAG) are purged on restore", () => {
    const reg = new OwnershipRegistry();
    reg.initialize([{ node_id: "GONE", write_paths: ["src/a.ts"] }]);
    reg.claimInFlight("GONE", ["src/a.ts"]);
    const restored = OwnershipRegistry.fromJson(reg.serialize(), new Set(["N1"]));
    expect(restored.inFlightOwner("src/a.ts")).toBeUndefined();
  });

  it("NEGATIVE→POSITIVE: the canonicalization root survives the round-trip (INV-SOO-09)", () => {
    const root = join(SCRATCH, "reg-root");
    const reg = new OwnershipRegistry(undefined, root);
    reg.initialize([{ node_id: "N1", write_paths: ["src/a.ts"] }]);
    reg.claimInFlight("N1", ["src/a.ts"]);
    const json = reg.serialize() as { root?: string };
    expect(json.root).toBe(root);
    const restored = OwnershipRegistry.fromJson(
      reg.serialize(),
      new Set(["N1"]),
    );
    // A differently-spelled same file must still collide after the restore —
    // only possible when the canonicalization root was restored too.
    expect(restored.inFlightOwner(join(root, "src", "a.ts"))).toBe("N1");
  });
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
// COR-46fff0ec — INV-RSM-SPLIT-01: split preserves verification + phase metadata
// ─────────────────────────────────────────────────────────────────────────────

describe("COR-46fff0ec splitBlocksByContextBudget preserves targeted_commands + phase_ordinal", () => {
  const splitRoot = join(SCRATCH, "split-root");
  const findings = [mkFinding("F-A", "src/a.ts"), mkFinding("F-B", "src/b.ts")];
  const block: RemediationBlock = {
    block_id: "B-SPLIT",
    items: ["F-A", "F-B"],
    parallel_safe: true,
    touched_files: ["src/a.ts", "src/b.ts"],
    phase_ordinal: 3,
    targeted_commands: [
      "npm run check",
      "npx vitest run src/a.ts",
      "node scripts/check-unrelated.mjs",
    ],
  };

  it("NEGATIVE→POSITIVE: every sub-block carries the parent phase_ordinal unchanged", () => {
    // Budget below two per-item costs forces a two-way split (0-byte files, so
    // each singleton group costs 900 base + 600 item overhead = 1500 tokens).
    const result = splitBlocksByContextBudget([block], findings, splitRoot, 2000);
    expect(result.length).toBe(2);
    for (const sub of result) {
      // A split must never erase the phase barrier — a consumer sub-block with
      // no ordinal dispatches alongside its foundations (INV-RSM-SPLIT-01).
      expect(sub.phase_ordinal).toBe(3);
    }
  });

  it("NEGATIVE→POSITIVE: targeted_commands partition by relevance; path-less and unmatched carry to all", () => {
    const result = splitBlocksByContextBudget([block], findings, splitRoot, 2000);
    expect(result.length).toBe(2);
    const subA = result.find((b) => b.items.includes("F-A"))!;
    const subB = result.find((b) => b.items.includes("F-B"))!;
    // Path-less command → every sub-block (no false-red, no vacuous pass).
    expect(subA.targeted_commands).toContain("npm run check");
    expect(subB.targeted_commands).toContain("npm run check");
    // Pathful command citing src/a.ts → ONLY the sub-block owning F-A.
    expect(subA.targeted_commands).toContain("npx vitest run src/a.ts");
    expect(subB.targeted_commands ?? []).not.toContain("npx vitest run src/a.ts");
    // Pathful command matching no sub-block → carried to all, never dropped.
    expect(subA.targeted_commands).toContain("node scripts/check-unrelated.mjs");
    expect(subB.targeted_commands).toContain("node scripts/check-unrelated.mjs");
  });

  it("POSITIVE: an unsplit block passes through with its metadata intact", () => {
    const result = splitBlocksByContextBudget([block], findings, splitRoot, 10_000_000);
    expect(result.length).toBe(1);
    expect(result[0]!.phase_ordinal).toBe(3);
    expect(result[0]!.targeted_commands).toEqual(block.targeted_commands);
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
    // A skipped NON-none close did not complete — e.g. merge-to-base with no
    // recorded base leaves the run unmerged.
    expect(completed({ status: "skipped", action: "merge-to-base", commands: [] })).toBe(false);
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
        candidate_closing_actions: ["merge-to-base"],
      },
      items: {
        "F-A": { finding_id: "F-A", status: "resolved", block_id: "B-1" },
      },
      closing_plan: { action: "merge-to-base" },
    } as RemediationState;
    const artifactsDir = join(SCRATCH, "verif-report");
    const report = build(
      state,
      { root: SCRATCH, artifactsDir },
      {
        contract_version: "remediate-code-closing-result/v1alpha1",
        action: "merge-to-base",
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
// COR-5f8fb354 — session-config autonomous_mode reaches the review gate
// ─────────────────────────────────────────────────────────────────────────────

describe("COR-5f8fb354 the review gate resolves autonomy from the persisted session config", () => {
  const h = createNextStepHarness(".cp-node-1-autonomy");

  afterAll(async () => {
    await h.cleanupTestRepo();
  });

  it("NEGATIVE: with session-config autonomous_mode=true the gate must not halt for a human", async () => {
    await h.resetTestRepo();
    await h.writeReadyStructuredAuditIntake(AUDIT_FIXTURE);
    await writeFile(
      join(h.REPO_DIR, "session-config.json"),
      JSON.stringify({ autonomous_mode: true }),
      "utf8",
    );
    const step = await decideNextStep({ root: h.REPO_DIR });
    // The unattended gate never halts: it records an autonomous decision and
    // proceeds (leftovers re-emitted, not durably rejected).
    expect(step.step_kind).not.toBe("collect_review_approval");
    expect(existsSync(join(h.ARTIFACTS_DIR, "review_decision.json"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COR-586b493e — verified base rollback (rollbackBaseToOid)
// ─────────────────────────────────────────────────────────────────────────────

describe("COR-586b493e rollbackBaseToOid verifies the reset instead of firing blind", () => {
  it("NEGATIVE→POSITIVE: rollbackBaseToOid exists, resets to the target OID, and verifies HEAD", async () => {
    const acceptNode = (await import(
      "../../src/remediate/steps/dispatch/acceptNode.js"
    )) as Record<string, unknown>;
    expect(typeof acceptNode.rollbackBaseToOid).toBe("function");
    const rollback = acceptNode.rollbackBaseToOid as (
      root: string,
      baseOid: string,
      filesToClean?: Iterable<string>,
    ) => { ok: boolean; detail?: string };

    const repo = join(SCRATCH, "rollback-repo");
    await mkdir(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    await writeFile(join(repo, "f.txt"), "one\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "first");
    const firstOid = git(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "f.txt"), "two\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "second");

    const ok = rollback(repo, firstOid, ["f.txt"]);
    expect(ok.ok).toBe(true);
    expect(git(repo, "rev-parse", "HEAD")).toBe(firstOid);
  });

  it("NEGATIVE: a rollback to an unreachable OID reports failure loudly", async () => {
    const acceptNode = (await import(
      "../../src/remediate/steps/dispatch/acceptNode.js"
    )) as Record<string, unknown>;
    const rollback = acceptNode.rollbackBaseToOid as (
      root: string,
      baseOid: string,
      filesToClean?: Iterable<string>,
    ) => { ok: boolean; detail?: string };
    const repo = join(SCRATCH, "rollback-repo"); // reuse the repo above
    const res = rollback(repo, "0123456789abcdef0123456789abcdef01234567");
    expect(res.ok).toBe(false);
    expect(res.detail).toBeTruthy();
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
