import { test, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureConsole } from "./helpers/captureConsole.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const distCliUrl = pathToFileURL(join(repoRoot, "dist", "audit", "cli.js")).href;
const { runCli } = await import(distCliUrl);

// All command names that the switch statement in cli.ts must handle.
const KNOWN_COMMANDS = [
  "sample-run",
  "advance-audit",
  "next-step",
  "worker-run",
  "import-external-analyzer",
  "intake",
  "plan",
  "ingest-results",
  "explain-task",
  "update-runtime-validation",
  "validate",
  "validate-results",
  "requeue",
  "synthesize",
  "resynthesize",
  "cleanup",
  "prepare-dispatch",
  "merge-and-ingest",
  "submit-packet",
  "validate-result",
  "quota",
  "status",
  "dispatch-status",
];

// ── unknown command sets exitCode=1 and lists valid commands ──────────────────

test("unknown command sets process.exitCode = 1", async () => {
  const result = await captureConsole(() =>
    runCli([process.execPath, "cli.js", "this-is-not-a-command"]),
  );
  expect(result.code, "exitCode should be 1 for unknown command").toBe(1);
});

test("unknown command prints 'Unknown command' error", async () => {
  const result = await captureConsole(() =>
    runCli([process.execPath, "cli.js", "bogus-cmd"]),
  );
  expect(result.stderr.includes("Unknown command"), `stderr should include 'Unknown command', got: ${result.stderr}`).toBeTruthy();
});

test("unknown command error lists all known commands", async () => {
  const result = await captureConsole(() =>
    runCli([process.execPath, "cli.js", "bogus-cmd"]),
  );
  for (const cmd of KNOWN_COMMANDS) {
    expect(result.stderr.includes(cmd), `'${cmd}' should appear in the error listing, got: ${result.stderr}`).toBeTruthy();
  }
});

// ── each extracted command module exports the expected function ───────────────

// Verify each command module is importable and exports the expected function.
// This ensures no extracted module was accidentally left as a stub or removed.
const cmdModuleMap = [
  ["advanceAuditCommand.ts", "cmdAdvanceAudit"],
  ["prepareDispatchCommand.ts", "cmdPrepareDispatch"],
  ["validateResultCommand.ts", "cmdValidateResult"],
  ["importExternalAnalyzerCommand.ts", "cmdImportExternalAnalyzer"],
  ["intakeCommand.ts", "cmdIntake"],
  ["planCommand.ts", "cmdPlan"],
  ["ingestResultsCommand.ts", "cmdIngestResults"],
  ["explainTaskCommand.ts", "cmdExplainTask"],
  ["updateRuntimeValidationCommand.ts", "cmdUpdateRuntimeValidation"],
  ["validateCommand.ts", "cmdValidate"],
  ["validateResultsCommand.ts", "cmdValidateResults"],
  ["requeueCommand.ts", "cmdRequeue"],
  ["synthesizeCommand.ts", "cmdSynthesize"],
  ["resynthesizeCommand.ts", "cmdResynthesize"],
  ["cleanupCommand.ts", "cmdCleanup"],
  ["quotaCommand.ts", "cmdQuota"],
  ["dispatchStatusCommand.ts", "cmdDispatchStatus"],
  ["sampleRunCommand.ts", "runSample"],
  ["nextStepCommand.ts", "cmdNextStep"],
  ["workerRunCommand.ts", "cmdWorkerRun"],
  ["submitPacketCommand.ts", "cmdSubmitPacket"],
  ["mergeAndIngestCommand.ts", "cmdMergeAndIngest"],
  ["statusCommand.ts", "cmdStatus"],
];

for (const [moduleFile, exportName] of cmdModuleMap) {
  await test(`cli/${moduleFile} exports ${exportName}`, async () => {
    const mod = await import(
      pathToFileURL(join(repoRoot, "src", "audit", "cli", moduleFile)).href
    );
    expect(typeof mod[exportName], `${moduleFile} should export a function named '${exportName}'`).toBe("function");
  });
}
