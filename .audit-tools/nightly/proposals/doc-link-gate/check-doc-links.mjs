#!/usr/bin/env node
/**
 * check-doc-links.mjs — every relative markdown link in a tracked doc must
 * resolve to a file that exists.
 *
 * WHY THIS EXISTS. `check-memory-citations.mjs` guards `memory: <name>`
 * citations and says so explicitly: "A dangling citation is not a broken link."
 * Nothing guarded the broken links. The 2026-07-25 doc-review pass rebased 27
 * of them by hand across the `docs/backlog/` files (they pointed at
 * `docs/backlog/reviews/` and `docs/spec/`, neither of which exists) plus six
 * link depths in the `.claude/skills/` SKILL bodies. The 2026-07-26 pass MOVED
 * three docs into `spec/` and rebased every inbound link to them while leaving
 * their own OUTBOUND links pointing at the old parent — so the same lap that
 * fixed 27 broken links created three more.
 *
 * That is the tell: a hand-audited property regresses the moment a doc moves.
 * Per CLAUDE.md's "whatever CAN be enforced in tooling must be", link
 * resolution needs no judgment, so it is enforced here rather than re-derived
 * by whoever next reads the file.
 *
 * SCOPE. Tracked `*.md` files, via `git ls-files`. Absolute URLs
 * (http/https/mailto), bare anchors (`#section`), and `~`-rooted host paths are
 * out of scope: none of them is checkable from the repo alone.
 *
 * THE `:<line>` SUFFIX is this repo's citation idiom
 * (`[foo.ts](../../src/foo.ts:247)`) and is stripped before the existence test,
 * as is any `#anchor`. Anchor TARGETS are deliberately not validated — heading
 * slugs are a judgment call about rendering, and a wrong-but-resolving anchor
 * is not the failure mode that keeps recurring.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const LINK_RE = /\[(?:[^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const SKIP_RE = /^(?:https?:|mailto:|#|~|<)/;

/** Strip a trailing `#anchor` and/or `:<line>` citation suffix. */
export function normalizeTarget(raw) {
  let target = raw.split("#")[0];
  target = target.replace(/:\d+(?:-\d+)?$/, "");
  return target;
}

export function findBrokenLinks(root, files, readFile = (p) => readFileSync(p, "utf8")) {
  const broken = [];
  for (const file of files) {
    const abs = join(root, file);
    let text;
    try {
      text = readFile(abs);
    } catch {
      continue;
    }
    const dir = dirname(abs);
    for (const match of text.matchAll(LINK_RE)) {
      const raw = match[1];
      if (SKIP_RE.test(raw)) continue;
      const target = normalizeTarget(raw);
      if (!target) continue;
      const resolved = resolve(dir, target);
      if (existsSync(resolved)) continue;
      broken.push({
        file,
        target: raw,
        resolvesTo: relative(root, resolved).split("\\").join("/"),
      });
    }
  }
  return broken;
}

function trackedMarkdown(root) {
  return execSync('git ls-files "*.md"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function main() {
  const root = process.cwd();
  const files = trackedMarkdown(root);
  const broken = findBrokenLinks(root, files);
  if (broken.length === 0) {
    console.log(`check:doc-links — OK (${files.length} tracked docs)`);
    return;
  }
  console.error(
    `check:doc-links — ${broken.length} broken relative link(s) in ${files.length} tracked docs:\n`,
  );
  for (const b of broken) {
    console.error(`  ${b.file}`);
    console.error(`    link:       ${b.target}`);
    console.error(`    resolves to ${b.resolvesTo}  (does not exist)\n`);
  }
  console.error(
    "A relative link that does not resolve is a dead pointer, and a doc MOVE is\n" +
      "what usually creates one: rebase the moved doc's OWN outbound links, not\n" +
      "just the inbound links to it.",
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-doc-links.mjs")) {
  main();
}
