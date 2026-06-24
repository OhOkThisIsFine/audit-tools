import { existsSync } from "node:fs";
import { join } from "node:path";
import { runTracked } from "./tooling/exec.js";

// Git helpers shared by both orchestrators. The remediator previously issued
// `git` calls inline in close.ts and plan.ts; the auditor's Phase 3 delta mode
// needs the same primitives. All run through the shared `runTracked` so the
// one Windows-wrapping implementation applies, and all degrade to empty/false
// when git is unavailable or the command fails (never throw).

function gitLines(root: string, args: string[]): string[] {
  const result = runTracked(["git", ...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** True when `root` is inside a git working tree. */
export function isGitRepo(root: string): boolean {
  if (existsSync(join(root, ".git"))) return true;
  const result = runTracked(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

/**
 * True when `ref` resolves to a commit in `root`. Lets callers distinguish a
 * mistyped/unknown `--since` ref (fall back to a full audit) from a valid ref
 * with no changes (`changedFiles` returns `[]` in both cases otherwise).
 */
export function gitRefExists(root: string, ref: string): boolean {
  const result = runTracked(
    ["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: root, encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim().length > 0;
}

/**
 * Files differing between `since` (a ref/SHA) and the current working tree —
 * committed, staged, and unstaged. Backs the auditor's `--since` delta mode.
 */
export function changedFiles(root: string, since: string): string[] {
  return gitLines(root, ["diff", "--name-only", since]);
}

/** The set of commit SHAs that have touched `path`, newest first. */
export function fileCommits(root: string, path: string): Set<string> {
  return new Set(gitLines(root, ["log", "--format=%H", "--", path]));
}

/**
 * One commit's metadata plus the set of repo-relative file paths it touched.
 * Used by the git-history miner; the raw log is parsed into these records, then
 * the deterministic co-change / churn / authorship aggregates are derived.
 */
interface GitCommitRecord {
  sha: string;
  author: string;
  files: string[];
}

/**
 * Parse `git log --name-only` output (with our `%H%x00%an` header format) into
 * per-commit records. Tolerant of blank lines and malformed headers; degrades
 * to an empty list rather than throwing on unexpected shapes.
 */
function parseCommitRecords(stdout: string): GitCommitRecord[] {
  const records: GitCommitRecord[] = [];
  let current: GitCommitRecord | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      // Header line: "<sha>\0<author>".
      const sha = line.slice(0, nul).trim();
      const author = line.slice(nul + 1).trim();
      if (sha.length > 0) {
        current = { sha, author, files: [] };
        records.push(current);
      } else {
        current = null;
      }
      continue;
    }
    if (current) {
      const file = line.trim();
      if (file.length > 0) current.files.push(file);
    }
  }
  return records;
}

/** A pair of files that changed together, with the number of shared commits. */
export interface CoChangePair {
  a: string;
  b: string;
  commits: number;
}

/** Per-file change frequency (number of commits that touched the file). */
export interface ChurnEntry {
  path: string;
  commits: number;
}

/** Per-file authorship breadth (number of distinct authors that touched it). */
export interface AuthorshipEntry {
  path: string;
  authors: number;
}

/** Deterministic git-history aggregates mined from the commit log. */
export interface GitHistory {
  co_change: CoChangePair[];
  churn: ChurnEntry[];
  authorship: AuthorshipEntry[];
}

export interface MineGitHistoryOptions {
  /** Cap on commits scanned, newest first (bounds cost on large repos). */
  maxCommits?: number;
  /** Minimum shared-commit count for a co-change pair to be reported. */
  minCoChangeCommits?: number;
}

const DEFAULT_MAX_COMMITS = 1000;
const DEFAULT_MIN_CO_CHANGE_COMMITS = 2;

/**
 * Mine deterministic git-history signals from `root`'s commit log:
 *  - **co_change**: file pairs that changed in the same commit, counted across
 *    history (a temporal-coupling signal), filtered by `minCoChangeCommits`.
 *  - **churn**: per-file commit-touch frequency.
 *  - **authorship**: per-file distinct-author count (a bus-factor signal).
 *
 * Fully deterministic: every list is sorted by a total order (counts descending,
 * then lexicographic ids) so identical history yields byte-identical output.
 * Degrades to empty (`{co_change:[],churn:[],authorship:[]}`) when `root` is not
 * a git repo or the log command fails — never throws.
 */
export function mineGitHistory(
  root: string,
  options: MineGitHistoryOptions = {},
): GitHistory {
  const empty: GitHistory = { co_change: [], churn: [], authorship: [] };
  if (!isGitRepo(root)) return empty;

  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const minCoChange =
    options.minCoChangeCommits ?? DEFAULT_MIN_CO_CHANGE_COMMITS;

  const result = runTracked(
    [
      "git",
      "log",
      `--max-count=${maxCommits}`,
      "--no-merges",
      "--name-only",
      "--format=%H%x00%an",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) return empty;

  const records = parseCommitRecords(result.stdout);
  if (records.length === 0) return empty;

  const churn = new Map<string, number>();
  const authors = new Map<string, Set<string>>();
  const coChange = new Map<string, number>();

  for (const record of records) {
    // Dedup files within a commit so a rename/edit pair cannot double-count.
    const files = [...new Set(record.files)].sort();
    for (const file of files) {
      churn.set(file, (churn.get(file) ?? 0) + 1);
      let authorSet = authors.get(file);
      if (!authorSet) {
        authorSet = new Set();
        authors.set(file, authorSet);
      }
      if (record.author.length > 0) authorSet.add(record.author);
    }
    for (let i = 0; i < files.length; i += 1) {
      for (let j = i + 1; j < files.length; j += 1) {
        // a < b guaranteed by the sort above, so the pair key is canonical.
        const key = `${files[i]}\0${files[j]}`;
        coChange.set(key, (coChange.get(key) ?? 0) + 1);
      }
    }
  }

  const churnList: ChurnEntry[] = [...churn.entries()]
    .map(([path, commits]) => ({ path, commits }))
    .sort((x, y) => y.commits - x.commits || x.path.localeCompare(y.path));

  const authorshipList: AuthorshipEntry[] = [...authors.entries()]
    .map(([path, set]) => ({ path, authors: set.size }))
    .sort((x, y) => y.authors - x.authors || x.path.localeCompare(y.path));

  const coChangeList: CoChangePair[] = [...coChange.entries()]
    .filter(([, commits]) => commits >= minCoChange)
    .map(([key, commits]) => {
      const [a, b] = key.split("\0");
      return { a: a ?? "", b: b ?? "", commits };
    })
    .sort(
      (x, y) =>
        y.commits - x.commits ||
        x.a.localeCompare(y.a) ||
        x.b.localeCompare(y.b),
    );

  return {
    co_change: coChangeList,
    churn: churnList,
    authorship: authorshipList,
  };
}

/** Working-tree changes vs HEAD plus untracked (non-ignored) files. */
export function stagedAndUntracked(root: string): string[] {
  const files = new Set<string>();
  for (const file of gitLines(root, ["diff", "--name-only", "HEAD"])) {
    files.add(file);
  }
  for (const file of gitLines(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ])) {
    files.add(file);
  }
  return [...files];
}
