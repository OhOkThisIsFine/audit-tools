#!/usr/bin/env node
/**
 * check-memory-citations.mjs — every `memory: <name>` citation in a tracked doc
 * must resolve to a real memory file.
 *
 * WHY THIS EXISTS. `docs/project-philosophy.md` cited a memory note
 * (`parallel-dispatch-overlapping-files-is-goal`) that had been DELETED as
 * falsified, and in doing so restored the refuted design as the map's stated
 * target. A dangling citation is not a broken link — it is how a superseded
 * design gets re-asserted with the authority of a pointer nobody can follow.
 * Catching it needs no judgment, so per "whatever CAN be enforced in tooling
 * must be" it is enforced here rather than remembered.
 *
 * SCOPE, and why this check is LOCAL-ONLY. The memory store lives outside the
 * repo (the host's per-project memory dir), so a fresh CI clone has no store to
 * check against. Rather than assert against a path CI cannot see — which would
 * make this a false RED on every CI run — the check SKIPS when the store is
 * absent and enforces when it is present. That is the machine where citations
 * are actually authored, so the guard fires where it can act.
 *
 * Resolution order for the store: $AUDIT_TOOLS_MEMORY_DIR, else the host's
 * default per-project path derived from the REPOSITORY, never from cwd. Both
 * rules — and the slug spelling — live in scripts/shared/hostMemoryDir.mjs, the
 * ONE derivation every consumer reads (this gate and the closeout-readiness
 * chain used to spell it differently, agreeing on this repo's punctuation and
 * diverging on any other; see that module).
 *
 * AND AN UNFOUND STORE NEVER TICKS. The skip announced itself with a ✓, which
 * reads as a pass in a scrolled log — that is how the inert years survived. A
 * store that cannot be found is a ⚠ that says NOT CHECKED. It stays exit 0
 * because a fresh CI clone genuinely has no store, and asserting against a path
 * CI cannot see would be a false RED on every CI run.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { isGeneratedRender } from "./shared/generated-renders.mjs";
import { hostMemoryDir } from "./shared/hostMemoryDir.mjs";

// The store path is derived in ONE place (scripts/shared/hostMemoryDir.mjs): the
// repository-identity rule, the host's slug rule, and the $AUDIT_TOOLS_MEMORY_DIR
// override all live there, so this gate and the closeout chain cannot disagree
// about which directory to read.
const memoryDir = hostMemoryDir();

if (!existsSync(memoryDir)) {
  console.log(
    `⚠ memory-citations: NOT CHECKED — no memory store at ${memoryDir} ` +
      `(expected off the authoring machine; set AUDIT_TOOLS_MEMORY_DIR to enforce)`,
  );
  process.exit(0);
}

const known = new Set(
  readdirSync(memoryDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3)),
);

const tracked = execFileSync("git", ["ls-files", "*.md"], {
  encoding: "utf8",
  windowsHide: true,
})
  .split(/\r?\n/)
  .filter(Boolean)
  // worker-authored render prose may quote citation-shaped text — see the module
  .filter((file) => !isGeneratedRender(file));

// `memory: a, b, c` — runs to the end of the parenthetical or the line group.
// Names are kebab-case slugs; prose after an em-dash is an annotation, not a name.
//
// CASE-INSENSITIVE, because the bare sentence-initial `Memory: a, b, c` list form
// is the same citation and was structurally invisible to this gate: a dangling
// `Memory:` name sat unread in `docs/project-philosophy.md` while the check ran
// green, which is the inert-guard shape this module already exists to prevent.
const CITATION = /memory:\s*([^)*]+)/gi;

const dangling = [];
let scanned = 0;
for (const file of tracked) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // The tracked census comes from the index. A document intentionally deleted
    // in the working tree has no citation bytes to validate; skip only ENOENT.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
    throw error;
  }
  scanned += 1;
  const lines = text.split(/\r?\n/);
  // Code spans are stripped for THIS form too, not just the wikilink form below.
  // Inline code and fences quote the SYNTAX — a doc explaining that a citation
  // looks like `memory: a, b, c` is documenting the form, not naming notes `a`
  // and `b`. The two forms disagreeing on this was a live false positive the
  // moment a doc first described the syntax.
  for (const match of stripCodeSpans(text).matchAll(CITATION)) {
    const names = match[1]
      .split(",")
      .map((raw) => raw.split("—")[0].trim())
      .filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n));
    for (const name of names) {
      if (known.has(name)) continue;
      const line = lines.findIndex((l) => l.includes(name)) + 1;
      dangling.push({ file, line, name });
    }
  }
}

// The OTHER citation form. Memories cite each other as `[[name]]`, and a dangling
// one fails exactly the way a dangling `memory:` citation does — a pointer nobody can
// follow re-asserting whatever the deleted note said. It was structurally invisible
// to this gate, which is what made every prune of the store a hand-audit.
const WIKILINK = /\[\[([^\][|]+)\]\]/g;

/** Inline code and fenced blocks quote the SYNTAX; they document the form, not a target. */
function stripCodeSpans(text) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

for (const note of readdirSync(memoryDir).filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(join(memoryDir, note), "utf8");
  const lines = text.split(/\r?\n/);
  for (const match of stripCodeSpans(text).matchAll(WIKILINK)) {
    // A stray `.md` suffix is a misspelling of a real target, not a second kind
    // of link — resolve the note first, then judge whether that note exists.
    const name = match[1].trim().replace(/\.md$/, "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue;
    if (known.has(name)) continue;
    const line = lines.findIndex((l) => l.includes(match[1])) + 1;
    dangling.push({ file: join(memoryDir, note), line, name, form: "[[…]]" });
  }
}

// THE THIRD DIRECTION: a memory note citing a repo PATH.
//
// The store lives OUTSIDE the tree, so no doc gate reaches it and this script
// read notes only for wikilinks — the direction was scanned by nothing. A note
// whose point is that a subsystem was DELETED legitimately cites paths that no
// longer resolve, and that archaeology is the majority of what a scan finds; so
// the rule is an explicit exemption marker (the same idiom the doc gates use),
// NEVER a bare existence check, and never inferred from words like "deleted".
//
// Confidence is total for a SLASHED path (a `src/foo/bar.ts` token names one
// file and nothing else). Globs, `<placeholders>`, `*`, line suffixes and
// non-repo tokens are out of scope by rule — a pattern is not a citation, and a
// `docs/backlog/` directory citation is resolved against the tracked dir set.
// The marker exempts every path citation on its line, or on the line above.
const MEMORY_PATH_EXEMPT = /<!--\s*memory-path-exempt:.*?-->/;

function stripLineSuffix(token) {
  return token.replace(/:[~\d][\d,~–-]*$/, "");
}

// The repo the notes' paths resolve against is the one the gate is run FROM —
// exactly the repo the doc census above reads (`git ls-files "*.md"` with no
// `cwd`). Resolving from `import.meta.url` instead would make the gate read this
// repo while a caller pointed at another, and would make the fixture-repo tests
// resolve against the wrong tree entirely.
function repoFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8", windowsHide: true })
    .split(/\r?\n/)
    .filter(Boolean);
}

/** Top-level dirs that actually hold code — a token under anything else is prose. */
const repoTopDirs = new Set(
  repoFiles().flatMap((p) => (p.includes("/") ? [p.split("/", 1)[0]] : [])),
);
const trackedSet = new Set(repoFiles());

/**
 * Gitignored paths are out of scope by rule, the same way the doc gate scopes
 * them: a note naming `.claude/lap-start.json` or an untracked run artifact
 * names a file the run really does write, and there is no tracked file for it to
 * resolve against. One batched `git check-ignore --stdin`, rules-based, so a
 * fresh clone classifies identically.
 */
function ignoredPaths(candidates) {
  const unique = [...new Set(candidates)].filter(Boolean);
  if (unique.length === 0) return new Set();
  let out = "";
  try {
    out = execFileSync("git", ["check-ignore", "--stdin", "-z"], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      input: unique.join("\0") + "\0",
    });
  } catch (err) {
    // `git check-ignore` exits 1 when nothing matched — not an error. The cast
    // mirrors the sibling doc gate, where `checkJs` narrows a caught value to
    // `{}` and the status is not reachable without it.
    if (err && /** @type {any} */ (err).status === 1) return new Set();
    throw err;
  }
  return new Set(out.split("\0").filter(Boolean));
}
const trackedDirSet = new Set();
for (const p of trackedSet) {
  const parts = p.split("/");
  for (let i = 1; i < parts.length; i += 1) trackedDirSet.add(parts.slice(0, i).join("/"));
}

/** A token that could name a repo path — never a glob, template, or non-repo form. */
function pathCandidate(token) {
  const path = stripLineSuffix(token).replace(/^\.\//, "");
  if (!path.includes("/")) return null;
  if (/[*?{<>…]/.test(path)) return null;
  if (path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path) || path.includes("://")) return null;
  if (path.includes("\\")) return null;
  if (path.split("/").some((s) => s === "." || s === ".." || s === "" )) return null;
  if (RUNTIME_STATE_PREFIXES.some((p) => path.startsWith(p))) return null;
  if (!repoTopDirs.has(path.split("/", 1)[0])) return null;
  return path;
}

const RUNTIME_STATE_PREFIXES = [".audit-tools/", ".audit-tools-visibility/"];

// Pass 1 — collect every path candidate, so the gitignore scoping runs as ONE
// batched git call over the whole store instead of a spawn per token.
const candidates = [];
for (const note of readdirSync(memoryDir).filter((f) => f.endsWith(".md"))) {
  const file = join(memoryDir, note);
  const noteLines = readFileSync(file, "utf8").split(/\r?\n/);
  noteLines.forEach((line, i) => {
    if (MEMORY_PATH_EXEMPT.test(line) || (i > 0 && MEMORY_PATH_EXEMPT.test(noteLines[i - 1]))) return;
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const path = pathCandidate(match[1]);
      if (path) candidates.push({ note, line: i + 1, path });
    }
  });
}

// Pass 2 — resolve. A gitignored candidate is out of scope, not checked.
const ignored = ignoredPaths(candidates.map((c) => c.path));
const danglingPaths = [];
for (const { note, line, path } of candidates) {
  if (ignored.has(path)) continue;
  const bare = path.replace(/\/+$/, "");
  // A trailing slash is unambiguous: that is a directory citation. Anything
  // else resolves as a FILE first and falls back to the tracked dir set, which
  // is what makes BOTH `.githooks/pre-commit` (a tracked extension-less FILE)
  // and `docs/backlog` (an extension-less DIRECTORY citation) resolve. Guessing
  // "no extension means directory" would red the first class.
  const resolves =
    trackedSet.has(bare) || (path.endsWith("/") && trackedDirSet.has(bare)) ||
    (!path.endsWith("/") && !/\.[A-Za-z0-9]+$/.test(bare) && trackedDirSet.has(bare));
  if (!resolves) danglingPaths.push({ note, line, path });
}

if (danglingPaths.length > 0) {
  console.error(
    `✗ memory-citations: ${danglingPaths.length} repo path(s) cited by a memory note do not resolve\n`,
  );
  for (const { note, line, path } of danglingPaths) {
    console.error(`  ${note}:${line} → ${path}`);
  }
  console.error(
    `\n  A note citing a path that is gone re-asserts a retired layout with the\n` +
      `  authority of a citation nobody can follow. Repoint it at what exists now,\n` +
      `  or — for a note whose POINT is that a subsystem was deleted — put\n` +
      `  \`<!-- memory-path-exempt: <what that path was> -->\` on the line above it.`,
  );
  process.exit(1);
}

if (dangling.length > 0) {
  console.error(`✗ memory-citations: ${dangling.length} citation(s) resolve to no memory file\n`);
  for (const { file, line, name, form } of dangling) {
    console.error(`  ${file}:${line || "?"} → ${form ?? "memory:"} ${name}`);
  }
  console.error(
    `\n  A citation to a deleted note re-asserts whatever that note said, with the\n` +
      `  authority of a pointer nobody can follow. Repoint it at the note that\n` +
      `  superseded it, or drop the citation.`,
  );
  process.exit(1);
}

console.log(`✓ memory-citations: all citations across ${scanned} present tracked docs resolve`);
