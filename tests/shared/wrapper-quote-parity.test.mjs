import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { CMD_METACHAR_CASES, CMD_PERCENT_CASES } from "./fixtures/cmd-metachar-cases.mjs";

// ── anti-drift guard: wrapper/audit-code-wrapper-lib.mjs carries its own copy
// of quoteForCmd (the wrapper runs pre-dist and cannot import TS source — a
// deliberate bootstrap-constraint copy, see the wrapper file's comment). Pin
// its behavior byte-equal to the single-sourced src/shared/tooling/exec.ts
// implementation across a table of cmd.exe-hostile args so the two copies
// can never silently diverge (mirrors the pattern in
// tests/shared/loop-core-gate-parity.test.mjs for the pre-commit-hook copies).

const { quoteForCmd: sharedQuoteForCmd } = await import(
  "../../src/shared/tooling/exec.ts"
);
const { quoteForCmd: wrapperQuoteForCmd, resolveSpawn } = await import(
  "../../wrapper/audit-code-wrapper-lib.mjs"
);
// Single-sourced nasty-arg table (also asserted against the shared
// implementation's exact expected output in tests/shared/exec.test.mjs) so
// the two test files can't quietly diverge on what "nasty" covers.
const NASTY_ARGS = [
  ...CMD_METACHAR_CASES.map((c) => c.arg),
  "plain",
  "C:\\Path With Spaces\\tool.mjs",
];

test("wrapper quoteForCmd stays behaviorally equal to the shared quoteForCmd on ordinary args", () => {
  for (const arg of NASTY_ARGS) {
    expect(wrapperQuoteForCmd(arg), `quoteForCmd(${JSON.stringify(arg)})`).toBe(
      sharedQuoteForCmd(arg),
    );
  }
});

test("wrapper quoteForCmd and shared quoteForCmd both refuse args containing %", () => {
  for (const arg of CMD_PERCENT_CASES) {
    assert.throws(() => wrapperQuoteForCmd(arg), /refusing to quote.*"%"/i);
    assert.throws(() => sharedQuoteForCmd(arg), /refusing to quote.*"%"/i);
  }
});

test("wrapper resolveSpawn wraps .cmd/.bat commands through cmd.exe with caret-escaped metachars", () => {
  // Explicit platform override (mirrors src/shared/tooling/exec.ts's
  // resolveExecArgv({ platform })) so this test is deterministic on any CI
  // runner, not just Windows.
  const resolved = resolveSpawn("npm.cmd", ["run", "build", "a&b"], "win32");
  const shell = process.env.ComSpec ?? "cmd.exe";
  expect(resolved.command).toBe(shell);
  expect(resolved.args).toEqual(["/d", "/s", "/c", "npm.cmd run build a^&b"]);
});

test("wrapper resolveSpawn is a passthrough for non-.cmd/.bat commands and on non-win32", () => {
  expect(resolveSpawn("node", ["--version"], "win32")).toEqual({
    command: "node",
    args: ["--version"],
  });
  expect(resolveSpawn("npm.cmd", ["run", "build"], "linux")).toEqual({
    command: "npm.cmd",
    args: ["run", "build"],
  });
});
