import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-memory-citations.mjs");

describe("check-memory-citations working-tree deletions", () => {
  it("skips a tracked markdown file deleted by the current atomic change", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-citation-deletion-"));
    const memoryDir = join(root, "memory");
    const git = (...args: string[]) =>
      spawnSyncHidden("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    try {
      mkdirSync(memoryDir);
      writeFileSync(join(memoryDir, "live-note.md"), "# Live\n", "utf8");
      expect(git("init", "-q").status).toBe(0);
      expect(git("config", "user.email", "test@example.com").status).toBe(0);
      expect(git("config", "user.name", "Test").status).toBe(0);
      writeFileSync(join(root, "retired.md"), "(memory: live-note)\n", "utf8");
      expect(git("add", "retired.md").status).toBe(0);
      expect(git("commit", "--no-gpg-sign", "-q", "-m", "fixture").status).toBe(0);
      rmSync(join(root, "retired.md"));

      const result = spawnSyncHidden(process.execPath, [CHECKER], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AUDIT_TOOLS_MEMORY_DIR: memoryDir },
      });
      expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
