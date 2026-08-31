/**
 * A gate script that NAMES test files must name files that exist.
 *
 * `test:doc-contract` listed `tests/audit/file-lock-doc-sync.test.ts` for months
 * after `467b1e8f` deleted it. `vitest run <missing path>` does not fail — it
 * silently runs the paths it can resolve — so the gate ran three of its four
 * declared legs and reported green, while every reader of `package.json` (and
 * the pre-commit refusal message, which named that file by hand) believed four
 * ran. An independent audit of a closeout found it, which is exactly the reach
 * question this repo answers with data instead of reading.
 *
 * The instance is fixed by deleting the dead path. This pins the CLASS: a
 * deletion that leaves a gate script pointing at a ghost reds here, at the
 * commit that deletes the file, rather than quietly narrowing a gate.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "vitest";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("every test path named in a package.json script exists", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  /** @type {Record<string, string>} */
  const scripts = pkg.scripts ?? {};

  const missing: { script: string; path: string }[] = [];
  for (const [name, body] of Object.entries(scripts)) {
    // Only literal test paths — a glob or a directory is the runner's business,
    // and this test claims nothing about those.
    for (const match of String(body).matchAll(/(?:^|\s)((?:tests|src)\/\S+\.test\.(?:ts|mjs))(?=\s|$)/g)) {
      const path = match[1];
      if (!existsSync(join(REPO_ROOT, path))) missing.push({ script: name, path });
    }
  }

  expect(
    missing,
    `a gate script names a test file that does not exist. vitest does NOT fail on a missing path, ` +
      `so the gate silently runs fewer legs than it declares:\n` +
      missing.map((m) => `  - ${m.script} -> ${m.path}`).join("\n"),
  ).toEqual([]);
});
