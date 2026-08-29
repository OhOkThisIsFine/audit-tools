/**
 * source-grounded-citation.test.ts — B3 remediate consumers.
 *
 * Pins the remediate-side consumers of the shared basename/dotfile grounding:
 *   - grounding.ts groundAffectedFiles / evidenceCitesRealPath resolve a bare
 *     basename to its NESTED tracked path instead of `existsSync(root/<name>)`
 *     (INV-B3-3), while a hallucinated path stays phantom (INV-B3-6).
 *   - the M-B3 gate (validateContractCitationGrounding) grounds a dotfile-only
 *     node end-to-end with zero severity:error issues (INV-B3-4).
 *
 * The git-tree-dependent cases build a hermetic temp git repo (git init + add;
 * `git ls-files` lists staged files, so no commit is needed).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  groundAffectedFiles,
  evidenceCitesRealPath,
} from "../../src/remediate/phases/grounding.js";
import { validateContractCitationGrounding } from "../../src/remediate/validation/contractPipelineGates.js";
import { enumerateTrackedFilePaths } from "../../src/shared/validation/findingGrounding.js";
import type { Finding } from "../../src/remediate/state/types.js";

function git(root: string, args: string[]): void {
  spawnSyncHidden("git", args, { cwd: root, shell: false, windowsHide: true });
}

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "b3-cite-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "t@t.dev"]);
  git(root, ["config", "user.name", "t"]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  git(root, ["add", "-A"]);
  return root;
}

function mkFinding(id: string, files: string[], evidence: string[] = ["e"]): Finding {
  return {
    id,
    title: `Finding ${id}`,
    category: "General",
    severity: "medium",
    confidence: "high",
    lens: "correctness",
    summary: `Summary ${id}.`,
    affected_files: files.map((path) => ({ path })),
    evidence,
  } as Finding;
}

// A nested source file + a dotfile-dir file + a top-level file.
const NESTED = "src/audit/orchestrator/advance.ts";
const DOTFILE = ".claude/hooks/friction-stop-gate.mjs";

describe("grounding.ts consumers resolve bare basenames + dotfile paths", () => {
  let root: string;
  beforeAll(() => {
    root = makeRepo({
      [NESTED]: "l1\nl2\nl3\nl4\nl5\nl6\n",
      [DOTFILE]: "export const x = 1;\n",
      "src/top.ts": "const y = 2;\n",
    });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("INV-B3-3 POSITIVE: a bare basename for a NESTED tracked file is not stripped as phantom", async () => {
    const corpus = await enumerateTrackedFilePaths(root);
    const finding = mkFinding("f1", ["advance.ts"]);
    const { zeroRealPathFindingIds, phantomPathsByFinding } = groundAffectedFiles(root, [finding], corpus);
    // Nested `advance.ts` resolves against the tracked corpus → kept, not phantom.
    expect(finding.affected_files.map((a) => a.path)).toContain("advance.ts");
    expect(zeroRealPathFindingIds).not.toContain("f1");
    expect(phantomPathsByFinding.has("f1")).toBe(false);
  });

  it("INV-B3-3 POSITIVE: a dotfile-dir path keeps resolving (via the root join)", async () => {
    const corpus = await enumerateTrackedFilePaths(root);
    const finding = mkFinding("f2", [DOTFILE]);
    const { zeroRealPathFindingIds } = groundAffectedFiles(root, [finding], corpus);
    expect(finding.affected_files.map((a) => a.path)).toContain(DOTFILE);
    expect(zeroRealPathFindingIds).not.toContain("f2");
  });

  it("INV-B3-6 NEGATIVE: a hallucinated bare basename / path is still phantom-stripped", async () => {
    const corpus = await enumerateTrackedFilePaths(root);
    const finding = mkFinding("f3", ["doesnotexist.ts", "made/up/dir/x.ts"]);
    const { zeroRealPathFindingIds, phantomPathsByFinding } = groundAffectedFiles(root, [finding], corpus);
    expect(finding.affected_files).toHaveLength(0);
    expect(zeroRealPathFindingIds).toContain("f3");
    expect(phantomPathsByFinding.get("f3")).toEqual([
      "doesnotexist.ts",
      "made/up/dir/x.ts",
    ]);
  });

  it("INV-B3-3 POSITIVE: evidence `advance.ts:5` cites-real-path true for a nested file", async () => {
    const corpus = await enumerateTrackedFilePaths(root);
    // Bare basename with an in-range line number resolves to the nested file.
    expect(evidenceCitesRealPath(root, "see advance.ts:5 for the bug", corpus)).toBe(true);
    // Without a line number the bare basename still grounds.
    expect(evidenceCitesRealPath(root, "look at advance.ts", corpus)).toBe(true);
  });

  it("INV-B3-6 NEGATIVE: evidence with an out-of-range line or hallucinated name stays ungrounded", async () => {
    const corpus = await enumerateTrackedFilePaths(root);
    expect(evidenceCitesRealPath(root, "advance.ts:9999 does not exist", corpus)).toBe(false);
    expect(evidenceCitesRealPath(root, "phantom in doesnotexist.ts:1", corpus)).toBe(false);
  });
});

describe("INV-B3-4: M-B3 gate grounds a dotfile-only node end-to-end", () => {
  let root: string;
  beforeAll(() => {
    root = makeRepo({ [DOTFILE]: "export const x = 1;\n" });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("POSITIVE: a finding citing only a dotfile path yields zero severity:error issues", async () => {
    const finding = mkFinding("d1", [DOTFILE]);
    const { treeReadable, issues } = await validateContractCitationGrounding([finding], root);
    expect(treeReadable).toBe(true);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("NEGATIVE: a finding citing only a hallucinated path is rejected (error)", async () => {
    const finding = mkFinding("d2", ["made/up/nowhere/x.ts"]);
    const { issues } = await validateContractCitationGrounding([finding], root);
    expect(issues.filter((i) => i.severity === "error").length).toBeGreaterThan(0);
  });
});
