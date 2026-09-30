#!/usr/bin/env node
// sites-pinned: tests/shared/retired-infrastructure.test.ts
// Retirement register gate: no tracked doc may name RETIRED infrastructure
// without saying so.
//
// The register is `scripts/shared/retired-infrastructure-data.mjs` (read there
// for why it exists). This gate is the half that runs: it scans every tracked
// markdown file for each row's literal identifiers and refuses any line that
// carries one, unless the line (or the line above) states the retirement with a
// `<!-- retired-infrastructure-exempt: <id> — <reason> -->` marker.
//
// Scope is every tracked Markdown file, including staged additions, except the
// canonical doc-manifest excluded records. Historical records describe services
// as they were at the time; their exclusion is shared with citation checks.
// Untracked scratch and deleted paths are outside the shipping document tree.
//
// The register itself is `.mjs` and so is outside its own scan by construction,
// and a retirement recorded in code is the code's business, not a doc's.
//
// THE REFUSAL NAMES THE MOVE, not the mistake. There are exactly two legal
// answers and the message states both: delete the entry (the trap is retired
// with the thing it names), or keep it deliberately and say what replaced the
// retired infrastructure — which is what makes the entry a RECORD instead of a
// live instruction.
//
// Exit 0 clean, 1 on any unexempted mention. The recognizer is exported so
// `tests/shared/retired-infrastructure.test.ts` can drive the REAL matcher over
// declared samples rather than a copy of it (P51).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { DOC_MANIFEST } from "./doc-manifest-data.mjs";
import { globToRegExp, isGlob } from "./check-doc-manifest.mjs";
import { guardArgv } from "./shared/argvGuard.mjs";
import { RETIRED_INFRASTRUCTURE } from "./shared/retired-infrastructure-data.mjs";

const root = process.cwd();

// The id class excludes whitespace, the em-dash and `>` — never `-`: an id
// like `llm-relay` must be captured whole. The marker's own grammar always
// puts whitespace before the em-dash (`id — reason`), so dropping `-` from
// the exclusion set does not let the id swallow the reason that follows it.
export const EXEMPT_MARKER = /<!--\s*retired-infrastructure-exempt:\s*([^\s—>]+)[^>]*-->/;

/**
 * Every mention of retired infrastructure on one line.
 *
 * The exemption is keyed by ROW ID, so a doc that legitimately records two
 * retirements needs two markers — a blanket exemption would let one marker
 * silently cover a different retired thing that landed in the same line later.
 * A marker whose id matches no row in the register is reported as UNKNOWN
 * rather than ignored: a typo would otherwise read as an exemption.
 *
 * @param {string} line
 * @param {string} [lineAbove]
 * @returns {{id: string, label: string, replacedBy: string, pointer: string}[]}
 */
export function findRetiredMentions(line, lineAbove = "") {
  const exemptIds = new Set();
  const unknownIds = [];
  const knownIds = new Set(RETIRED_INFRASTRUCTURE.map((r) => r.id));
  for (const text of [lineAbove, line]) {
    for (const match of text.matchAll(new RegExp(EXEMPT_MARKER, "g"))) {
      const id = match[1];
      if (knownIds.has(id)) exemptIds.add(id);
      else unknownIds.push(id);
    }
  }

  const found = [];
  for (const entry of RETIRED_INFRASTRUCTURE) {
    if (exemptIds.has(entry.id)) continue;
    for (const { name, pattern } of entry.patterns) {
      const match = new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(line);
      if (match === null) continue;
      found.push({
        id: entry.id,
        label: entry.label,
        replacedBy: entry.replacedBy,
        retired: entry.retired,
        pointer: `${name} — \`${match[0]}\``,
      });
      break; // one report per row per line; the first identifier is enough
    }
  }
  for (const id of unknownIds) {
    found.push({
      id,
      label: `an UNKNOWN register id \`${id}\``,
      replacedBy: "the ids declared in scripts/shared/retired-infrastructure-data.mjs",
      retired: "",
      pointer: "exemption marker names no row in the register",
    });
  }
  return found;
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
}

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

/** Every present tracked Markdown document outside canonical excluded records. */
export function scannedDocs() {
  const deleted = new Set(git(["ls-files", "-z", "--deleted"]).split("\0").filter(Boolean));
  const excluded = excludedMatchers();
  return [...new Set(git(["ls-files", "-z"]).split("\0"))]
    .filter((doc) => doc.endsWith(".md") && !deleted.has(doc) &&
      !excluded.some((pattern) => pattern.test(doc)))
    .sort();
}

function main() {
  const failures = [];
  const found = scannedDocs();
  for (const relPath of found) {
    let text;
    try {
      text = readFileSync(join(root, relPath), "utf8");
    } catch (error) {
      console.error(`check-retired-infrastructure: cannot read ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const mention of findRetiredMentions(line, i > 0 ? lines[i - 1] : "")) {
        failures.push({ relPath, line: i + 1, mention, text: line.trim() });
      }
    });
  }

  if (failures.length > 0) {
    console.error(
      `check-retired-infrastructure: ${failures.length} mention(s) of retired infrastructure ` +
        `without a retirement statement:`,
    );
    for (const f of failures) {
      const when = f.mention.retired ? ` (retired ${f.mention.retired})` : "";
      console.error(`  ${f.relPath}:${f.line}  ${f.mention.label}${when} — ${f.mention.pointer}`);
      console.error(`      ${f.text}`);
    }
    console.error(
      "\nTwo legal answers, and the message above is the whole choice:\n" +
        "  • DELETE the entry. A trap that existed only because the retired thing existed retires\n" +
        "    with it — two copies decay independently, and the reader is who pays for the stale one.\n" +
        "  • KEEP it deliberately, as a RECORD, and say what replaced the retired infrastructure.\n" +
        "    Mark the line (or the line above) with\n" +
        "      <!-- retired-infrastructure-exempt: <id> — <what replaced it> -->\n" +
        "The replacement is the point, not the paperwork: an entry that names dead infrastructure and\n" +
        "no successor still sends the reader to a wrong action.\n" +
        `Register: scripts/shared/retired-infrastructure-data.mjs — adding a row there is how a ` +
        `retirement is declared.`,
    );
    process.exit(1);
  }

  const ids = RETIRED_INFRASTRUCTURE.map((r) => r.id).join(", ");
  console.log(
    `check-retired-infrastructure: ${found.length} tracked doc(s) scanned against ` +
      `${RETIRED_INFRASTRUCTURE.length} retired-infrastructure row(s) [${ids}] — no mention ` +
      `without a retirement statement`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // The gate takes no arguments: it reads the tree at the working directory.
  guardArgv(process.argv.slice(2), {
    name: "check-retired-infrastructure",
    usage: "node scripts/check-retired-infrastructure.mjs",
  });
  main();
}
