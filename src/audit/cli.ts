import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCliCommandAllowedFromCwd } from "audit-tools/shared";

import {
  DIRECT_CLI_DEFAULTS,
  getFlag,
  hasFlag,
  getArtifactsDir,
  getRootDir,
  getBatchResultsDir,
  getTimeoutMs,
  looksLikeCliFlag,
  countLines,
  warnIfNotGitRepo,
} from "./cli/args.js";
import { cmdNextStep } from "./cli/nextStepCommand.js";
import { cmdStatus } from "./cli/statusCommand.js";
import { runSample } from "./cli/sampleRunCommand.js";
import { cmdImportExternalAnalyzer } from "./cli/importExternalAnalyzerCommand.js";
import { cmdIntake } from "./cli/intakeCommand.js";
import { cmdPlan } from "./cli/planCommand.js";
import { cmdIngestResults } from "./cli/ingestResultsCommand.js";
import { cmdExplainTask } from "./cli/explainTaskCommand.js";
import { cmdUpdateRuntimeValidation } from "./cli/updateRuntimeValidationCommand.js";
import { cmdValidate } from "./cli/validateCommand.js";
import { cmdValidateResults } from "./cli/validateResultsCommand.js";
import { cmdRequeue } from "./cli/requeueCommand.js";
import { cmdSynthesize } from "./cli/synthesizeCommand.js";
import { cmdForceSynthesis } from "./cli/forceSynthesisCommand.js";
import { cmdResynthesize } from "./cli/resynthesizeCommand.js";
import { cmdCleanup } from "./cli/cleanupCommand.js";
import { cmdScoreAudit } from "./cli/scoreAuditCommand.js";
import { cmdRecoverSubmission } from "./cli/recoverSubmissionCommand.js";
import { cmdUnacceptResults } from "./cli/unacceptResultsCommand.js";

export { runSample };

export const cliTestUtils = {
  defaults: DIRECT_CLI_DEFAULTS,
  getFlag,
  hasFlag,
  getArtifactsDir,
  getRootDir,
  getBatchResultsDir,
  getTimeoutMs,
  looksLikeCliFlag,
  countLines,
  warnIfNotGitRepo,
};

/**
 * Worker-safe subcommands: the only commands a dispatched worker may run from
 * inside a tool-created worktree (its own review snapshot / implement checkout)
 * — result-scoped submission and validation, whose targets are explicit
 * (`--task` payload, `--artifacts-dir-b64`). Every OTHER command — including
 * the bare-invocation `sample-run` default and any future command — is refused
 * from a node-worktree context: deny by default, never silently exposed
 * (backlog "shared-state clobber from node context", live 2026-07-22). The
 * packaged wrapper spawns this backend with cwd at the PACKAGE root, so the
 * caller's true cwd arrives via AUDIT_TOOLS_CALLER_CWD (stamped by the
 * wrapper, scrubbed from provider spawns).
 */
const WORKER_SAFE_COMMANDS: ReadonlySet<string> = new Set();

/**
 * The ONE route table for the audit CLI. Each row is [verb, handler]; the
 * dispatch below walks it and the unknown-command listing is DERIVED from it —
 * never a second hand-maintained copy that drifts when a verb is added.
 */
export const COMMAND_ROUTES: ReadonlyArray<
  readonly [string, (argv: string[]) => Promise<void>]
> = [
  ["sample-run", runSample],
  ["next-step", cmdNextStep],
  ["import-external-analyzer", cmdImportExternalAnalyzer],
  ["intake", cmdIntake],
  ["plan", cmdPlan],
  ["ingest-results", cmdIngestResults],
  ["explain-task", cmdExplainTask],
  ["update-runtime-validation", cmdUpdateRuntimeValidation],
  ["validate", cmdValidate],
  ["validate-results", cmdValidateResults],
  ["requeue", cmdRequeue],
  ["synthesize", cmdSynthesize],
  ["force-synthesis", cmdForceSynthesis],
  ["resynthesize", cmdResynthesize],
  ["cleanup", cmdCleanup],
  ["status", cmdStatus],
  ["score-audit", cmdScoreAudit],
  ["recover-submission", cmdRecoverSubmission],
  ["unaccept-results", cmdUnacceptResults],
];

async function main(argv: string[]): Promise<void> {
  const command = argv[2] ?? "sample-run";
  const route = COMMAND_ROUTES.find(([verb]) => verb === command);
  if (argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    console.log(`Usage: audit-code ${route ? command : "<command>"} [options]`);
    console.log(
      `Available commands: ${COMMAND_ROUTES.map(([verb]) => verb).join(", ")}`,
    );
    return;
  }
  assertCliCommandAllowedFromCwd({
    cliName: "audit-code",
    commandName: command,
    workerSafeCommands: WORKER_SAFE_COMMANDS,
    // Raw --root, pre-resolveRepoRoot: the anchoring climb erases the
    // worktree evidence, so the guard must see the unanchored value.
    rawRoot: getFlag(argv, "--root"),
  });
  if (!route) {
    console.error(`Unknown command: ${command}`);
    console.error(
      `Available commands: ${COMMAND_ROUTES.map(([verb]) => verb).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  await route[1](argv);
}

export async function runCli(argv: string[]): Promise<void> {
  await main(argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function isDirectCliExecution(argv: string[]): boolean {
  const entryPath = argv[1];
  if (!entryPath) {
    return false;
  }
  return resolve(entryPath) === fileURLToPath(import.meta.url);
}

if (isDirectCliExecution(process.argv)) {
  await runCli(process.argv);
}
