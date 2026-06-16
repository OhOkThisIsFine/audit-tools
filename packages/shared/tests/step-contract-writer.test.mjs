import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { writeStepContract, currentStepPath, currentPromptPath } = await import(
  "../src/io/stepContractWriter.ts"
);
const { stepsDir } = await import("../src/io/auditToolsPaths.ts");

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "step-contract-writer-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function baseInput(artifactsDir, overrides = {}) {
  return {
    contractVersion: "test-step/v1",
    stepKind: "demo_step",
    status: "ready",
    runId: "RUN-1",
    repoRoot: artifactsDir,
    artifactsDir,
    prompt: "Do the step.",
    allowedCommands: ["some-cmd"],
    stopCondition: "Stop when done.",
    artifactPaths: {},
    ...overrides,
  };
}

test("writeStepContract writes prompt + atomic current-step.json and returns the contract", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    const step = await writeStepContract(baseInput(artifactsDir));

    assert.equal(step.contract_version, "test-step/v1");
    assert.equal(step.step_kind, "demo_step");
    assert.equal(step.status, "ready");
    assert.equal(step.run_id, "RUN-1");
    assert.deepEqual(step.allowed_commands, ["some-cmd"]);
    assert.equal(step.stop_condition, "Stop when done.");

    // current-prompt.md holds the verbatim prompt.
    const promptOnDisk = await readFile(currentPromptPath(artifactsDir), "utf8");
    assert.equal(promptOnDisk, "Do the step.");

    // current-step.json round-trips to the returned object.
    const raw = await readFile(currentStepPath(artifactsDir), "utf8");
    assert.deepEqual(JSON.parse(raw), step);
  } finally {
    await cleanup();
  }
});

test("writeStepContract normalizes ALL host-facing path fields to forward slashes", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    const step = await writeStepContract(
      baseInput(artifactsDir, {
        repoRoot: "C:\\Code\\my-repo",
        artifactsDir,
        artifactPaths: {
          source_manifest:
            "C:\\Code\\my-repo\\.audit-tools\\remediation\\intake\\source-manifest.json",
          not_yet: null,
        },
      }),
    );

    // No backslashes anywhere in any path field.
    assert.ok(!step.prompt_path.includes("\\"), "prompt_path has no backslash");
    assert.ok(!step.repo_root.includes("\\"), "repo_root has no backslash");
    assert.ok(!step.artifacts_dir.includes("\\"), "artifacts_dir has no backslash");
    assert.equal(step.repo_root, "C:/Code/my-repo");
    for (const value of Object.values(step.artifact_paths)) {
      if (value !== null) {
        assert.ok(!value.includes("\\"), `artifact_paths value has no backslash: ${value}`);
      }
    }
    assert.equal(
      step.artifact_paths.source_manifest,
      "C:/Code/my-repo/.audit-tools/remediation/intake/source-manifest.json",
    );
    // null entries are preserved (audit allows not-yet-materialized artifacts).
    assert.equal(step.artifact_paths.not_yet, null);
  } finally {
    await cleanup();
  }
});

test("writeStepContract canonical current_step/current_prompt always win over caller-supplied keys", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    const step = await writeStepContract(
      baseInput(artifactsDir, {
        artifactPaths: {
          // A caller (or step config) must NOT be able to repoint the host.
          current_step: "C:\\attacker\\evil.json",
          current_prompt: "C:\\attacker\\evil.md",
          my_artifact: "C:\\repo\\foo.json",
        },
      }),
    );

    assert.ok(
      step.artifact_paths.current_step.endsWith("current-step.json"),
      "current_step must be the canonical computed path",
    );
    assert.ok(
      step.artifact_paths.current_prompt.endsWith("current-prompt.md"),
      "current_prompt must be the canonical computed path",
    );
    assert.ok(!step.artifact_paths.current_step.includes("attacker"));
    assert.ok(!step.artifact_paths.current_prompt.includes("attacker"));
    // Non-canonical caller keys survive (normalized).
    assert.equal(step.artifact_paths.my_artifact, "C:/repo/foo.json");
  } finally {
    await cleanup();
  }
});

test("writeStepContract spreads extraFields but they cannot clobber the normalized path fields", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    const step = await writeStepContract(
      baseInput(artifactsDir, {
        repoRoot: "C:\\Code\\my-repo",
        extraFields: {
          progress: { summary: "halfway" },
          // Attempt to override the canonical path fields via extraFields.
          repo_root: "C:\\attacker\\evil",
          prompt_path: "C:\\attacker\\evil.md",
          artifact_paths: { current_step: "C:\\attacker\\evil.json" },
        },
      }),
    );

    assert.deepEqual(step.progress, { summary: "halfway" });
    // Canonical fields written AFTER extraFields win and are normalized.
    assert.equal(step.repo_root, "C:/Code/my-repo");
    assert.ok(!step.prompt_path.includes("attacker"));
    assert.ok(step.artifact_paths.current_step.endsWith("current-step.json"));
    assert.ok(!step.artifact_paths.current_step.includes("attacker"));
  } finally {
    await cleanup();
  }
});

test("writeStepContract trimPromptStart trims leading whitespace only when requested", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");

    // Default: verbatim.
    await writeStepContract(baseInput(artifactsDir, { prompt: "\n  hi" }));
    assert.equal(await readFile(currentPromptPath(artifactsDir), "utf8"), "\n  hi");

    // trimPromptStart: true → leading whitespace stripped.
    await writeStepContract(
      baseInput(artifactsDir, { prompt: "\n  hi", trimPromptStart: true }),
    );
    assert.equal(await readFile(currentPromptPath(artifactsDir), "utf8"), "hi");
  } finally {
    await cleanup();
  }
});

test("currentStepPath/currentPromptPath live under the shared stepsDir", () => {
  const artifactsDir = join(tmpdir(), "some-artifacts");
  assert.equal(currentStepPath(artifactsDir), join(stepsDir(artifactsDir), "current-step.json"));
  assert.equal(currentPromptPath(artifactsDir), join(stepsDir(artifactsDir), "current-prompt.md"));
});
