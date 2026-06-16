/**
 * N-R04 tests: consolidated synthesis+intent checkpoint (pre-drafted, two stops total)
 *
 * Coverage:
 * - synthesizeIntakePrompt includes preliminary intent checkpoint instructions
 * - buildConfirmIntentStep reads and presents the pre-drafted checkpoint
 * - confirm_intent gate fires when draft checkpoint exists regardless of extracted-plan.json
 * - validateClarificationResolution rejects malformed answers
 * - resolveIntakeStep re-emits collect_intake_clarifications on invalid clarification resolution
 * - IntentCheckpoint type accepts confirmed_by: 'draft'
 * - filterFindingsByCheckpoint skips filtering when confirmed_by is 'draft'
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntentCheckpoint } from "@audit-tools/shared";
import { synthesizeIntakePrompt } from "../src/steps/prompts.js";
import { filterFindingsByCheckpoint } from "../src/intent/checkpointFilter.js";
import {
  validateClarificationResolution,
  intakePaths,
  INTAKE_SUMMARY_SCHEMA_VERSION,
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  type IntakeSummary,
  type IntakeSourceManifest,
} from "../src/intake.js";
import { resolveIntakeStep } from "../src/steps/intakeResolver.js";
import { decideNextStep } from "../src/steps/nextStep.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-n-r04");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools", "remediation");

function makeStubs() {
  return {
    collectStartingPointPrompt: (
      _root: string,
      _checked: string[],
      _missing: string[],
      _paths: ReturnType<typeof intakePaths>,
    ) => "collect starting point prompt",
    synthesizeIntakePrompt,
    collectIntakeClarificationsPrompt: (_summary: IntakeSummary, _paths: ReturnType<typeof intakePaths>) =>
      "collect clarifications prompt",
    extractFindingsPrompt: (_paths: ReturnType<typeof intakePaths>, _sources: unknown[]) =>
      "extract findings prompt",
    loaderCommand: (cmd: string) => `remediate-code ${cmd}`,
    randomRunId: (prefix?: string) => `${prefix ?? "RUN"}-test`,
  };
}

function makeCheckpoint(overrides: Partial<IntentCheckpoint> = {}): IntentCheckpoint {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-11T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "all packages",
    intent_summary: "full remediation",
    ...overrides,
  };
}

function makeFinding(id: string, opts: { severity?: string; lens?: string; files?: string[] } = {}): unknown {
  return {
    id,
    title: id,
    category: "correctness",
    severity: opts.severity ?? "high",
    confidence: "high",
    lens: opts.lens ?? "correctness",
    summary: "s",
    affected_files: (opts.files ?? ["src/a.ts"]).map((path) => ({ path })),
    evidence: ["src/a.ts:1 - x"],
  };
}

// ---------------------------------------------------------------------------
// synthesizeIntakePrompt includes preliminary intent checkpoint instructions
// ---------------------------------------------------------------------------

describe("synthesizeIntakePrompt — N-R04: preliminary intent checkpoint", () => {
  it("output contains instructions to write intent_checkpoint.json", () => {
    const paths = intakePaths(ARTIFACTS_DIR);
    const prompt = synthesizeIntakePrompt(
      paths.sourceManifest,
      [{ type: "document", path: "audit-report.md", label: "input-01" }],
      paths,
      false,
    );
    expect(prompt).toContain("intent_checkpoint.json");
  });

  it("instructs worker to set confirmed_by: 'draft'", () => {
    const paths = intakePaths(ARTIFACTS_DIR);
    const prompt = synthesizeIntakePrompt(
      paths.sourceManifest,
      [],
      paths,
      false,
    );
    expect(prompt).toContain('"confirmed_by": "draft"');
  });

  it("instructs worker to pre-populate scope_summary and intent_summary from goals/constraints", () => {
    const paths = intakePaths(ARTIFACTS_DIR);
    const prompt = synthesizeIntakePrompt(
      paths.sourceManifest,
      [],
      paths,
      false,
    );
    expect(prompt).toContain("scope_summary");
    expect(prompt).toContain("intent_summary");
    // Must mention goals and affected areas as source
    expect(prompt).toContain("goals");
    expect(prompt).toContain("affected");
  });

  it("instructs worker to carry open_questions into pre_draft_questions", () => {
    const paths = intakePaths(ARTIFACTS_DIR);
    const prompt = synthesizeIntakePrompt(
      paths.sourceManifest,
      [],
      paths,
      false,
    );
    expect(prompt).toContain("pre_draft_questions");
    expect(prompt).toContain("open_questions");
  });

  it("uses intentCheckpointPath override when provided", () => {
    const paths = intakePaths(ARTIFACTS_DIR);
    const customPath = "/custom/path/checkpoint.json";
    const prompt = synthesizeIntakePrompt(
      paths.sourceManifest,
      [],
      paths,
      false,
      customPath,
    );
    expect(prompt).toContain(customPath);
  });
});

// ---------------------------------------------------------------------------
// buildConfirmIntentStep reads and presents the pre-drafted checkpoint
// ---------------------------------------------------------------------------

describe("buildConfirmIntentStep — N-R04: pre-drafted checkpoint presentation", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    // Create a minimal repo file so the intent gate fires
    await mkdir(join(ARTIFACTS_DIR, "intake"), { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  async function writeDraftCheckpoint(extra: Record<string, unknown> = {}): Promise<void> {
    const checkpoint = {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-06-11T00:00:00.000Z",
      confirmed_by: "draft",
      scope_summary: "all packages in the repo",
      intent_summary: "full remediation of audit findings",
      filters: {},
      pre_draft_questions: [
        { id: "Q-001", question: "What is the priority?", blocking: true },
        { id: "Q-002", question: "Exclude test files?", blocking: false },
      ],
      closing_action: "commit",
      ...extra,
    };
    await writeFile(
      join(ARTIFACTS_DIR, "intent_checkpoint.json"),
      JSON.stringify(checkpoint),
      "utf8",
    );
  }

  async function writeSummary(): Promise<void> {
    const summary: IntakeSummary = {
      schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
      ready: true,
      source_type: "documents",
      goals: ["Remediate all high findings"],
      non_goals: [],
      constraints: [],
      affected_files: [{ path: "src/a.ts" }],
      open_questions: [],
    };
    await writeFile(
      join(ARTIFACTS_DIR, "intake", "intake-summary.json"),
      JSON.stringify(summary),
      "utf8",
    );
  }

  it("confirm_intent step renders pre-populated scope_summary from the draft", async () => {
    await writeDraftCheckpoint();
    await writeSummary();

    const step = await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(step.step_kind).toBe("confirm_intent");

    const promptText = await readFile(step.prompt_path, "utf8");
    expect(promptText).toContain("all packages in the repo");
  });

  it("confirm_intent step includes all open_questions from the draft", async () => {
    await writeDraftCheckpoint();
    await writeSummary();

    const step = await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const promptText = await readFile(step.prompt_path, "utf8");
    expect(promptText).toContain("Q-001");
    expect(promptText).toContain("What is the priority?");
    expect(promptText).toContain("Q-002");
    expect(promptText).toContain("Exclude test files?");
  });

  it("confirm_intent step shows non-blocking questions as FYI context", async () => {
    await writeDraftCheckpoint();
    await writeSummary();

    const step = await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const promptText = await readFile(step.prompt_path, "utf8");
    // Non-blocking Q-002 should be labeled FYI
    expect(promptText).toContain("FYI");
  });

  it("confirm_intent step includes the closing_action options list", async () => {
    await writeDraftCheckpoint({ closing_action: "commit" });
    await writeSummary();

    const step = await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const promptText = await readFile(step.prompt_path, "utf8");
    // Closing action should appear with valid options
    expect(promptText).toContain("commit");
    expect(promptText).toContain("none");
  });

  it("confirm_intent step shows how free_form_intent was interpreted", async () => {
    await writeDraftCheckpoint({ intent_interpretation: "prioritizing security findings" });
    await writeSummary();

    const step = await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const promptText = await readFile(step.prompt_path, "utf8");
    expect(promptText).toContain("prioritizing security findings");
  });
});

// ---------------------------------------------------------------------------
// confirm_intent gate fires when draft checkpoint exists regardless of extracted-plan.json
// ---------------------------------------------------------------------------

describe("decideNextStepInner — N-R04: intent gate with draft checkpoint", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await mkdir(join(ARTIFACTS_DIR, "intake"), { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("returns confirm_intent step when intent_checkpoint.json has confirmed_by='draft' even if extracted-plan.json exists", async () => {
    // Write a draft checkpoint
    await writeFile(
      join(ARTIFACTS_DIR, "intent_checkpoint.json"),
      JSON.stringify({
        schema_version: "intent-checkpoint/v1",
        confirmed_at: "2026-06-11T00:00:00.000Z",
        confirmed_by: "draft",
        scope_summary: "all",
        intent_summary: "remediation",
        filters: {},
        pre_draft_questions: [],
      }),
      "utf8",
    );

    // Write a minimal extracted-plan.json (normally would skip intent gate)
    await writeFile(
      join(ARTIFACTS_DIR, "intake", "extracted-plan.json"),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            title: "Test finding",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [],
            evidence: ["evidence"],
          },
        ],
        blocks: [],
      }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(step.step_kind).toBe("confirm_intent");
  });

  it("does NOT return confirm_intent step when intent_checkpoint.json has confirmed_by='host'", async () => {
    // Write a confirmed checkpoint
    await writeFile(
      join(ARTIFACTS_DIR, "intent_checkpoint.json"),
      JSON.stringify({
        schema_version: "intent-checkpoint/v1",
        confirmed_at: "2026-06-11T00:00:00.000Z",
        confirmed_by: "host",
        scope_summary: "all",
        intent_summary: "remediation",
      }),
      "utf8",
    );

    // Write a summary so there's something to do after intent
    const summary: IntakeSummary = {
      schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
      ready: false,
      source_type: "documents",
      goals: [],
      non_goals: [],
      constraints: [],
      affected_files: [],
      open_questions: [{ id: "Q-001", question: "Test question?", blocking: true }],
    };
    await writeFile(
      join(ARTIFACTS_DIR, "intake", "intake-summary.json"),
      JSON.stringify(summary),
      "utf8",
    );
    // Also need a source manifest
    const manifest: IntakeSourceManifest = {
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "conversation",
      sources: [],
    };
    await writeFile(
      join(ARTIFACTS_DIR, "intake", "source-manifest.json"),
      JSON.stringify(manifest),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(step.step_kind).not.toBe("confirm_intent");
  });
});

// ---------------------------------------------------------------------------
// validateClarificationResolution unit tests
// ---------------------------------------------------------------------------

describe("validateClarificationResolution — N-R04", () => {
  it("returns valid=true for a well-formed answers array that addresses all blocking questions", () => {
    const resolution = {
      schema_version: "remediate-code-intake-clarifications/v1alpha1",
      answers: [
        { question_id: "Q-001", answer: "Use TypeScript strict mode." },
        { question_id: "Q-002", answer: "Skip test-only files." },
      ],
    };
    const blocking = [
      { id: "Q-001", question: "What language?", blocking: true },
    ];
    const result = validateClarificationResolution(resolution, blocking);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns valid=false with errors when answers array is missing", () => {
    const resolution = { schema_version: "remediate-code-intake-clarifications/v1alpha1" };
    const result = validateClarificationResolution(resolution, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("answers"))).toBe(true);
  });

  it("returns valid=false when answers is not an array", () => {
    const resolution = { answers: "not-an-array" };
    const result = validateClarificationResolution(resolution, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("answers"))).toBe(true);
  });

  it("returns valid=false when no answer addresses any blocking question_id", () => {
    const resolution = {
      answers: [
        { question_id: "Q-999", answer: "Unrelated answer." },
      ],
    };
    const blocking = [
      { id: "Q-001", question: "Critical question?", blocking: true },
    ];
    const result = validateClarificationResolution(resolution, blocking);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Q-001"))).toBe(true);
  });

  it("returns valid=false when an answer object is missing the answer field", () => {
    const resolution = {
      answers: [
        { question_id: "Q-001" }, // missing 'answer'
      ],
    };
    const blocking = [{ id: "Q-001", question: "Question?", blocking: true }];
    const result = validateClarificationResolution(resolution, blocking);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("answer"))).toBe(true);
  });

  it("returns valid=false when answers array is empty and blocking questions remain", () => {
    const resolution = { answers: [] };
    const blocking = [{ id: "Q-001", question: "Critical question?", blocking: true }];
    const result = validateClarificationResolution(resolution, blocking);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns valid=true when no blocking questions exist and answers array is empty", () => {
    const resolution = { answers: [] };
    const result = validateClarificationResolution(resolution, []);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveIntakeStep re-emits collect_intake_clarifications on invalid resolution
// ---------------------------------------------------------------------------

describe("resolveIntakeStep — N-R04: clarification validation", () => {
  const dir = join(TEST_DIR, "clarification-validation");
  const artifactsDir = join(dir, ".audit-tools", "remediation");
  const intakeDir = join(artifactsDir, "intake");

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(intakeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeDocSource(): Promise<string> {
    const docPath = join(dir, "notes.md");
    await writeFile(docPath, "# Notes\nFix stuff.", "utf8");
    const manifest: IntakeSourceManifest = {
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "input",
      sources: [{ type: "document", path: docPath, label: "input-01" }],
    };
    await writeFile(join(intakeDir, "source-manifest.json"), JSON.stringify(manifest), "utf8");
    return docPath;
  }

  async function writeUnreadySummary(): Promise<void> {
    const summary: IntakeSummary = {
      schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
      ready: false,
      source_type: "documents",
      goals: ["Fix stuff"],
      non_goals: [],
      constraints: [],
      affected_files: [{ path: "src/a.ts" }],
      open_questions: [
        { id: "Q-001", question: "What first?", blocking: true },
      ],
    };
    await writeFile(join(intakeDir, "intake-summary.json"), JSON.stringify(summary), "utf8");
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief", "utf8");
  }

  it("when clarification-resolution file exists but is malformed JSON, step kind is collect_intake_clarifications not synthesize_intake", async () => {
    await writeDocSource();
    await writeUnreadySummary();
    // Write malformed clarification resolution
    await writeFile(
      join(intakeDir, "intake-clarifications.json"),
      "{ this is invalid json }",
      "utf8",
    );

    // readOptionalJsonFile will return undefined for malformed JSON, which means
    // clarificationResolution will be undefined — resolveIntakeStep falls through
    // to collect_intake_clarifications. Verify it emits the clarifications step.
    const stubs = makeStubs();
    const result = await resolveIntakeStep({
      root: dir,
      artifactsDir,
      inputResolution: { supplied: false, existing: [], missing: [], checked: [] },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("collect_intake_clarifications");
  });

  it("when clarification-resolution file exists but answers array is empty and blocking questions remain, step kind is collect_intake_clarifications", async () => {
    await writeDocSource();
    await writeUnreadySummary();
    // Write an empty answers array — invalid because blocking questions remain
    await writeFile(
      join(intakeDir, "intake-clarifications.json"),
      JSON.stringify({ schema_version: "remediate-code-intake-clarifications/v1alpha1", answers: [] }),
      "utf8",
    );

    const stubs = makeStubs();
    const result = await resolveIntakeStep({
      root: dir,
      artifactsDir,
      inputResolution: { supplied: false, existing: [], missing: [], checked: [] },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("collect_intake_clarifications");
  });

  it("step prompt includes validation error detail when re-emitting collect_intake_clarifications", async () => {
    await writeDocSource();
    await writeUnreadySummary();
    await writeFile(
      join(intakeDir, "intake-clarifications.json"),
      JSON.stringify({ schema_version: "remediate-code-intake-clarifications/v1alpha1", answers: [] }),
      "utf8",
    );

    const stubs = makeStubs();
    const result = await resolveIntakeStep({
      root: dir,
      artifactsDir,
      inputResolution: { supplied: false, existing: [], missing: [], checked: [] },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    // Prompt file should mention validation errors
    const promptText = await readFile(result.step.prompt_path, "utf8");
    expect(promptText).toContain("Validation errors");
  });
});

// ---------------------------------------------------------------------------
// IntentCheckpoint type accepts confirmed_by: 'draft'
// ---------------------------------------------------------------------------

describe("IntentCheckpoint type — N-R04: confirmed_by: 'draft'", () => {
  it("TypeScript compiles without error when confirmed_by is 'draft'", () => {
    // This is a compile-time check — if the file compiles, the test passes.
    const checkpoint: IntentCheckpoint = {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-06-11T00:00:00Z",
      confirmed_by: "draft",
      scope_summary: "all",
      intent_summary: "full",
    };
    expect(checkpoint.confirmed_by).toBe("draft");
  });

  it("TypeScript compiles without error when confirmed_by is 'host'", () => {
    const checkpoint: IntentCheckpoint = {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-06-11T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "all",
      intent_summary: "full",
    };
    expect(checkpoint.confirmed_by).toBe("host");
  });
});

// ---------------------------------------------------------------------------
// filterFindingsByCheckpoint skips filtering when confirmed_by is 'draft'
// ---------------------------------------------------------------------------

describe("filterFindingsByCheckpoint — N-R04: draft checkpoint skips filtering", () => {
  it("skips filtering when confirmed_by is 'draft'", () => {
    const findings = [
      makeFinding("F-001", { severity: "low", lens: "tests" }),
      makeFinding("F-002", { severity: "critical", lens: "security" }),
    ] as Parameters<typeof filterFindingsByCheckpoint>[0];

    const checkpoint = makeCheckpoint({
      confirmed_by: "draft",
      filters: { severity: ["critical"], lenses: ["security"] },
    });

    const { kept, droppedIds } = filterFindingsByCheckpoint(findings, checkpoint);
    // Draft checkpoint: no filtering — all findings kept
    expect(kept).toHaveLength(2);
    expect(droppedIds).toHaveLength(0);
  });

  it("applies filtering when confirmed_by is 'host'", () => {
    const findings = [
      makeFinding("F-001", { severity: "low", lens: "tests" }),
      makeFinding("F-002", { severity: "critical", lens: "security" }),
    ] as Parameters<typeof filterFindingsByCheckpoint>[0];

    const checkpoint = makeCheckpoint({
      confirmed_by: "host",
      filters: { severity: ["critical"], lenses: ["security"] },
    });

    const { kept, droppedIds } = filterFindingsByCheckpoint(findings, checkpoint);
    // Host checkpoint: only critical+security finding kept
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe("F-002");
    expect(droppedIds).toContain("F-001");
  });
});
