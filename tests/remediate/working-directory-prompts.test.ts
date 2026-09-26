/** FINDING-004: Host-facing step-contract paths are slash-safe. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { scratchDir } from "../helpers/scratch.js";

const TEST_DIR = scratchDir(".test-workdir-prompts");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("writeCurrentStep — slash-safe step contract JSON (FINDING-004)", () => {
  it("step contract JSON exposes prompt_path without backslashes", async () => {
    const { writeCurrentStep } = await import("../../src/remediate/steps/stepWriter.js");
    const step = await writeCurrentStep({
      stepKind: "collect_starting_point",
      status: "blocked",
      runId: "RUN-1",
      // Simulate Windows-style absolute paths.
      repoRoot: "C:\\Code\\my-repo",
      artifactsDir: ARTIFACTS_DIR,
      prompt: "Test prompt.",
      allowedCommands: [],
      stopCondition: "Stop after done.",
    });

    expect(step.repo_root).not.toContain("\\");
    expect(step.repo_root).toBe("C:/Code/my-repo");
    expect(step.prompt_path).not.toContain("\\");
    expect(step.artifacts_dir).not.toContain("\\");
  });

  it("step contract JSON exposes artifact_paths without backslashes", async () => {
    const { writeCurrentStep } = await import("../../src/remediate/steps/stepWriter.js");
    const step = await writeCurrentStep({
      stepKind: "collect_starting_point",
      status: "blocked",
      runId: "RUN-1",
      repoRoot: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      prompt: "Test prompt.",
      allowedCommands: [],
      stopCondition: "Stop after done.",
      artifactPaths: {
        source_manifest: "C:\\Code\\my-repo\\.audit-tools\\remediation\\intake\\source-manifest.json",
      },
    });

    for (const value of Object.values(step.artifact_paths)) {
      expect(value).not.toContain("\\");
    }
  });

  it("forwards RemediationStep.access through the shared step writer", async () => {
    // Packet 7 (Prompt Contract v1): a step emitter can bind its prompt's exact
    // read/write scope (`access`) and the field must ride through `WriteStepInput`
    // into the persisted contract JSON, mirroring audit's writer — never dropped
    // or clobbered by the canonical path fields. The read-scope guarantee
    // (`renderedPathsInScope` in audit-tools/shared) only means anything when this
    // binding lands on disk. Scope arrays forward verbatim (audit's writer does
    // not slash-normalize them either — consumers normalize before comparing, as
    // `design-review-contract-independence.test.ts` does).
    const { writeCurrentStep } = await import("../../src/remediate/steps/stepWriter.js");
    const access = {
      read_paths: ["C:/Code/my-repo/.audit-tools/remediation/intake/summary.json"],
      write_paths: ["C:/Code/my-repo/.audit-tools/remediation/steps/result.json"],
    };
    const step = await writeCurrentStep({
      stepKind: "contract_pipeline",
      status: "blocked",
      runId: "RUN-1",
      repoRoot: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      prompt: "Test prompt.",
      allowedCommands: [],
      stopCondition: "Stop after done.",
      access,
    });

    expect(step.access).toEqual({
      read_paths: access.read_paths,
      write_paths: access.write_paths,
    });

    // The access field never shadows the canonical path fields the writer owns.
    expect(step.prompt_path.length).toBeGreaterThan(0);
    expect(step.artifact_paths).toBeDefined();
  });
});
