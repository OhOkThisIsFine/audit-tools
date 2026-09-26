// O01: the tool-owned gate runs in ARBITRARY repositories, not just audit-tools.
//
// The retired behavior derived a command list only for the audit-tools
// monorepo and reported `scoped_out` (non-blocking) everywhere else, so a run
// on any other repository finished with no build, typecheck or suite run at
// all. This suite pins the replacement, through real fixture remediations:
// derivation from the target's own declared commands (npm + the supported
// Go/Python fallbacks), the explicit-override composition, the blocking
// operator decision when nothing is derivable, re-resolution on changed
// declarations, and failure preserving work with the resumable red state.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import {
  gateBindingChanged,
  resolveGateBinding,
  runToolOwnedFinalGate,
  toolOwnedFinalGateCommands,
} from "../../src/remediate/steps/finalGate.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const TESTS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The audit-tools repo itself — the one tree the pinned profile applies to. */
const REPO_ROOT = dirname(TESTS_ROOT);

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-arbitrary-gate-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeManifest(dir: string, scripts: Record<string, string>): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts }), "utf8");
}

// ---------------------------------------------------------------------------
// Derivation: the gate reads the target's own declarations.
// ---------------------------------------------------------------------------

describe("O01 derivation: an npm target gets its own build/typecheck/lint/test floor", () => {
  it("derives all four roles in order and runs them through the injected runner", async () => {
    await withTempDir(async (dir) => {
      await writeManifest(dir, {
        build: "tsc",
        typecheck: "tsc --noEmit",
        lint: "eslint .",
        test: "vitest run",
      });
      const specs = toolOwnedFinalGateCommands(dir);
      expect(specs.map((spec) => spec.argv.join(" "))).toEqual([
        "npm run build",
        "npm run typecheck",
        "npm run lint",
        "npm test",
      ]);
      expect(specs.map((spec) => spec.layer)).toEqual(["build", "check", "check", "unit"]);

      const invoked: string[] = [];
      const gate = await runToolOwnedFinalGate(dir, {
        runner: (argv) => {
          invoked.push(argv.join(" "));
          return { status: 0 };
        },
      });
      expect(gate.outcome).toBe("executed");
      expect(gate.passed).toBe(true);
      expect(invoked).toEqual([
        "npm run build",
        "npm run typecheck",
        "npm run lint",
        "npm test",
      ]);
      expect(gate.binding.profile).toBe("discovered");
      expect(gate.binding.discovered).toMatchObject({
        build: "npm run build",
        typecheck: "npm run typecheck",
        lint: "npm run lint",
        test: "npm test",
      });
      expect(gate.binding.manifest_digest).toBeTruthy();
    });
  });

  it("recognizes check:types but never a bare check script as typechecking", async () => {
    await withTempDir(async (dir) => {
      await writeManifest(dir, { "check:types": "tsc --noEmit" });
      expect(toolOwnedFinalGateCommands(dir).map((s) => s.argv.join(" "))).toEqual([
        "npm run check:types",
      ]);
    });
    await withTempDir(async (dir) => {
      await writeManifest(dir, { check: "npm run lint", test: "jest" });
      // The bare `check` script contributes NO role: the floor is the test
      // role alone, not a mislabeled check layer.
      const specs = toolOwnedFinalGateCommands(dir);
      expect(specs.map((s) => s.argv.join(" "))).toEqual(["npm test"]);
      expect(specs.every((s) => s.layer !== "check")).toBe(true);
    });
  });

  it("an explicit test command takes the test role without dropping other roles", async () => {
    await withTempDir(async (dir) => {
      await writeManifest(dir, { build: "tsc", lint: "eslint .", test: "jest" });
      const specs = toolOwnedFinalGateCommands(dir, {
        explicitTestCommand: ["node", "scripts/verify.mjs"],
      });
      expect(specs.map((s) => s.argv.join(" "))).toEqual([
        "npm run build",
        "npm run lint",
        "node scripts/verify.mjs",
      ]);
      const { binding } = resolveGateBinding(dir, {
        explicitTestCommand: ["node", "scripts/verify.mjs"],
      });
      expect(binding.explicit_test_command).toEqual(["node", "scripts/verify.mjs"]);
    });
  });

  it("the audit-tools profile is preserved and ignores the explicit override", async () => {
    expect(toolOwnedFinalGateCommands(REPO_ROOT).map((s) => s.argv.join(" "))).toEqual([
      "npm run build",
      "npm run check",
      "npm run check:tests",
      "node scripts/shared/run-vitest-gate.mjs --retry=2",
    ]);
    // INV-RS-10 independence: the pinned suite IS the gate on this tree, so an
    // explicit plan command cannot rewrite it here.
    expect(
      toolOwnedFinalGateCommands(REPO_ROOT, {
        explicitTestCommand: ["node", "scripts/verify.mjs"],
      }).map((s) => s.argv.join(" ")),
    ).toEqual(toolOwnedFinalGateCommands(REPO_ROOT).map((s) => s.argv.join(" ")));
    const { binding } = resolveGateBinding(REPO_ROOT);
    expect(binding.profile).toBe("audit-tools");
    expect(binding.explicit_test_command).toBeUndefined();
  });

  it("supported fallback ecosystems derive their own commands and no typecheck", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "go.mod"), "module example.com/x\n", "utf8");
      expect(toolOwnedFinalGateCommands(dir).map((s) => s.argv.join(" "))).toEqual([
        "go build ./...",
        "go test ./...",
      ]);
    });
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "pyproject.toml"), "[project]\nname='x'\n", "utf8");
      const specs = toolOwnedFinalGateCommands(dir);
      // Python contributes the pytest test role (when the interpreter resolves)
      // and invents no typecheck role for a toolchain the manifest never declared.
      expect(specs.some((s) => s.layer === "check")).toBe(false);
      expect(specs.map((s) => s.argv.join(" "))).toEqual(["python -m pytest"]);
    });
  });

  it("no derivable command blocks with needs_command and never consults a runner", async () => {
    await withTempDir(async (dir) => {
      expect(toolOwnedFinalGateCommands(dir)).toEqual([]);
      let consulted = false;
      const gate = await runToolOwnedFinalGate(dir, {
        runner: () => {
          consulted = true;
          return { status: 0 };
        },
      });
      expect(consulted, "nothing derivable means nothing may run").toBe(false);
      expect(gate.passed).toBe(false);
      expect(gate.outcome).toBe("needs_command");
      expect(gate.results).toEqual([]);
      expect(gate.binding.profile).toBe("discovered");
      expect(gate.binding.manifest_digest).toBeNull();
    });
  });
});

describe("O01 binding: the gate names what it resolved and detects changed declarations", () => {
  it("a script-body rewrite moves the digest and counts as changed", async () => {
    await withTempDir(async (dir) => {
      await writeManifest(dir, { test: "jest-a" });
      const first = resolveGateBinding(dir);
      // Same declarations, re-resolved: no move.
      expect(gateBindingChanged(first.binding, resolveGateBinding(dir).binding)).toBe(false);
      // Rewrite the script BODY: the derived argv is still `npm test`, but the
      // declaration behind it moved, so the gate must re-resolve rather than
      // trust the draw.
      await writeManifest(dir, { test: "jest-b" });
      const second = resolveGateBinding(dir);
      expect(second.binding.manifest_digest).not.toBe(first.binding.manifest_digest);
      expect(gateBindingChanged(first.binding, second.binding)).toBe(true);
      expect(second.commands.map((s) => s.argv.join(" "))).toEqual(["npm test"]);
    });
  });

  it("adding a role and changing the explicit override both count as changed", async () => {
    await withTempDir(async (dir) => {
      await writeManifest(dir, { test: "jest" });
      const first = resolveGateBinding(dir);
      await writeManifest(dir, { test: "jest", build: "tsc" });
      const second = resolveGateBinding(dir);
      expect(gateBindingChanged(first.binding, second.binding)).toBe(true);
      expect(second.commands.map((s) => s.argv.join(" "))).toEqual([
        "npm run build",
        "npm test",
      ]);
      const third = resolveGateBinding(dir, {
        explicitTestCommand: ["node", "scripts/verify.mjs"],
      });
      expect(gateBindingChanged(second.binding, third.binding)).toBe(true);
    });
  });

  it("no previous binding is a first resolution, not a change", async () => {
    await withTempDir(async (dir) => {
      await writeManifest(dir, { test: "jest" });
      expect(
        gateBindingChanged(undefined, resolveGateBinding(dir).binding),
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// End to end: real fixture remediations through the boundary and final gates.
// ---------------------------------------------------------------------------

const harness = createNextStepHarness(".test-final-gate-arbitrary-repo");
const { REPO_DIR, ARTIFACTS_DIR, saveState, acknowledgeResume, writeIntentCheckpoint } =
  harness;

/** Phase 0 landed, phase 1 pristine — the shape the boundary gate fires on. */
function makeBoundaryState(planOverrides: Record<string, unknown> = {}): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-ARBITRARY-GATE",
      findings: [
        {
          id: "F-000",
          title: "Foundation",
          category: "correctness",
          severity: "high",
          confidence: "high",
          lens: "correctness",
          summary: "Land the foundation.",
          affected_files: [{ path: "src/a.ts" }],
          evidence: ["src/a.ts:1 evidence"],
        },
        {
          id: "F-001",
          title: "Consumer",
          category: "correctness",
          severity: "high",
          confidence: "high",
          lens: "correctness",
          summary: "Build on the foundation.",
          affected_files: [{ path: "src/b.ts" }],
          evidence: ["src/b.ts:1 evidence"],
        },
      ],
      blocks: [
        {
          block_id: "B-000",
          items: ["F-000"],
          parallel_safe: true,
          touched_files: ["src/a.ts"],
          dependencies: [],
          phase_ordinal: 0,
        },
        {
          block_id: "B-001",
          items: ["F-001"],
          parallel_safe: true,
          touched_files: ["src/b.ts"],
          dependencies: ["B-000"],
          phase_ordinal: 1,
        },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
      ...planOverrides,
    },
    items: {
      "F-000": { finding_id: "F-000", status: "resolved", block_id: "B-000" },
      "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
    },
    closing_plan: { action: "none" },
  };
}

/** Every item terminal — the shape that reaches the all-terminal funnel. */
function makeAllTerminalState(): RemediationState {
  const state = makeBoundaryState();
  state.plan!.plan_id = "PLAN-ARBITRARY-FUNNEL";
  state.items = {
    "F-000": { finding_id: "F-000", status: "resolved", block_id: "B-000" },
    "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
  };
  return state;
}

async function readOutcomeRecord(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(ARTIFACTS_DIR, "final-gate-outcome.json"), "utf8"),
  ) as Record<string, unknown>;
}

beforeEach(async () => {
  await harness.resetTestRepo();
});
afterEach(async () => {
  await harness.cleanupTestRepo();
});

describe("O01 boundary gate on an arbitrary npm repository", () => {
  it("runs the declared floor at the phase boundary and proceeds when green", async () => {
    await writeManifest(REPO_DIR, {
      build: "tsc",
      typecheck: "tsc --noEmit",
      lint: "eslint .",
      test: "vitest run",
    });
    await saveState(makeBoundaryState());
    await writeIntentCheckpoint();
    await acknowledgeResume();

    const invoked: string[] = [];
    const step = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: (argv) => {
        invoked.push(argv.join(" "));
        return { status: 0 };
      },
    });
    expect(invoked).toEqual([
      "npm run build",
      "npm run typecheck",
      "npm run lint",
      "npm test",
    ]);
    expect(step.step_kind).not.toBe("final_gate_red");
    expect(step.step_kind).not.toBe("final_gate_needs_command");
    const outcome = await readOutcomeRecord();
    expect(outcome.outcome).toBe("executed");
    expect(outcome.passed).toBe(true);
    expect(outcome.commands_run).toBe(4);
  });

  it("a failing declared command pauses red and preserves every item", async () => {
    await writeManifest(REPO_DIR, { build: "tsc", test: "vitest run" });
    await saveState(makeBoundaryState());
    await writeIntentCheckpoint();
    await acknowledgeResume();

    const invoked: string[] = [];
    const step = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: (argv) => {
        invoked.push(argv.join(" "));
        return argv.join(" ") === "npm run build"
          ? { status: 1, stdout: "tsc: 3 errors", stderr: "" }
          : { status: 0 };
      },
    });
    // Short-circuit: the broken build stops the floor before the suite spends.
    expect(invoked).toEqual(["npm run build"]);
    expect(step.step_kind).toBe("final_gate_red");
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("npm run build");

    // THE preservation property: the pause mutates nothing, so the run
    // resumes exactly where it stood.
    const persisted = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(persisted?.status).toBe("implementing");
    expect(persisted?.items?.["F-000"]?.status).toBe("resolved");
    expect(persisted?.items?.["F-001"]?.status).toBe("pending");
    const record = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(record.failing_command).toBe("npm run build");

    // Recovery: a green floor on the next call proceeds past the boundary.
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "b.ts"), "export const b = 1;\n", "utf8");
    const green = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => ({ status: 0 }),
    });
    expect(green.step_kind).not.toBe("final_gate_red");
  });

  it("an explicit plan test command takes the test role at the boundary", async () => {
    await writeManifest(REPO_DIR, { build: "tsc", test: "jest" });
    await saveState(
      makeBoundaryState({
        test_command: "node scripts/verify.mjs",
        test_command_source: "explicit",
      }),
    );
    await writeIntentCheckpoint();
    await acknowledgeResume();

    const invoked: string[] = [];
    await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: (argv) => {
        invoked.push(argv.join(" "));
        return { status: 0 };
      },
    });
    // The declared build still runs (nothing dropped); the test role is the
    // operator's explicit command, not the discovered `npm test`.
    expect(invoked).toEqual(["npm run build", "node scripts/verify.mjs"]);
  });

  it("reruns the boundary floor when only the explicit plan command changes", async () => {
    await writeManifest(REPO_DIR, { test: "jest" });
    await saveState(makeBoundaryState({
      test_command: "node scripts/first.mjs",
      test_command_source: "explicit",
    }));
    await writeIntentCheckpoint();
    await acknowledgeResume();

    const invoked: string[] = [];
    const runner = (argv: string[]): { status: number } => {
      invoked.push(argv.join(" "));
      return { status: 0 };
    };
    await decideNextStep({ root: REPO_DIR, finalGateRunner: runner });
    expect(invoked).toEqual(["node scripts/first.mjs"]);

    // The plan lives under .audit-tools and is excluded from the content-id
    // cache key. A changed operator command must invalidate the old verdict.
    await saveState(makeBoundaryState({
      test_command: "node scripts/second.mjs",
      test_command_source: "explicit",
    }));
    await decideNextStep({ root: REPO_DIR, finalGateRunner: runner });
    expect(invoked).toEqual(["node scripts/first.mjs", "node scripts/second.mjs"]);
  });

  it("a changed manifest is re-resolved: the new declarations run", async () => {
    await writeManifest(REPO_DIR, { test: "vitest run" });
    await saveState(makeBoundaryState());
    await writeIntentCheckpoint();
    await acknowledgeResume();

    const invoked: string[] = [];
    const runner = (argv: string[]): { status: number } => {
      invoked.push(argv.join(" "));
      return { status: 0 };
    };
    await decideNextStep({ root: REPO_DIR, finalGateRunner: runner });
    expect(invoked).toEqual(["npm test"]);

    // The operator declares a build mid-run: the next evaluation must run the
    // new draw (build first), not the stale one-command floor.
    await writeManifest(REPO_DIR, { build: "tsc", test: "vitest run" });
    await decideNextStep({ root: REPO_DIR, finalGateRunner: runner });
    expect(invoked).toEqual(["npm test", "npm run build", "npm test"]);

    const log = await readFile(join(ARTIFACTS_DIR, "run.log.jsonl"), "utf8");
    expect(log).toContain("gate_commands_reresolved");
  });
});

describe("O01 no derivable gate: the run pauses for an operator decision, never passes", () => {
  it("the boundary gate emits final_gate_needs_command and touches nothing", async () => {
    await saveState(makeBoundaryState());
    await writeIntentCheckpoint();
    await acknowledgeResume();

    let consulted = false;
    const step = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => {
        consulted = true;
        return { status: 0 };
      },
    });
    expect(consulted, "no derivable command means no spawn").toBe(false);
    expect(step.step_kind).toBe("final_gate_needs_command");
    expect(step.status).toBe("blocked");
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("no repository gate command");
    expect(prompt).toContain("This is not a pass");
    expect(step.artifact_paths.final_gate_outcome).toBeTruthy();

    const persisted = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(persisted?.status).toBe("implementing");
    expect(persisted?.items?.["F-000"]?.status).toBe("resolved");
    expect(persisted?.items?.["F-001"]?.status).toBe("pending");

    const outcome = await readOutcomeRecord();
    expect(outcome.outcome).toBe("needs_command");
    expect(outcome.passed, "a gate that ran nothing has no verdict").toBeNull();
    expect(outcome.commands_run).toBe(0);
    expect(outcome.reason).toBeTruthy();
  });

  it("declaring a command resumes the run: the next evaluation runs the new gate", async () => {
    await saveState(makeBoundaryState());
    await writeIntentCheckpoint();
    await acknowledgeResume();

    const first = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => ({ status: 0 }),
    });
    expect(first.step_kind).toBe("final_gate_needs_command");

    // The operator declares the suite: re-resolution picks it up with no other
    // action, and the run continues past the boundary.
    await writeManifest(REPO_DIR, { test: "vitest run" });
    const invoked: string[] = [];
    const second = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: (argv) => {
        invoked.push(argv.join(" "));
        return { status: 0 };
      },
    });
    expect(invoked).toEqual(["npm test"]);
    expect(second.step_kind).not.toBe("final_gate_needs_command");
    expect(second.step_kind).not.toBe("final_gate_red");
  });

  it("the all-terminal funnel also pauses instead of closing unvalidated", async () => {
    await saveState(makeAllTerminalState());
    await writeIntentCheckpoint();
    await acknowledgeResume();

    const step = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => ({ status: 0 }),
    });
    expect(step.step_kind).toBe("final_gate_needs_command");
    const outcome = await readOutcomeRecord();
    expect(outcome.outcome).toBe("needs_command");
    expect(outcome.scope).toBe("all-terminal final gate");
    // The run did NOT advance to closing on an unjudged tree.
    const persisted = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(persisted?.status).not.toBe("closing");
  });

  it("a Go fallback repository gates on go build + go test at the boundary", async () => {
    await writeFile(join(REPO_DIR, "go.mod"), "module example.com/x\n", "utf8");
    await saveState(makeBoundaryState());
    await writeIntentCheckpoint();
    await acknowledgeResume();

    const invoked: string[] = [];
    const step = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: (argv) => {
        invoked.push(argv.join(" "));
        return { status: 0 };
      },
    });
    expect(invoked).toEqual(["go build ./...", "go test ./..."]);
    expect(step.step_kind).not.toBe("final_gate_needs_command");
    expect(step.step_kind).not.toBe("final_gate_red");
  });
});
