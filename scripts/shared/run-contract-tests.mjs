// sites-pinned: tests/release-wiring.test.mjs
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashContent } from "./primitives.mjs";
import { worktreeTrees } from "./worktree-tree.mjs";
import { writeSuiteGreenStamp } from "./suiteGreenStamp.mjs";

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
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...paths], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], windowsHide: true, timeout: 120_000,
  });
  process.stdout.write(result.stdout ?? "");
  if (result.status !== 0) throw result.error ?? new Error(`Contract tests exited ${result.status ?? result.signal}`);
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
