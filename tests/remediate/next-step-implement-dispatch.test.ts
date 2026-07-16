import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { REMEDIATION_WORKER_RESULT_CONTRACT_VERSION } from "../../src/remediate/steps/types.js";
import type { RemediationStepKind } from "../../src/remediate/steps/types.js";
import {
  createNextStepHarness,
  makePlanningState,
  makeImplementingState,
} from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-next-step-implement-dispatch");
const { REPO_DIR, ARTIFACTS_DIR, saveState, resetTestRepo, acknowledgeResume, writeIntentCheckpoint } = harness;

// This file mixes rolling_engine on/off: capture/restore the env var per test and
// set it inline (never globally) so a "true" test and a "false" test don't collide.
// Tests that assert the rolling-default behavior leave it unset entirely.
let prevRollingEngine: string | undefined;
beforeEach(async () => {
  await harness.resetTestRepo();
  prevRollingEngine = process.env.REMEDIATE_ROLLING_ENGINE;
});

afterEach(async () => {
  await harness.cleanupTestRepo();
  if (prevRollingEngine === undefined) delete process.env.REMEDIATE_ROLLING_ENGINE;
  else process.env.REMEDIATE_ROLLING_ENGINE = prevRollingEngine;
});
describe("decideNextStep — implementation dispatch and intent gate", () => {
  it("buildImplementDispatchStep: implementing state dispatches and leaves pending items untouched", async () => {
    const documentingState: RemediationState = makePlanningState({
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
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();
    process.env.REMEDIATE_ROLLING_ENGINE = "false";

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });

    // Dispatch proceeds directly; pending items are not marked terminal.
    expect(step.step_kind).toMatch(/dispatch_implement/);
    const savedState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(savedState.items["F-001"].status).toBe("pending");
    expect(savedState.items["F-002"].status).toBe("pending");
  });

  it("rolling engine + dispatching host emits the worktree-isolated rolling step + session", async () => {
    // The host-subagent rolling driver creates real git worktrees, so the repo
    // must be a git repo with a HEAD to branch from.
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: REPO_DIR, encoding: "utf8", shell: false });
    if (git("init").status !== 0) return; // git unavailable → skip
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("commit", "--allow-empty", "-m", "base");

    await saveState(makeImplementingState());
    await acknowledgeResume();
    await writeIntentCheckpoint();
    await writeFile(
      join(REPO_DIR, "session-config.json"),
      JSON.stringify({ host_can_dispatch_subagents: true }),
      "utf8",
    );
    process.env.REMEDIATE_ROLLING_ENGINE = "true";

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });

    expect(step.step_kind).toBe("dispatch_implement_rolling");
    expect(step.allowed_commands.some((c) => c.includes("accept-node"))).toBe(true);
    // A rolling session was persisted with a non-empty frontier and ≥1 worktree dispatched.
    const session = JSON.parse(
      await readFile(
        join(ARTIFACTS_DIR, "runs", step.run_id, "implement", "rolling-session.json"),
        "utf8",
      ),
    );
    expect(session.frontier.length).toBeGreaterThan(0);
    expect(session.dispatched.length).toBeGreaterThan(0);
  });

  it("implement phase dispatch sweep routes by host capability (rolling default)", async () => {
    const cases = [
      {
        options: { root: REPO_DIR },
        sessionConfig: null,
        stepKind: "dispatch_implement_rolling",
      },
      {
        options: { root: REPO_DIR, hostCanDispatchSubagents: true },
        sessionConfig: null,
        stepKind: "dispatch_implement_rolling",
      },
      {
        options: { root: REPO_DIR },
        sessionConfig: { host_can_dispatch_subagents: true },
        stepKind: "dispatch_implement_rolling",
      },
      {
        // Rolling scheduler: a non-dispatching host still gets the FULL eligible
        // frontier (both nodes) in one sequential step, not one node per next-step.
        options: { root: REPO_DIR, hostCanDispatchSubagents: false },
        sessionConfig: null,
        stepKind: "implement_rolling_sequential",
      },
    ];

    for (const scenario of cases) {
      await resetTestRepo();
      // The host-subagent rolling path creates real git worktrees, so the repo
      // must be a git repo with a HEAD to branch from.
      const git = (...args: string[]) =>
        spawnSync("git", args, { cwd: REPO_DIR, encoding: "utf8", shell: false });
      git("init");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      git("commit", "--allow-empty", "-m", "base");
      await saveState(makeImplementingState());
      await acknowledgeResume();
      await writeIntentCheckpoint();
      if (scenario.sessionConfig) {
        await writeFile(
          join(REPO_DIR, "session-config.json"),
          JSON.stringify(scenario.sessionConfig),
          "utf8",
        );
      }

      const step = await decideNextStep(scenario.options);

      expect(step.step_kind).toBe(scenario.stepKind);
    }
  });

  it("host cannot dispatch agents emits implement_rolling_sequential with the full eligible frontier", async () => {
    const documentingState: RemediationState = makePlanningState({
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
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: false });
    const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));

    // Rolling scheduler: a non-dispatching host gets the FULL eligible frontier
    // (both pending nodes), not one artificially-serialized block per next-step.
    expect(step.step_kind).toBe("implement_rolling_sequential");
    expect(plan.items.length).toBe(2);
    expect(await readFile(step.prompt_path, "utf8")).toMatch(
      /Implement Eligible Remediation Nodes \(sequential\)/,
    );
  });

  it("host cannot dispatch agents ingests an existing implement result before prompting again", async () => {
    const documentingState: RemediationState = makePlanningState({
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
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // Write a completed implement result for B-001
    const implResultDir = join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement");
    await mkdir(implResultDir, { recursive: true });
    await writeFile(
      join(implResultDir, "implement-B-001.result.json"),
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [
          { finding_id: "F-001", status: "resolved", evidence: ["applied fix a"] },
        ],
      }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: false });

    // Rolling scheduler: B-001 (which already has a result) is reconciled OUT of
    // the dispatch plan, and the remaining eligible node (B-002) is the dispatched
    // sequential frontier. The actual STATE merge of B-001 is deferred to the
    // `merge-implement-results` command (rolling defers the merge to the wave's
    // merge step), so F-001 stays pending in state at dispatch-emission time.
    expect(step.step_kind).toBe("implement_rolling_sequential");
    const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));
    const blockIds = (plan.items as Array<{ block_id: string }>).map((i) => i.block_id);
    expect(blockIds).toContain("B-002");
    expect(blockIds).not.toContain("B-001");
  });

  it("deterministic transition fold: documenting with no implementable blocks advances to implementing and triage in one call", async () => {
    // documenting state with all items documented but no item_spec (no implementable blocks)
    // → handleDocumenting marks documented items blocked, sets status=implementing, folds
    // → handleImplementing runs triage (no blocked items with specs → all_terminal check fails)
    // → allItemsTerminal is still false (blocked items), so it emits collect_triage or unhandled_state
    // The key invariant: step_kind is NOT state_transition.
    const documentingState = makePlanningState({
      status: "implementing",
      items: {
        "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
        "F-002": { finding_id: "F-002", status: "pending", block_id: "B-002" },
      },
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();
    process.env.REMEDIATE_ROLLING_ENGINE = "false";

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step).toBeDefined();
    expect(step.step_kind).not.toBe("state_transition");
  });

  it("deterministic transition fold: implementing with all resolved folds all the way to present_report in one call", async () => {
    const implementingState = makePlanningState({
      status: "implementing",
      items: {
        "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
        "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
      },
    });
    await saveState(implementingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // implementing → triage (no-op, all resolved) → allTerminal → closing → present_report.
    // The tool-owned final gate is scoped to the audit-tools monorepo structure, so
    // it is inert in this tmp REPO_DIR (exercised directly in rolling-scheduler.test.ts).
    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("present_report");
  });

  it("deterministic transition fold: planning with all-terminal items emits zero_documentable_findings (N-R13)", async () => {
    // N-R13: document phase dissolved. A planning state where all items are already
    // terminal hits the zero_documentable_findings guard BEFORE allItemsTerminal,
    // presenting user choices instead of silently folding to present_report.
    const state = makePlanningState({
      status: "planning",
      items: {
        "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
        "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
      },
    });
    await saveState(state);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("zero_documentable_findings");
  });

  it("deterministic transition fold: closing state folds to present_report in one call", async () => {
    const state = makePlanningState({
      status: "closing",
      items: {
        "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
        "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
      },
    });
    await saveState(state);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("present_report");
  });

  it("MAX_ITERATIONS no longer exists as a symbol or loop construct", async () => {
    const filePath = join(__dirname, "../../src/remediate/steps/nextStep.ts");
    const content = await readFile(filePath, "utf8");
    expect(content).not.toContain("MAX_ITERATIONS");
    expect(content).not.toContain("for (let iteration = 0;");
  });

  it("state_transition step_kind no longer emitted — step_count increments exactly once through folded transitions", async () => {
    const state = makePlanningState({
      status: "closing",
      step_count: 5,
      items: {
        "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
        "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
      },
    });
    await saveState(state);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    // Closing folds directly to present_report — no state_transition bounce.
    expect(step.step_kind).toBe("present_report");
    expect(step.step_kind).not.toBe("state_transition");

    const completeStatePath = join(REPO_DIR, ".audit-tools", "remediation-state.complete.json");
    const completedState = JSON.parse(await readFile(completeStatePath, "utf8"));
    // step_count incremented exactly once (from 5 to 6), even through multiple folded transitions.
    expect(completedState.step_count).toBe(6);
  });

  it("state_transition is not a member of the RemediationStepKind union (type-level surface, not source text)", () => {
    // Replaces the former source-text grep with an assertion against the exported
    // type surface: "state_transition" must NOT be assignable to RemediationStepKind.
    // `Exclude<X, X> = never`, so if the literal were a member, NotAStepKind would
    // be `never` and `true satisfies NotAStepKind` would fail to compile.
    type NotAStepKind = Exclude<"state_transition", RemediationStepKind> extends never
      ? false
      : true;
    const stateTransitionIsExcluded = true satisfies NotAStepKind;
    expect(stateTransitionIsExcluded).toBe(true);
  });

  it("emits confirm_intent step when intent_checkpoint.json is absent", async () => {
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-summary/v1alpha1",
        ready: true,
        source_type: "documents",
        goals: ["Clean up the auth flow."],
        non_goals: [],
        constraints: [],
        affected_files: [{ path: "src/auth.ts" }],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "remediation-brief.md"),
      "# Remediation Brief\n\nClean up the auth flow.\n",
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("confirm_intent");
    expect(step.status).toBe("ready");

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

    const nextStep = await decideNextStep({ root: REPO_DIR });
    expect(nextStep.step_kind).not.toBe("confirm_intent");
  });
});

describe("A3 slice 2b: handleClosing → complete crosses the engine boundary", () => {
  // `complete` is a PRE-INTAKE obligation, so a main-engine transition can never
  // select it. handleClosing therefore EMITs the report directly, passing exactly
  // what the original recursion reloaded after close. These two cases pin that
  // reload with teeth: a not-green close PRESERVES the artifact dir (reload → the
  // saved complete state → run_id is the plan_id); a fully-green close DELETES it
  // (reload → null → run_id is a fresh randomRunId). Passing the wrong value
  // (always-null or always-closed) — or transitioning instead of emitting, which
  // would fall through to unhandled_state — fails one of these.
  it("not-green close preserves artifacts → present_report carries the run's plan_id (reload → complete state)", async () => {
    await saveState(
      makePlanningState({
        status: "closing",
        items: {
          "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
          "F-002": {
            finding_id: "F-002",
            status: "blocked",
            block_id: "B-002",
            failure_reason: "Provider failed after retries.",
          },
        },
      }),
    );
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("present_report");
    // A blocked item makes the close not-fully-green → artifacts preserved → the
    // reload yields the saved complete state, so the report carries its plan_id.
    expect(step.run_id).toBe("PLAN-1");
  });

  it("fully-green close deletes artifacts → present_report carries a stable fallback run id (reload → null)", async () => {
    await saveState(
      makePlanningState({
        status: "closing",
        items: {
          "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
          "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
        },
      }),
    );
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("present_report");
    // Fully green → artifact dir deleted → the reload is null → stable fallback "run".
    // (Changed from randomRunId("REMEDIATE") to "run" so the friction record path is
    // deterministic across multiple next-step calls on the same run.)
    expect(step.run_id).toBe("run");
  });
});
