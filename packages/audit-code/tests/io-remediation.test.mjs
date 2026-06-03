import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const {
  appendNdjsonFile,
  readJsonFile,
  readNdjsonFile,
  readOptionalJsonFile,
  readOptionalNdjsonFile,
  writeJsonFile,
  writeNdjsonFile,
} = await import("@audit-tools/shared/io/json");
const {
  cleanupIntermediateArtifacts,
  getArtifactValue,
  loadArtifactBundle,
  promoteFinalAuditReport,
  writeCoreArtifacts,
} = await import("../src/io/artifacts.ts");
const { TOOLING_INPUTS, buildToolingManifest } = await import(
  "../src/io/toolingManifest.ts"
);
const {
  buildRunId,
  clearDispatchFiles,
  ensureSupervisorDirs,
  getRunPaths,
  writeDispatchBatchFiles,
  writeWorkerTaskFiles,
} = await import("../src/io/runArtifacts.ts");

async function withTempDir(prefix, fn) {
  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  try {
    await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function stableToolingManifestValues(manifest) {
  return {
    package_root: manifest.package_root,
    package_version: manifest.package_version,
    implementation_hash: manifest.implementation_hash,
    inputs: manifest.inputs,
  };
}

test("JSON readers and writers surface path-aware failures and optional readers stay permissive", async () => {
  await withTempDir("audit-code-io-json-", async (tempDir) => {
    const brokenJsonPath = join(tempDir, "broken.json");
    const missingJsonPath = join(tempDir, "missing.json");
    const blockingFilePath = join(tempDir, "blocking-parent");
    const impossibleWritePath = join(
      blockingFilePath,
      "nested",
      "value.json",
    );

    await writeFile(brokenJsonPath, "{oops");
    await writeFile(blockingFilePath, "occupied");

    await assert.rejects(
      readJsonFile(brokenJsonPath),
      new RegExp(`Invalid JSON in .*broken\\.json`, "i"),
    );
    await assert.rejects(
      writeJsonFile(impossibleWritePath, { ok: true }),
      new RegExp(`Failed to prepare parent directory .*value\\.json`, "i"),
    );
    await assert.equal(await readOptionalJsonFile(missingJsonPath), undefined);
    await assert.equal(await readOptionalNdjsonFile(join(tempDir, "missing.jsonl")), undefined);
  });
});

test("NDJSON parsing preserves physical line numbers and append/write helpers round-trip", async () => {
  await withTempDir("audit-code-io-ndjson-", async (tempDir) => {
    const brokenNdjsonPath = join(tempDir, "broken.jsonl");
    const validNdjsonPath = join(tempDir, "valid.jsonl");

    await writeFile(
      brokenNdjsonPath,
      ['{"id":1}', "", '{"id":2}', "not-json"].join("\n") + "\n",
    );
    await assert.rejects(
      readNdjsonFile(brokenNdjsonPath),
      /line 4/i,
    );

    await writeNdjsonFile(validNdjsonPath, [{ id: 1 }]);
    await appendNdjsonFile(validNdjsonPath, { id: 2 });

    assert.deepEqual(await readNdjsonFile(validNdjsonPath), [
      { id: 1 },
      { id: 2 },
    ]);
  });
});

test("artifact bundle definitions round-trip joined paths, falsey values, and cleanup metadata", async () => {
  await withTempDir("audit-code-io-artifacts-", async (tempDir) => {
    const bundle = {
      repo_manifest: {
        repository: { name: "fixture" },
        generated_at: "2026-04-22T00:00:00.000Z",
        files: [{ path: "src/index.ts", language: "ts", size_bytes: 10 }],
      },
      auto_fixes_applied: false,
      audit_results: [
        {
          task_id: "task-1",
          unit_id: "unit-1",
          pass_id: "pass-1",
          lens: "correctness",
          file_coverage: [{ path: "src/index.ts", total_lines: 10 }],
          findings: [],
        },
      ],
      audit_report: "# Audit Report\n",
      audit_tasks: [],
    };

    await writeCoreArtifacts(tempDir, bundle);

    const loaded = await loadArtifactBundle(`${tempDir}${sep}`);
    assert.deepEqual(loaded.repo_manifest, bundle.repo_manifest);
    assert.equal(loaded.auto_fixes_applied, false);
    assert.deepEqual(loaded.audit_results, bundle.audit_results);
    assert.equal(getArtifactValue(loaded, "audit-report.md"), "# Audit Report\n");
    assert.equal(getArtifactValue(loaded, "missing.json"), undefined);
    assert.ok(loaded.tooling_manifest);

    const expectedManifest = await buildToolingManifest();
    assert.equal(
      loaded.tooling_manifest.package_version,
      expectedManifest.package_version,
    );
    assert.match(loaded.tooling_manifest.implementation_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(
      loaded.tooling_manifest.implementation_hash,
      "0".repeat(64),
    );
    assert.deepEqual(loaded.tooling_manifest.inputs, Array.from(TOOLING_INPUTS));
    assert.deepEqual(
      stableToolingManifestValues(loaded.tooling_manifest),
      stableToolingManifestValues(expectedManifest),
    );

    const loadedAgain = await loadArtifactBundle(`${tempDir}${sep}`);
    assert.deepEqual(
      stableToolingManifestValues(loadedAgain.tooling_manifest),
      stableToolingManifestValues(loaded.tooling_manifest),
    );

    const deleted = await cleanupIntermediateArtifacts(tempDir);
    assert.ok(deleted.includes("repo_manifest.json"));
    assert.ok(deleted.includes("audit_results.jsonl"));
    assert.ok(deleted.includes("audit-report.md"));
    assert.equal(existsSync(join(tempDir, "repo_manifest.json")), false);
    assert.equal(existsSync(join(tempDir, "audit-report.md")), false);
  });
});

test("final report promotion preserves artifacts when destination is not writable", async () => {
  await withTempDir("audit-code-report-promotion-", async (tempDir) => {
    const artifactsDir = join(tempDir, "artifacts");
    const repoRoot = join(tempDir, "repo");
    await writeCoreArtifacts(artifactsDir, {
      audit_report: "# Audit Report\n",
    });

    const warnings = [];
    const result = await promoteFinalAuditReport(
      { artifactsDir, repoRoot },
      {
        copy: async () => {
          throw new Error("EPERM: operation not permitted");
        },
        warn: (message) => warnings.push(message),
      },
    );

    assert.equal(result.promoted, false);
    assert.equal(result.cleaned, false);
    assert.match(result.warning, /could not promote final report/i);
    assert.equal(warnings.length, 1);
    assert.equal(existsSync(join(artifactsDir, "audit-report.md")), true);
  });
});

test("run artifact helpers produce parseable run ids and clean only dispatch files", async () => {
  await withTempDir("audit-code-run-artifacts-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
    const fixedNow = new Date("2026-04-22T15:16:17.089Z");
    const runId = buildRunId(" flow:auth/entry ", 7, fixedNow);
    const paths = getRunPaths(artifactsDir, runId);

    assert.equal(runId, "20260422T151617089Z_flow-auth-entry_007");
    assert.equal(buildRunId("", 1, fixedNow), "20260422T151617089Z_terminal_001");

    await ensureSupervisorDirs(artifactsDir);

    const task = {
      contract_version: "audit-code-worker/v1alpha1",
      run_id: runId,
      repo_root: "C:\\repo",
      artifacts_dir: artifactsDir,
      obligation_id: "flow:auth/entry",
      preferred_executor: "agent",
      result_path: paths.resultPath,
      worker_command: ["node", "dist/index.js", "worker-run"],
      audit_results_path: join(paths.runDir, "audit-results.json"),
      worker_command_mode: "deferred",
      timeout_ms: 5000,
      max_retries: 1,
    };
    const pendingTasks = [
      {
        task_id: "audit-1",
        unit_id: "unit-1",
        pass_id: "pass-1",
        lens: "security",
        file_paths: ["src/index.ts"],
        file_line_counts: { "src/index.ts": 12 },
        rationale: "fixture",
      },
      {
        task_id: "audit-2",
        unit_id: "unit-2",
        pass_id: "pass-2",
        lens: "correctness",
        file_paths: ["src/other.ts"],
        file_line_counts: { "src/other.ts": 8 },
        rationale: "second fixture",
      },
    ];

    await writeWorkerTaskFiles(
      task,
      "# Prompt\n",
      paths,
      artifactsDir,
      pendingTasks,
    );

    assert.deepEqual(
      JSON.parse(await readFile(paths.taskPath, "utf8")),
      task,
    );
    assert.equal(await readFile(paths.promptPath, "utf8"), "# Prompt\n");
    assert.deepEqual(
      JSON.parse(await readFile(paths.statusPath, "utf8")),
      { run_id: runId, status: "dispatched" },
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(artifactsDir, "dispatch", "current-tasks.json"), "utf8"),
      ),
      pendingTasks,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(artifactsDir, "dispatch", "current-single-task.json"), "utf8"),
      ),
      pendingTasks[0],
    );
    const singleTaskPrompt = await readFile(
      join(artifactsDir, "dispatch", "current-single-task-prompt.md"),
      "utf8",
    );
    assert.match(singleTaskPrompt, /task_id: audit-1/);
    assert.match(singleTaskPrompt, /worker_command:/);
    assert.doesNotMatch(singleTaskPrompt, /audit-2/);
    assert.ok(
      (await readFile(join(artifactsDir, "dispatch", "audit-result.schema.json"), "utf8")).includes(
        "\"$schema\"",
      ),
    );
    assert.ok(
      (await readFile(join(artifactsDir, "dispatch", "audit-results.schema.json"), "utf8")).includes(
        "\"Audit Results\"",
      ),
    );
    assert.ok(
      (await readFile(join(artifactsDir, "dispatch", "finding.schema.json"), "utf8")).includes(
        "\"Audit Finding\"",
      ),
    );

    await clearDispatchFiles(artifactsDir);

    assert.equal(existsSync(join(artifactsDir, "dispatch", "current-task.json")), false);
    assert.equal(existsSync(join(artifactsDir, "dispatch", "current-prompt.md")), false);
    assert.equal(existsSync(join(artifactsDir, "dispatch", "current-tasks.json")), false);
    assert.equal(existsSync(join(artifactsDir, "dispatch", "current-single-task.json")), false);
    assert.equal(existsSync(join(artifactsDir, "dispatch", "current-single-task-prompt.md")), false);
    assert.equal(
      existsSync(join(artifactsDir, "dispatch", "audit-result.schema.json")),
      false,
    );
    assert.equal(
      existsSync(join(artifactsDir, "dispatch", "audit-results.schema.json")),
      false,
    );
    assert.equal(existsSync(join(artifactsDir, "dispatch", "finding.schema.json")), false);
    assert.equal(existsSync(paths.taskPath), true);
    assert.equal(existsSync(paths.promptPath), true);
    assert.equal(existsSync(paths.statusPath), true);
  });
});

test("parallel dispatch helper preserves the whole worker batch in shared dispatch artifacts", async () => {
  await withTempDir("audit-code-run-dispatch-batch-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
    await ensureSupervisorDirs(artifactsDir);

    await writeDispatchBatchFiles(
      artifactsDir,
      [
        {
          run_id: "run-1",
          task_path: join(artifactsDir, "runs", "run-1", "task.json"),
          prompt_path: join(artifactsDir, "runs", "run-1", "prompt.md"),
          result_path: join(artifactsDir, "runs", "run-1", "result.json"),
          status_path: join(artifactsDir, "runs", "run-1", "status.json"),
          audit_results_path: join(artifactsDir, "runs", "run-1", "audit-results.json"),
          pending_audit_tasks_path: join(artifactsDir, "runs", "run-1", "pending-audit-tasks.json"),
        },
        {
          run_id: "run-2",
          task_path: join(artifactsDir, "runs", "run-2", "task.json"),
          prompt_path: join(artifactsDir, "runs", "run-2", "prompt.md"),
          result_path: join(artifactsDir, "runs", "run-2", "result.json"),
          status_path: join(artifactsDir, "runs", "run-2", "status.json"),
          audit_results_path: join(artifactsDir, "runs", "run-2", "audit-results.json"),
          pending_audit_tasks_path: join(artifactsDir, "runs", "run-2", "pending-audit-tasks.json"),
        },
      ],
      [
        {
          task_id: "audit-1",
          unit_id: "unit-1",
          pass_id: "pass-1",
          lens: "security",
          file_paths: ["src/a.ts"],
          rationale: "fixture",
        },
        {
          task_id: "audit-2",
          unit_id: "unit-2",
          pass_id: "pass-2",
          lens: "reliability",
          file_paths: ["src/b.ts"],
          rationale: "fixture",
        },
      ],
    );

    const dispatchSummary = JSON.parse(
      await readFile(join(artifactsDir, "dispatch", "current-task.json"), "utf8"),
    );
    assert.equal(dispatchSummary.mode, "parallel-batch");
    assert.equal(dispatchSummary.run_count, 2);
    assert.deepEqual(
      dispatchSummary.runs.map((run) => run.run_id),
      ["run-1", "run-2"],
    );
    assert.match(
      await readFile(join(artifactsDir, "dispatch", "current-prompt.md"), "utf8"),
      /run-1[\s\S]*run-2/i,
    );
    assert.ok(existsSync(join(artifactsDir, "dispatch", "audit-result.schema.json")));
    assert.ok(existsSync(join(artifactsDir, "dispatch", "audit-results.schema.json")));
    assert.ok(existsSync(join(artifactsDir, "dispatch", "finding.schema.json")));
  });
});
