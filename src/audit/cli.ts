import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  setQuotaStateDir,
} from "./quota/index.js";
import {
  assertCliCommandAllowedFromCwd,
  resolveAuditCodeStateDir,
} from "audit-tools/shared";

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
import { cmdWorkerRun } from "./cli/workerRunCommand.js";
import { cmdSubmitPacket } from "./cli/submitPacketCommand.js";
import { cmdMergeAndIngest } from "./cli/mergeAndIngestCommand.js";
import { cmdStatus } from "./cli/statusCommand.js";
import { runSample } from "./cli/sampleRunCommand.js";
import { cmdAdvanceAudit } from "./cli/advanceAuditCommand.js";
import { cmdPrepareDispatch } from "./cli/prepareDispatchCommand.js";
import { cmdValidateResult } from "./cli/validateResultCommand.js";
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
import { cmdQuota } from "./cli/quotaCommand.js";
import { cmdDispatchStatus } from "./cli/dispatchStatusCommand.js";
import { cmdScoreAudit } from "./cli/scoreAuditCommand.js";
import { cmdScoreTokens } from "./cli/scoreTokensCommand.js";

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
const WORKER_SAFE_COMMANDS: ReadonlySet<string> = new Set([
  "worker-run",
  "submit-packet",
  "validate-result",
  "validate-results",
  "validate",
]);

async function main(argv: string[]): Promise<void> {
  setQuotaStateDir(resolveAuditCodeStateDir());
  const command = argv[2] ?? "sample-run";
  assertCliCommandAllowedFromCwd({
    cliName: "audit-code",
    commandName: command,
    workerSafeCommands: WORKER_SAFE_COMMANDS,
    // Raw --root, pre-resolveRepoRoot: the anchoring climb erases the
    // worktree evidence, so the guard must see the unanchored value.
    rawRoot: getFlag(argv, "--root"),
  });
  switch (command) {
    case "sample-run":
      await runSample(argv);
      return;
    case "advance-audit":
      await cmdAdvanceAudit(argv);
      return;
    case "next-step":
      await cmdNextStep(argv);
      return;
    case "worker-run":
      await cmdWorkerRun(argv);
      return;
    case "import-external-analyzer":
      await cmdImportExternalAnalyzer(argv);
      return;
    case "intake":
      await cmdIntake(argv);
      return;
    case "plan":
      await cmdPlan(argv);
      return;
    case "ingest-results":
      await cmdIngestResults(argv);
      return;
    case "explain-task":
      await cmdExplainTask(argv);
      return;
    case "update-runtime-validation":
      await cmdUpdateRuntimeValidation(argv);
      return;
    case "validate":
      await cmdValidate(argv);
      return;
    case "validate-results":
      await cmdValidateResults(argv);
      return;
    case "requeue":
      await cmdRequeue(argv);
      return;
    case "synthesize":
      await cmdSynthesize(argv);
      return;
    case "force-synthesis":
      await cmdForceSynthesis(argv);
      return;
    case "resynthesize":
      await cmdResynthesize(argv);
      return;
    case "cleanup":
      await cmdCleanup(argv);
      return;
    case "prepare-dispatch":
      await cmdPrepareDispatch(argv);
      return;
    case "merge-and-ingest":
      await cmdMergeAndIngest(argv);
      return;
    case "submit-packet":
      await cmdSubmitPacket(argv);
      return;
    case "validate-result":
      await cmdValidateResult(argv);
      return;
    case "quota":
      await cmdQuota(argv);
      return;
    case "status":
      await cmdStatus(argv);
      return;
    case "dispatch-status":
      await cmdDispatchStatus(argv);
      return;
    case "score-audit":
      await cmdScoreAudit(argv);
      return;
    case "score-tokens":
      await cmdScoreTokens(argv);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(
        "Available commands: sample-run, advance-audit, next-step, worker-run, import-external-analyzer, intake, plan, ingest-results, explain-task, update-runtime-validation, validate, validate-results, requeue, synthesize, force-synthesis, resynthesize, cleanup, prepare-dispatch, merge-and-ingest, submit-packet, validate-result, quota, status, dispatch-status, score-audit, score-tokens",
      );
      process.exitCode = 1;
  }
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
