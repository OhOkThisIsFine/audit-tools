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

  return { kind: "missing", target, detail: "no such file or directory" };
}

export function findDeadLinks(files = trackedMarkdown()) {
  const findings = [];
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
