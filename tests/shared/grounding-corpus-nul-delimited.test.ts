/**
 * The two grounding corpora must be NUL-delimited (`git ls-files -z`), never
 * newline-split.
 *
 * Without `-z`, `git ls-files` renders any path it considers unusual in C-quoted
 * form: non-ASCII bytes (core.quotePath, on by default) come back as
 * `"src/caf\303\251.ts"`, and a path containing a newline is likewise quoted so a
 * newline split tears one path into two entries. Either way the corpus entry no
 * longer equals the real repo path, so every citation naming that file silently
 * fails to ground while the file-disposition rule (which already uses `-z`) keeps
 * it in scope.
 *
 * The non-ASCII path is the portable probe for this: Windows forbids control
 * characters in filenames, so a literal-newline fixture cannot run everywhere,
 * but both shapes are the same defect — quoting/delimiting, not the character.
 */
import { test, expect } from "vitest";
import { execFileSyncHidden as execFileSync } from "../helpers/spawn.mjs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateTrackedFilePaths } from "../../src/shared/validation/findingGrounding.js";
import { enumerateRepoTreePaths } from "../../src/remediate/validation/contractPipelineGates.js";

const UNICODE_PATH = "src/café-ünïcode.ts";
const ASCII_PATH = "src/plain.ts";

// macOS stores filenames decomposed (NFD) while git recomposes them (NFC), so
// membership is compared unicode-normalized — the assertion is about quoting and
// delimiting, not about which normal form the filesystem chose.
const nfc = (value: string) => value.normalize("NFC");
const nfcSet = (paths: Iterable<string>) => new Set([...paths].map(nfc));

/** Throwaway repo tracking one plain and one non-ASCII path. */
async function withUnicodeRepo<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-grounding-corpus-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, ASCII_PATH), "export const a = 1;\n", "utf8");
    await writeFile(join(dir, UNICODE_PATH), "export const b = 2;\n", "utf8");
    git("add", "-A");
    git("commit", "-q", "-m", "initial");
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("enumerateTrackedFilePaths keeps a non-ASCII tracked path verbatim (NUL-delimited)", async () => {
  await withUnicodeRepo((dir) => {
    const corpus = enumerateTrackedFilePaths(dir);
    expect(corpus.has(ASCII_PATH)).toBe(true);
    expect(
      [...corpus].filter((p) => p.includes('"')),
      "a C-quoted entry means git ls-files ran without -z",
    ).toEqual([]);
    expect(nfcSet(corpus).has(nfc(UNICODE_PATH))).toBe(true);
  });
});

test("enumerateRepoTreePaths (M-B3 corpus) keeps a non-ASCII tracked path verbatim", async () => {
  await withUnicodeRepo((dir) => {
    const corpus = enumerateRepoTreePaths(dir);
    expect(corpus.has(ASCII_PATH)).toBe(true);
    expect(
      [...corpus].filter((p) => p.includes('"')),
      "a C-quoted entry means git ls-files ran without -z",
    ).toEqual([]);
    expect(nfcSet(corpus).has(nfc(UNICODE_PATH))).toBe(true);
  });
});
