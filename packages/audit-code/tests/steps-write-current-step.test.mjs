import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

const { writeCurrentStep, STEP_CONTRACT_VERSION } = await import(
  "../src/cli/steps.ts"
);

/**
 * Create a temporary directory for a test, return the directory path and a
 * cleanup function. The caller is responsible for calling cleanup() in a
 * finally block.
 */
async function makeTempDir() {
  const dir = await mkdtemp(join(os.tmpdir(), "audit-steps-test-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Minimal valid params for writeCurrentStep. */
function baseParams(artifactsDir) {
  return {
    artifactsDir,
    stepKind: "dispatch_review",
    status: "ready",
    runId: "run-abc123",
    allowedCommands: ["audit-code next-step"],
    stopCondition: "Stop when done.",
    repoRoot: "/tmp/repo",
    artifactPaths: {},
    prompt: "Do the audit step.",
  };
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

test("writeCurrentStep writes prompt to current-prompt.md and returns correct StepArtifact", async (t) => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const params = {
      ...baseParams(artifactsDir),
      allowedCommands: ["audit-code next-step", "cat some-file"],
    };
    const step = await writeCurrentStep(params);

    await t.test("contract_version matches STEP_CONTRACT_VERSION", () => {
      assert.strictEqual(step.contract_version, STEP_CONTRACT_VERSION);
    });

    await t.test("step_kind matches input", () => {
      assert.strictEqual(step.step_kind, params.stepKind);
    });

    await t.test("status matches input", () => {
      assert.strictEqual(step.status, params.status);
    });

    await t.test("run_id matches input", () => {
      assert.strictEqual(step.run_id, params.runId);
    });

    await t.test("allowed_commands deep-equals input", () => {
      assert.deepStrictEqual(step.allowed_commands, params.allowedCommands);
    });

    await t.test("stop_condition matches input", () => {
      assert.strictEqual(step.stop_condition, params.stopCondition);
    });

    await t.test("repo_root matches input", () => {
      assert.strictEqual(step.repo_root, params.repoRoot);
    });

    await t.test("artifacts_dir matches input", () => {
      assert.strictEqual(step.artifacts_dir, params.artifactsDir);
    });

    await t.test("prompt_path file contains exact prompt string", async () => {
      const written = await readFile(step.prompt_path, "utf8");
      assert.strictEqual(written, params.prompt);
    });

    await t.test("current-step.json round-trips to the returned StepArtifact", async () => {
      const raw = await readFile(step.artifact_paths.current_step, "utf8");
      const parsed = JSON.parse(raw);
      assert.deepStrictEqual(parsed, step);
    });
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Conditional `progress` field
// ---------------------------------------------------------------------------

test("writeCurrentStep omits progress when not supplied", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep(baseParams(artifactsDir));
    assert.ok(!("progress" in step), "'progress' must not be present when not supplied");
  } finally {
    await cleanup();
  }
});

test("writeCurrentStep includes progress when supplied", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const progress = { summary: "12 tasks remaining", pending_tasks: 12, max_concurrent_agents: 4 };
    const step = await writeCurrentStep({ ...baseParams(artifactsDir), progress });
    assert.deepStrictEqual(step.progress, progress);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Conditional `allowed_mcp_tools` field
// ---------------------------------------------------------------------------

test("writeCurrentStep omits allowed_mcp_tools when not supplied", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep(baseParams(artifactsDir));
    assert.ok(!("allowed_mcp_tools" in step), "'allowed_mcp_tools' must not be present when not supplied");
  } finally {
    await cleanup();
  }
});

test("writeCurrentStep omits allowed_mcp_tools when empty array is supplied", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep({ ...baseParams(artifactsDir), allowedMcpTools: [] });
    assert.ok(!("allowed_mcp_tools" in step), "'allowed_mcp_tools' must not be present for empty array");
  } finally {
    await cleanup();
  }
});

test("writeCurrentStep includes allowed_mcp_tools when a non-empty array is supplied", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const tools = ["mcp__tool_a", "mcp__tool_b"];
    const step = await writeCurrentStep({ ...baseParams(artifactsDir), allowedMcpTools: tools });
    assert.deepStrictEqual(step.allowed_mcp_tools, tools);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Conditional `access` field
// ---------------------------------------------------------------------------

test("writeCurrentStep omits access when not supplied", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep(baseParams(artifactsDir));
    assert.ok(!("access" in step), "'access' must not be present when not supplied");
  } finally {
    await cleanup();
  }
});

test("writeCurrentStep includes access when supplied", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const access = { read_paths: ["/repo/src"], write_paths: ["/repo/dist"] };
    const step = await writeCurrentStep({ ...baseParams(artifactsDir), access });
    assert.deepStrictEqual(step.access, access);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// artifact_paths merge
// ---------------------------------------------------------------------------

test("writeCurrentStep artifact_paths merges current_step and current_prompt with caller-supplied paths", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const callerPaths = { my_artifact: "/tmp/foo.json", another: null };
    const step = await writeCurrentStep({
      ...baseParams(artifactsDir),
      artifactPaths: callerPaths,
    });

    assert.ok(
      step.artifact_paths.current_step.endsWith("current-step.json"),
      "current_step must end with current-step.json",
    );
    assert.ok(
      step.artifact_paths.current_prompt.endsWith("current-prompt.md"),
      "current_prompt must end with current-prompt.md",
    );
    assert.strictEqual(step.artifact_paths.my_artifact, "/tmp/foo.json");
    assert.strictEqual(step.artifact_paths.another, null);

    // Caller-supplied keys must not clobber the built-in keys.
    const clobberStep = await writeCurrentStep({
      ...baseParams(artifactsDir),
      artifactPaths: {
        current_step: "/attacker/evil.json",
        current_prompt: "/attacker/evil.md",
      },
    });
    assert.ok(
      clobberStep.artifact_paths.current_step.endsWith("current-step.json"),
      "current_step must not be overwritten by caller-supplied key",
    );
    assert.ok(
      clobberStep.artifact_paths.current_prompt.endsWith("current-prompt.md"),
      "current_prompt must not be overwritten by caller-supplied key",
    );
  } finally {
    await cleanup();
  }
});
