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
 * default per-project path derived from the REPOSITORY, never from cwd.
 *
 * WHY REPOSITORY IDENTITY, NOT cwd. One store serves a repository, but a
 * cwd-derived slug names a different one in every linked worktree — and every lap
 * runs in a worktree. The gate then found no store, skipped, and exited 0, so the
 * one check that stops a dangling `[[memory]]` citation was green-by-absence for
 * exactly the sessions that edit memories (2026-08-29). The common git dir is
 * shared by every worktree of a repository, which is the identity the store
 * already keys on, so a worktree reaches its main checkout's store.
 *
 * AND AN UNFOUND STORE NEVER TICKS. The skip announced itself with a ✓, which
 * reads as a pass in a scrolled log — that is how the inert years survived. A
 * store that cannot be found is a ⚠ that says NOT CHECKED. It stays exit 0
 * because a fresh CI clone genuinely has no store, and asserting against a path
 * CI cannot see would be a false RED on every CI run.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { isGeneratedRender } from "./shared/generated-renders.mjs";

/**
 * The main checkout's root — the identity every worktree of this repository
 * shares. Falls back to cwd when git cannot answer, which is "cannot tell", and
 * a store then simply goes unfound rather than being asserted against wrongly.
 */
function repositoryRoot() {
  try {
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    // `<main>/.git` in an ordinary checkout and in every linked worktree alike.
    return basename(commonDir) === ".git" ? dirname(commonDir) : process.cwd();
  } catch {
    return process.cwd();
  }
}

/** The host derives its per-project dir by replacing every non-alphanumeric char. */
function defaultMemoryDir() {
  const slug = resolve(repositoryRoot()).replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", slug, "memory");
}

const memoryDir = process.env["AUDIT_TOOLS_MEMORY_DIR"] ?? defaultMemoryDir();

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
