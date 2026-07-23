import { test, expect } from "vitest";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const validateScript = join(here, "..", "..", "dispatch", "validate-result.mjs");
const mergeScript = join(here, "..", "..", "dispatch", "merge-results.mjs");

/** Spawn a script with CLAUDECODE removed from the environment. */
function run(scriptPath, args = [], cwd = process.cwd()) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    cwd,
    env,
    timeout: 10_000,
  });
}

/** Create a temporary directory that is cleaned up in the finally block. */
function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A minimal valid AuditResult object matching {@link manifestTask}'s identity. */
function minimalValidResult(taskId) {
  return {
    task_id: taskId,
    unit_id: "src/utils/helper.ts",
    pass_id: "pass-1",
    lens: "correctness",
    file_coverage: [{ path: "src/utils/helper.ts", total_lines: 10 }],
    findings: [],
  };
}

/** The pending-manifest task a {@link minimalValidResult} is assigned to. */
function manifestTask(taskId) {
  return {
    task_id: taskId,
    unit_id: "src/utils/helper.ts",
    pass_id: "pass-1",
    lens: "correctness",
    file_paths: ["src/utils/helper.ts"],
  };
}

/** Write runs/<runId>/pending-audit-tasks.json (the acceptance manifest). */
function writeManifest(artifactsDir, runId, tasks) {
  const runDir = join(artifactsDir, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "pending-audit-tasks.json"),
    JSON.stringify(tasks, null, 2),
    "utf8",
  );
}

// ── validate-result.mjs ──────────────────────────────────────────────────────

test("validate-result.mjs: exits 1 with usage when both --run-id and --task-id are missing", () => {
  const result = run(validateScript, []);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Usage:/i);
});

test("validate-result.mjs: exits 1 with usage when --task-id is missing", () => {
  const result = run(validateScript, ["--run-id", "run-123"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Usage:/i);
});

test("validate-result.mjs: sanitizes task-id special characters in the resolved file path", () => {
  withTempDir("dispatch-scripts-sanitize-", (artifactsDir) => {
    const result = run(validateScript, [
      "--run-id", "run-sanitize",
      "--task-id", "foo/bar baz",
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status).toBe(1);
    // The sanitized filename appears in the file-not-found error on stderr
    expect(result.stderr).toMatch(/foo_bar_baz\.json/);
  });
});

test("POSITIVE: validate-result.mjs exits 0 for a valid result validated against its assigned manifest task", () => {
  withTempDir("dispatch-scripts-valid-", (artifactsDir) => {
    const runId = "run-valid";
    const taskId = "task-abc";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    writeManifest(artifactsDir, runId, [manifestTask(taskId)]);
    writeFileSync(
      join(taskResultsDir, `${taskId}.json`),
      JSON.stringify(minimalValidResult(taskId), null, 2),
      "utf8",
    );

    const result = run(validateScript, [
      "--run-id", runId,
      "--task-id", taskId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(new RegExp(taskId));
  });
});

test("NEGATIVE: validate-result.mjs exits 1 for a valid result when NO pending manifest exists (null task context hard-fails, CP-NODE-2)", () => {
  withTempDir("dispatch-scripts-nomanifest-validate-", (artifactsDir) => {
    const runId = "run-nomanifest-validate";
    const taskId = "task-nomanifest";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    // No pending-audit-tasks.json: the task context is null and validation
    // must fail closed, never fail open.
    writeFileSync(
      join(taskResultsDir, `${taskId}.json`),
      JSON.stringify(minimalValidResult(taskId), null, 2),
      "utf8",
    );

    const result = run(validateScript, [
      "--run-id", runId,
      "--task-id", taskId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status, "a result without task context must not validate").toBe(1);
    expect(result.stderr).toMatch(/task context|assigned task/i);
  });
});

test("validate-result.mjs: exits 1 for a result file with invalid JSON", () => {
  withTempDir("dispatch-scripts-badjson-", (artifactsDir) => {
    const runId = "run-badjson";
    const taskId = "task-bad";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    writeFileSync(
      join(taskResultsDir, `${taskId}.json`),
      "{ this is not valid JSON }",
      "utf8",
    );

    const result = run(validateScript, [
      "--run-id", runId,
      "--task-id", taskId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid JSON/i);
  });
});

test("NEGATIVE: validate-result.mjs exits 1 when pending-audit-tasks.json is unreadable (fail-closed, warn still emitted)", () => {
  withTempDir("dispatch-scripts-badtasks-validate-", (artifactsDir) => {
    const runId = "run-badtasks-validate";
    const taskId = "task-validate-badtasks";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });

    writeFileSync(
      join(taskResultsDir, `${taskId}.json`),
      JSON.stringify(minimalValidResult(taskId), null, 2),
      "utf8",
    );

    // Invalid JSON in pending-audit-tasks.json → no task context can be
    // established → validation must fail closed (previously it warned and
    // failed OPEN, validating with no task context).
    const runDir = join(artifactsDir, "runs", runId);
    writeFileSync(join(runDir, "pending-audit-tasks.json"), "{ bad json }", "utf8");

    const result = run(validateScript, [
      "--run-id", runId,
      "--task-id", taskId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status, "unreadable manifest must fail closed").toBe(1);
  });
});

test("validate-result.mjs: default --artifacts-dir resolves under .audit-tools/audit, not .audit-artifacts (COR-bf5c7331)", () => {
  withTempDir("dispatch-scripts-default-dir-", (cwd) => {
    // No --artifacts-dir: the script must default to <cwd>/.audit-tools/audit,
    // matching where the orchestrator/wrapper actually writes runs. The
    // file-not-found error names the resolved path.
    const result = run(validateScript, ["--run-id", "run-x", "--task-id", "task-x"], cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/[/\\]\.audit-tools[/\\]audit[/\\]runs[/\\]run-x[/\\]/);
    expect(result.stderr).not.toMatch(/\.audit-artifacts/);
  });
});

test("merge-results.mjs: default --artifacts-dir resolves under .audit-tools/audit, not .audit-artifacts (COR-bf5c7331)", () => {
  withTempDir("dispatch-scripts-default-dir-merge-", (cwd) => {
    const result = run(mergeScript, ["--run-id", "run-y"], cwd);
    expect(result.status).toBe(1);
    // task-results-not-found error names the resolved default path.
    expect(result.stderr).toMatch(/[/\\]\.audit-tools[/\\]audit[/\\]runs[/\\]run-y[/\\]/);
    expect(result.stderr).not.toMatch(/\.audit-artifacts/);
  });
});

// ── merge-results.mjs ────────────────────────────────────────────────────────

test("merge-results.mjs: exits 1 with usage when --run-id is missing", () => {
  const result = run(mergeScript, []);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Usage:/i);
});

test("merge-results.mjs: exits 1 when task-results directory does not exist", () => {
  withTempDir("dispatch-scripts-nodir-", (artifactsDir) => {
    const result = run(mergeScript, [
      "--run-id", "run-nodir",
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/task-results directory not found/i);
  });
});

test("NEGATIVE: merge-results.mjs hard-fails without a pending manifest and writes NO run-results.json (manifest-reconciled completeness, CP-NODE-2)", () => {
  withTempDir("dispatch-scripts-nomanifest-merge-", (artifactsDir) => {
    const runId = "run-nomanifest-merge";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    // A perfectly valid result on disk — but with no manifest, acceptance
    // cannot be judged. Previously this merged fail-open.
    writeFileSync(
      join(taskResultsDir, "task-orphan.json"),
      JSON.stringify(minimalValidResult("task-orphan"), null, 2),
      "utf8",
    );

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status, "no manifest must fail closed").toBe(1);
    expect(result.stderr).toMatch(/pending-audit-tasks\.json|pending manifest/i);
    expect(
      existsSync(join(artifactsDir, "runs", runId, "run-results.json")),
      "no run-results.json may be written when acceptance cannot be judged",
    ).toBe(false);
  });
});

test("NEGATIVE: merge-results.mjs hard-fails when the pending manifest is unreadable (fail-closed, no write)", () => {
  withTempDir("dispatch-scripts-badtasks-merge-", (artifactsDir) => {
    const runId = "run-badtasks-merge";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });

    const taskId = "task-merge-badtasks";
    writeFileSync(
      join(taskResultsDir, `${taskId}.json`),
      JSON.stringify(minimalValidResult(taskId), null, 2),
      "utf8",
    );

    const runDir = join(artifactsDir, "runs", runId);
    writeFileSync(join(runDir, "pending-audit-tasks.json"), "{ bad json }", "utf8");

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status, "unreadable manifest must fail closed").toBe(1);
    expect(existsSync(join(runDir, "run-results.json"))).toBe(false);
  });
});

test("merge-results.mjs: separates valid and invalid results against the manifest, writes both output files", () => {
  withTempDir("dispatch-scripts-merge-", (artifactsDir) => {
    const runId = "run-merge";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    writeManifest(artifactsDir, runId, [manifestTask("task-good"), manifestTask("task-bad")]);

    writeFileSync(
      join(taskResultsDir, "task-good.json"),
      JSON.stringify(minimalValidResult("task-good"), null, 2),
      "utf8",
    );
    // Parseable but INVALID: lens mismatches the assigned task.
    const badResult = minimalValidResult("task-bad");
    badResult.lens = "security";
    badResult.pass_id = "pass-other";
    writeFileSync(
      join(taskResultsDir, "task-bad.json"),
      JSON.stringify(badResult, null, 2),
      "utf8",
    );

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);

    // INV-03: exits non-zero (1) when any result failed validation.
    expect(result.status, `expected non-zero exit on partial failure; stderr: ${result.stderr}`).toBe(1);

    const runResultsPath = join(artifactsDir, "runs", runId, "run-results.json");
    const failedTasksPath = join(artifactsDir, "runs", runId, "failed-tasks.json");

    const runResults = JSON.parse(readFileSync(runResultsPath, "utf8"));
    expect(runResults.length).toBe(1);
    expect(runResults[0].task_id).toBe("task-good");

    const failedTasks = JSON.parse(readFileSync(failedTasksPath, "utf8"));
    expect(failedTasks.length).toBe(1);
    expect(failedTasks[0].task_id).toBe("task-bad");

    // stderr reports failure count
    expect(result.stderr).toMatch(/1 task\(s\) failed/i);

    // stdout reports passing count in "N/M tasks valid" format
    expect(result.stdout).toMatch(/1\/2 tasks valid/i);
  });
});

test("NEGATIVE: merge-results.mjs rejects a manifest task with NO on-disk result as missing (completeness judged against the manifest)", () => {
  withTempDir("dispatch-scripts-missing-", (artifactsDir) => {
    const runId = "run-missing";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    writeManifest(artifactsDir, runId, [manifestTask("task-a"), manifestTask("task-b")]);

    writeFileSync(
      join(taskResultsDir, "task-a.json"),
      JSON.stringify(minimalValidResult("task-a"), null, 2),
      "utf8",
    );
    // task-b has NO result file at all — previously it silently vanished.

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status, "a missing assigned result is a failure").toBe(1);

    const failedTasks = JSON.parse(
      readFileSync(join(artifactsDir, "runs", runId, "failed-tasks.json"), "utf8"),
    );
    expect(failedTasks.map((f) => f.task_id)).toEqual(["task-b"]);
    expect(failedTasks[0].errors.some((e) => /missing audit result/i.test(e))).toBeTruthy();
    expect(result.stdout).toMatch(/1\/2 tasks valid/i);
  });
});

test("NEGATIVE: merge-results.mjs rejects a result whose task_id is not in the pending manifest (identity is the tool's authority)", () => {
  withTempDir("dispatch-scripts-unknown-", (artifactsDir) => {
    const runId = "run-unknown";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    writeManifest(artifactsDir, runId, [manifestTask("task-known")]);

    writeFileSync(
      join(taskResultsDir, "task-known.json"),
      JSON.stringify(minimalValidResult("task-known"), null, 2),
      "utf8",
    );
    writeFileSync(
      join(taskResultsDir, "task-unknown.json"),
      JSON.stringify(minimalValidResult("task-unknown"), null, 2),
      "utf8",
    );

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status).toBe(1);

    const runResults = JSON.parse(
      readFileSync(join(artifactsDir, "runs", runId, "run-results.json"), "utf8"),
    );
    expect(runResults.map((r) => r.task_id)).toEqual(["task-known"]);

    const failedTasks = JSON.parse(
      readFileSync(join(artifactsDir, "runs", runId, "failed-tasks.json"), "utf8"),
    );
    expect(failedTasks.some((f) => f.task_id === "task-unknown" && f.errors.some((e) => /unknown task_id/i.test(e)))).toBeTruthy();
  });
});

test("NEGATIVE: merge-results.mjs rejects a duplicate task_id instead of double-merging (dedup-by-task_id, CP-NODE-2)", () => {
  withTempDir("dispatch-scripts-dup-", (artifactsDir) => {
    const runId = "run-dup";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    writeManifest(artifactsDir, runId, [manifestTask("task-dup")]);

    // The same task_id answered in two files (e.g. a canonical file plus a
    // packet array from another round).
    writeFileSync(
      join(taskResultsDir, "a-first.json"),
      JSON.stringify(minimalValidResult("task-dup"), null, 2),
      "utf8",
    );
    writeFileSync(
      join(taskResultsDir, "b-second.json"),
      JSON.stringify([minimalValidResult("task-dup")], null, 2),
      "utf8",
    );

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status).toBe(1);

    const runResults = JSON.parse(
      readFileSync(join(artifactsDir, "runs", runId, "run-results.json"), "utf8"),
    );
    expect(runResults.length, "exactly one copy may merge").toBe(1);

    const failedTasks = JSON.parse(
      readFileSync(join(artifactsDir, "runs", runId, "failed-tasks.json"), "utf8"),
    );
    expect(failedTasks.some((f) => f.errors.some((e) => /duplicate audit result/i.test(e)))).toBeTruthy();
  });
});

test("POSITIVE: merge-results.mjs ignores packet schema pointer files as support artifacts (PACKET_SCHEMA_FILENAME_SET exclusion)", () => {
  withTempDir("dispatch-scripts-schema-", (artifactsDir) => {
    const runId = "run-schema";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    writeManifest(artifactsDir, runId, [manifestTask("task-ok")]);

    writeFileSync(
      join(taskResultsDir, "task-ok.json"),
      JSON.stringify(minimalValidResult("task-ok"), null, 2),
      "utf8",
    );
    // Schema pointer files prepare-dispatch copies into task-results/ —
    // support artifacts, never results, and never validation failures.
    for (const name of ["audit_result.schema.json", "finding.schema.json", "audit_task.schema.json"]) {
      writeFileSync(join(taskResultsDir, name), JSON.stringify({ $schema: "stub" }), "utf8");
    }

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status, `schema pointer files must not fail the merge; stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/1\/1 tasks valid/i);
  });
});

test("NEGATIVE: merge-results.mjs never truncates a prior run-results.json on a blocked no-op re-run (CP-NODE-2)", () => {
  withTempDir("dispatch-scripts-noclobber-", (artifactsDir) => {
    const runId = "run-noclobber";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    writeManifest(artifactsDir, runId, [manifestTask("task-x")]);

    // A prior successful merge left run-results.json; this re-run has no
    // result for the (re-listed) pending task → blocked no-op.
    const runResultsPath = join(artifactsDir, "runs", runId, "run-results.json");
    const prior = [minimalValidResult("task-prior")];
    writeFileSync(runResultsPath, JSON.stringify(prior, null, 2), "utf8");

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status, "blocked no-op exits non-zero").toBe(1);

    const preserved = JSON.parse(readFileSync(runResultsPath, "utf8"));
    expect(preserved, "prior run-results.json must survive a blocked no-op").toEqual(prior);
  });
});

// ── INV-01: merge-results.mjs expands AuditResult[] arrays ──────────────────

test("INV-01: merge-results.mjs expands a top-level AuditResult[] array from a single file", () => {
  withTempDir("dispatch-scripts-array-", (artifactsDir) => {
    const runId = "run-array";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    writeManifest(artifactsDir, runId, [manifestTask("task-array-1"), manifestTask("task-array-2")]);

    // A single file containing an AuditResult[] array with two results.
    const t1 = minimalValidResult("task-array-1");
    const t2 = minimalValidResult("task-array-2");
    writeFileSync(
      join(taskResultsDir, "packet-abc-inline-result.json"),
      JSON.stringify([t1, t2], null, 2),
      "utf8",
    );

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);

    // Both elements are valid → clean exit.
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);

    const runResultsPath = join(artifactsDir, "runs", runId, "run-results.json");
    const runResults = JSON.parse(readFileSync(runResultsPath, "utf8"));
    expect(runResults.length, "both array elements should be merged").toBe(2);
    const ids = runResults.map((r) => r.task_id).sort();
    expect(ids).toEqual(["task-array-1", "task-array-2"]);

    // stdout should reflect 2/2 tasks valid.
    expect(result.stdout).toMatch(/2\/2 tasks valid/i);
  });
});

// ── INV-03: merge-results.mjs exits 0 on clean merge ────────────────────────

test("INV-03: merge-results.mjs exits 0 when all results are valid", () => {
  withTempDir("dispatch-scripts-cleanexit-", (artifactsDir) => {
    const runId = "run-cleanexit";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    writeManifest(artifactsDir, runId, [manifestTask("task-ok")]);

    writeFileSync(
      join(taskResultsDir, "task-ok.json"),
      JSON.stringify(minimalValidResult("task-ok"), null, 2),
      "utf8",
    );

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);

    expect(result.status, `expected clean exit; stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/1\/1 tasks valid/i);
  });
});
