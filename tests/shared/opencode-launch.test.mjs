import { test, expect } from "vitest";

const { resolveOpenCodeSpawnCommand, resolveWindowsShimSpawnCommand } = await import(
  "../../src/shared/providers/opencodeLaunch.ts"
);

test("resolveOpenCodeSpawnCommand passes through on non-win32", () => {
  expect(resolveOpenCodeSpawnCommand("opencode", ["run", "--model", "x"], "linux")).toEqual({ command: "opencode", args: ["run", "--model", "x"] });
});

test("resolveOpenCodeSpawnCommand wraps opencode through cmd.exe on win32", () => {
  const resolved = resolveOpenCodeSpawnCommand(
    "opencode",
    ["run", "--model", "x"],
    "win32",
    "cmd.exe",
  );
  expect(resolved.command).toBe("cmd.exe");
  expect(resolved.args).toEqual([
    "/d",
    "/s",
    "/c",
    "opencode run --model x",
  ]);
});

test("resolveOpenCodeSpawnCommand wraps npx and explicit .cmd shims on win32", () => {
  expect(resolveOpenCodeSpawnCommand("npx", ["opencode"], "win32", "cmd.exe").command).toBe("cmd.exe");
  expect(resolveOpenCodeSpawnCommand("opencode.cmd", ["run"], "win32", "cmd.exe")
      .command).toBe("cmd.exe");
});

test("resolveOpenCodeSpawnCommand leaves unrelated win32 commands untouched", () => {
  expect(resolveOpenCodeSpawnCommand("node.exe", ["run"], "win32", "cmd.exe")).toEqual({ command: "node.exe", args: ["run"] });
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
  expect(resolved.command).toBe("cmd.exe");
  expect(resolved.args).toEqual(["/d", "/s", "/c", "sometool --flag"]);
});

test("resolveWindowsShimSpawnCommand leaves a bare command untouched when the PATH probe finds no shim", () => {
  const probe = () => undefined;
  expect(resolveWindowsShimSpawnCommand(
      "sometool",
      ["--flag"],
      ["opencode", "npx"],
      "win32",
      "cmd.exe",
      probe,
    )).toEqual({ command: "sometool", args: ["--flag"] });
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
  expect(probeCalled, "probe must be short-circuited for a recognized extension").toBe(false);
});
