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
// The suite is executed through the env-scrubbing `runTracked` (the async twin),
// whose `stripAuditToolsControlEnv` drops exactly ONE variable —
// `AUDIT_TOOLS_CALLER_CWD`, the wrapper's one-hop caller-cwd stamp. It does NOT
// strip CLAUDECODE / CLAUDE_CODE_*, so the gate's environment is the host's; what
// the scrub guarantees is that a child cannot read the parent's location as its
// own, not that the child is session-free.
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
import {
  discardOnSchemaVersionMismatch,
  readOptionalJsonFile,
  writeJsonFile,
  runTrackedAsync,
} from "audit-tools/shared";
// Deep import: the CDC-25-era exports of the shared outcome contract are not yet
// re-exported through the `audit-tools/shared` barrel (outside this work item's
// allowed_files) — the same note `close.ts` and `state/types.ts` carry.
import {
  carriesGateVerdict,
  type FinalGateOutcomeKind as SharedFinalGateOutcomeKind,
} from "../../shared/types/remediationOutcome.js";
import {
  attributeGateRed,
  isAuditToolsMonorepo,
  toolOwnedFinalGateCommands,
  type FinalGateCommandSpec,
  type GateRedAttribution,
  type RemediationGateState,
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
 *
 * MAY RETURN A PROMISE. The default runner is async (see
 * {@link runToolOwnedFinalGate}) and the gate awaits whatever it gets, so both
 * an old synchronous stub and a new async one are valid; the widening is
 * structural, not a second code path.
 */
export type GateRunner = (
  argv: string[],
  cwd: string,
  packageDir?: string,
) =>
  | { status: number | null; stdout?: string; stderr?: string }
  | Promise<{ status: number | null; stdout?: string; stderr?: string }>;

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
 * The runtime/packaging surface the hard floor does NOT gate (CE-002), declared
 * as a residual for a separate pass. A CONSTANT rather than a literal built per
 * run, because a verdict served from the cache has to carry the same declaration
 * a fresh run would — the residual is a property of the floor, not of the
 * evaluation that happened to observe it.
 */
export const RUNTIME_RESIDUAL_DECLARATION: ToolOwnedFinalGateResult["runtime_residual"] =
  {
    surface: "runtime/packaged-bin smokes (verify:release)",
    commands: [
      "npm run smoke:packaged-audit-code",
      "npm run smoke:packaged-remediate-code",
    ],
  };

/**
 * Run the tool-owned final gate (INV-RS-10). Each command runs through the
 * shared async `runTrackedAsync`, which scrubs the wrapper's
 * `AUDIT_TOOLS_CALLER_CWD` stamp (and nothing else — see `finalGate.ts`'s file
 * header; the host's session variables reach the child unchanged).
 * The first failing command short-circuits the floor (a broken build makes the
 * later layers meaningless). A `runner` may be injected for tests. When the
 * audit-tools suite does not apply (non-monorepo target), the gate is
 * `scoped_out` (does not block) rather than vacuously passing.
 */
export async function runToolOwnedFinalGate(
  root: string,
  opts: { runner?: GateRunner } = {},
): Promise<ToolOwnedFinalGateResult> {
  const runtime_residual = RUNTIME_RESIDUAL_DECLARATION;

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
    (async (argv, cwd, packageDir) => {
      const [command, ...args] = argv;
      // Package-scoped unit suites run with cwd at the package (no `npm -w`); the
      // monorepo-root build/check commands run at the repo root.
      const effectiveCwd = packageDir ? join(root, packageDir) : cwd;
      // runTrackedAsync strips AUDIT_TOOLS_CALLER_CWD, the wrapper's one-hop
      // caller-cwd stamp (INV-RS-10) — it does not clear the host session's
      // own variables, and this comment used to claim it did.
      //
      // ASYNC, and this one is a liveness requirement rather than a style
      // choice. The phase-boundary gate runs INLINE inside `advanceUnderPhaseLock`,
      // with `<artifactsDir>/phase.lock` HELD, and the floor's unit leg is a whole
      // vitest run — minutes. A synchronous child blocks the event loop for its
      // entire duration, so the lock's `setInterval` mtime heartbeat cannot fire
      // and a LIVE lock reads as stale to the next acquirer, which steals it out
      // from under the run mid-gate (the CP-NODE-5 lock-hazard class; the same
      // reason every closing spawn is awaited). Awaiting keeps the loop turning
      // for the whole suite.
      const result = await runTrackedAsync([command, ...args], {
        cwd: effectiveCwd,
        // Declared bound: full suites legitimately run minutes; one hour is a
        // bound, not a budget — it guards only against a child that never exits.
        timeout: 3_600_000,
      });
      // The captured streams are returned, not just the status: a red gate that
      // persisted nothing an operator could read was the defect this carries.
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    });

  const results: FinalGateCommandResult[] = [];
  let passed = true;
  for (const spec of commands) {
    // `await` is correct for an injected synchronous runner too — awaiting a
    // non-promise yields the value unchanged — so a stub needs no migration.
    const { status, stdout, stderr } = await runner(spec.argv, root, spec.package_dir);
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
const FINAL_GATE_VERDICT_FILENAME = "final-gate-verdict.json";
const FINAL_GATE_VERDICT_VERSION = "remediate-code-final-gate-verdict/v1alpha1";

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
 * A gate verdict bound to the CONTENT it was reached on.
 *
 * The gate is a whole-repo floor that legitimately runs minutes, and it sits at
 * a PHASE BOUNDARY the fold re-enters on every `next-step` taken before the next
 * phase dispatches. Without this record each of those calls re-ran it end to end
 * (the backlog entry), which is both the cost and the hazard: the phase lock is
 * held for the whole run.
 *
 * `passed: false` is cached exactly as `true` is, deliberately. The verdict is
 * about the TREE, not about the run's progress, so a second call on an unchanged
 * tree has to reach the same answer either way — and the honest way to make a
 * red reach its pause again is to READ the cached verdict and emit the pause,
 * not to re-spawn a suite to learn what is already known. `commands_run` and
 * `results` ride along so the red record (the failing command, its exit code,
 * its output tail) is rebuilt from the cache byte-identically.
 *
 * `tree` is a content id ({@link worktreeContentId}) or `null` for "cannot
 * tell", in which case the record is still written (the OUTCOME artifact must
 * describe what happened) but nothing may ever be served from it.
 */
export interface FinalGateVerdictRecord {
  schema_version: "remediate-code-final-gate-verdict/v1alpha1";
  /** The scope the floor ran at — a phase boundary, or the all-terminal funnel. */
  scope: string;
  /** The tree content id this verdict is about; `null` when it could not be taken. */
  tree: string | null;
  /** The verdict, as evaluated. A red is cached as readily as a green. */
  passed: boolean;
  /** Whether the audit-tools suite applied to this target. */
  scoped_out: boolean;
  outcome: Exclude<FinalGateOutcomeKind, "disabled">;
  /** The per-command results the red record is rebuilt from. */
  results: FinalGateCommandResult[];
  recorded_at: string;
}

/**
 * Where the {@link FinalGateVerdictRecord} lives. ONE file, overwritten: it
 * describes the LAST evaluation, and a run has one boundary at a time. Never a
 * history — an accumulating cache would grow a log nothing reads.
 */
export function finalGateVerdictPath(artifactsDir: string): string {
  return join(artifactsDir, FINAL_GATE_VERDICT_FILENAME);
}

/**
 * Read the cached verdict for `scope`, or `undefined` when there is none to
 * serve: absent, unreadable, unparseable, written by a different record version,
 * for a different scope, or about a different (or unknown) tree.
 *
 * Every one of those degrades to "run the floor", which is the safe direction —
 * a cache miss costs a gate run, a false hit certifies a tree nobody checked.
 * Never throws.
 */
export async function readFinalGateVerdict(
  artifactsDir: string,
  scope: string,
  tree: string | null,
): Promise<FinalGateVerdictRecord | undefined> {
  if (tree === null) return undefined;
  const raw = await readOptionalJsonFile<FinalGateVerdictRecord>(
    finalGateVerdictPath(artifactsDir),
  ).catch(() => undefined);
  const record = discardOnSchemaVersionMismatch(raw, FINAL_GATE_VERDICT_VERSION);
  if (record === undefined || record === null) return undefined;
  if (record.scope !== scope) return undefined;
  if (record.tree === null || record.tree !== tree) return undefined;
  if (!Array.isArray(record.results)) return undefined;
  return record;
}

/**
 * Record a gate verdict against the tree it was reached on. Overwrites.
 *
 * TWO ARTIFACTS, ONE ANSWER: the caller writes {@link writeFinalGateOutcomeRecord}
 * from the same values, so the outcome artifact and this cache can never disagree
 * about whether a floor ran and what it said.
 */
export async function writeFinalGateVerdict(
  artifactsDir: string,
  verdict: {
    scope: string;
    tree: string | null;
    passed: boolean;
    scoped_out: boolean;
    outcome: Exclude<FinalGateOutcomeKind, "disabled">;
    results: FinalGateCommandResult[];
  },
): Promise<string> {
  const path = finalGateVerdictPath(artifactsDir);
  const record: FinalGateVerdictRecord = {
    schema_version: FINAL_GATE_VERDICT_VERSION,
    scope: verdict.scope,
    tree: verdict.tree,
    passed: verdict.passed,
    scoped_out: verdict.scoped_out,
    outcome: verdict.outcome,
    results: verdict.results,
    recorded_at: new Date().toISOString(),
  };
  try {
    await writeJsonFile(path, record);
  } catch {
    // Best-effort in the same direction the read is safe: a verdict that cannot
    // be persisted costs the NEXT call a re-run, and never corrupts this one.
  }
  return path;
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
  const ran = carriesGateVerdict(outcome.outcome);
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
  /**
   * Which paths the red implicates, and whether any of them belong to the RUN.
   * See {@link GateRedAttribution} — the whole point is the `verdict`: a red
   * whose failing paths are all FOREIGN is this run reporting as a failure some
   * dirt it never touched (a commit that landed alongside it is enough), and
   * before this record existed that was indistinguishable from the run's own
   * breakage.
   */
  attribution?: GateRedAttribution;
}

/**
 * Record the failing command of a red gate run. Overwrites: the file describes
 * the CURRENT reason the run is paused, and a repeat next-step that still finds
 * the suite red rewrites it rather than accumulating a history nothing reads.
 *
 * `root` and `state` are what attribution reads; both are optional so a caller
 * that has no state (or a test asserting the record's shape alone) still gets a
 * valid record, degraded to no attribution rather than a refusal. The tail that
 * is SCANNED is the same tail that is PERSISTED — never the whole suite log,
 * which the record deliberately does not carry.
 */
export async function writeFinalGateRedRecord(
  artifactsDir: string,
  scope: string,
  failed: FinalGateCommandResult | undefined,
  attributionInput?: { root: string; state: RemediationGateState },
): Promise<string> {
  const path = finalGateRecordPath(artifactsDir);
  let attribution: GateRedAttribution | undefined;
  if (attributionInput && failed) {
    // Never let the diagnostic take down the gate: attribution is derived from
    // git and the filesystem, and a red gate on a broken tree is exactly when
    // those can misbehave. A failure to attribute is "no verdict", not a throw
    // that replaces the red record with a crash.
    attribution = await attributeGateRed({
      root: attributionInput.root,
      state: attributionInput.state,
      output: `${failed.stdout_tail ?? ""}\n${failed.stderr_tail ?? ""}`,
    }).catch(() => undefined);
  }
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
    ...(attribution === undefined ? {} : { attribution }),
  };
  await writeJsonFile(path, record);
  return path;
}
