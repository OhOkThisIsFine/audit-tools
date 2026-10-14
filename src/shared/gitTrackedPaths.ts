// sites-pinned: tests/shared/git-tracked-paths.test.ts, tests/audit/recursive-tracked-adapters.test.ts, tests/audit/submodule-tracked-corpus.test.ts
import { runTrackedAsync, TRACKED_CHILD_DEADLINE_MS } from "./tooling/exec.js";

/** Minimal async boundary also accepted by the disposition's injected spawn. */
export type TrackedPathsRunner = (
  argv: string[],
  options: { cwd: string; encoding: "utf8"; timeout: number; maxBuffer: number },
) => Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }>;

export type RecursiveTrackedPathsResult =
  | { ok: true; paths: string[] }
  | { ok: false; kind: "thrown"; cause: unknown }
  | { ok: false; kind: "error"; error: Error }
  | { ok: false; kind: "exit"; status: number | null; stderr: string };

/**
 * Single authority for the recursive index corpus. Preserve nonempty NUL fields
 * verbatim: ordering, duplicates, whitespace, case and separators are domain
 * policy, not Git transport policy. A failed child never exposes partial paths.
 * The string boundary supports valid UTF-8 paths, not arbitrary POSIX bytes.
 */
export async function readRecursiveTrackedPaths(
  root: string,
  options: { runner?: TrackedPathsRunner } = {},
): Promise<RecursiveTrackedPathsResult> {
  let result;
  try {
    result = await (options.runner ?? runTrackedAsync)(
      ["git", "ls-files", "-z", "--recurse-submodules"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: TRACKED_CHILD_DEADLINE_MS,
        maxBuffer: 256 * 1024 * 1024,
      },
    );
  } catch (cause) {
    return { ok: false, kind: "thrown", cause };
  }
  if (result.error) return { ok: false, kind: "error", error: result.error };
  if (result.status !== 0) {
    return { ok: false, kind: "exit", status: result.status, stderr: result.stderr };
  }
  return { ok: true, paths: result.stdout.split("\0").filter((path) => path.length > 0) };
}
