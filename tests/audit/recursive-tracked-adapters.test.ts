import { beforeEach, describe, expect, it, vi } from "vitest";
const child = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../src/shared/tooling/exec.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/shared/tooling/exec.js")>(),
  runTrackedAsync: child.run,
}));
import { hashContent, normalizeRepoPath, toPosixPath } from "audit-tools/shared";
import { enumerateTrackedFilePaths } from "../../src/shared/validation/findingGrounding.js";
import { buildFileDisposition } from "../../src/audit/extractors/disposition.js";
import type { GitSpawn } from "../../src/audit/extractors/disposition.js";
import { probeScopeIndexKey, probeScopeIndexKeyCached } from "../../src/audit/orchestrator/scopeIndexBaseline.js";
import type { ScopeIndexMemo } from "../../src/audit/orchestrator/scopeIndexBaseline.js";

const success = (paths: readonly string[]) => ({ status: 0, stdout: paths.join("\0") + "\0", stderr: "" });
const manifest = (paths: string[]) => ({
  repository: { name: "fixture" }, generated_at: "2026-10-14T00:00:00.000Z",
  files: paths.map((path) => ({ path, language: "typescript", size_bytes: 10 })),
});
const noIgnored: GitSpawn = async () => ({ status: 1, stdout: "", stderr: "" });
beforeEach(() => { child.run.mockReset(); });

describe("recursive tracked paths domain policies", () => {
  it("grounding preserves case and insertion order, normalizing only separators", async () => {
    child.run.mockResolvedValue(success([" Z ", "b\\a.ts", "MiXeD.ts", "line\nbreak", " Z "]));
    expect([...await enumerateTrackedFilePaths("root")]).toEqual([" Z ", "b/a.ts", "MiXeD.ts", "line\nbreak"]);
    expect(child.run).toHaveBeenCalledTimes(1);
    expect(child.run.mock.calls[0]?.[1]).toMatchObject({ maxBuffer: 256 * 1024 * 1024 });
  });

  it("scope preserves legacy hash bytes including candidate multiplicity and collisions", async () => {
    const paths = [" A.ts ", "dir\\B.ts", "line\nbreak", "A.ts"];
    const candidates = ["a.ts", " A.ts ", "./A.ts", "dir/B.ts", "DIR\\B.ts", "line\nbreak", "missing"];
    const tracked = new Set(paths.map(normalizeRepoPath));
    const expected = hashContent(candidates.map((p) => normalizeRepoPath(toPosixPath(p))).filter((p) => tracked.has(p)).sort().join("\n"));
    for (const order of [paths, [...paths].reverse()]) {
      child.run.mockResolvedValue(success(order));
      expect(await probeScopeIndexKey("root", candidates)).toBe(expected);
    }
    expect(child.run).toHaveBeenCalledTimes(2);
    expect(await probeScopeIndexKey("root", ["unmatched"])).toBe(hashContent(""));
    child.run.mockResolvedValue(success([]));
    expect(await probeScopeIndexKey("root", ["a.ts"])).toBe(hashContent(""));
  });

  it("empty candidates and no-root disposition do not enumerate", async () => {
    expect(await probeScopeIndexKey("root", [])).toBeNull();
    expect(await buildFileDisposition(manifest(["a.ts"]))).toEqual({ files: [{ path: "a.ts", status: "included", reason: "Default included source or config artifact." }] });
    expect(child.run).not.toHaveBeenCalled();
  });

  it("memo reuses identical inputs, reprobes changed inputs and observes fresh folds", async () => {
    const memo: ScopeIndexMemo = {};
    child.run.mockResolvedValue(success(["a.ts"]));
    const before = await probeScopeIndexKeyCached(memo, "root", ["a.ts", "b.ts"]);
    child.run.mockResolvedValue(success(["a.ts", "b.ts"]));
    expect(await probeScopeIndexKeyCached(memo, "root", ["a.ts", "b.ts"])).toBe(before);
    expect(child.run).toHaveBeenCalledTimes(1);
    expect(await probeScopeIndexKeyCached({}, "root", ["a.ts", "b.ts"])).not.toBe(before);
    await probeScopeIndexKeyCached(memo, "root", ["b.ts"]);
    await probeScopeIndexKeyCached(memo, "other-root", ["b.ts"]);
    expect(child.run).toHaveBeenCalledTimes(4);
  });

  const errors = ["ENOENT", "EACCES", "ETIMEDOUT", "ENOBUFS"].map((code) => Object.assign(new Error(`detail ${code}`), { code }));
  for (const error of errors) {
    it(`preserves ${error.code} diagnostic and fails closed in scope/grounding`, async () => {
      child.run.mockResolvedValue({ status: 0, stdout: "partial\0", stderr: "", error });
      expect(await enumerateTrackedFilePaths("root")).toEqual(new Set());
      expect(await probeScopeIndexKey("root", ["partial"])).toBeNull();
      const result = await buildFileDisposition(manifest(["a.ts"]), { root: "root", spawn: noIgnored });
      expect(result.untracked).toEqual({ applied: false, ignored_count: 0, skipped_reason: `untracked rule skipped: ${error.code === "ENOENT" ? "git executable not found (ENOENT)" : `git ls-files failed to start: ${error.message}`}` });
      expect(child.run).toHaveBeenCalledTimes(3);
    });
  }

  for (const status of [1, null]) {
    it(`preserves exit diagnostic ${status}`, async () => {
      child.run.mockResolvedValue({ status, stdout: "partial\0", stderr: "  first line\nsecond line " });
      expect(await enumerateTrackedFilePaths("root")).toEqual(new Set());
      expect(await probeScopeIndexKey("root", ["partial"])).toBeNull();
      const result = await buildFileDisposition(manifest(["a.ts"]), { root: "root", spawn: noIgnored });
      expect(result.untracked?.skipped_reason).toBe(`untracked rule skipped: git ls-files exited ${status ?? "by signal"}: first line`);
    });
  }

  it("handles rejected runners in all adapters", async () => {
    child.run.mockRejectedValue(new Error("rejected"));
    expect(await enumerateTrackedFilePaths("root")).toEqual(new Set());
    expect(await probeScopeIndexKey("root", ["a.ts"])).toBeNull();
    const result = await buildFileDisposition(manifest(["a.ts"]), { root: "root", spawn: noIgnored });
    expect(result.untracked?.skipped_reason).toBe("untracked rule skipped: git ls-files spawn failed: rejected");
  });

  it("preserves exact root and high-share guard summaries", async () => {
    child.run.mockResolvedValue(success([]));
    const rootGuard = await buildFileDisposition(manifest(["a.ts"]), { root: "root", spawn: noIgnored });
    expect(rootGuard.untracked).toEqual({
      applied: false, ignored_count: 1, guard_branch: "root_untracked",
      skipped_reason: "untracked rule skipped: every included candidate is untracked (the repository has no tracked files in the audit scope)",
    });
    child.run.mockResolvedValue(success(["f0.ts"]));
    const highShare = await buildFileDisposition(manifest(Array.from({ length: 20 }, (_, i) => `f${i}.ts`)), { root: "root", spawn: noIgnored });
    expect(highShare.untracked).toEqual({
      applied: false, ignored_count: 19, guard_branch: "share_exceeded",
      skipped_reason: "untracked rule skipped: untracked share 0.950 of included candidates exceeds VCS_IGNORED_MAX_SHARE (0.9)",
    });
    expect(highShare.files.every((f) => f.status === "included")).toBe(true);
  });

  it("keeps the injected disposition seam without a second default enumeration", async () => {
    const lsFilesSpawn = vi.fn<GitSpawn>().mockResolvedValue(success(["A.ts", "dir\\B.ts"]));
    const result = await buildFileDisposition(manifest(["a.ts", "dir/B.ts", "litter.ts"]), { root: "root", spawn: noIgnored, lsFilesSpawn });
    expect(lsFilesSpawn).toHaveBeenCalledTimes(1);
    expect(lsFilesSpawn.mock.calls[0]?.slice(0, 2)).toEqual(["git", ["ls-files", "-z", "--recurse-submodules"]]);
    expect(child.run).not.toHaveBeenCalled();
    expect(result.untracked).toEqual({ applied: true, ignored_count: 1 });
    expect(result.files.map((f) => f.status)).toEqual(["included", "included", "excluded"]);
  });
});
