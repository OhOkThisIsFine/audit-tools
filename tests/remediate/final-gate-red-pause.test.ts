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
import { worktreeContentId } from "../../src/remediate/steps/gateCommands.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";
import { execSyncHidden } from "../helpers/spawn.mjs";

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

/**
 * Commit everything currently on disk, so the fixture's own scaffolding stops
 * being "dirty". The harness baseline commit is EMPTY, and the layout markers
 * are written after it — so without this the markers are untracked, the gate
 * reads them as paths the run touched, and every red attributes to the run.
 * In production those files are tracked and clean; this makes the fixture match.
 */
function commitFixture(): void {
  execSyncHidden("git add -A", { cwd: REPO_DIR });
  execSyncHidden('git commit --no-gpg-sign -q -m "fixture tracked"', { cwd: REPO_DIR });
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

    // The host fixes the red — which is what re-running AFTER a fix means, and
    // what moves the TREE the gate's verdict is cached against. Without this
    // the next call would (correctly) serve the red it just recorded; see the
    // cache describe below, where that behaviour is pinned in its own right.
    await writeFile(join(REPO_DIR, "src", "b.ts"), "export const b = 1;\n", "utf8");

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

// ---------------------------------------------------------------------------
// ATTRIBUTION: a red is assigned to the RUN or to the ENVIRONMENT.
//
// The pause design is deliberately non-mutating BECAUSE a whole-repo red is
// unattributable — but "unattributable" was doing two jobs: "we cannot tell
// which item broke" (true and unavoidable) and "we cannot tell whether this run
// is involved at all" (false, and the expensive half). Live-tree dirt that has
// nothing to do with the run read as the run's failure, and the host's only cue
// was a suite log.
//
// The two directions are NOT symmetric and the asymmetry is the point: calling
// a real run-red `environment` is a fail-OPEN answer that tells the host to skip
// work it owes, so an overlap of ANY failing path with the run's own wins.
// ---------------------------------------------------------------------------

describe("a red is attributed to the run or to the environment", () => {
  it("ENVIRONMENT: foreign dirt reports as the environment, not the run", async () => {
    await establishBoundaryRun();
    // A committed, CLEAN file the run never declared: someone else's landed work
    // broke it. Clean is the point — the run's own set is built from its
    // declared surface plus its uncommitted edits, and this is in neither, so
    // nothing here says "the run did it".
    await writeFile(join(REPO_DIR, "src", "other.ts"), "export const x = 1;\n", "utf8");
    commitFixture();
    // The run is mid-flight with its own edit in the tree (B-001 declares
    // `src/b.ts`) — so the run's set is NON-empty and a genuine comparison
    // happens. Without it there is nothing to compare against and the honest
    // answer is `unattributable`, not this one.
    await writeFile(join(REPO_DIR, "src", "b.ts"), "export const b = 2;\n", "utf8");

    const step = await decideNextStep({
      root: REPO_DIR,
      // The failing suite NAMES the file it choked on — the shape a real vitest
      // red has (`FAIL tests/.../foo.test.ts`). A red that names only counts is
      // `unattributable`; see the case below.
      finalGateRunner: () => ({ status: 1, stdout: "FAIL src/other.ts", stderr: "" }),
    });
    expect(step.step_kind).toBe("final_gate_red");

    const record = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate.json"), "utf8"),
    ) as Record<string, any>;
    expect(record.attribution).toBeTruthy();
    expect(record.attribution.verdict).toBe("environment");
    expect(record.attribution.foreign_paths).toContain("src/other.ts");
    expect(record.attribution.run_paths).toEqual([]);

    // The verdict reaches the PROMPT, which is the only thing the host reads.
    // A verdict that lives only in an artifact nothing points at is not a fix.
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("Attribution: ENVIRONMENT");
    expect(prompt).toContain("src/other.ts");
    expect(prompt).toContain("do NOT rework remediation items");
  });

  it("RUN: a failing path the run itself touched attributes to the run", async () => {
    await establishBoundaryRun();
    // A path this run's block declares in `touched_files` (B-001 → src/b.ts),
    // made dirty in the working tree. The suite names it, and the run OWNS it.
    await writeFile(join(REPO_DIR, "src", "b.ts"), "export const b = 2;\n", "utf8");

    const step = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => ({
        status: 1,
        stdout: "FAIL src/b.ts",
        stderr: "",
      }),
    });

    const record = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate.json"), "utf8"),
    ) as Record<string, any>;
    expect(record.attribution.verdict).toBe("run");
    expect(record.attribution.run_paths).toContain("src/b.ts");

    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("Attribution: RUN");
  });

  it("RUN wins over ENVIRONMENT when a red implicates both", async () => {
    // The asymmetry, stated as a test: an overlap of ANY failing path with the
    // run's own means the run is involved, so `environment` — the answer that
    // excuses the run — must not win just because foreign dirt was ALSO failing.
    await establishBoundaryRun();
    await writeFile(join(REPO_DIR, "src", "other.ts"), "export const x = 1;\n", "utf8");
    commitFixture();
    await writeFile(join(REPO_DIR, "src", "b.ts"), "export const b = 2;\n", "utf8");

    await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => ({
        status: 1,
        stdout: "FAIL src/other.ts\nFAIL src/b.ts",
        stderr: "",
      }),
    });

    const record = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate.json"), "utf8"),
    ) as Record<string, any>;
    expect(record.attribution.verdict).toBe("run");
    expect(record.attribution.run_paths).toContain("src/b.ts");
  });

  it("UNATTRIBUTABLE: a red naming no resolvable path asserts nothing either way", async () => {
    // The honest third value. The failing output here is the SHAPE A REAL SUITE
    // VERDICT OFTEN HAS — counts and a summary line, no file paths — and the
    // temptation is to call that "environment" because nothing pointed at the
    // run. That would be a fail-open guess on the one verdict that assigns work.
    await establishBoundaryRun();
    await writeFile(join(REPO_DIR, "src", "b.ts"), "export const b = 2;\n", "utf8");

    const step = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => ({
        status: 1,
        stdout: "Tests  1 failed | 400 passed (401)",
        stderr: "",
      }),
    });

    const record = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate.json"), "utf8"),
    ) as Record<string, any>;
    // `src/b.ts` IS dirty, so the run's set is non-empty — but the output named
    // no path, so there is nothing to compare. Unattributable, not environment.
    expect(record.attribution.run_paths_considered).toContain("src/b.ts");
    expect(record.attribution.verdict).toBe("unattributable");
    expect(record.attribution.failing_paths_count).toBe(0);

    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("Attribution: UNATTRIBUTABLE");
    expect(prompt).not.toContain("do NOT rework remediation items");
  });

  it("ENVIRONMENT: a dirty NON-SOURCE file (config) still attributes to the environment", async () => {
    // The artifact-dir exemption, exercised: `.audit-tools/` is dirty in every
    // run (the step contract, the run log) and must never be read as the run's
    // edit — if it were, every red would attribute to the run and the verdict
    // would be worthless. A `.json` outside that dir is ordinary source.
    await establishBoundaryRun();
    await writeFile(join(REPO_DIR, "vite.config.json"), "{}\n", "utf8");
    commitFixture();
    await writeFile(join(REPO_DIR, "src", "b.ts"), "export const b = 2;\n", "utf8");

    await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => ({ status: 1, stdout: "error in vite.config.json", stderr: "" }),
    });

    const record = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate.json"), "utf8"),
    ) as Record<string, any>;
    expect(record.attribution.verdict).toBe("environment");
    expect(record.attribution.foreign_paths).toContain("vite.config.json");
    // And the run's own scratch is invisible on BOTH sides.
    expect(record.attribution.run_paths).not.toContain(".audit-tools/remediation/state.json");
  });

  it("FAIL-CLOSED: a red located in a TEST file is never attributed to the environment", async () => {
    // The realistic shape, and the fail-open answer was reached through it. The
    // run edits SOURCE; a suite that fails PRINTS the TEST file it choked on.
    // `src/x.ts` is the run's own edit (dirty after the baseline), and
    // `tests/x.test.ts` is a path the run never touched — so the intersection is
    // empty and the verdict was `environment`, whose prompt tells the host "do
    // NOT rework remediation items for it". A whole run's work, skipped on the
    // strength of a path a failing suite always prints.
    await establishBoundaryRun();
    await mkdir(join(REPO_DIR, "tests"), { recursive: true });
    await writeFile(
      join(REPO_DIR, "tests", "x.test.ts"),
      "// the suite's own test\n",
      "utf8",
    );
    await writeFile(join(REPO_DIR, "src", "x.ts"), "export const x = 1;\n", "utf8");
    commitFixture();
    // The run's edit — the ONLY thing it touched. `tests/x.test.ts` stays clean,
    // so it is genuinely foreign; what makes this a red and not an excuse is that
    // it is a TEST.
    await writeFile(join(REPO_DIR, "src", "x.ts"), "export const x = 2;\n", "utf8");

    const step = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => ({
        status: 1,
        stdout: "FAIL tests/x.test.ts > adds",
        stderr: "",
      }),
    });
    expect(step.step_kind).toBe("final_gate_red");

    const record = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate.json"), "utf8"),
    ) as Record<string, any>;
    // The test path IS harvested — it exists and it is a regular file. The fix is
    // not to hide it; it is to refuse to read it as evidence of innocence.
    expect(record.attribution.failing_paths_count).toBe(1);
    expect(record.attribution.verdict).not.toBe("environment");
    expect(record.attribution.verdict).toBe("unattributable");

    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("Attribution: UNATTRIBUTABLE");
    expect(
      prompt,
      "a test red must never license skipping the run's own work",
    ).not.toContain("do NOT rework remediation items");
  });

  /** The attribution verdict a red with `stdout` reached. */
  async function verdictFor(stdout: string): Promise<Record<string, any>> {
    await establishBoundaryRun();
    await mkdir(join(REPO_DIR, "docs"), { recursive: true });
    await writeFile(join(REPO_DIR, "docs", "readme.md"), "# docs\n", "utf8");
    await mkdir(join(REPO_DIR, "src", "nested"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "nested", "deep.ts"), "export {};\n", "utf8");
    // A committed, CLEAN file the run never declared — the real-file control the
    // anti-vacuity case names, and the shape a genuine foreign red has.
    await writeFile(join(REPO_DIR, "src", "other.ts"), "export const x = 1;\n", "utf8");
    commitFixture();
    await writeFile(join(REPO_DIR, "src", "b.ts"), "export const b = 2;\n", "utf8");

    await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => ({ status: 1, stdout, stderr: "" }),
    });
    return JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate.json"), "utf8"),
    ) as Record<string, any>;
  }

  it("a directory, and a file printed with a stray trailing slash, are both rejected", async () => {
    // `npm test` and `tsc` print DIRECTORY names in ordinary output (`docs/`,
    // `src/nested`). A directory is not a failing path, and admitting one
    // manufactures a foreign entry no run-touched set can match — the
    // phantom-foreign route to the same false-environment answer.
    //
    // What this pins is the OBSERVABLE property, not which guard realizes it.
    // Two guards realize it — the trailing-separator rejection and the
    // `statSync(...).isFile()` admission — and on both platforms `isFile()`
    // already rejects every shape below (a slash-suffixed path resolves to a
    // directory entry, so it is never a regular file). Verified by inversion:
    // disabling `isFile()` reds the no-separator case below; disabling the
    // separator check alone reds nothing, which is why no assertion here claims
    // that guard individually.
    const directory = (await verdictFor("error in docs/")).attribution;
    expect(directory.failing_paths_count).toBe(0);
    expect(directory.verdict).toBe("unattributable");

    const bareDirectory = (await verdictFor("error in src/nested")).attribution;
    expect(bareDirectory.failing_paths_count).toBe(0);
    expect(bareDirectory.verdict).toBe("unattributable");

    const straySlash = (await verdictFor("error in src/other.ts/")).attribution;
    expect(
      straySlash.failing_paths_count,
      "`src/other.ts/` must be rejected, not admitted as a path that matches nothing",
    ).toBe(0);
    expect(straySlash.foreign_paths).toEqual([]);
  });

  it("POSITIVE: a real file beside those directories is still harvested", async () => {
    // Anti-vacuity for the two above: a harvest that rejected EVERYTHING would
    // satisfy both and prove nothing. The same output shape, naming a real file,
    // still produces a failing path.
    const attribution = (
      await verdictFor("error in src/nested and src/other.ts")
    ).attribution;
    expect(attribution.failing_paths_count).toBe(1);
    expect(attribution.foreign_paths).toContain("src/other.ts");
  });

  it("does not mistake prose, numbers or phantom paths for failing files", async () => {
    // The harvest is textual and the output is untrusted. A token that is not a
    // real repo file must never enter the comparison: admitted, it would be
    // found NOT in the run's set and reported as foreign — manufacturing the
    // false-environment answer the whole feature exists to avoid.
    await establishBoundaryRun();

    await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => ({
        status: 1,
        stdout: [
          "Tests  2 failed (2)",
          "Duration  12.34s",
          "at Object.<anonymous> (C:/nonexistent/ghost.ts:12:3)",
          "see docs/missing.md for details",
          "1.5/2.0 ratio",
        ].join("\n"),
        stderr: "",
      }),
    });

    const record = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate.json"), "utf8"),
    ) as Record<string, any>;
    expect(record.attribution.failing_paths_count).toBe(0);
    expect(record.attribution.verdict).toBe("unattributable");
    expect(record.attribution.foreign_paths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE TREE-KEYED VERDICT CACHE: the boundary gate runs ONCE per boundary over
// an unchanged tree.
//
// `phaseBoundaryToGate` returns a phase on EVERY next-step that finds the
// phase's blocks pristine, and the floor it guards is build + typecheck + the
// whole suite — minutes, with the phase lock held. The verdict is a function of
// the TREE, so re-spawning that floor against identical content buys nothing:
// the second run cannot disagree with the first.
//
// The counterweight matters as much as the cache: a verdict must never be
// served for a tree nobody judged. Every test below that asserts a HIT is
// paired with one asserting the tree MOVED and the floor ran again.
// ---------------------------------------------------------------------------

describe("the boundary gate's verdict is cached against the tree it judged", () => {
  /**
   * One `next-step` with a COUNTING runner. The count is what the cache is
   * about: the gate's floor consults this runner once per gate command it
   * executes, so a served verdict shows up as zero consultions.
   */
  async function stepWithCount(
    runner: () => { status: number; stdout?: string; stderr?: string },
  ): Promise<{ step: Awaited<ReturnType<typeof decideNextStep>>; calls: number }> {
    let calls = 0;
    const step = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => {
        calls += 1;
        return runner();
      },
    });
    return { step, calls };
  }

  /** The number of commands the floor runs — hence consultations per real run. */
  function gateCommandCount(): number {
    const count = toolOwnedFinalGateCommands(REPO_DIR).length;
    expect(count, "the fixture is in scope, so the floor is non-vacuous").toBeGreaterThan(0);
    return count;
  }

  it("GREEN: a second call over an unchanged tree serves the verdict without re-spawning", async () => {
    await establishBoundaryRun();
    const commands = gateCommandCount();

    const first = await stepWithCount(() => ({ status: 0 }));
    expect(first.step.step_kind).not.toBe("final_gate_red");
    expect(first.calls, "an uncached boundary runs the whole floor").toBe(commands);

    // Same tree, second next-step. Runners consulted: ZERO. The gate is
    // replaced by a read.
    const second = await stepWithCount(() => ({ status: 0 }));
    expect(
      second.calls,
      "the floor must not be re-spawned for a tree it has already certified",
    ).toBe(0);
    expect(second.step.step_kind).not.toBe("final_gate_red");

    // ...and the outcome artifact says WHICH judge answered, because "the
    // suite just passed" and "the suite was not re-run" are different facts.
    const outcome = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate-outcome.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(outcome.outcome).toBe("history");
    expect(outcome.passed).toBe(true);
    expect(outcome.commands_run).toBe(commands);
    expect(String(outcome.reason)).toContain("has not changed");
  });

  it("RED: a cached red re-emits the pause with its failing command intact, without re-spawning", async () => {
    // The red half is cached for the same reason the green half is, and the
    // pause is rebuilt from the cached results rather than re-derived — so a
    // host that re-runs without fixing anything gets the same pause, free.
    await establishBoundaryRun();
    const first = await stepWithCount(failingRunner);
    expect(first.step.step_kind).toBe("final_gate_red");

    const second = await stepWithCount(() => ({
      status: 0,
      // A runner that WOULD answer green is the sharpest form of the
      // assertion: the cached red must win, because the tree it describes has
      // not moved. A served-from-scratch gate would open the phase here.
      stdout: "",
      stderr: "",
    }));
    expect(second.calls, "a cached red is a read, not a re-run").toBe(0);
    expect(second.step.step_kind).toBe("final_gate_red");

    const record = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(record.failing_command).toBe(
      toolOwnedFinalGateCommands(REPO_DIR)[0]!.argv.join(" "),
    );
    expect(record.exit_code).toBe(1);
    // The tail too: the cached results carry it, so the record a host opens is
    // the record the real run wrote, not a hollow restatement of the verdict.
    expect(record.stdout_tail).toBe(FAILING_STDOUT);
    expect(record.stderr_tail).toBe(FAILING_STDERR);

    // And the outcome record states it was a cached verdict, not a fresh floor.
    const outcome = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate-outcome.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(outcome.outcome).toBe("history");
    expect(outcome.passed).toBe(false);
  });

  it("a verdict is NEVER served for a tree that MOVED — the fix re-runs the floor", async () => {
    // THE counterweight. Without it the cache is a mechanism that certifies
    // trees nobody checked, which is strictly worse than the waste it removes.
    await establishBoundaryRun();
    const commands = gateCommandCount();
    const first = await stepWithCount(failingRunner);
    expect(first.step.step_kind).toBe("final_gate_red");

    // The host fixes something — the exact tree the verdict was about is gone.
    await writeFile(join(REPO_DIR, "src", "b.ts"), "export const b = 3;\n", "utf8");

    const after = await stepWithCount(() => ({ status: 0 }));
    expect(
      after.calls,
      "a changed tree must be judged, not remembered",
    ).toBe(commands);
    const outcome = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate-outcome.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(outcome.outcome).toBe("executed");
    expect(outcome.passed).toBe(true);
    expect(after.step.step_kind).not.toBe("final_gate_red");
  });

  it("an UNCOMMITTED edit is part of the tree — the cache keys on content, not on HEAD", async () => {
    // The case the whole mechanism exists for: a mid-flight run is made of
    // uncommitted edits, so an identity taken from HEAD alone would certify a
    // green tree as still-green after the run's own work landed in it.
    await establishBoundaryRun();
    const commands = gateCommandCount();
    const first = await stepWithCount(() => ({ status: 0 }));
    expect(first.step.step_kind).not.toBe("final_gate_red");

    // Same HEAD, different bytes on disk. The verdict it just wrote describes
    // the tree BEFORE this write, so this call must not be served it.
    await writeFile(join(REPO_DIR, "src", "b.ts"), "export const b = 2;\n", "utf8");

    const second = await stepWithCount(() => ({ status: 0 }));
    expect(
      second.calls,
      "an uncommitted edit moved the tree, so HEAD alone cannot be the identity",
    ).toBe(commands);
    expect(second.step.step_kind).not.toBe("final_gate_red");
  });

  it("NAMES ITS BINDING: the red prompt states the tree id and what moves it", async () => {
    // The cache is a real cost when it goes wrong: a host that reads "the suite
    // is red", fixes something the identity does not cover, and re-runs gets the
    // SAME pause served back — and nothing in the prompt said the answer was a
    // function of the tree. So the prompt names the id it is bound to and the
    // one thing an operator can do to move it.
    await establishBoundaryRun();
    const step = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: failingRunner,
    });
    const verdict = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "final-gate-verdict.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(verdict.tree).toBeTruthy();

    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain(
      `Binding: this red is bound to tree \`${String(verdict.tree)}\``,
    );
    // ...and the thing that moves it, in the operator's terms.
    expect(prompt).toContain(".audit-tools/");

    // The CACHED re-emit names the same binding, because it is the same
    // verdict — a second, differently-derived id there would point the operator
    // at a tree the cache is not matching on.
    const second = await decideNextStep({
      root: REPO_DIR,
      finalGateRunner: () => ({ status: 0 }),
    });
    const secondPrompt = await readFile(second.prompt_path, "utf8");
    expect(secondPrompt).toContain(
      `Binding: this red is bound to tree \`${String(verdict.tree)}\``,
    );
  });

  it("NEGATIVE: with no cache record at all the floor always runs", async () => {
    // Anti-vacuity for the whole describe: if `readFinalGateVerdict` were
    // hard-wired to return a record, every test above would pass while the gate
    // never ran. The first call of every test here proves that half — no record
    // exists, so the floor cannot be skipped.
    await establishBoundaryRun();
    expect(existsSync(join(ARTIFACTS_DIR, "final-gate-verdict.json"))).toBe(false);

    const first = await stepWithCount(() => ({ status: 0 }));
    expect(first.calls, "an uncached boundary runs the whole floor").toBe(
      gateCommandCount(),
    );
    expect(existsSync(join(ARTIFACTS_DIR, "final-gate-verdict.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE CONTENT IDENTITY ITSELF. Every cache assertion above is worthless if the
// id can be equal for two trees that are not — a false hit certifies a tree
// nobody judged, which is strictly worse than the waste the cache removes. The
// predecessor derived the id by reading each dirty path back through
// `normalizeRepoPath` (a lower-casing COMPARISON key) and dropping whatever it
// could not read, so it had two silent collision routes. The identity is now
// git's own (`GIT_INDEX_FILE` → `read-tree` → `add -A` → `write-tree`), which
// never re-derives a path from a comparison key.
// ---------------------------------------------------------------------------

describe("the tree content id is git's, not a re-derivation of the paths", () => {
  it("(a) two different contents of one dirty path give two ids", async () => {
    await establishBoundaryRun();
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "x.ts"), "export const x = 1;\n", "utf8");
    const first = await worktreeContentId(REPO_DIR);
    expect(first).not.toBeNull();

    await writeFile(join(REPO_DIR, "src", "x.ts"), "export const x = 2;\n", "utf8");
    const second = await worktreeContentId(REPO_DIR);
    expect(second).not.toBe(first);
  });

  it("(b) a mixed-case dirty path moves the id — the path is hashed as git has it", async () => {
    // The collision `normalizeRepoPath` caused: it lower-cases, and it is a
    // COMPARISON key, so the identity was keyed on a re-derivation rather than on
    // the path git knows. `git add -A` writes the path the tree actually holds
    // and hashes its bytes — there is no key to collapse onto.
    //
    // SCOPE OF THIS PROOF, stated because the mechanism is platform-dependent: on
    // a case-INSENSITIVE checkout (win32, which is where this suite runs) only
    // one file can exist, so this case passes under the predecessor's identity
    // too — it is NOT red-green here. The collapse it guards against is a
    // Linux/macOS observation. What is proved on this host is that a mixed-case
    // path is READ (a `readFile` through a lower-cased key would open the
    // lower-case file, or ENOENT and record `absent` — either way a constant).
    // The platform-independent half of the same defect is case (c) below.
    await establishBoundaryRun();
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(
      join(REPO_DIR, "src", "AuditStep.ts"),
      "export const a = 1;\n",
      "utf8",
    );
    const first = await worktreeContentId(REPO_DIR);
    expect(first).not.toBeNull();

    await writeFile(
      join(REPO_DIR, "src", "AuditStep.ts"),
      "export const a = 2;\n",
      "utf8",
    );
    const second = await worktreeContentId(REPO_DIR);
    expect(
      second,
      "a case-differing path must be read, not collapsed onto a lower-cased key",
    ).not.toBe(first);
  });

  it("(c) a NON-ASCII dirty path moves the id when its content changes", async () => {
    // git QUOTES an unusual path in `--name-only` / `ls-files --others` output
    // (`"src/\303\251.ts"`, C-style octal escapes) unless `core.quotepath` is
    // off. The predecessor fed that quoted text straight to `readFile`, which
    // failed ENOENT — i.e. "the file was DELETED" — and recorded the constant
    // marker `absent` for it. A path git quotes therefore contributed the SAME
    // token whatever the file held, so editing it did not move the id and a
    // verdict for the old content was served for the new one. `write-tree`
    // hashes the bytes git itself hashed, quoting and all.
    const NON_ASCII = "\\u00e9.ts"; // assembled, so this file stays pure ASCII
    await establishBoundaryRun();
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    const target = join(REPO_DIR, "src", JSON.parse(`"${NON_ASCII}"`) as string);
    await writeFile(target, "export const e = 1;\n", "utf8");
    const first = await worktreeContentId(REPO_DIR);
    expect(first).not.toBeNull();

    await writeFile(target, "export const e = 2;\n", "utf8");
    const second = await worktreeContentId(REPO_DIR);
    expect(
      second,
      "a path git quotes must still move the id: the tree is keyed on content",
    ).not.toBe(first);
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
