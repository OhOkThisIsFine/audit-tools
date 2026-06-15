import test from "node:test";
import assert from "node:assert/strict";

const {
  resolveExecArgv,
  quoteForCmd,
  shellQuote,
  platformCommand,
  runTracked,
  stripClaudeCodeEnv,
  renderPromptCommand,
  toPromptPathToken,
  coerceJsonObjectArg,
} = await import("../src/tooling/exec.ts");

test("platformCommand maps package-manager shims to .cmd on win32 only", () => {
  assert.equal(platformCommand("npm", "win32"), "npm.cmd");
  assert.equal(platformCommand("npx", "win32"), "npx.cmd");
  assert.equal(platformCommand("pnpm", "win32"), "pnpm.cmd");
  assert.equal(platformCommand("yarn", "win32"), "yarn.cmd");
  assert.equal(platformCommand("git", "win32"), "git");
  assert.equal(platformCommand("node.exe", "win32"), "node.exe");
  assert.equal(platformCommand("npm", "linux"), "npm");
});

test("quoteForCmd quotes whitespace and escapes quotes", () => {
  assert.equal(quoteForCmd("plain"), "plain");
  assert.equal(quoteForCmd(""), '""');
  assert.equal(quoteForCmd("a b"), '"a b"');
  assert.equal(quoteForCmd('a"b'), '"a""b"');
});

test("shellQuote uses cmd.exe quoting on win32 and POSIX quoting elsewhere", () => {
  assert.equal(shellQuote("plain", "win32"), "plain");
  assert.equal(shellQuote("a b", "win32"), '"a b"');
  assert.equal(shellQuote('a"b', "win32"), '"a""b"');
  assert.equal(shellQuote("a b", "linux"), "'a b'");
  assert.equal(shellQuote("it's", "linux"), "'it'\\''s'");
});

test("renderPromptCommand normalizes only path-like Windows command tokens", () => {
  assert.equal(
    renderPromptCommand(["node", "C:\\Code\\audit-tools\\packages\\audit-code\\audit-code.mjs"]),
    "node C:/Code/audit-tools/packages/audit-code/audit-code.mjs",
  );
  assert.equal(
    renderPromptCommand(["node", "packages\\audit-code\\audit-code.mjs"]),
    "node packages/audit-code/audit-code.mjs",
  );
  assert.equal(
    renderPromptCommand(["node", "C:\\Path With Spaces\\tool.mjs", "--flag", 'a"b']),
    'node "C:/Path With Spaces/tool.mjs" --flag "a\\"b"',
  );
  assert.equal(toPromptPathToken(String.raw`^\d+\w+$`), String.raw`^\d+\w+$`);
  assert.equal(
    renderPromptCommand(["node", String.raw`if (x) console.log("\n")`]),
    String.raw`node "if (x) console.log(\"\n\")"`,
  );
});

test("coerceJsonObjectArg accepts object or JSON object string and rejects arrays", () => {
  assert.deepEqual(coerceJsonObjectArg({ root: "C:/repo" }, "options"), {
    root: "C:/repo",
  });
  assert.deepEqual(coerceJsonObjectArg('{"root":"C:/repo"}', "options"), {
    root: "C:/repo",
  });
  assert.throws(
    () => coerceJsonObjectArg("[1,2]", "options"),
    /options must be an object or JSON object string/i,
  );
  assert.throws(
    () => coerceJsonObjectArg("{bad", "options"),
    /options must be an object or JSON object string/i,
  );
});

test("resolveExecArgv wraps batch shims through cmd.exe on win32", () => {
  const argv = resolveExecArgv(["npm", "run", "build"], { platform: "win32" });
  const shell = process.env.ComSpec ?? "cmd.exe";
  assert.equal(argv[0], shell);
  assert.deepEqual(argv.slice(1, 4), ["/d", "/s", "/c"]);
  assert.equal(argv[4], "npm.cmd run build");
});

test("resolveExecArgv is a passthrough on non-win32", () => {
  assert.deepEqual(resolveExecArgv(["npm", "run", "build"], { platform: "linux" }), [
    "npm",
    "run",
    "build",
  ]);
  // A plain executable (no shim, no batch ext) is unchanged even on win32.
  assert.deepEqual(resolveExecArgv(["git", "status"], { platform: "win32" }), [
    "git",
    "status",
  ]);
});

test("resolveExecArgv tolerates an empty argv", () => {
  assert.deepEqual(resolveExecArgv([]), []);
});

// ── runTracked result fields ──────────────────────────────────────────────────

test("runTracked result includes cwd when option is provided", () => {
  const result = runTracked(["node", "--version"], { cwd: process.cwd() });
  assert.equal(result.cwd, process.cwd());
});

test("runTracked result has cwd undefined when no cwd option is passed", () => {
  const result = runTracked(["node", "--version"]);
  assert.equal(result.cwd, undefined);
});

test("runTracked result includes duration_ms as a non-negative number", () => {
  const result = runTracked(["node", "--version"]);
  assert.equal(typeof result.duration_ms, "number");
  assert.ok(result.duration_ms >= 0);
});

test("runTracked empty-argv early-return path includes duration_ms of 0", () => {
  const result = runTracked([]);
  assert.equal(result.duration_ms, 0);
  assert.equal(result.cwd, undefined);
});

// ── stripClaudeCodeEnv unit tests ─────────────────────────────────────────────

test("stripClaudeCodeEnv removes CLAUDECODE and CLAUDE_CODE* keys", () => {
  const input = {
    PATH: "/usr/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_OTHER: "x",
    // CLAUDE_CODEX starts with CLAUDE_CODE so it is also stripped
    CLAUDE_CODEX: "stripped",
    // Keys that do NOT start with CLAUDE_CODE and are not CLAUDECODE are kept
    OTHER_CLAUDE: "kept",
    CLAUDECODEFOO: "kept",
  };
  const result = stripClaudeCodeEnv(input);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "CLAUDECODE"), "CLAUDECODE should be stripped");
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "CLAUDE_CODE_ENTRYPOINT"), "CLAUDE_CODE_ENTRYPOINT should be stripped");
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "CLAUDE_CODE_OTHER"), "CLAUDE_CODE_OTHER should be stripped");
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "CLAUDE_CODEX"), "CLAUDE_CODEX (starts with CLAUDE_CODE) should be stripped");
  assert.equal(result.PATH, "/usr/bin");
  assert.equal(result.OTHER_CLAUDE, "kept");
  // CLAUDECODEFOO does not equal "CLAUDECODE" and does not start with "CLAUDE_CODE" so it is kept
  assert.equal(result.CLAUDECODEFOO, "kept");
});

test("stripClaudeCodeEnv does not mutate the input object", () => {
  const input = { CLAUDECODE: "1", PATH: "/usr/bin" };
  const copy = { ...input };
  stripClaudeCodeEnv(input);
  assert.deepEqual(input, copy);
});

test("stripClaudeCodeEnv with no argument strips from process.env", () => {
  const result = stripClaudeCodeEnv();
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "CLAUDECODE"), "should strip CLAUDECODE from process.env");
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "CLAUDE_CODE_ENTRYPOINT"), "should strip CLAUDE_CODE_ENTRYPOINT from process.env");
});

// ── runTracked env-strip integration (real child process) ────────────────────

test("runTracked child sees neither CLAUDECODE nor CLAUDE_CODE* even when parent env has them", () => {
  // Use node -e to print env keys; detect which env vars are passed through.
  // We inject CLAUDECODE and a CLAUDE_CODE_ key into options.env and verify
  // the child doesn't receive them.
  const script = [
    "const keys = Object.keys(process.env);",
    "const found = keys.filter(k => k === 'CLAUDECODE' || /^CLAUDE_CODE/.test(k));",
    "process.stdout.write(JSON.stringify(found));",
  ].join(" ");

  // Test 1: explicit env with CLAUDECODE injected
  const explicitEnv = {
    ...process.env,
    CLAUDECODE: "1",
    CLAUDE_CODE_TEST_KEY: "should-not-appear",
  };
  const result1 = runTracked(["node", "-e", script], { env: explicitEnv });
  assert.equal(result1.status, 0, `node exited non-zero: ${result1.stderr}`);
  const found1 = JSON.parse(result1.stdout);
  assert.deepEqual(found1, [], `child saw CLAUDE* keys with explicit env: ${JSON.stringify(found1)}`);

  // Test 2: no explicit env (inherits process.env) — CLAUDECODE is unset in this
  // test process (runner must unset it), so result should also be empty.
  const result2 = runTracked(["node", "-e", script]);
  assert.equal(result2.status, 0, `node exited non-zero: ${result2.stderr}`);
  const found2 = JSON.parse(result2.stdout);
  assert.deepEqual(found2, [], `child saw CLAUDE* keys with inherited env: ${JSON.stringify(found2)}`);
});
