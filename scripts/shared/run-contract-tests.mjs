// sites-pinned: tests/release-wiring.test.mjs
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashContent } from "./primitives.mjs";
import { worktreeTrees } from "./worktree-tree.mjs";
import { writeSuiteGreenStamp } from "./suiteGreenStamp.mjs";

/** @param {string} tap */
function reportFailedTestNames(tap) {
  const maxNames = 8;
  const names = new Set();
  let diagnosticIndent = null;
  for (const line of tap.split(/\r?\n/)) {
    if (diagnosticIndent !== null) {
      if (line.trimEnd() === `${diagnosticIndent}...`) diagnosticIndent = null;
      continue;
    }
    const diagnostic = /^( +)---\s*$/.exec(line);
    if (diagnostic) {
      diagnosticIndent = diagnostic[1];
      continue;
    }
    const failed = /^ *not ok \d+ - (.+)$/.exec(line);
    if (!failed || / # (?:SKIP|TODO)\b/i.test(failed[1])) continue;
    // Only TAP titles, never diagnostic bodies. Redact recognizable filenames
    // and stop at paths or labeled payloads that may contain spaces.
    const name = failed[1]
      .replace(/\b(?:api[ _-]?key|authorization|cookie|credentials?|password|passwd|secrets?|tokens?)\s*[:=].*$/i, "[redacted]")
      .replace(/(^|\s)\S*[/\\=].*$/, "$1[redacted]")
      .replace(/(?<![\p{L}\p{N}_.-])[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.[a-z][a-z\d]{0,11}\b/giu, "[redacted]")
      .replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
    if (!name) continue;
    const bounded = name.length > 140 ? `${name.slice(0, 140)}…` : name;
    if (names.size === maxNames && !names.has(bounded)) {
      names.add("(additional failing tests omitted)");
      break;
    }
    names.add(bounded);
  }
  if (names.size) process.stderr.write(`Failing contract tests:\n  ${[...names].join("\n  ")}\n`);
}

const root = join(import.meta.dirname, "../..");
const files = readdirSync(join(root, "tests")).filter(name => name.endsWith(".test.mjs")).sort();
if (!files.length) throw new Error("No contract test files found");
const paths = files.map(name => join("tests", name));
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--check") {
  for (const path of paths) {
    const result = spawnSync(process.execPath, ["--check", path], { cwd: root, stdio: "inherit", windowsHide: true });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
if (args.length !== 0) throw new Error("The contract suite does not support filters");

const token = randomUUID();
const lockDir = join(tmpdir(), `audit-tools-vitest-${hashContent(root, { length: 12 })}.holders`);
mkdirSync(lockDir, { recursive: true });
const holder = join(lockDir, `${token}.json`);
writeFileSync(holder, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
try {
  const before = worktreeTrees(root)?.tree ?? null;
  if (!before) throw new Error("Could not bind tests to a Git worktree tree");
  // On Windows the full fixture inventory can exceed two minutes while still
  // making progress. Keep a finite deadline and require the same complete TAP.
  const timeoutMs = process.platform === "win32" ? 240_000 : 120_000;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...paths], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], windowsHide: true, timeout: timeoutMs,
  });
  process.stdout.write(result.stdout ?? "");
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
    throw new Error(`Contract suite timed out (ETIMEDOUT) after ${timeoutMs / 1000}s; no green stamp written. Rerun npm run test:built unfiltered on the same unchanged checkout when the machine is ready.`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    reportFailedTestNames(result.stdout ?? "");
    throw new Error(`Contract tests exited ${result.status ?? result.signal}`);
  }
  const summary = result.stdout?.match(/\n# tests (\d+)\r?\n# suites \d+\r?\n# pass (\d+)\r?\n# fail 0\r?\n# cancelled 0\r?\n# skipped 0\r?\n# todo 0\r?\n# duration_ms [\d.]+\s*$/);
  const passed = Number(summary?.[2]);
  if (!(passed >= paths.length && passed === Number(summary?.[1]))) {
    throw new Error("Missing or incomplete Node test summary; no green stamp written");
  }
  const after = worktreeTrees(root)?.tree ?? null;
  if (before !== after) throw new Error("Checkout changed during contract tests; rerun against the current tree");
  const evidence = {
    run_token: token,
    vitest_args: [], // Persisted field name used by the existing landing and ledger readers.
    tree_before: before,
    tree_after: after,
    reporter: { runToken: token, outcome: { passed, total: passed, failed: 0, unfinished: 0, skipped: 0, failedFiles: [] } },
  };
  if (!writeSuiteGreenStamp(root, after, evidence)) throw new Error("Could not record the verified test tree");
} finally {
  unlinkSync(holder);
}
