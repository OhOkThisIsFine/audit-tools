import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { CMD_METACHAR_CASES, CMD_PERCENT_CASES } from "./fixtures/cmd-metachar-cases.mjs";

const {
  resolveExecArgv,
  quoteForCmd,
  shellQuote,
  platformCommand,
  runTracked,
  runTrackedAsync,
  stripAuditToolsControlEnv,
  renderPromptCommand,
  toPromptPathToken,
  coerceJsonObjectArg,
} = await import("../../src/shared/tooling/exec.js");

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

// ── CVE-2024-27980-class hardening: cmd.exe metacharacters must not survive
// unescaped into the `.cmd`/`.bat` shim-wrapping path (`wrapForWindowsBatch`).
// Table-driven; the nasty-arg set is single-sourced (fixtures/cmd-metachar-cases.mjs)
// so tests/shared/wrapper-quote-parity.test.mjs exercises the identical table.
test("quoteForCmd caret-escapes cmd.exe line-scan metacharacters (& | < > ^)", () => {
  for (const { arg, expected } of CMD_METACHAR_CASES) {
    expect(quoteForCmd(arg), `quoteForCmd(${JSON.stringify(arg)})`).toBe(expected);
  }
});

test("quoteForCmd refuses to quote an argument containing % (unsolvable percent-expansion)", () => {
  for (const arg of CMD_PERCENT_CASES) {
    assert.throws(() => quoteForCmd(arg), /refusing to quote.*"%"/i);
  }
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

// ── hardening: quotePromptCommandArg/renderPromptCommand must quote any
// shell-sensitive char (not just whitespace/quote) since the rendered string
// is read by posix sh, PowerShell, and cmd.exe alike, and none of them treat
// `&`, `%`, `|`, etc. as ordinary text outside quotes.
test("renderPromptCommand quotes tokens containing shell metacharacters even without whitespace", () => {
  expect(renderPromptCommand(["echo", "a&b"])).toBe('echo "a&b"');
  expect(renderPromptCommand(["echo", "%PATH%"])).toBe('echo "%PATH%"');
  expect(renderPromptCommand(["echo", "a|b"])).toBe('echo "a|b"');
  expect(renderPromptCommand(["echo", "a;b"])).toBe('echo "a;b"');
  // Plain path-safe tokens (letters/digits/-_./:\\=@,+) stay unquoted.
  expect(renderPromptCommand(["node", "--artifacts-dir", "C:/repo/.audit-tools/audit"])).toBe(
    "node --artifacts-dir C:/repo/.audit-tools/audit",
  );
});

test("renderPromptCommand hardening: paths with spaces and metacharacters render as one safely-quoted token", () => {
  expect(renderPromptCommand(["node", "C:\\Path With Spaces & Stuff\\tool.mjs"])).toBe(
    'node "C:/Path With Spaces & Stuff/tool.mjs"',
  );
  expect(renderPromptCommand(["audit-code", "advance-audit", "--results", "C:\\repo\\audit results 100%.json"])).toBe(
    'audit-code advance-audit --results "C:/repo/audit results 100%.json"',
  );
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
  const result = runTracked(["node", "--version"], { cwd: process.cwd(), timeout: 30_000 });
  expect(result.cwd).toBe(process.cwd());
});

test("runTracked result has cwd undefined when no cwd option is passed", () => {
  const result = runTracked(["node", "--version"], { timeout: 30_000 });
  expect(result.cwd).toBe(undefined);
});

test("runTracked result includes duration_ms as a non-negative number", () => {
  const result = runTracked(["node", "--version"], { timeout: 30_000 });
  expect(typeof result.duration_ms).toBe("number");
  expect(result.duration_ms >= 0).toBeTruthy();
});

test("runTracked empty-argv early-return path includes duration_ms of 0", () => {
  const result = runTracked([], { timeout: 30_000 });
  expect(result.duration_ms).toBe(0);
  expect(result.cwd).toBe(undefined);
});

// ── audit-tools control-env scrubbing ────────────────────────────────────────

test("stripAuditToolsControlEnv removes only the wrapper caller-cwd stamp", () => {
  const input = {
    PATH: "/usr/bin",
    AUDIT_TOOLS_CALLER_CWD: "C:/driver",
    HOST_MARKER: "preserved",
  };
  const result = stripAuditToolsControlEnv(input);
  expect(result.AUDIT_TOOLS_CALLER_CWD).toBeUndefined();
  expect(result.PATH).toBe("/usr/bin");
  expect(result.HOST_MARKER).toBe("preserved");
});

test("stripAuditToolsControlEnv does not mutate the input object", () => {
  const input = { AUDIT_TOOLS_CALLER_CWD: "C:/driver", PATH: "/usr/bin" };
  const copy = { ...input };
  stripAuditToolsControlEnv(input);
  expect(input).toEqual(copy);
});

test("runTrackedAsync survives a child that exits without reading its input (EPIPE)", async () => {
  // A child that exits immediately never reads stdin, so writing `input`
  // raises EPIPE on the stdin stream on POSIX. Unhandled, that stream error
  // crashed the whole process (observed as a worker-killing `write EPIPE`
  // cascade on Linux CI — `git check-ignore --stdin` in a non-repo exits 128
  // without reading). The runner must settle with the child's own exit code
  // instead. Windows pipe buffering can mask the EPIPE, so this test is
  // load-bearing on POSIX and benign on win32.
  const result = await runTrackedAsync(["node", "-e", "process.exit(3)"], {
    input: "x".repeat(1024 * 1024),
    timeout: 30_000,
  });
  expect(result.status).toBe(3);
});

test("runTracked child does not inherit the wrapper caller-cwd stamp", () => {
  const script = "process.stdout.write(String(process.env.AUDIT_TOOLS_CALLER_CWD))";
  const result = runTracked(["node", "-e", script], {
    env: { ...process.env, AUDIT_TOOLS_CALLER_CWD: "C:/driver" },
    timeout: 30_000,
  });
  expect(result.status, `node exited non-zero: ${result.stderr}`).toBe(0);
  expect(result.stdout).toBe("undefined");
});
