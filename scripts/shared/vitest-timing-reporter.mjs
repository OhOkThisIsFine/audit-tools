// Always-on vitest timing reporter. Added to `reporters` in vitest.config.ts so
// every `vitest run` — local, CI, sharded — emits a compact per-area timing summary
// and persists a ledger under `.audit-tools-profile/` (gitignored) plus a GitHub
// Actions job-summary table. Profiling is a standing feature, not an opt-in flag, so
// a suite-time regression is visible on any run without anyone enabling it.
//
// Reads the per-file timing fields vitest attaches to each collected file
// (collect / setup / prepare / test-execution durations), defensively — missing
// fields degrade to 0 rather than throwing, since the report is advisory.

import { writeProfileLedger } from "./profile.mjs";

// tests/<area>/... → area subtotal bucket.
function areaOf(filepath) {
  const norm = filepath.replaceAll("\\", "/");
  const match = norm.match(/tests\/(audit|shared|remediate)\//);
  return match ? match[1] : "other";
}

function shardSuffix() {
  const shardArg = process.argv.find((a) => a.startsWith("--shard"));
  if (!shardArg) return "";
  const value = shardArg.includes("=") ? shardArg.split("=")[1] : "";
  const parsed = value.match(/(\d+)\/(\d+)/);
  return parsed ? `-shard${parsed[1]}of${parsed[2]}` : "";
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
      const rel = (file.filepath ?? file.name ?? "unknown").replaceAll("\\", "/").replace(/^.*?tests\//, "tests/");
      const d = fileDurations(file);
      return { rel, area: areaOf(file.filepath ?? ""), ...d };
    });

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
    console.log(lines.join("\n"));

    // Ledger: steps = area subtotals only. They partition every file with no
    // overlap, so the profiler's summed total equals the whole-suite wall — a
    // history diff surfaces a whole-area regression. The 10 slowest files ride in
    // meta so a single-file blowup is visible without inflating the total.
    const steps = [...areaTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([area, ms]) => ({ label: `area:${area}`, ms }));
    writeProfileLedger(`vitest${shardSuffix()}`, steps, {
      fileCount: perFile.length,
      collectMs: Math.round(collectSum),
      runMs: Math.round(runSum),
      wallSummedMs: Math.round(wallTotal),
      slowest: slowest.map((f) => ({ file: f.rel, ms: Math.round(f.total), collectMs: Math.round(f.collect), runMs: Math.round(f.run) })),
    });
  }
}
