import { recoverIngestHostResults } from "./steps/recoverIngest.js";
// sites-pinned: tests/remediate/recover-verb-branches.test.ts
// (the
// ACCEPTED-WITH-ISSUES arm — its status token and exit code)
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { changeOperatorLifecycle, decideNextStep } from "./steps/nextStep.js";
import { validateArtifacts } from "./validation/artifacts.js";
import { PlanSubmissionSchema, CritiqueSchema, CriticSchema, PlanJudgeSchema, executionPlanIssues, readPlanSource } from "./contractPipeline/executionPlan.js";
import { StateStore } from "./state/store.js";
import type { ValidationIssue } from "audit-tools/shared";
import {
  assertCliCommandAllowedFromCwd,
  callerWorkingDirectory,
  discoverRepoRoot,
  remediationArtifactsDir,
  resolveRepoRoot,
  invalidateStepContracts,
  recoverSubmission,
  runTracked,
  runWithBlockedStepBackstop,
} from "audit-tools/shared";
import { writeBlockedStep } from "./steps/stepWriter.js";
import { remediationSubmissionBinding } from "./steps/dispatch/hostHandoff.js";
import { type RemediationHostIngestSummary } from "./steps/dispatch/hostContracts.js";

// src/remediate/index.ts (source) or dist/remediate/index.js (built) → three
// dirnames up is the package root, holding package.json + skills/ + opencode.json.
const pkgRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { version: pkgVersion } = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
) as { version: string };

// opencode.json is optional package data (shipped with the package). Read it
// best-effort so a missing/unshipped config can never crash the CLI on startup —
// default to no extra permissions instead.
const program = new Command();

program
  .name("remediate-code")
  .description("Autonomous remediation orchestrator")
  .version(pkgVersion);

/**
 * The ONE `--root` help string, shared by every command that declares the
 * option. Five hand-kept copies of the same sentence is the duplication tell:
 * they drift one at a time, and `--help` then documents the same flag
 * differently depending on which subcommand the operator asked.
 *
 * Note what it does NOT say: there is no literal default. See
 * `resolveRootOption` for the two arms the absent value takes.
 */
const ROOT_OPTION_DESCRIPTION =
  "Repository root (default: the repository the working directory is in — the nearest ancestor owning .audit-tools/ or .git). " +
  "Pass it only to target a repository you are not inside, or a sub-project inside a larger one.";

/**
 * Worker-safe subcommands: the only commands a dispatched worker may run from
 * inside a tool-created node worktree (result-scoped validators — nothing that
 * touches shared run state). Every OTHER command — including any future one —
 * is refused from a node-worktree cwd by the preAction guard below: deny by
 * default, so a new lifecycle command is never silently exposed to worker
 * context (backlog "shared-state clobber from node context", live 2026-07-22).
 */
const WORKER_SAFE_COMMANDS: ReadonlySet<string> = new Set([
  "validate-artifacts",
  "validate-artifact",
  "validate",
]);

program.hook("preAction", (_thisCommand, actionCommand) => {
  const opts = actionCommand.opts() as { root?: string };
  assertCliCommandAllowedFromCwd({
    cliName: "remediate-code",
    commandName: actionCommand.name(),
    workerSafeCommands: WORKER_SAFE_COMMANDS,
    // Raw --root, pre-resolveRepoRoot: the anchoring climb erases the
    // worktree evidence, so the guard must see the unanchored value.
    rawRoot: opts.root,
  });
});

program
  .command("next-step")
  .option("--plan-only", "Finish planning, then persist a pause before implementation")
  .description("Write and print one backend-rendered remediation step")
  .option("--verification-command <command>", "Operator-approved test command for this run; declared build/typecheck/lint checks remain")
  .option("--root <path>", ROOT_OPTION_DESCRIPTION)
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".audit-tools/remediation",
  )
  // Repeatable: each `--input <path>` accumulates into a string[] via a collect
  // reducer (NOT a variadic `<path...>`, which would greedily swallow following
  // tokens). A single `--input` still yields `["<path>"]`; downstream
  // `inputValues`/`resolveInputPaths` normalize the one-vs-many shape and the
  // source manifest is the first-wins-deduped union of the resolved paths.
  .option(
    "--input <path>",
    "Path to audit report or feedback document (repeatable; unioned into intake)",
    // Accumulator defaults to []; guard against an undefined `previous` so the
    // first occurrence starts the array cleanly even if the default was cleared.
    (value: string, previous: string[] | undefined) =>
      (previous ?? []).concat([value]),
    [] as string[],
  )
  .option("--severity <level>", "Select this audit severity (repeatable; unioned with --finding-id)",
    (value: string, previous: string[] | undefined) => [...(previous ?? []), value])
  .option("--finding-id <id>", "Select this audit finding ID (repeatable; unioned with --severity)",
    (value: string, previous: string[] | undefined) => [...(previous ?? []), value])
  .option("--guidance <text>", "Use conversational feedback directly; the tool writes its canonical intake file")
  .option(
    "--guidance-file <path>",
    "Single-step bootstrap: write this file's contents to intake/conversation-start.md (sole, idempotent writer) before deciding the step",
  )
  .option(
    "--finalize-closing",
    "Finalize a closing remediation state from a generated close_run step",
  )
  .option(
    "--force-replan",
    "Rebuild the remediation plan from the existing intake artifacts",
  )
  .action(async (options) => {
    const root = resolveRootOption(options.root);
    const artifactsDir = resolveArtifactsDirOption(root, options.artifactsDir);
    // Terminal-exit backstop (backlog: abnormal-exit no-step-contract), the
    // remediate DRAW of the shared mechanism audit-code's cmdNextStep uses: any
    // throw below writes a blocked step naming the cause before propagating, so
    // a consumer can never read the previous current-step.json as a live
    // instruction after a fatal exit. Exit semantics unchanged.
    const step = await runWithBlockedStepBackstop(
      async () => {
        // Single-step bootstrap: fold the optional guidance file into
        // intake/conversation-start.md in this same invocation, then decide the
        // step — no separate write-then-call dance for the host to remember.
        return withBackendLogsOnStderr(() =>
          decideNextStep({
            root,
            artifactsDir,
            input: options.input,
            severity: options.severity,
            findingIds: options.findingId,
            guidanceFileSupplied: options.guidance !== undefined || Boolean(options.guidanceFile),
            guidanceText: options.guidance,
            guidanceFile: options.guidanceFile,
            planOnly: options.planOnly === true,
            finalizeClosing: options.finalizeClosing === true,
            verificationCommand: options.verificationCommand,
            forceReplan: options.forceReplan === true,
          }),
        );
      },
      (reason) => writeBlockedStep({ root, artifactsDir, reason }),
    );
    console.log(JSON.stringify(step, null, 2));
  });

for (const action of ["pause", "resume", "cancel"] as const) {
  program.command(action)
    .description(`${action} the persisted remediation run without changing accepted work or owning host worktrees`)
    .option("--root <path>", ROOT_OPTION_DESCRIPTION)
    .option("--artifacts-dir <path>", "Artifacts directory", ".audit-tools/remediation")
    .option("--worktree <path>", "Host-reported worktree location (metadata only)")
    .option("--outcome <text>", "Host-reported work outcome (metadata only)")
    .action(async (options) => {
      const root = resolveRootOption(options.root);
      const artifactsDir = resolveArtifactsDirOption(root, options.artifactsDir);
      const step = await changeOperatorLifecycle({
        root, artifactsDir, action,
        ...((options.worktree || options.outcome) ? { hostReport: {
          ...(options.worktree ? { worktree: options.worktree } : {}),
          ...(options.outcome ? { outcome: options.outcome } : {}),
        } } : {}),
      });
      console.log(JSON.stringify(step, null, 2));
    });
}

// The four installer verbs are intercepted by the remediate-code bin BEFORE the
// dist CLI is reached (`remediate-code.mjs` main), so nothing registered here can
// run them. `ensure` used to be registered WITH an action calling a second,
// dist-side asset installer — unreachable through the bin, which calls
// `installer.ensureBootstrap` instead. So the help page described one
// implementation while the bin ran another, and the dead one was invisible.
// That shadow implementation is now deleted, so the bin's is the only one.
//
// They stay registered, description-only, because `--help` must list the bin's
// real surface. `wrapper/installer-verb-help.mjs` is the single source for these
// summaries; the wrapper is `.mjs` and this tree is typechecked TypeScript with
// no allowJs, so a contract test pins the verbs AND their summary text against
// that module (tests/shared/installer-verb-help.test.ts) rather than an import.
const BIN_ROUTED_INSTALLER_VERBS: ReadonlyArray<readonly [string, string]> = [
  ["ensure", "lazily bootstraps repo-local /remediate-code assets when they are missing or stale"],
  ["install", "bootstraps /remediate-code into supported repo-local host surfaces"],
  ["install-host", "installs /remediate-code into ONE named host surface (--host <name>)"],
  ["verify-install", "smoke-tests the generated /remediate-code host assets after an install"],
];

for (const [verb, summary] of BIN_ROUTED_INSTALLER_VERBS) {
  program
    .command(verb)
    .description(`${summary} — handled by the remediate-code bin, not the dist CLI`)
    .action(() => {
      // Reachable only by invoking dist directly, bypassing the bin. Say so
      // rather than silently doing nothing, which is what a description-only
      // command would do.
      console.log(
        `${verb} is handled by the remediate-code bin, not the dist CLI. ` +
          `Run: remediate-code ${verb} --help`,
      );
    });
}

program
  .command("recover-submission")
  .description(
    "Re-land a host submission that was mangled, through the same validator the normal lane runs",
  )
  .option("--root <path>", ROOT_OPTION_DESCRIPTION)
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".audit-tools/remediation",
  )
  .requiredOption("--run-id <id>", "The run the work item belongs to")
  .requiredOption("--submission-id <id>", "The work item id the submission answers")
  .requiredOption("--from <path>", "Path to the corrected payload")
  .action(async (options) => {
    // Deliberately the ONLY new verb: the ordinary lane needs no command at all
    // (the host writes a file at a tool-named path), so the fragile argv surface
    // is paid only on the rare rescue, by an operator at a terminal.
    const root = resolveRootOption(options.root);
    const artifactsDir = resolveArtifactsDirOption(root, options.artifactsDir);
    const result = await recoverSubmissionVerb({
      root,
      artifactsDir,
      runId: options.runId,
      submissionId: options.submissionId,
      from: resolve(options.from),
    });
    if (result.status === "unrunnable") {
      console.error(result.message);
      process.exit(1);
    }
    console.log(JSON.stringify(result.body, null, 2));
    if (result.status !== "recovered") process.exit(result.exitCode);
  });

program
  .command("recover-ingest")
  .description(
    "Ingest landed host results whose trusted workload baseline was ORPHANED by a history rewrite (every other corroboration check still applies)",
  )
  .option("--root <path>", ROOT_OPTION_DESCRIPTION)
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".audit-tools/remediation",
  )
  .requiredOption("--run-id <id>", "The run whose workload results are ingested")
  .action(async (options) => {
    // An operator-explicit verb, exactly like recover-submission: the ordinary
    // lane needs no command (next-step ingests), so the relaxed evidence bar is
    // never reachable by a host that merely calls the normal loop.
    const root = resolveRootOption(options.root);
    const result = await recoverIngestVerb({
      root,
      artifactsDir: resolveArtifactsDirOption(root, options.artifactsDir),
      runId: options.runId,
    });
    if (result.status === "unrunnable") {
      // An operator at a terminal gets the reason, not a stack trace.
      console.error(`recover-ingest could not run: ${result.message}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result.body, null, 2));
    if (result.status !== "recovered") process.exit(result.exitCode);
  });

program
  .command("validate-artifacts")
  .description("Validate remediation runtime artifacts")
  .option("--root <path>", ROOT_OPTION_DESCRIPTION)
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".audit-tools/remediation",
  )
  .action(async (options) => {
    const root = resolveRootOption(options.root);
    const result = await validateArtifacts(
      resolveArtifactsDirOption(root, options.artifactsDir),
      root,
    );
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "ok" ? 0 : 1);
  });

export interface ValidateArtifactActionResult {
  status: "ok" | "error";
  name?: string;
  issue_count?: number;
  issues?: ValidationIssue[];
  message?: string;
}

/** Author-side shape/reference feedback. Acceptance still requires the live bound workflow. */
export async function runValidateArtifactAction(options: {
  name: string; file?: string; root?: string; artifactsDir: string;
}): Promise<{ result: ValidateArtifactActionResult; exitCode: number }> {
  const schema = options.name === "execution_plan" ? PlanSubmissionSchema : options.name === "critique" ? CritiqueSchema : options.name === "critic" ? CriticSchema : options.name === "judge" ? PlanJudgeSchema : undefined;
  if (!schema) return { result: { status: "error", message: "Valid names: execution_plan, critique, critic, judge." }, exitCode: 2 };
  try {
    const raw = JSON.parse(options.file ? readFileSync(resolve(options.file), "utf8") : readFileSync(0, "utf8")) as unknown;
    const payload = options.name !== "execution_plan" && raw && typeof raw === "object" && "result" in raw ? raw.result : raw;
    const parsed = schema.safeParse(payload);
    const messages = parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`);
    if (parsed.success && options.name === "execution_plan") {
      const root = resolveRootOption(options.root);
      const source = await readPlanSource(resolveArtifactsDirOption(root, options.artifactsDir));
      if (!source) messages.push("Tool-owned source record missing.");
      else messages.push(...executionPlanIssues(root, source, PlanSubmissionSchema.parse(payload).plan));
    }
    const issues: ValidationIssue[] = messages.map(message => ({ path: options.name, severity: "error", message }));
    return { result: { status: issues.length ? "error" : "ok", name: options.name, issue_count: issues.length, issues, message: "Shape/reference check only; next-step validates the live revision and review binding before acceptance." }, exitCode: issues.length ? 1 : 0 };
  } catch (error) { return { result: { status: "error", message: String(error) }, exitCode: 2 }; }
}

program
  .command("validate-artifact")
  .description(
    "Validate a single contract-pipeline artifact payload against its contract (write-time self-check)",
  )
  .requiredOption(
    "--name <name>",
    "Executable planning artifact name (execution_plan, critique, critic, judge)",
  )
  .option("--file <path>", "Path to the artifact JSON file (defaults to stdin)")
  .option("--root <path>", ROOT_OPTION_DESCRIPTION)
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".audit-tools/remediation",
  )
  .action(async (options) => {
    const { result, exitCode } = await runValidateArtifactAction(options);
    console.log(JSON.stringify(result, null, 2));
    process.exit(exitCode);
  });

program
  .command("validate")
  .description("Validate TypeScript types and schema contracts")
  .action(async () => {
    process.exit(runValidateCommand());
  });

// Exported so tests can construct argv and parse it through the real program
// instead of re-deriving option semantics.
export { program };

export function parseProgram(argv: string[]): void {
  program.parse(argv);
}

// Only parse argv when run directly; skip when imported as a module (e.g. in tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  parseProgram(process.argv);
}

// --- helpers ---

/**
 * Rewrite `<flag>=true` → `<flag>` and `<flag>=false` → `--no-<flag>` so a
 * value-less commander boolean can still be set false via the `=` spelling. A
 * non-boolean `<flag>=<other>` value fails loudly rather than silently defaulting.
 */
export function normalizeBooleanFlagArgv(argv: string[], flag: string): string[] {
  const negated = `--no-${flag.replace(/^--/, "")}`;
  return argv.map((token) => {
    if (token === `${flag}=true`) return flag;
    if (token === `${flag}=false`) return negated;
    if (token.startsWith(`${flag}=`)) {
      throw new Error(`${flag} must be true or false.`);
    }
    return token;
  });
}

async function withBackendLogsOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

/**
 * The repository root every remediate-code command acts on — the remediate DRAW
 * of the resolution audit-code's `getRootDir` performs (`src/audit/cli/args.ts`).
 *
 * Two arms, and the difference between them is the whole point:
 *   • `--root <X>` supplied → `resolveRepoRoot(X)`, which honors X verbatim
 *     (only climbing out of a `.audit-tools/` segment). An explicit root is an
 *     instruction, never a hint — a sub-project inside a larger repo stays the
 *     sub-project. This is the EXPLICIT OVERRIDE for running from outside the
 *     target repository.
 *   • no `--root` → `discoverRepoRoot` from the caller's working directory: the
 *     nearest ancestor owning `.audit-tools/` or `.git`, below the HOME ceiling.
 *     So every command run from anywhere inside a repository — including from
 *     inside its own `.audit-tools/` tree — resolves the SAME root.
 *
 * There is no literal default root any more. Every `--root`-bearing command used
 * to default to the string `"."`, i.e. the caller's cwd verbatim, so a run
 * launched from `<repo>/src` rooted the remediation at `<repo>/src` and minted a
 * second `.audit-tools/remediation` tree there — the property is now
 * tool-guaranteed instead of something the host must remember to pass on every
 * call (auditor-agnostic robustness). Commander leaves an absent `--root`
 * `undefined`, which is what makes "the user passed `--root .`" distinguishable
 * from "no `--root`" at all: the former still means the cwd, unclimbed.
 */
export function resolveRootOption(rawRoot: string | undefined): string {
  return rawRoot === undefined
    ? discoverRepoRoot(callerWorkingDirectory())
    : resolveRepoRoot(rawRoot);
}

/**
 * Resolve the remediation artifacts dir. An explicit `--artifacts-dir` is
 * honored verbatim; the unchanged commander default (`.audit-tools/remediation`)
 * rebases onto `root` via the shared `remediationArtifactsDir()` helper, so the
 * default always lands under `<root>/.audit-tools/remediation`. The
 * `.audit-tools/...` join literal lives only in the shared path module.
 *
 * `root` is the CANONICAL root — already through `resolveRootOption`, which is
 * where the discovered-vs-explicit decision and the climb out of a drifted
 * `.audit-tools/` cwd both happen. Anchoring here as well would put the same
 * decision in two places, and only one of them would see whether `--root` was
 * supplied at all.
 */
export function resolveArtifactsDirOption(
  root: string,
  artifactsDir: string,
): string {
  return artifactsDir === ".audit-tools/remediation"
    ? remediationArtifactsDir(root)
    : resolve(artifactsDir);
}

/**
 * The outcome of one operator recovery verb, as data: the JSON body to print,
 * the process exit code, and (for a failure that should read as a reason rather
 * than as a result) the message to print on stderr. Both recovery verbs return
 * this so the commander action branches are thin argv→call→print shims and the
 * real decisions — the recovered-nothing classification, the exit code, the
 * step-contract invalidation — are callable directly by a test. The branches
 * used to be testable only by spawning the CLI, which is why the
 * nothing-recovered path and the two `process.exit(1)` sites were covered by
 * exactly nothing.
 */
export type RecoveryVerbResult =
  | { readonly status: "recovered"; readonly body: Record<string, unknown> }
  | {
      readonly status: "recovered-with-issues" | "nothing-to-recover" | "pending";
      readonly body: Record<string, unknown>;
      readonly exitCode: number;
    }
  /** The verb could not run at all (an exception, or no live binding). */
  | { readonly status: "unrunnable"; readonly message: string };

/**
 * `recover-ingest`'s whole decision, minus argv parsing and printing.
 *
 * Exit code, not prose, is what an operator scripts on — so the three outcomes
 * are told apart mechanically, in this precedence:
 *
 *   75 the EXPECTED-PENDING outcome, tested FIRST: every issue is
 *      `submission_missing`, i.e. the run is waiting on results the host simply
 *      has not written yet. No operator action is implied, so this must not read
 *      as a fault — not even when a sibling item was accepted in the same pass,
 *      because the issues are what an operator acts on and none of them asks for
 *      anything. (`accepted_count` in the body still reports the acceptance.)
 *   2  ACCEPTED-WITH-ISSUES: something was accepted AND something was really
 *      refused. Tested before the clean arm, because the clean arm's condition
 *      ("something was accepted") is a strict superset: without this arm a
 *      partial recovery reports the same status token as a complete one, and a
 *      caller scripting on the token cannot see the refusal at all.
 *   0  otherwise, everything the pass saw was accepted
 *   1  otherwise (nothing accepted, and not every issue is expected-pending): a
 *      run that recovered NOTHING is not a recovery, and any REAL issue — a
 *      partial ingest, a moved tree, a refused payload — is a failure.
 *
 * The pending arm is the distinction the entry asks for: "the host hasn't
 * finished" must not read identically to "the run is wedged", or an operator's
 * retry loop cannot tell a normal wait from a real fault. `submission_missing`
 * is the ONLY issue code that means expected-pending — every other code
 * describes something the operator must act on. (75 = EX_TEMPFAIL, the
 * conventional "try again" code.)
 *
 * The accepted-with-issues arm applies the same rule one level down: a pass that
 * landed real work AND refused real work is neither a clean success nor a
 * nothing-to-recover, and it gets its own token so the three are told apart
 * without reading `issues`.
 */
export async function recoverIngestVerb(options: {
  root: string;
  artifactsDir: string;
  runId: string;
}): Promise<RecoveryVerbResult> {
  let summary: RemediationHostIngestSummary;
  try {
    summary = await recoverIngestHostResults(options);
  } catch (error) {
    return {
      status: "unrunnable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const expectedPendingOnly =
    summary.issues.length > 0 &&
    summary.issues.every((issue) => issue.code === "submission_missing");
  const recoveredNothing =
    summary.accepted_count === 0 &&
    summary.completed_work_item_ids.length === 0 &&
    !expectedPendingOnly;
  // A pass that accepted real work AND refused real work. Computed from the SAME
  // two facts the other arms read — an acceptance happened, and at least one
  // issue is not the expected-pending code — so this arm does not re-derive
  // "was there a refusal", which is what would let the token and the issue list
  // disagree.
  const acceptedWithIssues =
    !recoveredNothing &&
    !expectedPendingOnly &&
    summary.issues.length > 0;
  const body = {
    status: recoveredNothing
      ? "nothing-to-recover"
      : expectedPendingOnly
        ? "pending"
        : acceptedWithIssues
          ? "recovered-with-issues"
          : "recovered",
    run_id: options.runId,
    accepted_count: summary.accepted_count,
    completed_work_item_ids: summary.completed_work_item_ids,
    pending_work_item_ids: summary.pending_work_item_ids,
    issues: summary.issues,
    // The per-item progress the issues alone cannot express: an item whose
    // edits LANDED but whose result file is missing is partial progress, and it
    // would otherwise be indistinguishable here from one the host never started.
    worked_but_unreported_work_item_ids: [...summary.work_item_outcomes]
      .filter(([, outcome]) => outcome === "missing_result_with_commit")
      .map(([id]) => id)
      .sort(),
  };
  if (recoveredNothing) return { status: "nothing-to-recover", body, exitCode: 1 };
  if (expectedPendingOnly) return { status: "pending", body, exitCode: 75 };
  if (acceptedWithIssues) {
    return { status: "recovered-with-issues", body, exitCode: 2 };
  }
  return { status: "recovered", body };
}

/**
 * `recover-submission`'s whole decision, minus argv parsing and printing — the
 * same extraction, so its no-live-binding refusal and its refusal path are
 * covered by a test instead of by a manual smoke log.
 *
 * A successful rescue LANDS a submission, which changes what the run's persisted
 * step contract is still asking for, so it invalidates that contract exactly as
 * `recover-ingest` does. The invalidation is best-effort by construction
 * (`invalidateStepContracts` swallows a missing steps tree), so a rescue can
 * never be reported as failed because a stale prompt could not be removed.
 */
export async function recoverSubmissionVerb(options: {
  root: string;
  artifactsDir: string;
  runId: string;
  submissionId: string;
  from: string;
}): Promise<RecoveryVerbResult> {
  const store = new StateStore(options.artifactsDir);
  return store.withActiveOperator(async (): Promise<RecoveryVerbResult> => {
  const binding = await remediationSubmissionBinding({
    root: options.root,
    artifactsDir: options.artifactsDir,
    runId: options.runId,
    workItemId: options.submissionId,
  });
  if (binding === null) {
    // No contract to check against must never read as "passes".
    return {
      status: "unrunnable",
      message:
        `No live workload for run '${options.runId}' names work item ` +
        `'${options.submissionId}'. Recovery refuses a submission it cannot validate.`,
    };
  }
  const outcome = await recoverSubmission(
    {
      root: options.root,
      artifactsDir: options.artifactsDir,
      runId: options.runId,
      submissionId: options.submissionId,
      fromPath: options.from,
      lane: options.submissionId,
      submissionDir: binding.submissionDir,
    },
    binding.validate,
  );
  if (!outcome.ok) {
    return {
      status: "unrunnable",
      message:
        `recover-submission refused the payload for '${options.submissionId}' ` +
        `(${outcome.issue.code}): ${outcome.issue.message}`,
    };
  }
  await invalidateStepContracts(options.artifactsDir);
  return {
    status: "recovered",
    body: {
      status: "recovered",
      work_item_id: options.submissionId,
      submission_path: outcome.submission_path,
    },
  };
  });
}

export function runValidateCommand(
  deps: {
    run?: typeof runTracked;
    log?: (message: string) => void;
    error?: (message: string) => void;
  } = {},
): number {
  const run = deps.run ?? runTracked;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const result = run(["npx", "tsc", "--noEmit"], {
    cwd: pkgRoot,
    stdio: "inherit",
    // Declared bound (required by the sync twin): a full typecheck runs
    // minutes at worst; this command runs outside any held file lock.
    timeout: 3_600_000,
  });
  if (result.status !== 0) {
    error("Type check failed.");
    return result.status ?? 1;
  }
  log("validate: TypeScript types OK");
  return 0;
}
