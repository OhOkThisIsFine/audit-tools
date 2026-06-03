import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildAuditCodeHandoff, writeAuditCodeHandoffArtifacts } = await import(
  "../src/supervisor/operatorHandoff.ts"
);
const { appendRunLedgerEntry, loadRunLedger } = await import(
  "../src/supervisor/runLedger.ts"
);
const { getSessionConfigPath, loadSessionConfig } = await import(
  "../src/supervisor/sessionConfig.ts"
);

async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildRunLedgerEntry(runId) {
  return {
    run_id: runId,
    provider: "local-subprocess",
    obligation_id: "audit_tasks_completed",
    selected_executor: "agent",
    status: "blocked",
    started_at: "2026-04-22T12:00:00Z",
    ended_at: "2026-04-22T12:01:00Z",
    result_path: join("results", `${runId}.json`),
  };
}

test("appendRunLedgerEntry keeps concurrent writes without losing runs", async () => {
  await withTempDir("audit-code-run-ledger-", async (artifactsDir) => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      buildRunLedgerEntry(`run-${index}`),
    );

    await Promise.all(
      entries.map((entry) => appendRunLedgerEntry(artifactsDir, entry)),
    );

    const ledger = await loadRunLedger(artifactsDir);
    assert.equal(ledger.runs.length, entries.length);
    assert.deepEqual(
      [...new Set(ledger.runs.map((entry) => entry.run_id))].sort(),
      entries.map((entry) => entry.run_id).sort(),
    );

    const persisted = JSON.parse(
      await readFile(join(artifactsDir, "run-ledger.json"), "utf8"),
    );
    assert.equal(Array.isArray(persisted.runs), true);
    assert.equal(persisted.runs.length, entries.length);
  });
});

test("appendRunLedgerEntry preserves insertion order for sequential writes", async () => {
  await withTempDir("audit-code-run-ledger-order-", async (artifactsDir) => {
    const orderedRunIds = ["run-1", "run-2", "run-3"];
    for (const runId of orderedRunIds) {
      await appendRunLedgerEntry(artifactsDir, buildRunLedgerEntry(runId));
    }

    const ledger = await loadRunLedger(artifactsDir);
    assert.deepEqual(
      ledger.runs.map((entry) => entry.run_id),
      orderedRunIds,
    );
  });
});

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
  assert.ok(handoff.suggested_commands[0].startsWith('audit-code --results "'));
  assert.ok(handoff.suggested_commands[0].endsWith('audit-results.json"'));
  assert.ok(handoff.suggested_commands[1].startsWith('audit-code --batch-results "'));
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
          artifact_paths: {
            incoming_dir: incomingPath,
            operator_handoff_json: join(artifactsDir, "operator-handoff.json"),
            operator_handoff_markdown: join(artifactsDir, "operator-handoff.md"),
            session_config: join(artifactsDir, "session-config.json"),
            run_ledger: join(artifactsDir, "run-ledger.json"),
            current_task: join(artifactsDir, "dispatch", "current-task.json"),
            current_prompt: join(artifactsDir, "dispatch", "current-prompt.md"),
            current_tasks: join(artifactsDir, "dispatch", "current-tasks.json"),
            audit_tasks: null,
            runtime_validation_tasks: null,
          },
        }),
      /Failed to write operator handoff artifacts:/,
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
      audit_results_path: join(artifactsDir, "runs", "run-7", "audit-results.json"),
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
    join(artifactsDir, "runs", "run-7", "audit-results.json"),
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
      /audit-code --batch-results/i,
    );
  });
});
