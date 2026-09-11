#!/usr/bin/env node
// Retirement register gate: no tracked doc may name RETIRED infrastructure
// without saying so.
//
// The register is `scripts/shared/retired-infrastructure-data.mjs` (read there
// for why it exists). This gate is the half that runs: it scans every tracked
// markdown file for each row's literal identifiers and refuses any line that
// carries one, unless the line (or the line above) states the retirement with a
// `<!-- retired-infrastructure-exempt: <id> — <reason> -->` marker.
//
// SCOPE — DECLARED, and deliberately narrow. `SCANNED_DOCS` is the whole set.
//
// The property being enforced is about ONE file. `durable-traps.md` is a
// standing REFERENCE read precisely when a session is unsure what to run, so a
// stale entry there costs a wrong ACTION; that is the entry this gate closes,
// and it names that file. Widening the scan is a one-line edit above, and the
// reason it is not wider TODAY is coordination rather than principle: the
// backlog entry recording this defect necessarily quotes the identifiers it is
// about, and the generated seek index lifts that title verbatim — so a
// repo-wide scan would redden two files that other packets own (the entry
// itself is deleted by the backlog-reconciliation pass, the index is
// regenerated from it) while proving nothing about a live instruction.
//
// The universe within that set is the doc-manifest's `excluded` row, IMPORTED
// and never restated here, through the same helpers `check-doc-code-citations`
// uses. Those are RECORDS — a dated review, a nightly proposal, a runtime
// artifact — and each cites services that were live the day it was written, so
// reddening them would make the record unmaintainable while proving nothing.
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

export const EXEMPT_MARKER = /<!--\s*retired-infrastructure-exempt:\s*([^\s—>-]+)[^>]*-->/;

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

/**
 * The docs this gate reads. See the SCOPE note at the top of the file for why
 * the set is this narrow and what widening it would cost.
 */
export const SCANNED_DOCS = ["docs/backlog/durable-traps.md"];

/**
 * The scanned docs that are actually present. Resolved against `git ls-files`
 * UNION the untracked-but-not-ignored set — the shape `check-doc-code-citations`
 * uses — so the gate is fresh-clone stable and a doc being ADDED in this change
 * is scanned like any other. A declared doc that exists in NEITHER set is
 * reported as missing rather than skipped: a renamed or deleted target would
 * otherwise leave the gate green over nothing, which is the failure mode a
 * hardcoded list is most prone to.
 */
function scannedDocs() {
  const deleted = new Set(git(["ls-files", "-z", "--deleted"]).split("\0").filter(Boolean));
  const present = new Set(
    git(["ls-files", "-z"])
      .split("\0")
      .filter((p) => p && !deleted.has(p)),
  );
  for (const p of git(["ls-files", "-z", "--others", "--exclude-standard"]).split("\0")) {
    if (p) present.add(p);
  }
  const excluded = excludedMatchers();
  const found = [];
  const missing = [];
  for (const doc of SCANNED_DOCS) {
    if (!present.has(doc)) missing.push(doc);
    else if (excluded.some((re) => re.test(doc))) missing.push(`${doc} (excluded by the doc manifest)`);
    else found.push(doc);
  }
  return { found, missing };
}

function main() {
  const failures = [];
  const { found, missing } = scannedDocs();
  if (missing.length > 0) {
    console.error(
      `check-retired-infrastructure: declared scan target(s) not found in the tree:\n` +
        missing.map((m) => `  ${m}`).join("\n") +
        `\nSCANNED_DOCS in scripts/check-retired-infrastructure.mjs names a doc this gate must ` +
        `read; update it in the same change that moves the doc, or the gate goes green over nothing.`,
    );
    process.exit(1);
  }
  for (const relPath of found) {
    let text;
    try {
      text = readFileSync(join(root, relPath), "utf8");
    } catch {
      continue; // a vanished tracked path is another gate's business
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
    `check-retired-infrastructure: ${found.length} doc(s) scanned [${found.join(", ")}] against ` +
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
