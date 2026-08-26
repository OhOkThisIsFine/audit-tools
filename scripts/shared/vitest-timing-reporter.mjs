// Always-on vitest timing reporter. Added to `reporters` in vitest.config.ts so
// every `vitest run` — local, CI, sharded — emits a compact per-area timing summary
// and persists a ledger under `.audit-tools-profile/` (gitignored) plus a GitHub
// Actions job-summary table. Profiling is a standing feature, not an opt-in flag, so
// a suite-time regression is visible on any run without anyone enabling it.
//
// Reads the per-file timing fields vitest attaches to each collected file
// (collect / setup / prepare / test-execution durations), defensively — missing
// fields degrade to 0 rather than throwing, since the timing report is advisory.
//
// The OUTCOME half (passed/failed/skipped counts + failed file paths) is NOT
// advisory — it is the structured data source for `run-vitest-gate.mjs`'s
// false-green check (docs/backlog.md, search "false-green"). `vitest run` has
// exited 0 while reporting N failed at least 6 times; the fix is never to grep
// this reporter's own console prose for pass/fail (test *names* collide with
// words like "failed"/"passed" — the backlog documents two concrete false
// hits from exactly that mistake). Outcome is derived here from each file's
// structured task-result tree (`file.tasks[].result.state`), which is the only
// sound source.
//
// The BASELINE half answers a different question about the same task tree: is
// THIS failure the load-dependent one we have already investigated? A rotating
// set of heavy tests fails only in a full run and passes alone (hermeticity, not
// regression), and every dispatch-touching lap re-derived that same answer by
// stashing and re-running the whole suite on main to prove parity (~2×260s). The
// record below turns that re-run into a lookup, and it is the RECORD that is
// persisted — never a suppression: the gate keeps failing, and an unrecognized
// failure is always RED.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeProfileLedger } from "./profile.mjs";
import { shardSuffix } from "./vitestShard.mjs";

// tests/<area>/... → area subtotal bucket.
function areaOf(filepath) {
  const norm = filepath.replaceAll("\\", "/");
  const match = norm.match(/tests\/(audit|shared|remediate)\//);
  return match ? match[1] : "other";
}

function relPath(file) {
  return (file.filepath ?? file.name ?? "unknown").replaceAll("\\", "/").replace(/^.*?tests\//, "tests/");
}

// Flatten a file's task tree (suites nest tasks) to its leaf tests, each carrying
// the id both halves of this reporter address a test by:
// `tests/<area>/<file>.test.mjs > <suite> > <test>`. Single-sourced so the
// outcome counters and the flake baseline can never disagree about what a leaf is.
function leavesOf(file) {
  const leaves = [];
  const stack = [...(file.tasks ?? [])].map((task) => ({ task, prefix: relPath(file) }));
  while (stack.length > 0) {
    const { task, prefix } = /** @type {{task: any, prefix: string}} */ (stack.pop());
    const id = `${prefix} > ${task.name}`;
    if (task.type === "suite") {
      for (const child of task.tasks ?? []) stack.push({ task: child, prefix: id });
    } else {
      leaves.push({ id, task });
    }
  }
  return leaves;
}

// Derive a structured pass/fail/skip outcome — never from console text. A file
// that failed to collect at all (e.g. a syntax error) has no leaf tasks but its
// own `result.state === "fail"`; that counts as one failed file too, since it is
// exactly the kind of failure a prose scrape is most likely to miss or misparse.
function computeOutcome(files) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let unfinished = 0;
  const failedFiles = new Set();

  for (const file of files) {
    const rel = relPath(file);
    const leaves = leavesOf(file).map((leaf) => leaf.task);

    if (leaves.length === 0) {
      if (file.result?.state === "fail") {
        failed += 1;
        failedFiles.add(rel);
      }
      continue;
    }

    for (const leaf of leaves) {
      const state = leaf.result?.state;
      if (state === "pass") {
        passed += 1;
      } else if (state === "fail") {
        failed += 1;
        failedFiles.add(rel);
      } else if (state === "skip" || state === "todo" || leaf.mode === "skip" || leaf.mode === "todo") {
        // DELIBERATELY not run — the suite declared it skipped/todo.
        skipped += 1;
      } else {
        // NO RESULT REACHED US. Queued, still running, or — the case that matters —
        // a leaf whose result was lost because the `onTaskUpdate` RPC carrying it
        // timed out. A lost result is indistinguishable from a lost FAILURE, so it
        // must never share a bucket with a deliberate skip: `isReporterTransportFault`
        // refuses to downgrade a nonzero exit while any leaf is unfinished.
        unfinished += 1;
      }
    }
  }

  return {
    passed,
    failed,
    skipped,
    unfinished,
    total: passed + failed + skipped + unfinished,
    failedFiles: [...failedFiles].sort(),
  };
}

function fileDurations(file) {
  const collect = file.collectDuration ?? 0;
  const setup = file.setupDuration ?? 0;
  const prepare = file.prepareDuration ?? 0;
  const environment = file.environmentLoad ?? 0;
  const run = file.result?.duration ?? 0;
  return { collect, setup, prepare, environment, run, total: collect + setup + prepare + environment + run };
}

// ─── Parallel-flake baseline ───────────────────────────────────────────────
//
// TRACKED on purpose, unlike the gitignored timing ledger: its whole job is to
// outlive runs, branches and machines, so that a failure a previous lap already
// resolved to "load, not code" is never re-investigated from scratch.
const here = dirname(fileURLToPath(import.meta.url));
export const FLAKE_BASELINE_PATH = resolve(here, "test-flake-baseline.json");

// Bumping this DISCARDS every prior observation (see `readBaseline`) rather than
// migrating it: the record is a cache of measurements, and a stale-shaped one
// must never be the thing that explains away a red.
const BASELINE_SCHEMA = 1;

const EMPTY_EVIDENCE = { passedSolo: false, failedSolo: false, failedParallel: false };

/**
 * The environment a measurement is only valid in. The phenomenon is load-
 * dependent, so a status measured under different concurrency, on a different OS,
 * or on a box with a different core count says nothing about this run — the
 * record is bucketed by this key and a mismatch reads as "no record".
 */
export function currentEnvironment(env = process.env, platform = process.platform) {
  const cpuCount = availableParallelism();
  // vitest's default worker budget is the machine's parallelism; these env vars
  // are its documented overrides. Absent means "vitest chose the default", which
  // is a real value here, not a missing one.
  const declared = Number(env.VITEST_MAX_WORKERS ?? env.VITEST_MAX_THREADS);
  const workers = Number.isFinite(declared) && declared > 0 ? declared : cpuCount;
  return { platform, cpuCount, workers };
}

export function environmentKey({ platform, cpuCount, workers }) {
  return `${platform}-cpu${cpuCount}-w${workers}`;
}

/**
 * A run's LOAD class. `solo` is the isolated re-run the test-failure protocol
 * prescribes — one file, nothing else contending — and is the only thing that can
 * prove a failure was contention rather than code. Anything wider is `parallel`.
 */
export function loadClassOf({ fileCount, workers }) {
  return fileCount > 1 && workers > 1 ? "parallel" : "solo";
}

/**
 * One `{testId, outcome}` per leaf whose result is DECISIVE. A skipped test says
 * nothing about determinism, and an unfinished leaf's result was lost rather than
 * observed — recording either as evidence would let silence promote a test toward
 * "known flaky", which is the one direction this record must never move on guesses.
 */
export function collectObservations(files) {
  const observations = [];
  for (const file of files) {
    const leaves = leavesOf(file);
    if (leaves.length === 0) {
      // Collect-time death (syntax error, killed worker) — no leaves exist, and
      // this whole-file failure is exactly the shape a worker under load takes.
      const state = file.result?.state;
      if (state === "pass" || state === "fail") observations.push({ testId: relPath(file), outcome: state });
      continue;
    }
    for (const { id, task } of leaves) {
      const state = task.result?.state;
      if (state === "pass" || state === "fail") observations.push({ testId: id, outcome: state });
    }
  }
  return observations.sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
}

/**
 * Which evidence an outcome is admissible as. A pass under LOAD is deliberately
 * inadmissible — no slot at all: between two loaded runs the tree changes, so
 * "failed under load, later passed under load" is the signature of a fix at least
 * as much as of a flake. Only the isolated re-run — the one the test-failure
 * protocol prescribes, normally on the same tree — separates contention from code.
 */
function evidenceSlot(outcome, load) {
  if (outcome === "fail") return load === "parallel" ? "failedParallel" : "failedSolo";
  return load === "solo" ? "passedSolo" : null;
}

// Evidence is three monotone booleans, never counts: counts would rewrite the
// tracked file on every run, while booleans converge and the file stops changing
// once a test's behaviour is known.
function deriveStatus(evidence) {
  // Failing with nothing else contending is a real failure, and it OUTRANKS any
  // amount of flaky-looking history — this is what stops the record from ever
  // laundering a genuine regression in a test that used to be load-sensitive.
  if (evidence.failedSolo) return "deterministic";
  // Never failed under load — nothing here is about load.
  if (!evidence.failedParallel) return "deterministic";
  // Failed under load, passed alone: the load-dependent signature, and the only
  // evidence admissible for it.
  if (evidence.passedSolo) return "parallel_flaky";
  // Failed under load and never once observed passing ALONE — indistinguishable
  // from a genuine failure, so it stays a record of a failure and licenses nothing.
  return "unproven";
}

/**
 * Fold a run's observations into the record, returning a new one.
 *
 * ENTRY CRITERION — only a failure observed under parallel load may CREATE an
 * entry, because that failure *is* the phenomenon being catalogued. A solo run can
 * refine an entry that already exists (its pass is the evidence that promotes a
 * recorded failure to `parallel_flaky`) but can never seed one, so a focused
 * red-green loop on a single file leaves the record untouched.
 */
export function mergeObservations({ record, environment, load, observations }) {
  const key = environmentKey(environment);
  const tests = { ...record?.environments?.[key]?.tests };
  for (const { testId, outcome } of observations) {
    const slot = evidenceSlot(outcome, load);
    if (!slot) continue;
    const known = tests[testId];
    if (!known && slot !== "failedParallel") continue;
    const evidence = { ...EMPTY_EVIDENCE, ...known?.evidence, [slot]: true };
    tests[testId] = { status: deriveStatus(evidence), evidence };
  }
  // A run with nothing to record must not even mint an empty bucket — the file is
  // tracked, and a green run has to leave the tree exactly as it found it.
  if (Object.keys(tests).length === 0 && !record?.environments?.[key]) {
    return { schema: BASELINE_SCHEMA, environments: { ...record?.environments } };
  }
  return {
    schema: BASELINE_SCHEMA,
    environments: { ...record?.environments, [key]: { environment, tests } },
  };
}

/**
 * Classify this run's failures against the record. Two outcomes only:
 * `known_parallel_flaky` (a matching record explains it) and `unrecognized`
 * (everything else — stays RED). Both guards below are load-bearing:
 *   - the record must be from THIS environment, since a status measured under
 *     different concurrency/OS/core count means nothing here;
 *   - the CURRENT run must itself be under parallel load. A test that just failed
 *     alone failed with nothing contending, and no amount of flaky history may
 *     explain that away.
 * The caller must classify against the record as it stood BEFORE this run's
 * observations are merged, or a brand-new failure would explain itself.
 */
export function classifyFailures({ record, environment, load, failedTestIds }) {
  const tests = record?.environments?.[environmentKey(environment)]?.tests ?? {};
  return failedTestIds.map((testId) => {
    const recordedStatus = tests[testId]?.status ?? null;
    const known = load === "parallel" && recordedStatus === "parallel_flaky";
    return { testId, recordedStatus, classification: known ? "known_parallel_flaky" : "unrecognized" };
  });
}

function emptyBaseline() {
  return { schema: BASELINE_SCHEMA, environments: {} };
}

/**
 * Read the record, DISCARDING anything unreadable, malformed, or written under a
 * different schema. A record that cannot be trusted must read as no record at
 * all — the failure mode of a repair attempt is a downgrade based on garbage.
 */
export function readBaseline(path = FLAKE_BASELINE_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyBaseline();
  }
  if (!parsed || typeof parsed !== "object") return emptyBaseline();
  if (parsed.schema !== BASELINE_SCHEMA) return emptyBaseline();
  if (!parsed.environments || typeof parsed.environments !== "object") return emptyBaseline();
  return parsed;
}

// Sorted keys + a trailing newline: the file is tracked, so its bytes must be a
// function of its content alone, never of iteration order.
function serializeBaseline(record) {
  const environments = {};
  for (const key of Object.keys(record.environments).sort()) {
    const bucket = record.environments[key];
    const tests = {};
    for (const testId of Object.keys(bucket.tests).sort()) tests[testId] = bucket.tests[testId];
    environments[key] = { environment: bucket.environment, tests };
  }
  return `${JSON.stringify({ schema: record.schema, environments }, null, 2)}\n`;
}

/** Write only on a real content change, so a repeat run leaves the tree clean. */
export function writeBaselineIfChanged(path, record) {
  const next = serializeBaseline(record);
  try {
    if (readFileSync(path, "utf8") === next) return false;
  } catch {
    // No readable prior file — fall through and write one.
  }
  try {
    const temp = `${path}.tmp`;
    writeFileSync(temp, next);
    renameSync(temp, path);
    return true;
  } catch (error) {
    // The baseline is advisory bookkeeping; a write failure must never fail a run.
    console.warn(`[vitest-timing] flake baseline write skipped: ${/** @type {any} */ (error)?.message ?? error}`);
    return false;
  }
}

/** The env var that opts a run in to WRITING the baseline. */
export const RECORD_ENV_VAR = "AUDIT_TOOLS_RECORD_FLAKE_BASELINE";

/**
 * Is this run allowed to WRITE the tracked baseline?
 *
 * Recording used to happen on every run, which made the record fail-open in the
 * one direction it exists to close. An ordinary development run is red precisely
 * when you are mid-change, and those reds were written straight into the artifact
 * that decides what counts as a known flake — then staged by a routine
 * `git add -A`. Observed three times: twice recording pure noise, and once
 * recording two genuine regressions, one of them as `parallel_flaky` (the status
 * that actively EXPLAINS AWAY a red).
 *
 * So the write is now a deliberate act on a tree you have decided is green, not a
 * side effect of running tests. Classification against the PRIOR record is
 * unaffected and still runs on every suite — reading the record is what makes a
 * known flake legible, and only writing it is dangerous.
 * [[false-red-is-as-corrosive-as-false-green]]
 */
export function recordingEnabled(env = process.env) {
  return env[RECORD_ENV_VAR] === "1";
}

/**
 * The whole baseline step for one run: classify against the PRIOR record, then
 * merge this run's observations into it. The ordering is the invariant — a
 * failure recorded by this very run must not be able to explain itself.
 *
 * `recording` gates the WRITE only. When it is off and this run did observe
 * something new, the result carries `pendingObservations: true` so the reporter
 * can say so rather than silently discarding it.
 */
export function updateFlakeBaseline({
  files,
  environment,
  baselinePath = FLAKE_BASELINE_PATH,
  recording = recordingEnabled(),
}) {
  const load = loadClassOf({ fileCount: files.length, workers: environment.workers });
  const record = readBaseline(baselinePath);
  const observations = collectObservations(files);
  const failedTestIds = observations.filter((o) => o.outcome === "fail").map((o) => o.testId);
  const classified = classifyFailures({ record, environment, load, failedTestIds });
  const merged = mergeObservations({ record, environment, load, observations });
  // Nothing learned → the tracked file is not created, rewritten, or touched.
  const changed = serializeBaseline(merged) !== serializeBaseline(record);
  const wrote = recording && changed && writeBaselineIfChanged(baselinePath, merged);
  return {
    environment: environmentKey(environment),
    load,
    classified,
    wrote,
    pendingObservations: changed && !recording,
  };
}

export default class TimingReporter {
  onFinished(files = []) {
    if (!Array.isArray(files) || files.length === 0) return;

    const perFile = files.map((file) => {
      const rel = relPath(file);
      const d = fileDurations(file);
      return { rel, area: areaOf(file.filepath ?? ""), ...d };
    });

    const outcome = computeOutcome(files);

    const areaTotals = new Map();
    let collectSum = 0;
    let runSum = 0;
    for (const f of perFile) {
      areaTotals.set(f.area, (areaTotals.get(f.area) ?? 0) + f.total);
      collectSum += f.collect;
      runSum += f.run;
    }

    const slowest = [...perFile].sort((a, b) => b.total - a.total).slice(0, 10);
    const wallTotal = perFile.reduce((sum, f) => sum + f.total, 0);

    // Console summary — concise, printed after the default reporter's output.
    const lines = ["", "⏱ vitest timing (per-file wall, summed across workers):"];
    for (const [area, ms] of [...areaTotals.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`   ${area.padEnd(10)} ${(ms / 1000).toFixed(1)}s`);
    }
    lines.push(`   collect≈${(collectSum / 1000).toFixed(1)}s  run≈${(runSum / 1000).toFixed(1)}s  files=${perFile.length}`);
    lines.push("   slowest files:");
    for (const f of slowest) {
      lines.push(`     ${(f.total / 1000).toFixed(1)}s  ${f.rel} (collect ${(f.collect / 1000).toFixed(1)}s, run ${(f.run / 1000).toFixed(1)}s)`);
    }
    lines.push(
      `   outcome: ${outcome.passed} passed, ${outcome.failed} failed, ${outcome.skipped} skipped, ${outcome.unfinished} unfinished (total ${outcome.total})`,
    );
    if (outcome.failed > 0) {
      lines.push("   failed files (advisory console echo — the ledger's `outcome` field is the source of truth):");
      for (const f of outcome.failedFiles) lines.push(`     - ${f}`);
    }

    // Baseline step. Wrapped because it is bookkeeping riding on every run in the
    // repo: a defect in it must degrade to "no classification", never take down a
    // suite it has no business failing.
    let flake = null;
    try {
      flake = updateFlakeBaseline({ files, environment: currentEnvironment() });
      const known = flake.classified.filter((c) => c.classification === "known_parallel_flaky");
      const unrecognized = flake.classified.filter((c) => c.classification === "unrecognized");
      if (flake.classified.length > 0) {
        lines.push(`   parallel-flake baseline (${flake.environment}, load=${flake.load}):`);
        if (known.length > 0) {
          lines.push(`     ${known.length} known parallel-flaky (recorded as passing alone — hermeticity, not regression):`);
          for (const c of known) lines.push(`       - ${c.testId}`);
        }
        lines.push(`     ${unrecognized.length} UNRECOGNIZED — these stay RED:`);
        for (const c of unrecognized) lines.push(`       - ${c.testId}${c.recordedStatus ? ` (recorded: ${c.recordedStatus})` : ""}`);
      }
      if (flake.pendingObservations) {
        lines.push(
          `     this run saw something the baseline does not record — NOT written.` +
            ` Re-baseline deliberately on a tree you have decided is green:` +
            ` \`npm run test:rebaseline-flakes\`.`,
        );
      }
    } catch (error) {
      lines.push(`   parallel-flake baseline skipped: ${/** @type {any} */ (error)?.message ?? error}`);
    }
    console.log(lines.join("\n"));

    // Ledger: steps = area subtotals only. They partition every file with no
    // overlap, so the profiler's summed total equals the whole-suite wall — a
    // history diff surfaces a whole-area regression. The 10 slowest files ride in
    // meta so a single-file blowup is visible without inflating the total.
    //
    // `outcome` (passed/failed/skipped counts + failed file paths) is structured
    // data, not console prose — it is what `run-vitest-gate.mjs` reads to catch
    // vitest exiting 0 with reported failures. `runToken` threads through the
    // `VITEST_GATE_TOKEN` env var the gate script sets before spawning vitest;
    // it lets the gate detect a stale or missing ledger (a crashed run must not
    // pass by reading a PRIOR green ledger) rather than only a failed one.
    const steps = [...areaTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([area, ms]) => ({ label: `area:${area}`, ms }));
    writeProfileLedger(`vitest${shardSuffix(process.argv)}`, steps, {
      fileCount: perFile.length,
      collectMs: Math.round(collectSum),
      runMs: Math.round(runSum),
      wallSummedMs: Math.round(wallTotal),
      slowest: slowest.map((f) => ({ file: f.rel, ms: Math.round(f.total), collectMs: Math.round(f.collect), runMs: Math.round(f.run) })),
      // COMPLETE per-file durations (not just the top 10): the input
      // `generate-vitest-shard-baseline.mjs` distills into the committed shard
      // duration baseline the custom sequencer partitions by. Keys are
      // repo-relative test paths, values total ms.
      files: Object.fromEntries(
        [...perFile].sort((a, b) => (a.rel < b.rel ? -1 : 1)).map((f) => [f.rel, Math.round(f.total)]),
      ),
      outcome,
      // Per-failure classification against the tracked baseline. Advisory to the
      // gate today — it rides in the ledger so a lap can answer "is this mine?"
      // from the run's own record instead of re-running the suite on main.
      flakeBaseline: flake,
      runToken: process.env.VITEST_GATE_TOKEN ?? null,
    });
  }
}
