import { test, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureConsole } from "./helpers/captureConsole.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const distCliUrl = pathToFileURL(join(repoRoot, "dist", "audit", "cli.js")).href;
const { runCli, COMMAND_ROUTES } = await import(distCliUrl);

// The roster is DERIVED from the CLI's own route table — never a second,
// hand-maintained copy that drifts when a verb is added (the defect this file
// previously reproduced: `unaccept-results` and `recover-submission` were
// missing here while shipping).
const KNOWN_COMMANDS = COMMAND_ROUTES.map(
  // Route rows arrive untyped through the dist import — destructure explicitly.
  ([verb]: readonly string[]) => verb,
);

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

/**
 * Module file + export name per route row. Derived from the SAME table that
 * drives dispatch: a verb registered without a module row (or vice versa) fails
 * the pairing check below instead of silently escaping both rosters.
 */
const cmdModuleMap = [
  ["sample-run", "sampleRunCommand.js", "runSample"],
  ["next-step", "nextStepCommand.js", "cmdNextStep"],
  ["import-external-analyzer", "importExternalAnalyzerCommand.js", "cmdImportExternalAnalyzer"],
  ["intake", "intakeCommand.js", "cmdIntake"],
  ["plan", "planCommand.js", "cmdPlan"],
  ["validate", "validateCommand.js", "cmdValidate"],
  ["synthesize", "synthesizeCommand.js", "cmdSynthesize"],
  ["force-synthesis", "forceSynthesisCommand.js", "cmdForceSynthesis"],
  ["resynthesize", "resynthesizeCommand.js", "cmdResynthesize"],
  ["cleanup", "cleanupCommand.js", "cmdCleanup"],
  ["status", "statusCommand.js", "cmdStatus"],
  ["score-audit", "scoreAuditCommand.js", "cmdScoreAudit"],
  ["recover-submission", "recoverSubmissionCommand.js", "cmdRecoverSubmission"],
  ["submit", "submitCommand.js", "cmdSubmit"],
  ["consolidate-findings", "submitCommand.js", "cmdConsolidateFindings"],
  ["mcp", "submitCommand.js", "cmdMcp"],
];

for (const [, moduleFile, exportName] of cmdModuleMap) {
  await test(`cli/${moduleFile} exports ${exportName}`, async () => {
    const mod = await import(
      pathToFileURL(join(repoRoot, "src", "audit", "cli", moduleFile)).href
    );
    expect(typeof mod[exportName], `${moduleFile} should export a function named '${exportName}'`).toBe("function");
  });
}

test("every routed verb pairs with exactly one module row", () => {
  const routed = [...KNOWN_COMMANDS].sort();
  const paired = cmdModuleMap.map(([verb]) => verb).sort();
  expect(paired).toEqual(routed);
});

test.each(["--help", "-h"])("help-looking positionals after -- do not bypass validation: %s", async flag => {
  const result = await captureConsole(() => runCli([process.execPath, "cli.js", "status", "--", flag]));
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`unexpected positional argument ${flag}`);
  expect(result.stdout).not.toContain("Usage:");
});

test.each(["--help", "-h"])("help before -- still displays command help: %s", async flag => {
  const result = await captureConsole(() => runCli([process.execPath, "cli.js", "status", flag, "--", "literal"]));
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Usage: audit-code status");
});

test.each(["--help", "-h"])("top-level help remains available: %s", async flag => {
  const result = await captureConsole(() => runCli([process.execPath, "cli.js", flag]));
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Usage: audit-code <command>");
});

test.each(["explain-task", "requeue", "update-runtime-validation", "validate-results"])(
  "retired command %s is not recognized or advertised", async (verb) => {
    const result = await captureConsole(() => runCli([process.execPath, "cli.js", verb]));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Unknown command: ${verb}`);
    expect(KNOWN_COMMANDS).not.toContain(verb);
  },
);

test("bare backend invocation shows help without invoking sample-run", async () => {
  const result = await captureConsole(() => runCli([process.execPath, "cli.js"]));
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Usage: audit-code <command>");
  expect(result.stdout).toContain("sample-run");
  expect(result.stdout).not.toContain("artifacts_dir");
  expect(result.stderr).toBe("");
});