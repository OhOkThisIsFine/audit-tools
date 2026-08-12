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
  "next-step",
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
  "force-synthesis",
  "resynthesize",
  "cleanup",
  "status",
  "score-audit",
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
  ["importExternalAnalyzerCommand.js", "cmdImportExternalAnalyzer"],
  ["intakeCommand.js", "cmdIntake"],
  ["planCommand.js", "cmdPlan"],
  ["ingestResultsCommand.js", "cmdIngestResults"],
  ["explainTaskCommand.js", "cmdExplainTask"],
  ["updateRuntimeValidationCommand.js", "cmdUpdateRuntimeValidation"],
  ["validateCommand.js", "cmdValidate"],
  ["validateResultsCommand.js", "cmdValidateResults"],
  ["requeueCommand.js", "cmdRequeue"],
  ["synthesizeCommand.js", "cmdSynthesize"],
  ["forceSynthesisCommand.js", "cmdForceSynthesis"],
  ["resynthesizeCommand.js", "cmdResynthesize"],
  ["cleanupCommand.js", "cmdCleanup"],
  ["scoreAuditCommand.js", "cmdScoreAudit"],
  ["sampleRunCommand.js", "runSample"],
  ["nextStepCommand.js", "cmdNextStep"],
  ["statusCommand.js", "cmdStatus"],
];

for (const [moduleFile, exportName] of cmdModuleMap) {
  await test(`cli/${moduleFile} exports ${exportName}`, async () => {
    const mod = await import(
      pathToFileURL(join(repoRoot, "src", "audit", "cli", moduleFile)).href
    );
    expect(typeof mod[exportName], `${moduleFile} should export a function named '${exportName}'`).toBe("function");
  });
}
