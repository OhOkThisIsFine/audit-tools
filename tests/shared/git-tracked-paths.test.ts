import { describe, expect, it, vi } from "vitest";
import { readRecursiveTrackedPaths } from "../../src/shared/gitTrackedPaths.js";
import type { TrackedPathsRunner } from "../../src/shared/gitTrackedPaths.js";
import { TRACKED_CHILD_DEADLINE_MS } from "../../src/shared/tooling/exec.js";

describe("recursive tracked paths transport", () => {
  it("makes one bounded async recursive invocation and preserves every nonempty field", async () => {
    const paths = [" padded ", "line\nbreak", 'quote"', "back\\slash", "MiXeD", "é雪😀", "duplicate", "duplicate"];
    const runner = vi.fn<TrackedPathsRunner>().mockResolvedValue({ status: 0, stdout: `\0${paths.join("\0")}\0\0`, stderr: "" });
    expect(await readRecursiveTrackedPaths("root unchanged/", { runner })).toEqual({ ok: true, paths });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(
      ["git", "ls-files", "-z", "--recurse-submodules"],
      { cwd: "root unchanged/", encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS, maxBuffer: 256 * 1024 * 1024 },
    );
  });

  it("distinguishes successful empty output from failure", async () => {
    expect(await readRecursiveTrackedPaths("root", { runner: async () => ({ status: 0, stdout: "", stderr: "" }) })).toEqual({ ok: true, paths: [] });
  });

  for (const code of ["ENOENT", "EACCES", "ETIMEDOUT", "ENOBUFS"]) {
    for (const status of [0, null, 1]) {
      it(`rejects partial output for ${code}, even with status ${status}`, async () => {
        const error = Object.assign(new Error(code), { code });
        const runner = vi.fn<TrackedPathsRunner>().mockResolvedValue({ status, stdout: "partial\0", stderr: "details", error });
        expect(await readRecursiveTrackedPaths("root", { runner })).toEqual({ ok: false, kind: "error", error });
        expect(runner).toHaveBeenCalledTimes(1);
      });
    }
  }

  for (const status of [1, null]) {
    it(`preserves exit failure metadata (${status})`, async () => {
      expect(await readRecursiveTrackedPaths("root", { runner: async () => ({ status, stdout: "partial\0", stderr: " first\nsecond " }) })).toEqual({ ok: false, kind: "exit", status, stderr: " first\nsecond " });
    });
  }

  for (const cause of [new Error("thrown"), "non-error rejection"]) {
    it("retains a rejected runner's cause without throwing or retrying", async () => {
      const runner = vi.fn<TrackedPathsRunner>().mockRejectedValue(cause);
      expect(await readRecursiveTrackedPaths("root", { runner })).toEqual({ ok: false, kind: "thrown", cause });
      expect(runner).toHaveBeenCalledTimes(1);
    });
  }
});
