/**
 * N-R04 tests: consolidated synthesis + intent confirmation (two stops total).
 *
 * Prompt 17c (owner, 2026-09-18): the host writes ONE intake file — the
 * summary. The tool renders the Markdown brief from it, and the confirm step
 * builds its proposal from it. The host once also wrote the brief and a
 * "draft" intent checkpoint (`confirmed_by: "draft"`): three files carrying the
 * same facts, where the copy rule for the checkpoint's questions wrote a field
 * the strict schema dropped, so the user saw "Open Questions: None".
 *
 * Coverage:
 * - synthesizeIntakePrompt asks for the summary only, and states its rules
 * - buildConfirmIntentStep presents the proposal from the summary
 * - a legacy draft checkpoint is archived and reads as "not confirmed"
 * - resolveIntakeStep: a refused summary comes back with the reason; a valid
 *   summary gets its brief rendered by the tool
 * - validateClarificationResolution rejects malformed answers
 * - resolveIntakeStep re-emits collect_intake_clarifications on an invalid resolution
 * - filterFindingsByCheckpoint applies a confirmed checkpoint's filters
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  isLegacyDraftCheckpoint,
  readIntentCheckpoint,
  type IntentCheckpoint,
} from "audit-tools/shared";
import { synthesizeIntakePrompt } from "../../src/remediate/steps/prompts.js";
import { filterFindingsByCheckpoint } from "../../src/remediate/intent/checkpointFilter.js";
import {
  validateClarificationResolution,
  intakePaths,
  renderRemediationBrief,
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
  type IntakeSummary,
  type IntakeSourceManifest,
} from "../../src/remediate/intake.js";
import { resolveIntakeStep } from "../../src/remediate/steps/intakeResolver.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { scratchDir } from "../helpers/scratch.js";
import { intakeSummaryFixture } from "./helpers/intakeSummaryFixture.js";

const TEST_DIR = scratchDir(".test-n-r04");
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

/** A legacy draft checkpoint, as the retired synthesis prompt told the host to write it. */
const LEGACY_DRAFT = {
  schema_version: "intent-checkpoint/v1",
  confirmed_at: "2026-06-11T00:00:00.000Z",
  confirmed_by: "draft",
  scope_summary: "all",
  intent_summary: "remediation",
  filters: {},
  pre_draft_questions: [{ id: "Q-001", question: "What first?", blocking: true }],
};

// ---------------------------------------------------------------------------
// synthesizeIntakePrompt: ONE file, with its rules stated
// ---------------------------------------------------------------------------

describe("synthesizeIntakePrompt — prompt 17c: the host writes the summary only", () => {
  const paths = intakePaths(ARTIFACTS_DIR);
  const prompt = synthesizeIntakePrompt(
    [{ type: "document", path: "docs/refactor-plan.md", label: "input-01" }],
    paths,
    false,
  );

  it("names the summary path and the current schema version", () => {
    expect(prompt).toContain(paths.summary);
    expect(prompt).toContain(`"schema_version": "${INTAKE_SUMMARY_SCHEMA_VERSION}"`);
  });

  it("asks for no brief, no draft checkpoint, and no manifest read", () => {
    expect(prompt).not.toContain(paths.brief);
    expect(prompt).not.toContain("intent_checkpoint.json");
    expect(prompt).not.toContain('"draft"');
    expect(prompt).not.toContain("pre_draft_questions");
    expect(prompt).not.toContain(paths.sourceManifest);
    expect(prompt).not.toContain("free_form_intent");
    expect(prompt).toContain("The tool writes the Markdown brief and the scope proposal from this file.");
  });

  it("shows every summary field in the example", () => {
    for (const field of [
      "source_summary",
      "goals",
      "non_goals",
      "constraints",
      "affected_files",
      "acceptance_criteria",
      "scope_summary",
      "intent_summary",
      "filters",
      "open_questions",
    ]) {
      expect(prompt).toContain(`"${field}":`);
    }
  });

  it("states the ready rules the tool enforces", () => {
    expect(prompt).toContain("`goals` must not be");
    expect(prompt).toContain("`affected_files` must not be\n  empty unless `source_type` is `structured_audit`");
    expect(prompt).toContain("`ready: false` with no\n  blocking question is refused.");
    expect(prompt).toContain("`severity`, `lenses`, `packages` and `themes`");
  });

  it("lists the source files, and the clarification answers only when they exist", () => {
    expect(prompt).toContain("- document: `docs/refactor-plan.md`");
    expect(prompt).not.toContain(paths.clarificationResolution);
    const withAnswers = synthesizeIntakePrompt([], paths, true);
    expect(withAnswers).toContain(paths.clarificationResolution);
  });
});

// ---------------------------------------------------------------------------
// buildConfirmIntentStep: the proposal comes from the summary
// ---------------------------------------------------------------------------

describe("buildConfirmIntentStep — prompt 17c: proposal from the intake summary", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(ARTIFACTS_DIR, "intake"), { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  async function writeSummary(overrides: Partial<IntakeSummary> = {}): Promise<void> {
    await writeFile(
      join(ARTIFACTS_DIR, "intake", "intake-summary.json"),
      JSON.stringify(
        intakeSummaryFixture({
          scope_summary: "all packages in the repo",
          intent_summary: "full remediation of audit findings",
          open_questions: [
            { id: "Q-001", question: "What is the priority?", blocking: true },
            { id: "Q-002", question: "Exclude test files?", category: "scope_of_fix" },
          ],
          ...overrides,
        }),
      ),
      "utf8",
    );
  }

  async function confirmPrompt(): Promise<string> {
    const step = await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(step.step_kind).toBe("confirm_intent");
    return readFile(step.prompt_path, "utf8");
  }

  it("renders the proposed scope and intent from the summary", async () => {
    await writeSummary();
    const promptText = await confirmPrompt();
    expect(promptText).toContain("built the following proposal from the intake summary");
    expect(promptText).toContain("## Proposed Scope\n\nall packages in the repo");
    expect(promptText).toContain("## Proposed Intent\n\nfull remediation of audit findings");
    expect(promptText).toContain('"scope_summary": "all packages in the repo"');
  });

  // The retired draft path lost every question: a copied `category` field was
  // refused by the strict checkpoint schema, so the proposal showed "None".
  it("shows every open question, blocking ones marked and the rest as FYI", async () => {
    await writeSummary();
    const promptText = await confirmPrompt();
    expect(promptText).toContain("- **[blocking] Q-001**: What is the priority?");
    expect(promptText).toContain("- **[FYI] Q-002**: Exclude test files?");
  });

  it("shows the proposed filters and the intent interpretation when present", async () => {
    await writeSummary({
      filters: { severity: ["critical"] },
      intent_interpretation: "prioritizing security findings",
    });
    const promptText = await confirmPrompt();
    expect(promptText).toContain('"severity": [\n    "critical"\n  ]');
    expect(promptText).toContain("prioritizing security findings");
  });

  it("includes the closing_action choice", async () => {
    await writeSummary();
    const promptText = await confirmPrompt();
    expect(promptText).toContain("## Closing Action — you choose");
  });

  it("quotes a summary value safely in the JSON example", async () => {
    await writeSummary({ scope_summary: 'the "core" package' });
    const promptText = await confirmPrompt();
    expect(promptText).toContain('"scope_summary": "the \\"core\\" package"');
  });
});

// ---------------------------------------------------------------------------
// A legacy draft checkpoint is not a confirmation
// ---------------------------------------------------------------------------

describe("legacy draft checkpoint — prompt 17c: archived, reads as not confirmed", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(ARTIFACTS_DIR, "intake"), { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("the shared readers read a legacy draft as absent", async () => {
    const path = join(ARTIFACTS_DIR, "intent_checkpoint.json");
    await writeFile(path, JSON.stringify(LEGACY_DRAFT), "utf8");
    expect(isLegacyDraftCheckpoint(LEGACY_DRAFT)).toBe(true);
    expect(isLegacyDraftCheckpoint(makeCheckpoint())).toBe(false);
    expect(await readIntentCheckpoint(path)).toBeUndefined();
  });

  it("archives a legacy draft and asks for confirmation, even when extracted-plan.json exists", async () => {
    const checkpointPath = join(ARTIFACTS_DIR, "intent_checkpoint.json");
    await writeFile(checkpointPath, JSON.stringify(LEGACY_DRAFT), "utf8");
    // An extracted plan with no confirmed checkpoint must ask for confirmation.
    await writeFile(
      intakePaths(ARTIFACTS_DIR).extractedPlan,
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
    expect(existsSync(checkpointPath)).toBe(false);
    const archived = (await readdir(ARTIFACTS_DIR)).filter((f) =>
      f.startsWith("intent_checkpoint.json.legacy-draft-"),
    );
    expect(archived).toHaveLength(1);
  });

  it("does NOT ask for confirmation when the checkpoint is host-confirmed", async () => {
    await writeFile(
      join(ARTIFACTS_DIR, "intent_checkpoint.json"),
      JSON.stringify(makeCheckpoint({ scope_summary: "all", intent_summary: "remediation" })),
      "utf8",
    );
    await writeFile(
      join(ARTIFACTS_DIR, "intake", "intake-summary.json"),
      JSON.stringify(
        intakeSummaryFixture({
          ready: false,
          goals: [],
          affected_files: [],
          open_questions: [{ id: "Q-001", question: "Test question?", blocking: true }],
        }),
      ),
      "utf8",
    );
    // A source manifest in the shape the tool writes for a `--guidance-file`
    // run (a manifest never has an empty `sources` list).
    const conversationPath = join(ARTIFACTS_DIR, "intake", "conversation-start.md");
    await writeFile(conversationPath, "Fix the tests.\n", "utf8");
    const manifest: IntakeSourceManifest = {
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "conversation",
      sources: [{ type: "conversation", path: conversationPath, label: "conversation-start" }],
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
// resolveIntakeStep: the summary is the one source
// ---------------------------------------------------------------------------

describe("resolveIntakeStep — prompt 17c: refusal and brief render", () => {
  const dir = join(TEST_DIR, "summary-source");
  const artifactsDir = join(dir, ".audit-tools", "remediation");
  const intakeDir = join(artifactsDir, "intake");
  const paths = intakePaths(artifactsDir);

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(intakeDir, { recursive: true });
    const docPath = join(dir, "notes.md");
    await writeFile(docPath, "# Notes\nFix stuff.", "utf8");
    const manifest: IntakeSourceManifest = {
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "input",
      sources: [{ type: "document", path: docPath, label: "input-01" }],
    };
    await writeFile(paths.sourceManifest, JSON.stringify(manifest), "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function resolve() {
    const result = await resolveIntakeStep({
      root: dir,
      artifactsDir,
      inputResolution: { supplied: false, existing: [], missing: [], checked: [], allExisting: [] },
      ...makeStubs(),
    });
    return result;
  }

  it("a refused summary brings synthesize_intake back with each problem named", async () => {
    const { acceptance_criteria, ...withoutCriteria } = intakeSummaryFixture();
    void acceptance_criteria;
    await writeFile(paths.summary, JSON.stringify({ ...withoutCriteria, ready: "yes" }), "utf8");

    const result = await resolve();

    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("synthesize_intake");
    const promptText = await readFile(result.step.prompt_path, "utf8");
    expect(promptText).toContain("**Rewrite required.** The previous intake summary was refused:");
    expect(promptText).toContain("`ready`");
    expect(promptText).toContain("`acceptance_criteria`");
    expect(existsSync(paths.brief)).toBe(false);
  });

  it("a valid summary gets its brief rendered by the tool", async () => {
    const summary = intakeSummaryFixture();
    await writeFile(paths.summary, JSON.stringify(summary), "utf8");

    const result = await resolve();

    expect(result.kind).toBe("pipeline_ready");
    expect(await readFile(paths.brief, "utf8")).toBe(renderRemediationBrief(summary));
  });

  it("an absent summary asks for the summary only", async () => {
    const result = await resolve();

    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("synthesize_intake");
    // The step spells its paths with forward slashes on every platform.
    const slashed = (p: string) => p.replace(/\\/g, "/");
    expect(result.step.artifact_paths).toMatchObject({
      intake_summary: slashed(paths.summary),
      intake_clarifications: slashed(paths.clarificationResolution),
    });
    expect(result.step.artifact_paths).not.toHaveProperty("remediation_brief");
    expect(result.step.artifact_paths).not.toHaveProperty("source_manifest");
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
    const summary = intakeSummaryFixture({
      ready: false,
      goals: ["Fix stuff"],
      affected_files: [{ path: "src/a.ts" }],
      open_questions: [
        { id: "Q-001", question: "What first?", blocking: true },
      ],
    });
    await writeFile(join(intakeDir, "intake-summary.json"), JSON.stringify(summary), "utf8");
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
      inputResolution: { supplied: false, existing: [], missing: [], checked: [], allExisting: [] },
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
      inputResolution: { supplied: false, existing: [], missing: [], checked: [], allExisting: [] },
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
      inputResolution: { supplied: false, existing: [], missing: [], checked: [], allExisting: [] },
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
// filterFindingsByCheckpoint applies a confirmed checkpoint
// ---------------------------------------------------------------------------

describe("filterFindingsByCheckpoint — N-R04", () => {
  it("applies the filters of a host-confirmed checkpoint", () => {
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
