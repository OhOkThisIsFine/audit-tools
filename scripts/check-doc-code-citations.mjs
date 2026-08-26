#!/usr/bin/env node
// Backticked repo-path citation gate for tracked markdown.
//
// Docs here cite code overwhelmingly as a path in backticks (`src/foo/bar.ts`),
// not as a markdown link — and until this gate only the link form was checked
// (`check:doc-links`), so a rename/delete left every backtick citation pointing
// at nothing. The `.mjs`→`.ts` test conversion alone stranded 31 such citations
// across 9 docs, found a week later by a nightly review instead of at the commit
// that renamed the files.
//
// Resolution is against the GIT-TRACKED file set, never `existsSync`: a gate
// that asks the local disk is green on the machine that has the artifact and
// red in a fresh CI clone (the exact false-green/false-red split the doc-links
// gate had to fix). Gitignored citations are scoped out the same way — one
// batched `git check-ignore --stdin` (index/rules-based, fresh-clone stable),
// never a disk probe.
//
// THREE citation classes are checked (sol-4/P29 widened the last two — they
// were previously skipped outright, which both hid stale citations and
// overstated the printed tally):
//
//   • PATH — contains a `/`, first segment is a top-level dir that actually
//     holds tracked files, last segment carries an extension. Must name a
//     tracked file.
//   • DIRECTORY — ends with `/`. Must name a tracked directory (a dir prefix
//     of the tracked set), resolved root-relative first and then relative to
//     the citing doc (`src/audit/README.md` citing `orchestrator/`). Never
//     resolved anywhere-in-tree: a stale `prompts/` must not stay green just
//     because `.github/prompts/` exists somewhere (the P29 defect).
//   • BARE FILENAME — no `/`, carries an extension. Resolved against tracked
//     basenames: no match is red, and so is an ambiguous match (the same
//     basename tracked in two places — cite the full path instead), with ONE
//     tie-break: when exactly one candidate sits at the repo root the citation
//     resolves to it (`README.md` is the repo idiom for the root readme, and a
//     root file has no slashed form to disambiguate with).
//
// Out of scope by rule, not by hand-list:
//   • pattern/placeholder tokens (`*`, `{`, `<`, `>`, `…`) — globs/templates;
//   • non-repo tokens: `~`-homed, drive-lettered (`C:/…`), URL-schemed
//     (`://`), backslashed Windows prose, and `.`/`..` navigation;
//   • the runtime state layout (`.audit-tools/…`) and any gitignored path;
//   • bare names with a leading `.` or `-` (extension-mention idiom: `.ts`,
//     `-outcomes.json`) — the cost is that dotfile citations (`.gitignore`)
//     go unchecked;
//   • bare names whose extension no tracked file uses (`vi.spyOn`,
//     `claude.exe`, `v0.39.4` — method/binary/version mentions);
//   • bare names in the generated run-artifact set
//     (`scripts/shared/runtime-artifact-names.generated.mjs` — extracted from
//     the runtime-layout sources, never a hand list): `repo_manifest.json`
//     names what a run writes, not a repo file.
// A trailing `:123` / `:12-34` / `:~653` line suffix is stripped before
// resolution (line-anchored citations are the repo's normal citation form).
//
// EXEMPTION is explicit and inline, never inferred from prose (the manifest's
// data-not-prose principle): an HTML comment
//     <!-- doc-citation-exempt: <reason> -->
// on the line above (or on the same line as) the citation exempts that line's
// citations. Two legitimate classes need it: third-party repo paths, and
// deliberate "this file does not exist" narrative.
//
// Files matching the doc-manifest `excluded` row (dated review records, runtime
// artifacts, the guidelines file itself) are skipped — same single-sourced set,
// imported from scripts/doc-manifest-data.mjs, never restated here.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DOC_MANIFEST } from "./doc-manifest-data.mjs";
import { globToRegExp, isGlob } from "./check-doc-manifest.mjs";
import { RUNTIME_ARTIFACT_NAMES } from "./shared/runtime-artifact-names.generated.mjs";

const root = resolve(process.argv[2] ?? process.cwd());

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

/**
 * All versionable files present in the working tree (forward-slashed) — the
 * resolution universe. `git ls-files` alone includes unstaged deletions and
 * omits newly-created source, which made a pre-stage verification both crash
 * on retired docs and reject citations to files being added in the same change.
 * The union below models the tree that `git add -A` would stage without
 * mutating the index.
 */
function trackedFiles() {
  const deleted = new Set(
    git(["ls-files", "-z", "--deleted"]).split("\0").filter(Boolean),
  );
  const present = new Set(
    git(["ls-files", "-z"])
    .split("\0")
    .filter((path) => path && !deleted.has(path)),
  );
  for (const path of git(["ls-files", "-z", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean)) {
    present.add(path);
  }
  return [...present];
}

/**
 * One batched `git check-ignore --stdin -z` over every candidate path →
 * the ignored subset. Rules-based (the tracked .gitignore chain), not a disk
 * probe, so a fresh clone classifies identically. Exit 1 means "none ignored".
 */
function ignoredPaths(candidates) {
  const unique = [...new Set(candidates)].filter(Boolean);
  if (unique.length === 0) return new Set();
  let out = "";
  try {
    out = git(["check-ignore", "--stdin", "-z"], {
      input: unique.join("\0") + "\0",
    });
  } catch (err) {
    if (err && /** @type {any} */ (err).status === 1) return new Set();
    throw err;
  }
  return new Set(out.split("\0").filter(Boolean));
}

const EXEMPT_MARKER = /<!--\s*doc-citation-exempt:.*?-->/;

/** Paths the doc-manifest `excluded` row names (exact or pattern). */
function excludedMatchers() {
  const row = DOC_MANIFEST.find((r) => r.type === "excluded");
  if (!row) return [];
  return row.files.map(([pattern]) =>
    isGlob(pattern)
      ? globToRegExp(pattern)
      : new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  );
}

/** Strip a trailing line-anchor suffix (`:123`, `:12-34`, `:~653`, `:1,2`). */
function stripLineSuffix(token) {
  return token.replace(/:[~\d][\d,~–-]*$/, "");
}

const PATTERN_CHARS = /[*{<>…]/;
const HAS_EXTENSION = /\.([A-Za-z0-9]+)$/;

/** Tokens that name something outside this repository — never citations. */
function isNonRepoToken(token) {
  return (
    token.startsWith("~") ||
    /^[A-Za-z]:([\\/]|$)/.test(token) ||
    token.includes("://") ||
    token.includes("\\") ||
    token.split("/").some((segment) => segment === "." || segment === "..")
  );
}

// The runtime STATE dirs (`.audit-tools` path-module contract). Docs cite paths
// under them constantly as the run-artifact LAYOUT (`.audit-tools/audit/steps/…`)
// — those name files a run writes, never repo files, even though the dir itself
// carries two tracked report artifacts. Layout citations are out of this gate's
// scope by contract, not by hand-listing.
const RUNTIME_STATE_PREFIXES = [".audit-tools/", ".audit-tools-visibility/"];

/** Every directory prefix of the tracked set — the DIRECTORY resolution universe. */
function trackedDirs(tracked) {
  const dirs = new Set();
  for (const path of tracked) {
    let current = path;
    for (;;) {
      const slash = current.lastIndexOf("/");
      if (slash < 0) break;
      current = current.slice(0, slash);
      if (dirs.has(current)) break;
      dirs.add(current);
    }
  }
  return dirs;
}

function main() {
  const tracked = trackedFiles();
  const trackedSet = new Set(tracked);
  const dirSet = trackedDirs(tracked);
  const topDirs = new Set(
    tracked.filter((p) => p.includes("/")).map((p) => p.split("/", 1)[0]),
  );
  const byBasename = new Map();
  for (const path of tracked) {
    // Tracked files under the runtime state dirs don't participate in bare-name
    // resolution: citations INTO those dirs are out of scope by contract, so a
    // report artifact living there must not manufacture phantom ambiguity.
    if (RUNTIME_STATE_PREFIXES.some((p) => path.startsWith(p))) continue;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const bucket = byBasename.get(name);
    if (bucket) bucket.push(path);
    else byBasename.set(name, [path]);
  }
  const trackedExtensions = new Set();
  for (const path of tracked) {
    const ext = HAS_EXTENSION.exec(path);
    if (ext) trackedExtensions.add(ext[1].toLowerCase());
  }
  const runtimeNames = new Set(RUNTIME_ARTIFACT_NAMES);
  const excluded = excludedMatchers();
  const markdown = tracked.filter(
    (p) => p.endsWith(".md") && !excluded.some((re) => re.test(p)),
  );

  // Pass 1 — collect classified citation records, so gitignore scoping can run
  // as ONE batched git call over every candidate instead of a spawn per token.
  const records = [];
  for (const relPath of markdown) {
    const lines = readFileSync(join(root, relPath), "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        const token = match[1];
        if (/\s/.test(token) || PATTERN_CHARS.test(token)) continue;
        const path = stripLineSuffix(token).replace(/^\.\//, "");
        if (RUNTIME_STATE_PREFIXES.some((p) => path.startsWith(p))) continue;
        if (isNonRepoToken(path)) continue;

        const exempt =
          EXEMPT_MARKER.test(line) || (i > 0 && EXEMPT_MARKER.test(lines[i - 1]));
        const base = { relPath, line: i + 1, token, exempt };

        if (path.endsWith("/")) {
          const dir = path.replace(/\/+$/, "");
          if (!dir) continue;
          records.push({
            ...base,
            kind: "dir",
            candidates: [dir, posix.normalize(posix.join(posix.dirname(relPath), dir))],
          });
        } else if (path.includes("/")) {
          if (!topDirs.has(path.split("/", 1)[0])) continue;
          if (!HAS_EXTENSION.test(path)) continue;
          records.push({ ...base, kind: "path", path });
        } else {
          if (path.startsWith(".") || path.startsWith("-")) continue;
          const ext = HAS_EXTENSION.exec(path);
          if (!ext) continue;
          if (!trackedExtensions.has(ext[1].toLowerCase())) continue;
          if (runtimeNames.has(path)) continue;
          records.push({ ...base, kind: "bare", path });
        }
      }
    });
  }

  // Dir candidates are fed slash-terminated: a dir-only ignore pattern
  // (`dist/`) only matches a NONEXISTENT path when the queried path also ends
  // in `/` — and the path must not exist on the machine for the answer to be
  // fresh-clone stable (dist/ exists after a local build, not in CI).
  const ignored = ignoredPaths(
    records.flatMap((r) =>
      r.kind === "dir" ? r.candidates.map((c) => `${c}/`) : r.kind === "path" ? [r.path] : [],
    ),
  );

  // Pass 2 — resolve. A class counter ticks for every citation the gate actually
  // resolved (green or red); gitignored citations are out of scope, not checked.
  const counts = { path: 0, dir: 0, bare: 0 };
  const failures = [];
  const fail = (record, verdict) => {
    if (!record.exempt) failures.push({ ...record, verdict });
  };

  for (const record of records) {
    if (record.kind === "path") {
      if (ignored.has(record.path)) continue;
      counts.path += 1;
      if (trackedSet.has(record.path)) continue;
      fail(record, "does not name a tracked file");
    } else if (record.kind === "dir") {
      if (record.candidates.some((c) => dirSet.has(c))) {
        counts.dir += 1;
        continue;
      }
      if (record.candidates.some((c) => ignored.has(`${c}/`))) continue;
      counts.dir += 1;
      fail(record, "missing directory — no tracked dir at the root-relative or doc-relative path");
    } else {
      counts.bare += 1;
      const candidates = byBasename.get(record.path) ?? [];
      if (candidates.length === 1) continue;
      if (candidates.length === 0) {
        fail(record, "matches no tracked file");
      } else {
        // Root-preference tie-break: exactly one candidate at the repo root
        // wins (the root file is only citable bare — it has no longer form).
        if (candidates.filter((c) => !c.includes("/")).length === 1) continue;
        fail(
          record,
          `ambiguous (${candidates.length} candidates: ${[...candidates].sort().join(", ")}) — cite the full path`,
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error(
      `check-doc-code-citations: ${failures.length} backticked citation(s) do not resolve:`,
    );
    for (const f of failures) {
      console.error(`  ${f.relPath}:${f.line}  \`${f.token}\` — ${f.verdict}`);
    }
    console.error(
      "\nFix the citation (the file or directory moved/renamed/was deleted; an ambiguous basename " +
        "needs its full path), or — for a third-party path or deliberate does-not-exist narrative — " +
        "put `<!-- doc-citation-exempt: <reason> -->` on the line above it.",
    );
    process.exit(1);
  }

  console.log(
    `check-doc-code-citations: ${counts.path} path + ${counts.dir} directory + ` +
      `${counts.bare} bare-filename citation(s) across ${markdown.length} tracked docs — ` +
      `every one resolves.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
