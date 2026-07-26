#!/usr/bin/env node
// Deliberately re-record the parallel-flake baseline.
//
// WHY THIS EXISTS. The baseline used to be written by every test run, which made
// it fail-open in the one direction it exists to close: an ordinary development
// run is red precisely when you are mid-change, and those reds went straight into
// the artifact that decides what counts as a KNOWN flake — then got staged by a
// routine `git add -A`. Observed three times; the last one recorded two genuine
// regressions, one as `parallel_flaky`, the status that actively explains a red
// away. Reading the record is safe and still happens on every run; only writing
// it is dangerous, so writing is now an explicit act.
//
// This runs the suite with recording ON. It is the ONLY supported way to move the
// baseline, and it deliberately does not accept a filter: a partial run observes
// a partial suite, and a baseline merged from one is a record of what you happened
// to run rather than of what is flaky.
//
//   npm run test:rebaseline-flakes
//
// Run it on a tree you have decided is green. The baseline records CONTENTION
// evidence — "this passed alone and failed under load" — so a genuinely broken
// test recorded here becomes a red that the next lap is told to ignore.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RECORD_ENV_VAR } from "./vitest-timing-reporter.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

process.stdout.write(
  `Re-recording the parallel-flake baseline (${RECORD_ENV_VAR}=1).\n` +
    `Run this only on a tree you have decided is GREEN — a broken test recorded\n` +
    `here becomes a red the next lap is told to ignore.\n\n`,
);

const result = spawnSync(
  process.execPath,
  [join(repoRoot, "scripts", "shared", "run-vitest-gate.mjs")],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, [RECORD_ENV_VAR]: "1" },
    windowsHide: true,
  },
);

process.exit(result.status ?? 1);
