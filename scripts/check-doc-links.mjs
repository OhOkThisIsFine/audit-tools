#!/usr/bin/env node
// Relative-link resolution gate for tracked markdown.
//
// A dead relative link is the one doc defect that is fully mechanical: the target
// either resolves on disk or it does not, with no judgment involved. It had
// recurred on three separate dates before this gate existed, and three of the
// links in the last occurrence were created by that same run's own doc moves —
// a mover fixes the file it moved and cannot see the inbound links elsewhere.
//
// Enumerates GIT-TRACKED files, exactly like check-doc-manifest.mjs: an untracked
// scratch file is not a project doc, and a fresh CI clone must see the same set a
// local run does.
//
// That "local must equal CI" rule binds the link TARGETS too, and it did not at
// first: `existsSync` answers about the machine running the gate, so a link into
// a GITIGNORED path (`.audit-code/install/…`, written by the installer) resolved
// on a developer box that had run the install and 404'd in CI's bare clone —
// green locally, red on main, which is the exact failure this gate exists to stop.
// An ignored target is a build/install artifact by construction: it can never be
// in a clone, so flagging it is guaranteed noise, and skipping it cannot hide a
// real break because a real repo doc is tracked and therefore never ignored.
//
// Three defect classes, reported separately because their fixes differ:
//   missing        — the target does not exist at all (moved, renamed, deleted)
//   line-suffixed  — `path/file.ts:1946`; the FILE exists but a line suffix can
//                    never resolve as a path. Line numbers drift, so the standing
//                    citation policy is to point at a symbol instead.
//   case-mismatch  — resolves only case-insensitively. Green on Windows/macOS,
//                    dead on a case-sensitive Linux CI checkout.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative, basename } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());

/** Tracked markdown, NUL-delimited so a path with spaces survives. */
function trackedMarkdown() {
  const out = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return out.split("\0").filter(Boolean);
}


// Inline links `[text](target)` and reference definitions `[label]: target`.
// The target group deliberately stops at whitespace so a `(path "title")` form
// yields the path alone.
const INLINE_LINK = /\[[^\]]*\]\(\s*<?([^)<>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE_DEF = /^[ \t]{0,3}\[[^\]]+\]:[ \t]+<?([^\s<>]+)>?/gm;

/** Targets that are not repo-relative paths and cannot be resolved on disk. */
function isExternal(target) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(target) || // http:, https:, mailto:, ftp:, …
    target.startsWith("//") ||
    target.startsWith("#")
  );
}

/** Byte offset → 1-indexed line, so a finding is clickable. */
function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

/**
 * A sibling whose name differs only by case. Detects the class that is green on
 * a case-insensitive filesystem and dead in Linux CI.
 */
function caseInsensitiveMatch(absolute) {
  const dir = dirname(absolute);
  if (!existsSync(dir)) return null;
  const wanted = basename(absolute).toLowerCase();
  try {
    return readdirSync(dir).find((e) => e.toLowerCase() === wanted) ?? null;
  } catch {
    return null;
  }
}

function classify(sourceFile, target) {
  // Strip a fragment, but keep `#` inside an encoded path.
  const hash = target.indexOf("#");
  let pathPart = hash >= 0 ? target.slice(0, hash) : target;
  if (!pathPart) return null; // pure `#anchor`

  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    decoded = pathPart;
  }

  const fromDir = dirname(join(root, sourceFile));
  const absolute = resolve(fromDir, decoded);

  if (existsSync(absolute)) {
    const actual = caseInsensitiveMatch(absolute);
    if (actual && actual !== basename(absolute)) {
      return { kind: "case-mismatch", target, detail: `on-disk name is \`${actual}\`` };
    }
    return null;
  }

  // `path/file.ts:1946` / `:120-140` — the file resolves, the suffix does not.
  const lineSuffix = decoded.match(/^(.*?):(\d+(?:-\d+)?)$/);
  if (lineSuffix) {
    const bare = resolve(fromDir, lineSuffix[1]);
    if (existsSync(bare)) {
      return {
        kind: "line-suffixed",
        target,
        detail: `\`${relative(root, bare).replace(/\\/g, "/")}\` exists, but \`:${lineSuffix[2]}\` cannot resolve as a path — cite a symbol, not a line`,
      };
    }
  }

  const actual = caseInsensitiveMatch(absolute);
  if (actual) {
    return { kind: "case-mismatch", target, detail: `did you mean \`${actual}\`?` };
  }

  return { kind: "missing", target, detail: "no such file or directory", absolute };
}

/**
 * Repo-relative paths that git ignores, resolved in ONE batched call — a
 * per-link spawn would cost a process per finding.
 *
 * `git check-ignore` exits 1 when nothing matches, which is a normal answer
 * here, not a failure; and any other fault degrades to "nothing is ignored" so
 * a missing/odd git can never turn this gate green by accident.
 */
function gitIgnored(absolutePaths) {
  const relatives = [];
  for (const absolute of absolutePaths) {
    const rel = relative(root, absolute).replace(/\\/g, "/");
    // Outside the repo entirely — git has no opinion, and check-ignore errors.
    if (rel === "" || rel.startsWith("../")) continue;
    relatives.push(rel);
  }
  if (relatives.length === 0) return new Set();
  try {
    const out = execFileSync("git", ["check-ignore", "-z", "--stdin"], {
      cwd: root,
      input: `${relatives.join("\0")}\0`,
      encoding: "utf8",
      windowsHide: true,
    });
    return new Set(out.split("\0").filter(Boolean));
  } catch (err) {
    // Exit 1 = "none of them are ignored" and carries empty stdout; any other
    // fault also lands here and yields an empty set, i.e. the strict reading.
    const out = typeof err?.stdout === "string" ? err.stdout : "";
    return new Set(out.split("\0").filter(Boolean));
  }
}

export function findDeadLinks(files = trackedMarkdown()) {
  let findings = [];
  for (const file of files) {
    const absolute = join(root, file);
    if (!existsSync(absolute)) continue; // staged-delete race
    const source = readFileSync(absolute, "utf8");

    for (const re of [INLINE_LINK, REFERENCE_DEF]) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(source))) {
        const target = match[1];
        if (isExternal(target)) continue;
        const verdict = classify(file, target);
        if (verdict) {
          findings.push({
            file: file.replace(/\\/g, "/"),
            line: lineAt(source, match.index),
            ...verdict,
          });
        }
      }
    }
  }
  // Drop links into install/build artifacts, in one batched git call. Only the
  // `missing` class can qualify — the other classes already found a real file on
  // disk, so an ignore verdict would say nothing about them.
  const ignorable = findings.filter((f) => f.kind === "missing" && f.absolute !== undefined);
  if (ignorable.length > 0) {
    const ignored = gitIgnored(ignorable.map((f) => f.absolute));
    findings = findings.filter(
      (f) => !(f.kind === "missing" && f.absolute !== undefined && ignored.has(relative(root, f.absolute).replace(/\\/g, "/"))),
    );
  }
  for (const f of findings) delete f.absolute; // internal only — never rendered

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return findings;
}

function main() {
  const findings = findDeadLinks();
  if (findings.length === 0) {
    const count = trackedMarkdown().length;
    console.log(`✓ doc-links: every relative link in ${count} tracked markdown files resolves`);
    return;
  }

  const byKind = new Map();
  for (const f of findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  const summary = [...byKind].map(([k, n]) => `${n} ${k}`).join(", ");

  console.error(`\n✗ doc-links: ${findings.length} unresolvable relative link(s) — ${summary}\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    [${f.kind}] ${f.target}`);
    console.error(`    ${f.detail}`);
  }
  console.error(
    `\nA relative link resolves or it does not — there is no judgment here, which is why this is a gate.\n` +
      `⚠ A GENERATED doc (docs/HANDOFF.md, docs/backlog.md) copies link text from its SOURCE; a link\n` +
      `  correct in docs/backlog/*.md breaks when lifted one directory up. Fix the generator, never the\n` +
      `  generated file — the next regeneration overwrites it.\n`,
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-doc-links.mjs")) {
  main();
}
