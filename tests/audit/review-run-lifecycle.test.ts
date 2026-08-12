import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import {
  getRunPaths,
  writeReviewRunFiles,
} from "../../src/audit/io/runArtifacts.js";
import {
  CURRENT_TASK_FILENAME,
  CURRENT_TASKS_FILENAME,
  type ActiveReviewRun,
} from "../../src/audit/supervisor/operatorHandoff.js";
import type { AuditState } from "../../src/audit/types/auditState.js";
import type { AuditTask } from "../../src/audit/types.js";

const {
  loadCurrentActiveReviewRun,
  materializeReviewRun,
  ensureSemanticReviewRun,
  writeHandoffOnly,
  persistConfigErrorHandoff,
} = await import("../../src/audit/cli/reviewRun.js");

async function withTempArtifacts<T>(
  fn: (paths: { artifactsDir: string; root: string }) => T | Promise<T>,
): Promise<T> {
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

function reviewRun(artifactsDir: string, runId = "RUN-1"): ActiveReviewRun {
  const paths = getRunPaths(artifactsDir, runId);
  return {
    contract_version: "audit-review-run/v1alpha1",
    run_id: runId,
    review_run_path: paths.reviewRunPath,
    pending_audit_tasks_path: paths.pendingTasksPath,
    host_workload_path: paths.hostWorkloadPath,
    host_result_map_path: paths.hostResultMapPath,
  };
}

function auditTask(
  taskId: string,
  filePaths: string[],
  lens = "correctness",
): AuditTask {
  return {
    task_id: taskId,
    unit_id: `unit-${taskId}`,
    pass_id: `pass-${taskId}`,
    lens,
    file_paths: filePaths,
    rationale: `Review ${filePaths.join(", ")}`,
  };
}

function minimalState(status: AuditState["status"] = "active"): AuditState {
  return { status, obligations: [] };
}

async function readHandoff(artifactsDir: string) {
  return JSON.parse(
    await readFile(join(artifactsDir, "operator-handoff.json"), "utf8"),
  );
}

test("loadCurrentActiveReviewRun returns null when the current review manifest is absent", async () => {
  await withTempArtifacts(async ({ artifactsDir }) => {
    expect(await loadCurrentActiveReviewRun(artifactsDir)).toBe(null);
  });
});

test("loadCurrentActiveReviewRun accepts the provider-neutral review-run manifest", async () => {
  await withTempArtifacts(async ({ artifactsDir }) => {
    const run = reviewRun(artifactsDir);
    await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
    await writeFile(
      join(artifactsDir, "dispatch", CURRENT_TASK_FILENAME),
      JSON.stringify(run, null, 2),
    );

    expect(await loadCurrentActiveReviewRun(artifactsDir)).toEqual(run);
  });
});

test("loadCurrentActiveReviewRun rejects invalid and malformed review manifests", async () => {
  await withTempArtifacts(async ({ artifactsDir }) => {
    const currentPath = join(artifactsDir, "dispatch", CURRENT_TASK_FILENAME);
    await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
    await writeFile(
      currentPath,
      JSON.stringify({
        contract_version: "audit-review-run/v0",
        run_id: "invalid-run",
      }),
    );
    await assert.rejects(
      loadCurrentActiveReviewRun(artifactsDir),
      /Invalid audit review-run manifest/,
    );

    await writeFile(currentPath, "{not-json\n");
    await assert.rejects(loadCurrentActiveReviewRun(artifactsDir));
  });
});

test("materializeReviewRun persists only review identity and canonical pending tasks", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n");
    await writeFile(join(root, "src", "m.ts"), "one\n");
    await writeFile(join(root, "src", "z.ts"), "one\ntwo\nthree\n");
    const tasks = [
      auditTask("task-b", ["src/z.ts", "src/a.ts"], "security"),
      auditTask("task-a", ["src/m.ts"]),
    ];

    const { activeReviewRun, pendingTasks } = await materializeReviewRun({
      root,
      artifactsDir,
      bundle: {},
      obligationId: "audit_tasks_completed",
      tasksOverride: tasks,
    });

    const expectedPaths = getRunPaths(artifactsDir, activeReviewRun.run_id);
    expect(activeReviewRun).toEqual({
      contract_version: "audit-review-run/v1alpha1",
      run_id: activeReviewRun.run_id,
      review_run_path: expectedPaths.reviewRunPath,
      pending_audit_tasks_path: expectedPaths.pendingTasksPath,
      host_workload_path: expectedPaths.hostWorkloadPath,
      host_result_map_path: expectedPaths.hostResultMapPath,
    });
    expect(Object.keys(activeReviewRun).sort()).toEqual([
      "contract_version",
      "host_result_map_path",
      "host_workload_path",
      "pending_audit_tasks_path",
      "review_run_path",
      "run_id",
    ]);
    expect(pendingTasks.map((task) => task.task_id)).toEqual([
      "task-a",
      "task-b",
    ]);
    expect(pendingTasks[1]?.file_paths).toEqual(["src/a.ts", "src/z.ts"]);

    expect(JSON.parse(await readFile(expectedPaths.reviewRunPath, "utf8"))).toEqual(
      activeReviewRun,
    );
    expect(JSON.parse(await readFile(expectedPaths.pendingTasksPath, "utf8"))).toEqual(
      pendingTasks,
    );
    expect(JSON.parse(
      await readFile(join(artifactsDir, "dispatch", CURRENT_TASK_FILENAME), "utf8"),
    )).toEqual(activeReviewRun);
    expect(JSON.parse(
      await readFile(join(artifactsDir, "dispatch", CURRENT_TASKS_FILENAME), "utf8"),
    )).toEqual(pendingTasks);
    expect(existsSync(expectedPaths.hostWorkloadPath)).toBe(false);
    expect(existsSync(expectedPaths.hostResultMapPath)).toBe(false);
  });
});

test("writeHandoffOnly writes a blocked operator handoff", async () => {
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
    expect(handoff.summary).toBe("review handoff summary");
  });
});

test("ensureSemanticReviewRun creates a blocked host-review handoff for new work", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
    const pending = [auditTask("task-1", ["src/index.ts"])];

    const result = await ensureSemanticReviewRun({
      root,
      artifactsDir,
      bundle: {
        audit_state: minimalState("active"),
        audit_tasks: pending,
      },
      state: minimalState("active"),
      obligationId: "audit_tasks_completed",
    });

    expect(result.state.status).toBe("blocked");
    expect(result.activeReviewRun.contract_version).toBe(
      "audit-review-run/v1alpha1",
    );
    expect(await loadCurrentActiveReviewRun(artifactsDir)).toEqual(
      result.activeReviewRun,
    );
    const persistedTasks = JSON.parse(
      await readFile(result.activeReviewRun.pending_audit_tasks_path, "utf8"),
    ) as AuditTask[];
    expect(persistedTasks.map((task) => task.task_id)).toEqual(["task-1"]);

    const handoff = await readHandoff(artifactsDir);
    expect(handoff.active_review_run).toEqual(result.activeReviewRun);
    expect(handoff.suggested_inputs).toEqual([]);
    expect(handoff.suggested_commands).toHaveLength(1);
    expect(handoff.suggested_commands[0]).toMatch(/next-step/);
    expect(handoff.suggested_commands[0]).not.toMatch(/advance-audit|provider/iu);
  });
});

test("ensureSemanticReviewRun reuses a run whose pending task identities still match", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    const pending = [auditTask("task-1", ["src/index.ts"])];
    const seeded = reviewRun(artifactsDir, "SEEDED-RUN");
    await writeReviewRunFiles(artifactsDir, seeded, pending);

    const result = await ensureSemanticReviewRun({
      root,
      artifactsDir,
      bundle: {
        audit_state: minimalState("active"),
        audit_tasks: pending,
      },
      state: minimalState("active"),
      obligationId: "audit_tasks_completed",
    });

    expect(result.activeReviewRun).toEqual(seeded);
    expect(result.state.status).toBe("blocked");
  });
});

test("ensureSemanticReviewRun replaces a run whose pending manifest is stale", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    const seeded = reviewRun(artifactsDir, "STALE-RUN");
    await writeReviewRunFiles(
      artifactsDir,
      seeded,
      [auditTask("task-stale", ["src/stale.ts"])],
    );
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "current.ts"), "export const current = true;\n");
    const fresh = auditTask("task-fresh", ["src/current.ts"], "security");

    const result = await ensureSemanticReviewRun({
      root,
      artifactsDir,
      bundle: {
        audit_state: minimalState("active"),
        audit_tasks: [fresh],
      },
      state: minimalState("active"),
      obligationId: "audit_tasks_completed",
    });

    expect(result.activeReviewRun.run_id).not.toBe("STALE-RUN");
    const refreshedTasks = JSON.parse(
      await readFile(result.activeReviewRun.pending_audit_tasks_path, "utf8"),
    ) as AuditTask[];
    expect(refreshedTasks.map((task) => task.task_id)).toEqual(["task-fresh"]);
    expect(await loadCurrentActiveReviewRun(artifactsDir)).toEqual(
      result.activeReviewRun,
    );
  });
});

test("persistConfigErrorHandoff writes a blocked handoff carrying the progress summary", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
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
