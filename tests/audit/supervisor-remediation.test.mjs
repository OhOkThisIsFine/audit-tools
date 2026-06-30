import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { buildAuditCodeHandoff, writeAuditCodeHandoffArtifacts } = await import("../../src/audit/supervisor/operatorHandoff.ts");
const { loadRunLedger } = await import("../../src/audit/supervisor/runLedger.ts");
const { getSessionConfigPath, loadSessionConfig, persistAnalyzerSettings } = await import("../../src/audit/supervisor/sessionConfig.ts");

const { withTempDir } = await import("./helpers/withTempDir.mjs");

/**
 * Builds the artifact_paths object for writeAuditCodeHandoffArtifacts tests.
 * incomingDir defaults to `join(artifactsDir, "incoming")`.
 */
function makeHandoffArtifactPaths(artifactsDir, incomingDir) {
  const incoming = incomingDir ?? join(artifactsDir, "incoming");
  return {
    incoming_dir: incoming,
    operator_handoff_json: join(artifactsDir, "operator-handoff.json"),
    operator_handoff_markdown: join(artifactsDir, "operator-handoff.md"),
    session_config: join(artifactsDir, "session-config.json"),
    run_ledger: join(artifactsDir, "run-ledger.json"),
    current_task: join(artifactsDir, "dispatch", "current-task.json"),
    current_prompt: join(artifactsDir, "dispatch", "current-prompt.md"),
    current_tasks: join(artifactsDir, "dispatch", "current-tasks.json"),
    audit_tasks: null,
    runtime_validation_tasks: null,
  };
}

test("loadRunLedger rejects malformed ledger shapes instead of masking them", async () => {
  await withTempDir("audit-code-run-ledger-invalid-", async (artifactsDir) => {
    await writeFile(
      join(artifactsDir, "run-ledger.json"),
      JSON.stringify({ runs: {} }, null, 2),
      "utf8",
    );

    await assert.rejects(
      () => loadRunLedger(artifactsDir),
      /expected runs to be an array/i,
    );
  });
});

test("loadSessionConfig rejects invalid repo-local config with field details", async () => {
  await withTempDir("audit-code-session-config-invalid-", async (artifactsDir) => {
    const configPath = getSessionConfigPath(artifactsDir);
    await writeFile(
      configPath,
      JSON.stringify(
        {
          provider: "subprocess-template",
          subprocess_template: {
            command_template: [],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    await assert.rejects(async () => loadSessionConfig(artifactsDir), (error) => {
      assert.match(error.message, /Invalid .*session-config\.json:/i);
      assert.match(error.message, /command_template must not be empty/i);
      return true;
    });
  });
});

test("buildAuditCodeHandoff quotes suggested command paths and falls back to local-subprocess guidance", () => {
  const artifactsDir = join("tmp", "audit artifacts");
  const handoff = buildAuditCodeHandoff({
    root: "repo-root",
    artifactsDir,
    state: {
      status: "blocked",
      obligations: [{ id: "audit_tasks_completed", state: "blocked" }],
    },
    bundle: {},
    progressSummary: "manual review required",
  });

  assert.equal(handoff.suggested_inputs.length, 4);
  assert.equal(handoff.suggested_commands.length, 4);
  assert.ok(
    handoff.suggested_commands[0].startsWith('audit-code advance-audit --results "'),
  );
  assert.ok(handoff.suggested_commands[0].endsWith('audit-results.json"'));
  assert.ok(
    handoff.suggested_commands[1].startsWith(
      'audit-code advance-audit --batch-results "',
    ),
  );
  assert.ok(handoff.suggested_commands[1].endsWith('audit-results-batch"'));
  assert.match(
    handoff.interactive_provider_hint ?? "",
    /Provider: local-subprocess/i,
  );
  assert.match(
    handoff.interactive_provider_hint ?? "",
    /For automatic LLM review, configure an interactive provider/i,
  );
});

test("writeAuditCodeHandoffArtifacts wraps filesystem failures with handoff context", async () => {
  await withTempDir("audit-code-handoff-write-", async (artifactsDir) => {
    const incomingPath = join(artifactsDir, "incoming");
    await writeFile(incomingPath, "occupied", "utf8");

    await assert.rejects(
      () =>
        writeAuditCodeHandoffArtifacts({
          status: "blocked",
          repo_root: "repo-root",
          artifacts_dir: artifactsDir,
          provider: null,
          summary: "manual review required",
          pending_obligations: [],
          suggested_inputs: [],
          suggested_commands: [],
          interactive_provider_hint: null,
          artifact_paths: makeHandoffArtifactPaths(artifactsDir, incomingPath),
        }),
      /Failed to write operator handoff artifacts:/,
    );
  });
});

// OBS-3063e7e9: writeAuditCodeHandoffArtifacts should preserve the original error as cause
test("writeAuditCodeHandoffArtifacts preserves original error as cause when write fails", async () => {
  await withTempDir("audit-code-handoff-cause-", async (artifactsDir) => {
    // Block mkdir by placing a regular file at the incoming_dir path so that
    // mkdir(incomingPath, { recursive: true }) fails with ENOTDIR or EEXIST.
    const incomingPath = join(artifactsDir, "incoming");
    await writeFile(incomingPath, "occupied", "utf8");

    let caughtError;
    try {
      await writeAuditCodeHandoffArtifacts({
        status: "blocked",
        repo_root: "repo-root",
        artifacts_dir: artifactsDir,
        provider: null,
        summary: "manual review required",
        pending_obligations: [],
        suggested_inputs: [],
        suggested_commands: [],
        interactive_provider_hint: null,
        artifact_paths: makeHandoffArtifactPaths(artifactsDir, incomingPath),
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof Error, "should throw an Error");
    assert.match(caughtError.message, /Failed to write operator handoff artifacts:/);
    assert.ok(
      caughtError.cause instanceof Error,
      "thrown error should have a .cause that is the original Error",
    );
    // The original error's code (ENOTDIR / EEXIST) should be accessible via cause
    assert.ok(
      typeof (caughtError.cause).code === "string",
      "cause should carry the original error code",
    );
  });
});

test("buildAuditCodeHandoff points active review runs at next-step", () => {
  const artifactsDir = join("tmp", "audit artifacts");
  const handoff = buildAuditCodeHandoff({
    root: "repo-root",
    artifactsDir,
    state: {
      status: "blocked",
      obligations: [{ id: "audit_tasks_completed", state: "blocked" }],
    },
    bundle: {},
    progressSummary: "manual review required",
    activeReviewRun: {
      run_id: "run-7",
      task_path: join(artifactsDir, "runs", "run-7", "task.json"),
      prompt_path: join(artifactsDir, "runs", "run-7", "prompt.md"),
      pending_audit_tasks_path: join(
        artifactsDir,
        "runs",
        "run-7",
        "pending-audit-tasks.json",
      ),
      audit_results_path: join(artifactsDir, "runs", "run-7", "run-results.json"),
      worker_command: ["node", "dist/index.js", "worker-run", "--task", "task.json"],
    },
  });

  assert.equal(handoff.suggested_inputs.length, 0);
  assert.equal(handoff.suggested_commands.length, 1);
  assert.match(handoff.suggested_commands[0], /next-step/);
  assert.doesNotMatch(handoff.suggested_commands[0], /prepare-dispatch/);
  assert.doesNotMatch(handoff.suggested_commands[0], /worker-run/);
  assert.match(handoff.quick_start ?? "", /next-step/);
  assert.doesNotMatch(handoff.quick_start ?? "", /prepare-dispatch/);
  // file_map advertises only artifacts that exist at handoff time or are stable
  // output destinations. next-step outputs (the dispatch plan and single-task
  // fallback prompt) are intentionally absent so a host does not eager-read a
  // not-yet-generated path and wrongly fall back to manual single-task review.
  assert.equal(handoff.file_map?.single_task, undefined);
  assert.equal(handoff.file_map?.single_task_prompt, undefined);
  assert.equal(handoff.file_map?.dispatch_plan, undefined);
  assert.equal(
    handoff.file_map?.current_task,
    join(artifactsDir, "dispatch", "current-task.json"),
  );
  assert.equal(
    handoff.file_map?.audit_results,
    join(artifactsDir, "runs", "run-7", "run-results.json"),
  );
  // The report lives in the artifacts dir until completion promotes it to the
  // repo root (which also removes the artifacts dir). A blocked-for-review
  // handoff happens before that, so final_report must advertise the artifacts
  // location that actually exists mid-run — not the not-yet-created root path.
  assert.equal(
    handoff.file_map?.final_report,
    join(artifactsDir, "audit-report.md"),
  );
  assert.equal(handoff.active_review_run?.run_id, "run-7");
});

test("buildAuditCodeHandoff suppresses evidence inputs and shows config-repair hint when isConfigError is true", () => {
  const artifactsDir = join("tmp", "audit artifacts");
  const handoff = buildAuditCodeHandoff({
    root: "repo-root",
    artifactsDir,
    state: {
      status: "blocked",
      obligations: [{ id: "repo_manifest", state: "missing" }],
    },
    bundle: {},
    progressSummary: "configuration error",
    isConfigError: true,
  });

  assert.equal(handoff.suggested_inputs.length, 0);
  assert.equal(handoff.suggested_commands.length, 0);
  assert.match(
    handoff.interactive_provider_hint ?? "",
    /Configuration error/i,
  );
  assert.match(
    handoff.interactive_provider_hint ?? "",
    /repository root/i,
  );
  assert.doesNotMatch(
    handoff.interactive_provider_hint ?? "",
    /For automatic LLM review/i,
  );
});

test("writeAuditCodeHandoffArtifacts prepares the batch-results inbox alongside the incoming directory", async () => {
  await withTempDir("audit-code-handoff-batch-dir-", async (artifactsDir) => {
    const incomingPath = join(artifactsDir, "incoming");
    const batchPath = join(incomingPath, "audit-results-batch");
    const handoff = buildAuditCodeHandoff({
      root: "repo-root",
      artifactsDir,
      state: {
        status: "blocked",
        obligations: [{ id: "audit_tasks_completed", state: "blocked" }],
      },
      bundle: {},
      progressSummary: "manual review required",
    });

    await writeAuditCodeHandoffArtifacts(handoff);

    const persisted = JSON.parse(
      await readFile(join(artifactsDir, "operator-handoff.json"), "utf8"),
    );
    assert.equal(persisted.status, "blocked");
    await access(batchPath);
    assert.match(
      await readFile(join(artifactsDir, "operator-handoff.md"), "utf8"),
      /audit-code advance-audit --batch-results/i,
    );
  });
});

// ── persistAnalyzerSettings ──────────────────────────────────────────────────

test("persistAnalyzerSettings writes DEFAULT_SESSION_CONFIG + settings when no config file exists", async () => {
  await withTempDir("audit-code-persist-analyzer-new-", async (artifactsDir) => {
    const result = await persistAnalyzerSettings(artifactsDir, { semgrep: "permanent" });

    assert.equal(result.provider, "local-subprocess");
    assert.deepEqual(result.analyzers, { semgrep: "permanent" });

    const persisted = JSON.parse(
      await readFile(getSessionConfigPath(artifactsDir), "utf8"),
    );
    assert.deepEqual(persisted, result);
  });
});

test("persistAnalyzerSettings merges settings into an existing valid config, preserving all prior fields", async () => {
  await withTempDir("audit-code-persist-analyzer-merge-", async (artifactsDir) => {
    const configPath = getSessionConfigPath(artifactsDir);
    await writeFile(
      configPath,
      JSON.stringify({ provider: "codex", analyzers: { eslint: "ephemeral" } }, null, 2) + "\n",
      "utf8",
    );

    const result = await persistAnalyzerSettings(artifactsDir, { semgrep: "permanent" });

    assert.equal(result.provider, "codex");
    assert.equal(result.analyzers?.eslint, "ephemeral");
    assert.equal(result.analyzers?.semgrep, "permanent");

    const persisted = JSON.parse(
      await readFile(configPath, "utf8"),
    );
    assert.deepEqual(persisted, result);
  });
});

test("persistAnalyzerSettings falls back to DEFAULT_SESSION_CONFIG when persisted value is not a record", async () => {
  await withTempDir("audit-code-persist-analyzer-nonrecord-", async (artifactsDir) => {
    const configPath = getSessionConfigPath(artifactsDir);
    await writeFile(configPath, JSON.stringify([1, 2, 3], null, 2) + "\n", "utf8");

    const result = await persistAnalyzerSettings(artifactsDir, { eslint: "skip" });

    assert.equal(result.provider, "local-subprocess");
    assert.deepEqual(result.analyzers, { eslint: "skip" });

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(Array.isArray(persisted), false);
    assert.deepEqual(persisted, result);
  });
});

test("persistAnalyzerSettings merges into existing analyzers map without clobbering unrelated keys", async () => {
  await withTempDir("audit-code-persist-analyzer-partial-", async (artifactsDir) => {
    const configPath = getSessionConfigPath(artifactsDir);
    await writeFile(
      configPath,
      JSON.stringify(
        { provider: "claude-code", analyzers: { eslint: "ephemeral", semgrep: "skip" } },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const result = await persistAnalyzerSettings(artifactsDir, { semgrep: "permanent", npm_audit: "ephemeral" });

    assert.equal(result.analyzers?.eslint, "ephemeral");
    assert.equal(result.analyzers?.semgrep, "permanent");
    assert.equal(result.analyzers?.npm_audit, "ephemeral");

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(persisted, result);
  });
});

test("persistAnalyzerSettings throws a validation error naming the config path when the merged result is invalid", async () => {
  await withTempDir("audit-code-persist-analyzer-invalid-", async (artifactsDir) => {
    const configPath = getSessionConfigPath(artifactsDir);
    await writeFile(
      configPath,
      JSON.stringify(
        {
          provider: "subprocess-template",
          subprocess_template: { command_template: [] },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    await assert.rejects(
      () => persistAnalyzerSettings(artifactsDir, { eslint: "ephemeral" }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Invalid .*session-config\.json:/i);
        return true;
      },
    );
  });
});
