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

import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shardSuffix } from "./vitestShard.mjs";
import {
  attributeFailure,
  formatAttributionLine,
  isReporterTransportFault,
} from "./vitestGateVerdict.mjs";
import { worktreeTree } from "./worktree-tree.mjs";
import { isFullSuiteRun, writeSuiteGreenStamp } from "./suiteGreenStamp.mjs";
import {
  observeAndClaimLoadFlake,
} from "./load-flake-record.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const profileDir = resolve(repoRoot, ".audit-tools-profile");
// Mutable observations are checkout-local runtime state. Keeping them under the
// ignored profiler directory is load-bearing: a write to this record must not
// change the source-tree identity used to decide whether an observation repeats.
const loadFlakeRecordPath = resolve(profileDir, "load-flake-record.json");
const require = createRequire(import.meta.url);

const vitestArgs = process.argv.slice(2);
const token = randomUUID();

const vitestEntry = require.resolve("vitest/vitest.mjs");
// stderr is PIPED (stdout stays inherited, so progress still streams live) purely
// so the false-RED check below can identify a harness fault by its signature. It
// is echoed verbatim immediately after the run, so nothing is hidden.
const result = spawnSync(process.execPath, [vitestEntry, "run", ...vitestArgs], {
  cwd: repoRoot,
  stdio: ["inherit", "inherit", "pipe"],
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
  env: { ...process.env, VITEST_GATE_TOKEN: token },
});

const stderrText = result.stderr ?? "";
if (stderrText) process.stderr.write(stderrText);

const vitestExit = result.status ?? (result.error ? 1 : 0);
if (result.error) {
  console.error(`[vitest-gate] failed to spawn vitest: ${result.error.message}`);
}

const ledgerName = `vitest${shardSuffix(vitestArgs)}`;
const ledgerPath = resolve(profileDir, `${ledgerName}-latest.json`);

if (vitestExit !== 0) {
  // vitest's own nonzero exit is normally authoritative. The ONE case it is not
  // is a recognized reporter-transport fault over a ledger that this run
  // provably wrote (fresh token) and that reports zero failures. The predicate
  // is single-sourced in vitestGateVerdict.mjs so it can be tested without
  // reproducing a real worker-RPC timeout.
  let transportRecord = null;
  try {
    transportRecord = JSON.parse(readFileSync(ledgerPath, "utf8"));
  } catch {
    // No readable ledger — nothing to appeal to; the nonzero exit stands.
  }
  if (!isReporterTransportFault({ record: transportRecord, token, stderrText })) {
    // STATE what this run can prove about the failure before leaving. A caller
    // sees only the exit code otherwise, and the one that mattered — the
    // pre-commit doc-contract leg — filled that silence by asserting a cause it
    // had not observed. Attribution belongs here, where the run token proves
    // the ledger describes THIS run.
    const attribution = attributeFailure({ record: transportRecord, token });
    console.error(formatAttributionLine(attribution));
    await runIsolatedDiagnostics({ record: transportRecord, attribution });
    process.exit(vitestExit);
  }
  console.error(
    `[vitest-gate] vitest exited ${vitestExit}, but this run's own ledger reports ` +
      `${transportRecord.outcome.passed} passed / 0 failed and stderr carries a vitest-worker ` +
      `RPC timeout — a REPORTER-TRANSPORT fault, not a test failure. Treating as PASS.`,
  );
  console.error(
    "[vitest-gate] (if this becomes frequent, raise the worker RPC timeout — a suite that " +
      "routinely reports red while green is the same false-signal class as a false green.)",
  );
  // FALL THROUGH to the single success boundary below rather than exiting here.
  // A tolerated run is full evidence by construction — the predicate already
  // proved this run's own token, zero failed and zero unfinished leaves — so it
  // must mint the same stamp every other PASS does. Exiting 0 here instead left
  // the one run class the gate goes out of its way to call green as the one
  // class carrying no evidence it was, which is the tolerance's own false
  // signal relocated to the closeout. The checks below re-confirm the ledger
  // this path already read; that redundancy is free and keeps ONE success exit.
}

function failClosed(message) {
  console.error(`[vitest-gate] ${message}`);
  console.error(
    "[vitest-gate] this run's outcome could not be confirmed from the ledger — treating it as " +
      "FAILED rather than trusting a possibly stale result.",
  );
  // Every exit this script owns states its attribution, so a caller never has
  // to infer one from silence. Here the verdict is always unattributable by
  // construction: the ledger is what could not be trusted.
  console.error(formatAttributionLine({ attributable: false, reason: message.trim() }));
  process.exit(1);
}

if (!existsSync(ledgerPath)) {
  failClosed(`no ledger found at ${ledgerPath}.`);
}

let record;
try {
  record = JSON.parse(readFileSync(ledgerPath, "utf8"));
} catch (error) {
  failClosed(`ledger at ${ledgerPath} is unreadable/invalid JSON: ${/** @type {any} */ (error)?.message ?? error}`);
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
  const attribution = attributeFailure({ record, token });
  console.error(formatAttributionLine(attribution));
  await runIsolatedDiagnostics({ record, attribution });
  process.exit(1);
}

// A full-suite green is the only run that is evidence about the WHOLE tree, so
// only that run mints a stamp. Best-effort by construction: a stamp that cannot
// be written leaves NO evidence, and no-evidence is the safe reading downstream.
if (isFullSuiteRun(vitestArgs)) writeSuiteGreenStamp(repoRoot, worktreeTree(repoRoot));

process.exit(0);

/**
 * A full-suite failure is still RED, but it no longer leaves diagnosis to a
 * remembered file list. Every attributable failing file is rerun alone. A
 * full-suite fail followed by a solo pass is recorded from the tool's own
 * observations; the second distinct-tree occurrence starts a read-only repair
 * investigation and tells the runner where its report will land.
 */
async function runIsolatedDiagnostics({ record, attribution }) {
  if (!isFullSuiteRun(vitestArgs)) return;
  if (process.env.AUDIT_TOOLS_ISOLATED_LOAD_DIAGNOSTIC === "1") return;
  if (!attribution.attributable) return;

  const environment = record?.flakeBaseline?.environment ?? `${process.platform}-unknown-load`;
  const tree = worktreeTree(repoRoot);
  for (const file of [...new Set(attribution.failedFiles)]) {
    console.error(`[vitest-gate] isolated diagnostic: rerunning ${file} alone; the original gate remains RED.`);
    const solo = spawnSync(process.execPath, [fileURLToPath(import.meta.url), file], {
      cwd: repoRoot,
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, AUDIT_TOOLS_ISOLATED_LOAD_DIAGNOSTIC: "1" },
    });
    const soloExit = solo.status ?? (solo.error || solo.signal ? 1 : 0);
    if (soloExit !== 0) {
      console.error(
        `[vitest-gate] ISOLATED-FAIL: ${file} also failed alone (regression candidate); original gate remains RED.`,
      );
      continue;
    }

    console.error(
      `[vitest-gate] LOAD-ONLY OBSERVED: ${file} failed in the full suite and passed alone; ` +
        `original gate remains RED.`,
    );
    if (!tree) {
      console.error("[vitest-gate] observation was not recorded because the worktree tree id was unavailable.");
      continue;
    }

    try {
      const result = await observeAndClaimLoadFlake({
        path: loadFlakeRecordPath,
        environment,
        file,
        tree,
        observedAt: new Date().toISOString(),
        startInvestigation: async (observation) => {
          const slug = createHash("sha256").update(`${environment}\0${file}`).digest("hex").slice(0, 16);
          const investigationDir = resolve(profileDir, "load-flake-investigations");
          const requestPath = resolve(investigationDir, `${slug}.request.json`);
          const reportPath = resolve(investigationDir, `${slug}.md`);
          mkdirSync(investigationDir, { recursive: true });
          writeFileSync(
            requestPath,
            `${JSON.stringify({ repoRoot, environment, file, tree, count: observation.count }, null, 2)}\n`,
            "utf8",
          );
          const child = spawn(
            process.execPath,
            [resolve(here, "dispatch-load-flake-investigation.mjs"), requestPath, reportPath],
            { cwd: repoRoot, detached: true, stdio: "ignore", windowsHide: true },
          );
          const started = await waitForSpawn(child);
          if (!started.ok) return { started: false, error: started.error };
          child.on("error", () => {});
          child.unref();
          return { started: true, requestedAt: new Date().toISOString(), reportPath };
        },
      });
      if (result.prior?.count > 0) {
        console.error(
          `[vitest-gate] ADVISORY: ${file} has failed under full-suite load and passed alone ` +
            `${result.prior.count} time(s) on distinct source-tree content in ${environment}.`,
        );
      }
      if (result.investigation.started) {
        console.error(
          `[vitest-gate] REPEATED LOAD-ONLY FAILURE: started an isolated test-repair investigation; report: ${result.investigation.reportPath}`,
        );
      } else if (result.investigation.error) {
        const typedSpawnError = /** @type {any} */ (result.investigation.error);
        console.error(
          `[vitest-gate] repeated-load investigation could not start (${typedSpawnError?.message ?? typedSpawnError}); ` +
            `the claim remains retryable and the original gate remains RED.`,
        );
      }
    } catch (error) {
      const typedError = /** @type {any} */ (error);
      console.error(
        `[vitest-gate] load-only observation could not be recorded (${typedError?.message ?? error}); original gate remains RED.`,
      );
    }
  }
}

/** Resolve only after Node confirms process creation; an `error` leaves the record unclaimed. */
function waitForSpawn(child) {
  return new Promise((resolve) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve({ ok: true });
    };
    const onError = (error) => {
      child.off("spawn", onSpawn);
      resolve({ ok: false, error });
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}
