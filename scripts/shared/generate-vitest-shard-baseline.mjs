// Distill the committed shard-duration baseline (vitest-shard-duration-baseline.json,
// consumed by vitest-sequencer.mjs) from the per-file durations the always-on timing
// reporter records in the .audit-tools-profile ledger. The baseline is committed data
// (the CI wall-clock brief's T3 constraint: a build input, never a network/disk lookup
// at test time), but it is GENERATED, never hand-maintained — regenerate after a green
// full run with:
//
//   npm run generate:shard-baseline
//
// Guards, each refusing loudly (the defect class this exists to block is a PARTIAL
// baseline silently disabling the sequencer's balance for every run):
//   - the ledger must be a FULL-suite run (its file census must equal the tracked
//     test-file census from git), not a filtered/sharded/interrupted one;
//   - the ledger's outcome must be green (0 failed, 0 unfinished) — a red run's
//     durations are not representative;
//   - the ledger must carry the complete `files` map (reporter versions predating it
//     produce an actionable refusal, not a truncated baseline).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const LEDGER_PATH = resolve(repoRoot, ".audit-tools-profile", "vitest-latest.json");
const BASELINE_PATH = resolve(here, "vitest-shard-duration-baseline.json");

function fail(message) {
  console.error(`[generate-shard-baseline] REFUSED: ${message}`);
  process.exit(1);
}

let ledger;
try {
  ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
} catch (error) {
  fail(
    `cannot read the full-run ledger at ${LEDGER_PATH} ` +
      `(${error instanceof Error ? error.message : String(error)}). ` +
      `Run the full suite first: node scripts/shared/run-vitest-gate.mjs`,
  );
}

const files = ledger?.files;
if (!files || typeof files !== "object" || Object.keys(files).length === 0) {
  fail(
    "the ledger has no complete per-file `files` map — it predates the reporter " +
      "change that records one. Re-run the full suite on this tree, then retry.",
  );
}

const outcome = ledger?.outcome ?? {};
if ((outcome.failed ?? -1) !== 0 || (outcome.unfinished ?? -1) !== 0) {
  fail(
    `the ledger's run was not green (failed=${outcome.failed}, unfinished=${outcome.unfinished}); ` +
      "a baseline is only written from a green full run.",
  );
}

const tracked = execFileSync("git", ["ls-files", "tests"], { cwd: repoRoot, encoding: "utf8", windowsHide: true })
  .split("\n")
  .filter((f) => /\.test\.(ts|mjs)$/.test(f));
const ledgerSet = new Set(Object.keys(files));
const missing = tracked.filter((f) => !ledgerSet.has(f));
const extra = [...ledgerSet].filter((f) => !tracked.includes(f));
if (missing.length > 0 || extra.length > 0) {
  fail(
    `the ledger is not a full-suite run on the current tree: ` +
      `${missing.length} tracked test file(s) absent from it` +
      `${missing.length > 0 ? ` (e.g. ${missing.slice(0, 3).join(", ")})` : ""}, ` +
      `${extra.length} ledger file(s) no longer tracked` +
      `${extra.length > 0 ? ` (e.g. ${extra.slice(0, 3).join(", ")})` : ""}. ` +
      "Run the FULL suite (no filter, no --shard) on a tree matching the index, then retry.",
  );
}

// Sorted keys + trailing newline: committed bytes are a function of content alone.
const sorted = {};
for (const key of [...ledgerSet].sort()) sorted[key] = files[key];
const payload = {
  $comment:
    "GENERATED — do not hand-edit. Complete per-test-file durations (ms) from a green " +
    "full-suite run; consumed by scripts/shared/vitest-sequencer.mjs for duration-balanced " +
    "sharding. Regenerate: npm run generate:shard-baseline",
  files: sorted,
};
writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
console.log(
  `[generate-shard-baseline] wrote ${Object.keys(sorted).length} file durations to ${BASELINE_PATH}`,
);
