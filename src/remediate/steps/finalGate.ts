// ---------------------------------------------------------------------------
// Tool-owned final completion gate (INV-RS-10)
// ---------------------------------------------------------------------------
//
// The gate runner and its red record. A whole-repo gate red is UNATTRIBUTABLE
// by construction — nothing here computes which item or path caused it — so the
// only honest response is to record what failed and PAUSE. It does not mutate
// item statuses, does not move the run's phase, and does not close: a repeat
// next-step re-runs the gate and proceeds the moment it is green, which makes
// the pause resumable by construction rather than by a stored counter.
//
// This replaces a coarse backstop that re-opened EVERY non-skip item to
// `pending` on a red and, after a bounded number of tries, abandoned the whole
// run. It fired on 2026-08-20 against a suite reddened by an unrelated landed
// commit and wiped 21 accepted resolutions out of state.json — the failure the
// "Phase-boundary gate false abandonment" entry predicted, doing maximum damage
// on a red that had nothing to do with the run.
//
// INV-RS-10: the final completion gate is a TOOL-OWNED, NON-VACUOUS suite that
// is INDEPENDENT of any `plan.test_command`. A run can only land green when this
// suite passes; a vacuous/unset `plan.test_command` can never substitute for it.
// The suite is executed through the env-scrubbing `runTracked`, which strips
// CLAUDECODE / CLAUDE_CODE_* so the gate runs in a clean environment
// regardless of the host session.
//
// Hard floor (always run, in order — single package, single-flight build — CE-001):
//   1. npm run build                          (one tsc build for the whole package)
//   2. npm run check                          (typecheck, no emit)
//   3. BUILD-FREE unit suites at the repo root, each invoked directly so dist is
//      never rebuilt or raced:
//        - shared+audit:  node --import tsx/esm --test tests/shared/*.test.mjs tests/audit/*.test.mjs
//        - remediate-code: npx vitest run
//
// CE-002: the hard floor is scoped to build + typecheck + unit. The
// runtime/packaged-bin smoke surface (the `verify:release` smokes) is recorded
// as a DECLARED RESIDUAL the floor does not gate, rather than run inline — the
// packaged-bin smokes are the known Windows-flaky / EPERM surface and an in-loop
// gate must converge deterministically, so they are surfaced for a separate
// pass instead of being able to strand the run.

import { join } from "node:path";
import { writeJsonFile, runTracked } from "audit-tools/shared";
// Deep import: the CDC-25-era exports of the shared outcome contract are not yet
// re-exported through the `audit-tools/shared` barrel (outside this work item's
// allowed_files) — the same note `close.ts` and `state/types.ts` carry.
import type { FinalGateOutcomeKind as SharedFinalGateOutcomeKind } from "../../shared/types/remediationOutcome.js";
import {
  isAuditToolsMonorepo,
  toolOwnedFinalGateCommands,
  type FinalGateCommandSpec,
} from "./gateCommands.js";

// `FinalGateCommandSpec`, `isAuditToolsMonorepo`, and `toolOwnedFinalGateCommands`
// are single-sourced in the leaf module `gateCommands.ts` (so `dispatch.ts` can
// derive the same pinned merged-base check without an import cycle). Imported
// here for local use and re-exported to preserve the public surface + test imports.
export { isAuditToolsMonorepo, toolOwnedFinalGateCommands };
export type { FinalGateCommandSpec };

/** A command's recorded outcome within a gate run. */
export interface FinalGateCommandResult {
  argv: string[];
  layer: FinalGateCommandSpec["layer"];
  package_dir?: string;
  exit_code: number | null;
  passed: boolean;
  /**
   * Trailing slice of what the command printed, present only on a FAILING
   * command. The gate used to capture output and drop it on the floor — a red
   * arrived as an exit code and nothing to read, so the one artifact that could
   * explain it never existed. Bounded here at the source
   * ({@link GATE_OUTPUT_TAIL_LIMIT}): a whole suite log must not ride into a
   * state artifact, and the tail is where a failing suite puts its verdict.
   */
  stdout_tail?: string;
  stderr_tail?: string;
}

/**
 * How a gate EVALUATION ended — one vocabulary, used by every gate family that
 * runs this floor, so the three are never told apart by prose or by inference
 * from a bare boolean.
 *
 * DECLARED IN THE SHARED BASE LAYER ({@link SharedFinalGateOutcomeKind} in
 * `src/shared/types/remediationOutcome.ts`) and re-exported here for the local
 * name. A second copy declared in this module would be a second vocabulary for
 * the same three outcomes, which is the defect this record exists to close.
 *
 * `executed`   — the command list ran; `passed` is a real verdict.
 * `scoped_out` — the audit-tools-specific suite does not apply to this target,
 *                so zero commands ran.
 * `disabled`   — a gate was DUE and did not run. TWO distinct causes, both
 *                recorded with this kind and told apart by the record's
 *                `reason`: (1) SUPPRESSED — the `skipFinalGate` hermeticity
 *                option or the `REMEDIATE_SKIP_FINAL_GATE` environment skip,
 *                which never reach {@link runToolOwnedFinalGate} at all, and
 *                (2) NO SUBJECT — the all-terminal funnel found nothing
 *                verified-complete to validate, so it skipped the floor and
 *                went straight to `closing`. The second is the easiest to
 *                misread as a green close, because a run with zero resolved
 *                items still writes a completion report.
 *
 * The two not-run kinds are not verdicts. A record for either carries
 * `passed: null` (see {@link FinalGateOutcomeRecord}), so a gate that ran
 * nothing can never be PERSISTED as a pass — the distinction the boolean alone
 * could not carry.
 */
export type FinalGateOutcomeKind = SharedFinalGateOutcomeKind;

export interface ToolOwnedFinalGateResult {
  passed: boolean;
  results: FinalGateCommandResult[];
  /**
   * Which of the two REACHABLE outcome kinds this run was. `disabled` never
   * appears here — a disabled gate returns before the runner is consulted — so
   * its record is written by the consumer that suppressed it.
   */
  outcome: Exclude<FinalGateOutcomeKind, "disabled">;
  /**
   * True when the audit-tools-specific suite did not apply (target is not the
   * audit-tools monorepo). The gate then does not block; it is a declared scope,
   * not a vacuous pass. Kept alongside {@link outcome} as the boolean draw of
   * the same fact for the branches that only need "did anything run".
   */
  scoped_out: boolean;
  /**
   * The runtime/packaging surface the hard floor does NOT gate, declared as a
   * residual for a separate pass (CE-002). Always present (the floor is scoped
   * to build+check+unit by design).
   */
  runtime_residual: { surface: string; commands: string[] };
}

/**
 * Injectable runner so the gate is unit-testable without spawning a real build.
 *
 * `stdout` / `stderr` are OPTIONAL so an injected runner that only reports a
 * status stays valid — the gate degrades to "no output captured" rather than
 * refusing a runner that predates output capture.
 */
export type GateRunner = (
  argv: string[],
  cwd: string,
  packageDir?: string,
) => { status: number | null; stdout?: string; stderr?: string };

/**
 * How much of a failing command's output rides into the persisted record. TAIL,
 * because a suite prints its verdict last, and BOUNDED because this lands in a
 * durable artifact — the standing rule against multi-KB tool output riding into
 * a prompt applies to what a prompt POINTS AT as well.
 */
const GATE_OUTPUT_TAIL_LIMIT = 4_000;

function outputTail(value: string | undefined): string | undefined {
  const text = value ?? "";
  if (text.length === 0) return undefined;
  return text.length <= GATE_OUTPUT_TAIL_LIMIT
    ? text
    : `…${text.slice(text.length - GATE_OUTPUT_TAIL_LIMIT)}`;
}

/**
 * Run the tool-owned final gate (INV-RS-10). Each command runs through the
 * shared `runTracked`, which scrubs CLAUDECODE / CLAUDE_CODE_*.
 * The first failing command short-circuits the floor (a broken build makes the
 * later layers meaningless). A `runner` may be injected for tests. When the
 * audit-tools suite does not apply (non-monorepo target), the gate is
 * `scoped_out` (does not block) rather than vacuously passing.
 */
export async function runToolOwnedFinalGate(
  root: string,
  opts: { runner?: GateRunner } = {},
): Promise<ToolOwnedFinalGateResult> {
  const runtime_residual = {
    surface: "runtime/packaged-bin smokes (verify:release)",
    commands: [
      "npm run smoke:packaged-audit-code",
      "npm run smoke:packaged-remediate-code",
    ],
  };

  const commands = toolOwnedFinalGateCommands(root);
  if (commands.length === 0) {
    // Audit-tools-specific suite does not apply here — declared scope, not a
    // vacuous pass (it never substitutes for a real gate on the audit-tools repo).
    // `passed: true` keeps it NON-BLOCKING, which is the declared design; the
    // `outcome` beside it is what stops that non-blocking value from being
    // recorded as if a floor had run green.
    return {
      passed: true,
      results: [],
      outcome: "scoped_out",
      scoped_out: true,
      runtime_residual,
    };
  }

  const runner: GateRunner =
    opts.runner ??
    ((argv, cwd, packageDir) => {
      const [command, ...args] = argv;
      // Package-scoped unit suites run with cwd at the package (no `npm -w`); the
      // monorepo-root build/check commands run at the repo root.
      const effectiveCwd = packageDir ? join(root, packageDir) : cwd;
      // runTracked strips CLAUDECODE / CLAUDE_CODE_* (INV-RS-10).
      const result = runTracked([command, ...args], {
        cwd: effectiveCwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // `runTracked` has always returned the captured streams; this used to read
      // `status` alone and discard them, which is why a red gate persisted
      // nothing an operator could read.
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    });

  const results: FinalGateCommandResult[] = [];
  let passed = true;
  for (const spec of commands) {
    const { status, stdout, stderr } = runner(spec.argv, root, spec.package_dir);
    const cmdPassed = status === 0;
    const stdoutTail = cmdPassed ? undefined : outputTail(stdout);
    const stderrTail = cmdPassed ? undefined : outputTail(stderr);
    results.push({
      argv: spec.argv,
      layer: spec.layer,
      ...(spec.package_dir ? { package_dir: spec.package_dir } : {}),
      exit_code: status,
      passed: cmdPassed,
      ...(stdoutTail === undefined ? {} : { stdout_tail: stdoutTail }),
      ...(stderrTail === undefined ? {} : { stderr_tail: stderrTail }),
    });
    if (!cmdPassed) {
      passed = false;
      break; // short-circuit: later layers are meaningless on a broken floor
    }
  }

  return {
    passed,
    results,
    outcome: "executed",
    scoped_out: false,
    runtime_residual,
  };
}

const FINAL_GATE_STATE_FILENAME = "final-gate.json";
const FINAL_GATE_OUTCOME_FILENAME = "final-gate-outcome.json";

/**
 * Where the failing gate run is recorded, relative to the artifacts dir. The
 * step prompt carries this PATH and the failing command line — never the tail
 * itself, which is what keeps a multi-KB suite log out of the prompt while
 * still leaving it one open away.
 */
export function finalGateRecordPath(artifactsDir: string): string {
  return join(artifactsDir, FINAL_GATE_STATE_FILENAME);
}

/**
 * Where the LAST gate evaluation's outcome is recorded, relative to the
 * artifacts dir. Distinct from {@link finalGateRecordPath}, which only exists
 * when a gate ran and went RED: this one is written on EVERY evaluation,
 * including the two that run nothing.
 */
export function finalGateOutcomePath(artifactsDir: string): string {
  return join(artifactsDir, FINAL_GATE_OUTCOME_FILENAME);
}

/**
 * The ONE gate-outcome record. Every gate family that runs this floor writes
 * this shape, with these field names, so an executed, a scoped-out and a
 * disabled gate are three DISTINGUISHABLE records rather than three identical
 * "passed" notes.
 *
 * `passed` is `boolean | null` on purpose. The two not-run kinds carry `null`:
 * a gate that ran zero commands has no verdict, and a record that cannot hold
 * `true` for it is the mechanical reason a not-run gate can never be read back
 * as a green floor. (`ToolOwnedFinalGateResult.passed` stays a plain boolean
 * because it also drives the NON-BLOCKING decision — a scoped-out gate must not
 * block — and those are different questions: "may the run proceed" versus "what
 * actually happened".)
 */
export interface FinalGateOutcomeRecord {
  schema_version: "remediate-code-final-gate-outcome/v1alpha1";
  /** Which gate observed it — a phase boundary, or the all-terminal funnel. */
  scope: string;
  outcome: FinalGateOutcomeKind;
  /** The verdict, or null when the gate did not run. Never true for a not-run. */
  passed: boolean | null;
  /** How many commands actually ran. Zero for both not-run kinds. */
  commands_run: number;
  /** Why a not-run gate did not run. Absent on an executed gate. */
  reason?: string;
  recorded_at: string;
}

/**
 * Record what a gate evaluation was. Overwrites: the file describes the CURRENT
 * gate state of the run, the same way {@link writeFinalGateRedRecord} does for a
 * red, and a repeat next-step re-evaluates rather than accumulating a history
 * nothing reads.
 *
 * The `passed: null` normalization lives HERE rather than at each call site:
 * a caller cannot record a not-run gate as a pass even by passing `true`.
 */
export async function writeFinalGateOutcomeRecord(
  artifactsDir: string,
  outcome: {
    scope: string;
    outcome: FinalGateOutcomeKind;
    passed: boolean;
    commands_run: number;
    reason?: string;
  },
): Promise<string> {
  const path = finalGateOutcomePath(artifactsDir);
  const ran = outcome.outcome === "executed";
  const record: FinalGateOutcomeRecord = {
    schema_version: "remediate-code-final-gate-outcome/v1alpha1",
    scope: outcome.scope,
    outcome: outcome.outcome,
    passed: ran ? outcome.passed : null,
    commands_run: ran ? outcome.commands_run : 0,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    recorded_at: new Date().toISOString(),
  };
  await writeJsonFile(path, record);
  return path;
}

/**
 * What a RED gate leaves behind.
 *
 * This file used to hold a re-block counter and a `terminated` flag — the state
 * of a backstop that re-opened every item on an unattributable red and, at its
 * bound, abandoned the run. Both are gone: an unattributable red now records
 * what failed and pauses, so there is no count to carry and nothing to
 * terminate. (`terminated` had to go rather than merely stop being written: it
 * short-circuited the gate entirely, so a run that once reached the bound would
 * have skipped the suite check forever after.)
 */
export interface FinalGateRedRecord {
  schema_version: "remediate-code-final-gate/v1alpha1";
  /** Which gate observed the red — a phase boundary, or the all-terminal funnel. */
  scope: string;
  recorded_at: string;
  failing_command: string;
  exit_code: number | null;
  layer: FinalGateCommandSpec["layer"] | null;
  stdout_tail?: string;
  stderr_tail?: string;
}

/**
 * Record the failing command of a red gate run. Overwrites: the file describes
 * the CURRENT reason the run is paused, and a repeat next-step that still finds
 * the suite red rewrites it rather than accumulating a history nothing reads.
 */
export async function writeFinalGateRedRecord(
  artifactsDir: string,
  scope: string,
  failed: FinalGateCommandResult | undefined,
): Promise<string> {
  const path = finalGateRecordPath(artifactsDir);
  const record: FinalGateRedRecord = {
    schema_version: "remediate-code-final-gate/v1alpha1",
    scope,
    recorded_at: new Date().toISOString(),
    failing_command: failed ? failed.argv.join(" ") : "(command not reported)",
    exit_code: failed?.exit_code ?? null,
    layer: failed?.layer ?? null,
    ...(failed?.stdout_tail === undefined
      ? {}
      : { stdout_tail: failed.stdout_tail }),
    ...(failed?.stderr_tail === undefined
      ? {}
      : { stderr_tail: failed.stderr_tail }),
  };
  await writeJsonFile(path, record);
  return path;
}
