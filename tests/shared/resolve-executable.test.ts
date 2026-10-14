import { expect, test } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutableFile, resolveExecArgv } from "../../src/shared/tooling/exec.js";

test("ordered explicit PATH entries, missing PATH, and cwd anchoring", () => {
  const seen: string[] = [];
  const file = (path: string): string | null => { seen.push(path); return path === "/captured/relative/tool" ? path : null; };
  expect(resolveExecutableFile("tool", { platform: "linux", cwd: "/captured", env: { PATH: ":relative:/later" }, executableFile: file })).toBe("/captured/relative/tool");
  expect(seen).toEqual(["/captured/tool", "/captured/relative/tool"]);
  seen.length = 0;
  expect(resolveExecutableFile("tool", { env: {}, executableFile: file })).toBeNull();
  expect(seen).toEqual([]);
});
test("Windows Path casing, quoted directories, supported PATHEXT order and explicit extension", () => {
  const seen: string[] = [];
  const executableFile = (path: string): string | null => { seen.push(path); return path.toLowerCase().endsWith("tool.cmd") ? path : null; };
  expect(resolveExecutableFile("tool", { platform: "win32", cwd: "C:\\cwd", env: { Path: '"C:\\first space";C:\\later', Pathext: ".PS1;.CMD;.EXE" }, executableFile })).toBe("C:\\first space\\tool.CMD");
  expect(seen).toEqual(["C:\\first space\\tool.CMD"]);
  expect(resolveExecutableFile("tool.cMd", { platform: "win32", cwd: "C:\\cwd", env: { PATH: "C:\\bin" }, executableFile })).toBe("C:\\bin\\tool.cMd");
});
test.skipIf(process.platform === "win32")("POSIX requires X_OK, follows installation symlink, preserves spaces", () => {
  const root = mkdtempSync(join(tmpdir(), "path-inert-"));
  try {
    mkdirSync(join(root, "first")); mkdirSync(join(root, "second space"));
    writeFileSync(join(root, "first", "tool"), "inert"); chmodSync(join(root, "first", "tool"), 0o600);
    writeFileSync(join(root, "real file"), "inert"); chmodSync(join(root, "real file"), 0o700);
    symlinkSync(join(root, "real file"), join(root, "second space", "tool"));
    expect(resolveExecutableFile("tool", { cwd: root, env: { PATH: "first:second space" } })).toBe(join(root, "real file"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolved Windows batch path keeps the existing execution wrapper", () => {
  const selected = resolveExecutableFile("tool", { platform: "win32", cwd: "C:\\cwd", env: { PATH: "C:\\first space", PATHEXT: ".CMD" }, executableFile: path => path });
  const wrapped = resolveExecArgv([selected!, "--version"], { platform: "win32" });
  expect(wrapped.slice(1, 4)).toEqual(["/d", "/s", "/c"]);
  expect(wrapped[4]).toContain('"C:\\first space\\tool.CMD"');
});
