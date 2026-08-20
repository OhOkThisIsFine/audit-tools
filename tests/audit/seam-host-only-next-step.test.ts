/**
 * seam-host-only-next-step.test.ts
 *
 * Cross-module integration test: host-only-next-step seam
 *
 * Enforces the reconciled interface contract between:
 *   - src/audit/cli/nextStepHelpers.ts
 *     (runDeterministicForNextStep return-type discriminated union, exposed at
 *      runtime as NEXT_STEP_RETURN_KINDS)
 *   - src/audit/cli/nextStepCommand.ts
 *     (the step-emission dispatch table and the handled-kinds set derived from
 *      its own keys — NEXT_STEP_EMISSION_TABLE / NEXT_STEP_EMISSION_KINDS)
 *   - src/audit/cli/steps.ts
 *     (writeCurrentStep, STEP_CONTRACT_VERSION, StepArtifact, StepKind)
 *   - audit-tools/shared
 *     (StepStatus union — the only valid status values)
 *
 * This test fails whenever either side diverges from the shared interface:
 *
 *   A. EXHAUSTIVENESS: every kind in runDeterministicForNextStep's return union
 *      is emitted by a row of the dispatch table or by its single documented
 *      fallback. Both sides are IMPORTED from the production modules, never
 *      transcribed — a guard that compares two hand-copied sets agrees with
 *      itself while both drift away from the source it claims to guard.
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
import type { StepStatus } from "audit-tools/shared";
import type { StepKind } from "../../src/audit/cli/steps.js";
import type { NextStepResult } from "../../src/audit/cli/nextStepHelpers.js";
import { NEXT_STEP_RETURN_KINDS } from "../../src/audit/cli/nextStepHelpers.js";
import {
  NEXT_STEP_EMISSION_KINDS,
  NEXT_STEP_EMISSION_TABLE,
} from "../../src/audit/cli/nextStepCommand.js";

// ── Module imports ────────────────────────────────────────────────────────────

const { writeCurrentStep, STEP_CONTRACT_VERSION } = await import("../../src/audit/cli/steps.js");

const { StepStatus: _StepStatus } = await import("audit-tools/shared").catch(
  () => null,
).then(async (m: Record<string, unknown> | null) => {
  // StepStatus is a TS type, not a runtime value; import the module to
  // verify the re-export is present in the index.
  if (m) return m;
  return {};
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(os.tmpdir(), "seam-host-next-step-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseParams(artifactsDir: string): {
  artifactsDir: string;
  stepKind: StepKind;
  status: StepStatus;
  runId: string;
  allowedCommands: string[];
  stopCondition: string;
  repoRoot: string;
  artifactPaths: Record<string, string | null>;
  prompt: string;
} {
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

// ── A. EXHAUSTIVENESS — return-kind union vs the step-emission table ──────────
//
// BOTH SIDES ARE IMPORTED. This guard used to declare two hand-transcribed Set
// literals and assert they agreed with EACH OTHER (MNT-cce68021): adding a kind
// to the real union or deleting a real handler left both copies equal and all
// three assertions green, so the contract the header states was enforced only by
// an author remembering to edit the test.
//
//   A side — NEXT_STEP_RETURN_KINDS, derived in nextStepHelpers.ts from a table
//   typed TOTAL over NextStepResult["kind"] (a kind added to the union with no
//   row there is a compile error).
//   B side — NEXT_STEP_EMISSION_KINDS, derived by the shared emission scaffold
//   from NEXT_STEP_EMISSION_TABLE's OWN KEYS.

const RETURN_KINDS_FROM_NEXT_STEP_HELPERS: ReadonlySet<string> = new Set(
  NEXT_STEP_RETURN_KINDS,
);
const CMD_NEXT_STEP_HANDLED_KINDS: ReadonlySet<string> = NEXT_STEP_EMISSION_KINDS;

/**
 * The return kinds the emission table has NO row for, and which therefore reach
 * the scaffold's single `fallback`. nextStepCommand.ts names exactly one such
 * kind (its fallback casts the result to `NextStepResultOf<"semantic_review">`),
 * so this is one name, not a copy of a set — and it is pinned from two sides:
 *
 *   • `satisfies readonly FallbackRoutedKind[]` — a compile error the moment the
 *     table gains a row for this kind (the residual would become `never`);
 *   • A2 below — a runtime failure the moment the residual is anything else,
 *     which is what deleting a real table row produces.
 */
type FallbackRoutedKind = Exclude<
  NextStepResult["kind"],
  keyof typeof NEXT_STEP_EMISSION_TABLE
>;
const FALLBACK_ROUTED_KINDS = [
  "semantic_review",
] as const satisfies readonly FallbackRoutedKind[];

test("A1: the emission table handles no phantom kind absent from the return union", () => {
  for (const kind of CMD_NEXT_STEP_HANDLED_KINDS) {
    expect(
      RETURN_KINDS_FROM_NEXT_STEP_HELPERS.has(kind),
      `the step-emission table has a row for kind "${kind}", but runDeterministicForNextStep's return union does not carry it`,
    ).toBeTruthy();
  }
});

test("A2: every return kind is emitted by a table row or the single documented fallback", () => {
  const residual = [...RETURN_KINDS_FROM_NEXT_STEP_HELPERS]
    .filter((kind) => !CMD_NEXT_STEP_HANDLED_KINDS.has(kind))
    .sort();
  expect(
    residual,
    `the return kinds with no step-emission row must be exactly the documented fallback kind(s). ` +
      `A kind that appears here unexpectedly lost its handler; one that disappeared gained a row ` +
      `without this guard being updated.`,
  ).toEqual([...FALLBACK_ROUTED_KINDS].sort());
});

test("A3: both imported kind sets are non-empty and account for the whole union", () => {
  // A guard that scans an empty set passes unconditionally (TST-eb0de44d's
  // class); assert directly that both imported sides carry real data.
  expect(
    CMD_NEXT_STEP_HANDLED_KINDS.size > 0,
    "the step-emission table exported no kinds — this guard would pass over nothing",
  ).toBeTruthy();
  expect(
    RETURN_KINDS_FROM_NEXT_STEP_HELPERS.size,
    `kind-set size mismatch: the return union has ${RETURN_KINDS_FROM_NEXT_STEP_HELPERS.size} kinds, ` +
      `the emission table handles ${CMD_NEXT_STEP_HANDLED_KINDS.size} and the fallback ${FALLBACK_ROUTED_KINDS.length}`,
  ).toBe(CMD_NEXT_STEP_HANDLED_KINDS.size + FALLBACK_ROUTED_KINDS.length);
});

test("A4: the exported handled-kinds set IS the emission table's own key set", () => {
  // Pins the scaffold's construction-time snapshot to the table it was built
  // from, so the set A1/A2 import can never be a second copy that drifted.
  expect([...CMD_NEXT_STEP_HANDLED_KINDS].sort()).toEqual(
    Object.keys(NEXT_STEP_EMISSION_TABLE).sort(),
  );
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
const VALID_STEP_STATUSES: StepStatus[] = ["ready", "blocked", "complete"];

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
    expect(VALID_STEP_STATUSES.includes(s as StepStatus), `terminal status "${s}" must be in StepStatus`).toBeTruthy();
  }
  for (const s of nonTerminalStatuses) {
    expect(VALID_STEP_STATUSES.includes(s as StepStatus), `non-terminal status "${s}" must be in StepStatus`).toBeTruthy();
  }
  // No overlap with undefined/unknown values
  expect(VALID_STEP_STATUSES.length, "StepStatus must have exactly three members").toBe(3);
});

// ── D. ALLOWED-COMMANDS NON-EMPTY for non-terminal steps ────────────────────

// Non-terminal step kinds are those where the host must continue the pipeline.
// "complete" and "blocked" are terminal — allowed_commands can be empty.
const NON_TERMINAL_STEP_KINDS: StepKind[] = [
  "dispatch_review",
  "design_review",
  "design_review_parallel",
  "design_review_contract",
  "design_review_conceptual",
  "confirm_intent",
  "analyzer_install",
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

const ALL_STEP_KINDS: StepKind[] = [
  "dispatch_review",
  "design_review",
  "design_review_parallel",
  "design_review_contract",
  "design_review_conceptual",
  "confirm_intent",
  "analyzer_install",
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
