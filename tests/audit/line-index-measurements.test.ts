import { afterEach, expect, test, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as args from "../../src/audit/cli/args.js";
import { buildLineIndex, buildLineIndexForPaths } from "../../src/audit/cli/lineIndex.js";
import type { RepoManifest } from "../../src/audit/types.js";

function manifest(paths: string[]): RepoManifest {
  return {
    repository: { name: "line-measurement-fixture" },
    generated_at: "2026-10-14T00:00:00.000Z",
    files: paths.map((path) => ({ path, language: "TypeScript", size_bytes: 0 })),
  };
}

const adapters = [
  { name: "manifest", build: (root: string, paths: string[]) => buildLineIndex(root, manifest(paths)) },
  { name: "paths", build: buildLineIndexForPaths },
];

afterEach(() => vi.restoreAllMocks());

for (const adapter of adapters) {
  for (const size of [0, 26, 60]) {
    test(`${adapter.name}: ${size} actual countLines calls preserve 25-file barriers and input order`, async () => {
      const paths = Array.from({ length: size }, (_, i) => `file-${String(size - i).padStart(3, "0")}.ts`);
      const prepared = adapter.name === "paths" ? [...paths].sort() : paths;
      const pending: Array<{ path: string; finish: () => void }> = [];
      let active = 0;
      let peak = 0;
      const count = vi.spyOn(args, "countLines").mockImplementation((path) => {
        const position = pending.length;
        active++;
        peak = Math.max(peak, active);
        return new Promise<number>((resolveCount) => {
          let settled = false;
          pending.push({ path, finish: () => {
            if (settled) return;
            settled = true;
            active--;
            resolveCount(position + 1);
          } });
        });
      });
      const result = adapter.build("fixture-root", paths);
      try {
        for (let start = 0; start < size; start += 25) {
          await setImmediate();
          const end = Math.min(start + 25, size);
          expect(pending.map((entry) => entry.path)).toEqual(prepared.slice(0, end).map((path) => resolve("fixture-root", path)));
          expect(active).toBe(end - start);
          // Complete every read except the FIRST. A rolling pool would start
          // the next batch here, even though it never exceeds 25 active reads.
          for (let i = end - 1; i > start; i--) pending[i]!.finish();
          await setImmediate();
          expect(count).toHaveBeenCalledTimes(end);
          expect(active).toBe(1);
          pending[start]!.finish();
        }
        const index = await result;
        expect(peak).toBe(Math.min(25, size));
        expect(active).toBe(0);
        expect(Object.entries(index)).toEqual(prepared.map((path, i) => [path, i + 1]));
        expect(count).toHaveBeenCalledTimes(size);
      } finally {
        // Also settle a mutated implementation after an early assertion fails.
        count.mockImplementation(async () => 0);
        for (const entry of pending) entry.finish();
        await result;
      }
    });
  }
}

test("manifest measures duplicate raw paths repeatedly; last input occurrence wins, not last completion", async () => {
  const paths = ["z/../same.ts", "other.ts", "z/../same.ts", "./same.ts"];
  const finishes: Array<(value: number) => void> = [];
  const count = vi.spyOn(args, "countLines").mockImplementation(() => new Promise<number>((finish) => finishes.push(finish)));
  const result = buildLineIndex("fixture-root", manifest(paths));
  try {
    expect(count.mock.calls.map(([path]) => path)).toEqual(paths.map((path) => resolve("fixture-root", path)));
    finishes[3]!(40);
    finishes[2]!(30);
    finishes[1]!(20);
    finishes[0]!(10);
    expect(Object.entries(await result)).toEqual([[paths[0], 30], [paths[1], 20], [paths[3], 40]]);
  } finally {
    count.mockImplementation(async () => 0);
    for (const finish of finishes) finish(0);
    await result;
  }
});

test("path adapter alone deduplicates exact keys and uses code-unit order", async () => {
  const paths = ["z.ts", "a.ts", "Z.ts", "./a.ts", "a.ts", "z.ts"];
  const count = vi.spyOn(args, "countLines").mockResolvedValue(7);
  const index = await buildLineIndexForPaths("fixture-root", paths);
  const expected = ["./a.ts", "Z.ts", "a.ts", "z.ts"];
  expect(count.mock.calls.map(([path]) => path)).toEqual(expected.map((path) => resolve("fixture-root", path)));
  expect(Object.keys(index)).toEqual(expected);
});

for (const adapter of adapters) {
  test(`${adapter.name}: failures retain NaN and exact per-occurrence diagnostics`, async () => {
    const paths = ["missing.ts", "missing.ts", "other.ts", "raw.ts"];
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    const count = vi.spyOn(args, "countLines").mockImplementation(async (path) => {
      if (path.endsWith("missing.ts")) throw missing;
      if (path.endsWith("other.ts")) throw new Error("denied");
      throw "non-Error failure";
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const index = await adapter.build("fixture-root", paths);
    const prepared = adapter.name === "paths" ? ["missing.ts", "other.ts", "raw.ts"] : paths;
    expect(count).toHaveBeenCalledTimes(prepared.length);
    expect(Object.keys(index)).toEqual(["missing.ts", "other.ts", "raw.ts"]);
    expect(Object.values(index).every(Number.isNaN)).toBe(true);
    expect(stderr.mock.calls.map(([text]) => text)).toEqual([
      ...prepared.map((path) => `[lineIndex] ${path === "missing.ts" ? "file not found" : "IO error"} counting lines for '${path}': ${path === "missing.ts" ? "gone" : path === "other.ts" ? "denied" : "non-Error failure"}\n`),
      `[lineIndex] ${prepared.length} of ${prepared.length} file(s) failed line counting; those entries are marked unmeasured.\n`,
    ]);
  });
}

for (const adapter of adapters) {
  test(`${adapter.name}: real countLines preserves empty, CRLF and unterminated final lines`, async () => {
    const root = await mkdtemp(join(tmpdir(), "line-measurements-"));
    try {
      const files = [["empty", "", 0], ["crlf", "one\r\ntwo\r\n", 2], ["no-final-lf", "one\ntwo", 2]] as const;
      for (const [path, content] of files) await writeFile(join(root, path), content);
      const index = await adapter.build(root, files.map(([path]) => path));
      expect(index).toEqual(Object.fromEntries(files.map(([path, , lines]) => [path, lines])));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("duplicate failures count occurrences, and a later failed occurrence overrides an earlier success", async () => {
  const pending: Array<{ resolve: (value: number) => void; reject: (error: Error) => void }> = [];
  const count = vi.spyOn(args, "countLines").mockImplementation(() => new Promise<number>((resolveCount, reject) => pending.push({ resolve: resolveCount, reject })));
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const result = buildLineIndex("fixture-root", manifest(["same.ts", "same.ts"]));
  try {
    expect(count).toHaveBeenCalledTimes(2);
    pending[1]!.reject(new Error("second occurrence"));
    await setImmediate();
    expect(stderr).toHaveBeenCalledTimes(1); // Aggregate waits for every read.
    pending[0]!.resolve(99);
    expect(Number.isNaN((await result)["same.ts"])).toBe(true);
    expect(stderr.mock.calls.map(([text]) => text)).toEqual([
      "[lineIndex] IO error counting lines for 'same.ts': second occurrence\n",
      "[lineIndex] 1 of 2 file(s) failed line counting; those entries are marked unmeasured.\n",
    ]);

    count.mockRejectedValue(new Error("both fail"));
    stderr.mockClear();
    const failed = await buildLineIndex("fixture-root", manifest(["same.ts", "same.ts"]));
    expect(Object.keys(failed)).toEqual(["same.ts"]);
    expect(Number.isNaN(failed["same.ts"])).toBe(true);
    expect(stderr.mock.calls.map(([text]) => text)).toEqual([
      "[lineIndex] IO error counting lines for 'same.ts': both fail\n",
      "[lineIndex] IO error counting lines for 'same.ts': both fail\n",
      "[lineIndex] 2 of 2 file(s) failed line counting; those entries are marked unmeasured.\n",
    ]);
  } finally {
    count.mockImplementation(async () => 0);
    for (const entry of pending) entry.resolve(0);
    await result;
  }
});
