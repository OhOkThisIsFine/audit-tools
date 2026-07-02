import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const {
  activeReviewRunFromTask,
  loadCurrentActiveReviewRun,
  ensureSemanticReviewRun,
  writeHandoffOnly,
  persistConfigErrorHandoff,
} = await import("../../src/audit/cli/reviewRun.ts");

async function withTempArtifacts(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "review-run-lifecycle-"));
  const artifactsDir = join(tempDir, ".audit-tools/audit");
  const root = join(tempDir, "repo");
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(root, { recursive: true });
  try {
    return await fn({ artifactsDir, root });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// A valid agent WorkerTask — the shape activeReviewRunFromTask treats as an
// active review run.
function agentTask(artifactsDir, root, runId = "RUN-1") {
  return {
    contract_version: "audit-code-worker/v1alpha1",
    run_id: runId,
    repo_root: root,
    artifacts_dir: artifactsDir,
    obligation_id: "audit_tasks_completed",
    preferred_executor: "agent",
    result_path: join(artifactsDir, "runs", runId, "result.json"),
    worker_command: ["node", "cli.js", "worker-run", "--task", "task.json"],
    audit_results_path: join(artifactsDir, "runs", runId, "run-results.json"),
    pending_audit_tasks_path: join(
      artifactsDir,
      "runs",
      runId,
      "pending-audit-tasks.json",
    ),
  };
}

function minimalState(status = "active") {
  return { status, obligations: [] };
}

async function readHandoff(artifactsDir) {
  return JSON.parse(
    await readFile(join(artifactsDir, "operator-handoff.json"), "utf8"),
  );
}

// ── activeReviewRunFromTask ──────────────────────────────────────────────────

test("activeReviewRunFromTask returns null for a non-agent task", async () => {
  await withTempArtifacts(({ artifactsDir, root }) => {
    const task = { ...agentTask(artifactsDir, root), preferred_executor: "inline" };
    expect(activeReviewRunFromTask(artifactsDir, task)).toBe(null);

    const noResults = { ...agentTask(artifactsDir, root) };
    delete noResults.audit_results_path;
    expect(activeReviewRunFromTask(artifactsDir, noResults)).toBe(null);
  });
});

test("activeReviewRunFromTask returns an ActiveReviewRun for a valid agent task", async () => {
  await withTempArtifacts(({ artifactsDir, root }) => {
    const task = agentTask(artifactsDir, root);
    const run = activeReviewRunFromTask(artifactsDir, task);
    expect(run).toBeTruthy();
    expect(run.run_id).toBe(task.run_id);
    expect(run.audit_results_path).toBe(task.audit_results_path);
    expect(run.pending_audit_tasks_path).toBe(task.pending_audit_tasks_path);
    expect(run.worker_command).toEqual(task.worker_command);
  });
});

// ── loadCurrentActiveReviewRun ───────────────────────────────────────────────

test("loadCurrentActiveReviewRun returns null when current-task.json is absent", async () => {
  await withTempArtifacts(async ({ artifactsDir }) => {
    expect(await loadCurrentActiveReviewRun(artifactsDir)).toBe(null);
  });
});

test("loadCurrentActiveReviewRun returns an ActiveReviewRun for a valid agent task", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    const task = agentTask(artifactsDir, root);
    await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
    await writeFile(
      join(artifactsDir, "dispatch", "current-task.json"),
      JSON.stringify(task, null, 2),
    );
    const run = await loadCurrentActiveReviewRun(artifactsDir);
    expect(run).toBeTruthy();
    expect(run.run_id).toBe(task.run_id);
  });
});

test("loadCurrentActiveReviewRun propagates unexpected (non-missing) errors", async () => {
  await withTempArtifacts(async ({ artifactsDir }) => {
    await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
    // Invalid JSON is a parse error, not a missing-file error → must throw.
    await writeFile(
      join(artifactsDir, "dispatch", "current-task.json"),
      "{not-json\n",
    );
    await assert.rejects(loadCurrentActiveReviewRun(artifactsDir));
  });
});

// ── writeHandoffOnly ─────────────────────────────────────────────────────────

test("writeHandoffOnly writes a blocked operator-handoff.json to artifactsDir", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    await writeHandoffOnly({
      root,
      artifactsDir,
      bundle: {},
      audit_state: minimalState("blocked"),
      progress_summary: "review handoff summary",
    });
    const handoff = await readHandoff(artifactsDir);
    expect(handoff.status).toBe("blocked");
  });
});

// ── ensureSemanticReviewRun ──────────────────────────────────────────────────

test("ensureSemanticReviewRun new-run branch writes an agent task and returns a fresh ActiveReviewRun", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    // No current-task.json present → the function creates a new review run.
    const result = await ensureSemanticReviewRun({
      root,
      artifactsDir,
      bundle: { audit_state: minimalState("active") },
      state: minimalState("active"),
      obligationId: "audit_tasks_completed",
      selfCliPath: join(repoRoot, "dist", "index.js"),
      timeoutMs: 60_000,
    });

    expect(result.activeReviewRun).toBeTruthy();
    expect(result.activeReviewRun.run_id.length > 0).toBeTruthy();
    expect(result.state.status).toBe("blocked");

    const currentTask = JSON.parse(
      await readFile(
        join(artifactsDir, "dispatch", "current-task.json"),
        "utf8",
      ),
    );
    expect(currentTask.preferred_executor).toBe("agent");
  });
});

test("ensureSemanticReviewRun new-run: access.read_paths is non-empty and contains all pending task file paths", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    const pendingAuditTasks = [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass-1",
        lens: "correctness",
        file_paths: ["src/index.ts", "src/utils.ts"],
        file_line_counts: { "src/index.ts": 50, "src/utils.ts": 30 },
        rationale: "fixture task 1",
      },
      {
        task_id: "task-2",
        unit_id: "unit-2",
        pass_id: "pass-2",
        lens: "security",
        file_paths: ["src/auth.ts"],
        file_line_counts: { "src/auth.ts": 80 },
        rationale: "fixture task 2",
      },
    ];

    // No current-task.json present → the function creates a new review run.
    await ensureSemanticReviewRun({
      root,
      artifactsDir,
      bundle: {
        audit_state: minimalState("active"),
        audit_tasks: pendingAuditTasks,
      },
      state: minimalState("active"),
      obligationId: "audit_tasks_completed",
      selfCliPath: join(repoRoot, "dist", "index.js"),
      timeoutMs: 60_000,
    });

    const currentTask = JSON.parse(
      await readFile(
        join(artifactsDir, "dispatch", "current-task.json"),
        "utf8",
      ),
    );

    // access.read_paths must be populated
    expect(Array.isArray(currentTask.access?.read_paths), "access.read_paths is an Array").toBeTruthy();
    expect(currentTask.access.read_paths.length > 0, "access.read_paths is non-empty").toBeTruthy();

    // Every file_paths entry from the pending tasks must appear in read_paths
    const expectedPaths = pendingAuditTasks.flatMap((t) => t.file_paths);
    for (const expectedPath of expectedPaths) {
      expect(currentTask.access.read_paths.includes(expectedPath), `access.read_paths contains expected path: ${expectedPath}`).toBeTruthy();
    }
  });
});

test("ensureSemanticReviewRun existing-run branch reuses the run without creating a new runId", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    const seeded = agentTask(artifactsDir, root, "SEEDED-RUN");
    await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
    await writeFile(
      join(artifactsDir, "dispatch", "current-task.json"),
      JSON.stringify(seeded, null, 2),
    );

    const result = await ensureSemanticReviewRun({
      root,
      artifactsDir,
      bundle: { audit_state: minimalState("active") },
      state: minimalState("active"),
      obligationId: "audit_tasks_completed",
      selfCliPath: join(repoRoot, "dist", "index.js"),
      timeoutMs: 60_000,
    });

    // The pre-seeded run is reused, so no new runId is minted.
    expect(result.activeReviewRun.run_id).toBe("SEEDED-RUN");
    expect(result.state.status).toBe("blocked");
  });
});

// ── persistConfigErrorHandoff ────────────────────────────────────────────────

test("persistConfigErrorHandoff writes a blocked handoff carrying the progress summary", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    // Pre-write a minimal artifact bundle so loadArtifactBundle has something
    // to read; deriveAuditState backfills the rest.
    await writeFile(
      join(artifactsDir, "repo_manifest.json"),
      JSON.stringify({ root: "sample", files: [] }, null, 2),
    );
    await writeFile(
      join(artifactsDir, "file_disposition.json"),
      JSON.stringify({ files: [] }, null, 2),
    );

    const summary = "config-error: --root does not point at an auditable tree";
    await persistConfigErrorHandoff({
      root,
      artifactsDir,
      progressSummary: summary,
    });

    const handoff = await readHandoff(artifactsDir);
    expect(handoff.status).toBe("blocked");
    expect(handoff.summary).toBe(summary);
  });
});
