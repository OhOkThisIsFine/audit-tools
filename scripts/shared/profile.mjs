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
//   - Non-invasive to gate semantics. `runProfiledCommands` preserves fail-fast: a
//     non-zero step throws after its timing is recorded, exactly like the former
//     `&&` chain.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const profileDir = resolve(repoRoot, ".audit-tools-profile");

/** Round milliseconds to one-decimal seconds for display. */
export function toSeconds(ms) {
  return Math.round(ms / 100) / 10;
}

function quoteForCmd(arg) {
  if (arg.length === 0) return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

// Route `.cmd`/`.bat` (npm, npx, gh shims on Windows) through the command shell so
// they resolve reliably — same wrap as scripts/release-and-publish.mjs.
function resolveSpawn(command, args) {
  if (!(process.platform === "win32" && /\.(cmd|bat)$/i.test(command))) {
    return { command, args };
  }
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")],
  };
}

/** `npm` → `npm.cmd` on win32. */
export function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Run an ordered list of commands, timing each. Preserves fail-fast: the first
 * non-zero exit records its timing, writes the (partial) ledger, then throws.
 *
 * @param {string} profileName  ledger basename, e.g. "verify-checks"
 * @param {Array<{label:string, command:string, args:string[]}>} commands
 * @param {{ meta?: object, spawnImpl?: typeof spawnSync }} [opts]
 *   `spawnImpl` is a test seam (defaults to node's spawnSync) so failure
 *   classification — spawn error, non-zero status, signal termination — is
 *   unit-testable without arranging real child-process deaths.
 * @returns {Promise<Array<{label:string, ms:number, status:number}>>}
 */
export async function runProfiledCommands(profileName, commands, opts = {}) {
  const spawnImpl = opts.spawnImpl ?? spawnSync;
  const entries = [];
  let failure = null;
  for (const { label, command, args } of commands) {
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
  writeProfileLedger(profileName, entries, opts.meta);
  if (failure) throw failure;
  return entries;
}

/**
 * Persist a profile: `<name>-latest.json` (full snapshot) + one `<name>-history.ndjson`
 * append line, and — under GitHub Actions — a markdown table in the job summary.
 *
 * @param {string} profileName
 * @param {Array<{label:string, ms:number, status?:number}>} entries
 * @param {object} [meta]  extra fields folded into the ledger (e.g. version, git sha)
 */
export function writeProfileLedger(profileName, entries, meta = {}) {
  const totalMs = entries.reduce((sum, e) => sum + (e.ms ?? 0), 0);
  const record = {
    profile: profileName,
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    ci: Boolean(process.env.CI),
    gitSha: process.env.GITHUB_SHA ?? null,
    totalMs,
    totalSeconds: toSeconds(totalMs),
    steps: entries.map((e) => ({ label: e.label, ms: Math.round(e.ms), seconds: toSeconds(e.ms) })),
    ...meta,
  };
  try {
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(resolve(profileDir, `${profileName}-latest.json`), JSON.stringify(record, null, 2));
    appendFileSync(resolve(profileDir, `${profileName}-history.ndjson`), `${JSON.stringify(record)}\n`);
  } catch (error) {
    // Profiling is advisory — a ledger write failure must never fail a pipeline.
    console.warn(`[profile:${profileName}] ledger write skipped: ${error?.message ?? error}`);
  }
  appendJobSummary(profileName, record);
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

function appendJobSummary(profileName, record) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, `${renderProfileTable(record)}\n`);
  } catch (error) {
    console.warn(`[profile:${profileName}] job-summary append skipped: ${error?.message ?? error}`);
  }
}
