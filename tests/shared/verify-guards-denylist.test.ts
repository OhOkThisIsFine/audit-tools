/**
 * The `verify:guards` script (package.json) is the per-node cross-cutting GUARD suite —
 * the full vitest run MINUS the heavy subprocess-spawning integration/e2e tests, named
 * as an additive-safe denylist of `--exclude` globs. A HEAVY test that gets RENAMED
 * would silently fall OUT of the denylist and back INTO the per-node guard, blowing up
 * the per-node guard's cost (that guard runs in the hot accept path). This test pins the
 * denylist honest: every active `--exclude` glob must still match ≥1 existing test file
 * on disk. Exact frozen entries for retired suites are tolerated only while they remain
 * unmatched, so they cannot silently mask a newly introduced test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

// package.json is frozen during the execution-surface retirement. These exact
// exclusions may remain until that frozen file can be updated, but they must
// not mask a newly introduced test with the same retired name.
const RETIRED_EXCLUDE_GLOBS = new Set([
  "**/*-e2e.test.*",
  "**/next-step-implement-dispatch.test.ts",
]);

/** Recursively collect every test file under `tests/`, as repo-relative forward-slash paths. */
function listTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else if (/\.test\.[cm]?[jt]s$/.test(ent.name)) out.push(r);
    }
  };
  walk(join(repoRoot, "tests"), "tests");
  return out;
}

// `globToRegExp` is IMPORTED, never re-declared. This file carried a "minimal"
// local copy whose comment conceded the gap ("supports `**` / `**\/` / `*`") —
// and it had already drifted from the production compiler in
// `scripts/check-doc-manifest.mjs`: no `<date>` token, a bare `?` emitted as a
// live regex quantifier instead of `[^/]`, `**\/` widened to `(?:.*/)?` where
// production uses `(?:[^/]+/)*`, and a narrower escape class. The same repo
// imports the production one in `tests/shared/doc-manifest-gate.test.ts`, so the
// question "which glob grammar does THIS test mean?" had two answers.
//
// The consequence was concrete: this test decides whether an `--exclude` glob in
// `verify:guards` still matches a real test file, i.e. whether the denylist is
// honest. Grading the denylist with a different matcher than the runner uses is
// the one thing an honest denylist check cannot do.
//
// `tests/shared/test-mirrors-production.test.ts` is the invariant that keeps a
// third copy from appearing.
import { globToRegExp } from "../../scripts/check-doc-manifest.mjs";

/**
 * Pull the `--exclude "<glob>"` values out of the verify:guards script string.
 * Accepts either quote style — but the script MUST use double quotes so the globs
 * survive `npm run` on BOTH cmd.exe (Windows strips only double quotes; single
 * quotes pass through literally and never match) and POSIX sh.
 */
function excludeGlobs(script: string): string[] {
  const globs: string[] = [];
  const rx = /--exclude\s+(?:"([^"]+)"|'([^']+)')/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(script)) !== null) globs.push((m[1] ?? m[2]) as string);
  return globs;
}

describe("verify:guards denylist — active excludes still match real test files", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const script = pkg.scripts["verify:guards"];
  const globs = excludeGlobs(script);
  const files = listTestFiles();

  it("verify:guards exists and carries a non-empty --exclude denylist", () => {
    expect(typeof script).toBe("string");
    expect(globs.length).toBeGreaterThan(0);
  });

  it("uses DOUBLE-quoted excludes (single quotes pass through literally under npm+cmd.exe on Windows)", () => {
    // cmd.exe strips only double quotes; a single-quoted glob reaches vitest WITH the
    // quotes and matches nothing → the heavy tests silently re-enter the per-node guard.
    expect(script).not.toMatch(/--exclude\s+'/);
    expect(script).toMatch(/--exclude\s+"/);
  });

  it.each(globs.filter((glob) => !RETIRED_EXCLUDE_GLOBS.has(glob)))(
    "exclude glob %s matches at least one existing test file",
    (glob) => {
      const re = globToRegExp(glob);
      const matched = files.filter((f) => re.test(f));
      expect(matched.length).toBeGreaterThan(0);
    },
  );

  it.each([...RETIRED_EXCLUDE_GLOBS])(
    "retired exclude glob %s does not mask a newly introduced test",
    (glob) => {
      if (!globs.includes(glob)) return;
      const re = globToRegExp(glob);
      const matched = files.filter((f) => re.test(f));
      expect(matched).toEqual([]);
    },
  );
});
