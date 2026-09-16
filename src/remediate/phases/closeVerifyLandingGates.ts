// sites-pinned: tests/remediate/landing-gates-close.test.ts
//   The close leg's discovery→spawn→verdict path (each gate run once, a red
//   gate not green) is pinned by that suite, which drives the real close. The
//   admission claim in the doc-comment below — that the gates go through the
//   SAME admission path the project-facts test and e2e commands use — is pinned
//   by "runs the REAL default runner", the one test in that file that passes NO
//   override and so reaches the default runner with its timeout bound.
import {
  discoverLandingGates,
  landingGateRefusal,
  runAdmittedProjectLandingGateCommand,
} from "audit-tools/shared";
import type { ProjectTestAdmissionOutcome } from "audit-tools/shared";
import { FAILURE_OUTPUT_TAIL_CHARS } from "./constants.js";

/**
 * THE LANDING-GATE CLOSE LEG.
 *
 * The per-item required tests are the block's own `targeted_commands`, which are
 * MODULE-SCOPED: a block that edits one module declares the command that
 * exercises that module. Three remediation landings reddened CI after green
 * per-item runs, each on a gate no module-scoped command covers — a hand-
 * restated `.audit-tools` literal caught only by the tree-wide path-guard suite
 * (`1e7a4a54`), a case-folding assertion true only on a case-insensitive volume
 * (`011c6ae0`), and an intra-`src/shared` import cycle `check:depgraph` refuses
 * (`b5963957`). So a landing must run the repository's landing gates too.
 *
 * ⚠ WHY THIS IS A CLOSE LEG AND NOT A PER-ITEM REQUIRED TEST — read this before
 * moving it back. `check:deadcode`, `check:depgraph`, lint and the id-glossary
 * gate state facts about the WHOLE tree, so the boundary that OWNS them is the
 * merged tree, which exists only after every item has landed. Folding them into
 * each item's `required_tests` (the first attempt) refused a wave item whose
 * added export had no consumer until a LATER item landed: no edit inside that
 * item's scope could make the gate pass, and another item's fault could refuse
 * this one. That is a gate guessing at a boundary owned by something else;
 * CLAUDE.md, *A gate states the boundary it OWNS* says move it to the boundary
 * that owns it. Precedent for the shape: {@link verifyAnalyzerLeads} is a
 * close-gate verify leg, never a `CLOSING_ACTIONS` entry.
 *
 * Discovery reads the TARGET repository's `package.json` scripts. This tool runs
 * against arbitrary repositories, so the gate set is never baked in; a
 * repository with another build system contributes no gate at all and the report
 * says so.
 */

export interface LandingGateOutcome {
  /**
   * The gate command, as discovered. Empty when the repository declares none —
   * in which case `ran` is false and the report states the absence.
   */
  command: string;
  /** The one-line statement of what the gate refuses (from the shared vocabulary). */
  refuses: string | null;
  passed: boolean;
  /**
   * Tail of the gate's combined output, populated only on failure. Bounded by
   * `FAILURE_OUTPUT_TAIL_CHARS` — the same bound the combined-suite and e2e legs
   * use, so no one leg can flood the report.
   */
  output: string;
  /** True when the gate could not be SPAWNED or was refused admission. */
  spawn_error?: string;
}

export interface LandingGateVerifyOutcome {
  /** The discovered gate commands, in the vocabulary's role order. */
  commands: string[];
  /** One result per discovered gate. Empty when `commands` is empty. */
  gates: LandingGateOutcome[];
  /**
   * False when the gate ran and exited 0. Vacuously true for a repository that
   * declares no landing gate — the same "never-ran is not a red" rule
   * `CombinedTestResult.passed` follows, and `commands` being empty is what
   * tells a reader the difference.
   */
  passed: boolean;
}

/** Test-injectable seam for the spawn; production passes nothing. */
export interface LandingGateVerifyOverrides {
  run?: (
    command: string[],
    root: string,
    options: { timeoutMs: number },
  ) => Promise<ProjectTestAdmissionOutcome>;
}

/**
 * Run each of the repository's declared landing gates ONCE on the merged tree
 * at `root`, through the SAME admission path the project-facts test and e2e
 * commands use — never a raw spawn. A landing gate is admitted iff
 * `discoverLandingGates(root)` emits it, exactly as a test/e2e command is
 * admitted iff `discoverProjectCommands(root)` emits it; a gate that discovery
 * did not emit is REFUSED, never run.
 *
 * Sequential, not concurrent: these are release gates whose failures are read
 * together, and running them in parallel would interleave their output tails
 * into an unreadable report while multiplying peak memory.
 */
export async function verifyLandingGates(params: {
  root: string;
  timeoutMs: number;
  overrides?: LandingGateVerifyOverrides;
}): Promise<LandingGateVerifyOutcome> {
  const { root, timeoutMs } = params;
  const run = params.overrides?.run ?? runAdmittedProjectLandingGateCommand;
  const commands = discoverLandingGates(root);
  if (commands.length === 0) {
    return { commands, gates: [], passed: true };
  }

  const gates: LandingGateOutcome[] = [];
  for (const command of commands) {
    const outcome = await run(command.split(" "), root, { timeoutMs });
    const passed =
      outcome.admitted && outcome.exit_code === 0 && !outcome.timed_out && !outcome.spawn_error;
    gates.push({
      command,
      refuses: landingGateRefusal(command),
      passed,
      output: passed
        ? ""
        : (outcome.spawn_error ?? outcome.output).trim().slice(-FAILURE_OUTPUT_TAIL_CHARS) ||
          (outcome.timed_out
            ? `landing gate timed out after ${timeoutMs}ms`
            : "landing gate failed without output"),
      ...(outcome.admitted ? {} : { spawn_error: outcome.refusal_reason ?? "refused" }),
    });
  }

  return { commands, gates, passed: gates.every((gate) => gate.passed) };
}
