/**
 * A drain failure must name the obligation that ACTUALLY threw.
 *
 * `advanceAudit` DRAINS: one `runAuditStep` call folds through successive
 * deterministic obligations. `executeAndRecord` used to report its own pre-drain
 * `decideNextStep` selection, so ANY failure inside the fold was attributed to
 * the drain's FIRST obligation — an executor that had already SUCCEEDED. That is
 * not hypothetical: a `synthesis_executor` blowup was recorded against
 * `runtime_validation_executor` in `deterministic-progress.json` and in the
 * blocked step's reason, and sent the investigation to the wrong file first.
 *
 * The drain below is real end-to-end — real engine, real `advanceAudit`, real
 * `runAuditStep`, real persistence — over a real (tiny) repository. Only the
 * LEAF WORK of the drain's second obligation is replaced, with a runner that
 * throws: "an executor threw" is precisely the condition under test, and
 * synthesizing it here is what keeps the test hermetic and fast.
 */
import { test, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXECUTOR_RUNNERS } from "../../src/audit/orchestrator/executorRunners.js";
import { decideNextStep } from "../../src/audit/orchestrator/nextStep.js";
import { executeAndRecord } from "../../src/audit/cli/nextStepHelpers.js";

/**
 * The drain's step 1 on an empty bundle (verified by the run log below), and
 * therefore what a pre-drain `decideNextStep` selects — the identity the defect
 * reported no matter which step failed.
 */
const FIRST_EXECUTOR = "intake_executor";
const FIRST_OBLIGATION = "repo_manifest";
/** The drain's step 2, and the step made to fail here. */
const FAILING_EXECUTOR = "auto_fix_executor";
const FAILING_OBLIGATION = "auto_fixes_applied";

test("a drain failure names the obligation that threw, not the drain's first", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "drain-attribution-"));
  const root = join(workspace, "repo");
  const artifactsDir = join(workspace, "artifacts");
  const original = EXECUTOR_RUNNERS[FAILING_EXECUTOR];
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(artifactsDir, "steps"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(
      join(root, "package.json"),
      '{"name":"drain-attribution-fixture","version":"1.0.0"}\n',
      "utf8",
    );

    EXECUTOR_RUNNERS[FAILING_EXECUTOR] = async () => {
      throw new Error("synthetic auto-fix failure");
    };

    // Exactly what the CLI fold passes: the decision derived BEFORE the drain,
    // off the (empty) bundle. It selects the drain's first obligation.
    const decision = decideNextStep({}, { emitStaleness: false });
    expect(decision.selected_executor).toBe(FIRST_EXECUTOR);
    expect(decision.selected_obligation).toBe(FIRST_OBLIGATION);

    let caught: unknown;
    try {
      await executeAndRecord({ root, artifactsDir }, undefined, decision, 0, "");
    } catch (error) {
      caught = error;
    }

    expect(caught, "the drain must fail").toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(FAILING_EXECUTOR);
    expect(message).toContain(FAILING_OBLIGATION);
    expect(
      message,
      "the drain's FIRST (already-succeeded) executor must not be blamed",
    ).not.toContain(FIRST_EXECUTOR);
    expect(message).toContain("synthetic auto-fix failure");

    // The filesystem marker a watching host reads must agree, and must still
    // carry the drain's entry point so the fold position stays reconstructable.
    const marker = JSON.parse(
      await readFile(
        join(artifactsDir, "steps", "deterministic-progress.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(marker.last_executor).toBe(FAILING_EXECUTOR);
    expect(marker.last_obligation).toBe(FAILING_OBLIGATION);
    expect(marker.selected_executor).toBe(FIRST_EXECUTOR);
    expect(marker.selected_obligation).toBe(FIRST_OBLIGATION);

    // The persisted audit_state records the same failing identity.
    const state = JSON.parse(
      await readFile(join(artifactsDir, "audit_state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(state.last_executor).toBe(FAILING_EXECUTOR);
    expect(state.last_obligation).toBe(FAILING_OBLIGATION);
  } finally {
    EXECUTOR_RUNNERS[FAILING_EXECUTOR] = original!;
    await rm(workspace, { recursive: true, force: true });
  }
}, 120_000);
