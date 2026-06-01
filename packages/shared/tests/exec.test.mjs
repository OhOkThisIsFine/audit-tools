import test from "node:test";
import assert from "node:assert/strict";

const { resolveExecArgv, quoteForCmd, shellQuote, platformCommand } = await import(
  "../dist/tooling/exec.js"
);

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

test("resolveExecArgv applies opentoken wrapping per platform", () => {
  assert.deepEqual(
    resolveExecArgv(["git", "status"], { opentoken: "opentoken", platform: "linux" }),
    ["opentoken", "wrap", "git", "status"],
  );
  const win = resolveExecArgv(["git", "status"], {
    opentoken: "opentoken",
    platform: "win32",
  });
  const shell = process.env.ComSpec ?? "cmd.exe";
  assert.equal(win[0], shell);
  assert.deepEqual(win.slice(1, 4), ["/d", "/s", "/c"]);
  assert.equal(win[4], "opentoken wrap git status");
});

test("resolveExecArgv tolerates an empty argv", () => {
  assert.deepEqual(resolveExecArgv([]), []);
});
