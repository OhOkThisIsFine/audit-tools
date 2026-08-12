import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
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

describe("N-R01: --guidance-file against an advanced run trips input_conflict", () => {
  it("guidanceFileSupplied against a past-intake run emits input_conflict (blocked), not a silent resume", async () => {
    await saveState(makePlanningState({ status: "planning" }));
    const step = await decideNextStep({ root: REPO_DIR, guidanceFileSupplied: true });
    expect(step.step_kind).toBe("input_conflict");
    expect(step.status).toBe("blocked");
  });

  it("bare re-invocation after the conflict (no guidance flag) does not re-fire input_conflict", async () => {
    await saveState(makePlanningState({ status: "planning" }));
    const step = await decideNextStep({ root: REPO_DIR });
    // Bare call → the resume gate handles it, not input_conflict.
    expect(step.step_kind).not.toBe("input_conflict");
  });

  it("re-passing the SAME --input against a mixed (input+guidance) run resumes, not input_conflict", async () => {
    // A run started with --input + --guidance-file records a created_from:"mixed"
    // manifest (input sources + the conversation-start entry). The loader re-passes
    // --input on every next-step, so a mixed manifest must count as input-bound and
    // the comparison must ignore the guidance entry — else every mixed run trips a
    // phantom conflict on its second step. The pinned property is PARITY: mixed
    // yields the same step a pure "input" manifest does, whatever gate that is.
    const inputPath = join(REPO_DIR, "notes.md");
    const seedManifest = async (manifest: Record<string, unknown>) => {
      const intakeDir = join(ARTIFACTS_DIR, "intake");
      await mkdir(intakeDir, { recursive: true });
      await writeFile(inputPath, "# notes", "utf8");
      await writeFile(join(intakeDir, "source-manifest.json"), JSON.stringify(manifest), "utf8");
      await saveState(makePlanningState({ status: "planning" }));
    };

    await seedManifest({
      schema_version: "remediate-code-intake-source-manifest/v1alpha1",
      created_from: "input",
      sources: [{ type: "document", path: inputPath, label: "input-01" }],
    });
    const inputBoundStep = await decideNextStep({ root: REPO_DIR, input: inputPath });
    expect(inputBoundStep.step_kind).not.toBe("input_conflict");

    await harness.resetTestRepo();
    await seedManifest({
      schema_version: "remediate-code-intake-source-manifest/v1alpha1",
      created_from: "mixed",
      sources: [
        { type: "document", path: inputPath, label: "input-01" },
        {
          type: "conversation",
          path: join(ARTIFACTS_DIR, "intake", "conversation-start.md"),
          label: "conversation-start",
        },
      ],
    });

    const mixedStep = await decideNextStep({ root: REPO_DIR, input: inputPath });

    expect(mixedStep.step_kind).not.toBe("input_conflict");
    expect(mixedStep.step_kind).toBe(inputBoundStep.step_kind);
  });

  it("a genuinely DIFFERENT --input against a mixed run still trips input_conflict", async () => {
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    const originalInput = join(REPO_DIR, "notes.md");
    const otherInput = join(REPO_DIR, "other.md");
    await writeFile(originalInput, "# notes", "utf8");
    await writeFile(otherInput, "# other", "utf8");
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-source-manifest/v1alpha1",
        created_from: "mixed",
        sources: [
          { type: "document", path: originalInput, label: "input-01" },
          { type: "conversation", path: join(intakeDir, "conversation-start.md"), label: "conversation-start" },
        ],
      }),
      "utf8",
    );
    await saveState(makePlanningState({ status: "planning" }));

    const step = await decideNextStep({ root: REPO_DIR, input: otherInput });

    expect(step.step_kind).toBe("input_conflict");
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
    // A declared sizing window, without which `applyPlanPipeline` refuses and no
    // planning state is built. This fixture predates the refusal propagating:
    // the refusal used to be swallowed as "corrupted extracted-plan.json", so
    // these two cases passed on their NEGATIVE assertions while exercising the
    // re-emit-extraction path the comment above says they must avoid.
    await writeFile(
      join(REPO_DIR, "session-config.json"),
      JSON.stringify({
        block_quota: { context_tokens: 200_000, reserved_output_tokens: 8_000 },
      }),
      "utf8",
    );
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
    // Positive first: these cases are only meaningful if the intake actually
    // BUILT a plan. Asserting only the negatives let them pass for years while
    // the join was refusing and re-emitting an extraction step instead.
    await expectIntakeBuiltAPlan();
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
    await expectIntakeBuiltAPlan();
    expect(step.step_kind).not.toBe("input_conflict");
    expect(step.step_kind).not.toBe("confirm_intent");
  });

  /**
   * The precondition both cases share: the promoted extracted plan survived the
   * join and became a planning state. If it did not, every `not.toBe(...)` below
   * is vacuously true and the case tests nothing.
   */
  async function expectIntakeBuiltAPlan(): Promise<void> {
    const { existsSync } = await import("node:fs");
    expect(
      existsSync(join(ARTIFACTS_DIR, "state.json")),
      "the extracted plan must have been joined into a planning state",
    ).toBe(true);
    expect(
      existsSync(join(ARTIFACTS_DIR, "extracted-plan.json")),
      "a successful join keeps the extracted plan; its absence means the recovery path discarded it",
    ).toBe(true);
  }
});
