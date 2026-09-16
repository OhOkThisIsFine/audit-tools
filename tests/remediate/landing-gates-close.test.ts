// THE LANDING-GATE CLOSE LEG.
//
// docs/backlog/open-bugs.md, "The per-item required tests and the host landing
// gate do not include the tree-wide guard suites or the cheap release gates":
// three remediation landings reddened CI after green per-item runs — a
// hand-restated `.audit-tools` literal caught only by the tree-wide path-guard
// suite, a case-folding assertion true only on a case-insensitive volume, and
// an intra-`src/shared` import cycle `check:depgraph` refuses.
//
// WHY THE CLOSE OWNS THEM (and not each item's `required_tests`): these gates
// state facts about the WHOLE tree. The first attempt folded them into every
// work item's required tests, which refused a wave item whose added export had
// no consumer until a LATER item landed — no edit inside that item's scope could
// make the gate pass — and let one item's fault refuse another. The merged-tree
// fact exists only at the close, so that is the boundary that runs it. See
// CLAUDE.md, *A gate states the boundary it OWNS*; the per-item side is pinned
// by the "landing gates" describe in `tests/remediate/host-handoff.test.ts`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runClosePhase } from "../../src/remediate/phases/close.js";
import {
  verifyLandingGates,
  type LandingGateOutcome,
} from "../../src/remediate/phases/closeVerifyLandingGates.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { makeState as makeBaseState } from "./test-helpers.js";
import { scratchDir } from "../helpers/scratch.js";
import { withFsRetry } from "../../src/shared/io/json.js";

const REPO_DIR = scratchDir(".test-landing-gates-close");
const TEST_DIR = join(REPO_DIR, ".audit-tools", "remediation");
const OUTPUT_DIR = join(REPO_DIR, ".audit-tools");
const BASE_OPTIONS = { root: REPO_DIR, artifactsDir: TEST_DIR };

function makeState(overrides: Record<string, unknown> = {}): RemediationState {
  return makeBaseState({
    status: "closing",
    plan: {
      plan_id: "P1",
      findings: [],
      blocks: [],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    closing_plan: { action: "none", pre_authorized: true },
    items: {
      F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
    },
    ...overrides,
  });
}

/**
 * A close leg that reports exactly one gate result, without spawning. The
 * alternative — letting the declared `npm run <gate>` actually run — exercises
 * `npm` itself rather than this leg, and would make every assertion depend on
 * the fixture's npm resolution.
 *
 * The stub REPLACES the spawn, not the discovery: `verified` records the
 * commands discovery actually handed it, so a stub cannot paper over a root
 * that declares no gate.
 */
function stubbedLeg(gate: Pick<LandingGateOutcome, "passed"> & { output?: string }) {
  const verified: string[][] = [];
  return {
    overrides: {
      run: async (command: string[]) => {
        verified.push(command);
        return {
          admitted: true,
          exit_code: gate.passed ? 0 : 1,
          timed_out: false,
          truncated: false,
          output: gate.output ?? "",
        };
      },
    },
    verified,
  };
}

beforeEach(async () => {
  // Every `rm` of a fixture root here is retried through the repo's bounded
  // backoff: this platform can transiently fail an rmdir on a directory a
  // just-killed child still holds a handle on, and a bare `rm` then fails the
  // TEST with an EBUSY that says nothing about the leg under test.
  await withFsRetry(() => rm(REPO_DIR, { recursive: true, force: true }));
  await mkdir(TEST_DIR, { recursive: true });
  // The leg discovers its gates from the TARGET root's `package.json` scripts,
  // so the fixture root has to declare one for the leg to have anything to run.
  // Nothing spawns it — the injected runner replaces the spawn.
  await writeFile(
    join(REPO_DIR, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { "check:lint": "eslint ." } }, null, 2),
    "utf8",
  );
});

afterEach(async () => {
  await withFsRetry(() => rm(REPO_DIR, { recursive: true, force: true }));
});

describe("the landing-gate close leg", () => {
  it("preserves the artifacts dir on a RED landing gate, exactly as a red combined suite does", async () => {
    // Red with the `landingGates.passed` term removed from `fullyGreen` in
    // `cleanupTempBranchesAndArtifacts`: the run then lands green, deletes the
    // artifacts dir, and a tree-wide red is reported as a clean close.
    const state = makeState();
    const leg = stubbedLeg({ passed: false, output: "gate refused: cycle" });
    await runClosePhase(state, {
      ...BASE_OPTIONS,
      landingGateVerifyOverrides: leg.overrides,
    });

    expect(leg.verified, "the declared gate must reach the leg").toEqual([["npm", "run", "check:lint"]]);
    expect(existsSync(TEST_DIR), "artifacts dir must be preserved for diagnosis").toBe(true);
    const report = readFileSync(join(OUTPUT_DIR, "remediation-report.md"), "utf8");
    expect(report).toMatch(/## Landing Gates/);
    // The failure names the command AND carries its output tail — a report that
    // says only "a gate failed" leaves an operator with nothing to act on.
    expect(report).toMatch(/FAILED/);
    expect(report).toContain("gate refused: cycle");
  });

  it("deletes the artifacts dir when the landing gates pass", async () => {
    // The inverse of the test above, so the red proof cannot be satisfied by a
    // leg that simply always preserves.
    const state = makeState();
    await runClosePhase(state, {
      ...BASE_OPTIONS,
      landingGateVerifyOverrides: stubbedLeg({ passed: true }).overrides,
    });

    expect(existsSync(TEST_DIR), "a fully-green close must delete the artifacts dir").toBe(false);
    const report = readFileSync(join(OUTPUT_DIR, "remediation-report.md"), "utf8");
    expect(report).toMatch(/## Landing Gates/);
    expect(report).not.toMatch(/FAILED/);
  });

  it("says in one line that no gate was discovered, rather than omitting the section", async () => {
    // An absent gate set is a real fact about a target repository — one with
    // another build system declares no npm gate at all. Red with the
    // empty-`commands` branch removed: the section then renders as a bare
    // heading, which reads identically to "the gates ran and none failed".
    const noGateRoot = scratchDir(".test-landing-gates-none");
    const noGateArtifacts = join(noGateRoot, ".audit-tools", "remediation");
    await rm(noGateRoot, { recursive: true, force: true });
    await mkdir(noGateArtifacts, { recursive: true });
    try {
      const state = makeState();
      await runClosePhase(state, {
        root: noGateRoot,
        artifactsDir: noGateArtifacts,
        landingGateVerifyOverrides: {
          run: async () => {
            throw new Error("no gate may be spawned when none is declared");
          },
        },
      });

      const report = readFileSync(
        join(noGateRoot, ".audit-tools", "remediation-report.md"),
        "utf8",
      );
      expect(report).toMatch(/## Landing Gates/);
      expect(report).toMatch(/No landing gates were discovered/);
    } finally {
      await rm(noGateRoot, { recursive: true, force: true });
    }
  });

  it("runs EVERY discovered gate once, in discovery order", async () => {
    // The leg runs the whole discovered set, not its first element. Red with
    // `for (const command of commands)` narrowed to `commands.slice(0, 1)`: the
    // second declared gate never reaches the runner, and a red `check:depgraph`
    // on a two-gate repository would be reported as a clean landing.
    await writeFile(
      join(REPO_DIR, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          scripts: { "check:depgraph": "depcruise src", "check:lint": "eslint ." },
        },
        null,
        2,
      ),
      "utf8",
    );
    const state = makeState();
    const leg = stubbedLeg({ passed: true });
    await runClosePhase(state, {
      ...BASE_OPTIONS,
      landingGateVerifyOverrides: leg.overrides,
    });

    // `discoverLandingGates` emits in the vocabulary's role order — depgraph
    // before lint — so the expectation is the discovered order, not the order
    // the fixture happens to declare the scripts in.
    expect(leg.verified, "each discovered gate runs exactly once").toEqual([
      ["npm", "run", "check:depgraph"],
      ["npm", "run", "check:lint"],
    ]);
  });

  it("runs the REAL default runner — a gate that outlives the bound is red, never silently green", async () => {
    // ⚠ THE ONE TEST THAT SPAWNS FOR REAL. Every other test in this block
    // injects `landingGateVerifyOverrides.run`, which is exactly why none of
    // them pins the production branch: the default
    // `runAdmittedProjectLandingGateCommand` would be reached by no test at all
    // and could stop applying its timeout bound without one red. Nothing here
    // spawns directly — this calls the leg with NO overrides and the leg spawns.
    //
    // A caller-supplied `timeoutMs` smaller than the script's own runtime is the
    // only observable difference the admission path's bound makes over a raw
    // spawn: without the bound the call never returns, so the test times out;
    // with a throwing stand-in, the call rejects instead of resolving to the
    // bounded verdict below.
    //
    // It gets its OWN root rather than reusing `REPO_DIR`: a killed child can
    // hold a directory handle on this platform for a moment, and the shared
    // `beforeEach` `rm` — or the next test's — would then fail with EBUSY on a
    // directory this test never meant to own.
    const realRoot = scratchDir(".test-landing-gates-real");
    await rm(realRoot, { recursive: true, force: true });
    await mkdir(realRoot, { recursive: true });
    await writeFile(
      join(realRoot, "package.json"),
      JSON.stringify(
        { name: "fixture", scripts: { "check:lint": "node -e \"setTimeout(() => {}, 30000)\"" } },
        null,
        2,
      ),
      "utf8",
    );

    try {
      // The deadline is 2/3 of the script's runtime, deliberately. `npm run` on
      // an admitted vector is the `cmd.exe` shim `resolveExecArgv` produces, so
      // npm sits between the leg and the script: a deadline close to the
      // runtime lets npm's own startup jitter decide whether the timer fires at
      // all, and this test would then be asserting the machine's speed rather
      // than the bound.
      const outcome = await verifyLandingGates({
        root: realRoot,
        timeoutMs: 5500,
      });

      expect(outcome.gates.length, "exactly the one declared gate ran").toBe(1);
      expect(outcome.passed, "a gate that did not finish is not green").toBe(false);
      expect(outcome.gates[0].command).toBe("npm run check:lint");
      // The report names the BOUND, which is the fact the admission path adds
      // over a raw spawn. WHICH of its two messages carries the bound is
      // deliberately not asserted. On win32 the admitted vector is a `cmd.exe`
      // shim, so SIGTERM kills the shell and leaves npm/node holding the
      // inherited pipe: the direct child then either survives the grace (the
      // runner's own terminal-settle message, via `spawn_error`) or its `close`
      // lands late and the leg's canonical line renders instead. Both name the
      // deadline in milliseconds, and pinning one would assert this platform's
      // kill semantics rather than the leg's contract.
      expect(
        `${outcome.gates[0].spawn_error ?? ""}\n${outcome.gates[0].output}`,
        "the verdict must name the deadline it enforced",
      ).toMatch(/5500ms/);
    } finally {
      // Retried, not a bare `rm`: this is the one root in this file whose child
      // is kill-eligible, and the killed grandchild can hold the directory
      // handle for a while after the close the leg resolved on. The settle
      // branch deliberately does not wait for that grandchild (it may never
      // exit at all — that is the whole reason the branch exists), so the wait
      // belongs HERE, where it cannot bind the leg. A cleanup failure is also
      // not an assertion failure: `rm` below is `force: true` and the run root
      // is per-invocation, so a surprise leaves residue, never a red.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          await rm(realRoot, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
  }, 40000);

  it("reports a gate that could not be spawned as RED, never as a silent pass", async () => {
    // R3: "a gate that could not run is not silently green." A refusal is the
    // one outcome where the gate's exit code is meaningless — nothing ran — so
    // a `passed` computed from the exit code alone reads a refused gate as a
    // clean landing and deletes the artifacts dir on a tree no gate ever
    // checked. Red with `outcome.admitted &&` dropped from `passed`.
    const state = makeState();
    await runClosePhase(state, {
      ...BASE_OPTIONS,
      landingGateVerifyOverrides: {
        run: async () => ({
          admitted: false,
          refusal_reason: "refused by admission",
          exit_code: 0,
          timed_out: false,
          truncated: false,
          output: "",
        }),
      },
    });

    expect(existsSync(TEST_DIR), "a gate that did not run must preserve the tree").toBe(true);
    const report = readFileSync(join(OUTPUT_DIR, "remediation-report.md"), "utf8");
    expect(report).toMatch(/## Landing Gates/);
    expect(report).toMatch(/FAILED/);
    expect(report).toContain("refused by admission");
  });
});
