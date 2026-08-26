import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-memory-citations.mjs");

/** A minimal tracked-git fixture; the checker censuses tracked docs through `git ls-files`. */
function fixture(notes: Record<string, string>): { root: string; memoryDir: string } {
  const root = mkdtempSync(join(tmpdir(), "memory-crosslink-"));
  const memoryDir = join(root, "memory");
  mkdirSync(memoryDir);
  for (const [name, body] of Object.entries(notes)) {
    writeFileSync(join(memoryDir, name), body, "utf8");
  }
  const git = (...args: string[]) =>
    spawnSyncHidden("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  expect(git("init", "-q").status).toBe(0);
  expect(git("config", "user.email", "test@example.com").status).toBe(0);
  expect(git("config", "user.name", "Test").status).toBe(0);
  writeFileSync(join(root, "tracked.md"), "# fixture\n", "utf8");
  expect(git("add", "tracked.md").status).toBe(0);
  expect(git("commit", "--no-gpg-sign", "-q", "-m", "fixture").status).toBe(0);
  return { root, memoryDir };
}

function run(root: string, memoryDir: string) {
  return spawnSyncHidden(process.execPath, [CHECKER], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, AUDIT_TOOLS_MEMORY_DIR: memoryDir },
  });
}

describe("check-memory-citations covers memory-to-memory [[name]] cross-links", () => {
  it("fails on a [[name]] link whose target memory does not exist", () => {
    const { root, memoryDir } = fixture({
      "alpha.md": "Supersedes any tier reflex in [[beta]]; the ordering still holds.\n",
    });
    try {
      const result = run(root, memoryDir);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).toBe(1);
      expect(output).toContain("beta");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a [[name]] link written with a stray .md suffix", () => {
    const { root, memoryDir } = fixture({
      "alpha.md": "See [[beta.md]] for the ordering.\n",
      "beta.md": "# Beta\n",
    });
    try {
      const result = run(root, memoryDir);
      expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores [[...]] inside an inline code span — that is syntax documentation, not a link", () => {
    const { root, memoryDir } = fixture({
      "MEMORY.md": "Memories cite each other as `[[name]]`, which the gate reads.\n",
      "alpha.md": "Wiki-style `[[…]]` links are the other citation form.\n",
    });
    try {
      const result = run(root, memoryDir);
      expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
