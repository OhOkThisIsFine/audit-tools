#!/usr/bin/env node
// Size budget for the split backlog.
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
// THE RATCHET IS PER-FILE, NOT PER-ENTRY — and that is a correction, not a
// loosening. An earlier version recorded a shrink-only ceiling for every
// individual over-budget entry. It refused a factually CORRECT edit for costing
// 14 bytes, and again for 15 bytes × 5 when five run-on stages were converted to
// labelled bullets so that deleting one could not silently renumber the others.
// Both were improvements, and in both the only way forward was to re-record a
// HIGHER ceiling — which is the ratchet defeating itself while taxing accuracy on
// the way. A gate that makes correcting a fact cost more than leaving it wrong is
// worse than no gate.
//
// So the shrink-only ceiling lives on the FILE TOTAL, where the property it
// protects actually lives ("one bounded read"), and the per-entry number stays a
// plain THRESHOLD with no snapshot: an entry may grow if the file pays for it
// somewhere. That is the right unit — an entry growing because a neighbour was
// deleted is the backlog working, not regressing.
//
// What survives per-entry is the budget itself. A NEW entry over
// `ENTRY_BUDGET_BYTES` is refused outright; entries that predate the budget are
// grandfathered BY NAME (no recorded size), so the amnesty is visible and finite
// without metering every edit. Their growth is bounded by their file's ceiling,
// which is the number that has to hold.
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
//
//   node scripts/check-backlog-budget.mjs                    # enforce
//   node scripts/check-backlog-budget.mjs --report           # show the distribution
//   node scripts/check-backlog-budget.mjs --update-baseline  # re-record after condensing
//   node scripts/check-backlog-budget.mjs --update-baseline --raise-ceiling
//                                                            # …and accept a HIGHER ceiling
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { splitBacklogEntries } from "./shared/backlog-entry-grammar.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const backlogDir = join(repoRoot, "docs", "backlog");
const baselinePath = join(backlogDir, ".size-baseline.json");

/** UTF-8 byte length — the ONE measurement function, so no caller can drift to `.length`. */
export function sizeOf(text) {
  return Buffer.byteLength(text, "utf8");
}

/** Max BYTES for one top-level `- **…` entry, including its continuation lines. */
export const ENTRY_BUDGET_BYTES = 2600;

/** Max BYTES for a whole section file — the "one bounded read" property. */
export const FILE_BUDGET_BYTES = 120_000;

/**
 * Split a backlog file into its top-level entries and meter each one. Entry
 * boundaries come from the shared grammar; the TITLE stays local because it is a
 * persisted identity (see entryKey / .size-baseline.json) whose 78-char
 * truncation the recorded keys already carry.
 */
export function parseEntries(text) {
  return splitBacklogEntries(text).map(({ line, headline, body }) => ({
    line,
    bytes: sizeOf(body.replace(/\s+$/, "")),
    title: headline.replace(/^- \*\*/, "").replace(/\*\*/g, "").slice(0, 78),
  }));
}

/** Stable identity for an entry — its title, not its line (lines shift constantly). */
export function entryKey(file, entry) {
  return `${file}::${entry.title}`;
}

/**
 * The baseline, in two deliberately DIFFERENT shapes because the two halves are
 * different kinds of promise:
 *
 *   `file_ceilings`      file → recorded BYTES. A shrink-only ratchet: an over-budget
 *                        file may only get smaller — including through
 *                        `--update-baseline`, which cannot re-record one upward
 *                        (`planBaselineUpdate`).
 *   `entries_over_budget` a LIST of entry keys, with no sizes. A named amnesty, not a
 *                        ratchet — these predate the budget and may move in either
 *                        direction; their file's ceiling is what bounds them.
 *
 * The asymmetry is the design. Recording a size here would re-create the per-entry
 * ratchet that taxed correctness.
 */
export function normalizeBaseline(raw) {
  const fileCeilings = raw && typeof raw.file_ceilings === "object" && raw.file_ceilings !== null
    ? raw.file_ceilings
    : {};
  const entries = Array.isArray(raw?.entries_over_budget) ? raw.entries_over_budget : [];
  return { fileCeilings, entriesOverBudget: new Set(entries) };
}

function loadBaseline() {
  try {
    return normalizeBaseline(JSON.parse(readFileSync(baselinePath, "utf8")));
  } catch {
    return normalizeBaseline(null);
  }
}

/**
 * Evaluate the whole backlog. Pure — takes file contents, returns findings — so the
 * gate's own behavior can be tested against synthetic files rather than by mutating
 * the real backlog.
 *
 * @param {{file: string, text: string}[]} files
 * @param {{fileCeilings: Record<string, number>, entriesOverBudget: Set<string>}} baseline
 */
export function evaluateBacklog(files, baseline) {
  const violations = [];
  const staleAmnesty = new Set(baseline.entriesOverBudget);
  const nextBaseline = { file_ceilings: {}, entries_over_budget: [] };
  let totalEntries = 0;
  let grandfathered = 0;
  const distribution = [];

  for (const { file, text } of files) {
    const entries = parseEntries(text);
    totalEntries += entries.length;
    const fileBytes = sizeOf(text);
    distribution.push({ file, fileBytes, entries });

    if (fileBytes > FILE_BUDGET_BYTES) {
      // The one ratchet. `open-bugs.md` is over on the day this landed: splitting by
      // section made three of the four files a bounded read, but the open-bugs section
      // is ~107 entries and is genuinely NOT one yet. Recording its ceiling makes that
      // visible and shrink-only, rather than silently raising the budget until it means
      // nothing.
      const allowed = baseline.fileCeilings[file];
      nextBaseline.file_ceilings[file] = fileBytes;
      if (allowed === undefined) {
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
      }
    }

    for (const e of entries) {
      if (e.bytes <= ENTRY_BUDGET_BYTES) continue;
      const key = entryKey(file, e);
      nextBaseline.entries_over_budget.push(key);
      if (baseline.entriesOverBudget.has(key)) {
        // Grandfathered BY NAME. Deliberately no size comparison: this entry's growth is
        // paid for out of its file's ceiling, so a correctness fix that costs 14 bytes
        // does not have to be argued for.
        staleAmnesty.delete(key);
        grandfathered += 1;
        continue;
      }
      violations.push(
        `docs/backlog/${file}:${e.line} — NEW entry at ${e.bytes} bytes (budget ${ENTRY_BUDGET_BYTES})\n` +
          `    ${e.title}`,
      );
    }
  }

  nextBaseline.entries_over_budget.sort();
  nextBaseline.file_ceilings = Object.fromEntries(
    Object.entries(nextBaseline.file_ceilings).sort(([a], [b]) => a.localeCompare(b)),
  );
  return { violations, totalEntries, grandfathered, staleAmnesty: [...staleAmnesty], nextBaseline, distribution };
}

/**
 * What `--update-baseline` is ALLOWED to write. Measuring the files says what they ARE;
 * this says what may be RECORDED, and the two are not the same question.
 *
 * WHY it is a separate decision. The enforce run's one refusal is "an over-budget file
 * may only shrink" — and `--update-baseline` re-recorded whatever the file currently
 * measured, so erasing that refusal was a single flag away from its legitimate use
 * (locking in a shrink), with the two reading identically at the shell. The only thing
 * between them was a written caution not to do it, which is host discretion where a
 * mechanism was available: a raise is now refused and the recorded ceiling KEPT unless
 * `--raise-ceiling` states the intent out loud, and either way the file is NAMED.
 *
 * A file with no recorded ceiling is recorded as-is — there is nothing to raise yet, and
 * that first record is the ratchet being armed, not defeated. The refusal is partial by
 * design: other files' shrinks and the entry amnesty still land, so one grown file does
 * not strand the rest of an end-of-lap update.
 *
 * @param {{file_ceilings: Record<string, number>, entries_over_budget: string[]}} nextBaseline
 * @param {{fileCeilings: Record<string, number>}} baseline  what is recorded today
 * @param {{raiseCeiling: boolean}} intent
 */
export function planBaselineUpdate(nextBaseline, baseline, { raiseCeiling }) {
  // Required and typed, not defaulted: `"false"` — an argv value forwarded unparsed — is
  // truthy, and would wave through every raise in silence.
  if (typeof raiseCeiling !== "boolean") {
    throw new TypeError(`planBaselineUpdate: raiseCeiling must be a boolean, got ${typeof raiseCeiling}`);
  }

  const file_ceilings = {};
  const refused = [];
  const raised = [];
  // Insertion order is `evaluateBacklog`'s sorted order, so the written file stays stable.
  for (const [file, measured] of Object.entries(nextBaseline.file_ceilings)) {
    const recorded = baseline.fileCeilings[file];
    if (recorded === undefined || measured <= recorded) {
      file_ceilings[file] = measured;
      continue;
    }
    if (raiseCeiling) {
      file_ceilings[file] = measured;
      raised.push({ file, recorded, measured });
      continue;
    }
    file_ceilings[file] = recorded;
    refused.push({ file, recorded, measured });
  }

  return {
    baseline: { file_ceilings, entries_over_budget: nextBaseline.entries_over_budget },
    refused,
    raised,
  };
}

function main() {
  const report = process.argv.includes("--report");
  const updateBaseline = process.argv.includes("--update-baseline");
  const raiseCeiling = process.argv.includes("--raise-ceiling");

  // A flag that silently does nothing is how an operator concludes the gate is broken.
  if (raiseCeiling && !updateBaseline) {
    process.stderr.write(
      `\ncheck-backlog-budget: --raise-ceiling only means anything with --update-baseline,\n` +
        `which is the command that writes the ceiling. Nothing was written.\n\n`,
    );
    process.exit(1);
  }

  const files = readdirSync(backlogDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(backlogDir, file), "utf8") }));

  const baseline = loadBaseline();
  const result = evaluateBacklog(files, baseline);

  if (updateBaseline) {
    const plan = planBaselineUpdate(result.nextBaseline, baseline, { raiseCeiling });
    writeFileSync(baselinePath, JSON.stringify(plan.baseline, null, 2) + "\n", "utf8");
    process.stdout.write(
      `wrote ${baselinePath} — ${Object.keys(plan.baseline.file_ceilings).length} file ceiling(s), ` +
        `${plan.baseline.entries_over_budget.length} grandfathered entr(ies).\n` +
        `A file ceiling may only shrink; a grandfathered entry is amnestied by name, not metered.\n` +
        plan.raised
          .map(
            ({ file, recorded, measured }) =>
              `  raised docs/backlog/${file}: ${recorded} → ${measured} bytes (--raise-ceiling)\n`,
          )
          .join(""),
    );
    if (plan.refused.length > 0) {
      process.stderr.write(
        `\ncheck-backlog-budget: REFUSED to raise ${plan.refused.length} file ceiling(s)\n\n` +
          plan.refused
            .map(
              ({ file, recorded, measured }) =>
                `  docs/backlog/${file}: recorded ${recorded} bytes, now ${measured} ` +
                `(+${measured - recorded}) — kept ${recorded}\n`,
            )
            .join("") +
          `\nAn over-budget file may only SHRINK, and re-recording the grown size would erase\n` +
          `exactly the refusal this gate exists for. Pay for the growth by condensing\n` +
          `elsewhere in the same file. Everything else in this run was written.\n\n` +
          `If the ceiling genuinely must rise, say so — it goes on the record:\n` +
          `  node scripts/check-backlog-budget.mjs --update-baseline --raise-ceiling\n\n`,
      );
      process.exit(1);
    }
    return;
  }

  if (report) {
    for (const { file, fileBytes, entries } of result.distribution) {
      const sorted = [...entries].sort((a, b) => b.bytes - a.bytes);
      process.stdout.write(
        `\n${file}: ${entries.length} entries, ${fileBytes} bytes\n` +
          sorted
            .slice(0, 5)
            .map((e) => `  ${String(e.bytes).padStart(5)}  :${e.line}  ${e.title}\n`)
            .join(""),
      );
    }
    if (result.staleAmnesty.length > 0) {
      process.stdout.write(
        `\nstale amnesty (now under budget or renamed — re-run --update-baseline to drop):\n` +
          result.staleAmnesty.map((k) => `  ${k}\n`).join(""),
      );
    }
    process.stdout.write("\n");
  }

  if (result.violations.length > 0) {
    process.stderr.write(
      `\ncheck-backlog-budget: ${result.violations.length} over budget\n\n` +
        result.violations.map((v) => `  ${v}`).join("\n") +
        `\n\nCondense at write time. Keep the MECHANISM and the open PROPERTY; move the\n` +
        `narrative of how it was found to git log or a docs/reviews/ record. An entry that\n` +
        `reinterprets an incident should LINK the primary record rather than retell it —\n` +
        `retelling is how two entries came to invert their own incident's mechanism.\n\n` +
        `A file that shrank below its recorded ceiling: re-run with --update-baseline to\n` +
        `lock the improvement in. There is no per-entry ceiling to raise — an entry that\n` +
        `must grow is paid for by shrinking its file elsewhere.\n\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `✓ backlog-budget: ${result.totalEntries} entries across ${files.length} file(s) within budget ` +
      `(${ENTRY_BUDGET_BYTES} bytes/entry, ${FILE_BUDGET_BYTES} bytes/file)` +
      (result.grandfathered > 0 ? `; ${result.grandfathered} grandfathered\n` : `\n`),
  );
}

// Run only when invoked as a CLI. Importing this module (the unit tests do, to reach
// `evaluateBacklog`) must not scan the repo — and above all must not `process.exit`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
