#!/usr/bin/env node
// `docs/reviews/` routing declaration gate.
//
// WHY THIS EXISTS. Seven dated review records were cited by nothing tracked —
// over 1,500 lines of identified, prioritized work that no queue knew about,
// including a whole philosophy audit challenging four standing decisions.
// Nothing could have caught it: no gate reconciled `docs/reviews/` against
// `docs/backlog/`, and `docs/documentation-philosophy.md` stated no rule for
// routing a review's recommendations into a queue. The failure is silent by
// construction — the reviews are well-formed, the backlog is well-formed, and
// the only thing missing is the edge between them. Routing them took a lap of
// agent time a gate would have made unnecessary.
//
// THE OBVIOUS GATE IS THE WRONG ONE, and the record says so: "every review is
// cited from somewhere" is detectable but WRONG, because a dogfood log, a
// measurement record and a completed triage legitimately carry no forward work
// and would each be a false red — and a false red gets the gate disabled, which
// is worse than no gate. Whether a record identifies work is a SEMANTIC
// judgment, the same unscriptable class the record-update gate's semantic half
// already declares.
//
// So the mechanism is a DECLARATION THE AUTHOR WRITES ONCE, in the record:
//
//     <!-- review-routing: <slug> -->
//
// on a line near the top, where `<slug>` is a routing ROW in the data module
// below. The author asserts the disposition; the gate enforces that the
// assertion exists, is well-formed, and names a row that actually routes
// somewhere in the tree. It never guesses whether the prose contained work.
//
// WHAT IT DOES NOT DO, declared rather than implied: it cannot tell whether an
// author picked the TRUE row, only that they picked one and that the row's
// stated destination exists. That residue is why the declaration is a sentence
// in the record rather than a checkbox — a wrong claim is visible to the next
// reader in the same place the right one would be.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REVIEW_ROUTING_ROWS } from "./review-routing-data.mjs";
import { guardArgv } from "./shared/argvGuard.mjs";

// The root is the optional positional argument. `guardArgv` parses it in the entry block, so
// a flag can never be read as the root and an unrecognized flag is refused. An importer
// (the contract test) gets the working directory.
let root = resolve(process.cwd());

/** The declared-debt baseline: pre-mechanism records, by path. Shrinks, never grows. */
export const BASELINE_PATH = "docs/reviews/.routing-baseline.json";

/** Render the baseline file. Sorted, so a re-record of the same set is byte-identical. */
export function renderBaseline(files) {
  return `${JSON.stringify({ note: "Pre-mechanism review records with no routing declaration. This list only SHRINKS: declare a record's routing and re-run with --update-baseline, or the stale entry is a red.", files: [...files].sort() }, null, 2)}\n`;
}

function readBaseline() {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")).files ?? [];
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

/** `<!-- review-routing: <slug> -->` — the ONE declaration form. */
export const ROUTING_DECLARATION = /<!--\s*review-routing:\s*([a-z0-9][a-z0-9-]*)\s*-->/;

/**
 * The form as a callable, so the guard-form harness can drive the REAL
 * recognizer over a declared sample (P51) — a bare RegExp export is not a
 * function and the `export` drive has nothing to call. Returns the row ids it
 * finds, so a caller can assert on them the way the sibling recognizers do.
 */
export function findRoutingDeclarations(text) {
  return [...text.matchAll(new RegExp(ROUTING_DECLARATION, "g"))].map((match) => match[1]);
}

/**
 * The declaration must sit in the record's HEADER (the first N lines), so a
 * reader meets the disposition before the analysis — and so a routing note
 * buried in a closing paragraph cannot satisfy the gate by accident.
 */
export const HEADER_LINES = 20;

/**
 * Every tracked `docs/reviews/*.md`, split into declared and undeclared.
 * Pure over its inputs (the file list and a reader), so the contract test can
 * drive every failure mode without a git repo.
 */
export function classifyReviewRecords({ files, read }) {
  const declared = [];
  const undeclared = [];
  const unknownRow = [];
  const known = new Set(REVIEW_ROUTING_ROWS.map((row) => row.id));
  for (const file of files) {
    const header = read(file).split(/\r?\n/).slice(0, HEADER_LINES);
    let match;
    for (const line of header) {
      const found = ROUTING_DECLARATION.exec(line);
      if (found) {
        match = found;
        break;
      }
    }
    if (!match) {
      undeclared.push(file);
      continue;
    }
    if (!known.has(match[1])) {
      unknownRow.push({ file, row: match[1] });
      continue;
    }
    declared.push({ file, row: match[1] });
  }
  return { declared, undeclared, unknownRow };
}

/** A row's stated destination must exist — a declaration that routes nowhere is a dead rule. */
export function deadDestinationRows(rows, exists) {
  return rows.filter((row) => row.destination !== null && !exists(row.destination));
}

/**
 * A RATCHET, not an exemption — the repo's own backlog-budget idiom.
 *
 * 73 dated records predate this mechanism, and deciding each one's disposition
 * is a per-record SEMANTIC judgment (which is the whole reason the gate cannot
 * make it). Refusing all 73 on day one would block every commit until that
 * analysis is done — and a gate that blocks on work unrelated to the change
 * under review gets overridden, which is worse than no gate.
 *
 * So the records that predate the mechanism are recorded BY PATH in a baseline
 * file, and the ratchet has teeth in three directions:
 *   • a NEW record (not in the baseline) with no declaration is a RED;
 *   • a baseline record that HAS been declared must leave the baseline — the
 *     `--update-baseline` writer refuses to re-record it, so the list only
 *     shrinks;
 *   • a baseline path that no longer exists is a RED (a stale entry is how a
 *     baseline rots into a permanent exemption).
 *
 * The baseline is a DECLARED-DEBT list with a stated doom, never an off switch.
 */
/**
 * The entries a `--update-baseline` write would ADD to the baseline.
 *
 * The ratchet has teeth on the READ side (`evaluateRatchet` reds a stale entry
 * and a new undeclared record), but the WRITER had none of its own: recording
 * a record into the baseline and then re-running produced a self-consistent
 * green, so the one command that exists to SHRINK the declared-debt list could
 * also silence a record it was never meant to cover.
 *
 * `previous` is the baseline on disk. A path already on it is a re-record (the
 * write is a no-op for that entry); a path NOT on it is debt this run is
 * declaring for the first time, which is exactly what the ratchet forbids. So
 * the writer refuses unless the new set is a SUBSET of the previous one.
 */
export function baselineAdditions({ previous, next }) {
  const known = new Set(previous);
  return next.filter((file) => !known.has(file));
}

export function evaluateRatchet({ undeclared, baseline }) {
  const known = new Set(baseline);
  const errors = [];
  const newUndeclared = undeclared.filter((file) => !known.has(file));
  if (newUndeclared.length > 0) {
    errors.push(
      `Review record(s) added since this mechanism landed carry no routing\n` +
        `declaration — a review can propose a whole program and reach no queue:\n` +
        newUndeclared.map((f) => `  - ${f}`).join("\n") +
        `\n  → add \`<!-- review-routing: <row> -->\` in the first ${HEADER_LINES} lines. Rows:\n` +
        REVIEW_ROUTING_ROWS.map((row) => `      ${row.id} — ${row.means}`).join("\n"),
    );
  }
  const stale = [...known].filter((file) => !undeclared.includes(file));
  if (stale.length > 0) {
    errors.push(
      `Baseline entries that are no longer undeclared — they were declared (good) or\n` +
        `deleted (fine), but the baseline still lists them, and an entry that can stay\n` +
        `listed after it is resolved is how a ratchet becomes a permanent exemption:\n` +
        stale.map((f) => `  - ${f}`).join("\n") +
        `\n  → run node scripts/check-review-routing.mjs --update-baseline`,
    );
  }
  return errors;
}

function main(args) {
  const files = git(["ls-files", "docs/reviews/*.md"])
    .split(/\r?\n/)
    .filter(Boolean);
  const { declared, undeclared, unknownRow } = classifyReviewRecords({
    files,
    read: (file) => readFileSync(join(root, file), "utf8"),
  });

  if (args.has("--update-baseline")) {
    // The writer's own shrink guard. Without it the command that exists to take
    // records OFF the list could also put them on, and the run that did so would
    // be green by construction — the ratchet's read-side teeth only bite the run
    // AFTER the baseline was already widened.
    const added = baselineAdditions({ previous: readBaseline(), next: undeclared });
    if (added.length > 0) {
      console.error(
        `✗ refusing to update ${BASELINE_PATH}: it would ADD ` +
          `${added.length} entry(ies). The baseline is a SHRINKING declared-debt list — a record ` +
          `added to it is a record silenced forever:\n` +
          added.map((f) => `  - ${f}`).join("\n") +
          `\n  → declare the routing in the record (\`<!-- review-routing: <row> -->\` in its first ` +
          `${HEADER_LINES} lines) instead of baselining it.`,
      );
      process.exit(1);
    }
    writeFileSync(
      join(root, BASELINE_PATH),
      renderBaseline(undeclared),
      "utf8",
    );
    process.stdout.write(
      `wrote ${BASELINE_PATH}: ${undeclared.length} pre-mechanism record(s) still undeclared ` +
        `(${declared.length} already declared)\n`,
    );
    return;
  }

  const baseline = readBaseline();
  const errors = [];
  errors.push(...evaluateRatchet({ undeclared, baseline }));
  if (unknownRow.length > 0) {
    errors.push(
      `Review record(s) name a routing row that does not exist in\n` +
        `scripts/review-routing-data.mjs:\n` +
        unknownRow.map((u) => `  - ${u.file} → ${u.row}`).join("\n"),
    );
  }
  const dead = deadDestinationRows(REVIEW_ROUTING_ROWS, (destination) => {
    try {
      return git(["ls-files", destination]).trim().length > 0;
    } catch {
      return false;
    }
  });
  if (dead.length > 0) {
    errors.push(
      `Routing row(s) point at a destination no tracked file matches — a dead rule that\n` +
        `would green a record routed nowhere:\n` +
        dead.map((row) => `  - ${row.id} → ${row.destination}`).join("\n"),
    );
  }

  if (errors.length > 0) {
    console.error("✗ review-routing check failed:\n\n" + errors.join("\n\n") + "\n");
    process.exit(1);
  }
  console.log(
    `✓ review-routing: ${declared.length} review record(s) declare a routing row, ` +
      `${undeclared.length} pre-mechanism record(s) remain on the declared-debt baseline, ` +
      `and every row's destination resolves`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = guardArgv(process.argv.slice(2), {
    name: "check-review-routing",
    usage: "node scripts/check-review-routing.mjs [root] [--update-baseline]",
    flags: ["--update-baseline"],
    positionals: 1,
  });
  root = resolve(args.positionals[0] ?? process.cwd());
  main(args);
}
