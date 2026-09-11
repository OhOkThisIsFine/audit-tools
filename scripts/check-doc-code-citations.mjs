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
 *
 * TWO SETS, because the two uses must not move together. `examined` is what the
 * tree COMMITS to — tracked files plus the index, never an untracked scratch
 * file — and it is what the rules that decide WHICH citations are checked read
 * (the bare-name extension-skip set). `universe` adds untracked non-ignored
 * files, which may only RESOLVE a citation as a target: a file being authored in
 * this change must resolve, but a stray `notes.log` at the root must not widen
 * the extension census and flip an unrelated doc's citation from skipped to
 * failing (the 2026-08-19 release-gate refusal, where the same docs had passed
 * the commit gate minutes earlier).
 */
function trackedFiles() {
  const deleted = new Set(
    git(["ls-files", "-z", "--deleted"]).split("\0").filter(Boolean),
  );
  const examined = new Set(
    git(["ls-files", "-z"])
    .split("\0")
    .filter((path) => path && !deleted.has(path)),
  );
  const universe = new Set(examined);
  for (const path of git(["ls-files", "-z", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean)) {
    universe.add(path);
  }
  return { examined: [...examined], universe: [...universe] };
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

/** Does this token carry a line-anchor suffix at all? */
function hasLineSuffix(token) {
  return stripLineSuffix(token) !== token;
}

/**
 * A line anchor into SOURCE is refused; into anything else it is allowed.
 *
 * Owner preference, 2026-09-06: *"in general we should make citations refer to
 * symbols and not line numbers"*. The reason is decay, not style — a line number
 * is wrong the moment anything is inserted above it, and this gate proves the
 * point: it resolves the PATH and has always thrown the line suffix away, so a
 * citation could rot to a completely unrelated statement and every check stayed
 * green. A symbol name survives every edit that does not rename it, and a rename
 * is exactly when the citation SHOULD break.
 */
const CODE_EXTENSIONS = new Set(["ts", "tsx", "mjs", "cjs", "js", "jsx"]);

/**
 * ⚠ The rule needs NO exclusion list of its own, and adding one would be a second
 * home for a decision the doc manifest already owns. This gate scans only the
 * docs the manifest does not exclude — 54 of 209 tracked markdown files — and the
 * two classes that carry essentially every line anchor are already outside it:
 * generated tool output under the runtime state dirs, and dated review records.
 *
 * Measured 2026-09-06, which is why that matters: 2,781 code line anchors live
 * under the runtime state dirs and 935 in dated review records, against ZERO in
 * the living authored docs this gate reads. So the rule starts green, and it
 * binds exactly the documents a person maintains by hand. To widen it to either
 * class, change the manifest's excluded row — not this file.
 */

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

/**
 * Every identifier the tree declares or names in a string — the resolution set
 * for the `spec/**` symbol rule. Deliberately WIDER than "declared": a symbol
 * cited from a spec is one the code OWNS, and the spellings that legitimately
 * count are a binding, a type body's field, a member access, a quoted string
 * (an env-var name is a value, not an identifier), and a module's own basename
 * (`nextStepHelpers` is how prose cites a file). Anything narrower reds real
 * citations; anything wider — a template literal's contents, a bare `index` —
 * swallows drift.
 *
 * Reads the same file set the FILE-RESOLUTION rule reads, so a symbol in a
 * source file the tree does not carry cannot green a spec citation.
 */
function declaredIdentifierUniverse(paths) {
  const names = new Set();
  const SOURCE = /\.(ts|tsx|mjs|cjs|js|jsx)$/;
  const DECLARATION =
    /\b(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const FIELD = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/gm;
  const MEMBER = /\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const QUOTED = /["']([A-Za-z_$][A-Za-z0-9_$]*)["']/g;
  for (const path of paths) {
    if (!SOURCE.test(path)) continue;
    let source;
    try {
      source = readFileSync(join(root, path), "utf8");
    } catch {
      continue; // a tracked file absent from this worktree contributes nothing
    }
    for (const re of [DECLARATION, FIELD, MEMBER, QUOTED]) {
      for (const match of source.matchAll(re)) names.add(match[1]);
    }
    const base = path.slice(path.lastIndexOf("/") + 1).replace(SOURCE, "");
    if (base !== "index") names.add(base);
  }
  return names;
}

/**
 * Symbol-shaped backticked tokens: a compound CONSTANT or a lowerCamelCase name.
 * BOTH anchored, and the camel arm anchored at BOTH ends — `/…[A-Z]/` alone
 * matches a PREFIX, so `writeContractArtifact(...)` and `deriveNodeFiles(node)`
 * were reported as dangling symbols when they are call-shaped example prose.
 */
function isSymbolShaped(token) {
  return (
    /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(token) ||
    /^[a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*$/.test(token)
  );
}

const SYMBOL_EXEMPT = /<!--\s*symbol-citation-exempt:.*?-->/;

function main() {
  // `universe` is the RESOLUTION set (tracked + index + untracked non-ignored):
  // a file being authored in this change must resolve as a target. `examined`
  // is what the tree COMMITS to, and it is what decides WHICH citations are
  // looked at — the two must not move together, or an untracked scratch doc
  // changes the verdict of a tree that was green a moment earlier.
  const { examined, universe } = trackedFiles();
  const tracked = universe;
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
  // The EXTENSION-SKIP census reads `examined`, never the resolution universe.
  // This is the rule that decides which bare-name citations are looked at, so an
  // untracked scratch file must not be able to change it (see `trackedFiles`).
  const trackedExtensions = new Set();
  for (const path of examined) {
    const ext = HAS_EXTENSION.exec(path);
    if (ext) trackedExtensions.add(ext[1].toLowerCase());
  }
  const runtimeNames = new Set(RUNTIME_ARTIFACT_NAMES);
  const excluded = excludedMatchers();
  // WHICH DOCS ARE READ is a decision about the citations the gate examines, so
  // it reads `examined` — an untracked doc may be CITED (it joins `trackedSet`
  // above as a resolution target) but must never add citations of its own to
  // the corpus. The first version of this gate built both from `universe`,
  // which made an untracked `spec/zz-probe.md` able to red a green tree with a
  // citation path resolution would never have visited.
  const markdown = examined.filter(
    (p) => p.endsWith(".md") && !excluded.some((re) => re.test(p)),
  );

  // TWO RULES, TWO SCOPES, and the difference is deliberate.
  //
  // Path RESOLUTION runs over `markdown` — the manifest's narrower set — because
  // a dated review record legitimately cites paths that were deleted after it was
  // written, and reddening it for that would make the record unmaintainable.
  //
  // The LINE-ANCHOR rule runs wider, over every tracked doc outside the runtime
  // state dirs, because a dead anchor is not a historical fact the way a deleted
  // path is: it points at whatever now occupies that line number, which is a
  // statement the record never made. Owner decision 2026-09-06, on measurement —
  // of 935 anchors in dated review records, 640 named a path that no longer
  // resolved and every resolvable one sampled pointed at unrelated content:
  // "If the line number citations are meaningless, we should remove them." They
  // were removed; this scope is what stops them coming back.
  //
  // The runtime state dirs stay out because they are generated: the next run
  // rewrites them, so a refusal there would be unfixable by editing.
  const anchorScope = examined.filter(
    (p) => p.endsWith(".md") && !RUNTIME_STATE_PREFIXES.some((s) => p.startsWith(s)),
  );
  const resolutionScope = new Set(markdown);

  // A THIRD RULE, on `spec/**` ONLY: a backticked SYMBOL citation that names
  // nothing in the tree.
  //
  // The wiring is what rots. `spec/remediate/remediation-goals.md` named
  // `dependencyAwaitingClarification` as the held-pending mechanism long after
  // the frontier unification deleted it, and `check:doc-code-citations` stayed
  // green — the gate resolves PATHS and has always ignored a bare identifier.
  // A constitutional doc cannot silently drift from the code it measures while
  // an owner decision is outstanding, so the dangling symbol is surfaced.
  //
  // A WARNING, not a red, and the reason is the message: `spec/**` includes the
  // escalate-only constitutional subset, where a mechanical edit is exactly what
  // the commit gate refuses. Reddening would block a commit the constitution
  // says only an owner may resolve — the gate would be enforcing at a boundary it
  // does not own (PH-05). So it prints, names the file and line, and exits 0;
  // the mechanical part is that it can no longer be INVISIBLE.
  const declaredSymbols = declaredIdentifierUniverse(tracked);
  const danglingSymbols = [];

  // Pass 1 — collect classified citation records, so gitignore scoping can run
  // as ONE batched git call over every candidate instead of a spawn per token.
  const records = [];
  /** Line anchors into source, collected by the same scan. */
  const lineAnchors = [];
  for (const relPath of anchorScope) {
    const resolves = resolutionScope.has(relPath);
    const lines = readFileSync(join(root, relPath), "utf8").split("\n");
    const isSpec = relPath.startsWith("spec/");
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

        // The SYMBOL rule, `spec/**` only. A token that is a repo path (it has
        // a slash or an extension) is the other rule's business; this one is
        // about the bare identifier a spec names as a mechanism.
        if (isSpec && !path.includes("/") && !HAS_EXTENSION.test(path) && isSymbolShaped(path)) {
          const symbolExempt =
            exempt ||
            SYMBOL_EXEMPT.test(line) ||
            (i > 0 && SYMBOL_EXEMPT.test(lines[i - 1]));
          if (!symbolExempt && !declaredSymbols.has(path)) {
            danglingSymbols.push({ relPath, line: i + 1, token: path });
          }
        }

        // The line-anchor rule rides the same scan: this loop already has the
        // token, the line and the exemption, so a second pass over the corpus
        // would only be a second place to keep in step with this one.
        if (!exempt && hasLineSuffix(token)) {
          const ext = HAS_EXTENSION.exec(path);
          if (ext && CODE_EXTENSIONS.has(ext[1].toLowerCase())) {
            lineAnchors.push({ relPath, line: i + 1, token, path });
          }
        }

        // Past here is PATH RESOLUTION, which keeps the manifest's narrower
        // scope. A doc outside it was read only for the anchor rule above.
        if (!resolves) continue;

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

  if (lineAnchors.length > 0) {
    console.error(
      `check-doc-code-citations: ${lineAnchors.length} citation(s) anchor to a LINE NUMBER in source:`,
    );
    for (const a of lineAnchors) {
      console.error(`  ${a.relPath}:${a.line}  \`${a.token}\``);
    }
    console.error(
      "\nCite the SYMBOL instead — the function, type, constant or export, and the file that holds " +
        "it. A line number is wrong as soon as anything is inserted above it, and this gate resolves " +
        "only the PATH, so a rotted anchor stays green forever. Write `renderContractRepairPrompt` in " +
        "`src/remediate/steps/contractPipelinePrompts.ts`, not `contractPipelinePrompts.ts:566`.\n" +
        "When there is genuinely no symbol to name — a data row, a config line — keep the anchor and " +
        "put `<!-- doc-citation-exempt: <reason> -->` on the line above it, saying what is at that line.",
    );
    process.exit(1);
  }

  // The symbol rule PRINTS but does not fail — see the comment at its collection
  // site. A spec citing a symbol the tree does not carry is surfaced on every run
  // rather than discovered by whoever next reads the doc, which is the property
  // the entry asked for; the escalation stays the owner's, because `spec/**`
  // includes the constitutional subset a mechanical edit may not touch.
  if (danglingSymbols.length > 0) {
    console.warn(
      `⚠ check-doc-code-citations: ${danglingSymbols.length} backticked symbol citation(s) in spec/ ` +
        `name nothing the tree declares:`,
    );
    for (const d of danglingSymbols) {
      console.warn(`  ${d.relPath}:${d.line}  \`${d.token}\``);
    }
    console.warn(
      "The code a spec measures has moved on. Re-point the citation at the symbol that replaced " +
        "it, or — for a design record deliberately naming a retired mechanism — put " +
        "`<!-- symbol-citation-exempt: <what it was> -->` on the line above it. Not a failure: a " +
        "constitutional spec is escalate-only, so only an owner may resolve it.",
    );
  }

  console.log(
    `check-doc-code-citations: ${counts.path} path + ${counts.dir} directory + ` +
      `${counts.bare} bare-filename citation(s) across ${markdown.length} tracked docs — ` +
      `every one resolves, and none anchors to a source line.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
