import { test, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { writeStepContract, currentStepPath, currentPromptPath, processAgentId } = await import("../../src/shared/io/stepContractWriter.ts");
const { stepsDir } = await import("../../src/shared/io/auditToolsPaths.ts");

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

    expect(step.contract_version).toBe("test-step/v1");
    expect(step.step_kind).toBe("demo_step");
    expect(step.status).toBe("ready");
    expect(step.run_id).toBe("RUN-1");
    expect(step.allowed_commands).toEqual(["some-cmd"]);
    expect(step.stop_condition).toBe("Stop when done.");

    // current-prompt.md holds the verbatim prompt.
    const promptOnDisk = await readFile(currentPromptPath(artifactsDir), "utf8");
    expect(promptOnDisk).toBe("Do the step.");

    // current-step.json round-trips to the returned object.
    const raw = await readFile(currentStepPath(artifactsDir), "utf8");
    expect(JSON.parse(raw)).toEqual(step);
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
    expect(!step.prompt_path.includes("\\"), "prompt_path has no backslash").toBeTruthy();
    expect(!step.repo_root.includes("\\"), "repo_root has no backslash").toBeTruthy();
    expect(!step.artifacts_dir.includes("\\"), "artifacts_dir has no backslash").toBeTruthy();
    expect(step.repo_root).toBe("C:/Code/my-repo");
    for (const value of Object.values(step.artifact_paths)) {
      if (value !== null) {
        expect(!value.includes("\\"), `artifact_paths value has no backslash: ${value}`).toBeTruthy();
      }
    }
    expect(step.artifact_paths.source_manifest).toBe("C:/Code/my-repo/.audit-tools/remediation/intake/source-manifest.json");
    // null entries are preserved (audit allows not-yet-materialized artifacts).
    expect(step.artifact_paths.not_yet).toBe(null);
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

    expect(step.artifact_paths.current_step.endsWith("current-step.json"), "current_step must be the canonical computed path").toBeTruthy();
    expect(step.artifact_paths.current_prompt.endsWith("current-prompt.md"), "current_prompt must be the canonical computed path").toBeTruthy();
    expect(!step.artifact_paths.current_step.includes("attacker")).toBeTruthy();
    expect(!step.artifact_paths.current_prompt.includes("attacker")).toBeTruthy();
    // Non-canonical caller keys survive (normalized).
    expect(step.artifact_paths.my_artifact).toBe("C:/repo/foo.json");
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

    expect(step.progress).toEqual({ summary: "halfway" });
    // Canonical fields written AFTER extraFields win and are normalized.
    expect(step.repo_root).toBe("C:/Code/my-repo");
    expect(!step.prompt_path.includes("attacker")).toBeTruthy();
    expect(step.artifact_paths.current_step.endsWith("current-step.json")).toBeTruthy();
    expect(!step.artifact_paths.current_step.includes("attacker")).toBeTruthy();
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
    expect(await readFile(currentPromptPath(artifactsDir), "utf8")).toBe("\n  hi");

    // trimPromptStart: true → leading whitespace stripped.
    await writeStepContract(
      baseInput(artifactsDir, { prompt: "\n  hi", trimPromptStart: true }),
    );
    expect(await readFile(currentPromptPath(artifactsDir), "utf8")).toBe("hi");
  } finally {
    await cleanup();
  }
});

test("currentStepPath/currentPromptPath live under the shared stepsDir", () => {
  const artifactsDir = join(tmpdir(), "some-artifacts");
  expect(currentStepPath(artifactsDir)).toBe(join(stepsDir(artifactsDir), "current-step.json"));
  expect(currentPromptPath(artifactsDir)).toBe(join(stepsDir(artifactsDir), "current-prompt.md"));
});

test("currentStepPath/currentPromptPath insert a per-agent subdir when given an agentId", () => {
  const artifactsDir = join(tmpdir(), "some-artifacts");
  expect(currentStepPath(artifactsDir, "a-1")).toBe(join(stepsDir(artifactsDir), "a-1", "current-step.json"));
  expect(currentPromptPath(artifactsDir, "a-1")).toBe(join(stepsDir(artifactsDir), "a-1", "current-prompt.md"));
});

test("writeStepContract returns a PER-AGENT prompt_path and also mirrors a shared latest pointer", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, ".audit-tools", "audit");
    const step = await writeStepContract(baseInput(artifactsDir, { prompt: "AGENT PROMPT" }));
    const agentId = processAgentId();

    // Returned/canonical paths are the per-agent slot (concurrency-safe handoff).
    expect(step.agent_id === agentId, "contract carries the process agent id").toBeTruthy();
    expect(step.prompt_path.includes(agentId), "returned prompt_path points at the per-agent slot").toBeTruthy();
    expect(await readFile(currentPromptPath(artifactsDir, agentId), "utf8"), "per-agent prompt file has the content").toBe("AGENT PROMPT");

    // Shared latest pointer is ALSO written (single-agent back-compat / helpers).
    expect(await readFile(currentPromptPath(artifactsDir), "utf8"), "shared latest current-prompt.md mirrors the step").toBe("AGENT PROMPT");
    const sharedStep = JSON.parse(
      await readFile(currentStepPath(artifactsDir), "utf8"),
    );
    expect(sharedStep.agent_id, "shared latest current-step.json mirrors the step").toBe(agentId);
  } finally {
    await cleanup();
  }
});
