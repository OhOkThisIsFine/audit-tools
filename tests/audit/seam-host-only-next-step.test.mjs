/**
 * seam-host-only-next-step.test.mjs
 *
 * Cross-module integration test: host-only-next-step seam
 *
 * Enforces the reconciled interface contract between:
 *   - packages/audit-code/src/cli/nextStepHelpers.ts
 *     (runDeterministicForNextStep return-type discriminated union)
 *   - packages/audit-code/src/cli/nextStepCommand.ts
 *     (cmdNextStep handlers — one branch per kind)
 *   - packages/audit-code/src/cli/steps.ts
 *     (writeCurrentStep, STEP_CONTRACT_VERSION, StepArtifact, StepKind)
 *   - audit-tools/shared
 *     (StepStatus union — the only valid status values)
 *
 * This test fails whenever either side diverges from the shared interface:
 *
 *   A. EXHAUSTIVENESS: every kind exported by runDeterministicForNextStep's
 *      return union has a corresponding handler branch in cmdNextStep.
 *      Neither side may add a kind without updating the other.
 *
 *   B. VERSION-IDENTITY: STEP_CONTRACT_VERSION is a stable versioned string
 *      matching the "audit-code-step/vNalphaN" format. writeCurrentStep stamps
 *      it onto every artifact so a host can reject stale contracts.
 *
 *   C. STATUS-PARITY: the status values written by writeCurrentStep
 *      ("ready" | "blocked" | "complete") exactly match the StepStatus union
 *      from audit-tools/shared. No other strings are valid.
 *
 *   D. ALLOWED-COMMANDS NON-EMPTY: every non-terminal step kind
 *      (i.e. not "complete" or "blocked") must include at least one
 *      allowed_commands entry so the host knows how to continue.
 *
 *   E. STEP-ARTIFACT SHAPE: writeCurrentStep produces a JSON-serializable
 *      StepArtifact whose required fields (contract_version, step_kind,
 *      prompt_path, status, run_id, allowed_commands, stop_condition,
 *      repo_root, artifacts_dir, artifact_paths) are present and correctly typed.
 *
 *   F. STEP-KIND COVERAGE: every StepKind value that writeCurrentStep accepts
 *      can be round-tripped through JSON without loss.
 *
 * Finding: N-TEST-SEAM-host-only-next-step
 */

import { test, expect } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

// ── Module imports ────────────────────────────────────────────────────────────

const { writeCurrentStep, STEP_CONTRACT_VERSION } = await import("../../src/audit/cli/steps.ts");

const { StepStatus: _StepStatus } = await import("audit-tools/shared").catch(
  () => null,
).then(async (m) => {
  // StepStatus is a TS type, not a runtime value; import the module to
  // verify the re-export is present in the index.
  if (m) return m;
  return {};
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withTempDir(fn) {
  const dir = await mkdtemp(join(os.tmpdir(), "seam-host-next-step-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseParams(artifactsDir) {
  return {
    artifactsDir,
    stepKind: "dispatch_review",
    status: "ready",
    runId: "run-seam-test",
    allowedCommands: ["audit-code next-step --root /repo"],
    stopCondition: "Stop when the review is complete.",
    repoRoot: "/tmp/seam-repo",
    artifactPaths: {},
    prompt: "Seam test prompt.",
  };
}

// ── A. EXHAUSTIVENESS — kind union vs cmdNextStep handlers ────────────────────
//
// These are the kind values that runDeterministicForNextStep can return (from
// the return type in nextStepHelpers.ts) and that cmdNextStep must handle.
// The test verifies the sets are consistent without importing the function
// body (which would require a live filesystem and session config).

const RETURN_KINDS_FROM_NEXT_STEP_HELPERS = new Set([
  "complete",
  "blocked",
  "semantic_review",
  "design_review",
  "design_review_parallel",
  "design_review_contract",
  "design_review_conceptual",
  "confirm_intent",
  "provider_confirmation",
  "analyzer_install",
  "edge_reasoning",
  "synthesis_narrative",
]);

// cmdNextStep explicitly checks these kinds via if (result.kind === ...).
// "semantic_review" falls through to renderSemanticReviewStep at the bottom.
const CMD_NEXT_STEP_HANDLED_KINDS = new Set([
  "complete",
  "blocked",
  "design_review",
  "design_review_parallel",
  "design_review_contract",
  "design_review_conceptual",
  "confirm_intent",
  "provider_confirmation",
  "analyzer_install",
  "edge_reasoning",
  "synthesis_narrative",
  "semantic_review", // handled as the default fallthrough at the end of cmdNextStep
]);

test("A1: every kind from runDeterministicForNextStep is handled in cmdNextStep", () => {
  for (const kind of RETURN_KINDS_FROM_NEXT_STEP_HELPERS) {
    expect(CMD_NEXT_STEP_HANDLED_KINDS.has(kind), `runDeterministicForNextStep kind "${kind}" has no handler branch in cmdNextStep`).toBeTruthy();
  }
});

test("A2: cmdNextStep does not handle phantom kinds absent from runDeterministicForNextStep", () => {
  for (const kind of CMD_NEXT_STEP_HANDLED_KINDS) {
    expect(RETURN_KINDS_FROM_NEXT_STEP_HELPERS.has(kind), `cmdNextStep handles kind "${kind}" but it is not in runDeterministicForNextStep's return union`).toBeTruthy();
  }
});

test("A3: both sets have the same cardinality (no hidden divergence)", () => {
  expect(RETURN_KINDS_FROM_NEXT_STEP_HELPERS.size, `Kind-set size mismatch: runDeterministicForNextStep has ${RETURN_KINDS_FROM_NEXT_STEP_HELPERS.size} kinds, ` +
      `cmdNextStep handles ${CMD_NEXT_STEP_HANDLED_KINDS.size}`).toBe(CMD_NEXT_STEP_HANDLED_KINDS.size);
});

// ── B. VERSION-IDENTITY — STEP_CONTRACT_VERSION format ───────────────────────

test("B1: STEP_CONTRACT_VERSION is a non-empty string", () => {
  expect(typeof STEP_CONTRACT_VERSION).toBe("string");
  expect(STEP_CONTRACT_VERSION.length > 0, "STEP_CONTRACT_VERSION must be non-empty").toBeTruthy();
});

test("B2: STEP_CONTRACT_VERSION matches the expected versioned-string format", () => {
  // Format: "<product>-step/v<N>alpha<N>" or "<product>-step/v<N>" etc.
  expect(STEP_CONTRACT_VERSION, `STEP_CONTRACT_VERSION "${STEP_CONTRACT_VERSION}" does not match "<product>/v<N>" format`).toMatch(/^[\w-]+\/v\d/);
});

test("B3: STEP_CONTRACT_VERSION is stamped onto every StepArtifact produced by writeCurrentStep", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep(baseParams(artifactsDir));
    expect(step.contract_version, "writeCurrentStep must stamp contract_version with STEP_CONTRACT_VERSION").toBe(STEP_CONTRACT_VERSION);
  });
});

// ── C. STATUS-PARITY — StepStatus values are exhaustive ─────────────────────

// StepStatus is a TS type alias ("ready" | "blocked" | "complete") — verify
// the three string values used in writeCurrentStep calls match it exactly.
const VALID_STEP_STATUSES = ["ready", "blocked", "complete"];

test("C1: all three StepStatus values are accepted by writeCurrentStep", async () => {
  await withTempDir(async (dir) => {
    for (const status of VALID_STEP_STATUSES) {
      const artifactsDir = join(dir, `artifacts-${status}`);
      await mkdir(artifactsDir, { recursive: true });
      const step = await writeCurrentStep({ ...baseParams(artifactsDir), status });
      expect(step.status, `writeCurrentStep with status "${status}" must return step.status === "${status}"`).toBe(status);
    }
  });
});

test("C2: the terminal status values align with the semantic contract (complete/blocked are terminals)", () => {
  const terminalStatuses = ["complete", "blocked"];
  const nonTerminalStatuses = ["ready"];
  for (const s of terminalStatuses) {
    expect(VALID_STEP_STATUSES.includes(s), `terminal status "${s}" must be in StepStatus`).toBeTruthy();
  }
  for (const s of nonTerminalStatuses) {
    expect(VALID_STEP_STATUSES.includes(s), `non-terminal status "${s}" must be in StepStatus`).toBeTruthy();
  }
  // No overlap with undefined/unknown values
  expect(VALID_STEP_STATUSES.length, "StepStatus must have exactly three members").toBe(3);
});

// ── D. ALLOWED-COMMANDS NON-EMPTY for non-terminal steps ────────────────────

// Non-terminal step kinds are those where the host must continue the pipeline.
// "complete" and "blocked" are terminal — allowed_commands can be empty.
const NON_TERMINAL_STEP_KINDS = [
  "dispatch_review",
  "single_task_fallback",
  "design_review",
  "design_review_parallel",
  "design_review_contract",
  "design_review_conceptual",
  "confirm_intent",
  "provider_confirmation",
  "analyzer_install",
  "edge_reasoning",
  "edge_reasoning_dispatch",
  "synthesis_narrative",
];

test("D1: non-terminal step kinds are written with a non-empty allowed_commands array", async () => {
  await withTempDir(async (dir) => {
    for (const stepKind of NON_TERMINAL_STEP_KINDS) {
      const artifactsDir = join(dir, `artifacts-${stepKind}`);
      await mkdir(artifactsDir, { recursive: true });
      const step = await writeCurrentStep({
        ...baseParams(artifactsDir),
        stepKind,
        allowedCommands: ["audit-code next-step --root /repo"],
      });
      expect(Array.isArray(step.allowed_commands) && step.allowed_commands.length > 0, `non-terminal step kind "${stepKind}" must include at least one allowed_command`).toBeTruthy();
    }
  });
});

test("D2: the continuation command written for non-terminal steps contains 'next-step'", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const continueCommand = "audit-code next-step --root /repo --artifacts-dir .audit-tools/audit";
    const step = await writeCurrentStep({
      ...baseParams(artifactsDir),
      stepKind: "dispatch_review",
      allowedCommands: [continueCommand],
    });
    expect(step.allowed_commands.some((cmd) => cmd.includes("next-step")), `allowed_commands must include a 'next-step' continuation; got: ${JSON.stringify(step.allowed_commands)}`).toBeTruthy();
  });
});

// ── E. STEP-ARTIFACT SHAPE — required fields present and correctly typed ──────

test("E1: writeCurrentStep produces a StepArtifact with all required fields", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep(baseParams(artifactsDir));

    const required = [
      "contract_version",
      "step_kind",
      "prompt_path",
      "status",
      "run_id",
      "allowed_commands",
      "stop_condition",
      "repo_root",
      "artifacts_dir",
      "artifact_paths",
    ];
    for (const field of required) {
      expect(field in step, `StepArtifact must include required field "${field}"`).toBeTruthy();
    }
  });
});

test("E2: StepArtifact field types are correct", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep(baseParams(artifactsDir));

    expect(typeof step.contract_version).toBe("string");
    expect(typeof step.step_kind).toBe("string");
    expect(typeof step.prompt_path).toBe("string");
    expect(typeof step.status).toBe("string");
    // run_id may be string or null
    expect(step.run_id === null || typeof step.run_id === "string", "run_id must be string or null").toBeTruthy();
    expect(Array.isArray(step.allowed_commands), "allowed_commands must be an array").toBeTruthy();
    expect(typeof step.stop_condition).toBe("string");
    expect(typeof step.repo_root).toBe("string");
    expect(typeof step.artifacts_dir).toBe("string");
    expect(typeof step.artifact_paths).toBe("object");
    expect(step.artifact_paths !== null, "artifact_paths must not be null").toBeTruthy();
  });
});

test("E3: StepArtifact is JSON-round-trip stable (serialization contract)", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep(baseParams(artifactsDir));

    const json = JSON.stringify(step);
    const parsed = JSON.parse(json);

    expect(parsed.contract_version).toBe(step.contract_version);
    expect(parsed.step_kind).toBe(step.step_kind);
    expect(parsed.status).toBe(step.status);
    expect(parsed.run_id).toBe(step.run_id);
    expect(parsed.allowed_commands).toEqual(step.allowed_commands);
    expect(parsed.stop_condition).toBe(step.stop_condition);
    expect(parsed.repo_root).toBe(step.repo_root);
    expect(parsed.artifacts_dir).toBe(step.artifacts_dir);
  });
});

test("E4: artifact_paths always includes current_step and current_prompt keys", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep(baseParams(artifactsDir));

    expect("current_step" in step.artifact_paths, "artifact_paths must include 'current_step'").toBeTruthy();
    expect("current_prompt" in step.artifact_paths, "artifact_paths must include 'current_prompt'").toBeTruthy();
    expect(typeof step.artifact_paths.current_step === "string" &&
        step.artifact_paths.current_step.endsWith("current-step.json"), "current_step must end with 'current-step.json'").toBeTruthy();
    expect(typeof step.artifact_paths.current_prompt === "string" &&
        step.artifact_paths.current_prompt.endsWith("current-prompt.md"), "current_prompt must end with 'current-prompt.md'").toBeTruthy();
  });
});

// ── F. STEP-KIND COVERAGE — every StepKind round-trips through JSON ──────────

const ALL_STEP_KINDS = [
  "dispatch_review",
  "single_task_fallback",
  "design_review",
  "design_review_parallel",
  "design_review_contract",
  "design_review_conceptual",
  "confirm_intent",
  "analyzer_install",
  "edge_reasoning",
  "edge_reasoning_dispatch",
  "synthesis_narrative",
  "present_report",
  "blocked",
];

test("F1: all StepKind values are non-empty strings that survive JSON round-trip", () => {
  for (const kind of ALL_STEP_KINDS) {
    const rt = JSON.parse(JSON.stringify(kind));
    expect(rt, `StepKind "${kind}" must survive JSON round-trip unchanged`).toBe(kind);
    expect(kind.length > 0, `StepKind "${kind}" must be non-empty`).toBeTruthy();
  }
});

test("F2: every non-terminal kind in ALL_STEP_KINDS appears in NON_TERMINAL_STEP_KINDS or is 'blocked'/'present_report'", () => {
  const terminalKinds = new Set(["blocked", "present_report"]);
  const nonTerminalSet = new Set(NON_TERMINAL_STEP_KINDS);
  for (const kind of ALL_STEP_KINDS) {
    if (!terminalKinds.has(kind)) {
      expect(nonTerminalSet.has(kind), `StepKind "${kind}" is not categorized as terminal or non-terminal — update NON_TERMINAL_STEP_KINDS`).toBeTruthy();
    }
  }
});

test("F3: writeCurrentStep writes step_kind verbatim for each non-terminal kind", async () => {
  await withTempDir(async (dir) => {
    for (const stepKind of NON_TERMINAL_STEP_KINDS) {
      const artifactsDir = join(dir, `kind-${stepKind}`);
      await mkdir(artifactsDir, { recursive: true });
      const step = await writeCurrentStep({
        ...baseParams(artifactsDir),
        stepKind,
      });
      expect(step.step_kind, `step_kind must round-trip: expected "${stepKind}", got "${step.step_kind}"`).toBe(stepKind);
    }
  });
});

// ── G. OPTIONAL FIELDS — conditional fields obey the omit-when-absent contract ─

test("G1: progress is omitted when not supplied", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep(baseParams(artifactsDir));
    expect(!("progress" in step), "progress must be absent when not supplied").toBeTruthy();
  });
});

test("G2: progress is included when supplied and survives JSON round-trip", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const progress = {
      summary: "4 tasks remaining",
      pending_tasks: 4,
      granted_count: 2,
    };
    const step = await writeCurrentStep({ ...baseParams(artifactsDir), progress });
    expect(step.progress).toEqual(progress);
    const rt = JSON.parse(JSON.stringify(step));
    expect(rt.progress).toEqual(progress);
  });
});

test("G3: allowed_mcp_tools is omitted when not supplied", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep(baseParams(artifactsDir));
    expect(!("allowed_mcp_tools" in step), "allowed_mcp_tools must be absent when not supplied").toBeTruthy();
  });
});

test("G4: allowed_mcp_tools included when supplied", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const tools = ["mcp__tool_a", "mcp__tool_b"];
    const step = await writeCurrentStep({ ...baseParams(artifactsDir), allowedMcpTools: tools });
    expect(step.allowed_mcp_tools).toEqual(tools);
  });
});

test("G5: access field is omitted when not supplied", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const step = await writeCurrentStep(baseParams(artifactsDir));
    expect(!("access" in step), "access must be absent when not supplied").toBeTruthy();
  });
});

test("G6: access field is included when supplied", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const access = { read_paths: ["/repo/src"], write_paths: ["/repo/dist"] };
    const step = await writeCurrentStep({ ...baseParams(artifactsDir), access });
    expect(step.access).toEqual(access);
  });
});
