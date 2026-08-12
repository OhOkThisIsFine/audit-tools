// A4 — git hunk extraction and parsing.
//
// gitHunksForBranch parses `git diff HEAD...<branch>` into per-hunk new-side
// line ranges (fail-closed like gitEditedFilesForBranch).

import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  gitHunksForBranch,
  parseUnifiedDiffHunks,
} from "../../src/remediate/steps/dispatch.js";

// --- temp git repo helpers -------------------------------------------------

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function git(root: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr ?? r.stdout}`);
  }
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "a4-region-"));
  tempRoots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

function commit(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

// A file with `count` numbered lines.
function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
}

// --- gitHunksForBranch: real repo parse ------------------------------------

describe("gitHunksForBranch", () => {
  it("parses new-side hunk ranges from a branch diff", () => {
    const root = makeRepo();
    writeFileSync(join(root, "f.ts"), numberedLines(40));
    commit(root, "base");

    git(root, ["checkout", "-q", "-b", "feature"]);
    // Edit line 5 and line 30 — two disjoint hunks.
    const lines = numberedLines(40).split("\n");
    lines[4] = "line 5 CHANGED";
    lines[29] = "line 30 CHANGED";
    writeFileSync(join(root, "f.ts"), lines.join("\n"));
    commit(root, "edit");
    git(root, ["checkout", "-q", "-"]);

    const result = gitHunksForBranch(root, "feature");
    expect(result.available).toBe(true);
    if (!result.available) return;
    // Two hunks around lines 5 and 30, all on f.ts (forward-slash relative).
    expect(result.hunks.every((h) => h.file === "f.ts")).toBe(true);
    expect(result.hunks.length).toBe(2);
    const starts = result.hunks.map((h) => h.startLine).sort((a, b) => a - b);
    expect(starts[0]).toBeLessThanOrEqual(5);
    expect(starts[1]).toBeGreaterThanOrEqual(25);
  });

  it("fails closed (not_a_repo) outside a git work tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "a4-norepo-"));
    tempRoots.push(dir);
    const result = gitHunksForBranch(dir, "whatever");
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toBe("not_a_repo");
  });

  it("fails closed (probe_failed) for a nonexistent branch in a real repo", () => {
    const root = makeRepo();
    writeFileSync(join(root, "f.ts"), numberedLines(3));
    commit(root, "base");
    const result = gitHunksForBranch(root, "does-not-exist");
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toBe("probe_failed");
  });
});

// --- parseUnifiedDiffHunks: pure parse -------------------------------------

describe("parseUnifiedDiffHunks", () => {
  it("extracts new-side ranges and normalizes b/ paths", () => {
    const diff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "index 000..111 100644",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -5,3 +5,4 @@",
      " ctx",
      "+added",
      "@@ -40,2 +41,2 @@",
      " ctx",
    ].join("\n");
    const result = parseUnifiedDiffHunks(diff);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hunks).toEqual([
      { file: "src/x.ts", startLine: 5, lineCount: 4 },
      { file: "src/x.ts", startLine: 41, lineCount: 2 },
    ]);
  });

  it("treats a missing new-side count as a single line", () => {
    const diff = ["+++ b/f.ts", "@@ -1 +1 @@"].join("\n");
    const result = parseUnifiedDiffHunks(diff);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hunks).toEqual([{ file: "f.ts", startLine: 1, lineCount: 1 }]);
  });

  it("fails closed on an unparseable hunk header", () => {
    const diff = ["+++ b/f.ts", "@@ garbage @@"].join("\n");
    const result = parseUnifiedDiffHunks(diff);
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toBe("probe_failed");
  });
});
