import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decideNextStep } from "../src/steps/nextStep.js";
import type { RemediationState } from "../src/state/store.js";
import {
  createNextStepHarness,
  makePlanningState,
  makeImplementingState,
} from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-next-step-implement-dispatch");
const { REPO_DIR, ARTIFACTS_DIR, saveState, resetTestRepo, acknowledgeImplementationPreview, acknowledgeResume, writeIntentCheckpoint } = harness;

beforeEach(async () => {
  await harness.resetTestRepo();
});

afterEach(async () => {
  await harness.cleanupTestRepo();
});
describe("decideNextStep — implementation dispatch and intent gate", () => {
  it("buildImplementDispatchStep: declined ack marks all pending items deemed_inappropriate and returns continueWithState", async () => {
    // Set up a documenting state with two documented items
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

    // Write a "declined" ack file
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "declined", skip: [] }),
      "utf8",
    );

    let step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    while (step.step_kind === "state_transition") {
      step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    }

    // Should not dispatch — all items are terminal so the run folds straight
    // through closing to completion (which deletes the artifact dir, so the
    // durable evidence is the report in .audit-tools/).
    expect(["present_report", "run_close_action", "no_closing_actions"]).toContain(step.step_kind);

    // Both pending items were marked deemed_inappropriate before closing; the
    // completed run records them in outcomes with the declined rationale.
    const report = JSON.parse(
      await readFile(join(REPO_DIR, ".audit-tools", "remediation-outcomes.json"), "utf8"),
    );
    const outcomes = report.outcomes as Array<{
      finding_id: string;
      outcome: string;
      reason?: string;
    }>;
    const f1 = outcomes.find((e) => e.finding_id === "F-001");
    const f2 = outcomes.find((e) => e.finding_id === "F-002");
    expect(f1?.outcome).toBe("inappropriate");
    expect(f2?.outcome).toBe("inappropriate");
    expect(f1?.reason).toMatch(/declined by the user/i);
    expect(f2?.reason).toMatch(/declined by the user/i);
  });

  it("buildImplementDispatchStep: terminal items are not mutated when ack is declined", async () => {
    const documentingState: RemediationState = makePlanningState({
      status: "implementing",
      items: {
        "F-001": {
          finding_id: "F-001",
          status: "resolved",
          block_id: "B-001",
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

    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "declined", skip: [] }),
      "utf8",
    );

    let step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    while (step.step_kind === "state_transition") {
      step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    }

    // The run completes (deleting the artifact dir), so assert on the durable
    // outcomes in .audit-tools/ rather than the now-removed state.json.
    const report = JSON.parse(
      await readFile(join(REPO_DIR, ".audit-tools", "remediation-outcomes.json"), "utf8"),
    );
    const outcomes = report.outcomes as Array<{ finding_id: string; outcome: string }>;
    const resolvedIds = outcomes.filter((e) => e.outcome === "resolved").map((e) => e.finding_id);
    const inappropriateIds = outcomes.filter((e) => e.outcome === "inappropriate").map((e) => e.finding_id);
    // Already-resolved item must not be touched — it stays in the resolved bucket
    // and never appears as deemed_inappropriate.
    expect(resolvedIds).toContain("F-001");
    expect(inappropriateIds).not.toContain("F-001");
    // Non-terminal item is marked deemed_inappropriate.
    expect(inappropriateIds).toContain("F-002");
  });

  it("buildImplementDispatchStep: confirmed ack with empty skip still dispatches implementation", async () => {
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

    // Write a reviewed risk file so the preview step is skipped
    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify([]),
      "utf8",
    );
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", skip: [] }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });

    // Items should NOT be marked deemed_inappropriate — dispatch proceeds
    expect(step.step_kind).toMatch(/dispatch_implement/);
    const savedState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(savedState.items["F-001"].status).toBe("pending");
    expect(savedState.items["F-002"].status).toBe("pending");
  });

  it("emits classify_impl_risks before implementation preview when reviewed risks are missing", async () => {
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
      },
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("classify_impl_risks");
    expect(step.artifact_paths.reviewed).toMatch(/impl_risk_reviewed\.json$/);
    expect(prompt).toMatch(/impl_risk_reviewed\.json/);
    expect(prompt).not.toMatch(/remove.*risk-review hop/i);
  });

  it("renders preview decision labels with reviewed reasons, pros and cons, and excludes no-change choices", async () => {
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
            tests_to_write: [{ name: "a.test", assertions: ["asserts a"] }],
            not_applicable_steps: [],
          },
        },
        "F-002": {
          finding_id: "F-002",
          status: "pending",
          block_id: "B-002",
          item_spec: {
            finding_id: "F-002",
            concrete_change: "already correct after prior change",
            no_change: true,
            touched_files: [],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      },
    });
    await saveState(documentingState);
    await acknowledgeResume();
    await writeIntentCheckpoint();
    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_preliminary.json"),
      JSON.stringify({
        schema_version: "impl-risk-preliminary/v1",
        findings: [
          {
            finding_id: "F-001",
            title: "First",
            summary: "Fix first.",
            affected_files: ["src/a.ts"],
            concrete_change: "fix a",
            no_change: false,
            tests_to_write: [{ name: "a.test", assertions: ["asserts a"] }],
            preliminary_tier: "safe",
            preliminary_reason: "low blast radius",
          },
          {
            finding_id: "F-002",
            title: "Second",
            summary: "Already correct.",
            affected_files: ["src/b.ts"],
            concrete_change: "already correct after prior change",
            no_change: true,
            tests_to_write: [],
            preliminary_tier: "context_dependent",
            preliminary_reason: "no-op",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify({
        schema_version: "impl-risk-reviewed/v1",
        findings: [
          { finding_id: "F-001", tier: "safe", reason: "reviewed safe reason" },
          { finding_id: "F-002", tier: "context_dependent", reason: "reviewed no-op reason" },
        ],
      }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("preview_implement");
    expect(prompt).toContain("Straightforward");
    expect(prompt).toContain("Reviewed Reason");
    expect(prompt).toContain("Pros");
    expect(prompt).toContain("Cons");
    expect(prompt).toContain("reviewed safe reason");
    expect(prompt).toContain("Already Correct (no changes planned)");
    expect(prompt).toContain("ignored_findings");
    expect(prompt).not.toContain("Tier 1");
    expect(prompt).not.toContain("Tier 2");
    expect(prompt).not.toContain("Tier 3");
    // The ## Ignore Choices section was removed (N-D01 #23) — the tiered tables
    // already carry the full context; an extra duplicate list is noise.
    expect(prompt).not.toContain("## Ignore Choices");
    // F-001 appears in the Straightforward table (not in a separate Ignore Choices list)
    expect(prompt).toContain("F-001");
    expect(prompt).toContain("Straightforward");
    // F-002 is no-op — excluded from tier tables, listed only under Already Correct
    expect(prompt).toContain("F-002");
  });

  it("confirmed preview ack with ignored_findings marks only named items ignored and dispatches the rest", async () => {
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
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", ignored_findings: ["F-002"] }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const savedState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));

    expect(step.step_kind).toBe("dispatch_implement");
    expect(savedState.items["F-002"].status).toBe("ignored");
    expect(savedState.items["F-002"].failure_reason).toMatch(/implementation preview/i);
    expect(savedState.items["F-001"].status).toBe("pending");
    expect(plan.items.map((item: { block_id: string }) => item.block_id)).toContain("B-001");
    expect(plan.items.map((item: { block_id: string }) => item.block_id)).not.toContain("B-002");
  });

  it("implement phase dispatch sweep defaults to parallel after preview acknowledgment", async () => {
    const cases = [
      {
        options: { root: REPO_DIR },
        sessionConfig: null,
        stepKind: "dispatch_implement",
        itemCount: 2,
      },
      {
        options: { root: REPO_DIR, hostCanDispatchSubagents: true },
        sessionConfig: null,
        stepKind: "dispatch_implement",
        itemCount: 2,
      },
      {
        options: { root: REPO_DIR },
        sessionConfig: { host_can_dispatch_subagents: true },
        stepKind: "dispatch_implement",
        itemCount: 2,
      },
      {
        // Rolling scheduler: a non-dispatching host still gets the FULL eligible
        // frontier (both nodes) in one sequential step, not one node per next-step.
        options: { root: REPO_DIR, hostCanDispatchSubagents: false },
        sessionConfig: null,
        stepKind: "implement_rolling_sequential",
        itemCount: 2,
      },
    ];

    for (const scenario of cases) {
      await resetTestRepo();
      await saveState(makeImplementingState());
      await acknowledgeResume();
      await writeIntentCheckpoint();
      await acknowledgeImplementationPreview();
      if (scenario.sessionConfig) {
        await writeFile(
          join(REPO_DIR, "session-config.json"),
          JSON.stringify(scenario.sessionConfig),
          "utf8",
        );
      }

      const step = await decideNextStep(scenario.options);
      const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));

      expect(step.step_kind).toBe(scenario.stepKind);
      expect(plan.items).toHaveLength(scenario.itemCount);
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

    // Write a confirmed ack to bypass the preview-ack gate
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", skip: [] }),
      "utf8",
    );

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

    // Write a confirmed ack to bypass the preview-ack gate
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", skip: [] }),
      "utf8",
    );

    // Write a completed implement result for B-001
    const implResultDir = join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement");
    await mkdir(implResultDir, { recursive: true });
    await writeFile(
      join(implResultDir, "implement-B-001.result.json"),
      JSON.stringify({
        contract_version: "remediate-code-worker-result/v1alpha1",
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
    const filePath = join(__dirname, "../src/steps/nextStep.ts");
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

  it("state_transition step_kind is not in the types union", async () => {
    const filePath = join(__dirname, "../src/steps/types.ts");
    const content = await readFile(filePath, "utf8");
    expect(content).not.toContain("state_transition");
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
