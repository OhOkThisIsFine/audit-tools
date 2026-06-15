import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decideNextStep } from "../src/steps/nextStep.js";
import type { RemediationState } from "../src/state/store.js";
import {
  createNextStepHarness,
  makePlanningState,
  makeImplementingState,
} from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-next-step-preview-ack");
const { REPO_DIR, ARTIFACTS_DIR, saveState, acknowledgeResume, writeIntentCheckpoint } = harness;

beforeEach(async () => {
  await harness.resetTestRepo();
});

afterEach(async () => {
  await harness.cleanupTestRepo();
});
describe("N-D01: preview ack plan_id binding (#22)", () => {
  async function makeImplementingStateWithItems(): Promise<RemediationState> {
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
    });
  }

  it("stale ack with mismatched plan_id is rejected and preview is re-emitted", async () => {
    await saveState(await makeImplementingStateWithItems());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // Write reviewed risk so we reach the preview step
    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify({ schema_version: "impl-risk-reviewed/v1", findings: [] }),
      "utf8",
    );

    // Write an ack with a DIFFERENT plan_id than the current plan ("PLAN-1")
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", ignored_findings: [], plan_id: "PLAN-STALE" }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });

    // Ack should be rejected → preview step re-emitted, not dispatch
    expect(step.step_kind).toBe("preview_implement");
    // Stale ack file should be deleted
    expect(existsSync(join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"))).toBe(false);
  });

  it("matching plan_id in ack is accepted and dispatch proceeds", async () => {
    await saveState(await makeImplementingStateWithItems());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify({ schema_version: "impl-risk-reviewed/v1", findings: [] }),
      "utf8",
    );

    // Write ack with correct plan_id ("PLAN-1" matches makePlanningState default)
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", ignored_findings: [], plan_id: "PLAN-1" }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });

    // Ack is accepted → dispatch proceeds
    expect(step.step_kind).toBe("dispatch_implement");
  });

  it("ack without plan_id field is accepted (backward compat: identity binding only when plan_id present)", async () => {
    await saveState(await makeImplementingStateWithItems());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify({ schema_version: "impl-risk-reviewed/v1", findings: [] }),
      "utf8",
    );

    // Legacy ack without plan_id — should still be honored
    await writeFile(
      join(ARTIFACTS_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed", ignored_findings: [] }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });

    expect(step.step_kind).toBe("dispatch_implement");
  });

  it("preview prompt includes plan_id in the ack schema example", async () => {
    await saveState(await makeImplementingStateWithItems());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    // No reviewed file — triggers classify_impl_risks first; write it so we get preview
    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify({ schema_version: "impl-risk-reviewed/v1", findings: [
        { finding_id: "F-001", tier: "safe", reason: "simple fix" },
        { finding_id: "F-002", tier: "safe", reason: "simple fix" },
      ] }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("preview_implement");
    expect(prompt).toMatch(/plan_id/);
    expect(prompt).toContain("PLAN-1");
  });
});

describe("N-D01: preview prompt does not include redundant Ignore Choices section (#23)", () => {
  it("preview_implement prompt does NOT contain ## Ignore Choices section", async () => {
    const state = makePlanningState({
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
            tests_to_write: [{ name: "test-a", assertions: ["asserts a"] }],
            not_applicable_steps: [],
          },
        },
      },
    });
    await saveState(state);
    await acknowledgeResume();
    await writeIntentCheckpoint();

    await writeFile(
      join(ARTIFACTS_DIR, "impl_risk_reviewed.json"),
      JSON.stringify({ schema_version: "impl-risk-reviewed/v1", findings: [
        { finding_id: "F-001", tier: "safe", reason: "simple fix" },
      ] }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("preview_implement");
    expect(prompt).not.toContain("## Ignore Choices");
    // Tiered tables are still present
    expect(prompt).toMatch(/Straightforward|Substantive|Operator Context/);
  });
});
