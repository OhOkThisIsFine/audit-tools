import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-memory-citations.mjs");

/** The host's per-project slug: every non-alphanumeric character becomes a dash. */
const slugOf = (path: string) => resolve(path).replace(/[^a-zA-Z0-9]/g, "-");

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

// The store lives OUTSIDE the repo, so the gate has to name it by a path. Deriving
// that path from `cwd` made the gate inert in every linked worktree — and every lap
// runs in one — while it announced the miss with a ✓ that reads as a pass in a
// scrolled log. Both halves are asserted here: the path comes from the REPOSITORY
// (its common git dir, shared by every worktree), and an unfound store never ticks.
describe("check-memory-citations store resolution", () => {
  /** A repository plus one linked worktree, torn down together. */
  function withLinkedWorktree(run: (paths: { main: string; linked: string }) => void) {
    const main = mkdtempSync(join(tmpdir(), "memory-citation-worktree-"));
    const git = (cwd: string, ...args: string[]) =>
      spawnSyncHidden("git", args, { cwd, encoding: "utf8", windowsHide: true });
    try {
      expect(git(main, "init", "-q").status).toBe(0);
      expect(git(main, "config", "user.email", "test@example.com").status).toBe(0);
      expect(git(main, "config", "user.name", "Test").status).toBe(0);
      writeFileSync(join(main, "doc.md"), "# Doc\n", "utf8");
      expect(git(main, "add", "doc.md").status).toBe(0);
      expect(git(main, "commit", "--no-gpg-sign", "-q", "-m", "fixture").status).toBe(0);
      const linked = join(main, "wt");
      expect(git(main, "worktree", "add", "-q", "-b", "lap", linked).status).toBe(0);
      run({ main, linked });
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  }

  /** Run the gate with no AUDIT_TOOLS_MEMORY_DIR, so it must resolve the store itself. */
  function runUnpointed(cwd: string) {
    const env = { ...process.env };
    delete env["AUDIT_TOOLS_MEMORY_DIR"];
    const result = spawnSyncHidden(process.execPath, [CHECKER], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      env,
    });
    return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  it("resolves the store from the repository, so a linked worktree reaches its main checkout's", () => {
    withLinkedWorktree(({ main, linked }) => {
      const { output } = runUnpointed(linked);
      expect(output).toContain(slugOf(main));
      expect(output).not.toContain(slugOf(linked));
    });
  });

  it("never announces an unfound store with a ✓ — a tick reads as a pass", () => {
    withLinkedWorktree(({ linked }) => {
      const { output } = runUnpointed(linked);
      expect(output).not.toContain("✓");
    });
  });
});
