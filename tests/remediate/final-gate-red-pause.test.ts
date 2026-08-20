// A RED tool-owned gate PAUSES the run — it never mutates it.
//
// The predecessor did the opposite: on an unattributable whole-repo red it
// re-opened every non-skip item to `pending` and, after a bounded number of
// tries, marked them all `abandoned`. On 2026-08-20 that fired against a suite
// reddened by a commit that landed alongside the run and erased 21 accepted
// resolutions from state.json in one pass.
//
// The property under test is the one the backlog entry asked for: an
// unattributable red records what failed and stops. No item status moves, no
// phase moves, nothing is written to state.json at all — so a repeat next-step
// re-runs the gate and continues the moment the suite is green.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import {
  isAuditToolsMonorepo,
  runToolOwnedFinalGate,
  toolOwnedFinalGateCommands,
} from "../../src/remediate/steps/finalGate.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-final-gate-red-pause");
const { REPO_DIR, ARTIFACTS_DIR, saveState, acknowledgeResume, writeIntentCheckpoint } =
  harness;

const FAILING_STDOUT = "Tests  1 failed | 400 passed (401)";
const FAILING_STDERR = "FAIL tests/shared/closeout-render.test.ts";

/** The five layout markers, without the gate script the unit leg spawns. */
async function writeLayoutMarkers(): Promise<void> {
  for (const dir of ["src/shared", "src/audit", "src/remediate"]) {
    await mkdir(join(REPO_DIR, dir), { recursive: true });
  }
  for (const file of ["audit-code.mjs", "remediate-code.mjs"]) {
    await writeFile(join(REPO_DIR, file), "// fixture\n", "utf8");
  }
}

/**
 * Make the scratch repo look like the audit-tools monorepo, INCLUDING the vitest
 * gate script the unit leg spawns.
 *
 * Without the layout the gate is `scoped_out` — its command list is audit-tools
 * specific — and a scoped-out gate PASSES, so the red path would never be
 * reached and the test would pass for the wrong reason. Without the SCRIPT the
 * tree is deliberately out of scope; see the negative pin below.
 */
async function makeRepoLookLikeAuditTools(): Promise<void> {
  await writeLayoutMarkers();
  await mkdir(join(REPO_DIR, "scripts", "shared"), { recursive: true });
  await writeFile(
    join(REPO_DIR, "scripts", "shared", "run-vitest-gate.mjs"),
    "// fixture gate script\n",
    "utf8",
  );
}

/**
 * An implementing run standing exactly at a phase boundary: phase 0 landed
 * (`resolved`), phase 1 pristine (`pending`) and dependency-ready. That is the
 * shape `phaseBoundaryToGate` gates on, so the next `decideNextStep` runs the
 * whole-repo suite before opening phase 1.
 */
function makeBoundaryState(): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-GATE",
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
    },
    items: {
      "F-000": { finding_id: "F-000", status: "resolved", block_id: "B-000" },
      "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
    },
    closing_plan: { action: "none" },
  };
}

async function establishBoundaryRun(): Promise<void> {
  await makeRepoLookLikeAuditTools();
  await saveState(makeBoundaryState());
  await writeIntentCheckpoint();
  await acknowledgeResume();
}

/** A gate runner whose first command fails, with output to capture. */
const failingRunner = () => ({
  status: 1,
  stdout: FAILING_STDOUT,
  stderr: FAILING_STDERR,
});

beforeEach(async () => {
  await harness.resetTestRepo();
});
afterEach(async () => {
  await harness.cleanupTestRepo();
});

describe("a red tool-owned gate pauses the run without mutating it", () => {
  it("emits final_gate_red and leaves every item status and the phase untouched", async () => {
    await establishBoundaryRun();

    const step = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: failingRunner,
    });

    expect(step.step_kind).toBe("final_gate_red");
    expect(step.status).toBe("blocked");
    expect(step.run_id).toBe("PLAN-GATE");

    // THE property: the 21-resolution wipe was item mutation on an
    // unattributable red. Nothing moved.
    const persisted = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(persisted?.status).toBe("implementing");
    expect(persisted?.items?.["F-000"]?.status).toBe("resolved");
    expect(persisted?.items?.["F-001"]?.status).toBe("pending");
    // The re-attempt path also stamped this; its absence is a second witness
    // that no coarse backstop ran.
    expect(persisted?.items?.["F-000"]?.failure_context).toBeUndefined();
  });

  it("names the failing command in the prompt and points at the record, not the log", async () => {
    await establishBoundaryRun();

    const step = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: failingRunner,
    });
    const prompt = await readFile(step.prompt_path, "utf8");

    // The FIRST gate command is the one that fails (the gate short-circuits).
    const firstCommand = toolOwnedFinalGateCommands(REPO_DIR)[0]!.argv.join(" ");
    expect(prompt).toContain(firstCommand);
    expect(prompt).toContain("final-gate.json");
    // The tail lives in the artifact, NOT inline: a whole suite log must never
    // ride into a prompt.
    expect(prompt).not.toContain(FAILING_STDOUT);
    expect(step.artifact_paths.final_gate_record).toBeTruthy();
  });

  it("persists the failing command, its exit code and a bounded output tail", async () => {
    await establishBoundaryRun();

    await decideNextStep({ root: REPO_DIR, finalGateRunner: failingRunner });

    const recordPath = join(ARTIFACTS_DIR, "final-gate.json");
    expect(existsSync(recordPath)).toBe(true);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(record.failing_command).toBe(
      toolOwnedFinalGateCommands(REPO_DIR)[0]!.argv.join(" "),
    );
    expect(record.exit_code).toBe(1);
    expect(record.stdout_tail).toBe(FAILING_STDOUT);
    expect(record.stderr_tail).toBe(FAILING_STDERR);
    expect(record.scope).toContain("phase 1");
    // The retired counter/termination fields must not come back: `terminated`
    // short-circuited the gate, so a run that once hit the old bound skipped the
    // suite check forever after.
    expect(record.coarse_reblock_count).toBeUndefined();
    expect(record.terminated).toBeUndefined();
  });

  it("re-runs the gate on the next call and proceeds once it is green", async () => {
    await establishBoundaryRun();

    const red = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: failingRunner,
    });
    expect(red.step_kind).toBe("final_gate_red");

    // Resumable BY CONSTRUCTION: nothing was consumed by the pause, so a green
    // gate on the very next call opens the phase. A stored "already gave up"
    // flag is exactly what would have made this unreachable.
    const green = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => ({ status: 0 }),
    });
    expect(green.step_kind).not.toBe("final_gate_red");
  });
});

describe("the gate's unit leg reads a trustworthy verdict", () => {
  it("routes vitest through run-vitest-gate.mjs rather than a bare npx vitest run", async () => {
    await makeRepoLookLikeAuditTools();
    const commands = toolOwnedFinalGateCommands(REPO_DIR);
    const unit = commands.filter((spec) => spec.layer === "unit");
    expect(unit.length).toBeGreaterThan(0);
    for (const spec of unit) {
      // A raw vitest exit is not a verdict in this repo: it has exited 0 with
      // reported failures, and exits 1 with ZERO failures under worker-RPC
      // starvation — the latter is a whole-repo gate red on a healthy tree.
      expect(spec.argv.join(" ")).toContain("scripts/shared/run-vitest-gate.mjs");
      expect(spec.argv.join(" ")).not.toMatch(/^npx vitest run/u);
    }
  });

  it("scopes OUT a tree carrying the layout markers but not the gate script", async () => {
    // Applicability must be verified, not coincidental. A tree with the five
    // layout markers and no gate script would otherwise be judged in scope, spawn
    // `node <missing>`, exit 1, and report a whole-repo RED on a healthy repo —
    // the same false-red class the pause design exists to remove. This fixture
    // shape is not hypothetical: it is what the harness produced before the
    // predicate learned to check the script.
    await writeLayoutMarkers();
    expect(isAuditToolsMonorepo(REPO_DIR)).toBe(false);
    expect(toolOwnedFinalGateCommands(REPO_DIR)).toEqual([]);

    const gate = await runToolOwnedFinalGate(REPO_DIR, {
      runner: failingRunner,
    });
    // Scoped out, so the failing runner is never consulted: no command ran.
    expect(gate.scoped_out).toBe(true);
    expect(gate.passed).toBe(true);
    expect(gate.results).toEqual([]);
  });

  it("scopes IN once the gate script is present", async () => {
    await makeRepoLookLikeAuditTools();
    expect(isAuditToolsMonorepo(REPO_DIR)).toBe(true);
    expect(toolOwnedFinalGateCommands(REPO_DIR).length).toBeGreaterThan(0);
  });
});
