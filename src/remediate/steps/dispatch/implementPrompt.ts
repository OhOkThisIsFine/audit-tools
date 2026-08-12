import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  toPromptPathToken,
  isBareBasename,
  resolveBasenameToTrackedPath,
} from "audit-tools/shared";

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const WALK_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", "out",
  ".next", ".turbo", ".audit-tools",
]);

/** Bounded recursive scan for test files under `root` (skips vendor/build dirs). */
function walkTestFiles(root: string, max = 400): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  let visited = 0;
  while (stack.length > 0 && out.length < max) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > 20000) return out;
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".test-")) continue;
        stack.push(join(dir, entry.name));
      } else if (TEST_FILE_RE.test(entry.name)) {
        out.push(join(dir, entry.name));
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

/**
 * Best-effort: repo-relative test files that reference any of `sourceFiles` (by
 * module basename). Pulling them into a block's access lets the worker that
 * changes or removes a symbol also fix the tests that assert it, instead of
 * leaving orphaned test breakage for a separate central mop-up. Matching is
 * deliberately loose (a false positive only grants slightly broader, harmless
 * write access; a false negative is the failure mode we want to avoid).
 */
export interface TestFileEntry {
  rel: string;
  content: string;
}

/**
 * Walk the repo ONCE and read every test file's content (bounded). Built once per
 * dispatch and shared across all blocks so the filesystem walk + reads are not
 * repeated per block.
 */
export function buildTestFileIndex(root: string): TestFileEntry[] {
  const index: TestFileEntry[] = [];
  for (const testPath of walkTestFiles(root)) {
    let content: string;
    try {
      content = readFileSync(testPath, "utf8");
    } catch {
      continue;
    }
    index.push({ rel: relative(root, testPath).replace(/\\/g, "/"), content });
  }
  return index;
}

/**
 * Collect test files from `index` that reference any of `sourceFiles` by
 * module basename. When `packageRoot` is supplied (repo-relative prefix, e.g.
 * `packages/foo`), only test files under that package are considered —
 * otherwise all test files in the index are matched (existing behavior).
 */
export function collectReferencingTests(
  index: TestFileEntry[],
  sourceFiles: string[],
  packageRoot?: string,
): string[] {
  if (sourceFiles.length === 0 || index.length === 0) return [];
  const basenames = sourceFiles
    .map((f) => (f.split(/[/\\]/).pop() ?? f).replace(/\.[cm]?[jt]sx?$/, ""))
    .filter((b) => b.length > 1);
  if (basenames.length === 0) return [];
  const needles = basenames.map(
    (b) => new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
  );
  const sourceSet = new Set(sourceFiles.map((f) => f.replace(/\\/g, "/")));
  // Normalize packageRoot to forward slashes and ensure it ends without trailing slash
  const pkgPrefix = packageRoot
    ? packageRoot.replace(/\\/g, "/").replace(/\/$/, "") + "/"
    : null;
  const result: string[] = [];
  for (const { rel, content } of index) {
    if (sourceSet.has(rel)) continue;
    // If a package scope is set, skip files outside that package
    if (pkgPrefix && !rel.startsWith(pkgPrefix)) continue;
    if (needles.some((re) => re.test(content))) result.push(rel);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Infra-modifying block detection
// ---------------------------------------------------------------------------

/**
 * The live dispatch/orchestration modules whose modification can break the
 * running engine mid-run. Derived from the REAL post-A12 source layout
 * (`src/remediate/...`) — this module IS one of them (`steps/dispatch.ts`), so
 * the list is anchored to the actual files on disk, not a hand-typed monorepo
 * path that drifts when the tree is reorganised (the pre-A12
 * `packages/remediate-code/...` list silently matched NOTHING after the
 * collapse, so every infra block rendered as non-infra). Each entry is the
 * module's path relative to the `src/remediate` area, forward-slash form.
 */
const INFRA_MODULE_SUBPATHS = [
  "steps/nextStep.ts",
  "steps/dispatch.ts",
  "state/store.ts",
  "steps/contractPipeline.ts",
  "steps/stepWriter.ts",
] as const;

/**
 * The infra module sub-paths anchored under `src/remediate/` — the canonical
 * repo-relative form for the current (post-A12) single-package layout. A write
 * path matches when its normalised (forward-slash) form ends with one of these
 * segments, so an absolute worktree path
 * (`.../worktrees/foo/src/remediate/steps/dispatch.ts`), a repo-relative path
 * (`src/remediate/steps/dispatch.ts`), or a Windows backslash path all match,
 * while a same-basename file in another area (`src/audit/steps/dispatch.ts`)
 * does not.
 */
const INFRA_FILE_SEGMENTS: readonly string[] = INFRA_MODULE_SUBPATHS.map(
  (sub) => `src/remediate/${sub}`,
);

/**
 * Returns true when any path in `writePaths` is one of the live infra modules.
 * Paths are normalised to forward-slash form (win32 backslash → `/`) and matched
 * by trailing repo-relative segment so absolute/worktree/relative spellings all
 * resolve identically. Used to gate the live-surface verification section in the
 * implement prompt.
 */
export function isInfraModifyingBlock(writePaths: string[]): boolean {
  for (const p of writePaths) {
    const normalized = p.replace(/\\/g, "/");
    for (const segment of INFRA_FILE_SEGMENTS) {
      if (normalized === segment || normalized.endsWith("/" + segment)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * INV-B3-5: resolve a cited source path to the token the worker should open.
 *
 * A bare basename (`advance.ts`) that uniquely resolves to one tracked path
 * (`src/audit/orchestrator/advance.ts`) is rewritten to that tracked path FIRST,
 * so it never surfaces as a broken `<worktreeRoot>/advance.ts` prefix that
 * misdirects the worker to a non-existent top-level file. Full / dotfile-dir /
 * already-absolute / drive-letter paths pass through unchanged; when a worktree
 * root is present, a relative path is prefixed onto it (unchanged behaviour). An
 * ambiguous or unresolvable basename is left as-is (monotonic — never a
 * regression on paths that already resolved).
 */
export function resolveCitationPathForPrompt(
  rel: string,
  worktreeRoot: string | undefined,
  trackedPaths: ReadonlySet<string>,
): string {
  let target = rel;
  if (isBareBasename(rel)) {
    const resolved = resolveBasenameToTrackedPath(rel, trackedPaths);
    if (resolved) target = resolved;
  }
  if (!worktreeRoot) return target;
  if (target.startsWith("/") || /^[A-Za-z]:[/\\]/.test(target)) return target;
  return toPromptPathToken(join(worktreeRoot, target));
}
