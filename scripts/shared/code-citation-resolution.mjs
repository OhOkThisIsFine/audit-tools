// sites-pinned: tests/shared/comment-code-citations-gate.test.ts, tests/shared/doc-code-citations-gate.test.ts
// The ONE citation-resolution engine behind the two prose-to-code gates:
// `check:doc-code-citations` (markdown) and `check:comment-code-citations`
// (source comments). Each gate decides which TEXT it reads; this module decides
// what a backticked token in that text IS and whether it RESOLVES — so the two
// gates cannot drift on what counts as a path, a symbol, or a tracked file.
//
// Resolution is against the GIT-TRACKED file set, never `existsSync`: a gate
// that asks the local disk is green on the machine that has the artifact and red
// in a fresh CI clone. Gitignored citations are scoped out with one batched
// `git check-ignore --stdin` (rules-based, fresh-clone stable), never a disk
// probe.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

/** Run git in `root`, windowless, returning stdout. */
function git(root, args, options = {}) {
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
 * on retired files and reject citations to files being added in the same change.
 * The union below models the tree that `git add -A` would stage without
 * mutating the index.
 *
 * TWO SETS, because the two uses must not move together. `examined` is what the
 * tree COMMITS to — tracked files plus the index, never an untracked scratch
 * file — and it is what the rules that decide WHICH citations are checked read
 * (the corpus a gate scans, the bare-name extension-skip set). `universe` adds
 * untracked non-ignored files, which may only RESOLVE a citation as a target: a
 * file being authored in this change must resolve, but a stray `notes.log` at
 * the root must not widen the extension census and flip an unrelated citation
 * from skipped to failing (the 2026-08-19 release-gate refusal, where the same
 * docs had passed the commit gate minutes earlier).
 */
export function trackedFiles(root) {
  const deleted = new Set(
    git(root, ["ls-files", "-z", "--deleted"]).split("\0").filter(Boolean),
  );
  const examined = new Set(
    git(root, ["ls-files", "-z"])
      .split("\0")
      .filter((path) => path && !deleted.has(path)),
  );
  const universe = new Set(examined);
  for (const path of git(root, ["ls-files", "-z", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean)) {
    universe.add(path);
  }
  return { examined: [...examined], universe: [...universe] };
}

/**
 * One batched `git check-ignore --stdin -z` over every candidate path → the
 * ignored subset. Rules-based (the tracked .gitignore chain), not a disk probe,
 * so a fresh clone classifies identically. Exit 1 means "none ignored".
 */
export function ignoredPaths(root, candidates) {
  const unique = [...new Set(candidates)].filter(Boolean);
  if (unique.length === 0) return new Set();
  let out = "";
  try {
    out = git(root, ["check-ignore", "--stdin", "-z"], {
      input: unique.join("\0") + "\0",
    });
  } catch (err) {
    if (err && /** @type {any} */ (err).status === 1) return new Set();
    throw err;
  }
  return new Set(out.split("\0").filter(Boolean));
}

/** Strip a trailing line-anchor suffix (`:123`, `:12-34`, `:~653`, `:1,2`). */
export function stripLineSuffix(token) {
  return token.replace(/:[~\d][\d,~–-]*$/, "");
}

/** Does this token carry a line-anchor suffix at all? */
export function hasLineSuffix(token) {
  return stripLineSuffix(token) !== token;
}

/** Source extensions — a line anchor into one of these is refused, and these files feed the symbol universe. */
export const CODE_EXTENSIONS = new Set(["ts", "tsx", "mjs", "cjs", "js", "jsx"]);

/** Glob/template tokens (`*`, `{`, `<`, `>`, `…`) are patterns, never citations. */
export const PATTERN_CHARS = /[*{<>…]/;
export const HAS_EXTENSION = /\.([A-Za-z0-9]+)$/;

/** Tokens that name something outside this repository — never citations. */
export function isNonRepoToken(token) {
  return (
    token.startsWith("~") ||
    token.startsWith("/") ||
    /^[A-Za-z]:([\\/]|$)/.test(token) ||
    token.includes("://") ||
    token.includes("\\") ||
    token.split("/").some((segment) => segment === "." || segment === "..")
  );
}

// The runtime STATE dirs (`.audit-tools` path-module contract). Prose cites
// paths under them constantly as the run-artifact LAYOUT
// (`.audit-tools/audit/steps/…`) — those name files a run writes, never repo
// files, even though the dir itself carries two tracked report artifacts. Layout
// citations are out of scope by contract, not by hand-listing.
export const RUNTIME_STATE_PREFIXES = [".audit-tools/", ".audit-tools-visibility/"];

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
 * for every SYMBOL rule. Deliberately WIDER than "declared": a symbol cited from
 * prose is one the code OWNS, and the spellings that legitimately count are a
 * binding, a type body's field, a member access, a quoted string (an env-var
 * name is a value, not an identifier — `AUDIT_TOOLS_CALLER_CWD` is the case that
 * proved it), and a module's own basename (`nextStepHelpers` is how prose cites
 * a file). DECLARED, not EXPORTED: a comment naturally names the private helper
 * in the module it sits beside. Anything narrower reds real citations; anything
 * wider — a template literal's contents, a bare `index` — swallows drift.
 *
 * Reads the same file set the FILE-RESOLUTION rule reads, so a symbol in a
 * source file the tree does not carry cannot green a citation.
 */
export function declaredIdentifierUniverse(root, paths) {
  const names = new Set();
  const SOURCE = /\.(ts|tsx|mjs|cjs|js|jsx)$/;
  const DECLARATION =
    /\b(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const FIELD = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/gm;
  const MEMBER = /\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const QUOTED = /["']([A-Za-z_$][A-Za-z0-9_$]*)["']/g;
  // A METHOD or line-leading CALL (`onFinished(files) {`, `afterEach(() => …)`):
  // a class/object method is a declaration the binding regex cannot see, and a
  // library API the tree calls is a name it really uses.
  const METHOD =
    /^\s*(?:(?:async|static|get|set|public|private|protected|override)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm;
  // NAMED IMPORTS/RE-EXPORTS (`import { afterEach } from "vitest"`): a library
  // symbol the tree imports is one a comment may name.
  const NAMED_LIST = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}/g;
  for (const path of paths) {
    if (!SOURCE.test(path)) continue;
    let source;
    try {
      source = readFileSync(join(root, path), "utf8");
    } catch {
      continue; // a tracked file absent from this worktree contributes nothing
    }
    for (const re of [DECLARATION, FIELD, MEMBER, QUOTED, METHOD]) {
      for (const match of source.matchAll(re)) names.add(match[1]);
    }
    for (const match of source.matchAll(NAMED_LIST)) {
      for (const entry of match[1].split(",")) {
        const name = /^\s*(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)/.exec(entry);
        if (name) names.add(name[1]);
      }
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
 * were reported as dangling symbols when they are call-shaped example prose. A
 * single capitalised word is neither shape: `NaN`/`RangeError` name JS
 * built-ins, `ENOENT` an errno code, `COM1` a device — prose about a host API,
 * none a symbol this tree declares. Excluding them by shape needs no list.
 */
export function isSymbolShaped(token) {
  // The camel arm also needs a LOWERCASE letter: without one, `$NAME` (a shell
  // variable) and `_FIXED_` (markdown emphasis) read the `$`/`_` as the
  // lowercase lead and the capitals as the hump.
  return (
    /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(token) ||
    (/^[a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*$/.test(token) && /[a-z]/.test(token))
  );
}

/**
 * The index every PATH rule resolves against, built once per gate run.
 * `universe` resolves targets; `examined` decides the bare-name extension census.
 */
export function buildPathIndex({ examined, universe }) {
  const trackedSet = new Set(universe);
  const dirSet = trackedDirs(universe);
  const topDirs = new Set(
    universe.filter((p) => p.includes("/")).map((p) => p.split("/", 1)[0]),
  );
  const byBasename = new Map();
  for (const path of universe) {
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
  for (const path of examined) {
    const ext = HAS_EXTENSION.exec(path);
    if (ext) trackedExtensions.add(ext[1].toLowerCase());
  }
  return { trackedSet, dirSet, topDirs, byBasename, trackedExtensions };
}

/**
 * Classify one backticked token as a PATH citation, or return null when it is
 * not one this engine checks. THREE classes:
 *
 *   • PATH — contains a `/`, first segment is a top-level dir that actually
 *     holds tracked files, last segment carries an extension. Must name a
 *     tracked file.
 *   • DIRECTORY — ends with `/`. Must name a tracked directory, resolved
 *     root-relative first and then relative to the citing file. Never resolved
 *     anywhere-in-tree: a stale `prompts/` must not stay green just because
 *     `.github/prompts/` exists somewhere.
 *   • BARE FILENAME — no `/`, carries an extension, resolved against tracked
 *     basenames.
 *
 * Out of scope by rule, not by hand-list: whitespace-bearing and pattern tokens,
 * non-repo tokens, the runtime state layout, bare names with a leading `.` or
 * `-` (the extension-mention idiom: `.ts`, `-outcomes.json`), bare names whose
 * extension no tracked file uses (`vi.spyOn`, `claude.exe`, `v0.39.4`), and bare
 * names in `skipBareNames` (the generated run-artifact set). A trailing line
 * suffix is stripped first.
 */
export function classifyPathToken(token, citingPath, index, { skipBareNames = new Set() } = {}) {
  if (/\s/.test(token) || PATTERN_CHARS.test(token)) return null;
  const path = stripLineSuffix(token).replace(/^\.\//, "");
  if (RUNTIME_STATE_PREFIXES.some((p) => path.startsWith(p))) return null;
  if (isNonRepoToken(path)) return null;
  if (path.endsWith("/")) {
    const dir = path.replace(/\/+$/, "");
    if (!dir) return null;
    return {
      kind: "dir",
      path,
      candidates: [dir, posix.normalize(posix.join(posix.dirname(citingPath), dir))],
    };
  }
  if (path.includes("/")) {
    if (!index.topDirs.has(path.split("/", 1)[0])) return null;
    if (!HAS_EXTENSION.test(path)) return null;
    return { kind: "path", path };
  }
  if (path.startsWith(".") || path.startsWith("-")) return null;
  const ext = HAS_EXTENSION.exec(path);
  if (!ext) return null;
  if (!index.trackedExtensions.has(ext[1].toLowerCase())) return null;
  if (skipBareNames.has(path)) return null;
  return { kind: "bare", path };
}

/** The candidates one batched check-ignore call needs for a set of classified records. */
export function ignoreCandidates(records) {
  // Dir candidates are fed slash-terminated: a dir-only ignore pattern (`dist/`)
  // only matches a NONEXISTENT path when the queried path also ends in `/` — and
  // the path must not exist on the machine for the answer to be fresh-clone
  // stable (dist/ exists after a local build, not in CI).
  return records.flatMap((r) =>
    r.kind === "dir" ? r.candidates.map((c) => `${c}/`) : r.kind === "path" ? [r.path] : [],
  );
}

/**
 * Resolve one classified record. Returns `null` when it is out of scope
 * (gitignored), `{ ok: true }` when it resolves, or `{ ok: false, verdict }`.
 *
 * A bare basename tracked in more than one place is ambiguous — the citing
 * text must give the full path — with ONE tie-break: exactly one candidate at
 * the repo root wins (a root file has no longer form to disambiguate with).
 */
export function resolvePathRecord(record, index, ignored) {
  if (record.kind === "path") {
    if (ignored.has(record.path)) return null;
    if (index.trackedSet.has(record.path)) return { ok: true };
    return { ok: false, verdict: "does not name a tracked file" };
  }
  if (record.kind === "dir") {
    if (record.candidates.some((c) => index.dirSet.has(c))) return { ok: true };
    if (record.candidates.some((c) => ignored.has(`${c}/`))) return null;
    return {
      ok: false,
      verdict: "missing directory — no tracked dir at the root-relative or citing-file-relative path",
    };
  }
  const candidates = index.byBasename.get(record.path) ?? [];
  if (candidates.length === 1) return { ok: true };
  if (candidates.length === 0) return { ok: false, verdict: "matches no tracked file" };
  if (candidates.filter((c) => !c.includes("/")).length === 1) return { ok: true };
  return {
    ok: false,
    verdict: `ambiguous (${candidates.length} candidates: ${[...candidates].sort().join(", ")}) — cite the full path`,
  };
}
