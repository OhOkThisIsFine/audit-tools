// A4 — region merge + write-scope: hunk-aware overlap detection.
//
// gitHunksForBranch parses `git diff HEAD...<branch>` into per-hunk new-side
// line ranges (fail-closed like gitEditedFilesForBranch). detectOverlappingEdits
// spares same-file blocks whose ACTUAL hunk ranges are disjoint, still flags
// blocks whose hunks overlap, and fails closed (flags) when hunk info is
// unavailable. The cherry-pick in mergeWorktree stays the sole merge authority —
// no hand-rolled hunk apply is introduced (asserted structurally below).

import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  detectOverlappingEdits,
  gitHunksForBranch,
  parseUnifiedDiffHunks,
  type BlockEditedFiles,
  type GitBranchHunk,
  type GitBranchHunks,
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

// Convenience: available-hunks value from a plain list.
function hunks(list: GitBranchHunk[]): GitBranchHunks {
  return { available: true, hunks: list };
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

// --- detectOverlappingEdits: hunk-aware ------------------------------------

describe("detectOverlappingEdits (hunk-aware)", () => {
  it("does NOT flag same-file blocks with DISJOINT hunk ranges", () => {
    const edited: BlockEditedFiles[] = [
      {
        block_id: "B1",
        files: new Set(["src/shared.ts"]),
        hunks: hunks([{ file: "src/shared.ts", startLine: 1, lineCount: 5 }]),
      },
      {
        block_id: "B2",
        files: new Set(["src/shared.ts"]),
        hunks: hunks([{ file: "src/shared.ts", startLine: 40, lineCount: 5 }]),
      },
    ];
    expect(detectOverlappingEdits(edited)).toHaveLength(0);
  });

  it("DOES flag same-file blocks with OVERLAPPING hunk ranges", () => {
    const edited: BlockEditedFiles[] = [
      {
        block_id: "B1",
        files: new Set(["src/shared.ts"]),
        hunks: hunks([{ file: "src/shared.ts", startLine: 10, lineCount: 5 }]),
      },
      {
        block_id: "B2",
        files: new Set(["src/shared.ts"]),
        hunks: hunks([{ file: "src/shared.ts", startLine: 12, lineCount: 5 }]),
      },
    ];
    const overlaps = detectOverlappingEdits(edited);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].path).toBe("src/shared.ts");
    expect(overlaps[0].block_ids).toEqual(["B1", "B2"]);
  });

  it("fails closed (flags) when hunk info is UNAVAILABLE for a same-file pairing", () => {
    const edited: BlockEditedFiles[] = [
      {
        block_id: "B1",
        files: new Set(["src/shared.ts"]),
        hunks: { available: false, reason: "probe_failed", error: "boom" },
      },
      {
        block_id: "B2",
        files: new Set(["src/shared.ts"]),
        hunks: hunks([{ file: "src/shared.ts", startLine: 40, lineCount: 5 }]),
      },
    ];
    const overlaps = detectOverlappingEdits(edited);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].block_ids).toEqual(["B1", "B2"]);
  });

  it("fails closed (flags) when hunks are entirely absent (legacy call shape)", () => {
    const edited: BlockEditedFiles[] = [
      { block_id: "B1", files: new Set(["src/shared.ts"]) },
      { block_id: "B2", files: new Set(["src/shared.ts"]) },
    ];
    const overlaps = detectOverlappingEdits(edited);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].block_ids).toEqual(["B1", "B2"]);
  });

  it("still reports no overlap for disjoint FILES regardless of hunks", () => {
    const edited: BlockEditedFiles[] = [
      { block_id: "B1", files: new Set(["src/a.ts"]) },
      { block_id: "B2", files: new Set(["src/b.ts"]) },
    ];
    expect(detectOverlappingEdits(edited)).toHaveLength(0);
  });
});
