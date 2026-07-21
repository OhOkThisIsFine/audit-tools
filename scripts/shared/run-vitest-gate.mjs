#!/usr/bin/env node
// Single-sourced vitest GATE. Every local script and CI step that runs vitest
// in a gate context (must actually fail the pipeline on a test failure) should
// invoke this instead of `vitest run` / `npx vitest run` directly.
//
// Closes the false-green defect (docs/backlog.md, search "false-green"):
// `vitest run` has exited 0 while reporting N failed at least 6 times — caught
// only by a human reading the console summary, never the exit code, and once
// that reached release CI before a shard caught it. `vitest run`'s own exit
// code already fails a run with a nonzero status; this script exists purely
// for the exit-0-with-reported-failures case, which nothing else catches.
//
// The check reads the STRUCTURED `outcome` field `vitest-timing-reporter.mjs`
// writes to the `.audit-tools-profile/vitest*-latest.json` ledger (counts +
// failed file paths derived from vitest's own task-result tree) — never
// vitest's console prose. Do not "fix" a slow/awkward result here by grepping
// stdout for `/failed/` or `/passed/`: the backlog documents two false hits
// from exactly that shortcut (a test literally named "fail-closed", and
// "Test Files 1 passed" matching before "Tests 12 passed"). Prose contains
// arbitrary author-chosen test names by construction, so no keyword match over
// it is sound.
//
// Staleness hole: a run that crashes before the reporter's `onFinished` fires
// (a config error, an OOM, a killed worker pool) writes NO new ledger — reading
// the ledger alone would then silently pass on YESTERDAY'S green run. This
// script closes that hole with a run token: a fresh id is generated here and
// threaded to the vitest child via the `VITEST_GATE_TOKEN` env var; the
// reporter echoes it back into the ledger it writes. If the ledger's token
// doesn't match (missing ledger, stale ledger, reporter never ran), the gate
// fails closed rather than trusting a ledger it cannot prove belongs to this run.

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shardSuffix } from "./vitestShard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const profileDir = resolve(repoRoot, ".audit-tools-profile");
const require = createRequire(import.meta.url);

const vitestArgs = process.argv.slice(2);
const token = randomUUID();

const vitestEntry = require.resolve("vitest/vitest.mjs");
const result = spawnSync(process.execPath, [vitestEntry, "run", ...vitestArgs], {
  cwd: repoRoot,
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, VITEST_GATE_TOKEN: token },
});

const vitestExit = result.status ?? (result.error ? 1 : 0);
if (result.error) {
  console.error(`[vitest-gate] failed to spawn vitest: ${result.error.message}`);
}

// vitest's own exit code already fails a run with a genuine nonzero status —
// no need to second-guess it. The ledger check below exists ONLY for the
// false-green case: exit 0 with reported failures.
if (vitestExit !== 0) {
  process.exit(vitestExit);
}

const ledgerName = `vitest${shardSuffix(vitestArgs)}`;
const ledgerPath = resolve(profileDir, `${ledgerName}-latest.json`);

function failClosed(message) {
  console.error(`[vitest-gate] ${message}`);
  console.error(
    "[vitest-gate] vitest exited 0 but its outcome could not be confirmed from the ledger — " +
      "treating this run as FAILED rather than trusting a possibly stale result.",
  );
  process.exit(1);
}

if (!existsSync(ledgerPath)) {
  failClosed(`no ledger found at ${ledgerPath}.`);
}

let record;
try {
  record = JSON.parse(readFileSync(ledgerPath, "utf8"));
} catch (error) {
  failClosed(`ledger at ${ledgerPath} is unreadable/invalid JSON: ${error?.message ?? error}`);
}

if (record.runToken !== token) {
  failClosed(
    `ledger token mismatch at ${ledgerPath} (expected ${token}, found ${record.runToken ?? "none"}) — ` +
      "this run's reporter never wrote a fresh ledger (crash, or an older ledger from a prior run).",
  );
}

const outcome = record.outcome;
if (!outcome || typeof outcome.failed !== "number") {
  failClosed(`ledger at ${ledgerPath} has no structured 'outcome' field.`);
}

if (outcome.failed > 0) {
  console.error(
    `[vitest-gate] vitest process exited 0 but the ledger reports ${outcome.failed} failed test(s) ` +
      `across ${outcome.failedFiles.length} file(s) — this is the false-green defect; failing the gate:`,
  );
  for (const file of outcome.failedFiles) console.error(`  - ${file}`);
  process.exit(1);
}

process.exit(0);
