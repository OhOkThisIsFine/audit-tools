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

// Walk a file's task tree (suites nest tasks) to its leaf tests, and derive a
// structured pass/fail/skip outcome — never from console text. A file that
// failed to collect at all (e.g. a syntax error) has no leaf tasks but its own
// `result.state === "fail"`; that counts as one failed file too, since it is
// exactly the kind of failure a prose scrape is most likely to miss or misparse.
function computeOutcome(files) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failedFiles = new Set();

  for (const file of files) {
    const rel = relPath(file);
    const leaves = [];
    const stack = [...(file.tasks ?? [])];
    while (stack.length > 0) {
      const task = stack.pop();
      if (task.type === "suite") {
        stack.push(...(task.tasks ?? []));
      } else {
        leaves.push(task);
      }
    }

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
      } else {
        // skip / todo / queued / any unfinished state — none of these are a pass.
        skipped += 1;
      }
    }
  }

  return { passed, failed, skipped, total: passed + failed + skipped, failedFiles: [...failedFiles].sort() };
}

function fileDurations(file) {
  const collect = file.collectDuration ?? 0;
  const setup = file.setupDuration ?? 0;
  const prepare = file.prepareDuration ?? 0;
  const environment = file.environmentLoad ?? 0;
  const run = file.result?.duration ?? 0;
  return { collect, setup, prepare, environment, run, total: collect + setup + prepare + environment + run };
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
    lines.push(`   outcome: ${outcome.passed} passed, ${outcome.failed} failed, ${outcome.skipped} skipped (total ${outcome.total})`);
    if (outcome.failed > 0) {
      lines.push("   failed files (advisory console echo — the ledger's `outcome` field is the source of truth):");
      for (const f of outcome.failedFiles) lines.push(`     - ${f}`);
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
      outcome,
      runToken: process.env.VITEST_GATE_TOKEN ?? null,
    });
  }
}
