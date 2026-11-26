// Regenerate timing weights from a verified green suite, never from a filtered run.
// npm run generate:shard-baseline
// npm run generate:shard-baseline -- --shards <ledger1> <ledger2> ...
// The first form requires today's tracked test census. The second checks the
// shards against the commit recorded by CI, which may predate new tests.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const localLedger = resolve(repoRoot, ".audit-tools-profile", "vitest-latest.json");
const baselinePath = resolve(here, "vitest-shard-duration-baseline.json");

function fail(message) {
  console.error(`[generate-shard-baseline] REFUSED: ${message}`);
  process.exit(1);
}

function readLedger(path) {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read timing ledger at ${path} (${error instanceof Error ? error.message : String(error)}). Run the full suite first: node scripts/shared/run-vitest-gate.mjs`);
  }

  const { files, outcome } = ledger ?? {};
  if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length === 0) {
    fail(`ledger at ${path} has no per-file timings; re-run with the timing reporter.`);
  }
  if (outcome?.failed !== 0 || outcome?.unfinished !== 0 || !(outcome.passed > 0)) {
    fail(`ledger at ${path} was not green (passed=${outcome?.passed}, failed=${outcome?.failed}, unfinished=${outcome?.unfinished}).`);
  }
  if (Object.keys(files).length !== ledger.fileCount) {
    fail(`ledger at ${path} has an incomplete per-file timing map.`);
  }
  for (const [file, ms] of Object.entries(files)) {
    if (!Number.isFinite(ms) || ms < 0) fail(`invalid duration for ${file} in ${path}.`);
  }
  return ledger;
}

function trackedTests(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true })
      .split("\0")
      .filter((file) => /\.test\.(ts|mjs)$/.test(file));
  } catch {
    fail("could not read the tracked test census; make sure the measured commit is available locally.");
  }
}

const args = process.argv.slice(2);
if (args.length > 0 && (args[0] !== "--shards" || args.length < 3)) {
  fail("usage: npm run generate:shard-baseline [-- --shards <ledger1> <ledger2> ...]");
}
const sharded = args.length > 0;
const ledgers = (sharded ? args.slice(1) : [localLedger]).map(readLedger);
const first = ledgers[0];
const seenShards = new Set();
const merged = new Map();

for (const ledger of ledgers) {
  if (sharded) {
    const match = /^vitest-shard([1-9]\d*)of([1-9]\d*)$/.exec(ledger.profile);
    const index = Number(match?.[1]);
    if (!match || Number(match[2]) !== ledgers.length || index > ledgers.length || seenShards.has(index)) {
      fail("expected every index of one complete shard set, supplied exactly once.");
    }
    seenShards.add(index);
    if (!/^[0-9a-f]{40}$/.test(first.gitSha) || ledger.gitSha !== first.gitSha ||
        ledger.platform !== first.platform || ledger.node !== first.node || ledger.ci !== first.ci) {
      fail("sharded ledgers must come from the same recorded commit and measurement environment.");
    }
  } else if (ledger.profile !== "vitest") {
    fail("expected an unsharded full-suite ledger; supply a complete set with --shards instead.");
  }

  for (const [file, ms] of Object.entries(ledger.files)) {
    if (merged.has(file)) fail(`spec appears in more than one timing ledger: ${file}.`);
    merged.set(file, ms);
  }
}

const tracked = new Set(trackedTests(sharded
  ? ["ls-tree", "-rz", "--name-only", first.gitSha, "--", "tests"]
  : ["ls-files", "-z", "--", "tests"]));
const missing = [...tracked].filter((file) => !merged.has(file));
const extra = [...merged.keys()].filter((file) => !tracked.has(file));
if (missing.length > 0 || extra.length > 0) {
  fail(`the ledger(s) do not cover the ${sharded ? "recorded commit" : "current tracked"} suite: ` +
    `${missing.length} tracked test file(s) missing, ${extra.length} unknown ledger file(s). ` +
    `Run the full suite or supply its complete set of green shard ledgers.`);
}

const payload = {
  $comment: "GENERATED - do not hand-edit. Per-test-file durations (ms) from a green full suite. Regenerate: npm run generate:shard-baseline",
  source: { gitSha: first.gitSha ?? null, platform: first.platform ?? null, node: first.node ?? null, ci: first.ci ?? null, shards: ledgers.length },
  files: Object.fromEntries([...merged.keys()].sort().map((file) => [file, merged.get(file)])),
};
writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`[generate-shard-baseline] wrote ${merged.size} measured file durations to ${baselinePath}`);
