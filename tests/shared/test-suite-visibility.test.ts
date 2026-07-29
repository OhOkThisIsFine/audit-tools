/**
 * Visibility guard for the test tree itself: every `*.test.*` file under
 * `tests/` must be matched by the single-sourced rule list that also generates
 * vitest's `include` globs (`tests/helpers/testFileContract.ts`). Without this,
 * a file the runner cannot see — a `.test.ts` rename before the globs admitted
 * it, a stray `.test.js`, a test in an unlisted directory — leaves the suite
 * SILENTLY green with one fewer file. A script in no gate is not a gate; a test
 * the runner cannot see is not a test.
 *
 * Also refuses `.mjs`/`.ts` twins of one test name in one directory: during the
 * file-by-file conversion a leftover `.mjs` copy would keep running STALE
 * duplicate tests beside its converted successor.
 */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "vitest";
import { TEST_FILE_RULES } from "../helpers/testFileContract.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const testsRoot = join(repoRoot, "tests");

/** Repo-relative forward-slash paths of every *.test.* file under tests/. */
function collectTestFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.test\.[a-z]+$/i.test(entry.name)) {
        found.push(relative(repoRoot, abs).split(sep).join("/"));
      }
    }
  };
  walk(testsRoot);
  return found.sort();
}

function matchesSomeRule(path: string): boolean {
  return TEST_FILE_RULES.some(
    (rule) => path.startsWith(`${rule.dir}/`) && rule.exts.some((ext) => path.endsWith(ext)),
  );
}

test("every *.test.* file under tests/ is visible to the vitest include globs", () => {
  const invisible = collectTestFiles().filter((path) => !matchesSomeRule(path));
  expect(
    invisible,
    `these test files match NO rule in tests/helpers/testFileContract.ts, so vitest never runs them — rename to an admitted extension or extend the rule list: ${invisible.join(", ")}`,
  ).toEqual([]);
});

test("no test name exists as both .test.mjs and .test.ts in one directory", () => {
  const byStem = new Map<string, string[]>();
  for (const path of collectTestFiles()) {
    const stem = path.replace(/\.test\.[a-z]+$/i, "");
    byStem.set(stem, [...(byStem.get(stem) ?? []), path]);
  }
  const twins = [...byStem.values()].filter((paths) => paths.length > 1).flat();
  expect(
    twins,
    `converted tests must REPLACE their .mjs original in the same commit — a leftover copy runs stale duplicates: ${twins.join(", ")}`,
  ).toEqual([]);
});
