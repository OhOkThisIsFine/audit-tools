import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decideNextStep, recoverIngestHostResults } from "./steps/nextStep.js";
import { validateArtifacts } from "./validation/artifacts.js";
import {
  CONTRACT_PIPELINE_VALIDATORS,
  evaluateContractPipelineCrossGates,
} from "./validation/contractPipeline.js";
import {
  CP_ARTIFACT_NAMES,
  isEnvelope,
  stampToolCreatedAt,
  readContractArtifact,
  envelopePayload,
  type ContractPipelineArtifactName,
} from "./contractPipeline/artifactStore.js";
import { intakePaths } from "./intake.js";
import type { ValidationIssue } from "audit-tools/shared";
import {
  applyGuidanceFile,
  assertCliCommandAllowedFromCwd,
  remediationArtifactsDir,
  resolveRepoRoot,
  readOptionalJsonFile,
  recoverSubmission,
  runTracked,
  runWithBlockedStepBackstop,
} from "audit-tools/shared";
import { writeBlockedStep } from "./steps/stepWriter.js";
import {
  remediationSubmissionBinding,
  type RemediationHostIngestSummary,
} from "./steps/dispatch/hostHandoff.js";

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
  .description("Write and print one backend-rendered remediation step")
  .option("--root <path>", "Repository root", ".")
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
    const artifactsDir = resolveArtifactsDirOption(
      options.root,
      options.artifactsDir,
    );
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
        if (options.guidanceFile) {
          applyGuidanceFile(artifactsDir, options.guidanceFile);
        }
        return withBackendLogsOnStderr(() =>
          decideNextStep({
            root: options.root,
            artifactsDir,
            input: options.input,
            guidanceFileSupplied: Boolean(options.guidanceFile),
            finalizeClosing: options.finalizeClosing === true,
            forceReplan: options.forceReplan === true,
          }),
        );
      },
      (reason) =>
        writeBlockedStep({ root: resolve(options.root), artifactsDir, reason }),
    );
    console.log(JSON.stringify(step, null, 2));
  });

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
// no allowJs, so a contract test pins the two lists rather than an import.
const BIN_ROUTED_INSTALLER_VERBS: ReadonlyArray<readonly [string, string]> = [
  ["ensure", "lazily bootstraps repo-local /remediate-code assets when they are missing or stale"],
  ["install", "bootstraps /remediate-code into supported repo-local host surfaces"],
  ["install-host", "installs /remediate-code into ONE named host surface (--host <name>)"],
  ["verify-install", "smoke-tests the generated host assets after an install"],
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
  .option("--root <path>", "Repository root", ".")
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
    const root = resolve(options.root);
    const artifactsDir = resolveArtifactsDirOption(options.root, options.artifactsDir);
    const binding = await remediationSubmissionBinding({
      root,
      artifactsDir,
      runId: options.runId,
      workItemId: options.submissionId,
    });
    if (binding === null) {
      // No contract to check against must never read as "passes".
      console.error(
        `No live workload for run '${options.runId}' names work item ` +
          `'${options.submissionId}'. Recovery refuses a submission it cannot validate.`,
      );
      process.exit(1);
    }
    const outcome = await recoverSubmission(
      {
        root,
        artifactsDir,
        runId: options.runId,
        submissionId: options.submissionId,
        fromPath: resolve(options.from),
        lane: options.submissionId,
        submissionDir: binding.submissionDir,
      },
      binding.validate,
    );
    if (!outcome.ok) {
      console.error(
        `recover-submission refused the payload for '${options.submissionId}' ` +
          `(${outcome.issue.code}): ${outcome.issue.message}`,
      );
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          status: "recovered",
          work_item_id: options.submissionId,
          submission_path: outcome.submission_path,
        },
        null,
        2,
      ),
    );
  });

program
  .command("recover-ingest")
  .description(
    "Ingest landed host results whose trusted workload baseline was ORPHANED by a history rewrite (every other corroboration check still applies)",
  )
  .option("--root <path>", "Repository root", ".")
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
    let summary: RemediationHostIngestSummary;
    try {
      summary = await recoverIngestHostResults({
        root: options.root,
        artifactsDir: resolveArtifactsDirOption(options.root, options.artifactsDir),
        runId: options.runId,
      });
    } catch (error) {
      // An operator at a terminal gets the reason, not a stack trace.
      console.error(
        `recover-ingest could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
    // A run that recovered NOTHING is not a recovery. Saying "recovered" and
    // exiting 0 over an empty accept set is the one outcome an operator could
    // mistake for success, so it gets its own status and a non-zero exit — as
    // does any partial run, since an operator who asked for N items back must
    // not read a partial ingest as a complete one. The body names what landed.
    const recoveredNothing =
      summary.accepted_count === 0 &&
      summary.completed_work_item_ids.length === 0;
    console.log(
      JSON.stringify(
        {
          status: recoveredNothing ? "nothing-to-recover" : "recovered",
          run_id: options.runId,
          accepted_count: summary.accepted_count,
          completed_work_item_ids: summary.completed_work_item_ids,
          pending_work_item_ids: summary.pending_work_item_ids,
          issues: summary.issues,
        },
        null,
        2,
      ),
    );
    if (recoveredNothing || summary.issues.length > 0) process.exit(1);
  });

program
  .command("validate-artifacts")
  .description("Validate remediation runtime artifacts")
  .option("--root <path>", "Repository root", ".")
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".audit-tools/remediation",
  )
  .action(async (options) => {
    const result = await validateArtifacts(
      resolveArtifactsDirOption(options.root, options.artifactsDir),
      resolve(options.root),
    );
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "ok" ? 0 : 1);
  });

export interface ValidateArtifactActionResult {
  status: "ok" | "error";
  name?: ContractPipelineArtifactName;
  issue_count?: number;
  issues?: ValidationIssue[];
  message?: string;
}

/**
 * The `validate-artifact --name X` self-check's full logic, exported so tests
 * can call it directly (no dist build / subprocess race). Returns the JSON body
 * + exit code the CLI action prints/exits with, without doing either itself.
 *
 * Beyond the per-artifact structural validator, this ALSO loads the on-disk
 * sibling contract-pipeline artifacts (under `<artifactsDir>/intake/contract/`)
 * and runs the SAME cross-artifact gates the plural `validate-artifacts` sweep
 * and `next-step` enforce (evaluateContractPipelineCrossGates — single-sourced
 * in validation/contractPipelineGates.ts), substituting the in-flight `name`
 * payload for its on-disk version so the in-flight edit always wins over a
 * stale/absent sibling. Without this, a shape-valid artifact missing its
 * cross-artifact obligations (e.g. a test_validator_plan missing its CE-006
 * scoped negative) could self-validate "ok" here and only fail later at
 * next-step — the exact authoring round-trip this closes.
 */
export async function runValidateArtifactAction(options: {
  name: string;
  file?: string;
  root: string;
  artifactsDir: string;
}): Promise<{ result: ValidateArtifactActionResult; exitCode: number }> {
  const name = options.name as ContractPipelineArtifactName;
  const validator = CONTRACT_PIPELINE_VALIDATORS[name];
  if (!validator) {
    return {
      result: {
        status: "error",
        message: `Unknown contract-pipeline artifact "${options.name}". Valid names: ${CP_ARTIFACT_NAMES.join(", ")}.`,
      },
      exitCode: 2,
    };
  }
  let raw: string;
  try {
    raw = options.file
      ? readFileSync(resolve(options.file), "utf8")
      : readFileSync(0, "utf8");
  } catch (err) {
    return {
      result: { status: "error", message: `Could not read artifact input: ${(err as Error).message}` },
      exitCode: 2,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      result: { status: "error", message: `Artifact is not valid JSON: ${(err as Error).message}` },
      exitCode: 2,
    };
  }
  // Unwrap a stored content-hash envelope so the bare payload is validated
  // against its contract; a plain payload validates as-is. Uses the canonical
  // isEnvelope predicate so CLI self-check and ingest unwrap identically.
  const unwrapped = isEnvelope(parsed) ? parsed.payload : parsed;
  // Stamp the tool-owned `created_at` (host has no clock) so the self-check
  // matches ingest: a host payload without a timestamp is valid here too (B4).
  const payload = stampToolCreatedAt(unwrapped, new Date().toISOString());
  const structuralIssues = validator(payload, name);

  const root = resolve(options.root);
  const artifactsDir = resolveArtifactsDirOption(options.root, options.artifactsDir);

  let crossGateIssues: ValidationIssue[];
  try {
    const payloads = new Map<ContractPipelineArtifactName, unknown>();
    for (const siblingName of CP_ARTIFACT_NAMES) {
      const siblingPayload = envelopePayload(await readContractArtifact(artifactsDir, siblingName));
      if (siblingPayload !== undefined) payloads.set(siblingName, siblingPayload);
    }
    // The in-flight payload ALWAYS wins over any stale/absent on-disk copy of
    // the SAME artifact — this is the write-time self-check for `name`, so its
    // in-flight content is what must be gated, not a possibly-stale sibling file.
    payloads.set(name, payload);
    const findingEnumeration = await readOptionalJsonFile(
      intakePaths(artifactsDir).findingEnumeration,
    );
    crossGateIssues = evaluateContractPipelineCrossGates({
      payloads,
      findingEnumeration,
      root,
    }).flat();
  } catch (err) {
    // readContractArtifact / readOptionalJsonFile throw on a corrupt (malformed-
    // JSON) sibling envelope — mirror the same JSON-parse-error shape/exit code
    // the primary --file parse error above uses.
    return {
      result: {
        status: "error",
        message: `Could not load a sibling contract-pipeline artifact: ${(err as Error).message}`,
      },
      exitCode: 2,
    };
  }

  // A write-time self-check for `name` gates only what is KNOWABLE when `name`
  // is authored — it must not report a defect scoped to an artifact authored
  // LATER in the pipeline (which does not exist yet at this write). The
  // canonical example: the OBL-CO-03 evidence-threading cross-gate fail-closes
  // when a judge ACCEPTS a counterexample but no implementation_dag threads it —
  // correct at the DAG/promotion boundary, but the DAG is authored AFTER the
  // judge, so `validate-artifact --name judge_report` could never return "ok"
  // for an honest judge with accepted counterexamples (its "fix issues until ok"
  // prompt was unsatisfiable). Suppress cross-gate issues whose scoped artifact
  // is DOWNSTREAM of `name`; the promotion sweep (where that downstream artifact
  // IS the in-flight one, so its order is not > name's) still enforces them in
  // full. This phase-scopes ONLY the singular self-check to match what next-step
  // applies at `name`'s phase — the shared cross-gate SET the plural sweep and
  // next-step run is untouched, so the two can never diverge on what IS checked.
  const nameOrder = CP_ARTIFACT_NAMES.indexOf(name);
  const isDownstreamScopedIssue = (issue: ValidationIssue): boolean => {
    // Issue paths are `<artifact>.<field>…` / `<artifact>[i]…`; the leading
    // segment names the artifact the defect belongs to. A non-artifact prefix
    // (e.g. `decomposition_file_scope.repo_tree`) resolves to -1 → never
    // suppressed (only a POSITIVE downstream match is dropped).
    const lead = issue.path.split(/[.[]/, 1)[0];
    return CP_ARTIFACT_NAMES.indexOf(lead as ContractPipelineArtifactName) > nameOrder;
  };
  crossGateIssues = crossGateIssues.filter((issue) => !isDownstreamScopedIssue(issue));

  const issues = [...structuralIssues, ...crossGateIssues];
  const errors = issues.filter((issue) => issue.severity === "error");
  return {
    result: {
      status: errors.length === 0 ? "ok" : "error",
      name,
      issue_count: issues.length,
      issues,
    },
    exitCode: errors.length === 0 ? 0 : 1,
  };
}

program
  .command("validate-artifact")
  .description(
    "Validate a single contract-pipeline artifact payload against its contract (write-time self-check)",
  )
  .requiredOption(
    "--name <name>",
    "Contract-pipeline artifact name (e.g. obligation_ledger, test_validator_plan)",
  )
  .option("--file <path>", "Path to the artifact JSON file (defaults to stdin)")
  .option("--root <path>", "Repository root", ".")
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
 * Resolve the remediation artifacts dir. An explicit `--artifacts-dir` is
 * honored verbatim; the unchanged commander default (`.audit-tools/remediation`)
 * rebases onto the anchored `--root` via the shared `remediationArtifactsDir()`
 * helper, so `--root <X>` lands the default under `<X>/.audit-tools/remediation`.
 * The `.audit-tools/...` join literal lives only in the shared path module, and
 * `resolveRepoRoot()` climbs the root out of a drifted cwd so a bare `--root .`
 * run from inside `.audit-tools/` cannot mint a phantom nested tree.
 */
export function resolveArtifactsDirOption(
  root: string,
  artifactsDir: string,
): string {
  return artifactsDir === ".audit-tools/remediation"
    ? remediationArtifactsDir(resolveRepoRoot(root))
    : resolve(artifactsDir);
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
  });
  if (result.status !== 0) {
    error("Type check failed.");
    return result.status ?? 1;
  }
  log("validate: TypeScript types OK");
  return 0;
}
