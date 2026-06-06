import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureConsole } from "./helpers/captureConsole.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const { cliTestUtils, runCli } = await import("../src/cli.ts");
const { runFirstAvailableCommand } = await import("../src/orchestrator/localCommands.ts");

async function captureRunCli(argv) {
  const result = await captureConsole(() => runCli(argv));
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
}

test("CLI flag parsing falls back when values are missing or malformed", () => {
  assert.equal(
    cliTestUtils.getFlag(
      ["node", "cli", "plan", "--root", "repo"],
      "--root",
    ),
    "repo",
  );
  assert.equal(
    cliTestUtils.getFlag(
      ["node", "cli", "plan", "--root", "--artifacts-dir", "out"],
      "--root",
      ".",
    ),
    ".",
  );
  assert.equal(
    cliTestUtils.getFlag(["node", "cli", "plan", "--root"], "--root", "."),
    ".",
  );
  assert.equal(cliTestUtils.getUiMode(["node", "cli", "--ui", "visible"]), "visible");
  assert.equal(
    cliTestUtils.getUiMode(["node", "cli", "--ui", "unsupported"], "visible"),
    "visible",
  );
});

test("CLI numeric options prefer argv, then session config, then documented defaults", () => {
  const sessionConfig = {
    agent_task_batch_size: 3,
    parallel_workers: 4,
    timeout_ms: 9_000,
  };

  assert.equal(cliTestUtils.getMaxRuns(["node", "cli", "--max-runs", "7"]), 7);
  assert.equal(
    cliTestUtils.getMaxRuns(["node", "cli", "--max-runs", "0"]),
    cliTestUtils.defaults.maxRuns,
  );
  assert.equal(
    cliTestUtils.getMaxRuns(["node", "cli", "--max-runs", "NaN"]),
    cliTestUtils.defaults.maxRuns,
  );

  assert.equal(
    cliTestUtils.getAgentBatchSize(
      ["node", "cli", "--agent-batch-size", "2"],
      sessionConfig,
    ),
    2,
  );
  assert.equal(
    cliTestUtils.getAgentBatchSize(
      ["node", "cli", "--agent-batch-size", "-1"],
      sessionConfig,
    ),
    3,
  );
  assert.equal(cliTestUtils.getAgentBatchSize(["node", "cli"], {}), 6);

  assert.equal(
    cliTestUtils.getParallelWorkers(
      ["node", "cli", "--parallel", "6"],
      sessionConfig,
    ),
    6,
  );
  assert.equal(
    cliTestUtils.getParallelWorkers(
      ["node", "cli", "--parallel", "0"],
      sessionConfig,
    ),
    4,
  );
  assert.equal(cliTestUtils.getParallelWorkers(["node", "cli"], {}), 1);

  assert.equal(
    cliTestUtils.getTimeoutMs(["node", "cli", "--timeout", "1200"], sessionConfig),
    1200,
  );
  assert.equal(
    cliTestUtils.getTimeoutMs(["node", "cli", "--timeout", "oops"], sessionConfig),
    9_000,
  );
  assert.equal(
    cliTestUtils.getTimeoutMs(["node", "cli"], {}),
    cliTestUtils.defaults.timeoutMs,
  );
});

test("CLI helper utilities chunk arrays and count lines deterministically", async () => {
  assert.deepEqual(cliTestUtils.chunkArray([1, 2, 3, 4, 5], 2), [
    [1, 2],
    [3, 4],
    [5],
  ]);
  assert.throws(
    () => cliTestUtils.chunkArray([1, 2, 3], 0),
    /positive integer/i,
  );

  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-cli-lines-"));
  try {
    const emptyFile = join(tempDir, "empty.txt");
    const trailingNewlineFile = join(tempDir, "trailing.txt");
    const noTrailingNewlineFile = join(tempDir, "no-trailing.txt");

    await writeFile(emptyFile, "");
    await writeFile(trailingNewlineFile, "alpha\nbeta\n");
    await writeFile(noTrailingNewlineFile, "alpha\nbeta");

    assert.equal(await cliTestUtils.countLines(emptyFile), 0);
    assert.equal(await cliTestUtils.countLines(trailingNewlineFile), 2);
    assert.equal(await cliTestUtils.countLines(noTrailingNewlineFile), 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-to-completion starts intake for manifestless source repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-code-manifestless-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.js"), "export const ok = true;\n");

    const result = await captureRunCli([
      process.execPath,
      join(repoRoot, "dist", "cli.js"),
      "run-to-completion",
      "--root",
      root,
      "--artifacts-dir",
      join(root, ".audit-artifacts"),
      "--max-runs",
      "1",
    ]);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.selected_executor, "intake_executor");
    assert.equal(parsed.audit_state.status, "active");
    assert.ok(parsed.artifacts_written.includes("repo_manifest.json"));
    assert.ok(parsed.artifacts_written.includes("file_disposition.json"));
    assert.doesNotMatch(result.stdout + result.stderr, /No recognisable project signals/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run-to-completion blocks empty or documentation-only repositories after intake validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-code-no-auditable-"));
  try {
    await writeFile(join(root, "README.md"), "# Notes only\n");

    const result = await captureRunCli([
      process.execPath,
      join(repoRoot, "dist", "cli.js"),
      "run-to-completion",
      "--root",
      root,
      "--artifacts-dir",
      join(root, ".audit-artifacts"),
      "--max-runs",
      "1",
    ]);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.selected_executor, "intake_executor");
    assert.equal(parsed.audit_state.status, "blocked");
    assert.match(parsed.progress_summary, /No auditable files found/);
    assert.doesNotMatch(parsed.progress_summary, /No recognisable project signals/i);
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

    assert.ok(result);
    assert.match(result.candidate.command, /fixture-tool\.cmd$/i);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /pathext-shim/);
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
    let stderrOutput = "";
    const originalWarn = console.warn;
    console.warn = (...args) => {
      stderrOutput += args.join(" ") + "\n";
    };
    try {
      cliTestUtils.warnIfNotGitRepo(tempDir);
    } finally {
      console.warn = originalWarn;
    }
    assert.match(stderrOutput, /does not appear to be a git repository/);
    assert.match(stderrOutput, new RegExp(tempDir.replace(/\\/g, "\\\\")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("warnIfNotGitRepo emits warning to stderr (console.warn), not stdout", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-no-git-stderr-"));
  try {
    let stdoutOutput = "";
    let stderrOutput = "";
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args) => {
      stdoutOutput += args.join(" ") + "\n";
    };
    console.warn = (...args) => {
      stderrOutput += args.join(" ") + "\n";
    };
    try {
      cliTestUtils.warnIfNotGitRepo(tempDir);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    assert.equal(stdoutOutput, "", "warning must not go to stdout");
    assert.match(stderrOutput, /does not appear to be a git repository/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("warnIfNotGitRepo does not throw — execution continues after warning", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-no-git-nothrow-"));
  try {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.doesNotThrow(() => cliTestUtils.warnIfNotGitRepo(tempDir));
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("warnIfNotGitRepo emits no warning when .git directory is present", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-with-git-dir-"));
  try {
    await mkdir(join(tempDir, ".git"), { recursive: true });
    let stderrOutput = "";
    const originalWarn = console.warn;
    console.warn = (...args) => {
      stderrOutput += args.join(" ") + "\n";
    };
    try {
      cliTestUtils.warnIfNotGitRepo(tempDir);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(stderrOutput, "", "no warning expected for a valid git repo");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("warnIfNotGitRepo emits no warning when .git file is present (git worktree)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-with-git-file-"));
  try {
    // git worktrees create a .git file (not a directory) pointing to the main repo
    await writeFile(join(tempDir, ".git"), "gitdir: /some/other/repo/.git/worktrees/branch\n");
    let stderrOutput = "";
    const originalWarn = console.warn;
    console.warn = (...args) => {
      stderrOutput += args.join(" ") + "\n";
    };
    try {
      cliTestUtils.warnIfNotGitRepo(tempDir);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(stderrOutput, "", "no warning expected for a git worktree (.git file)");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli reports unknown commands without throwing", async () => {
  const result = await captureConsole(() =>
    runCli([
      process.execPath,
      join(repoRoot, "dist", "cli.js"),
      "definitely-unknown",
    ]),
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command: definitely-unknown/);
  assert.match(result.stderr, /Available commands:/);
});

test("each extracted command module exports the expected function (ARC-3579b443)", async () => {
  const { pathToFileURL } = await import("node:url");
  const { join: pathJoin } = await import("node:path");
  const distDir = pathJoin(repoRoot, "dist", "cli");
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
    assert.equal(
      typeof mod[exportName],
      "function",
      `${file} must export ${exportName} as a function`,
    );
  }
});

test("cli.ts main dispatcher sets exitCode=1 for unknown command without throwing (ARC-3579b443)", async () => {
  const result = await captureConsole(() =>
    runCli([
      process.execPath,
      join(repoRoot, "dist", "cli.js"),
      "arc-3579b443-unknown-command",
    ]),
  );
  assert.equal(result.code, 1, "unknown command must set exitCode=1");
  assert.match(result.stderr, /Unknown command: arc-3579b443-unknown-command/);
});
