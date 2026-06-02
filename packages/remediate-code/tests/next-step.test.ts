import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { decideNextStep, resolveHostDispatchCapability } from "../src/steps/nextStep.js";
import { StateStore } from "../src/state/store.js";
import type { RemediationState } from "../src/state/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-next-step");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".remediation-artifacts");
const WRAPPER = join(__dirname, "..", "remediate-code.mjs");
const AUDIT_FIXTURE = join(__dirname, "fixtures", "audit-findings-simple.json");
const AUDITOR_CONTRACT_FIXTURE = join(
  __dirname,
  "fixtures",
  "auditor-contract-audit-findings.json",
);

function makePlanningState(overrides: Partial<RemediationState> = {}): RemediationState {
  return {
    status: "planning",
    plan: {
      plan_id: "PLAN-1",
      findings: [
        {
          id: "F-001",
          title: "First",
          category: "correctness",
          severity: "high",
          confidence: "high",
          lens: "correctness",
          summary: "Fix first.",
          affected_files: [{ path: "src/a.ts" }],
          evidence: ["src/a.ts:1 evidence"],
        },
        {
          id: "F-002",
          title: "Second",
          category: "tests",
          severity: "low",
          confidence: "medium",
          lens: "tests",
          summary: "Fix second.",
          affected_files: [{ path: "src/b.ts" }],
          evidence: ["src/b.ts:1 evidence"],
        },
      ],
      blocks: [
        { block_id: "B-001", items: ["F-001"], parallel_safe: true },
        { block_id: "B-002", items: ["F-002"], parallel_safe: true },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
      "F-002": { finding_id: "F-002", status: "pending", block_id: "B-002" },
    },
    closing_plan: { action: "none" },
    ...overrides,
  } as RemediationState;
}

async function saveState(state: RemediationState): Promise<void> {
  await new StateStore(ARTIFACTS_DIR).saveState(state);
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("decideNextStep", () => {
  it("complete run emits present_report", async () => {
    await saveState({ status: "complete" });
    await writeFile(join(REPO_DIR, "remediation-report.md"), "# Report\n", "utf8");

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.contract_version).toBe("remediate-code-step/v1alpha1");
    expect(step.step_kind).toBe("present_report");
    expect(step.status).toBe("complete");
    expect(step.artifact_paths.final_report).toMatch(/remediation-report\.md$/);
    expect(await readFile(step.prompt_path, "utf8")).toMatch(/Present Remediation Report/);
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

  it("ready intake summary advances to bounded finding extraction", async () => {
    const inputPath = join(REPO_DIR, "feedback.md");
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(inputPath, "# Notes\n\nPlease clean up the auth flow.\n", "utf8");
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-source-manifest/v1alpha1",
        created_from: "input",
        sources: [{ type: "document", path: inputPath }],
      }),
      "utf8",
    );
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
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("extract_findings");
    expect(step.artifact_paths.extracted_plan).toMatch(/extracted-plan\.json$/);
    expect(prompt).toMatch(/Extract Findings From Intake Brief/);
    expect(prompt).toMatch(/"category": "User Goal"/);
  });

  it("ready intake survives a default-candidate manifest re-derivation instead of looping", async () => {
    // Regression: when next-step runs without --input but a default audit-report
    // candidate exists, the resolver re-derives the source manifest every call.
    // An identical candidate set must not discard the persisted summary/brief and
    // re-emit synthesize_intake forever.
    const auditDir = join(REPO_DIR, ".audit-artifacts");
    const reportPath = join(auditDir, "audit-report.md");
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(auditDir, { recursive: true });
    await mkdir(intakeDir, { recursive: true });
    await writeFile(reportPath, "# Audit Report\n\nFindings here.\n", "utf8");
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-source-manifest/v1alpha1",
        created_from: "default_candidates",
        sources: [{ type: "document", path: reportPath, label: "input-01" }],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-summary/v1alpha1",
        ready: true,
        source_type: "documents",
        goals: ["Fix only the critical bugs."],
        non_goals: ["Broad refactors."],
        constraints: [],
        affected_files: [{ path: "src/auth.ts" }],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "remediation-brief.md"),
      "# Remediation Brief\n\nCritical bugs only.\n",
      "utf8",
    );

    // Run twice to prove it is not a one-shot escape: a stable candidate set must
    // keep advancing rather than oscillating back into synthesis.
    const first = await decideNextStep({ root: REPO_DIR });
    expect(first.step_kind).toBe("extract_findings");

    const second = await decideNextStep({ root: REPO_DIR });
    expect(second.step_kind).toBe("extract_findings");

    // The persisted summary must remain intact (scope preserved, not reset).
    const summary = JSON.parse(
      await readFile(join(intakeDir, "intake-summary.json"), "utf8"),
    );
    expect(summary.ready).toBe(true);
    expect(summary.goals).toContain("Fix only the critical bugs.");
  });

  it("ambiguous intake summary asks for clarification before extraction", async () => {
    const inputPath = join(REPO_DIR, "feedback.md");
    const intakeDir = join(ARTIFACTS_DIR, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(inputPath, "# Notes\n\nPlease clean up auth.\n", "utf8");
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-source-manifest/v1alpha1",
        created_from: "input",
        sources: [{ type: "document", path: inputPath }],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-summary/v1alpha1",
        ready: false,
        source_type: "documents",
        goals: ["Clean up auth."],
        non_goals: [],
        constraints: [],
        affected_files: [],
        open_questions: [
          {
            id: "Q-001",
            category: "scope_of_fix",
            question: "Which auth flow should change?",
            blocking: true,
          },
        ],
      }),
      "utf8",
    );
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Draft\n", "utf8");

    const step = await decideNextStep({ root: REPO_DIR });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("collect_intake_clarifications");
    expect(prompt).toMatch(/Which auth flow should change/);
  });

  it("uses auditor-rendered output as next-step input and prepares bounded dispatch", async () => {
    const step = await decideNextStep({
      root: REPO_DIR,
      input: AUDITOR_CONTRACT_FIXTURE,
      hostCanDispatchSubagents: true,
    });
    const state = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    const dispatchPlan = JSON.parse(
      await readFile(step.artifact_paths.dispatch_plan, "utf8"),
    );

    expect(step.step_kind).toBe("dispatch_document");
    expect(state.plan.findings.map((finding: { id: string }) => finding.id)).toEqual([
      "AUD-001",
      "AUD-002",
      "AUD-003",
    ]);
    expect(state.plan.blocks.map((block: { block_id: string }) => block.block_id)).toEqual([
      "block-1",
      "block-2",
    ]);
    expect(state.items["AUD-001"]).toMatchObject({
      status: "pending",
      block_id: "block-1",
    });
    expect(dispatchPlan.items.map((item: { finding_id: string }) => item.finding_id)).toEqual([
      "AUD-001",
      "AUD-002",
      "AUD-003",
    ]);
    expect(await readFile(dispatchPlan.items[0].prompt_path, "utf8")).toMatch(
      /Session token accepted without expiry validation/,
    );
  });

  it("blocked clarifications emit one batched user prompt", async () => {
    await saveState({
      ...makePlanningState(),
      status: "waiting_for_clarification",
      clarifications: [
        {
          finding_id: "F-001",
          category: "scope_of_fix",
          description: "Clarify one.",
        },
        {
          finding_id: "F-002",
          category: "behavioral_semantics",
          description: "Clarify two.",
        },
      ],
    });

    const step = await decideNextStep({ root: REPO_DIR });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("collect_clarifications");
    expect(prompt).toContain("F-001");
    expect(prompt).toContain("F-002");
    expect(prompt).toMatch(/one batched response/i);
  });

  it("host can dispatch agents emits dispatch_document and prepares artifacts", async () => {
    await saveState(makePlanningState());

    const step = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });
    const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("dispatch_document");
    expect(plan.contract_version).toBe("remediate-code-dispatch-plan/v1alpha1");
    expect(plan.items).toHaveLength(2);
    expect(prompt).toMatch(/dispatch one subagent/i);
    expect(prompt).toMatch(/merge-document-results/);
  });

  it("host cannot dispatch agents emits single-item fallback", async () => {
    await saveState(makePlanningState());

    const step = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: false,
    });
    const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("document_single_item");
    expect(plan.items).toHaveLength(1);
    expect(existsSync(step.artifact_paths.single_task_prompt)).toBe(true);
    expect(prompt).toMatch(/Document One Remediation Item/);
  });

  it("host cannot dispatch agents ingests an existing single-item result before prompting again", async () => {
    await saveState(makePlanningState());
    const resultDir = join(ARTIFACTS_DIR, "runs", "PLAN-1", "document");
    await mkdir(resultDir, { recursive: true });
    await writeFile(
      join(resultDir, "document-F-001.result.json"),
      JSON.stringify({
        type: "item_spec",
        item_spec: {
          finding_id: "F-001",
          concrete_change: "fix",
          tests_to_write: [],
          not_applicable_steps: [],
        },
      }),
      "utf8",
    );

    const step = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: false,
    });
    const state = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );

    expect(state.items["F-001"].status).toBe("documented");
    expect(step.step_kind).toBe("document_single_item");
    expect(step.artifact_paths.result).toMatch(/document-F-002\.result\.json$/);
  });

  it("omitted hostCanDispatchSubagents defaults to single-item (no capability_check)", async () => {
    await saveState(makePlanningState());

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("document_single_item");
    expect(step.step_kind).not.toBe("capability_check");
  });

  it("session config host_can_dispatch_subagents=true enables dispatch without CLI flag", async () => {
    await saveState(makePlanningState());
    const configPath = join(REPO_DIR, "session-config.json");
    await writeFile(configPath, JSON.stringify({ host_can_dispatch_subagents: true }), "utf8");

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("dispatch_document");
  });

  it("closing state runs close inline and returns present_report", async () => {
    await saveState(
      makePlanningState({
        status: "closing",
        items: {
          "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
          "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
        },
      }),
    );

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("present_report");
  });

  it("finalize-closing runs close and returns present_report", async () => {
    await saveState(
      makePlanningState({
        status: "closing",
        items: {
          "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
          "F-002": { finding_id: "F-002", status: "resolved", block_id: "B-002" },
        },
      }),
    );

    const step = await decideNextStep({
      root: REPO_DIR,
      finalizeClosing: true,
    });

    expect(step.step_kind).toBe("present_report");
    expect(step.status).toBe("complete");
    expect(existsSync(join(REPO_DIR, "remediation-report.md"))).toBe(true);
  });

  it("CLI next-step writes parseable JSON to stdout even when planning logs", () => {
    const result = spawnSync(
      process.execPath,
      [WRAPPER, "next-step", "--root", REPO_DIR, "--input", AUDIT_FIXTURE],
      {
        cwd: REPO_DIR,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout).contract_version).toBe(
      "remediate-code-step/v1alpha1",
    );
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    expect(result.stderr).toMatch(/Running Plan Phase/);
  });

  it("CLI run is a deprecated parseable next-step alias", () => {
    const result = spawnSync(
      process.execPath,
      [WRAPPER, "run", "--root", REPO_DIR, "--input", AUDIT_FIXTURE],
      {
        cwd: REPO_DIR,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout).contract_version).toBe(
      "remediate-code-step/v1alpha1",
    );
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    expect(result.stderr).toMatch(/`run` is deprecated/);
    expect(result.stderr).toMatch(/Running Plan Phase/);
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

  it("defaults to false when nothing is configured", () => {
    expect(resolveHostDispatchCapability({ env: {} as any })).toBe(false);
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
