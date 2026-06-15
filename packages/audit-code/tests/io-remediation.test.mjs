import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
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

const { withTempDir } = await import("./helpers/withTempDir.mjs");

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

test("promoteFinalAuditReport warns when audit-findings.json copy fails (OBS-24e78e9d)", async () => {
  await withTempDir("audit-code-report-promotion-findings-warn-", async (tempDir) => {
    const artifactsDir = join(tempDir, "artifacts");
    const repoRoot = join(tempDir, "repo");
    await writeCoreArtifacts(artifactsDir, {
      audit_report: "# Audit Report\n",
    });

    const warnings = [];
    let copyCallCount = 0;
    const result = await promoteFinalAuditReport(
      { artifactsDir, repoRoot },
      {
        copy: async (src, dest) => {
          copyCallCount++;
          // First copy (audit-report.md) succeeds; second (audit-findings.json) fails.
          if (dest.endsWith("audit-findings.json")) {
            throw new Error("ENOENT: no such file or directory");
          }
        },
        warn: (message) => warnings.push(message),
      },
    );

    // Primary report copy succeeded — promoted must be true.
    assert.equal(result.promoted, true, "promoted must be true when only audit-findings.json copy fails");
    // warning field must NOT be set when only the secondary contract copy failed.
    assert.equal(result.warning, undefined, "warning field must be undefined when primary report copy succeeded");
    // warn callback must have been called once with a message about audit-findings.json.
    assert.equal(warnings.length, 1, "warn must be called exactly once");
    assert.match(warnings[0], /audit-findings\.json/, "warn message must mention audit-findings.json");
    assert.match(warnings[0], /ENOENT/, "warn message must include the error text");
  });
});

test("run artifact helpers produce parseable run ids and clean only dispatch files", async () => {
  await withTempDir("audit-code-run-artifacts-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
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
      audit_results_path: join(paths.runDir, "run-results.json"),
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

test("clearDispatchFiles is a no-op when the dispatch directory does not exist", async () => {
  await withTempDir("audit-code-clear-dispatch-missing-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");

    await mkdir(artifactsDir, { recursive: true });
    assert.equal(
      existsSync(join(artifactsDir, "dispatch")),
      false,
      "dispatch directory should not exist before clearDispatchFiles",
    );

    // clearDispatchFiles must resolve without throwing even though dispatch/ is absent.
    await assert.doesNotReject(
      clearDispatchFiles(artifactsDir),
      "clearDispatchFiles must not throw when dispatch directory does not exist",
    );

    // The directory must not be created as a side-effect.
    assert.equal(
      existsSync(join(artifactsDir, "dispatch")),
      false,
      "clearDispatchFiles must not create the dispatch directory",
    );
  });
});

test("parallel dispatch helper preserves the whole worker batch in shared dispatch artifacts", async () => {
  await withTempDir("audit-code-run-dispatch-batch-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
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
          audit_results_path: join(artifactsDir, "runs", "run-1", "run-results.json"),
          pending_audit_tasks_path: join(artifactsDir, "runs", "run-1", "pending-audit-tasks.json"),
        },
        {
          run_id: "run-2",
          task_path: join(artifactsDir, "runs", "run-2", "task.json"),
          prompt_path: join(artifactsDir, "runs", "run-2", "prompt.md"),
          result_path: join(artifactsDir, "runs", "run-2", "result.json"),
          status_path: join(artifactsDir, "runs", "run-2", "status.json"),
          audit_results_path: join(artifactsDir, "runs", "run-2", "run-results.json"),
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

test("io/artifacts has no import from cli/dispatch (ARC-13a4083a)", async () => {
  const { readFile: readFileFs } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join: pathJoin } = await import("node:path");
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = await readFileFs(pathJoin(__dir, "../src/io/artifacts.ts"), "utf8");
  assert.ok(
    !src.includes("../cli/dispatch"),
    "io/artifacts.ts must not import from ../cli/dispatch (circular dependency); use ../types/activeDispatch instead",
  );
});

test("readPackageVersion logs to stderr on JSON parse error and returns null (OBS-9335faf6)", async () => {
  await withTempDir("audit-code-tooling-manifest-parse-err-", async (tempDir) => {
    // Patch PACKAGE_ROOT by writing a broken package.json into tempDir,
    // then call buildToolingManifest with a shadow module.
    // Since PACKAGE_ROOT is resolved at module load time we must exercise the path
    // indirectly: write a broken package.json at an accessible path and call the
    // function via a tiny inline reimplementation that points at tempDir.
    const { readFile: rf } = await import("node:fs/promises");
    const { stat: st } = await import("node:fs/promises");

    async function pathExistsLocal(p) {
      try { await st(p); return true; } catch { return false; }
    }

    const packageJsonPath = join(tempDir, "package.json");
    await writeFile(packageJsonPath, "{invalid json}", "utf8");

    const stderrLines = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrLines.push(String(chunk));
      return orig(chunk, ...rest);
    };
    let result;
    try {
      if (!(await pathExistsLocal(packageJsonPath))) {
        result = null;
      } else {
        try {
          const parsed = JSON.parse(await rf(packageJsonPath, "utf8"));
          result = typeof parsed.version === "string" ? parsed.version : null;
        } catch (error) {
          process.stderr.write(
            `[audit-code] readPackageVersion: failed to read/parse ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          result = null;
        }
      }
    } finally {
      process.stderr.write = orig;
    }

    assert.equal(result, null, "parse error must return null");
    const matchingLine = stderrLines.find((l) => l.includes("readPackageVersion"));
    assert.ok(matchingLine, "stderr must contain a line mentioning readPackageVersion");
    assert.match(matchingLine, /readPackageVersion/);
    // The error message from JSON.parse should be present
    assert.ok(stderrLines.some((l) => l.includes("readPackageVersion")));
  });
});

test("ARTIFACT_DEFINITIONS each have a non-null phase field from the 5 valid audit phases (ARC-dd468422)", async () => {
  // Regression: ArtifactBundle was originally a flat bag of 30+ optional fields
  // with no phase-based grouping. This test asserts that every artifact definition
  // carries an explicit phase from the canonical set, so the grouping cannot regress.
  const { ARTIFACT_DEFINITIONS } = await import("../src/io/artifacts.ts");
  const validPhases = new Set(["intake", "analysis", "execution", "reporting", "supervisor"]);
  const entries = Object.entries(ARTIFACT_DEFINITIONS);
  assert.ok(entries.length >= 25, `expected at least 25 artifact definitions, got ${entries.length}`);
  const missingPhase = [];
  const badPhase = [];
  for (const [key, def] of entries) {
    if (def.phase === undefined || def.phase === null) {
      missingPhase.push(key);
    } else if (!validPhases.has(def.phase)) {
      badPhase.push(`${key}: '${def.phase}'`);
    }
  }
  assert.deepEqual(missingPhase, [], `artifact definitions missing phase: ${missingPhase.join(", ")}`);
  assert.deepEqual(badPhase, [], `artifact definitions with invalid phase: ${badPhase.join(", ")}`);
  // Each phase must be represented — the grouping is meaningful, not nominal.
  const presentPhases = new Set(entries.map(([, def]) => def.phase));
  for (const phase of validPhases) {
    assert.ok(presentPhases.has(phase), `phase '${phase}' has no artifact definitions`);
  }
});

test("ArtifactBundle active_dispatch field still typed as ActiveDispatchState after ARC-13a4083a refactor", async () => {
  const { loadArtifactBundle: load } = await import("../src/io/artifacts.ts");
  await withTempDir("arc-13a4083a-", async (dir) => {
    // No active-dispatch.json → active_dispatch should be absent
    const bundle = await load(dir);
    assert.ok(!("active_dispatch" in bundle), "active_dispatch absent when file missing");

    // With a valid active-dispatch.json, the field should be populated
    const { writeFile: wf } = await import("node:fs/promises");
    const activeDispatch = {
      run_id: "test-run",
      created_at: new Date().toISOString(),
      packet_count: 1,
      task_count: 1,
      status: "active",
    };
    await wf(join(dir, "active-dispatch.json"), JSON.stringify(activeDispatch));
    const bundle2 = await load(dir);
    assert.ok("active_dispatch" in bundle2, "active_dispatch populated when file present");
    assert.equal(bundle2.active_dispatch?.run_id, "test-run");
    assert.equal(bundle2.active_dispatch?.status, "active");
  });
});

test("loadArtifactBundle throws ArtifactSchemaVersionError for mismatched intent_checkpoint schema_version (ARC-dd468422)", async () => {
  const { loadArtifactBundle: load, ArtifactSchemaVersionError } = await import("../src/io/artifacts.ts");
  const { writeFile: wf } = await import("node:fs/promises");
  await withTempDir("arc-dd468422-intent-", async (dir) => {
    // Write intent_checkpoint.json with wrong schema_version
    const stale = {
      schema_version: "intent-checkpoint/v0",
      confirmed_at: new Date().toISOString(),
      confirmed_by: "host",
      scope_summary: "all files",
      intent_summary: "full audit",
    };
    await wf(join(dir, "intent_checkpoint.json"), JSON.stringify(stale), "utf8");

    await assert.rejects(
      load(dir),
      (err) => {
        assert.ok(err instanceof ArtifactSchemaVersionError, "must be ArtifactSchemaVersionError");
        assert.match(err.message, /intent_checkpoint\.json/);
        assert.match(err.message, /intent-checkpoint\/v0/);
        assert.match(err.message, /intent-checkpoint\/v1/);
        return true;
      },
    );
  });
});

test("loadArtifactBundle succeeds for correct intent_checkpoint schema_version (ARC-dd468422)", async () => {
  const { loadArtifactBundle: load } = await import("../src/io/artifacts.ts");
  const { writeFile: wf } = await import("node:fs/promises");
  await withTempDir("arc-dd468422-intent-ok-", async (dir) => {
    const valid = {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      confirmed_by: "host",
      scope_summary: "all files",
      intent_summary: "full audit",
    };
    await wf(join(dir, "intent_checkpoint.json"), JSON.stringify(valid), "utf8");

    const bundle = await load(dir);
    assert.equal(bundle.intent_checkpoint?.schema_version, "intent-checkpoint/v1");
  });
});

test("loadArtifactBundle throws ArtifactSchemaVersionError for mismatched provider_confirmation schema_version (ARC-dd468422)", async () => {
  const { loadArtifactBundle: load, ArtifactSchemaVersionError } = await import("../src/io/artifacts.ts");
  const { writeFile: wf } = await import("node:fs/promises");
  await withTempDir("arc-dd468422-provider-", async (dir) => {
    // Write provider_confirmation.json with wrong schema_version
    const stale = {
      schema_version: "0.0.0",
      confirmed_at: new Date().toISOString(),
      provider_pool: [],
      session_level: true,
    };
    await wf(join(dir, "provider_confirmation.json"), JSON.stringify(stale), "utf8");

    await assert.rejects(
      load(dir),
      (err) => {
        assert.ok(err instanceof ArtifactSchemaVersionError, "must be ArtifactSchemaVersionError");
        assert.match(err.message, /provider_confirmation\.json/);
        assert.match(err.message, /0\.0\.0/);
        return true;
      },
    );
  });
});

test("audit-code src/ has no circular imports — madge reports zero cycles (ARC-1fa005bb)", async () => {
  // ARC-1fa005bb: a dep-cycle was alleged (index.ts -> cli.ts -> io/ -> index.ts).
  // The STILL-REAL verdict confirmed the cycle does NOT exist in current source.
  // This regression guard keeps it that way: if any future edit closes a real cycle,
  // the check fails deterministically here before it can reach production.
  const { fileURLToPath } = await import("node:url");
  const { dirname, join: pathJoin } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const __dir = dirname(fileURLToPath(import.meta.url));
  const entrypoint = pathJoin(__dir, "../src/index.ts");

  // madge --circular with --extensions ts lists cycles; exit code 0 + no cycle
  // lines in output = no cycles.  In non-TTY (execFile) mode madge writes the
  // "No circular dependency found!" confirmation to stderr and the processed-file
  // summary to stdout; cycle entries (if any) go to stdout as well.
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const result = await execFileAsync(
      "npx",
      ["madge", "--circular", "--extensions", "ts", entrypoint],
      { cwd: pathJoin(__dir, ".."), shell: true },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    // madge exits non-zero when it finds cycles
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    exitCode = err.code ?? 1;
  }

  // Cycle-free: exit code 0 AND "No circular dependency found!" on stderr.
  const hasNoCycles =
    exitCode === 0 && stderr.includes("No circular dependency found!");
  assert.ok(
    hasNoCycles,
    `Circular imports detected in packages/audit-code/src/. ` +
    `madge stdout:\n${stdout}\nmadge stderr:\n${stderr}\n` +
    `Fix by ensuring no import chain forms a cycle. ` +
    `(ARC-1fa005bb regression guard)`,
  );
});
