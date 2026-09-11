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

// THE THIRD DIRECTION — a memory note citing a repo PATH. Scanned by nothing
// until 2026-09-10: the store lives outside the tree so no doc gate reaches it,
// and the script read notes only for wikilinks. A note whose point is that a
// subsystem was DELETED legitimately cites paths that no longer resolve — the
// majority of what a scan finds — so the rule is an explicit exemption marker,
// NEVER a bare existence check.
describe("check-memory-citations covers the note → repo path direction", () => {
  it("fails on a note citing a repo path that does not resolve", () => {
    const { root, memoryDir } = fixture({
      "alpha.md": "The old reader lived in `docs/does-not-exist.md` before the split.\n",
    });
    try {
      // `docs/guide.md` tracked and `docs/does-not-exist.md` not, so the token is
      // path-shaped against a real top-level dir rather than being prose.
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "guide.md"), "# guide\n", "utf8");
      const git = (...args: string[]) =>
        spawnSyncHidden("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
      expect(git("add", "-A").status).toBe(0);
      expect(git("commit", "--no-gpg-sign", "-q", "-m", "docs").status).toBe(0);

      const result = run(root, memoryDir);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).toBe(1);
      expect(output).toContain("does-not-exist.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a tracked file, a tracked extension-less FILE, and a tracked DIRECTORY", () => {
    const { root, memoryDir } = fixture({
      // A tracked file with an extension.
      "alpha.md": "The reader is `docs/guide.md` now.\n",
      // A tracked DIRECTORY cited extension-less — how notes talk about "the backlog".
      "beta.md": "Routed into `docs/backlog` by the sweep.\n",
      // A tracked extension-less FILE — the class a naive "no extension means
      // directory" rule would red (`.githooks/pre-commit` in the real tree).
      "gamma.md": "The legs moved to `docs/hooks/pre-commit`.\n",
    });
    // The fixture writes these so the tokens have something to resolve against;
    // `fixture` only takes note files, so they are created and committed here.
    const git = (...args: string[]) =>
      spawnSyncHidden("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    mkdirSync(join(root, "docs", "backlog"), { recursive: true });
    mkdirSync(join(root, "docs", "hooks"), { recursive: true });
    writeFileSync(join(root, "docs", "guide.md"), "# guide\n", "utf8");
    writeFileSync(join(root, "docs", "backlog", "open.md"), "# backlog\n", "utf8");
    writeFileSync(join(root, "docs", "hooks", "pre-commit"), "#!/bin/sh\n", "utf8");
    expect(git("add", "-A").status).toBe(0);
    expect(git("commit", "--no-gpg-sign", "-q", "-m", "paths").status).toBe(0);
    try {
      const result = run(root, memoryDir);
      expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an inline marker for a note whose point is that a path was DELETED", () => {
    const { root, memoryDir } = fixture({
      // The marker covers the line below it (and the rest of its comment block).
      "alpha.md":
        "<!-- memory-path-exempt: the retired dispatcher -->\n" +
        "The dispatcher (`src/retired/dispatch.ts`) was deleted in the unification.\n",
    });
    try {
      const result = run(root, memoryDir);
      expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips globs, placeholders and non-repo tokens by rule", () => {
    const { root, memoryDir } = fixture({
      "alpha.md":
        "Patterns `src/**/*.ts` and `src/<name>.ts` are not citations.\n" +
        "Non-repo `~/x/y.ts`, `C:/tmp/z.ts`, `https://e.com/a.ts` and `src\\win\\p.ts` are out.\n" +
        "Gitignored `node_modules/left-pad/index.js` is out.\n",
    });
    try {
      const result = run(root, memoryDir);
      expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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
