import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureConsole } from "./helpers/captureConsole.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const { cliTestUtils, runCli } = await import("../../src/audit/cli.ts");
const { runFirstAvailableCommand } = await import("../../src/audit/orchestrator/localCommands.ts");

async function captureRunCli(argv) {
  const result = await captureConsole(() => runCli(argv));
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
}

/**
 * Captures all console.warn calls made during fn(), restores console.warn
 * afterward (even on throw), and returns the captured output as a string.
 *
 * @param {() => void} fn  Synchronous function under test.
 * @returns {string}  Concatenated warn output.
 */
function withCapturedWarn(fn) {
  let output = "";
  const originalWarn = console.warn;
  console.warn = (...args) => {
    output += args.join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    console.warn = originalWarn;
  }
  return output;
}

test("CLI flag parsing falls back when values are missing or malformed", () => {
  expect(cliTestUtils.getFlag(
      ["node", "cli", "plan", "--root", "repo"],
      "--root",
    )).toBe("repo");
  expect(cliTestUtils.getFlag(
      ["node", "cli", "plan", "--root", "--artifacts-dir", "out"],
      "--root",
      ".",
    )).toBe(".");
  expect(cliTestUtils.getFlag(["node", "cli", "plan", "--root"], "--root", ".")).toBe(".");
});

test("ingest-results rejects a value-less --results alongside --batch-results (COR-79283e3b)", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "ingest-mutex-"));
  try {
    // `--results` is present as a token but value-less (the next token is the
    // end of argv). The mutual-exclusion guard must still fire rather than
    // silently running the batch path. runCli catches the thrown Error, prints
    // its message to stderr, and sets exitCode=1.
    const { stderr, exitCode } = await captureRunCli([
      "node",
      "cli",
      "ingest-results",
      "--batch-results",
      tempRoot,
      "--results",
    ]);
    expect(stderr).toMatch(/not both/i);
    expect(exitCode).toBe(1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI numeric options prefer argv, then session config, then documented defaults", () => {
  const sessionConfig = {
    timeout_ms: 9_000,
  };

  expect(cliTestUtils.getTimeoutMs(["node", "cli", "--timeout", "1200"], sessionConfig)).toBe(1200);
  expect(cliTestUtils.getTimeoutMs(["node", "cli", "--timeout", "oops"], sessionConfig)).toBe(9_000);
  expect(cliTestUtils.getTimeoutMs(["node", "cli"], {})).toBe(cliTestUtils.defaults.timeoutMs);
});

test("CLI helper utilities count lines deterministically", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-cli-lines-"));
  try {
    const emptyFile = join(tempDir, "empty.txt");
    const trailingNewlineFile = join(tempDir, "trailing.txt");
    const noTrailingNewlineFile = join(tempDir, "no-trailing.txt");

    await writeFile(emptyFile, "");
    await writeFile(trailingNewlineFile, "alpha\nbeta\n");
    await writeFile(noTrailingNewlineFile, "alpha\nbeta");

    expect(await cliTestUtils.countLines(emptyFile)).toBe(0);
    expect(await cliTestUtils.countLines(trailingNewlineFile)).toBe(2);
    expect(await cliTestUtils.countLines(noTrailingNewlineFile)).toBe(2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("next-step starts intake for manifestless source repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-code-manifestless-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.js"), "export const ok = true;\n");

    const artifactsDir = join(root, ".audit-tools/audit");
    // next-step advances the deterministic spine: provider confirmation
    // auto-completes headlessly, then intake builds the repo manifest and file
    // disposition before the run pauses at its first host step.
    const result = await captureRunCli([
      process.execPath,
      join(repoRoot, "dist", "audit", "cli.js"),
      "next-step",
      "--root",
      root,
      "--artifacts-dir",
      artifactsDir,
    ]);

    expect(result.exitCode).toBe(0);
    const step = JSON.parse(result.stdout);
    expect(step.contract_version).toBe("audit-code-step/v1alpha1");
    expect(step.status).toBe("ready");
    // Intake ran: the manifest artifacts exist on disk.
    expect((await stat(join(artifactsDir, "repo_manifest.json"))).isFile()).toBe(true);
    expect((await stat(join(artifactsDir, "file_disposition.json"))).isFile()).toBe(true);
    expect(result.stdout + result.stderr).not.toMatch(/No recognisable project signals/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("next-step blocks empty or documentation-only repositories after intake validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-code-no-auditable-"));
  try {
    await writeFile(join(root, "README.md"), "# Notes only\n");

    // Intake throws for repositories with no auditable files; next-step
    // surfaces the failure as a non-zero exit with the intake validation
    // message rather than inventing audit work.
    const result = await captureRunCli([
      process.execPath,
      join(repoRoot, "dist", "audit", "cli.js"),
      "next-step",
      "--root",
      root,
      "--artifacts-dir",
      join(root, ".audit-tools/audit"),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/No auditable files found/);
    expect(result.stdout + result.stderr).not.toMatch(/No recognisable project signals/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runFirstAvailableCommand prefers PATHEXT shims over extensionless files on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("PATHEXT resolution is Windows-specific.");
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-local-command-"));
  const previousPath = process.env.PATH;
  const previousPathExt = process.env.PATHEXT;
  try {
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "fixture-tool"), "not a Windows command shim", "utf8");
    await writeFile(
      join(binDir, "fixture-tool.cmd"),
      "@echo off\r\necho pathext-shim\r\n",
      "utf8",
    );

    process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
    process.env.PATHEXT = ".CMD;.EXE";

    const result = runFirstAvailableCommand(tempDir, [
      { command: "fixture-tool", args: [] },
    ]);

    expect(result).toBeTruthy();
    expect(result.candidate.command).toMatch(/fixture-tool\.cmd$/i);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/pathext-shim/);
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousPathExt === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = previousPathExt;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("warnIfNotGitRepo warns to stderr when .git is absent", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-no-git-"));
  try {
    const stderrOutput = withCapturedWarn(() => cliTestUtils.warnIfNotGitRepo(tempDir));
    expect(stderrOutput).toMatch(/does not appear to be a git repository/);
    expect(stderrOutput).toMatch(new RegExp(tempDir.replace(/\\/g, "\\\\")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("warnIfNotGitRepo emits warning to stderr (console.warn), not stdout", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-no-git-stderr-"));
  try {
    // captureConsole captures console.log (stdout) and console.error; withCapturedWarn
    // captures console.warn. Together they let us assert warn → only warn, not log.
    let stdoutOutput = "";
    const originalLog = console.log;
    console.log = (...args) => { stdoutOutput += args.join(" ") + "\n"; };
    let stderrOutput;
    try {
      stderrOutput = withCapturedWarn(() => cliTestUtils.warnIfNotGitRepo(tempDir));
    } finally {
      console.log = originalLog;
    }
    expect(stdoutOutput, "warning must not go to stdout").toBe("");
    expect(stderrOutput).toMatch(/does not appear to be a git repository/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("warnIfNotGitRepo does not throw — execution continues after warning", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-no-git-nothrow-"));
  try {
    assert.doesNotThrow(() => {
      withCapturedWarn(() => cliTestUtils.warnIfNotGitRepo(tempDir));
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("warnIfNotGitRepo emits no warning when .git directory is present", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-with-git-dir-"));
  try {
    await mkdir(join(tempDir, ".git"), { recursive: true });
    const stderrOutput = withCapturedWarn(() => cliTestUtils.warnIfNotGitRepo(tempDir));
    expect(stderrOutput, "no warning expected for a valid git repo").toBe("");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("warnIfNotGitRepo emits no warning when .git file is present (git worktree)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-with-git-file-"));
  try {
    // git worktrees create a .git file (not a directory) pointing to the main repo
    await writeFile(join(tempDir, ".git"), "gitdir: /some/other/repo/.git/worktrees/branch\n");
    const stderrOutput = withCapturedWarn(() => cliTestUtils.warnIfNotGitRepo(tempDir));
    expect(stderrOutput, "no warning expected for a git worktree (.git file)").toBe("");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli reports unknown commands without throwing", async () => {
  const result = await captureConsole(() =>
    runCli([
      process.execPath,
      join(repoRoot, "dist", "audit", "cli.js"),
      "definitely-unknown",
    ]),
  );

  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/Unknown command: definitely-unknown/);
  expect(result.stderr).toMatch(/Available commands:/);
});

test("each extracted command module exports the expected function (ARC-3579b443)", async () => {
  const { pathToFileURL } = await import("node:url");
  const { join: pathJoin } = await import("node:path");
  const distDir = pathJoin(repoRoot, "dist", "audit", "cli");
  const cases = [
    ["advanceAuditCommand.js", "cmdAdvanceAudit"],
    ["prepareDispatchCommand.js", "cmdPrepareDispatch"],
    ["validateResultCommand.js", "cmdValidateResult"],
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
    ["cleanupCommand.js", "cmdCleanup"],
    ["quotaCommand.js", "cmdQuota"],
    ["dispatchStatusCommand.js", "cmdDispatchStatus"],
    ["sampleRunCommand.js", "runSample"],
  ];
  for (const [file, exportName] of cases) {
    const mod = await import(pathToFileURL(pathJoin(distDir, file)).href);
    expect(typeof mod[exportName], `${file} must export ${exportName} as a function`).toBe("function");
  }
});

test("cli.ts main dispatcher sets exitCode=1 for unknown command without throwing (ARC-3579b443)", async () => {
  const result = await captureConsole(() =>
    runCli([
      process.execPath,
      join(repoRoot, "dist", "audit", "cli.js"),
      "arc-3579b443-unknown-command",
    ]),
  );
  expect(result.code, "unknown command must set exitCode=1").toBe(1);
  expect(result.stderr).toMatch(/Unknown command: arc-3579b443-unknown-command/);
});
