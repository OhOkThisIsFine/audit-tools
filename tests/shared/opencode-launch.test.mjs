import test from "node:test";
import assert from "node:assert/strict";

const { resolveOpenCodeSpawnCommand, resolveWindowsShimSpawnCommand } = await import(
  "../../src/shared/providers/opencodeLaunch.ts"
);

test("resolveOpenCodeSpawnCommand passes through on non-win32", () => {
  assert.deepEqual(
    resolveOpenCodeSpawnCommand("opencode", ["run", "--model", "x"], "linux"),
    { command: "opencode", args: ["run", "--model", "x"] },
  );
});

test("resolveOpenCodeSpawnCommand wraps opencode through cmd.exe on win32", () => {
  const resolved = resolveOpenCodeSpawnCommand(
    "opencode",
    ["run", "--model", "x"],
    "win32",
    "cmd.exe",
  );
  assert.equal(resolved.command, "cmd.exe");
  assert.deepEqual(resolved.args, [
    "/d",
    "/s",
    "/c",
    "opencode run --model x",
  ]);
});

test("resolveOpenCodeSpawnCommand wraps npx and explicit .cmd shims on win32", () => {
  assert.equal(
    resolveOpenCodeSpawnCommand("npx", ["opencode"], "win32", "cmd.exe").command,
    "cmd.exe",
  );
  assert.equal(
    resolveOpenCodeSpawnCommand("opencode.cmd", ["run"], "win32", "cmd.exe")
      .command,
    "cmd.exe",
  );
});

test("resolveOpenCodeSpawnCommand leaves unrelated win32 commands untouched", () => {
  assert.deepEqual(
    resolveOpenCodeSpawnCommand("node.exe", ["run"], "win32", "cmd.exe"),
    { command: "node.exe", args: ["run"] },
  );
});

test("resolveWindowsShimSpawnCommand wraps a bare command outside the allowlist when the PATH probe finds a .cmd shim", () => {
  const probe = (command) => (command === "sometool" ? ".cmd" : undefined);
  const resolved = resolveWindowsShimSpawnCommand(
    "sometool",
    ["--flag"],
    ["opencode", "npx"],
    "win32",
    "cmd.exe",
    probe,
  );
  assert.equal(resolved.command, "cmd.exe");
  assert.deepEqual(resolved.args, ["/d", "/s", "/c", "sometool --flag"]);
});

test("resolveWindowsShimSpawnCommand leaves a bare command untouched when the PATH probe finds no shim", () => {
  const probe = () => undefined;
  assert.deepEqual(
    resolveWindowsShimSpawnCommand(
      "sometool",
      ["--flag"],
      ["opencode", "npx"],
      "win32",
      "cmd.exe",
      probe,
    ),
    { command: "sometool", args: ["--flag"] },
  );
});

test("resolveWindowsShimSpawnCommand never invokes the probe for a command with a recognized extension", () => {
  let probeCalled = false;
  const probe = () => {
    probeCalled = true;
    return undefined;
  };
  resolveWindowsShimSpawnCommand(
    "node.exe",
    ["run"],
    ["opencode", "npx"],
    "win32",
    "cmd.exe",
    probe,
  );
  assert.equal(probeCalled, false, "probe must be short-circuited for a recognized extension");
});
