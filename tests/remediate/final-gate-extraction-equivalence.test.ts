// Behaviour-preserving extraction equivalence pin (CP-NODE-1).
//
// The tool-owned final-gate cluster was lifted out of the nextStep.ts god module
// into the sibling leaf module finalGate.ts as a PURE MOVE. This suite pins that
// the move is behaviour-preserving: the symbols re-exported by nextStep.ts ARE
// the exact same references finalGate.ts exports (a move, not a
// re-implementation, so there is no second copy that could drift). If a future
// edit re-implements one in nextStep.ts instead of re-exporting finalGate.ts's,
// the identity assertions fail loudly.
//
// The suite's other half used to characterize `applyCoarseReblock` — the coarse
// backstop that re-opened every item on a whole-repo red and abandoned the run
// at its bound. That function is gone, and with it those cases: a red now
// records what failed and pauses, which is pinned in final-gate-red-pause.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideNextStep,
  runToolOwnedFinalGate as runToolOwnedFinalGateNext,
  toolOwnedFinalGateCommands as toolOwnedFinalGateCommandsNext,
} from "../../src/remediate/steps/nextStep.js";
import {
  finalGateOutcomePath,
  isAuditToolsMonorepo,
  runToolOwnedFinalGate as runToolOwnedFinalGateGate,
  toolOwnedFinalGateCommands as toolOwnedFinalGateCommandsGate,
  writeFinalGateOutcomeRecord,
  type FinalGateOutcomeRecord,
} from "../../src/remediate/steps/finalGate.js";
import {
  buildRemediationOutcomesReport,
  runClosePhase,
} from "../../src/remediate/phases/close.js";
import type { ClosingResult } from "../../src/remediate/phases/close.js";
import type { OrchestratorOptions } from "../../src/remediate/types/options.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { Finding } from "../../src/remediate/state/types.js";
import type { EvidenceMechanismKind } from "../../src/shared/types/remediationOutcome.js";
import { scratchDir } from "../helpers/scratch.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const TESTS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The audit-tools repo itself — the one tree the gate's command list applies to. */
const REPO_ROOT = dirname(TESTS_ROOT);
const SCRATCH = scratchDir(".test-final-gate-extraction");

describe("CP-NODE-1: final-gate extraction is a behaviour-preserving move", () => {
  it("nextStep.ts re-exports the SAME references finalGate.ts exports (identity, no drift copy)", () => {
    expect(runToolOwnedFinalGateNext).toBe(runToolOwnedFinalGateGate);
    expect(toolOwnedFinalGateCommandsNext).toBe(toolOwnedFinalGateCommandsGate);
  });

  it("runToolOwnedFinalGate scopes out (does not block) on a non-monorepo target via both paths", async () => {
    const noRepo = "/definitely/not/the/audit-tools/repo/root";
    const runner = () => ({ status: 0 });
    const viaNext = await runToolOwnedFinalGateNext(noRepo, { runner });
    const viaGate = await runToolOwnedFinalGateGate(noRepo, { runner });
    expect(viaNext.scoped_out).toBe(true);
    expect(viaGate.scoped_out).toBe(true);
    expect(viaNext.passed).toBe(true);
    expect(viaGate.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OBL-remediate-nextstep-and-final-gate-inv-2: the command list is non-vacuous
// for the audit-tools structure, never references plan.test_command, every unit
// command is build-free, and no package's unit suite appears twice (CE-001).
//
// Every assertion below is DERIVED from the returned FinalGateCommandSpec
// objects — layers, build_free flags, package_dir values and argv are read off
// the result. A hand-copied literal list would be the very drift test this
// obligation exists to remove: it would stay green while the production list
// went vacuous.
// ---------------------------------------------------------------------------

describe("OBL-…-inv-2: the gate's command list is derived, not transcribed", () => {
  it("POSITIVE: an audit-tools-shaped root yields at least one build, check and unit layer", () => {
    expect(isAuditToolsMonorepo(REPO_ROOT)).toBe(true);
    const specs = toolOwnedFinalGateCommandsGate(REPO_ROOT);
    expect(specs.length, "the list must never be vacuous here").toBeGreaterThan(0);
    const layers = new Set(specs.map((spec) => spec.layer));
    expect(layers.has("build")).toBe(true);
    expect(layers.has("check")).toBe(true);
    expect(layers.has("unit")).toBe(true);
  });

  it("POSITIVE: the check layer carries MORE THAN ONE command, so the test-tree typecheck cannot be dropped silently", () => {
    // Derived as a COUNT off the result, not a transcribed command string:
    // dropping `check:tests` (which lands type-red test files invisible to both
    // vitest and `check`) leaves one check-layer command and turns this red.
    const specs = toolOwnedFinalGateCommandsGate(REPO_ROOT);
    const check = specs.filter((spec) => spec.layer === "check");
    expect(check.length).toBeGreaterThanOrEqual(2);
    const distinct = new Set(check.map((spec) => spec.argv.join(" ")));
    expect(distinct.size, "two check commands that are the same command are one").toBe(
      check.length,
    );
  });

  it("POSITIVE: every unit command is build-free and no package_dir repeats (single-flight)", () => {
    const specs = toolOwnedFinalGateCommandsGate(REPO_ROOT);
    const unit = specs.filter((spec) => spec.layer === "unit");
    expect(unit.length).toBeGreaterThan(0);
    for (const spec of unit) {
      expect(spec.build_free, `${spec.argv.join(" ")} must not prepend a build`).toBe(
        true,
      );
    }
    const dirs = specs
      .map((spec) => spec.package_dir)
      .filter((dir): dir is string => dir !== undefined);
    expect(new Set(dirs).size, "a package's unit suite must not run twice").toBe(
      dirs.length,
    );
  });

  it("NEGATIVE: no argv can carry a plan-supplied test command — the derivation's only input is `root`", () => {
    // Structural, not a string search for a value we happened to think of: the
    // function's ONLY parameter is the root, so there is no channel through
    // which a `plan.test_command` could reach an argv. The determinism check
    // beside it closes the other half (nothing is rewritten per call).
    expect(toolOwnedFinalGateCommandsGate.length, "arity is the channel count").toBe(1);
    const first = toolOwnedFinalGateCommandsGate(REPO_ROOT);
    const second = toolOwnedFinalGateCommandsGate(REPO_ROOT);
    expect(second).toEqual(first);
    for (const spec of first) {
      for (const token of spec.argv) {
        expect(token).not.toContain("test_command");
      }
    }
  });

  it("NEGATIVE: a root missing ANY ONE of the six markers is out of scope, and its list is empty", async () => {
    const MARKER_DIRS = ["src/shared", "src/audit", "src/remediate"];
    const MARKER_FILES = [
      "audit-code.mjs",
      "remediate-code.mjs",
      join("scripts", "shared", "run-vitest-gate.mjs"),
    ];
    const markers = [...MARKER_DIRS, ...MARKER_FILES];

    async function buildTree(root: string, omit?: string): Promise<void> {
      await rm(root, { recursive: true, force: true });
      for (const dir of MARKER_DIRS) {
        if (dir === omit) continue;
        await mkdir(join(root, dir), { recursive: true });
      }
      for (const file of MARKER_FILES) {
        if (file === omit) continue;
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), "// marker\n", "utf8");
      }
    }

    const complete = join(SCRATCH, "markers-complete");
    await buildTree(complete);
    expect(isAuditToolsMonorepo(complete)).toBe(true);
    expect(toolOwnedFinalGateCommandsGate(complete).length).toBeGreaterThan(0);

    for (const [index, marker] of markers.entries()) {
      const partial = join(SCRATCH, `markers-missing-${String(index)}`);
      await buildTree(partial, marker);
      expect(isAuditToolsMonorepo(partial), `missing ${marker}`).toBe(false);
      expect(toolOwnedFinalGateCommandsGate(partial), `missing ${marker}`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// OBL-remediate-nextstep-and-final-gate-inv-8: the BLOCKING path of the gate.
//
// The only runToolOwnedFinalGate coverage used to pass a NON-monorepo root, so
// the command list was empty, the scoped_out early return fired, and the
// injected runner was never invoked — the command loop, the per-command result
// recording, `passed: false` and the short-circuit were executed by no test at
// all. GateRunner exists precisely to make that path testable without spawning
// a real build.
// ---------------------------------------------------------------------------

describe("OBL-…-inv-8: the gate's blocking path is executed, not just its early exit", () => {
  it("POSITIVE: an all-green injected runner is invoked once per command, in declared order", async () => {
    const specs = toolOwnedFinalGateCommandsGate(REPO_ROOT);
    const invoked: string[] = [];
    const gate = await runToolOwnedFinalGateGate(REPO_ROOT, {
      runner: (argv) => {
        invoked.push(argv.join(" "));
        return { status: 0 };
      },
    });
    expect(gate.scoped_out).toBe(false);
    expect(gate.outcome).toBe("executed");
    expect(gate.passed).toBe(true);
    expect(invoked, "the runner must actually run").toEqual(
      specs.map((spec) => spec.argv.join(" ")),
    );
    expect(gate.results.map((result) => result.argv.join(" "))).toEqual(invoked);
    for (const result of gate.results) {
      expect(result.passed).toBe(true);
      expect(result.exit_code).toBe(0);
      // Output is recorded on FAILURE only — a green command's log is noise.
      expect(result.stdout_tail).toBeUndefined();
    }
  });

  it("NEGATIVE: a runner failing on the check layer stops there — passed false, later layers absent", async () => {
    const specs = toolOwnedFinalGateCommandsGate(REPO_ROOT);
    const checkIndex = specs.findIndex((spec) => spec.layer === "check");
    expect(checkIndex, "a check layer must exist to fail on").toBeGreaterThan(-1);
    const failingCommand = specs[checkIndex]!.argv.join(" ");

    let calls = 0;
    const gate = await runToolOwnedFinalGateGate(REPO_ROOT, {
      runner: (argv) => {
        calls += 1;
        return argv.join(" ") === failingCommand
          ? { status: 2, stdout: "tsc: 3 errors", stderr: "TS2345: not assignable" }
          : { status: 0 };
      },
    });

    expect(gate.passed).toBe(false);
    expect(gate.outcome).toBe("executed");
    expect(calls, "the short-circuit stops the loop at the first red").toBe(
      checkIndex + 1,
    );
    expect(gate.results).toHaveLength(checkIndex + 1);
    const failed = gate.results.at(-1)!;
    expect(failed.argv.join(" ")).toBe(failingCommand);
    expect(failed.passed).toBe(false);
    expect(failed.exit_code).toBe(2);
    expect(failed.stdout_tail).toContain("tsc: 3 errors");
    expect(failed.stderr_tail).toContain("TS2345");
    for (const later of specs.slice(checkIndex + 1)) {
      const laterCommand = later.argv.join(" ");
      expect(
        gate.results.some((result) => result.argv.join(" ") === laterCommand),
        `${laterCommand} must not have run after a red floor`,
      ).toBe(false);
    }
  });

  it("NEGATIVE: a non-zero exit can never report passed true for its own command", async () => {
    const gate = await runToolOwnedFinalGateGate(REPO_ROOT, {
      runner: () => ({ status: 1 }),
    });
    expect(gate.passed).toBe(false);
    expect(gate.results).toHaveLength(1);
    expect(gate.results[0]!.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OBL-…-inv-1 / inv-13 / fail-7: a gate that ran ZERO commands is a
// distinguishable NOT-RUN outcome, never a pass.
//
// The control flow was never the defect: a scoped-out gate is deliberately
// non-blocking — a declared scope, not a vacuous pass. The defect was the
// AFFIRMATION. Both consumers wrote `passed=<bool>` and nothing else, and that
// boolean is `true` for an executed green floor, for a target the suite does not
// apply to, and for a gate suppressed before it was ever reached. All three
// produced the same bytes, so "the whole floor ran green" and "nothing ran" were
// indistinguishable after the fact.
// ---------------------------------------------------------------------------

async function readOutcomeRecord(dir: string): Promise<FinalGateOutcomeRecord> {
  return JSON.parse(
    await readFile(finalGateOutcomePath(dir), "utf8"),
  ) as FinalGateOutcomeRecord;
}

describe("OBL-…-inv-1/inv-13/fail-7: executed, scoped-out and disabled are three records", () => {
  it("POSITIVE: an executed gate records its real verdict and the number of commands that ran", async () => {
    const dir = join(SCRATCH, "outcome-executed");
    await mkdir(dir, { recursive: true });
    await writeFinalGateOutcomeRecord(dir, {
      scope: "all-terminal final gate",
      outcome: "executed",
      passed: true,
      commands_run: 4,
    });
    const record = await readOutcomeRecord(dir);
    expect(record.outcome).toBe("executed");
    expect(record.passed).toBe(true);
    expect(record.commands_run).toBe(4);
    expect(record.schema_version).toBe("remediate-code-final-gate-outcome/v1alpha1");
  });

  it("NEGATIVE: a not-run gate cannot be RECORDED as a pass, even when told it passed", async () => {
    // The normalization lives in the writer, not at the call sites: a consumer
    // handing `passed: true` for a gate that ran nothing still persists `null`.
    for (const outcome of ["scoped_out", "disabled"] as const) {
      const dir = join(SCRATCH, `outcome-${outcome}`);
      await mkdir(dir, { recursive: true });
      await writeFinalGateOutcomeRecord(dir, {
        scope: "all-terminal final gate",
        outcome,
        passed: true,
        commands_run: 4,
        reason: "fixture",
      });
      const record = await readOutcomeRecord(dir);
      expect(record.outcome).toBe(outcome);
      expect(record.passed, `${outcome} has no verdict to report`).toBeNull();
      expect(record.commands_run, `${outcome} ran nothing`).toBe(0);
      expect(record.reason).toBe("fixture");
    }
  });

  it("NEGATIVE: the three outcomes are not byte-identical records", async () => {
    const bodies = new Set<string>();
    for (const outcome of ["executed", "scoped_out", "disabled"] as const) {
      const dir = join(SCRATCH, `outcome-distinct-${outcome}`);
      await mkdir(dir, { recursive: true });
      await writeFinalGateOutcomeRecord(dir, {
        scope: "all-terminal final gate",
        outcome,
        passed: true,
        commands_run: 4,
      });
      const record = await readOutcomeRecord(dir);
      const { recorded_at: _ignored, ...stable } = record;
      bodies.add(JSON.stringify(stable));
    }
    expect(bodies.size, "three outcomes, three records").toBe(3);
  });

  it("NEGATIVE: runToolOwnedFinalGate itself reports WHICH of the two reachable kinds happened", async () => {
    const scoped = await runToolOwnedFinalGateGate(
      "/definitely/not/the/audit-tools/repo/root",
      { runner: () => ({ status: 0 }) },
    );
    const executed = await runToolOwnedFinalGateGate(REPO_ROOT, {
      runner: () => ({ status: 0 }),
    });
    // Both are `passed: true` — which is exactly why the boolean alone cannot
    // carry the distinction and `outcome` has to.
    expect(scoped.passed).toBe(executed.passed);
    expect(scoped.outcome).toBe("scoped_out");
    expect(executed.outcome).toBe("executed");
  });
});

// ---------------------------------------------------------------------------
// OBL-…-inv-15: the injectable final-gate runner is a PRODUCTION seam owned
// here, and it is the only way a harness-driven run reaches the gate. The
// environment skip produces NO gate record path at all, so no suite may use it.
// ---------------------------------------------------------------------------

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

describe("OBL-…-inv-15: hermeticity comes from the injected runner, never the env skip", () => {
  it("NEGATIVE: no file under tests/ references the final-gate environment skip", async () => {
    // The needle is ASSEMBLED, so this scanner does not match itself and the
    // scan can therefore cover its own file — a scanner that has to exclude
    // itself is a scanner with a hole exactly where its author is standing.
    const needle = ["REMEDIATE", "SKIP", "FINAL", "GATE"].join("_");
    const offenders: string[] = [];
    const scanned: string[] = [];
    for await (const file of walkFiles(TESTS_ROOT)) {
      if (!/\.(?:ts|mts|cts|mjs|cjs|js)$/u.test(file)) continue;
      scanned.push(file);
      if ((await readFile(file, "utf8")).includes(needle)) offenders.push(file);
    }
    // ANTI-VACUITY. An empty offender list is only meaningful if the walk read
    // anything: a moved tests root, a tightened extension filter, or a throw
    // swallowed upstream would all produce a green "no offenders" having
    // scanned nothing. Assert both that files were read AND that the scan
    // reached a file we KNOW exists — this one.
    expect(scanned.length, "the walk must actually read files").toBeGreaterThan(0);
    expect(
      scanned,
      "the scan must reach its own file, or its coverage claim is unfounded",
    ).toContain(fileURLToPath(import.meta.url));
    expect(
      offenders,
      "a suite that sets the env skip records no gate outcome at all; inject a runner instead",
    ).toEqual([]);
  });

  it("POSITIVE: injecting a runner is sufficient — the whole floor is recorded, nothing is spawned", async () => {
    // The injected runner services EVERY command, so the default `runTracked`
    // spawner is never reached: hermeticity without suppressing the gate, which
    // is the whole point of keeping the seam in production.
    let injectedCalls = 0;
    const gate = await runToolOwnedFinalGateGate(REPO_ROOT, {
      runner: () => {
        injectedCalls += 1;
        return { status: 0 };
      },
    });
    const expected = toolOwnedFinalGateCommandsGate(REPO_ROOT).length;
    expect(injectedCalls).toBe(expected);
    expect(gate.outcome).toBe("executed");
    expect(gate.results).toHaveLength(expected);
  });
});

// ---------------------------------------------------------------------------
// The same three outcomes END TO END, through decideNextStep — the half a unit
// test of the writer can never establish: that the CONSUMERS record them.
// ---------------------------------------------------------------------------

const harness = createNextStepHarness(".test-final-gate-extraction-e2e");
const { REPO_DIR, ARTIFACTS_DIR, saveState, acknowledgeResume, writeIntentCheckpoint } =
  harness;

/** The layout markers AND the script the unit leg spawns — both are the scope test. */
async function makeRepoLookLikeAuditTools(): Promise<void> {
  for (const dir of ["src/shared", "src/audit", "src/remediate"]) {
    await mkdir(join(REPO_DIR, dir), { recursive: true });
  }
  for (const file of ["audit-code.mjs", "remediate-code.mjs"]) {
    await writeFile(join(REPO_DIR, file), "// fixture\n", "utf8");
  }
  await mkdir(join(REPO_DIR, "scripts", "shared"), { recursive: true });
  await writeFile(
    join(REPO_DIR, "scripts", "shared", "run-vitest-gate.mjs"),
    "// fixture gate script\n",
    "utf8",
  );
}

/** Phase 0 landed, phase 1 pristine — the shape `phaseBoundaryToGate` gates on. */
function makeBoundaryState(): RemediationState {
  const finding = (id: string, path: string): Finding =>
    ({
      id,
      title: `Finding ${id}`,
      category: "correctness",
      severity: "high",
      confidence: "high",
      lens: "correctness",
      summary: `Fix ${id}.`,
      affected_files: [{ path }],
      evidence: [`${path}:1 evidence`],
    }) as Finding;
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-GATE-OUTCOME",
      findings: [finding("F-000", "src/a.ts"), finding("F-001", "src/b.ts")],
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

async function establishBoundaryRun(inScope: boolean): Promise<void> {
  if (inScope) await makeRepoLookLikeAuditTools();
  await saveState(makeBoundaryState());
  await writeIntentCheckpoint();
  await acknowledgeResume();
}

beforeEach(async () => {
  await harness.resetTestRepo();
});
afterEach(async () => {
  await harness.cleanupTestRepo();
});

describe("OBL-…-inv-1/fail-7 end to end: the consumers record which gate happened", () => {
  it("POSITIVE: an executed green floor records outcome=executed with its command count", async () => {
    await establishBoundaryRun(true);
    const commands = toolOwnedFinalGateCommandsGate(REPO_DIR).length;
    expect(commands).toBeGreaterThan(0);

    await decideNextStep({ root: REPO_DIR, finalGateRunner: () => ({ status: 0 }) });

    const record = await readOutcomeRecord(ARTIFACTS_DIR);
    expect(record.outcome).toBe("executed");
    expect(record.passed).toBe(true);
    expect(record.commands_run).toBe(commands);
    expect(record.scope).toContain("phase 1");
  });

  it("NEGATIVE: a SCOPED-OUT gate takes the same non-blocking branch but leaves a different record", async () => {
    await establishBoundaryRun(false); // no markers → the suite does not apply
    expect(toolOwnedFinalGateCommandsGate(REPO_DIR)).toEqual([]);

    await decideNextStep({ root: REPO_DIR, finalGateRunner: () => ({ status: 0 }) });

    const record = await readOutcomeRecord(ARTIFACTS_DIR);
    expect(record.outcome).toBe("scoped_out");
    expect(record.passed, "nothing ran, so there is no verdict").toBeNull();
    expect(record.commands_run).toBe(0);
    expect(record.reason).toBeTruthy();
  });

  it("NEGATIVE: a DISABLED gate — the quietest not-run — still leaves a record naming the suppression", async () => {
    await establishBoundaryRun(true);

    await decideNextStep({
      root: REPO_DIR,
      skipFinalGate: true,
      finalGateRunner: () => ({ status: 0 }),
    });

    const record = await readOutcomeRecord(ARTIFACTS_DIR);
    expect(record.outcome).toBe("disabled");
    expect(record.passed).toBeNull();
    expect(record.commands_run).toBe(0);
    expect(record.reason).toContain("skipFinalGate");
  });

  it("NEGATIVE: the run log tells the three apart too — never a bare passed=true for a not-run", async () => {
    await establishBoundaryRun(false);
    await decideNextStep({ root: REPO_DIR, finalGateRunner: () => ({ status: 0 }) });
    const log = await readFile(join(ARTIFACTS_DIR, "run.log.jsonl"), "utf8");
    const gateLines = log
      .split("\n")
      .filter((line) => line.includes("phase_boundary_gate"));
    expect(gateLines.length).toBeGreaterThan(0);
    const end = gateLines.find((line) => line.includes("outcome="))!;
    expect(end).toContain("outcome=scoped_out");
    expect(end, "a not-run gate has no verdict to log").toContain("passed=n/a");
    expect(end).not.toContain("passed=true");
  });
});

// ---------------------------------------------------------------------------
// OBL-…-inv-1, THE COMPLETION-REPORT LEG. The gate record had no reader, so the
// report a scoped-out or disabled run produced was byte-identical to one written
// after a green floor — the distinction existed on disk and died there.
// `runClosePhase` now reads it into `remediation-outcomes.json` and the render.
// ---------------------------------------------------------------------------

describe("OBL-…-inv-1: the completion report names which gate happened", () => {
  const OUTPUT_DIR = () => join(REPO_DIR, ".audit-tools");

  function closingState(): RemediationState {
    return {
      status: "closing",
      plan: {
        plan_id: "PLAN-GATE-REPORT",
        findings: [
          {
            id: "F-001",
            title: "Finding F-001",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix F-001.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["src/a.ts:1 evidence"],
          } as Finding,
        ],
        blocks: [
          {
            block_id: "B-001",
            items: ["F-001"],
            parallel_safe: true,
            touched_files: ["src/a.ts"],
          },
        ],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
      },
      closing_plan: { action: "none" },
    } as unknown as RemediationState;
  }

  async function closeWithGateRecord(
    record: Record<string, unknown> | undefined,
  ): Promise<{ report: string; outcomes: Record<string, unknown> }> {
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    if (record) {
      await writeFile(
        finalGateOutcomePath(ARTIFACTS_DIR),
        JSON.stringify(record),
        "utf8",
      );
    }
    await runClosePhase(closingState(), {
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
    } as OrchestratorOptions);
    return {
      report: await readFile(join(OUTPUT_DIR(), "remediation-report.md"), "utf8"),
      outcomes: JSON.parse(
        await readFile(join(OUTPUT_DIR(), "remediation-outcomes.json"), "utf8"),
      ) as Record<string, unknown>,
    };
  }

  it("POSITIVE: an executed GREEN floor is named green in the contract and the render", async () => {
    const { report, outcomes } = await closeWithGateRecord({
      schema_version: "remediate-code-final-gate-outcome/v1alpha1",
      scope: "all-terminal final gate",
      outcome: "executed",
      passed: true,
      commands_run: 4,
      recorded_at: new Date().toISOString(),
    });
    const gate = outcomes.final_gate as Record<string, unknown>;
    expect(gate.outcome).toBe("executed");
    expect(gate.passed).toBe(true);
    expect(gate.commands_run).toBe(4);
    expect(report).toContain("## Repository Gate");
    expect(report).toContain("executed");
    expect(report).toContain("PASSED");
  });

  it("NEGATIVE: a SCOPED-OUT record is named scoped_out and explicitly not a pass", async () => {
    const { report, outcomes } = await closeWithGateRecord({
      schema_version: "remediate-code-final-gate-outcome/v1alpha1",
      scope: "phase 1 boundary",
      outcome: "scoped_out",
      passed: null,
      commands_run: 0,
      reason: "target is not the audit-tools monorepo",
      recorded_at: new Date().toISOString(),
    });
    const gate = outcomes.final_gate as Record<string, unknown>;
    expect(gate.outcome).toBe("scoped_out");
    expect(gate.passed, "a gate that ran nothing has no verdict").toBeNull();
    expect(report).toContain("scoped_out");
    expect(report).toContain("did NOT run");
    expect(report, "the report must refuse to read a not-run gate as green").toContain(
      "This is not a pass",
    );
    expect(report).not.toContain("PASSED");
  });

  it("NEGATIVE: an ABSENT record is stated as absent, never inferred as green", async () => {
    const { report, outcomes } = await closeWithGateRecord(undefined);
    const gate = outcomes.final_gate as Record<string, unknown>;
    expect(gate.outcome).toBe("absent");
    expect(gate.passed).toBeNull();
    expect(report).toContain("Outcome: absent");
    expect(report).toContain("This is not a pass");
  });

  it("NEGATIVE: a hand-forged not-run record claiming passed:true is normalized, not reprinted", async () => {
    const { report, outcomes } = await closeWithGateRecord({
      schema_version: "remediate-code-final-gate-outcome/v1alpha1",
      scope: "all-terminal final gate",
      outcome: "disabled",
      passed: true,
      commands_run: 4,
      reason: "skipFinalGate option",
      recorded_at: new Date().toISOString(),
    });
    const gate = outcomes.final_gate as Record<string, unknown>;
    expect(gate.outcome).toBe("disabled");
    expect(gate.passed, "only an executed gate may carry a verdict").toBeNull();
    expect(gate.commands_run).toBe(0);
    expect(report).toContain("skipFinalGate option");
    expect(report).not.toContain("PASSED");
  });

  it("NEGATIVE: the three reports are not the same document", async () => {
    const executed = await closeWithGateRecord({
      schema_version: "remediate-code-final-gate-outcome/v1alpha1",
      scope: "s",
      outcome: "executed",
      passed: true,
      commands_run: 4,
      recorded_at: "2026-01-01T00:00:00.000Z",
    });
    await harness.resetTestRepo();
    const scoped = await closeWithGateRecord({
      schema_version: "remediate-code-final-gate-outcome/v1alpha1",
      scope: "s",
      outcome: "scoped_out",
      passed: null,
      commands_run: 0,
      recorded_at: "2026-01-01T00:00:00.000Z",
    });
    await harness.resetTestRepo();
    const absent = await closeWithGateRecord(undefined);

    const gateSection = (report: string): string =>
      report.slice(report.indexOf("## Repository Gate")).split("\n##")[0]!;
    const sections = new Set([
      gateSection(executed.report),
      gateSection(scoped.report),
      gateSection(absent.report),
    ]);
    expect(sections.size, "three gate outcomes, three reports").toBe(3);
  });
});

// ---------------------------------------------------------------------------
// OBL-remediate-nextstep-and-final-gate-inv-16: INV-COVERAGE.
//
// This module owns the TERMINAL DISPOSITION of exactly 9 approved finding ids.
// The join reads the PERSISTED outcome-status layer (resolved / verified_no_change
// / verified_already_fixed / refuted) that `dispositionToOutcomeStatus` produces,
// never a disposition-layer name as a literal, and it goes RED on a non-terminal
// value, on a missing record, and on incomplete file+line+mechanism evidence.
// ---------------------------------------------------------------------------

describe("OBL-…-inv-16: INV-COVERAGE — this module's 9 owned ids", () => {
  const OWNED_IDS = [
    "COR-e362503b",
    "OBS-8cbb8e8d",
    "OBS-e362503b",
    "TST-1749661e",
    "TST-24a69a8d",
    "TST-8cbb8e8d",
    "TST-8cbb8e8d-2",
    "TST-e362503b",
    "TST-e362503b-2",
  ];
  const TERMINAL_PERSISTED = new Set([
    "resolved",
    "verified_no_change",
    "verified_already_fixed",
    "refuted",
  ]);
  const MODULE = "remediate-nextstep-and-final-gate";
  const closingResult: ClosingResult = {
    contract_version: "remediate-code-closing-result/v1alpha1",
    action: "none",
    status: "skipped",
    commands: [],
  };

  function mkFinding(id: string): Finding {
    return {
      id,
      title: `Finding ${id}`,
      category: "correctness",
      severity: "high",
      confidence: "high",
      lens: "correctness",
      summary: `Fix ${id}.`,
      affected_files: [{ path: "src/remediate/steps/nextStep.ts" }],
      evidence: ["src/remediate/steps/nextStep.ts:1 evidence"],
    } as Finding;
  }

  function stateFor(items: Record<string, unknown>): RemediationState {
    return {
      status: "closing",
      plan: {
        plan_id: "PLAN-RNF-COV",
        findings: OWNED_IDS.map(mkFinding),
        blocks: [
          {
            block_id: "B-1",
            items: OWNED_IDS,
            parallel_safe: true,
            touched_files: [],
          },
        ],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items,
    } as unknown as RemediationState;
  }

  /** One owned id, dispositioned under T with a complete, non-contradicting triple. */
  function coveredItem(id: string, index: number): Record<string, unknown> {
    const disposition =
      index % 3 === 0
        ? "verified_already_fixed"
        : index % 3 === 1
          ? "refuted"
          : undefined;
    const mechanism: EvidenceMechanismKind =
      disposition === "verified_already_fixed"
        ? "read_at_head_verification"
        : disposition === "refuted"
          ? "read_at_head_refutation"
          : "red_green_test";
    return {
      finding_id: id,
      status: "resolved_no_change",
      block_id: "B-1",
      ...(disposition ? { disposition_override: disposition } : {}),
      evidence: {
        file: "src/remediate/steps/finalGate.ts",
        line: `${String(100 + index)}`,
        mechanism,
      },
      recorded_by_module: MODULE,
    };
  }

  it("POSITIVE: all 9 owned ids under T, with complete evidence, join GREEN and keep their attribution", () => {
    const items: Record<string, unknown> = {};
    OWNED_IDS.forEach((id, index) => {
      items[id] = coveredItem(id, index);
    });
    const report = buildRemediationOutcomesReport(stateFor(items), closingResult);
    expect(report.outcomes).toHaveLength(OWNED_IDS.length);
    for (const id of OWNED_IDS) {
      const outcome = report.outcomes.find((o) => o.finding_id === id)!;
      expect(
        TERMINAL_PERSISTED.has(outcome.outcome),
        `${id} must persist a member of T, got '${outcome.outcome}'`,
      ).toBe(true);
      expect(outcome.evidence, `${id} must carry verification evidence`).toBeDefined();
      expect(outcome.evidence!.file.length).toBeGreaterThan(0);
      expect(outcome.evidence!.line.length).toBeGreaterThan(0);
      expect(outcome.evidence!.mechanism.length).toBeGreaterThan(0);
      expect(outcome.recorded_by_module, `${id} attribution round-trips`).toBe(MODULE);
    }
  });

  it("NEGATIVE (condition 4): the all-blocked witness — every owned id blocked WITH a reason is still RED", () => {
    const items: Record<string, unknown> = {};
    for (const id of OWNED_IDS) {
      items[id] = {
        finding_id: id,
        status: "blocked",
        block_id: "B-1",
        failure_reason: "the gate red was unattributable",
      };
    }
    const report = buildRemediationOutcomesReport(stateFor(items), closingResult);
    for (const id of OWNED_IDS) {
      const outcome = report.outcomes.find((o) => o.finding_id === id)!;
      expect(
        TERMINAL_PERSISTED.has(outcome.outcome),
        `${id}: a non-empty reason does not make a non-terminal disposition terminal`,
      ).toBe(false);
    }
  });

  it("NEGATIVE (condition 1): a listed id ABSENT from the outcomes contract is RED", () => {
    const items: Record<string, unknown> = {};
    OWNED_IDS.forEach((id, index) => {
      if (id === OWNED_IDS[0]) return; // deleted record
      items[id] = coveredItem(id, index);
    });
    const state = stateFor(items);
    state.plan!.findings = state.plan!.findings.filter((f) => f.id !== OWNED_IDS[0]);
    const report = buildRemediationOutcomesReport(state, closingResult);
    expect(
      report.outcomes.find((o) => o.finding_id === OWNED_IDS[0]),
      "the join must not find the deleted id",
    ).toBeUndefined();
    const covered = OWNED_IDS.filter((id) =>
      report.outcomes.some(
        (o) => o.finding_id === id && TERMINAL_PERSISTED.has(o.outcome),
      ),
    );
    expect(covered).toHaveLength(OWNED_IDS.length - 1);
  });

  it("NEGATIVE (condition 5): stripping any ONE evidence part leaves the id uncovered", () => {
    for (const part of ["file", "line", "mechanism"] as const) {
      const items: Record<string, unknown> = {};
      OWNED_IDS.forEach((id, index) => {
        const item = coveredItem(id, index) as Record<string, unknown> & {
          evidence: Record<string, unknown>;
        };
        if (id === OWNED_IDS[0]) {
          item.evidence = { ...item.evidence, [part]: "" };
        }
        items[id] = item;
      });
      const report = buildRemediationOutcomesReport(stateFor(items), closingResult);
      const outcome = report.outcomes.find((o) => o.finding_id === OWNED_IDS[0])!;
      const complete =
        outcome.evidence !== undefined &&
        outcome.evidence.file.length > 0 &&
        outcome.evidence.line.length > 0 &&
        outcome.evidence.mechanism.length > 0;
      expect(complete, `missing evidence.${part} must not read as a covered close`).toBe(
        false,
      );
    }
  });

  it("NEGATIVE (condition 4, second leg): a persisted member contradicting its mechanism is RED", () => {
    // `refuted` established by a read-at-HEAD VERIFICATION is a wrong value, not
    // a matter of interpretation — which is what makes the two members
    // non-interchangeable rather than invisible to the join.
    const items: Record<string, unknown> = {};
    OWNED_IDS.forEach((id, index) => {
      const item = coveredItem(id, index) as Record<string, unknown> & {
        evidence: Record<string, unknown>;
      };
      if (id === OWNED_IDS[0]) {
        item.disposition_override = "refuted";
        item.evidence = { ...item.evidence, mechanism: "read_at_head_verification" };
      }
      items[id] = item;
    });
    const report = buildRemediationOutcomesReport(stateFor(items), closingResult);
    const outcome = report.outcomes.find((o) => o.finding_id === OWNED_IDS[0])!;
    expect(
      outcome.outcome === "refuted" &&
        outcome.evidence?.mechanism === "read_at_head_verification",
      "the contradiction must be visible in the joined record, not hidden by it",
    ).toBe(false);
  });
});
