import { test, expect, describe, it, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const { writeCurrentStep, STEP_CONTRACT_VERSION } = await import("../../src/audit/cli/steps.ts");
// The writer now normalizes host-facing paths to forward slashes (drift-plan
// R3); assert against the normalized form, not the raw input.
const { toPromptPathToken } = await import("audit-tools/shared");

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "src", "audit");

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

describe("writeCurrentStep writes prompt to current-prompt.md and returns correct StepArtifact", () => {
  let cleanup;
  let params;
  let step;

  beforeAll(async () => {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    const artifactsDir = join(tmp.dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    params = {
      ...baseParams(artifactsDir),
      allowedCommands: ["audit-code next-step", "cat some-file"],
    };
    step = await writeCurrentStep(params);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("contract_version matches STEP_CONTRACT_VERSION", () => {
    expect(step.contract_version).toBe(STEP_CONTRACT_VERSION);
  });

  it("step_kind matches input", () => {
    expect(step.step_kind).toBe(params.stepKind);
  });

  it("status matches input", () => {
    expect(step.status).toBe(params.status);
  });

  it("run_id matches input", () => {
    expect(step.run_id).toBe(params.runId);
  });

  it("allowed_commands deep-equals input", () => {
    expect(step.allowed_commands).toEqual(params.allowedCommands);
  });

  it("stop_condition matches input", () => {
    expect(step.stop_condition).toBe(params.stopCondition);
  });

  it("repo_root matches normalized input (R3)", () => {
    expect(step.repo_root).toBe(toPromptPathToken(params.repoRoot));
  });

  it("artifacts_dir matches normalized input (R3)", () => {
    expect(step.artifacts_dir).toBe(toPromptPathToken(params.artifactsDir));
  });

  it("prompt_path file contains exact prompt string", async () => {
    const written = await readFile(step.prompt_path, "utf8");
    expect(written).toBe(params.prompt);
  });

  it("current-step.json round-trips to the returned StepArtifact", async () => {
    const raw = await readFile(step.artifact_paths.current_step, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(step);
  });
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
    expect(!("progress" in step), "'progress' must not be present when not supplied").toBeTruthy();
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
    expect(step.progress).toEqual(progress);
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
    expect(!("allowed_mcp_tools" in step), "'allowed_mcp_tools' must not be present when not supplied").toBeTruthy();
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
    expect(!("allowed_mcp_tools" in step), "'allowed_mcp_tools' must not be present for empty array").toBeTruthy();
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
    expect(step.allowed_mcp_tools).toEqual(tools);
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
    expect(!("access" in step), "'access' must not be present when not supplied").toBeTruthy();
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
    expect(step.access).toEqual(access);
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

    expect(step.artifact_paths.current_step.endsWith("current-step.json"), "current_step must end with current-step.json").toBeTruthy();
    expect(step.artifact_paths.current_prompt.endsWith("current-prompt.md"), "current_prompt must end with current-prompt.md").toBeTruthy();
    expect(step.artifact_paths.my_artifact).toBe("/tmp/foo.json");
    expect(step.artifact_paths.another).toBe(null);

    // Caller-supplied keys must not clobber the built-in keys.
    const clobberStep = await writeCurrentStep({
      ...baseParams(artifactsDir),
      artifactPaths: {
        current_step: "/attacker/evil.json",
        current_prompt: "/attacker/evil.md",
      },
    });
    expect(clobberStep.artifact_paths.current_step.endsWith("current-step.json"), "current_step must not be overwritten by caller-supplied key").toBeTruthy();
    expect(clobberStep.artifact_paths.current_prompt.endsWith("current-prompt.md"), "current_prompt must not be overwritten by caller-supplied key").toBeTruthy();
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Windows path-separator normalization (drift-plan R3)
//
// The audit step writer previously emitted RAW Windows paths (backslashes),
// while remediate-code normalized them. After promoting the writer to shared,
// audit's step JSON must carry NO backslash separators in any host-facing path
// field — backslashes break the bash-like shells a host may use to run the
// step's commands. This test simulates Windows-style absolute paths regardless
// of the host OS so it fails if the normalization regresses on any platform.
// ---------------------------------------------------------------------------

test("writeCurrentStep emits no backslash separators in any path field (R3 fix)", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep({
      ...baseParams(artifactsDir),
      // Windows-style inputs, exercised on every platform.
      repoRoot: "C:\\Code\\my-repo",
      artifactPaths: {
        unit_manifest: "C:\\Code\\my-repo\\.audit-tools\\audit\\unit_manifest.json",
        not_yet: null,
      },
    });

    expect(!step.prompt_path.includes("\\"), "prompt_path must have no backslash").toBeTruthy();
    expect(!step.repo_root.includes("\\"), "repo_root must have no backslash").toBeTruthy();
    expect(!step.artifacts_dir.includes("\\"), "artifacts_dir must have no backslash").toBeTruthy();
    expect(step.repo_root).toBe("C:/Code/my-repo");
    expect(step.artifact_paths.unit_manifest).toBe("C:/Code/my-repo/.audit-tools/audit/unit_manifest.json");
    // null artifact entries (not-yet-materialized) survive normalization.
    expect(step.artifact_paths.not_yet).toBe(null);
    for (const value of Object.values(step.artifact_paths)) {
      if (value !== null) {
        expect(!value.includes("\\"), `artifact_paths value must have no backslash: ${value}`).toBeTruthy();
      }
    }

    // The persisted JSON file likewise carries no backslash separators.
    const raw = await readFile(step.artifact_paths.current_step, "utf8");
    const parsed = JSON.parse(raw);
    for (const field of ["prompt_path", "repo_root", "artifacts_dir"]) {
      expect(!parsed[field].includes("\\"), `persisted ${field} must have no backslash`).toBeTruthy();
    }
  } finally {
    await cleanup();
  }
});

test("writeCurrentStep canonical paths win even with Windows-style attacker overrides (R3)", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep({
      ...baseParams(artifactsDir),
      artifactPaths: {
        current_step: "C:\\attacker\\evil.json",
        current_prompt: "C:\\attacker\\evil.md",
      },
    });
    expect(step.artifact_paths.current_step.endsWith("current-step.json")).toBeTruthy();
    expect(step.artifact_paths.current_prompt.endsWith("current-prompt.md")).toBeTruthy();
    expect(!step.artifact_paths.current_step.includes("attacker")).toBeTruthy();
    expect(!step.artifact_paths.current_prompt.includes("attacker")).toBeTruthy();
    expect(!step.artifact_paths.current_step.includes("\\")).toBeTruthy();
    expect(!step.artifact_paths.current_prompt.includes("\\")).toBeTruthy();
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Single-sourced writer guard (drift-plan R3)
//
// There must be exactly ONE step-contract writer body. After consolidation the
// audit `writeCurrentStep` is a thin wrapper that DELEGATES to the shared
// `writeStepContract`; no source file under audit-code/src may define its own
// `writeCurrentStep` body that re-spells the steps/ filenames + raw-path writes.
// We assert: (a) the audit writer imports `writeStepContract` from shared, and
// (b) no audit source file constructs the steps dir / current-step.json by hand
// outside steps.ts.
// ---------------------------------------------------------------------------

async function collectTsFiles(rootDir) {
  const out = [];
  async function walk(d) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && full.endsWith(".ts")) out.push(full);
    }
  }
  await walk(rootDir);
  return out;
}

test("R3: audit writeCurrentStep delegates to the shared single-sourced writer", async () => {
  const stepsSrc = await readFile(join(srcDir, "cli", "steps.ts"), "utf8");
  expect(stepsSrc, "audit steps.ts must delegate to the shared writeStepContract").toMatch(/writeStepContract/);
  expect(stepsSrc, "audit steps.ts must import the writer from audit-tools/shared").toMatch(/from "audit-tools\/shared"/);
  // The raw-path writer body is gone: steps.ts must no longer write the prompt
  // or the step JSON itself (those moved into shared).
  expect(stepsSrc, "audit steps.ts must not write current-prompt.md itself (moved to shared)").not.toMatch(/writeFile\s*\(/);
  expect(stepsSrc, "audit steps.ts must not write current-step.json itself (moved to shared)").not.toMatch(/writeJsonFile\s*\(/);
});

test("R3: no audit source file outside steps.ts hand-builds the steps/current-step.json writer", async () => {
  const files = await collectTsFiles(srcDir);
  const offenders = [];
  for (const file of files) {
    if (file.endsWith(join("cli", "steps.ts"))) continue;
    const text = await readFile(file, "utf8");
    // A second writer would join the steps dir to current-step.json by hand.
    if (/["']steps["']\s*\)/.test(text) && /current-step\.json/.test(text)) {
      offenders.push(file);
    }
  }
  expect(offenders, `only steps.ts (delegating to shared) may own the step-writer path joins; offenders: ${offenders.join(", ")}`).toEqual([]);
});
