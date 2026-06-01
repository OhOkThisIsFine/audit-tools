import test from "node:test";
import assert from "node:assert/strict";

const { resolveOpenCodeSpawnCommand } = await import(
  "../dist/providers/opencodeLaunch.js"
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
