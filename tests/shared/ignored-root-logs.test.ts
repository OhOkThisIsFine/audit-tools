import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectNewlyCreatedIgnoredRootLogs,
  inventoryIgnoredRootLogs,
  isLogFilename,
} from "../../src/shared/submission/ignoredRootLogs.js";
import { execFileSyncHidden } from "../helpers/spawn.mjs";

function git(root: string, args: string[]): string {
  return String(
    execFileSyncHidden("git", args, { cwd: root, encoding: "utf8" }),
  ).trim();
}

describe("ignoredRootLogs unit tests", () => {
  it("isLogFilename correctly matches log filenames and rejects non-log files", () => {
    expect(isLogFilename("test.log")).toBe(true);
    expect(isLogFilename("npm-debug.log")).toBe(true);
    expect(isLogFilename("run.log.jsonl")).toBe(true);
    expect(isLogFilename("OUT.LOG")).toBe(true);
    expect(isLogFilename("test.txt")).toBe(false);
    expect(isLogFilename("logger.ts")).toBe(false);
    expect(isLogFilename("log")).toBe(false);
    expect(isLogFilename("package.json")).toBe(false);
  });

  it("inventoryIgnoredRootLogs inventories ignored root logs in a git repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-ignored-logs-"));
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "test@example.com"]);
      git(root, ["config", "user.name", "Test"]);
      await writeFile(join(root, ".gitignore"), "*.log\n", "utf8");
      git(root, ["add", ".gitignore"]);
      git(root, ["commit", "-m", "init"]);

      // Create files
      await writeFile(join(root, "root.log"), "log", "utf8");
      await writeFile(join(root, "other.txt"), "text", "utf8");
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "nested.log"), "nested", "utf8");

      // Sanctioned artifact directory
      const artifactsDir = join(root, ".audit-tools", "artifacts");
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(join(artifactsDir, "sanctioned.log"), "sanctioned", "utf8");

      const logs = await inventoryIgnoredRootLogs({ root, artifactsDir });
      // Only root.log is a root ignored log
      expect(logs).toEqual(["root.log"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detectNewlyCreatedIgnoredRootLogs reports only newly created logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-ignored-logs-diff-"));
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "test@example.com"]);
      git(root, ["config", "user.name", "Test"]);
      await writeFile(join(root, ".gitignore"), "*.log\n", "utf8");
      git(root, ["add", ".gitignore"]);
      git(root, ["commit", "-m", "init"]);

      await writeFile(join(root, "pre-existing.log"), "pre", "utf8");
      const pre = await inventoryIgnoredRootLogs({ root });
      expect(pre).toEqual(["pre-existing.log"]);

      // Create new log
      await writeFile(join(root, "new-stray.log"), "new", "utf8");

      const newlyCreated = await detectNewlyCreatedIgnoredRootLogs({
        root,
        preInventory: pre,
      });
      expect(newlyCreated).toEqual(["new-stray.log"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
