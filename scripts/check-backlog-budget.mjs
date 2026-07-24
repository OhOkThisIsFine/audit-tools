#!/usr/bin/env node
// Per-entry size budget for the split backlog.
//
// WHY. The backlog grew past 1,700 lines in one file, so every pass navigated it
// blind — and that is how ~21% of entries silently went stale between
// classification passes. Splitting by section was half the fix; without a budget
// the largest section simply regrows, because the driver is not the entry COUNT
// but post-mortem narrative accreting onto entries after the fact.
//
// The budget is deliberately generous. Entries earn their length: the standing
// warning is that pruning aggressively is the WRONG failure mode, since stale
// entries survive precisely because nobody can hold the whole file at once. What
// this refuses is a single entry that has become a changelog — the mechanism and
// the open property belong in the entry, the story belongs in `git log` or a
// `docs/reviews/` record.
//
// UNIT: UTF-8 BYTES, deliberately — not JS string length. Two reasons, and the
// second is why this changed.
//   1. What is being budgeted is the TOKEN cost of reading the file, and bytes
//      track that far better than characters do across mixed content: an ASCII
//      run is ~4 bytes and ~4 chars per token alike, but a 3-byte glyph like ⚠
//      or → is ONE character and roughly one token, so counting characters
//      systematically under-prices exactly the decorated prose these entries are
//      full of. The project already standardizes on bytes→tokens
//      (`estimateTokensFromBytes`), so characters were also the odd unit out.
//   2. Every ambient tool — `wc -c`, `ls -l`, an editor's status bar — reports
//      bytes. While this counted characters, a maintainer comparing `wc -c`
//      against a recorded ceiling read a violation that was not there (and
//      vice versa); the two differ by ~1000 on `open-bugs.md`. A gate whose unit
//      disagrees with every tool you would reach for is a footgun, not a guard.
// Baselines recorded before the switch were CHARACTER counts and are not
// comparable; they were regenerated in the same commit as the metric change.
//
//   node scripts/check-backlog-budget.mjs            # enforce
//   node scripts/check-backlog-budget.mjs --report   # show the distribution
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const backlogDir = join(repoRoot, "docs", "backlog");

/** UTF-8 byte length — the ONE measurement function, so no caller can drift to `.length`. */
export function sizeOf(text) {
  return Buffer.byteLength(text, "utf8");
}

/** Max BYTES for one top-level `- **…` entry, including its continuation lines. */
export const ENTRY_BUDGET_BYTES = 2600;

/** Max BYTES for a whole section file — the "one bounded read" property. */
export const FILE_BUDGET_BYTES = 120_000;

/** Split a backlog file into its top-level entries. */
export function parseEntries(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => {
    if (/^- \*\*/.test(l)) starts.push(i);
  });
  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const body = lines.slice(start, end).join("\n").replace(/\s+$/, "");
    return {
      line: start + 1,
      bytes: sizeOf(body),
      title: lines[start].replace(/^- \*\*/, "").replace(/\*\*/g, "").slice(0, 78),
    };
  });
}

// Entries that predate the budget. A RATCHET, not an amnesty: each may only
// shrink. A new entry must meet the budget outright, and a grandfathered one
// that grows fails the build — which is precisely the accretion this exists to
// stop. Regenerate with --update-baseline after condensing, and the recorded
// ceiling drops permanently.
const baselinePath = join(backlogDir, ".size-baseline.json");

/** Stable identity for an entry — its title, not its line (lines shift constantly). */
function entryKey(file, entry) {
  return `${file}::${entry.title}`;
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    return {};
  }
}

const files = readdirSync(backlogDir).filter((f) => f.endsWith(".md")).sort();
const report = process.argv.includes("--report");
const updateBaseline = process.argv.includes("--update-baseline");
const baseline = loadBaseline();
const nextBaseline = {};
const violations = [];
let totalEntries = 0;
let grandfathered = 0;

for (const file of files) {
  const path = join(backlogDir, file);
  const text = readFileSync(path, "utf8");
  const entries = parseEntries(text);
  totalEntries += entries.length;

  const fileBytes = sizeOf(text);
  if (fileBytes > FILE_BUDGET_BYTES) {
    // Same ratchet as entries. `open-bugs.md` is over on the day this landed:
    // splitting by section made three of the four files a bounded read, but the
    // open-bugs section is ~107 entries and is genuinely NOT one yet. Recording
    // its ceiling makes that visible and shrink-only, rather than silently
    // raising the budget until it means nothing.
    const key = `${file}::__FILE__`;
    const allowed = baseline[key];
    if (updateBaseline) {
      nextBaseline[key] = fileBytes;
    } else if (allowed === undefined) {
      violations.push(
        `docs/backlog/${file} is ${fileBytes} bytes (budget ${FILE_BUDGET_BYTES}) — ` +
          `no longer one bounded read. Condense its largest entries, or split the section.`,
      );
    } else if (fileBytes > allowed) {
      violations.push(
        `docs/backlog/${file} GREW from ${allowed} to ${fileBytes} bytes ` +
          `(budget ${FILE_BUDGET_BYTES}) — an over-budget file may only shrink.`,
      );
    } else {
      grandfathered += 1;
      nextBaseline[key] = fileBytes;
    }
  }

  for (const e of entries) {
    if (e.bytes <= ENTRY_BUDGET_BYTES) continue;
    const key = entryKey(file, e);
    const allowed = baseline[key];
    if (updateBaseline) {
      nextBaseline[key] = e.bytes;
      continue;
    }
    if (allowed === undefined) {
      violations.push(
        `docs/backlog/${file}:${e.line} — NEW entry at ${e.bytes} bytes (budget ${ENTRY_BUDGET_BYTES})\n` +
          `    ${e.title}`,
      );
    } else if (e.bytes > allowed) {
      violations.push(
        `docs/backlog/${file}:${e.line} — GREW from ${allowed} to ${e.bytes} bytes ` +
          `(budget ${ENTRY_BUDGET_BYTES}); a grandfathered entry may only shrink\n` +
          `    ${e.title}`,
      );
    } else {
      grandfathered += 1;
      nextBaseline[key] = e.bytes;
    }
  }

  if (report) {
    const sorted = [...entries].sort((a, b) => b.bytes - a.bytes);
    process.stdout.write(
      `\n${file}: ${entries.length} entries, ${fileBytes} bytes\n` +
        sorted.slice(0, 5).map((e) => `  ${String(e.bytes).padStart(5)}  :${e.line}  ${e.title}\n`).join(""),
    );
  }
}

if (updateBaseline) {
  const sorted = Object.fromEntries(Object.entries(nextBaseline).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  process.stdout.write(
    `wrote ${baselinePath} — ${Object.keys(sorted).length} grandfathered entr(ies) over ` +
      `${ENTRY_BUDGET_BYTES} bytes. Each may now only shrink.\n`,
  );
  process.exit(0);
}

if (violations.length > 0) {
  process.stderr.write(
    `\ncheck-backlog-budget: ${violations.length} over budget\n\n` +
      violations.map((v) => `  ${v}`).join("\n") +
      `\n\nCondense at write time. Keep the MECHANISM and the open PROPERTY; move the\n` +
      `narrative of how it was found to git log or a docs/reviews/ record. An entry that\n` +
      `reinterprets an incident should LINK the primary record rather than retell it —\n` +
      `retelling is how two entries came to invert their own incident's mechanism.\n\n` +
      `A grandfathered entry that shrank below its recorded ceiling: re-run with\n` +
      `--update-baseline to lock the improvement in.\n\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `✓ backlog-budget: ${totalEntries} entries across ${files.length} file(s) within budget ` +
    `(${ENTRY_BUDGET_BYTES} bytes/entry, ${FILE_BUDGET_BYTES} bytes/file)` +
    (grandfathered > 0 ? `; ${grandfathered} grandfathered, shrink-only\n` : `\n`),
);
