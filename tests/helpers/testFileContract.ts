/**
 * Single source of truth for WHICH files are test files — consumed by BOTH
 * `vitest.config.ts` (as its `include` globs) and the visibility guard
 * (`tests/shared/test-suite-visibility.test.ts`), so the two cannot drift.
 *
 * Why this exists: during the `.mjs` → `.ts` test-tree conversion, a renamed
 * file that vitest's `include` does not match SILENTLY leaves the suite — the
 * suite stays green with one fewer file, which is the invisible-test class this
 * repo already documents (a test beside a hook never ran because vitest
 * excludes `.claude/**`). Deriving the globs and the guard from one rule list
 * makes that state unrepresentable: a `*.test.*` file either matches a rule
 * (so vitest runs it) or the guard names it and fails.
 */

export interface TestFileRule {
  /** Repo-relative directory prefix, forward slashes, no trailing slash. */
  readonly dir: string;
  /** Filename suffixes admitted as test files under `dir`. */
  readonly exts: readonly string[];
}

/**
 * The admitted test-file shapes. audit + shared admit both extensions while the
 * `.mjs` → `.ts` conversion is in flight; remediate finished as `.test.ts`.
 * When the conversion completes, drop `".test.mjs"` here and the guard starts
 * refusing stragglers.
 */
export const TEST_FILE_RULES: readonly TestFileRule[] = [
  { dir: "tests/audit", exts: [".test.mjs", ".test.ts"] },
  { dir: "tests/remediate", exts: [".test.ts"] },
  { dir: "tests/shared", exts: [".test.mjs", ".test.ts"] },
];

/** The vitest `include` globs, derived — never hand-listed in the config. */
export function vitestIncludeGlobs(): string[] {
  return TEST_FILE_RULES.flatMap((rule) => rule.exts.map((ext) => `${rule.dir}/**/*${ext}`));
}
