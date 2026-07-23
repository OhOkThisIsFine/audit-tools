import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { buildAuditCodeHandoff, writeAuditCodeHandoffArtifacts } = await import("../../src/audit/supervisor/operatorHandoff.ts");
const { loadRunLedger } = await import("../../src/audit/supervisor/runLedger.ts");
const { getSessionConfigPath, loadSessionConfig, persistAnalyzerSettings } = await import("../../src/audit/supervisor/sessionConfig.ts");
const { frictionCapturePath } = await import("../../src/shared/io/frictionCapture.ts");

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
    friction_record: frictionCapturePath(artifactsDir, "run"),
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
      expect(error.message).toMatch(/Invalid .*session-config\.json:/i);
      expect(error.message).toMatch(/command_template must not be empty/i);
      return true;
    });
  });
});

test("buildAuditCodeHandoff quotes suggested command paths and falls back to worker-command guidance", () => {
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

  expect(handoff.suggested_inputs.length).toBe(4);
  expect(handoff.suggested_commands.length).toBe(4);
  expect(handoff.suggested_commands[0].startsWith('audit-code advance-audit --results "')).toBeTruthy();
  expect(handoff.suggested_commands[0].endsWith('audit-results.json"')).toBeTruthy();
  expect(handoff.suggested_commands[1].startsWith(
      'audit-code advance-audit --batch-results "',
    )).toBeTruthy();
  expect(handoff.suggested_commands[1].endsWith('audit-results-batch"')).toBeTruthy();
  expect(handoff.interactive_provider_hint ?? "").toMatch(/Provider: worker-command/i);
  expect(handoff.interactive_provider_hint ?? "").toMatch(/For automatic LLM review, configure an interactive provider/i);
});

// operatorHandoff's suggested/quick_start commands now render via the shared
// renderPromptCommand (audit-tools/shared) instead of a local hand-rolled
// quoteShellPath/renderShellCommand pair that only escaped whitespace/quotes.
// An artifacts dir containing a shell metacharacter must come out quoted, not
// passed through raw.
test("buildAuditCodeHandoff quotes suggested/quick_start commands for artifact paths containing shell metacharacters", () => {
  // A literal (not path.join-built) absolute Windows-style path so the
  // renderPromptCommand path-token normalization is deterministic across
  // whatever OS runs this suite (it is plain string manipulation, not a real
  // filesystem path).
  const artifactsDir = "C:\\repo\\tmp\\audit & artifacts";
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
      run_id: "run-9",
      task_path: join(artifactsDir, "runs", "run-9", "task.json"),
      prompt_path: join(artifactsDir, "runs", "run-9", "prompt.md"),
      audit_results_path: join(artifactsDir, "runs", "run-9", "run-results.json"),
      worker_command: ["node", "dist/index.js", "worker-run"],
    },
  });

  expect(handoff.suggested_commands.length).toBe(1);
  expect(handoff.suggested_commands[0]).toContain(
    `"${artifactsDir.replace(/\\/g, "/")}"`,
  );
  expect(handoff.quick_start ?? "").toContain(
    `"${artifactsDir.replace(/\\/g, "/")}"`,
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

    expect(caughtError instanceof Error, "should throw an Error").toBeTruthy();
    expect(caughtError.message).toMatch(/Failed to write operator handoff artifacts:/);
    expect(caughtError.cause instanceof Error, "thrown error should have a .cause that is the original Error").toBeTruthy();
    // The original error's code (ENOTDIR / EEXIST) should be accessible via cause
    expect(typeof (caughtError.cause).code === "string", "cause should carry the original error code").toBeTruthy();
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

  expect(handoff.suggested_inputs.length).toBe(0);
  expect(handoff.suggested_commands.length).toBe(1);
  expect(handoff.suggested_commands[0]).toMatch(/next-step/);
  expect(handoff.suggested_commands[0]).not.toMatch(/prepare-dispatch/);
  expect(handoff.suggested_commands[0]).not.toMatch(/worker-run/);
  expect(handoff.quick_start ?? "").toMatch(/next-step/);
  expect(handoff.quick_start ?? "").not.toMatch(/prepare-dispatch/);
  // file_map advertises only artifacts that exist at handoff time or are stable
  // output destinations. next-step outputs (the dispatch plan and single-task
  // fallback prompt) are intentionally absent so a host does not eager-read a
  // not-yet-generated path and wrongly fall back to manual single-task review.
  expect(handoff.file_map?.single_task).toBe(undefined);
  expect(handoff.file_map?.single_task_prompt).toBe(undefined);
  expect(handoff.file_map?.dispatch_plan).toBe(undefined);
  expect(handoff.file_map?.current_task).toBe(join(artifactsDir, "dispatch", "current-task.json"));
  expect(handoff.file_map?.audit_results).toBe(join(artifactsDir, "runs", "run-7", "run-results.json"));
  // The report lives in the artifacts dir until completion promotes it to the
  // repo root (which also removes the artifacts dir). A blocked-for-review
  // handoff happens before that, so final_report must advertise the artifacts
  // location that actually exists mid-run — not the not-yet-created root path.
  expect(handoff.file_map?.final_report).toBe(join(artifactsDir, "audit-report.md"));
  expect(handoff.active_review_run?.run_id).toBe("run-7");
});

// ── CP-NODE-8 / COR-b019d3b9 pinning tests: blocked-status rendering and
// artifact-path invariants of buildAuditCodeHandoff. The blocked branch is
// live at HEAD (buildBlockedAuditState in envelope.ts feeds this consumer via
// the review-run path); these pin the consumer contract so it cannot regress.

test("blocked handoff renders the dispatch path trio and pending obligations in obligation order", () => {
  const artifactsDir = join("tmp", "audit artifacts");
  const handoff = buildAuditCodeHandoff({
    root: "repo-root",
    artifactsDir,
    state: {
      status: "blocked",
      obligations: [
        { id: "provider_confirmation", state: "present" },
        { id: "repo_manifest", state: "satisfied" },
        { id: "module_graph", state: "stale" },
        { id: "audit_tasks_completed", state: "blocked" },
        { id: "audit_results_ingested", state: "missing" },
      ],
    },
    bundle: {},
    progressSummary: "manual review required",
  });

  // POSITIVE: current_task/current_prompt/current_tasks are non-null exactly
  // when status is blocked.
  expect(handoff.artifact_paths.current_task).toBe(
    join(artifactsDir, "dispatch", "current-task.json"),
  );
  expect(handoff.artifact_paths.current_prompt).toBe(
    join(artifactsDir, "dispatch", "current-prompt.md"),
  );
  expect(handoff.artifact_paths.current_tasks).toBe(
    join(artifactsDir, "dispatch", "current-tasks.json"),
  );
  // pending_obligations is exactly the ids outside {present, satisfied}, in
  // state.obligations order (deterministic, content-derived).
  expect(handoff.pending_obligations).toEqual([
    "module_graph",
    "audit_tasks_completed",
    "audit_results_ingested",
  ]);
});

test("non-blocked statuses keep dispatch paths null and emit no blocked-mode outputs", () => {
  const artifactsDir = join("tmp", "audit artifacts");
  for (const status of ["not_started", "active", "complete"]) {
    // activeReviewRun is included deliberately: the file_map non-null
    // assertions on the dispatch trio must never fire off-blocked, even when a
    // review run is present.
    const handoff = buildAuditCodeHandoff({
      root: "repo-root",
      artifactsDir,
      state: {
        status,
        obligations: [{ id: "synthesis_current", state: "missing" }],
      },
      bundle: {},
      progressSummary: "in progress",
      activeReviewRun: {
        run_id: "run-3",
        task_path: join(artifactsDir, "runs", "run-3", "task.json"),
        prompt_path: join(artifactsDir, "runs", "run-3", "prompt.md"),
        audit_results_path: join(artifactsDir, "runs", "run-3", "run-results.json"),
        worker_command: ["node", "worker.js"],
      },
    });

    expect(handoff.artifact_paths.current_task).toBe(null);
    expect(handoff.artifact_paths.current_prompt).toBe(null);
    expect(handoff.artifact_paths.current_tasks).toBe(null);
    expect(handoff.suggested_inputs).toEqual([]);
    expect(handoff.suggested_commands).toEqual([]);
    expect(handoff.quick_start).toBe(undefined);
    expect(handoff.file_map).toBe(undefined);
  }
});

test("friction_record is single-sourced from frictionCapturePath for default and explicit run ids", () => {
  const artifactsDir = join("tmp", "audit artifacts");
  const state = {
    status: "blocked",
    obligations: [{ id: "audit_tasks_completed", state: "blocked" }],
  };

  const withDefault = buildAuditCodeHandoff({
    root: "repo-root",
    artifactsDir,
    state,
    bundle: {},
    progressSummary: "manual review required",
  });
  expect(withDefault.artifact_paths.friction_record).toBe(
    frictionCapturePath(artifactsDir, "run"),
  );

  const withRunId = buildAuditCodeHandoff({
    root: "repo-root",
    artifactsDir,
    state,
    bundle: {},
    progressSummary: "manual review required",
    runId: "run 42/x",
  });
  expect(withRunId.artifact_paths.friction_record).toBe(
    frictionCapturePath(artifactsDir, "run 42/x"),
  );
});

test("operator-handoff.json and .md serialize the same in-memory handoff and the markdown renders every artifact path", async () => {
  await withTempDir("audit-code-handoff-same-value-", async (artifactsDir) => {
    const handoff = buildAuditCodeHandoff({
      root: "repo-root",
      artifactsDir,
      state: {
        status: "blocked",
        obligations: [{ id: "audit_tasks_completed", state: "blocked" }],
      },
      // Truthy audit_tasks / runtime_validation_tasks so every artifact_paths
      // field is non-null and must therefore appear in the markdown render.
      bundle: {
        audit_tasks: [{ task_id: "T1" }],
        runtime_validation_tasks: { tasks: [] },
      },
      progressSummary: "manual review required",
      runId: "run-13",
      activeReviewRun: {
        run_id: "run-13",
        task_path: join(artifactsDir, "runs", "run-13", "task.json"),
        prompt_path: join(artifactsDir, "runs", "run-13", "prompt.md"),
        audit_results_path: join(artifactsDir, "runs", "run-13", "run-results.json"),
        worker_command: ["node", "worker.js"],
      },
    });

    await writeAuditCodeHandoffArtifacts(handoff);

    const persisted = JSON.parse(
      await readFile(join(artifactsDir, "operator-handoff.json"), "utf8"),
    );
    const markdown = await readFile(
      join(artifactsDir, "operator-handoff.md"), "utf8",
    );

    // Both artifacts come from the SAME in-memory handoff value — the JSON is
    // a straight serialization, never a divergent re-derivation.
    expect(persisted.artifact_paths).toEqual(handoff.artifact_paths);
    expect(persisted.file_map).toEqual(handoff.file_map);
    expect(persisted.pending_obligations).toEqual(handoff.pending_obligations);

    // Runtime complement of the compile-time registry drift guard: the
    // markdown renders every artifact_paths field of the model.
    for (const value of Object.values(handoff.artifact_paths)) {
      expect(markdown).toContain(value);
    }

    // The advertised deliverable is the mid-run artifacts-dir location, never
    // the repo-root render that only exists after completion promotes it.
    expect(handoff.file_map?.final_report).toBe(
      join(artifactsDir, "audit-report.md"),
    );
    const repoRootReport = join("repo-root", "audit-report.md");
    for (const value of Object.values(persisted.file_map)) {
      expect(value).not.toBe(repoRootReport);
    }
    expect(markdown).not.toContain(repoRootReport);
  });
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

  expect(handoff.suggested_inputs.length).toBe(0);
  expect(handoff.suggested_commands.length).toBe(0);
  expect(handoff.interactive_provider_hint ?? "").toMatch(/Configuration error/i);
  expect(handoff.interactive_provider_hint ?? "").toMatch(/repository root/i);
  expect(handoff.interactive_provider_hint ?? "").not.toMatch(/For automatic LLM review/i);
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
    expect(persisted.status).toBe("blocked");
    await access(batchPath);
    expect(await readFile(join(artifactsDir, "operator-handoff.md"), "utf8")).toMatch(/audit-code advance-audit --batch-results/i);
  });
});

// ── persistAnalyzerSettings ──────────────────────────────────────────────────

test("persistAnalyzerSettings writes DEFAULT_SESSION_CONFIG + settings when no config file exists", async () => {
  await withTempDir("audit-code-persist-analyzer-new-", async (artifactsDir) => {
    const result = await persistAnalyzerSettings(artifactsDir, { semgrep: "permanent" });

    expect(result.analyzers).toEqual({ semgrep: "permanent" });

    const persisted = JSON.parse(
      await readFile(getSessionConfigPath(artifactsDir), "utf8"),
    );
    expect(persisted).toEqual(result);
  });
});

test("persistAnalyzerSettings merges settings into an existing valid config, preserving all prior fields", async () => {
  await withTempDir("audit-code-persist-analyzer-merge-", async (artifactsDir) => {
    const configPath = getSessionConfigPath(artifactsDir);
    await writeFile(
      configPath,
      JSON.stringify({ timeout_ms: 60000, analyzers: { eslint: "ephemeral" } }, null, 2) + "\n",
      "utf8",
    );

    const result = await persistAnalyzerSettings(artifactsDir, { semgrep: "permanent" });

    expect(result.timeout_ms).toBe(60000);
    expect(result.analyzers?.eslint).toBe("ephemeral");
    expect(result.analyzers?.semgrep).toBe("permanent");

    const persisted = JSON.parse(
      await readFile(configPath, "utf8"),
    );
    expect(persisted).toEqual(result);
  });
});

test("persistAnalyzerSettings falls back to DEFAULT_SESSION_CONFIG when persisted value is not a record", async () => {
  await withTempDir("audit-code-persist-analyzer-nonrecord-", async (artifactsDir) => {
    const configPath = getSessionConfigPath(artifactsDir);
    await writeFile(configPath, JSON.stringify([1, 2, 3], null, 2) + "\n", "utf8");

    const result = await persistAnalyzerSettings(artifactsDir, { eslint: "skip" });

    expect(result.analyzers).toEqual({ eslint: "skip" });

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    expect(Array.isArray(persisted)).toBe(false);
    expect(persisted).toEqual(result);
  });
});

test("persistAnalyzerSettings merges into existing analyzers map without clobbering unrelated keys", async () => {
  await withTempDir("audit-code-persist-analyzer-partial-", async (artifactsDir) => {
    const configPath = getSessionConfigPath(artifactsDir);
    await writeFile(
      configPath,
      JSON.stringify(
        { timeout_ms: 30000, analyzers: { eslint: "ephemeral", semgrep: "skip" } },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const result = await persistAnalyzerSettings(artifactsDir, { semgrep: "permanent", npm_audit: "ephemeral" });

    expect(result.analyzers?.eslint).toBe("ephemeral");
    expect(result.analyzers?.semgrep).toBe("permanent");
    expect(result.analyzers?.npm_audit).toBe("ephemeral");

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    expect(persisted).toEqual(result);
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
        expect(error instanceof Error).toBeTruthy();
        expect(error.message).toMatch(/Invalid .*session-config\.json:/i);
        return true;
      },
    );
  });
});

// ── RMW lock: concurrent persists must not lose any writer's key ──────────────
// (G2 retired `persistHostProvider` — the provider now rides the --auditor descriptor,
// never a disk write — so the concurrent-different-fields RMW property is covered by the
// many-writers analyzer test below, which exercises the same shared file lock.)

test("many concurrent persistAnalyzerSettings writers each land their own key (no lost update)", async () => {
  await withTempDir("audit-code-session-config-rmw-lock-many-", async (artifactsDir) => {
    const configPath = getSessionConfigPath(artifactsDir);
    const ids = ["semgrep", "eslint", "npm_audit"];

    await Promise.all(
      ids.map((id) => persistAnalyzerSettings(artifactsDir, { [id]: "permanent" })),
    );

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    for (const id of ids) {
      expect(persisted.analyzers?.[id]).toBe("permanent");
    }
  });
});
