/**
 * No fixed time cap on a test (owner decision, 2026-11-07).
 *
 * A fixed per-test cap is a number nobody measured. Under full-suite load the
 * same test takes ten times longer than alone, so any cap can fire on a test
 * that is correct: three suite runs in a row went red on three different
 * capped tests (5 s, 30 s, 120 s), and each passed alone in 3 to 15 s. A fix
 * for one test only moved the false red to the next one, so the class is
 * closed here: vitest runs every test and hook without a limit, and a hung
 * test is stopped by the CI job limit (`timeout-minutes` in the workflows).
 *
 * A test whose ASSERTION is about time keeps its own deadline. Those deadlines
 * live inside the test body (a product time-out, a timer, or a scan deadline
 * passed to `runAfterReadyWithDeadline`), not in the vitest options this test
 * reads. So a trailing number or a `{ timeout }` object counts only when the
 * call it belongs to is a vitest test, suite or hook.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TESTS_DIR = join(REPO_ROOT, "tests");
const THIS_FILE = "tests/shared/no-fixed-test-caps.test.ts";

/** A line that opens a vitest test, suite or hook call. */
const VITEST_CALL = /^\s*(?:test|it|describe|beforeEach|beforeAll|afterEach|afterAll)\b/u;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The line that opens the call a closing line `}, N);` ends. The repo's
 * formatting puts the closer at the opener's indentation, so the opener is the
 * nearest earlier statement line at that indentation (closers skipped).
 */
function openerOfCloser(lines: readonly string[], index: number): string | undefined {
  const indent = indentOf(lines[index] ?? "");
  for (let at = index - 1; at >= 0; at -= 1) {
    const line = lines[at] ?? "";
    if (line.trim() === "" || indentOf(line) !== indent) continue;
    if (/^\s*[}\])]/u.test(line)) continue;
    return line;
  }
  return undefined;
}

/** The line that opens the call whose argument list holds the line at `index`. */
function enclosingCallOf(lines: readonly string[], index: number): string | undefined {
  const indent = indentOf(lines[index] ?? "");
  for (let at = index - 1; at >= 0; at -= 1) {
    const line = lines[at] ?? "";
    if (line.trim() !== "" && indentOf(line) < indent) return line;
  }
  return undefined;
}

type CapForm = {
  readonly name: string;
  readonly find: (text: string, lines: readonly string[]) => number[];
};

function lineNumbersOf(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((match) => text.slice(0, match.index).split("\n").length);
}

const CAP_FORMS: readonly CapForm[] = [
  {
    name: "a trailing timeout argument on a test call: `}, 30_000);` or `}, SOME_TIMEOUT_MS);`",
    find: (text, lines) =>
      lineNumbersOf(text, /^\s*\}\s*,\s*(?:[0-9_]+|[A-Z][A-Z0-9_]*)\s*\);?\s*$/gmu)
        .filter((line) => VITEST_CALL.test(openerOfCloser(lines, line - 1) ?? "")),
  },
  {
    name: "a timeout option after the title: `test(\"…\", { timeout: N }, …)`",
    find: (text) => lineNumbersOf(text, /\b(?:test|it|describe)(?:\.\w+)*\(\s*(["'`]).*?\1\s*,\s*\{\s*timeout\s*:/gmu),
  },
  {
    name: "a timeout option on its own line in a test call: `{ timeout: N },`",
    find: (text, lines) =>
      lineNumbersOf(text, /^\s*\{\s*timeout\s*:\s*[\w.]+\s*\}\s*,\s*$/gmu)
        .filter((line) => VITEST_CALL.test(enclosingCallOf(lines, line - 1) ?? "")),
  },
  {
    name: "a per-file config cap: `vi.setConfig({ testTimeout: N })`",
    find: (text) => lineNumbersOf(text, /\bvi\.setConfig\(\s*\{[^}]*\b(?:testTimeout|hookTimeout)\b/gmu),
  },
];

function testFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...testFiles(path));
    else if (/\.(?:ts|mts|mjs|js)$/u.test(entry.name)) files.push(path);
  }
  return files.sort();
}

test("vitest runs every test and hook without a fixed time limit", () => {
  const config = readFileSync(join(REPO_ROOT, "vitest.config.ts"), "utf8");
  expect(config).toMatch(/\btestTimeout:\s*0\s*,/u);
  expect(config).toMatch(/\bhookTimeout:\s*0\s*,/u);
});

test("no test, suite or hook under tests/ sets its own fixed time cap", () => {
  const offenders: string[] = [];
  for (const file of testFiles(TESTS_DIR)) {
    const repoPath = relative(REPO_ROOT, file).split("\\").join("/");
    if (repoPath === THIS_FILE) continue;
    const text = readFileSync(file, "utf8").replace(/\r\n/gu, "\n");
    const lines = text.split("\n");
    for (const form of CAP_FORMS) {
      const hits = form.find(text, lines);
      if (hits.length > 0) offenders.push(`${repoPath} (${form.name}) at lines ${hits.join(", ")}`);
    }
  }
  expect(offenders, "Remove the cap: the suite runs tests without a time limit (see this file's header).").toEqual([]);
});
