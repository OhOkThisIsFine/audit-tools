import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { loaderCommand } from "../../src/remediate/steps/prompts.js";
import {
  createNextStepHarness,
  makePlanningState,
} from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-next-step-lifecycle");
const { REPO_DIR, ARTIFACTS_DIR, saveState, acknowledgeResume, writeIntentCheckpoint } = harness;

beforeEach(async () => {
  await harness.resetTestRepo();
});

afterEach(async () => {
  await harness.cleanupTestRepo();
});
describe("decideNextStep — run lifecycle, input handling, and intake routing", () => {
  it("complete run emits present_report with a folded friction close-out", async () => {
    await saveState({ status: "complete" });
    await mkdir(join(REPO_DIR, ".audit-tools"), { recursive: true });
    await writeFile(join(REPO_DIR, ".audit-tools", "remediation-report.md"), "# Report\n", "utf8");

    // First call: friction triage pending — record materialized, needs open_observations.
    const pending = await decideNextStep({ root: REPO_DIR });

    expect(pending.contract_version).toBe("remediate-code-step/v1alpha1");
    expect(pending.step_kind).toBe("present_report");
    expect(pending.status).toBe("ready");
    expect(pending.artifact_paths.final_report).toMatch(/remediation-report\.md$/);
    // The terminal friction close-out is folded in: the record path is surfaced and
    // the prompt surfaces the single-sourced run-friction triage (events UNION reflections).
    expect(pending.artifact_paths.friction_record).toMatch(/friction[\\/].+\.json$/);
    expect(existsSync(pending.artifact_paths.friction_record)).toBe(true);
    const pendingPrompt = await readFile(pending.prompt_path, "utf8");
    expect(pendingPrompt).toMatch(/[Ff]riction triage/);

    // Host covers all friction categories → friction satisfied.
    const record = JSON.parse(await readFile(pending.artifact_paths.friction_record, "utf8"));
    record.category_attestations = [
      { category: "ambiguous_direction", note: "none this run" },
      { category: "tool_should_decide", note: "none this run" },
      { category: "inefficient_feeding", note: "none this run" },
    ];
    await writeFile(pending.artifact_paths.friction_record, JSON.stringify(record) + "\n", "utf8");

    // Second call: friction satisfied → status:"complete", prompt includes report.
    const done = await decideNextStep({ root: REPO_DIR });
    expect(done.step_kind).toBe("present_report");
    expect(done.status).toBe("complete");
    const donePrompt = await readFile(done.prompt_path, "utf8");
    expect(donePrompt).toMatch(/Present Remediation Report/);
  });

  it("accepts options supplied as a JSON string", async () => {
    await saveState({ status: "complete" });
    await mkdir(join(REPO_DIR, ".audit-tools"), { recursive: true });
    await writeFile(join(REPO_DIR, ".audit-tools", "remediation-report.md"), "# Report\n", "utf8");

    const step = await decideNextStep(JSON.stringify({ root: REPO_DIR }));

    expect(step.step_kind).toBe("present_report");
    // prompt_path is normalized to forward slashes (FINDING-004), so compare
    // with the slash-normalized artifacts dir.
    expect(step.prompt_path).toContain(ARTIFACTS_DIR.replace(/\\/g, "/"));
  });

  it("rejects malformed JSON string and array options", async () => {
    await expect(decideNextStep("{bad")).rejects.toThrow(
      /decideNextStep options must be an object or JSON object string/i,
    );
    await expect(decideNextStep("[]")).rejects.toThrow(
      /decideNextStep options must be an object or JSON object string/i,
    );
  });

  it("loaderCommand renders argv tokens through the shared prompt command renderer", () => {
    expect(loaderCommand("next-step --force-replan")).toBe(
      "remediate-code next-step --force-replan",
    );
    expect(loaderCommand(["next-step", "--input", "C:\\Path With Spaces\\report.md"])).toBe(
      'remediate-code next-step --input "C:/Path With Spaces/report.md"',
    );
  });

  it("records started_at and increments step_count once per next-step invocation", async () => {
    await saveState(makePlanningState());
    await acknowledgeResume();
    await writeIntentCheckpoint();

    await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const firstState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(Date.parse(firstState.started_at)).not.toBeNaN();
    expect(firstState.step_count).toBe(1);

    await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: true });
    const secondState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(secondState.started_at).toBe(firstState.started_at);
    expect(secondState.step_count).toBe(2);
  });

  it("stale remediation-report.md does not complete a fresh --input run", async () => {
    // A leftover report must NOT short-circuit a run that has fresh intent: with
    // a new --input, planning proceeds instead of declaring the prior run done.
    await mkdir(join(REPO_DIR, ".audit-tools"), { recursive: true });
    await writeFile(join(REPO_DIR, ".audit-tools", "remediation-report.md"), "# Stale prior run\n", "utf8");
    const inputPath = join(REPO_DIR, "new-brief.md");
    await writeFile(inputPath, "# A new brief\n", "utf8");

    const step = await decideNextStep({ root: REPO_DIR, input: inputPath });

    expect(step.step_kind).not.toBe("present_report");
  });

  it("does not re-present a leftover report over a fresh confirmed run (intake-summary + host checkpoint, no state)", async () => {
    // task_2092be69: right after confirm_intent a NEW run carries a ready
    // intake-summary + host-confirmed checkpoint but no state.json yet (plan not
    // built). A prior run's leftover root report must NOT short-circuit it to
    // present_report — that signal means an active run, not a finished one.
    await mkdir(join(REPO_DIR, ".audit-tools"), { recursive: true });
    await writeFile(join(REPO_DIR, ".audit-tools", "remediation-report.md"), "# Stale prior run\n", "utf8");
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-summary/v1alpha1",
        ready: true,
        source_type: "structured_audit",
        goals: ["Remediate the findings."],
        non_goals: [],
        constraints: [],
        affected_files: [],
        open_questions: [],
      }),
      "utf8",
    );
    await writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).not.toBe("present_report");
  });

  it("re-presents the report on a bare re-invocation after a completed+cleaned run", async () => {
    // close deletes .audit-tools/remediation/state.json but leaves durable root
    // outputs. A bare next-step with no fresh intent should re-present the report.
    await mkdir(join(REPO_DIR, ".audit-tools"), { recursive: true });
    await writeFile(join(REPO_DIR, ".audit-tools", "remediation-report.md"), "# Done\n", "utf8");

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("present_report");
  });

  it("a freshly-regenerated audit doc newer than a leftover report is not silently redelivered", async () => {
    // task backlog: intake must not short-circuit to present_report over a STALE
    // report when a default-discovered audit doc (audit-findings.json) postdates
    // it — that's a fresh audit run, not evidence the old remediation is "the"
    // answer. Explicit utimes so mtime ordering is deterministic regardless of
    // filesystem timestamp resolution.
    await mkdir(join(REPO_DIR, ".audit-tools"), { recursive: true });
    const reportPath = join(REPO_DIR, ".audit-tools", "remediation-report.md");
    await writeFile(reportPath, "# Stale prior run\n", "utf8");
    const older = new Date(Date.now() - 60_000);
    await utimes(reportPath, older, older);

    const findingsPath = join(REPO_DIR, ".audit-tools", "audit-findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify({
        schema_version: "audit-findings/v1alpha1",
        summary: { total_findings: 0 },
        findings: [],
        work_blocks: [],
      }),
      "utf8",
    );
    const newer = new Date();
    await utimes(findingsPath, newer, newer);

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).not.toBe("present_report");
  });

  it("new --input against an in-progress run emits input_conflict instead of silently resuming", async () => {
    await saveState(makePlanningState());
    const inputPath = join(REPO_DIR, "new-feedback.md");
    await writeFile(inputPath, "# A different brief\n", "utf8");

    const step = await decideNextStep({ root: REPO_DIR, input: inputPath });

    expect(step.step_kind).toBe("input_conflict");
    expect(step.status).toBe("blocked");
    expect(await readFile(step.prompt_path, "utf8")).toMatch(/already exists/i);
  });

  it("re-passing the SAME --input the run was built from resumes (no input_conflict)", async () => {
    // The /remediate-code loader re-passes the same --input on every next-step.
    // An unchanged input must be treated as a resume, not a conflict — enforced in
    // the tool, not by asking the loader to remember to drop the flag.
    await saveState(makePlanningState());
    const inputPath = join(REPO_DIR, "feedback.md");
    await writeFile(inputPath, "# The brief this run was built from\n", "utf8");
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-source-manifest/v1alpha1",
        created_from: "input",
        sources: [{ type: "document", path: inputPath, label: "input-01" }],
      }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, input: inputPath });

    expect(step.step_kind).not.toBe("input_conflict");
  });

  it("writes a structured run log recording the state and resulting step", async () => {
    const step = await decideNextStep({ root: REPO_DIR });

    const logRaw = await readFile(join(ARTIFACTS_DIR, "run.log.jsonl"), "utf8");
    const events = logRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    // every line carries a timestamp
    expect(events.every((event) => typeof event.ts === "string")).toBe(true);

    const stateEvent = events.find((event) => event.kind === "state");
    expect(stateEvent?.phase).toBe("next-step");

    const stepEvent = events.find((event) => event.kind === "step");
    expect(stepEvent?.obligation).toBe(step.step_kind);
    expect(typeof stepEvent?.duration_ms).toBe("number");
  });

  it("does not write a run log when observability.run_log is disabled", async () => {
    await writeFile(
      join(REPO_DIR, "session-config.json"),
      JSON.stringify({ observability: { run_log: false } }),
      "utf8",
    );

    await decideNextStep({ root: REPO_DIR });

    expect(existsSync(join(ARTIFACTS_DIR, "run.log.jsonl"))).toBe(false);
  });

  it("missing input emits a conversation-first starting-point step", async () => {
    const step = await decideNextStep({ root: REPO_DIR });
    const currentStep = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "steps", "current-step.json"), "utf8"),
    );
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("collect_starting_point");
    expect(currentStep.step_kind).toBe("collect_starting_point");
    expect(prompt).toMatch(/document paths/i);
    expect(prompt).toMatch(/conversational feedback/i);
    expect(step.artifact_paths.source_manifest).toMatch(/source-manifest\.json$/);
  });

  it("explicit missing input emits a starting-point step with the missing path", async () => {
    const missingPath = join(REPO_DIR, "missing feedback.md");

    const step = await decideNextStep({ root: REPO_DIR, input: missingPath });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("collect_starting_point");
    expect(prompt).toContain(missingPath);
    expect(prompt).toMatch(/did not exist/i);
  });

  it("free-form Markdown enters intake synthesis instead of a zero-finding plan", async () => {
    const inputPath = join(REPO_DIR, "feedback.md");
    await writeFile(inputPath, "# Notes\n\nPlease clean up the auth flow.\n", "utf8");

    const step = await decideNextStep({ root: REPO_DIR, input: inputPath });
    const prompt = await readFile(step.prompt_path, "utf8");
    const manifest = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "intake", "source-manifest.json"), "utf8"),
    );

    expect(step.step_kind).toBe("synthesize_intake");
    expect(step.artifact_paths.intake_summary).toMatch(/intake-summary\.json$/);
    expect(prompt).toMatch(/Synthesize Remediation Intake/);
    expect(manifest.sources[0]).toMatchObject({
      type: "document",
      path: inputPath,
    });
  });

  it("conversation-start artifact enters intake synthesis", async () => {
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    const conversationPath = join(intakeDir, "conversation-start.md");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(
      conversationPath,
      "Please refactor the auth flow until the refresh behavior is clear.",
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR });
    const manifest = JSON.parse(
      await readFile(join(intakeDir, "source-manifest.json"), "utf8"),
    );

    expect(step.step_kind).toBe("synthesize_intake");
    expect(manifest.sources[0]).toMatchObject({
      type: "conversation",
      path: conversationPath,
    });
  });

  it("audit-looking Markdown without Work Blocks uses intake synthesis", async () => {
    const inputPath = join(REPO_DIR, "partial-audit-report.md");
    await writeFile(
      inputPath,
      `# Audit Report\n\n## Findings\n\n### F-001 — Missing block section\n- Severity: high\n- Confidence: high\n- Lens: security\n- Summary: Needs extraction.\n- Files: src/auth.ts\n- Evidence:\n  - evidence\n`,
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, input: inputPath });

    expect(step.step_kind).toBe("synthesize_intake");
    expect(await readFile(step.prompt_path, "utf8")).toMatch(/Synthesize Remediation Intake/);
  });
});
