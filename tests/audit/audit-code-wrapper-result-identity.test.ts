import { test, expect, vi } from "vitest";
import assert from "node:assert/strict";

// Heavy spawn suite: real tarball packs + real subprocess round-trips, and the
// cases are `concurrent`, so under a full-suite run they contend with siblings.
// Single-sourced ceiling — see tests/helpers/heavy-timeout.mjs for the rationale.
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
vi.setConfig({ testTimeout: HEAVY_AUDIT_TEST_TIMEOUT_MS });
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AUDITOR_ARGS,
  runWrapper,
  startDispatchRun,
  validAuditResultForTask,
  withTempRepo,
} from "./helpers/wrapper-harness.js";
const { isCanonicalResultFilename } = await import("../../src/audit/cli/args.js");

// Result-file IDENTITY: a result file must belong to the task whose path it was
// written to, and the canonical-filename recognizer must tell a real per-task
// result from a stray file. Both guard the same failure — a result being read as
// something it is not.

test.concurrent("isCanonicalResultFilename separates canonical results from stray files", () => {
  // Canonical per-task result name: <stem>_<12-hex digest>.json (artifactNameForId).
  expect(isCanonicalResultFilename("unit_foo_0123456789ab.json")).toBe(true);
  expect(isCanonicalResultFilename("lens_security_packet-1_a1b2c3d4e5f6.json")).toBe(true);
  // Stray files a subagent might leave — no _<12hex> suffix, so a prior round's
  // canonical results never inflate spurious_file_count while these still do.
  expect(isCanonicalResultFilename("packet-23-results.json")).toBe(false);
  expect(isCanonicalResultFilename("packet_spurious_results.json")).toBe(false);
  expect(isCanonicalResultFilename("tmp-packet-87-result.json")).toBe(false);
  expect(isCanonicalResultFilename("audit_result_packet1.json")).toBe(false);
});

test.concurrent("merge-and-ingest rejects swapped task result files", async () => {
  await withTempRepo(async (root) => {
    const dispatchStep = await startDispatchRun(root);
    const runId = dispatchStep.run_id;
    const artifactsDir = dispatchStep.artifacts_dir;

    expect(runId).toBeTruthy();
    expect(artifactsDir).toBeTruthy();

    await runWrapper(
      [
        "prepare-dispatch",
        "--run-id",
        runId,
        "--artifacts-dir",
        artifactsDir,
        ...AUDITOR_ARGS,
      ],
      { cwd: root },
    );

    const runDir = join(artifactsDir, "runs", runId);
    const tasks = JSON.parse(
      await readFile(join(runDir, "pending-audit-tasks.json"), "utf8"),
    );
    expect(tasks.length >= 2).toBeTruthy();
    const resultMap = JSON.parse(
      await readFile(join(runDir, "dispatch-result-map.json"), "utf8"),
    );
    const entryByTaskId = new Map<string, any>(
      resultMap.entries.map((entry: any) => [entry.task_id, entry]),
    );
    const [first, second] = tasks;

    await writeFile(
      entryByTaskId.get(first.task_id).result_path,
      JSON.stringify(validAuditResultForTask(second), null, 2) + "\n",
    );
    await writeFile(
      entryByTaskId.get(second.task_id).result_path,
      JSON.stringify(validAuditResultForTask(first), null, 2) + "\n",
    );

    await assert.rejects(
      runWrapper(
        ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
        { cwd: root },
      ),
      /assigned to|blocked before ingestion/i,
    );
  });
});
