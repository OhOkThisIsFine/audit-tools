import test from "node:test";
import assert from "node:assert/strict";

const { applyTemplate, SubprocessTemplateProvider } = await import(
  "../src/providers/subprocessTemplateProvider.ts"
);
const { RunLogger } = await import("../src/observability/runLog.ts");

// Minimal LaunchFreshSessionInput-shaped object used across tests.
function buildInput(repoRoot = "/repo") {
  return {
    repoRoot,
    runId: "run-1",
    obligationId: "audit_tasks_completed",
    promptPath: "/repo/prompt.md",
    taskPath: "/repo/task.json",
    resultPath: "/repo/result.json",
    stdoutPath: "/repo/stdout.log",
    stderrPath: "/repo/stderr.log",
    uiMode: "headless",
    timeoutMs: 60000,
  };
}

// Minimal WorkerTaskWithCommand-shaped object.
function buildTask(workerCommand = ["node", "/repo/worker.js"]) {
  return { worker_command: workerCommand };
}

const CTX = { providerName: "test-provider", entryIndex: 0, log: RunLogger.disabled() };

// ── wholePlaceholder shortcut ────────────────────────────────────────────────

test("applyTemplate wholePlaceholder: single-token template returns value raw, without shellQuote", () => {
  const input = buildInput("/repo with spaces/and/more");
  const task = buildTask(["cmd", "--flag"]);
  // workerCommandShell is the shell-quoted join of worker_command argv.
  // When the entire template entry is exactly {workerCommandShell}, it must
  // be returned raw — not double-quoted — even though it contains spaces.
  const result = applyTemplate("{workerCommandShell}", input, task, CTX);
  // The raw value is shellQuote("cmd") + " " + shellQuote("--flag").
  // Under non-win32 that's: "cmd --flag" (single-quotes around each).
  // The whole-placeholder path must NOT add another layer of quoting.
  assert.ok(typeof result === "string" && result.length > 0);
  // The result must equal what the raw workerCommandShell value is —
  // it must NOT be additionally shell-quoted (no surrounding single/double quotes wrapping the whole string).
  const task2 = buildTask(["my script"]);
  const raw = applyTemplate("{workerCommandShell}", input, task2, CTX);
  // On any platform the outer shellQuote would add quotes around the whole;
  // confirm the raw value equals just the inner quoted argv join without an outer wrap.
  const shellJoined = applyTemplate(
    "prefix {workerCommandShell}",
    input,
    task2,
    CTX,
  );
  // In a multi-token template the workerCommandShell key still bypasses shellQuote
  // (Shell-suffix rule), so the last part of shellJoined equals raw.
  assert.ok(shellJoined.endsWith(raw), "Shell-suffix bypass holds in multi-token template too");
});

test("applyTemplate wholePlaceholder: repoRoot with spaces IS shell-quoted in multi-token template, but not when sole token", () => {
  const input = buildInput("/path with spaces");
  const task = buildTask(["node", "worker.js"]);
  // Whole placeholder → raw (no extra quoting)
  const whole = applyTemplate("{repoRoot}", input, task, CTX);
  assert.equal(whole, "/path with spaces");

  // Multi-token template → shellQuoted because repoRoot does not end in Shell
  const multi = applyTemplate("cmd --root {repoRoot}", input, task, CTX);
  assert.ok(multi.includes("path with spaces"), "value appears in output");
  assert.notEqual(multi, "cmd --root /path with spaces");
});

// ── Shell-suffix bypass ──────────────────────────────────────────────────────

test("applyTemplate Shell-suffix bypass: keys ending in Shell are not shellQuoted in multi-token templates", () => {
  const input = buildInput("/repo");
  // A worker_command with spaces inside an arg
  const task = buildTask(["node", "/path with spaces/worker.js"]);
  // In a multi-token entry the workerCommandShell substitution should be raw
  const result = applyTemplate("run {workerCommandShell} --done", input, task, CTX);
  // The Shell-suffix bypass means {workerCommandShell} substitutes the
  // pre-assembled shell string RAW — identical to its sole-token rendering and
  // never wrapped in an additional shell-quote layer. Comparing the two
  // renderings keeps this platform-agnostic (POSIX single-quote vs win32
  // double-quote escaping both round-trip the same way; a leading/trailing
  // quote on the value itself is not "outer" quoting).
  const raw = applyTemplate("{workerCommandShell}", input, task, CTX);
  assert.ok(raw.length > 0);
  assert.equal(result, `run ${raw} --done`, "workerCommandShell is substituted raw, not re-quoted");
});

// ── Unknown placeholder: routes to RunLogger, not console.warn ───────────────

test("applyTemplate unknown placeholder: routes to RunLogger instead of console.warn, substitutes empty string", async () => {
  const input = buildInput("/repo");
  const task = buildTask(["node", "worker.js"]);
  // Capture events via a spy RunLogger backed by a temp file we read back.
  const { writeFileSync, mkdirSync, rmSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const tmpDir = join(tmpdir(), "stp-test-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });
  const logPath = join(tmpDir, "run.log");
  const logger = new RunLogger(logPath);

  // Patch console.warn to assert it is NOT called.
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  let result;
  try {
    result = applyTemplate("cmd {noSuchKey} --flag", input, task, {
      providerName: "test-provider",
      entryIndex: 0,
      log: logger,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 0, "console.warn must not be called");
  assert.equal(result, "cmd  --flag", "unknown placeholder substitutes empty string");

  // The log file should contain exactly one event line with kind=error and the placeholder.
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "exactly one log event emitted");
  const event = JSON.parse(lines[0]);
  assert.equal(event.kind, "error");
  assert.ok(
    event.note.includes("applyTemplate: unknown placeholder {noSuchKey}"),
    `note contains placeholder: ${event.note}`,
  );
  assert.equal(event.provider, "test-provider");

  rmSync(tmpDir, { recursive: true, force: true });
});

test("applyTemplate unknown placeholder: no error thrown and no log event when RunLogger is disabled", () => {
  const input = buildInput("/repo");
  const task = buildTask(["node", "worker.js"]);
  const logger = RunLogger.disabled();
  // Should not throw; result must be the template with placeholder resolved to "".
  const result = applyTemplate("cmd {noSuchKey} --flag", input, task, {
    providerName: "test-provider",
    entryIndex: 0,
    log: logger,
  });
  assert.equal(result, "cmd  --flag");
});

// ── Known non-Shell placeholder: shellQuoted in multi-token template ─────────

test("applyTemplate known non-Shell placeholder: value is shellQuoted in multi-token template", () => {
  const input = buildInput("/root with spaces");
  const task = buildTask(["node", "worker.js"]);
  // repoRoot does not end in 'Shell', so in a multi-token template it is shell-quoted.
  const result = applyTemplate("launch {repoRoot} --go", input, task, CTX);
  // On POSIX, shellQuote wraps in single quotes; on win32 it uses cmd escaping.
  // Either way the raw unquoted value "/root with spaces" must not appear verbatim
  // as a bare unquoted token (i.e. the output must differ from the unquoted form).
  assert.notEqual(result, "launch /root with spaces --go");
  // The root does appear (possibly quoted) in the output.
  assert.ok(result.includes("root with spaces"), "value appears in output");
  // Whole-placeholder test: {repoRoot} alone returns the raw value (no quoting).
  const wholeResult = applyTemplate("{repoRoot}", input, task, CTX);
  assert.equal(wholeResult, "/root with spaces");
});

// ── SubprocessTemplateProvider RunLogger constructor integration ──────────────

test("SubprocessTemplateProvider: unknown placeholder routes to RunLogger, not console.warn, when runLogger is provided", async (t) => {
  const { writeFileSync, mkdirSync, rmSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const tmpDir = join(tmpdir(), "stp-rl-test-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });

  // Write a minimal task file so readJsonFile succeeds.
  const taskPath = join(tmpDir, "task.json");
  writeFileSync(taskPath, JSON.stringify({ worker_command: ["node", "worker.js"] }));

  const logPath = join(tmpDir, "run.log");
  const logger = new RunLogger(logPath);

  const calls = [];
  const provider = new SubprocessTemplateProvider(
    { command_template: ["{unknownKey}"] },
    "test-provider",
    async (command, args, launchInput) => {
      calls.push({ command, args });
      return { exitCode: 0, durationMs: 0, stdout: "", stderr: "" };
    },
    {},
    logger,
  );

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await provider.launch({
      repoRoot: tmpDir,
      runId: "run-42",
      obligationId: "test_obligation",
      promptPath: join(tmpDir, "prompt.md"),
      taskPath,
      resultPath: join(tmpDir, "result.json"),
      stdoutPath: join(tmpDir, "stdout.log"),
      stderrPath: join(tmpDir, "stderr.log"),
      uiMode: "headless",
      timeoutMs: 60000,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 0, "console.warn must not be called");

  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "exactly one log event emitted");
  const event = JSON.parse(lines[0]);
  assert.equal(event.kind, "error");
  assert.ok(
    event.note.includes("applyTemplate: unknown placeholder {unknownKey}"),
    `note contains placeholder: ${event.note}`,
  );

  rmSync(tmpDir, { recursive: true, force: true });
});

test("SubprocessTemplateProvider: no error thrown when no runLogger and unknown placeholder encountered", async (t) => {
  const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const tmpDir = join(tmpdir(), "stp-norl-test-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });

  const taskPath = join(tmpDir, "task.json");
  writeFileSync(taskPath, JSON.stringify({ worker_command: ["node", "worker.js"] }));

  // No runLogger argument — defaults to RunLogger.disabled().
  const provider = new SubprocessTemplateProvider(
    { command_template: ["{unknownKey}"] },
    "test-provider",
    async () => ({ exitCode: 0, durationMs: 0, stdout: "", stderr: "" }),
  );

  // Must complete without throwing; placeholder resolves to empty string.
  await provider.launch({
    repoRoot: tmpDir,
    runId: "run-x",
    obligationId: undefined,
    promptPath: join(tmpDir, "prompt.md"),
    taskPath,
    resultPath: join(tmpDir, "result.json"),
    stdoutPath: join(tmpDir, "stdout.log"),
    stderrPath: join(tmpDir, "stderr.log"),
    uiMode: "headless",
    timeoutMs: 60000,
  });

  rmSync(tmpDir, { recursive: true, force: true });
});
