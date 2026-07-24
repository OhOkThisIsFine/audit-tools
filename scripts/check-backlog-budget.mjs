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
//   node scripts/check-backlog-budget.mjs            # enforce
//   node scripts/check-backlog-budget.mjs --report   # show the distribution
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const backlogDir = join(repoRoot, "docs", "backlog");

/** Max characters for one top-level `- **…` entry, including its continuation lines. */
export const ENTRY_BUDGET_CHARS = 2600;

/** Max characters for a whole section file — the "one bounded read" property. */
export const FILE_BUDGET_CHARS = 120_000;

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
      chars: body.length,
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

  if (text.length > FILE_BUDGET_CHARS) {
    // Same ratchet as entries. `open-bugs.md` is over on the day this landed:
    // splitting by section made three of the four files a bounded read, but the
    // open-bugs section is ~107 entries and is genuinely NOT one yet. Recording
    // its ceiling makes that visible and shrink-only, rather than silently
    // raising the budget until it means nothing.
    const key = `${file}::__FILE__`;
    const allowed = baseline[key];
    if (updateBaseline) {
      nextBaseline[key] = text.length;
    } else if (allowed === undefined) {
      violations.push(
        `docs/backlog/${file} is ${text.length} chars (budget ${FILE_BUDGET_CHARS}) — ` +
          `no longer one bounded read. Condense its largest entries, or split the section.`,
      );
    } else if (text.length > allowed) {
      violations.push(
        `docs/backlog/${file} GREW from ${allowed} to ${text.length} chars ` +
          `(budget ${FILE_BUDGET_CHARS}) — an over-budget file may only shrink.`,
      );
    } else {
      grandfathered += 1;
      nextBaseline[key] = text.length;
    }
  }

  for (const e of entries) {
    if (e.chars <= ENTRY_BUDGET_CHARS) continue;
    const key = entryKey(file, e);
    const allowed = baseline[key];
    if (updateBaseline) {
      nextBaseline[key] = e.chars;
      continue;
    }
    if (allowed === undefined) {
      violations.push(
        `docs/backlog/${file}:${e.line} — NEW entry at ${e.chars} chars (budget ${ENTRY_BUDGET_CHARS})\n` +
          `    ${e.title}`,
      );
    } else if (e.chars > allowed) {
      violations.push(
        `docs/backlog/${file}:${e.line} — GREW from ${allowed} to ${e.chars} chars ` +
          `(budget ${ENTRY_BUDGET_CHARS}); a grandfathered entry may only shrink\n` +
          `    ${e.title}`,
      );
    } else {
      grandfathered += 1;
      nextBaseline[key] = e.chars;
    }
  }

  if (report) {
    const sorted = [...entries].sort((a, b) => b.chars - a.chars);
    process.stdout.write(
      `\n${file}: ${entries.length} entries, ${text.length} chars\n` +
        sorted.slice(0, 5).map((e) => `  ${String(e.chars).padStart(5)}  :${e.line}  ${e.title}\n`).join(""),
    );
  }
}

if (updateBaseline) {
  const sorted = Object.fromEntries(Object.entries(nextBaseline).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  process.stdout.write(
    `wrote ${baselinePath} — ${Object.keys(sorted).length} grandfathered entr(ies) over ` +
      `${ENTRY_BUDGET_CHARS} chars. Each may now only shrink.\n`,
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
    `(${ENTRY_BUDGET_CHARS} chars/entry, ${FILE_BUDGET_CHARS} chars/file)` +
    (grandfathered > 0 ? `; ${grandfathered} grandfathered, shrink-only\n` : `\n`),
);
