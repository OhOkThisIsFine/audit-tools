import { test, expect } from "vitest";
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
} = await import("../../src/shared/tooling/exec.ts");

test("platformCommand maps package-manager shims to .cmd on win32 only", () => {
  expect(platformCommand("npm", "win32")).toBe("npm.cmd");
  expect(platformCommand("npx", "win32")).toBe("npx.cmd");
  expect(platformCommand("pnpm", "win32")).toBe("pnpm.cmd");
  expect(platformCommand("yarn", "win32")).toBe("yarn.cmd");
  expect(platformCommand("git", "win32")).toBe("git");
  expect(platformCommand("node.exe", "win32")).toBe("node.exe");
  expect(platformCommand("npm", "linux")).toBe("npm");
});

test("quoteForCmd quotes whitespace and escapes quotes", () => {
  expect(quoteForCmd("plain")).toBe("plain");
  expect(quoteForCmd("")).toBe('""');
  expect(quoteForCmd("a b")).toBe('"a b"');
  expect(quoteForCmd('a"b')).toBe('"a""b"');
});

test("shellQuote uses cmd.exe quoting on win32 and POSIX quoting elsewhere", () => {
  expect(shellQuote("plain", "win32")).toBe("plain");
  expect(shellQuote("a b", "win32")).toBe('"a b"');
  expect(shellQuote('a"b', "win32")).toBe('"a""b"');
  expect(shellQuote("a b", "linux")).toBe("'a b'");
  expect(shellQuote("it's", "linux")).toBe("'it'\\''s'");
});

test("renderPromptCommand normalizes only path-like Windows command tokens", () => {
  expect(renderPromptCommand(["node", "C:\\Code\\audit-tools\\packages\\audit-code\\audit-code.mjs"])).toBe("node C:/Code/audit-tools/packages/audit-code/audit-code.mjs");
  expect(renderPromptCommand(["node", "packages\\audit-code\\audit-code.mjs"])).toBe("node packages/audit-code/audit-code.mjs");
  expect(renderPromptCommand(["node", "C:\\Path With Spaces\\tool.mjs", "--flag", 'a"b'])).toBe('node "C:/Path With Spaces/tool.mjs" --flag "a\\"b"');
  expect(toPromptPathToken(String.raw`^\d+\w+$`)).toBe(String.raw`^\d+\w+$`);
  expect(renderPromptCommand(["node", String.raw`if (x) console.log("\n")`])).toBe(String.raw`node "if (x) console.log(\"\n\")"`);
});

test("coerceJsonObjectArg accepts object or JSON object string and rejects arrays", () => {
  expect(coerceJsonObjectArg({ root: "C:/repo" }, "options")).toEqual({
    root: "C:/repo",
  });
  expect(coerceJsonObjectArg('{"root":"C:/repo"}', "options")).toEqual({
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
  expect(argv[0]).toBe(shell);
  expect(argv.slice(1, 4)).toEqual(["/d", "/s", "/c"]);
  expect(argv[4]).toBe("npm.cmd run build");
});

test("resolveExecArgv is a passthrough on non-win32", () => {
  expect(resolveExecArgv(["npm", "run", "build"], { platform: "linux" })).toEqual([
    "npm",
    "run",
    "build",
  ]);
  // A plain executable (no shim, no batch ext) is unchanged even on win32.
  expect(resolveExecArgv(["git", "status"], { platform: "win32" })).toEqual([
    "git",
    "status",
  ]);
});

test("resolveExecArgv tolerates an empty argv", () => {
  expect(resolveExecArgv([])).toEqual([]);
});

// ── runTracked result fields ──────────────────────────────────────────────────

test("runTracked result includes cwd when option is provided", () => {
  const result = runTracked(["node", "--version"], { cwd: process.cwd() });
  expect(result.cwd).toBe(process.cwd());
});

test("runTracked result has cwd undefined when no cwd option is passed", () => {
  const result = runTracked(["node", "--version"]);
  expect(result.cwd).toBe(undefined);
});

test("runTracked result includes duration_ms as a non-negative number", () => {
  const result = runTracked(["node", "--version"]);
  expect(typeof result.duration_ms).toBe("number");
  expect(result.duration_ms >= 0).toBeTruthy();
});

test("runTracked empty-argv early-return path includes duration_ms of 0", () => {
  const result = runTracked([]);
  expect(result.duration_ms).toBe(0);
  expect(result.cwd).toBe(undefined);
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
  expect(!Object.prototype.hasOwnProperty.call(result, "CLAUDECODE"), "CLAUDECODE should be stripped").toBeTruthy();
  expect(!Object.prototype.hasOwnProperty.call(result, "CLAUDE_CODE_ENTRYPOINT"), "CLAUDE_CODE_ENTRYPOINT should be stripped").toBeTruthy();
  expect(!Object.prototype.hasOwnProperty.call(result, "CLAUDE_CODE_OTHER"), "CLAUDE_CODE_OTHER should be stripped").toBeTruthy();
  expect(!Object.prototype.hasOwnProperty.call(result, "CLAUDE_CODEX"), "CLAUDE_CODEX (starts with CLAUDE_CODE) should be stripped").toBeTruthy();
  expect(result.PATH).toBe("/usr/bin");
  expect(result.OTHER_CLAUDE).toBe("kept");
  // CLAUDECODEFOO does not equal "CLAUDECODE" and does not start with "CLAUDE_CODE" so it is kept
  expect(result.CLAUDECODEFOO).toBe("kept");
});

test("stripClaudeCodeEnv does not mutate the input object", () => {
  const input = { CLAUDECODE: "1", PATH: "/usr/bin" };
  const copy = { ...input };
  stripClaudeCodeEnv(input);
  expect(input).toEqual(copy);
});

test("stripClaudeCodeEnv with no argument strips from process.env", () => {
  const result = stripClaudeCodeEnv();
  expect(!Object.prototype.hasOwnProperty.call(result, "CLAUDECODE"), "should strip CLAUDECODE from process.env").toBeTruthy();
  expect(!Object.prototype.hasOwnProperty.call(result, "CLAUDE_CODE_ENTRYPOINT"), "should strip CLAUDE_CODE_ENTRYPOINT from process.env").toBeTruthy();
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
  expect(result1.status, `node exited non-zero: ${result1.stderr}`).toBe(0);
  const found1 = JSON.parse(result1.stdout);
  expect(found1, `child saw CLAUDE* keys with explicit env: ${JSON.stringify(found1)}`).toEqual([]);

  // Test 2: no explicit env (inherits process.env) — CLAUDECODE is unset in this
  // test process (runner must unset it), so result should also be empty.
  const result2 = runTracked(["node", "-e", script]);
  expect(result2.status, `node exited non-zero: ${result2.stderr}`).toBe(0);
  const found2 = JSON.parse(result2.stdout);
  expect(found2, `child saw CLAUDE* keys with inherited env: ${JSON.stringify(found2)}`).toEqual([]);
});
