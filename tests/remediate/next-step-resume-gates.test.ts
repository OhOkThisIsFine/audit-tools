import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decideNextStep, resolveHostDispatchCapability } from "../../src/remediate/steps/nextStep.js";
import {
  createNextStepHarness,
  makePlanningState,
} from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-next-step-resume-gates");
const { REPO_DIR, ARTIFACTS_DIR, saveState, acknowledgeResume, writeIntentCheckpoint } = harness;

beforeEach(async () => {
  await harness.resetTestRepo();
});

afterEach(async () => {
  await harness.cleanupTestRepo();
});
describe("N-R01: confirm_resume_or_restart gate", () => {
  it("bare re-invocation with planning state emits confirm_resume_or_restart (blocked)", async () => {
    await saveState(makePlanningState({ status: "planning" }));
    // No confirm_resume_ack.json → gate fires

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("confirm_resume_or_restart");
    expect(step.status).toBe("blocked");
  });

  it("confirm_resume_or_restart prompt includes state status, plan_id, and item counts", async () => {
    await saveState(makePlanningState({ status: "planning" }));

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("confirm_resume_or_restart");
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toMatch(/planning/i);
    expect(prompt).toContain("PLAN-1");
    expect(prompt).toMatch(/pending/i);
  });

  it("confirm_resume_or_restart prompt lists resume, restart, and merge choices", async () => {
    await saveState(makePlanningState({ status: "planning" }));

    const step = await decideNextStep({ root: REPO_DIR });

    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toMatch(/resume/i);
    expect(prompt).toMatch(/restart/i);
    expect(prompt).toMatch(/merge/i);
  });

  it("with confirm_resume_ack.json choice=resume, does NOT emit confirm_resume_or_restart", async () => {
    await saveState(makePlanningState({ status: "planning" }));
    await acknowledgeResume();
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).not.toBe("confirm_resume_or_restart");
  });
});

describe("N-R01: extracted-plan fast-path does not bypass confirm_intent", () => {
  it("extracted-plan.json present with no checkpoint emits confirm_intent (not dispatch)", async () => {
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify(makePlanningState().plan),
      "utf8",
    );
    // No intent_checkpoint.json written

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("confirm_intent");
  });

  it("extracted-plan.json prompt references intent_checkpoint.json", async () => {
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify(makePlanningState().plan),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("confirm_intent");
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toMatch(/intent_checkpoint\.json/);
  });

  it("N-R06: with checkpoint + intake artifacts + extracted-plan, proceeds past confirm_intent to dispatch", async () => {
    // After N-R06: a pre-existing extracted-plan.json still works for resumability,
    // but intake artifacts must be present (the fast-path bypass without intake was removed).
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-source-manifest/v1alpha1",
        created_from: "input",
        sources: [{ type: "document", path: join(REPO_DIR, "notes.md"), label: "input-01" }],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-summary/v1alpha1",
        ready: true,
        source_type: "documents",
        goals: ["Fix all bugs"],
        non_goals: [],
        constraints: [],
        affected_files: [],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief\n", "utf8");
    await writeFile(join(REPO_DIR, "notes.md"), "# notes", "utf8");
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify(makePlanningState().plan),
      "utf8",
    );
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    // Should advance to planning / document dispatch — not blocked at confirm_intent
    expect(step.step_kind).not.toBe("confirm_intent");
  });
});

describe("A3 engine rewire: entry-gate freeze (no resurrection after an intake-built state)", () => {
  // When pending_intake builds a planning state from a promoted extracted-plan,
  // the shared advance loop re-scans on that fresh state. The resume/conflict
  // gates are about a *pre-existing* run, so they must stay frozen at the
  // call-entry state (null here) and NOT re-fire against the intake-built plan —
  // otherwise the run wrongly bounces to a resume/conflict prompt instead of
  // dispatching. (Pre-fix these derived from the threaded state and resurrected.)
  async function seedPromotedPlanWithIntake(): Promise<void> {
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-source-manifest/v1alpha1",
        created_from: "input",
        sources: [
          { type: "document", path: join(REPO_DIR, "notes.md"), label: "input-01" },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-summary/v1alpha1",
        ready: true,
        source_type: "documents",
        goals: ["Fix all bugs"],
        non_goals: [],
        constraints: [],
        affected_files: [],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief\n", "utf8");
    await writeFile(join(REPO_DIR, "notes.md"), "# notes", "utf8");
    // Materialize the findings' cited paths so phantom-path grounding KEEPS them
    // and handlePendingExtractedPlan yields a planning *state* (the transition that
    // triggers the advance re-scan we are testing) rather than re-emitting an
    // extraction step.
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "a.ts"), "// a\n", "utf8");
    await writeFile(join(REPO_DIR, "src", "b.ts"), "// b\n", "utf8");
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify(makePlanningState().plan),
      "utf8",
    );
    await writeIntentCheckpoint();
  }

  it("bare re-invocation (no pre-existing state) does not resurrect confirm_resume_or_restart after intake builds a plan", async () => {
    await seedPromotedPlanWithIntake();
    // No state.json (entry state is null) and no --input.
    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).not.toBe("confirm_resume_or_restart");
    expect(step.step_kind).not.toBe("confirm_intent");
  });

  it("--input against a fresh run (no pre-existing state) does not resurrect input_conflict after intake builds a plan", async () => {
    await seedPromotedPlanWithIntake();
    await writeFile(join(REPO_DIR, "audit-report.md"), "# audit\n", "utf8");
    const step = await decideNextStep({
      root: REPO_DIR,
      input: join(REPO_DIR, "audit-report.md"),
    });
    expect(step.step_kind).not.toBe("input_conflict");
    expect(step.step_kind).not.toBe("confirm_intent");
  });
});

describe("resolveHostDispatchCapability", () => {
  it("returns the explicit flag when provided", () => {
    expect(resolveHostDispatchCapability({ hostCanDispatchSubagents: true })).toBe(true);
    expect(resolveHostDispatchCapability({ hostCanDispatchSubagents: false })).toBe(false);
  });

  it("reads session config when flag is undefined", () => {
    expect(
      resolveHostDispatchCapability({
        sessionConfig: { host_can_dispatch_subagents: true },
      }),
    ).toBe(true);
  });

  it("reads REMEDIATE_HOST_CAN_DISPATCH env var as fallback", () => {
    expect(
      resolveHostDispatchCapability({
        env: { REMEDIATE_HOST_CAN_DISPATCH: "true" } as any,
      }),
    ).toBe(true);
    expect(
      resolveHostDispatchCapability({
        env: { REMEDIATE_HOST_CAN_DISPATCH: "false" } as any,
      }),
    ).toBe(false);
  });

  it("defaults to true when nothing is configured (conversation-first parallel dispatch)", () => {
    expect(resolveHostDispatchCapability({ env: {} as any })).toBe(true);
  });

  it("CLI flag overrides session config", () => {
    expect(
      resolveHostDispatchCapability({
        hostCanDispatchSubagents: false,
        sessionConfig: { host_can_dispatch_subagents: true },
      }),
    ).toBe(false);
  });
});
