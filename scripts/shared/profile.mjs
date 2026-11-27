// sites-pinned: tests/shared/pipeline-guard-scripts.test.ts
// Single-sourced, always-on profiling primitive for the test + release/publish
// pipelines. Times labeled steps, prints a compact `[profile:<name>] <label>: Xs`
// line per step, persists a ledger under `.audit-tools-profile/` (gitignored), and
// — when running under GitHub Actions — appends a markdown timing table to the job
// summary. This replaces the scattered ad-hoc `Date.now()` timing that previously
// lived inline in the smoke/release scripts.
//
// Design invariants:
//   - Always-on, no opt-in flag. Profiling is a standing feature of every run, so a
//     time regression is visible without anyone remembering to enable it.
//   - OS-agnostic. Command spawning routes through the same win32 `.cmd`/`.bat`
//     shell-wrap the release script uses, so identical code runs on win32/darwin/linux.
//   - Non-invasive to gate semantics. `runProfiledCommands` preserves fail-fast between
//     stages. The explicitly independent tail runs together, then records all
//     outcomes and fails if any child failed.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSpawn } from "./spawn-shell.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const profileDir = resolve(repoRoot, ".audit-tools-profile");

/** Round milliseconds to one-decimal seconds for display. */
export function toSeconds(ms) {
  return Math.round(ms / 100) / 10;
}

/** `npm` → `npm.cmd` on win32. */
export function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Time ordered commands with fail-fast prerequisites, then optionally run an
 * explicitly independent tail as a batch. Record every started child before failing.
 *
 * @param {string} profileName  ledger basename, e.g. "verify-checks"
 * @param {Array<{label:string, command:string, args:string[]}>} commands
 * @param {{ meta?: object, spawnImpl?: typeof spawnSync, profileDir?: string, summaryPath?: string | null, parallelTail?: number }} [opts]
 *   `spawnImpl` is a test seam (defaults to node's spawnSync) so failure
 *   classification — spawn error, non-zero status, signal termination — is
 *   unit-testable without arranging real child-process deaths.
 * @returns {Promise<Array<{label:string, ms:number, status:number}>>}
 */
export async function runProfiledCommands(profileName, commands, opts = {}) {
  const spawnImpl = opts.spawnImpl ?? spawnSync;
  const entries = [];
  let failure = null;
  const serialCount = commands.length - (opts.parallelTail ?? 0);
  const started = performance.now();
  for (const { label, command, args } of commands.slice(0, serialCount)) {
    const resolved = resolveSpawn(command, args);
    const start = performance.now();
    const result = spawnImpl(resolved.command, resolved.args, {
      cwd: repoRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    const ms = performance.now() - start;
    // Non-success classification (COR-85a995a0): spawn error, signal termination
    // (spawnSync reports status:null + signal for a killed child), and non-zero
    // exit are ALL failures. The old `status ?? (error ? 1 : 0)` mapping let a
    // signal-killed step read as status 0 — success.
    const status = result.status ?? (result.error || result.signal ? 1 : 0);
    entries.push({ label, ms, status });
    console.log(`[profile:${profileName}] ${label}: ${toSeconds(ms)}s`);
    if (result.error) {
      failure = new Error(`profiled step '${label}' failed to spawn: ${result.error.message}`);
      break;
    }
    if (result.status === null && result.signal) {
      failure = new Error(
        `profiled step '${label}' was terminated by signal ${result.signal}.`,
      );
      break;
    }
    if (status !== 0) {
      failure = new Error(`profiled step '${label}' exited with code ${status}.`);
      break;
    }
  }
  if (!failure && serialCount < commands.length) {
    const tail = commands.slice(serialCount);
    console.log(`[profile:${profileName}] running independent checks: ${tail.map(({ label }) => label).join(", ")}`);
    // The longest smoke goes first. Two workers are enough to overlap the
    // two shorter smokes with it, with less resource contention than three.
    const batch = await runSmokeWorkers(tail);
    for (const { label, ms, status, error, stdout, stderr } of batch) {
      if (stdout) {
        console.log(`[profile:${profileName}] ${label} stdout:`);
        process.stdout.write(stdout.endsWith("\n") ? stdout : stdout + "\n");
      }
      if (stderr) {
        console.error(`[profile:${profileName}] ${label} stderr:`);
        process.stderr.write(stderr.endsWith("\n") ? stderr : stderr + "\n");
      }
      entries.push({ label, ms, status });
      console.log(`[profile:${profileName}] ${label}: ${toSeconds(ms)}s`);
      if (error) console.error(`[profile:${profileName}] ${label}: ${error.message}`);
    }
    const failed = batch.filter(({ status }) => status !== 0);
    if (failed.length) failure = new Error(`parallel checks failed: ${failed.map(({ label }) => label).join(", ")}`);
  }
  writeProfileLedger(profileName, entries, opts.meta, {
    ...opts,
    elapsedMs: opts.parallelTail ? performance.now() - started : undefined,
  });
  if (failure) throw failure;
  return entries;
}

/** @param {Array<{label: string, command: string, args: string[]}>} tail */
async function runSmokeWorkers(tail) {
  /** @type {Array<Awaited<ReturnType<typeof runBufferedCommand>>>} */
  const results = [];
  let next = 0;
  const work = async () => {
    while (next < tail.length) {
      const position = next++;
      results[position] = await runBufferedCommand(tail[position]);
    }
  };
  await Promise.all([work(), work()]);
  return results;
}

/**
 * Run an isolated smoke and group its output without interleaving sibling logs.
 * @param {{label: string, command: string, args: string[]}} step
 * @returns {Promise<{label: string, ms: number, status: number, error?: Error, stdout: string, stderr: string}>}
 */
async function runBufferedCommand({ label, command, args }) {
  const start = performance.now();
  return new Promise((resolveResult) => {
    /** @type {string[]} */
    const stdout = [];
    /** @type {string[]} */
    const stderr = [];
    let spawnError;
    let child;
    try {
      const resolved = resolveSpawn(command, args);
      child = spawn(resolved.command, resolved.args, {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolveResult({ label, ms: performance.now() - start, status: 1,
        error: error instanceof Error ? error : new Error(String(error)), stdout: "", stderr: "" });
      return;
    }
    child.stdout?.setEncoding("utf8").on("data", chunk => stdout.push(chunk));
    child.stderr?.setEncoding("utf8").on("data", chunk => stderr.push(chunk));
    child.on("error", error => { spawnError = error; });
    child.on("close", (code, signal) => {
      const error = spawnError ?? (signal ? new Error(`terminated by signal ${signal}`) :
        code === 0 ? undefined : new Error(`exited with code ${code ?? "unknown"}`));
      resolveResult({
        label, ms: performance.now() - start,
        status: error ? code || 1 : 0, error, stdout: stdout.join(""), stderr: stderr.join(""),
      });
    });
  });
}

/**
 * Persist a profile: `<name>-latest.json` (full snapshot) + one `<name>-history.ndjson`
 * append line, and — under GitHub Actions — a markdown table in the job summary.
 *
 * @param {string} profileName
 * @param {Array<{label:string, ms:number, status?:number}>} entries
 * @param {object} [meta]  extra fields folded into the ledger (e.g. version, git sha)
 * @param {{ profileDir?: string, summaryPath?: string | null, elapsedMs?: number }} [opts] output destinations; defaults to the checkout and CI summary
 */
export function writeProfileLedger(profileName, entries, meta = {}, opts = {}) {
  const outputDir = opts.profileDir ?? profileDir;
  const totalMs = opts.elapsedMs ?? entries.reduce((sum, e) => sum + (e.ms ?? 0), 0);
  const record = {
    profile: profileName,
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    ci: Boolean(process.env.CI),
    gitSha: process.env.GITHUB_SHA ?? null,
    totalMs,
    totalSeconds: toSeconds(totalMs),
    steps: entries.map((e) => ({
      label: e.label, ms: Math.round(e.ms), seconds: toSeconds(e.ms),
      ...(e.status !== undefined ? { status: e.status } : {}),
    })),
    ...meta,
  };
  try {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, `${profileName}-latest.json`), JSON.stringify(record, null, 2));
    appendFileSync(resolve(outputDir, `${profileName}-history.ndjson`), `${JSON.stringify(record)}\n`);
  } catch (error) {
    // Profiling is advisory — a ledger write failure must never fail a pipeline.
    console.warn(`[profile:${profileName}] ledger write skipped: ${/** @type {any} */ (error)?.message ?? error}`);
  }
  appendJobSummary(profileName, record, opts.summaryPath === undefined ? process.env.GITHUB_STEP_SUMMARY : opts.summaryPath);
  return record;
}

/** Render a profile record as a GitHub Actions job-summary markdown table. */
function renderProfileTable(record) {
  const rows = record.steps
    .map((s) => `| ${s.label} | ${s.seconds.toFixed(1)} |`)
    .join("\n");
  return [
    `### ⏱ Profile: ${record.profile}`,
    "",
    "| step | seconds |",
    "|---|--:|",
    rows,
    `| **total** | **${record.totalSeconds.toFixed(1)}** |`,
    "",
  ].join("\n");
}

function appendJobSummary(profileName, record, summaryPath) {
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, `${renderProfileTable(record)}\n`);
  } catch (error) {
    console.warn(`[profile:${profileName}] job-summary append skipped: ${/** @type {any} */ (error)?.message ?? error}`);
  }
}
