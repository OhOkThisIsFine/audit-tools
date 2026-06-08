import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveIntakeStep } from "../src/steps/intakeResolver.js";
import { StateStore } from "../src/state/store.js";
import {
  intakePaths,
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
  type IntakeSourceManifest,
  type IntakeSummary,
} from "../src/intake.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-intake-resolver");

// Stub callbacks used across tests
function makeStubs() {
  const collectStartingPointPrompt = vi.fn(
    (_root: string, _checked: string[], _missing: string[], _paths: ReturnType<typeof intakePaths>) =>
      "collect starting point prompt",
  );
  const synthesizeIntakePrompt = vi.fn(() => "synthesize intake prompt");
  const collectIntakeClarificationsPrompt = vi.fn(() => "collect clarifications prompt");
  const extractFindingsPrompt = vi.fn(() => "extract findings prompt");
  const loaderCommand = (cmd: string) => `remediate-code ${cmd}`;
  const randomRunId = (prefix?: string) => `${prefix ?? "RUN"}-test`;

  return {
    collectStartingPointPrompt,
    synthesizeIntakePrompt,
    collectIntakeClarificationsPrompt,
    extractFindingsPrompt,
    loaderCommand,
    randomRunId,
  };
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

    const store = new StateStore(artifactsDir);
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
      store,
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
    const store = new StateStore(artifactsDir);
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
      store,
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
        contract_version: "audit-findings/v1alpha1",
        findings: [],
        work_blocks: [],
      }),
      "utf8",
    );

    const store = new StateStore(artifactsDir);
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
      store,
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

  it("ready structured_audit intake consumes the original JSON deterministically", async () => {
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
        affected_files: [],
        open_questions: [],
      }),
      "utf8",
    );
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Structured intake\n", "utf8");

    const store = new StateStore(artifactsDir);
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
      store,
      ...stubs,
    });

    expect(result.kind).toBe("state");
    if (result.kind !== "state") throw new Error("expected state");
    expect(result.state.status).toBe("planning");
    expect(result.state.plan?.findings.map((finding) => finding.id)).toEqual(["AUD-001"]);
    expect(stubs.extractFindingsPrompt).not.toHaveBeenCalled();
  });

  it("existing document input builds a document source manifest and returns synthesize_intake step", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-doc-manifest");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    const docPath = join(TEST_DIR, "feedback.md");
    await writeFile(docPath, "# Feedback\nFix bugs.", "utf8");

    const store = new StateStore(artifactsDir);
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
      store,
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

    const store = new StateStore(artifactsDir);
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
      store,
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
    const store = new StateStore(artifactsDir);
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
      store,
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

    const store = new StateStore(artifactsDir);
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
      store,
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("synthesize_intake");
    expect(result.step.status).toBe("ready");
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

    const store = new StateStore(artifactsDir);
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
      store,
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("collect_intake_clarifications");
    expect(result.step.status).toBe("blocked");
  });

  it("summary ready returns extract_findings step", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-ready");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });

    const docPath = join(TEST_DIR, "report.md");
    await writeFile(docPath, "# Report\nAll good.", "utf8");

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
      affected_files: [],
      open_questions: [],
    };
    await writeFile(join(intakeDir, "intake-summary.json"), JSON.stringify(summary), "utf8");
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief\nFix everything.", "utf8");

    const store = new StateStore(artifactsDir);
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
      store,
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("extract_findings");
    expect(result.step.status).toBe("ready");
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
      affected_files: [],
      open_questions: [],
    };
    await writeFile(join(intakeDir, "intake-summary.json"), JSON.stringify(summary), "utf8");
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief for A", "utf8");

    const store = new StateStore(artifactsDir);
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
      store,
      ...stubs,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") throw new Error("expected step");
    expect(result.step.step_kind).toBe("synthesize_intake");
    // runId should have INTAKE prefix (from randomRunId("INTAKE"))
    expect(result.step.run_id).toMatch(/^INTAKE/);
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
      affected_files: [],
      open_questions: [],
    };
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify(summary),
      "utf8",
    );

    // A previously completed brief
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief\nOld brief.", "utf8");

    const store = new StateStore(artifactsDir);
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
      store,
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
});
