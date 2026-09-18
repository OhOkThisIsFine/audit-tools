// The intake prompts 16b (collect the starting point) and 16c (intake
// questions), owner-reviewed 2026-09-18.
//
//   - FLAGS ONLY, THE TOOL OWNS THE MANIFEST: the host gives sources with
//     `--input` (repeatable) and `--guidance-file`; the source manifest is
//     tool-written, and a malformed one is refused on read with a named reason.
//   - 16c states its closed id set, and a blank answer is refused.
//   - A `ready: false` summary with no blocking question goes back to synthesis
//     with the reason, never to a question round with nothing to ask.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  intakePaths,
  readSourceManifest,
  validateClarificationResolution,
  type IntakeSummary,
} from "../../src/remediate/intake.js";
import { resolveIntakeStep } from "../../src/remediate/steps/intakeResolver.js";
import {
  collectIntakeClarificationsPrompt,
  collectStartingPointPrompt,
} from "../../src/remediate/steps/prompts.js";
import { scratchDir } from "../helpers/scratch.js";
import { intakeSummaryFixture } from "./helpers/intakeSummaryFixture.js";

const TEST_DIR = scratchDir(".test-intake-starting-point-contract");

function summary(overrides: Partial<IntakeSummary> = {}): IntakeSummary {
  return intakeSummaryFixture(overrides);
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});
afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("the source manifest is tool-only and validated on read", () => {
  const manifestPath = () => join(TEST_DIR, "source-manifest.json");

  it("reads a manifest the tool wrote", async () => {
    const manifest = {
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "input",
      sources: [{ type: "document", path: "notes.md", label: "input-01" }],
    };
    await writeFile(manifestPath(), JSON.stringify(manifest), "utf8");
    await expect(readSourceManifest(manifestPath())).resolves.toEqual(manifest);
  });

  it("returns undefined when the manifest is absent", async () => {
    await expect(readSourceManifest(manifestPath())).resolves.toBeUndefined();
  });

  it("refuses a hand-written manifest, naming the field and the recovery", async () => {
    await writeFile(
      manifestPath(),
      JSON.stringify({
        schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
        created_from: "user",
        sources: [{ type: "document", path: "notes.md", note: "hand-added" }],
      }),
      "utf8",
    );
    const read = readSourceManifest(manifestPath());
    await expect(read).rejects.toThrow(/Malformed intake source manifest/);
    await expect(readSourceManifest(manifestPath())).rejects.toThrow(/created_from/);
    await expect(readSourceManifest(manifestPath())).rejects.toThrow(/sources\.0/);
    await expect(readSourceManifest(manifestPath())).rejects.toThrow(/--guidance-file <path>/);
  });

  it("refuses a manifest with no sources", async () => {
    await writeFile(
      manifestPath(),
      JSON.stringify({
        schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
        created_from: "input",
        sources: [],
      }),
      "utf8",
    );
    await expect(readSourceManifest(manifestPath())).rejects.toThrow(/sources/);
  });
});

describe("the 16b prompt gives the starting point with flags only", () => {
  const paths = intakePaths("/run/remediation");
  const prompt = collectStartingPointPrompt("/repo", ["/repo/audit-findings.json"], [], paths);

  it("never asks the host to write the source manifest", () => {
    expect(prompt).not.toContain(paths.sourceManifest);
    expect(prompt).not.toContain('"schema_version"');
    expect(prompt).toContain("do not write a source manifest");
  });

  it("names both flags and the exact feedback path", () => {
    expect(prompt).toContain("--input");
    expect(prompt).toContain("Repeat `--input` once for each");
    expect(prompt).toContain("--guidance-file");
    expect(prompt).toContain(paths.conversationStart);
  });

  it("offers the flag commands as the step's allowed commands", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts");
    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: { supplied: false, existing: [], missing: [], checked: [], allExisting: [] },
      loaderCommand: (cmd: string) => `remediate-code ${cmd}`,
      randomRunId: (prefix?: string) => `${prefix ?? "RUN"}-test`,
      collectStartingPointPrompt: vi.fn(() => "p"),
      synthesizeIntakePrompt: vi.fn(() => "p"),
      collectIntakeClarificationsPrompt: vi.fn(() => "p"),
    });
    if (result.kind !== "step") throw new Error("expected a step");
    expect(result.step.step_kind).toBe("collect_starting_point");
    expect(result.step.allowed_commands).toEqual([
      "remediate-code next-step --input <path>",
      "remediate-code next-step --guidance-file <path>",
      "remediate-code next-step --input <path> --guidance-file <path>",
    ]);
    expect(result.step.artifact_paths).not.toHaveProperty("source_manifest");
  });
});

describe("the 16c intake question round", () => {
  const questions = summary({
    ready: false,
    open_questions: [
      { id: "Q-104", question: "Which auth flow?", blocking: true },
      { id: "Q-107", question: "Keep the v1 API?", blocking: true },
      { id: "Q-200", question: "FYI only", blocking: false },
    ],
  });

  it("uses the first real id in its example and states the closed id set", () => {
    const prompt = collectIntakeClarificationsPrompt(questions, intakePaths("/run"));
    expect(prompt).toContain('"question_id": "Q-104"');
    expect(prompt).toContain("`Q-104`, `Q-107`");
    expect(prompt).not.toContain("`Q-200`");
    expect(prompt).toContain("must not be blank");
  });

  it("refuses a blank answer by name", () => {
    const result = validateClarificationResolution(
      { answers: [{ question_id: "Q-104", answer: "  " }] },
      questions.open_questions.filter((q) => q.blocking === true),
      questions.open_questions,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answers[0].answer is blank — write the user's answer");
  });

  it("sends a ready:false summary with no blocking question back to synthesis", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts");
    const intakeDir = join(artifactsDir, "intake");
    await mkdir(intakeDir, { recursive: true });
    const docPath = join(TEST_DIR, "notes.md");
    await writeFile(docPath, "# Notes\n", "utf8");
    await writeFile(
      join(intakeDir, "source-manifest.json"),
      JSON.stringify({
        schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
        created_from: "input",
        sources: [{ type: "document", path: docPath, label: "input-01" }],
      }),
      "utf8",
    );
    await writeFile(
      join(intakeDir, "intake-summary.json"),
      JSON.stringify(
        summary({
          ready: false,
          open_questions: [{ id: "Q-001", question: "FYI", blocking: false }],
        }),
      ),
      "utf8",
    );

    const result = await resolveIntakeStep({
      root: TEST_DIR,
      artifactsDir,
      inputResolution: { supplied: false, existing: [], missing: [], checked: [], allExisting: [] },
      loaderCommand: (cmd: string) => `remediate-code ${cmd}`,
      randomRunId: (prefix?: string) => `${prefix ?? "RUN"}-test`,
      collectStartingPointPrompt: vi.fn(() => "p"),
      synthesizeIntakePrompt: vi.fn(() => "synthesize intake prompt"),
      collectIntakeClarificationsPrompt: vi.fn(() => "collect clarifications prompt"),
    });
    if (result.kind !== "step") throw new Error("expected a step");
    expect(result.step.step_kind).toBe("synthesize_intake");
    const prompt = await readFile(result.step.prompt_path, "utf8");
    expect(prompt).toContain("set `ready: false` but listed no blocking question");
  });
});
