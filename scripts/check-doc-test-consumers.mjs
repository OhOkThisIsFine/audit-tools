#!/usr/bin/env node
// The declared doc → test consumer map check.
//
// WHY THIS EXISTS. A contract-bearing doc edit has no edit-time surface naming
// the tests that assert its content. `docs/nightly-routine.md`'s approved lane
// swap was green through every local doc gate and failed release CI on a parity
// test that pinned the retired helper invocation verbatim, burning tag v0.34.40.
// The durable fix named in the record is this map.
//
// WHAT IS MECHANICAL, and it is deliberately the SMALL half: when a mapped doc
// is in the STAGED set, the map is printed with the tests that assert it, so the
// editor is handed the list without having to grep for it. That is a surface,
// not an enforcement — and saying so is the point.
//
// WHAT IS NOT, declared rather than implied: this does not check that the named
// tests still ASSERT the doc (a test can be edited to stop asserting and nothing
// here notices), nor that an unmapped doc is uncovered (it is only UNCLAIMED).
// Both would need assertion-level provenance — knowing which string in a test
// came from which doc — which is the same undecidable class the acquired-analyzer
// boundary already declares. So the map is CURATED and its rows are checked for
// SHAPE (a tracked doc, tracked tests, a stated `what`), which is what keeps it
// from rotting into a list of paths that no longer exist.
//
//   node scripts/check-doc-test-consumers.mjs             # verify the map's shape
//   node scripts/check-doc-test-consumers.mjs --staged    # print the consumers
//                                                         # for the staged docs
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DOC_TEST_CONSUMERS } from "./doc-test-consumers-data.mjs";
import { guardArgv } from "./shared/argvGuard.mjs";

const root = resolve(process.cwd());

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
}

function trackedFiles() {
  return new Set(git(["ls-files"]).split(/\r?\n/).filter(Boolean));
}

/**
 * The map's SHAPE errors — pure over the rows and a `tracked` predicate, so the
 * contract test drives every failure mode without a git repo.
 */
export function validateMap(rows, tracked) {
  const errors = [];
  const seen = new Set();
  for (const row of rows) {
    const where = row.doc ?? "(row with no doc)";
    if (!row.doc) {
      errors.push(`A row names no doc — every row must state the doc it maps.`);
      continue;
    }
    if (seen.has(row.doc)) errors.push(`${where} is mapped by more than one row.`);
    seen.add(row.doc);
    if (!tracked(row.doc)) errors.push(`${where} is not a tracked file.`);
    if (!Array.isArray(row.tests) || row.tests.length === 0) {
      errors.push(`${where} names no test — a map row with no consumer claims coverage of nothing.`);
      continue;
    }
    for (const test of row.tests) {
      if (!tracked(test)) errors.push(`${where} → ${test} is not a tracked file.`);
    }
    if (typeof row.what !== "string" || row.what.length < 20) {
      errors.push(
        `${where} states no \`what\` — a reader must be able to judge whether their edit touches the asserted content.`,
      );
    }
  }
  return errors;
}

/** The rows whose doc is in the staged set — what `--staged` prints. */
export function stagedConsumers(rows, staged) {
  const set = new Set(staged);
  return rows.filter((row) => set.has(row.doc));
}

/**
 * The map's shape errors from a STAGED-SET view: given the staged paths, which
 * mapped docs are being edited, and what each one's consumers are. Pure text in,
 * text out — the recognizer the declared form drives, so a form sample is a
 * staged-file listing rather than a call shape.
 *
 * `rows` is optional so the function is callable with ONE argument — the form
 * harness drives `fn(sample)` — and defaults to the real map.
 */
export function describeStagedHits(stagedText, rows = DOC_TEST_CONSUMERS) {
  const staged = stagedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return stagedConsumers(rows, staged).map(
    (row) => `${row.doc} → asserts: ${row.what} → ${row.tests.join(", ")}`,
  );
}

function main(args) {
  const tracked = trackedFiles();
  const errors = validateMap(DOC_TEST_CONSUMERS, (path) => tracked.has(path));

  if (args.has("--staged")) {
    const staged = git(["diff", "--cached", "--name-only"])
      .split(/\r?\n/)
      .filter(Boolean);
    for (const line of describeStagedHits(staged.join("\n"))) {
      console.log(`doc-test-consumers: ${line}`);
    }
  }

  if (errors.length > 0) {
    console.error("✗ doc-test-consumers check failed:\n\n" + errors.join("\n") + "\n");
    process.exit(1);
  }
  console.log(
    `✓ doc-test-consumers: ${DOC_TEST_CONSUMERS.length} doc(s) declare their test consumers; ` +
      `an unmapped doc is UNCLAIMED, never asserted uncovered`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(
    guardArgv(process.argv.slice(2), {
      name: "check-doc-test-consumers",
      usage: "node scripts/check-doc-test-consumers.mjs [--staged]",
      flags: ["--staged"],
    }),
  );
}
