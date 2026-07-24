import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveIntakeStep } from "../../src/remediate/steps/intakeResolver.js";
import {
  intakePaths,
  intakeSummaryContentErrors,
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
  type IntakeSourceManifest,
  type IntakeSummary,
} from "../../src/remediate/intake.js";
import { validateSuppliedInput } from "../../src/remediate/steps/intakeResolver.js";
import { scratchDir } from "../helpers/scratch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-intake-resolver");

// Stub callbacks used across tests
function makeStubs() {
  const collectStartingPointPrompt = vi.fn(
    (_root: string, _checked: string[], _missing: string[], _paths: ReturnType<typeof intakePaths>) =>
      "collect starting point prompt",
  );
  const synthesizeIntakePrompt = vi.fn(() => "synthesize intake prompt");
  const collectIntakeClarificationsPrompt = vi.fn(() => "collect clarifications prompt");
  const loaderCommand = (cmd: string) => `remediate-code ${cmd}`;
  const randomRunId = (prefix?: string) => `${prefix ?? "RUN"}-test`;

  return {
    collectStartingPointPrompt,
    synthesizeIntakePrompt,
    collectIntakeClarificationsPrompt,
    loaderCommand,
    randomRunId,
  };
}

/**
 * Helper: write a complete ready-intake artifact set (manifest + summary + brief)
 * into the given artifactsDir. Reduces boilerplate for tests that need a "ready" intake.
 */
async function writeReadyIntakeArtifacts(
  artifactsDir: string,
  docPath: string,
  summaryOverrides: Partial<IntakeSummary> = {},
): Promise<void> {
  const intakeDir = join(artifactsDir, "intake");
  await mkdir(intakeDir, { recursive: true });

  const manifest: IntakeSourceManifest = {
    schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
    created_from: "input",
    sources: [{ type: "document", path: docPath, label: "input-01" }],
  };
  await writeFile(join(intakeDir, "source-manifest.json"), JSON.stringify(manifest), "utf8");

  const summary: IntakeSummary = {
    schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
    ready: true,
    source_type: "documents",
    goals: ["Fix all bugs"],
    non_goals: [],
    constraints: [],
    affected_files: [{ path: "src/main.ts" }],
    open_questions: [],
    ...summaryOverrides,
  };
  await writeFile(join(intakeDir, "intake-summary.json"), JSON.stringify(summary), "utf8");
  await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief\nFix everything.", "utf8");
}

describe("resolveIntakeStep", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("returns collect_starting_point blocked step when manifest sources are missing on disk", async () => {
    // Arrange: create an artifactsDir with a persisted source-manifest.json whose
    // sources reference a path that does NOT exist on disk.
    const artifactsDir = join(TEST_DIR, "artifacts-missing");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    const missingPath = join(TEST_DIR, "does-not-exist.md");

    const manifest: IntakeSourceManifest = {
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "input",
      sources: [{ type: "document", path: missingPath, label: "input-01" }],
    };
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify(manifest),
      "utf8",
    );

    const stubs = makeStubs();

    // Act: no input supplied; missing/checked/existing are all empty so the
    // code falls through to resolveManifestSources which finds the path absent.
    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [],
        missing: [],
        checked: [],
      },
      ...stubs,
    });

    // Assert
    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");

    expect(result.step.step_kind).toBe("collect_starting_point");
    expect(result.step.status).toBe("blocked");

    // collectStartingPointPrompt must have been called with the missing path
    expect(stubs.collectStartingPointPrompt).toHaveBeenCalledOnce();
    const [, , missingArg] = stubs.collectStartingPointPrompt.mock.calls[0];
    expect(missingArg).toContain(missingPath);
  });

  it("returns collect_starting_point blocked step when supplied input files are all missing", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-supplied-missing");
    await mkdir(artifactsDir, { recursive: true });
    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: true,
        existing: [],
        missing: [join(TEST_DIR, "does-not-exist.md")],
        checked: [join(TEST_DIR, "does-not-exist.md")],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("collect_starting_point");
    expect(result.step.status).toBe("blocked");
  });

  it("audit-findings JSON routes through intake with a structured_audit manifest", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-fast-path");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    // Write a minimal audit-findings.json fixture
    const auditFindingsPath = join(TEST_DIR, "audit-findings.json");
    await writeFile(
      auditFindingsPath,
      JSON.stringify({
        contract_version: "audit-tools/audit-findings/v1alpha1",
        findings: [],
        work_blocks: [],
      }),
      "utf8",
    );

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: true,
        existing: [auditFindingsPath],
        missing: [],
        checked: [auditFindingsPath],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("synthesize_intake");
    expect(result.step.status).toBe("ready");

    const manifestRaw = await readFile(join(intakeDir, "source-manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as IntakeSourceManifest;
    expect(manifest.sources).toEqual([
      {
        type: "structured_audit",
        path: auditFindingsPath,
        label: "audit-findings",
      },
    ]);
  });

  it("N-R06: ready structured_audit intake returns pipeline_ready (no fast path, no extract_findings)", async () => {
    // After N-R06: structured_audit no longer calls runPlanPhase directly.
    // resolveIntakeStep returns { kind: "pipeline_ready" } so the caller routes
    // through the contract pipeline.
    const artifactsDir = join(TEST_DIR, "artifacts-structured-ready");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    const auditFindingsPath = join(TEST_DIR, "audit-findings-ready.json");
    await writeFile(
      auditFindingsPath,
      JSON.stringify({
        contract_version: "audit-findings/v1alpha1",
        findings: [
          {
            id: "AUD-001",
            title: "Structured finding",
            category: "correctness",
            severity: "medium",
            confidence: "high",
            lens: "correctness",
            summary: "Fix structured issue.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["evidence"],
          },
        ],
        work_blocks: [
          {
            id: "WB-001",
            finding_ids: ["AUD-001"],
            depends_on: [],
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
        created_from: "input",
        sources: [
          {
            type: "structured_audit",
            path: auditFindingsPath,
            label: "audit-findings",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify({
        schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
        ready: true,
        source_type: "structured_audit",
        goals: ["Remediate the structured audit findings."],
        non_goals: [],
        constraints: [],
        affected_files: [{ path: "src/a.ts" }],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Structured intake\n", "utf8");

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [],
        missing: [],
        checked: [],
      },
      ...stubs,
    });

    // N-R06: pipeline_ready, not state — fast path deleted
    expect(result.kind).toBe("pipeline_ready");
  });

  it("existing document input builds a document source manifest and returns synthesize_intake step", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-doc-manifest");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    const docPath = join(TEST_DIR, "feedback.md");
    await writeFile(docPath, "# Feedback\nFix bugs.", "utf8");

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: true,
        existing: [docPath],
        missing: [],
        checked: [docPath],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("synthesize_intake");
    expect(result.step.status).toBe("ready");

    // source-manifest.json must have been written with kind 'document'
    const manifestRaw = await readFile(join(intakeDir, "source-manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as IntakeSourceManifest;
    expect(manifest.sources.every((s) => s.type === "document")).toBe(true);
  });

  it("no supplied input and no existing candidates with a conversationStart file uses conversation manifest", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-conv-manifest");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    // Write a conversation-start.md file
    await writeFile(
      join(intakeDir, "conversation-start.md"),
      "Fix the performance issue.",
      "utf8",
    );

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [],
        missing: [],
        checked: [],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("synthesize_intake");

    // source-manifest.json must reference a 'conversation' source
    const manifestRaw = await readFile(join(intakeDir, "source-manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as IntakeSourceManifest;
    expect(manifest.created_from).toBe("conversation");
  });

  it("no manifest and no conversationStart returns collect_starting_point blocked step", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-no-input");
    await mkdir(artifactsDir, { recursive: true });
    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [],
        missing: [],
        checked: [],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("collect_starting_point");
    expect(result.step.status).toBe("blocked");
  });

  it("manifest present but summary absent returns synthesize_intake step", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-no-summary");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    const docPath = join(TEST_DIR, "notes.md");
    await writeFile(docPath, "# Notes", "utf8");

    // Write only the source manifest; no summary or brief
    const manifest: IntakeSourceManifest = {
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "input",
      sources: [{ type: "document", path: docPath, label: "input-01" }],
    };
    await writeFile(join(intakeDir, "source-manifest.json"), JSON.stringify(manifest), "utf8");

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [],
        missing: [],
        checked: [],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("synthesize_intake");
    expect(result.step.status).toBe("ready");
  });

  it("bare next-step (no --input) preserves an input-bound manifest — does not swap to a default candidate", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-preserve-input");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    const docPath = join(TEST_DIR, "remaining-specs.md");
    await writeFile(docPath, "# Specs", "utf8");
    // A stale default candidate a bare call would otherwise hijack.
    const stalePath = join(TEST_DIR, "audit-findings.json");
    await writeFile(stalePath, JSON.stringify({ findings: [] }), "utf8");

    const manifest: IntakeSourceManifest = {
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "input",
      sources: [{ type: "document", path: docPath, label: "input-01" }],
    };
    await writeFile(join(intakeDir, "source-manifest.json"), JSON.stringify(manifest), "utf8");

    const stubs = makeStubs();
    await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      // Bare call: default discovery surfaced the stale candidate, no --input.
      inputResolution: { supplied: false, existing: [stalePath], missing: [], checked: [stalePath] },
      ...stubs,
    });

    // The on-disk manifest must STILL be the input-bound document, never the candidate.
    const after = JSON.parse(await readFile(join(intakeDir, "source-manifest.json"), "utf8"));
    expect(after.created_from).toBe("input");
    expect(after.sources[0].path).toBe(docPath);
  });

  it("summary present but not ready and no clarification resolution returns collect_intake_clarifications step", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-not-ready");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    const docPath = join(TEST_DIR, "notes2.md");
    await writeFile(docPath, "# Notes 2", "utf8");

    const manifest: IntakeSourceManifest = {
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "input",
      sources: [{ type: "document", path: docPath, label: "input-01" }],
    };
    await writeFile(join(intakeDir, "source-manifest.json"), JSON.stringify(manifest), "utf8");

    // Summary is NOT ready (ready: false, has a blocking open question)
    const summary: IntakeSummary = {
      schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
      ready: false,
      source_type: "documents",
      goals: [],
      non_goals: [],
      constraints: [],
      affected_files: [],
      open_questions: [
        { id: "Q1", question: "What is the target language?", blocking: true },
      ],
    };
    await writeFile(join(intakeDir, "intake-summary.json"), JSON.stringify(summary), "utf8");
    // Write the brief so only the unready summary + absent clarification triggers the clarifications step
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief", "utf8");

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [],
        missing: [],
        checked: [],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("collect_intake_clarifications");
    expect(result.step.status).toBe("blocked");
  });

  it("N-R06: summary ready for document source returns pipeline_ready (extract_findings deleted)", async () => {
    // After N-R06: the extract_findings step is removed. resolveIntakeStep now
    // returns { kind: "pipeline_ready" } for document/conversation sources too.
    const artifactsDir = join(TEST_DIR, "artifacts-ready");
    const docPath = join(TEST_DIR, "report.md");
    await writeFile(docPath, "# Report\nAll good.", "utf8");
    await writeReadyIntakeArtifacts(artifactsDir, docPath);

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [],
        missing: [],
        checked: [],
      },
      ...stubs,
    });

    expect(result.kind).toBe("pipeline_ready");
  });

  it("manifest refresh clears stale summary and brief so synthesize_intake is re-issued", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-refresh-runid");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    const fileA = join(TEST_DIR, "file-a2.md");
    await writeFile(fileA, "# file A", "utf8");
    const fileB = join(TEST_DIR, "file-b2.md");
    await writeFile(fileB, "# file B", "utf8");

    // Persisted manifest pointing at A
    const oldManifest: IntakeSourceManifest = {
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "input",
      sources: [{ type: "document", path: fileA, label: "input-01" }],
    };
    await writeFile(join(intakeDir, "source-manifest.json"), JSON.stringify(oldManifest), "utf8");

    // A previously completed summary+brief
    const summary: IntakeSummary = {
      schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
      ready: true,
      source_type: "documents",
      goals: ["Fix A"],
      non_goals: [],
      constraints: [],
      affected_files: [{ path: "src/a.ts" }],
      open_questions: [],
    };
    await writeFile(join(intakeDir, "intake-summary.json"), JSON.stringify(summary), "utf8");
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief for A", "utf8");

    const stubs = makeStubs();

    // Supply file B — causes manifest refresh
    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: true,
        existing: [fileB],
        missing: [],
        checked: [fileB],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("synthesize_intake");
    // runId should have INTAKE prefix (from randomRunId("INTAKE"))
    expect(result.step.run_id).toMatch(/^INTAKE/);
  });

  it("N-R01: auto-discovered candidate emits confirm_auto_discovered_input (blocked)", async () => {
    // When !supplied && existing.length > 0 && !manifest, emit the confirmation
    // step rather than silently writing source-manifest.json and proceeding.
    const artifactsDir = join(TEST_DIR, "artifacts-auto-discover");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    const auditFindingsPath = join(TEST_DIR, "audit-findings-auto.json");
    await writeFile(
      auditFindingsPath,
      JSON.stringify({
        contract_version: "audit-findings/v1alpha1",
        findings: [
          {
            id: "AF-001",
            title: "Auto-discovered finding",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["evidence"],
          },
        ],
        work_blocks: [],
      }),
      "utf8",
    );

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [auditFindingsPath],
        missing: [],
        checked: [auditFindingsPath],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("confirm_auto_discovered_input");
    expect(result.step.status).toBe("blocked");
  });

  it("N-R01: confirm_auto_discovered_input prompt names the discovered file path", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-auto-discover-prompt");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    const auditFindingsPath = join(TEST_DIR, "audit-findings-prompt.json");
    await writeFile(
      auditFindingsPath,
      JSON.stringify({
        contract_version: "audit-findings/v1alpha1",
        findings: [],
        work_blocks: [],
      }),
      "utf8",
    );

    const stubs = makeStubs();

    // Write the step's current-prompt.md and check it includes the path
    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [auditFindingsPath],
        missing: [],
        checked: [auditFindingsPath],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("confirm_auto_discovered_input");
    // The prompt written to disk should name the discovered path
    const prompt = await readFile(result.step.prompt_path, "utf8");
    expect(prompt).toContain(auditFindingsPath);
  });

  it("N-R01: with ack confirmed, proceeds past confirm_auto_discovered_input to intake", async () => {
    // When confirm_auto_discovered_input_ack.json exists with status 'confirmed',
    // resolveIntakeStep should NOT re-emit the confirmation step — it proceeds.
    const artifactsDir = join(TEST_DIR, "artifacts-auto-discover-acked");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    const auditFindingsPath = join(TEST_DIR, "audit-findings-acked.json");
    await writeFile(
      auditFindingsPath,
      JSON.stringify({
        contract_version: "audit-findings/v1alpha1",
        findings: [],
        work_blocks: [],
      }),
      "utf8",
    );

    // Write the ack
    await writeFile(
      join(artifactsDir, "confirm_auto_discovered_input_ack.json"),
      JSON.stringify({ status: "confirmed" }),
      "utf8",
    );

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [auditFindingsPath],
        missing: [],
        checked: [auditFindingsPath],
      },
      ...stubs,
    });

    // Should advance past the gate — no longer confirm_auto_discovered_input
    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).not.toBe("confirm_auto_discovered_input");
  });

  it("N-R01: a --guidance-file (conversationStart present) skips the discovered-sources gate — explicit source is not blocked", async () => {
    // The decline→re-offer loop fix: a discovered candidate must NOT re-trigger the
    // confirmation once the host supplied guidance (conversation-start.md exists).
    const artifactsDir = join(TEST_DIR, "artifacts-guidance-skips-gate");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(join(intakeDir, "conversation-start.md"), "Fix the flaky test.", "utf8");

    const auditFindingsPath = join(TEST_DIR, "audit-findings-guidance.json");
    await writeFile(
      auditFindingsPath,
      JSON.stringify({ contract_version: "audit-findings/v1alpha1", findings: [], work_blocks: [] }),
      "utf8",
    );

    const stubs = makeStubs();
    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [auditFindingsPath],
        missing: [],
        checked: [auditFindingsPath],
        allExisting: [auditFindingsPath],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    // Proceeds with the guidance (conversation manifest), never re-blocks on the candidate.
    expect(result.step.step_kind).not.toBe("confirm_auto_discovered_input");
    expect(result.step.step_kind).toBe("synthesize_intake");
  });

  it("registers conversation-start as the source, never the stale default candidate, when a guidance file is present", async () => {
    // Bug (2026-07-02): a fresh --guidance-file run wrote the guidance to
    // conversation-start.md, but the source manifest was built
    // `created_from: default_candidates` pointing at a leftover audit-findings.json —
    // remediating the wrong (stale) source. A present conversation-start.md must win
    // over any stale default candidate on disk (an explicit --input still wins over both).
    const artifactsDir = join(TEST_DIR, "artifacts-guidance-source");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(join(intakeDir, "conversation-start.md"), "Fix the flaky test.", "utf8");

    // A stale, unrelated audit-findings.json a default-candidate scan surfaced.
    const stalePath = join(TEST_DIR, "audit-findings.json");
    await writeFile(
      stalePath,
      JSON.stringify({ contract_version: "audit-findings/v1alpha1", findings: [], work_blocks: [] }),
      "utf8",
    );

    const stubs = makeStubs();
    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [stalePath],
        missing: [],
        checked: [stalePath],
        allExisting: [stalePath],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("synthesize_intake");

    const manifest = JSON.parse(
      await readFile(join(intakeDir, "source-manifest.json"), "utf8"),
    ) as IntakeSourceManifest;
    expect(manifest.created_from).toBe("conversation");
    // The stale default candidate must NOT be registered as a source.
    expect(manifest.sources.map((s) => s.path)).not.toContain(stalePath);
  });

  it("N-R01: a declined ack routes to collect_starting_point, not a re-offer of the same candidate", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-auto-declined");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });
    const auditFindingsPath = join(TEST_DIR, "audit-findings-declined.json");
    await writeFile(
      auditFindingsPath,
      JSON.stringify({ contract_version: "audit-findings/v1alpha1", findings: [], work_blocks: [] }),
      "utf8",
    );
    await writeFile(
      join(artifactsDir, "confirm_auto_discovered_input_ack.json"),
      JSON.stringify({ status: "declined" }),
      "utf8",
    );

    const stubs = makeStubs();
    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [auditFindingsPath],
        missing: [],
        checked: [auditFindingsPath],
        allExisting: [auditFindingsPath],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("collect_starting_point");
  });

  it("N-R01: the discovered-sources manifest lists EVERY existing candidate, not just the best", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-multi-source");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });
    const jsonPath = join(TEST_DIR, "multi-findings.json");
    const mdPath = join(TEST_DIR, "multi-report.md");
    await writeFile(
      jsonPath,
      JSON.stringify({ contract_version: "audit-findings/v1alpha1", findings: [], work_blocks: [] }),
      "utf8",
    );
    await writeFile(mdPath, "# Report\n", "utf8");

    const stubs = makeStubs();
    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [jsonPath],
        missing: [],
        checked: [jsonPath, mdPath],
        allExisting: [jsonPath, mdPath],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("confirm_auto_discovered_input");
    const prompt = await readFile(result.step.prompt_path, "utf8");
    expect(prompt).toContain(jsonPath);
    expect(prompt).toContain(mdPath);
    // Each discovered source carries provenance metadata (type/mtime).
    expect(prompt).toMatch(/type: (document|structured_audit)/);
  });

  it("discards existing summary and brief when the manifest is refreshed", async () => {
    // Arrange: pre-populate artifactsDir with a completed intake referencing file A,
    // then call resolveIntakeStep with inputResolution.supplied=true pointing at
    // a DIFFERENT existing file B. This makes the new manifest non-equivalent to
    // the persisted one, triggering manifestRefreshed=true and discarding summary/brief.
    const artifactsDir = join(TEST_DIR, "artifacts-refresh");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    // File A — what the persisted manifest points to
    const fileA = join(TEST_DIR, "file-a.md");
    await writeFile(fileA, "# file A content", "utf8");

    // File B — what the new input points to (different path → manifests differ)
    const fileB = join(TEST_DIR, "file-b.md");
    await writeFile(fileB, "# file B content", "utf8");

    // Persisted manifest referencing file A
    const oldManifest: IntakeSourceManifest = {
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "input",
      sources: [{ type: "document", path: fileA, label: "input-01" }],
    };
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify(oldManifest),
      "utf8",
    );

    // A previously completed summary (ready=true, no blocking questions)
    const summary: IntakeSummary = {
      schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
      ready: true,
      source_type: "documents",
      goals: ["Fix bugs"],
      non_goals: [],
      constraints: [],
      affected_files: [{ path: "src/index.ts" }],
      open_questions: [],
    };
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify(summary),
      "utf8",
    );

    // A previously completed brief
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief\nOld brief.", "utf8");

    const stubs = makeStubs();

    // Act: supply file B as the new input
    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: true,
        existing: [fileB],
        missing: [],
        checked: [fileB],
      },
      ...stubs,
    });

    // Assert: manifestRefreshed=true causes summary/brief to be discarded,
    // so the function should return a synthesize_intake step (not extract_findings).
    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");

    expect(result.step.step_kind).toBe("synthesize_intake");

    // The new source-manifest.json on disk must reference file B, not file A.
    const persistedManifestRaw = await readFile(
      join(intakeDir, "source-manifest.json"),
      "utf8",
    );
    const persistedManifest = JSON.parse(persistedManifestRaw) as IntakeSourceManifest;
    expect(persistedManifest.sources.map((s) => s.path)).toContain(fileB);
    expect(persistedManifest.sources.map((s) => s.path)).not.toContain(fileA);
  });

  // N-R02: manifest-time input validation
  it("N-R02: malformed JSON supplied input returns blocked collect_starting_point step", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-bad-json");
    await mkdir(artifactsDir, { recursive: true });

    const badJsonPath = join(TEST_DIR, "bad-input.json");
    await writeFile(badJsonPath, "{ not valid json !!!}", "utf8");

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: true,
        existing: [badJsonPath],
        missing: [],
        checked: [badJsonPath],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("collect_starting_point");
    expect(result.step.status).toBe("blocked");
    // collectStartingPointPrompt must have been called with the bad-JSON path in the missing array
    expect(stubs.collectStartingPointPrompt).toHaveBeenCalledOnce();
    const [, , missingArg] = stubs.collectStartingPointPrompt.mock.calls[0];
    expect(missingArg).toContain(badJsonPath);
  });

  it("N-R02: JSON file with unrecognised schema_version returns blocked collect_starting_point step", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-unknown-schema");
    await mkdir(artifactsDir, { recursive: true });

    const unknownSchemaPath = join(TEST_DIR, "unknown-schema.json");
    await writeFile(
      unknownSchemaPath,
      JSON.stringify({ schema_version: "unknown/v9", data: "something" }),
      "utf8",
    );

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: true,
        existing: [unknownSchemaPath],
        missing: [],
        checked: [unknownSchemaPath],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("collect_starting_point");
    expect(result.step.status).toBe("blocked");
  });

  it("N-R02: intake summary with ready:true but empty goals re-issues synthesize_intake step", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-empty-goals");
    const docPath = join(TEST_DIR, "feedback-empty-goals.md");
    await writeFile(docPath, "# Feedback", "utf8");
    await writeReadyIntakeArtifacts(artifactsDir, docPath, {
      goals: [],
      affected_files: [{ path: "src/a.ts" }],
    });

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [],
        missing: [],
        checked: [],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("synthesize_intake");
    expect(result.step.status).toBe("ready");
  });

  it("N-R02: intake summary with ready:true but empty affected_files re-issues synthesize_intake step", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-empty-affected");
    const docPath = join(TEST_DIR, "feedback-empty-affected.md");
    await writeFile(docPath, "# Feedback", "utf8");
    await writeReadyIntakeArtifacts(artifactsDir, docPath, {
      goals: ["Fix bugs"],
      affected_files: [],
    });

    const stubs = makeStubs();

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: {
        supplied: false,
        existing: [],
        missing: [],
        checked: [],
      },
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("synthesize_intake");
    expect(result.step.status).toBe("ready");
  });
});

// N-R02: intakeSummaryContentErrors unit tests
describe("intakeSummaryContentErrors", () => {
  it("returns empty array for a valid ready summary", () => {
    const summary: IntakeSummary = {
      schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
      ready: true,
      source_type: "documents",
      goals: ["Fix bugs"],
      non_goals: [],
      constraints: [],
      affected_files: [{ path: "src/a.ts" }],
      open_questions: [],
    };
    expect(intakeSummaryContentErrors(summary)).toEqual([]);
  });

  it("returns errors for ready summary with empty goals and affected_files", () => {
    const summary: IntakeSummary = {
      schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
      ready: true,
      source_type: "documents",
      goals: [],
      non_goals: [],
      constraints: [],
      affected_files: [],
      open_questions: [],
    };
    const errors = intakeSummaryContentErrors(summary);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.includes("goals"))).toBe(true);
  });

  it("does not flag non-ready summaries for empty content", () => {
    const summary: IntakeSummary = {
      schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
      ready: false,
      source_type: "documents",
      goals: [],
      non_goals: [],
      constraints: [],
      affected_files: [],
      open_questions: [],
    };
    expect(intakeSummaryContentErrors(summary)).toEqual([]);
  });
});

// N-R02: validateSuppliedInput unit tests
describe("validateSuppliedInput", () => {
  it("returns ok:true for valid JSON without schema_version", () => {
    const result = validateSuppliedInput("file.json", JSON.stringify({ foo: "bar" }));
    expect(result.ok).toBe(true);
  });

  it("returns ok:false for malformed JSON", () => {
    const result = validateSuppliedInput("file.json", "{ not json");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.reason).toContain("not valid JSON");
  });

  it("returns ok:false for JSON with unknown schema_version", () => {
    const result = validateSuppliedInput(
      "file.json",
      JSON.stringify({ schema_version: "unknown/v9" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.reason).toContain("unknown/v9");
  });

  it("returns ok:true for JSON with a known schema_version", () => {
    const result = validateSuppliedInput(
      "file.json",
      JSON.stringify({ schema_version: "audit-findings/v1alpha1" }),
    );
    expect(result.ok).toBe(true);
  });
});
