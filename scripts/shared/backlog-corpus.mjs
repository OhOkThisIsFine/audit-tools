// sites-pinned: tests/shared/backlog-index.test.ts
// The ONE enumeration + parse of the split backlog, shared by every validator
// and by the seek-index generator.
//
// WHY THIS EXISTS (ceremony review F5, packet 23). The four backlog validators
// — budget, status-tokens, line-numbers, friction-tags — each ran
// `readdirSync(backlogDir)` and re-split the files it read, so one staging of
// `docs/backlog/open-bugs.md` spawned four processes that enumerated the
// directory off DISK rather than off the git index. Every other gate in the
// tree uses `git ls-files` and says why: an untracked scratch file in
// `docs/backlog/` reds the build, and a fresh CI clone can disagree with a
// local run. This module is the one place that reads the corpus, so "which
// entries exist" and "which files are in scope" have a single definition that
// a drift cannot split — the same property the shared entry grammar
// (`splitBacklogEntries`) gives the segmentation.
//
// WHAT IS SHARED, and what is deliberately NOT. The enumeration (git index, not
// disk) and the per-file parse (entries via `splitBacklogEntries`) live here;
// each validator keeps its OWN refusal text, because the four properties are
// genuinely distinct and a distinct diagnostic is the whole point of keeping
// them separable (packet 23 acceptance). The budget gate's `--update-baseline`
// WRITE mode stays in `check-backlog-budget.mjs` — it is an operational
// ratchet command, not a read predicate, and its baseline file
// (`.size-baseline.json`) lives beside the corpus it meters.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitBacklogEntries } from "./backlog-entry-grammar.mjs";

/** The repo-root of this checkout, resolved from THIS module's location. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The split backlog lives under docs/backlog/. */
export const BACKLOG_DIR = join(REPO_ROOT, "docs", "backlog");

/**
 * Every backlog entry file, from the git INDEX — never `readdirSync`. Order is
 * stable (git emits sorted) and an untracked scratch file is out of scope,
 * which is the fix F5 names: a gate enumerating the disk reds on a file the
 * next clone never has.
 *
 * @param {string} [root] repo root; defaults to this checkout.
 * @param {(args: string[]) => string} [git] injectable for fixtures; defaults
 *   to `git ls-files`.
 * @returns {string[]} backlog `.md` filenames, relative to `docs/backlog/`.
 */
export function listBacklogFiles(root = REPO_ROOT, git = (args) => execFileSync("git", args, {
  encoding: "utf8", cwd: root, windowsHide: true, // INV-WH — windowsHide on every git spawn
})) {
  const out = git(["ls-files", "docs/backlog/"]);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("docs/backlog/") && line.endsWith(".md"))
    .map((line) => line.slice("docs/backlog/".length))
    .sort();
}

/**
 * Read and parse the whole backlog corpus ONCE. Each file is read and split
 * into its top-level entries by the shared grammar; the returned entries carry
 * the file they came from so a caller never re-splits or re-reads to attribute
 * a finding.
 *
 * @param {string[]} files backlog filenames (see {@link listBacklogFiles})
 * @param {string} [root]
 * @returns {{file: string, text: string, entries: {line: number, headline: string, body: string}[]}[]}
 */
export function readBacklogCorpus(files, root = REPO_ROOT) {
  return files.map((file) => {
    const text = readFileSync(join(root, "docs", "backlog", file), "utf8");
    return { file, text, entries: splitBacklogEntries(text) };
  });
}

/**
 * The whole corpus in one call — the common case. Enumerates the git index and
 * parses every file once.
 */
export function loadBacklog(root = REPO_ROOT, git) {
  return readBacklogCorpus(listBacklogFiles(root, git), root);
}
