// Tests for N-CE301: partial-completion terminal — remediate-code consumer hook

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "../src/state/store.js";
import type { RemediationState } from "../src/state/store.js";
import { decideNextStep } from "../src/steps/nextStep.js";
import type { PartialCompletionTerminal } from "@audit-tools/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-partial-terminal");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

function makeImplementingState(
  terminalOverride?: PartialCompletionTerminal,
  extraItems: Record<string, RemediationState["items"] extends Record<string, infer V> ? V : never> = {},
): RemediationState {
  const items: NonNullable<RemediationState["items"]> = {
    "F-001": {
      finding_id: "F-001",
      status: "pending",
      block_id: "B-001",
      item_spec: {
        finding_id: "F-001",
        concrete_change: "add null check",
        tests_to_write: [],
        not_applicable_steps: [],
      },
    },
    "F-002": {
      finding_id: "F-002",
      status: "pending",
      block_id: "B-002",
    },
    ...extraItems,
  };

  const state: RemediationState = {
    status: "implementing",
    plan: {
      plan_id: "PLAN-TERMINAL",
      findings: [
        {
          id: "F-001",
          title: "Finding 1",
          category: "correctness",
          severity: "high",
          confidence: "high",
          lens: "correctness",
          summary: "Something is wrong.",
          affected_files: [{ path: "src/a.ts" }],
          evidence: [],
        },
        {
          id: "F-002",
          title: "Finding 2",
          category: "tests",
          severity: "low",
          confidence: "medium",
          lens: "tests",
          summary: "Tests missing.",
          affected_files: [{ path: "src/b.ts" }],
          evidence: [],
        },
      ],
      blocks: [
        { block_id: "B-001", items: ["F-001"], parallel_safe: true },
        { block_id: "B-002", items: ["F-002"], parallel_safe: true },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items,
    closing_plan: { action: "none" },
  };

  if (terminalOverride) {
    state.partial_completion_terminal = terminalOverride;
  }

  return state;
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

describe("N-CE301: partial_completion_terminal on RemediationState", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("partial_completion_terminal field round-trips through StateStore", async () => {
    const store = new StateStore(ARTIFACTS_DIR);
    const terminal: PartialCompletionTerminal = {
      reason: "empty_pool",
      stranded_ids: ["T1", "T2"],
    };
    const state: RemediationState = {
      status: "implementing",
      partial_completion_terminal: terminal,
    };
    await store.saveState(state);
    const loaded = await store.loadState();
    expect(loaded?.partial_completion_terminal).toEqual(terminal);
    expect(loaded?.partial_completion_terminal?.reason).toBe("empty_pool");
    expect(loaded?.partial_completion_terminal?.stranded_ids).toEqual(["T1", "T2"]);
  });

  it("partial_completion_terminal marks non-terminal items blocked and folds to present_report", async () => {
    const store = new StateStore(ARTIFACTS_DIR);
    const terminal: PartialCompletionTerminal = {
      reason: "livelock_guard",
      stranded_ids: ["F-001", "F-002"],
    };
    const state = makeImplementingState(terminal);
    await store.saveState(state);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // Folded: partial_completion_terminal marks items blocked, advances to closing,
    // runs close, and returns present_report — all in one decideNextStep call.
    // (close phase deletes the artifacts dir, so we cannot read state.json after.)
    const step = await decideNextStep({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      hostCanDispatchSubagents: false,
    });

    expect(step.step_kind).toBe("present_report");
    expect(step.step_kind).not.toBe("state_transition");
  });

  it("already-terminal items are NOT re-marked by the partial-completion terminal", async () => {
    const store = new StateStore(ARTIFACTS_DIR);
    const terminal: PartialCompletionTerminal = {
      reason: "empty_pool",
      stranded_ids: ["F-002"],
    };
    // F-001 is already resolved (terminal), F-002 is pending (non-terminal)
    const state = makeImplementingState(terminal, {
      "F-001": {
        finding_id: "F-001",
        status: "resolved",
        block_id: "B-001",
      },
    });
    state.items!["F-001"] = {
      finding_id: "F-001",
      status: "resolved",
      block_id: "B-001",
    };
    await store.saveState(state);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // Folded: runs to completion. Verify via the durable outcomes report, which
    // is written BEFORE the artifacts dir is deleted on close.
    const step = await decideNextStep({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      hostCanDispatchSubagents: false,
    });

    expect(step.step_kind).toBe("present_report");

    // The outcomes report records the final status of every item. F-001 was
    // already resolved and must not be re-marked; F-002 was blocked (stranded).
    const { readFile } = await import("node:fs/promises");
    const outcomesPath = join(REPO_DIR, ".audit-tools", "remediation-outcomes.json");
    const outcomes = JSON.parse(await readFile(outcomesPath, "utf8"));
    const byId = new Map(outcomes.outcomes.map((e: { finding_id: string }) => [e.finding_id, e]));
    const f1 = byId.get("F-001") as { final_status: string } | undefined;
    const f2 = byId.get("F-002") as { final_status: string } | undefined;
    // F-001 was already resolved — must appear as fixed (not failed/blocked)
    expect(f1?.final_status).toBe("fixed");
    // F-002 was non-terminal, stranded → blocked → failed in the outcomes
    expect(f2?.final_status).toBe("failed");
  });

  it("without partial_completion_terminal, normal documenting flow applies (no regression)", async () => {
    const store = new StateStore(ARTIFACTS_DIR);
    const state = makeImplementingState(undefined);
    await store.saveState(state);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      hostCanDispatchSubagents: false,
    });

    // Without terminal, items should still be in their original statuses
    const updatedState = await store.loadState();
    // documenting path: either still documenting or a document dispatch step
    // The key is it did NOT mark items as blocked via the terminal path
    const items = updatedState?.items ?? {};
    const blockedByTerminal = Object.values(items).filter(
      (it) => it.status === "blocked" && it.failure_reason?.includes("partial-completion terminal"),
    );
    expect(blockedByTerminal).toHaveLength(0);
    // TST-5003421d: pin the normal-flow step kind rather than the vacuous
    // toBeDefined(). Without a partial-completion terminal, this ready
    // implementing state advances straight to the rolling implement dispatch
    // (host cannot dispatch subagents → sequential frontier) — a real workflow
    // step, never a terminal/error kind produced by the partial-completion path.
    // (toBeDefined() was true for any returned step and could not catch a
    // regression in the non-terminal path.)
    const TERMINAL_OR_ERROR_KINDS = [
      "present_report",
      "collect_triage",
      "zero_documentable_findings",
    ];
    expect(
      TERMINAL_OR_ERROR_KINDS,
      `normal no-terminal flow must not produce a terminal/error step, got '${step.step_kind}'`,
    ).not.toContain(step.step_kind);
    expect(step.step_kind).toBe("implement_rolling_sequential");
  });
});

// ── @audit-tools/shared exports ─────────────────────────────────────────────

import { detectLivelock, buildEmptyPoolTerminal } from "@audit-tools/shared";

describe("N-CE301: PartialCompletionTerminal exported from @audit-tools/shared", () => {
  it("PartialCompletionTerminal and PartialCompletionReason are importable as functions", () => {
    expect(detectLivelock).toBeTypeOf("function");
    expect(buildEmptyPoolTerminal).toBeTypeOf("function");
  });

  it("detectLivelock returns null when below limit", () => {
    const result = detectLivelock({ pendingIds: ["T1"], consecutiveNoProgressWaves: 2, noProgressLimit: 3 });
    expect(result).toBeNull();
  });

  it("detectLivelock returns livelock_guard terminal when limit reached", () => {
    const result = detectLivelock({ pendingIds: ["T1", "T2"], consecutiveNoProgressWaves: 3, noProgressLimit: 3 });
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("livelock_guard");
    expect(result?.stranded_ids).toEqual(["T1", "T2"]);
  });

  it("buildEmptyPoolTerminal returns empty_pool terminal with given ids", () => {
    const result = buildEmptyPoolTerminal(["A", "B"]);
    expect(result.reason).toBe("empty_pool");
    expect(result.stranded_ids).toEqual(["A", "B"]);
  });

  it("detectLivelock returns null when pendingIds is empty", () => {
    const result = detectLivelock({ pendingIds: [], consecutiveNoProgressWaves: 99 });
    expect(result).toBeNull();
  });
});
