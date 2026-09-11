import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
import type { AuditResult, AuditTask } from "../../src/audit/types.js";
import type { AuditHostTask } from "../../src/audit/cli/dispatch/hostHandoff.js";

const {
  loadCurrentActiveReviewRun,
  materializeReviewRun,
  ensureSemanticReviewRunUnlocked,
  writeHandoffOnly,
  persistConfigErrorHandoff,
} = await import("../../src/audit/cli/reviewRun.js");

const { prepareAuditHostHandoff, ingestAuditHostResults } = await import(
  "../../src/audit/cli/dispatch/hostHandoff.js"
);

/**
 * A published work item, as the host-handoff boundary emits it. Only the fields
 * these tests bind through — the bound path and the prompt digest — are named.
 */
interface PublishedWorkItem {
  readonly id: string;
  readonly result_path: string;
  readonly prompt: { readonly sha256: string };
  readonly scope: { readonly files: readonly string[] };
}

interface PublishedWorkload {
  readonly run_id: string;
  readonly work_items: readonly PublishedWorkItem[];
}

/**
 * The artifacts dir MUST sit beneath the repository root the host-handoff
 * boundary is handed — the shared resolution contains it there — so the two
 * wave tests derive it from the root rather than from `withTempArtifacts`,
 * whose other callers only exercise the review-run writer.
 */
function auditArtifactsDir(root: string): string {
  return join(root, ".audit-tools", "audit");
}

/** The audit draw's host-task projection, for the two fields these tests use. */
function hostTask(task: AuditTask): AuditHostTask {
  return {
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_paths: task.file_paths,
    file_line_counts: Object.fromEntries(
      task.file_paths.map((path) => [path, 2]),
    ),
    rationale: task.rationale,
    priority: "low",
    demand: { size: "small", complexity: "standard", risk: "medium" },
    token_estimate: 100,
  };
}

/** Write the host's result for one published item at its BOUND path. */
async function writeBoundResult(
  root: string,
  runId: string,
  item: PublishedWorkItem,
): Promise<void> {
  const absolute = join(root, item.result_path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(
    absolute,
    JSON.stringify({
      contract_version: "audit-host-result/v1alpha1",
      result_id: `result-${item.id}`,
      run_id: runId,
      work_item_id: item.id,
      prompt_sha256: item.prompt.sha256,
      file_coverage: item.scope.files.map((path) => ({
        path,
        reviewed_lines: 2,
        total_lines: 2,
      })),
      findings: [],
    }),
    "utf8",
  );
}

/**
 * One whole wave turn: pause the review obligation for `tasks`, publish the
 * workload for the run it hands back, and return both. This is the shape a host
 * actually sees — the run identity and the bound paths come from the SAME
 * pause, never from a run id a test invented.
 *
 * A wave ENDS when its pending set is fully accepted, and the tool finds that
 * out the only way it does in production: the accepted results land in the
 * bundle, so `derivePendingTaskPartition` no longer names those tasks. The
 * accepted results are therefore written into the bundle here rather than
 * simulated with a flag — `accepted` is exactly what the fold ingests, and
 * omitting it is exactly how a wave stays open.
 */
async function publishWave(
  root: string,
  artifactsDir: string,
  tasks: readonly AuditTask[],
  accepted: readonly AuditTask[] = [],
): Promise<{ run: ActiveReviewRun; workload: PublishedWorkload }> {
  const pause = await ensureSemanticReviewRunUnlocked({
    root,
    artifactsDir,
    bundle: {
      audit_state: minimalState("active"),
      audit_tasks: [...tasks],
      ...(accepted.length > 0
        ? { audit_results: accepted.map(acceptedResult) }
        : {}),
    },
    state: minimalState("active"),
    obligationId: "audit_tasks_completed",
  });
  const handoff = await prepareAuditHostHandoff({
    root,
    artifactsDir,
    runId: pause.activeReviewRun.run_id,
    tasks: tasks.map(hostTask),
  });
  return {
    run: pause.activeReviewRun,
    workload: handoff.workload as unknown as PublishedWorkload,
  };
}

/** A task's accepted result, as ingestion leaves it in the bundle. */
function acceptedResult(task: AuditTask): AuditResult {
  return {
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: 2,
    })),
    findings: [],
  };
}

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

test("ensureSemanticReviewRunUnlocked creates a blocked host-review handoff for new work", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
    const pending = [auditTask("task-1", ["src/index.ts"])];

    const result = await ensureSemanticReviewRunUnlocked({
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

test("ensureSemanticReviewRunUnlocked derives ONE run id while a wave is open, whatever the pending set is", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    const pending = [auditTask("task-1", ["src/index.ts"])];
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "one\ntwo\n");

    const first = await ensureSemanticReviewRunUnlocked({
      root,
      artifactsDir,
      bundle: {
        audit_state: minimalState("active"),
        audit_tasks: pending,
      },
      state: minimalState("active"),
      obligationId: "audit_tasks_completed",
    });
    // A DIFFERENT pending set in the SAME wave: this is what a partial ingest
    // looks like from here — the accepted task left the pending set, the wave
    // did not end. The retired rule reused a run only while its persisted
    // pending manifest named exactly these task ids, so this is precisely the
    // input that used to re-mint the run.
    const second = await ensureSemanticReviewRunUnlocked({
      root,
      artifactsDir,
      bundle: {
        audit_state: minimalState("active"),
        audit_tasks: [auditTask("task-2", ["src/index.ts"], "security")],
      },
      state: minimalState("active"),
      obligationId: "audit_tasks_completed",
    });

    expect(
      second.activeReviewRun.run_id,
      "a wave's run id is a pure function of the review obligation and the OPEN " +
        "GENERATION — the pending set is content the run CARRIES, never identity " +
        "it is derived from",
    ).toBe(first.activeReviewRun.run_id);
    expect(second.state.status).toBe("blocked");
  });
});

test("ensureSemanticReviewRunUnlocked rewrites the pending manifest in place when the frontier moves", async () => {
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

    const result = await ensureSemanticReviewRunUnlocked({
      root,
      artifactsDir,
      bundle: {
        audit_state: minimalState("active"),
        audit_tasks: [fresh],
      },
      state: minimalState("active"),
      obligationId: "audit_tasks_completed",
    });

    // "Stale" no longer means "a new run id" — the run is named for the
    // obligation, so the manifest is simply rewritten where the run already is.
    const refreshedTasks = JSON.parse(
      await readFile(result.activeReviewRun.pending_audit_tasks_path, "utf8"),
    ) as AuditTask[];
    expect(refreshedTasks.map((task) => task.task_id)).toEqual(["task-fresh"]);
    expect(await loadCurrentActiveReviewRun(artifactsDir)).toEqual(
      result.activeReviewRun,
    );
  });
});

test("two waves of one artifacts directory name two runs — the second opens a new generation", async () => {
  await withTempArtifacts(async ({ root }) => {
    const artifactsDir = auditArtifactsDir(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n");
    const firstTask = auditTask("task-a", ["src/a.ts"]);

    // WAVE 1: publish one item, then accept it. Accepting the LAST owed item is
    // what re-opens the review obligation, and the pause that follows publishes
    // over an EMPTY owed partition — the wave's own statement that it drained.
    const first = await publishWave(root, artifactsDir, [firstTask]);
    const firstItem = first.workload.work_items.find(
      (item) => item.id === "task-a",
    );
    if (firstItem === undefined) {
      throw new Error("wave 1 published no work item for task-a");
    }
    const drained = await publishWave(root, artifactsDir, [], [firstTask]);
    expect(
      drained.run.run_id,
      "the drain publish belongs to wave 1 — it is the same open wave",
    ).toBe(first.run.run_id);

    // WAVE 2: the review obligation re-opens with new work. It must NOT resolve
    // wave 1's run id — `runs/` is never pruned, so sharing one directory would
    // let wave 1's accepted pair withhold wave 2's work.
    const second = await publishWave(root, artifactsDir, [
      auditTask("task-b", ["src/a.ts"]),
      auditTask("task-c", ["src/a.ts"]),
    ]);

    expect(
      second.run.run_id,
      "a NEW wave resolves a NEW run id: a wave's identity never moves while any " +
        "of its work is owed, and it never carries over into the next wave",
    ).not.toBe(first.run.run_id);
    // Each wave's own directory is on disk carrying its own manifest.
    expect(
      JSON.parse(await readFile(first.run.review_run_path, "utf8")).run_id,
    ).toBe(first.run.run_id);
    expect(
      JSON.parse(await readFile(second.run.review_run_path, "utf8")).run_id,
    ).toBe(second.run.run_id);
  });
});

test("a partial ingest keeps every carried-over binding: the run identity, the bound path and the prompt digest all survive", async () => {
  await withTempArtifacts(async ({ root }) => {
    const artifactsDir = auditArtifactsDir(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n");
    await writeFile(join(root, "src", "b.ts"), "one\ntwo\n");
    const tasks = [
      auditTask("task-a", ["src/a.ts"]),
      auditTask("task-b", ["src/b.ts"]),
    ];

    const before = await publishWave(root, artifactsDir, tasks);
    const carriedOver = before.workload.work_items.find(
      (item) => item.id === "task-a",
    );
    if (carriedOver === undefined) {
      throw new Error("the first wave published no work item for task-a");
    }

    // The host ingests PART of the wave: task-b's worker returned, task-a's is
    // still writing. The next pause therefore sees one task fewer pending.
    const acceptedB = before.workload.work_items.find(
      (item) => item.id === "task-b",
    );
    if (acceptedB === undefined) {
      throw new Error("the first wave published no work item for task-b");
    }
    await writeBoundResult(root, before.run.run_id, acceptedB);
    const ingested = await ingestAuditHostResults({
      root,
      artifactsDir,
      runId: before.run.run_id,
      auditTasks: tasks,
    });
    expect(
      ingested.completed_work_item_ids,
      "the fixture must ingest exactly the one result it wrote",
    ).toEqual(["task-b"]);

    // The host calls next-step again while task-a's worker is still writing, so
    // the wave is STILL OPEN: task-b is accepted, task-a is not.
    const after = await publishWave(root, artifactsDir, [tasks[0]!], [tasks[1]!]);
    const republished = after.workload.work_items.find(
      (item) => item.id === "task-a",
    );
    if (republished === undefined) {
      throw new Error("the republished wave dropped the still-pending task-a");
    }

    expect(
      after.run.run_id,
      "a partial ingest must not re-mint the wave's run identity: the worker still " +
        "writing task-a is holding a binding derived from it",
    ).toBe(before.run.run_id);
    expect(
      republished.result_path,
      "the still-pending work item's BOUND PATH must survive a partial ingest, or the " +
        "worker writes to a path this run never reads",
    ).toBe(carriedOver.result_path);
    expect(
      republished.prompt.sha256,
      "the still-pending work item's PROMPT DIGEST must survive a partial ingest, or the " +
        "worker's result is refused on identity it had no way to re-derive",
    ).toBe(carriedOver.prompt.sha256);
  });
});

test("the accepted ledger carries forward across a republication inside one wave", async () => {
  await withTempArtifacts(async ({ root }) => {
    const artifactsDir = auditArtifactsDir(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n");
    await writeFile(join(root, "src", "b.ts"), "one\ntwo\n");
    const tasks = [
      auditTask("task-a", ["src/a.ts"]),
      auditTask("task-b", ["src/b.ts"]),
    ];

    const before = await publishWave(root, artifactsDir, tasks);
    const acceptedB = before.workload.work_items.find(
      (item) => item.id === "task-b",
    );
    if (acceptedB === undefined) {
      throw new Error("the first wave published no work item for task-b");
    }
    await writeBoundResult(root, before.run.run_id, acceptedB);
    await ingestAuditHostResults({
      root,
      artifactsDir,
      runId: before.run.run_id,
      auditTasks: tasks,
    });

    // task-a's worker is still out, so the wave is still open; the host calls
    // next-step with task-b accepted and task-a still owed.
    const after = await publishWave(root, artifactsDir, [tasks[0]!], [tasks[1]!]);
    const reingested = await ingestAuditHostResults({
      root,
      artifactsDir,
      runId: after.run.run_id,
      auditTasks: tasks,
    });

    expect(
      reingested.accepted_count,
      "an acceptance must not be silently re-ingested by a republication: the ledger " +
        "the wave writes to has to be the ledger the next run reads, so task-b's " +
        "binding is already satisfied and its file is never accepted a second time",
    ).toBe(0);
    expect(
      reingested.completed_work_item_ids,
      "an acceptance must not be forgotten by a republication: the set of work items " +
        "this run has already accepted still names task-b",
    ).toContain("task-b");
  });
});

test("ensureSemanticReviewRunUnlocked ADOPTS an in-flight clock-minted run at the derived id", async () => {
  await withTempArtifacts(async ({ artifactsDir, root }) => {
    // A run minted by the retired clock-based `buildRunId`, still in flight when
    // this build lands: its published workload, bound paths and accepted pair
    // all hang off the OLD id, and workers are holding its bindings.
    const legacyRunId = "20260910T120000000Z_audit_tasks_completed_001";
    const legacy = reviewRun(artifactsDir, legacyRunId);
    await writeReviewRunFiles(artifactsDir, legacy, [
      auditTask("task-legacy", ["src/legacy.ts"]),
    ]);

    const result = await ensureSemanticReviewRunUnlocked({
      root,
      artifactsDir,
      bundle: {
        audit_state: minimalState("active"),
        audit_tasks: [auditTask("task-legacy", ["src/legacy.ts"])],
      },
      state: minimalState("active"),
      obligationId: "audit_tasks_completed",
    });

    expect(
      result.activeReviewRun.run_id,
      "a run the previous build minted for THIS obligation is ADOPTED, not " +
        "abandoned: the alternative strands a wave whose workers are still " +
        "writing against bindings derived from the old identity",
    ).toBe(legacyRunId);
  });
});

test("wave 2 applies a result whose binding is byte-identical to one wave 1 accepted", async () => {
  await withTempArtifacts(async ({ root }) => {
    const artifactsDir = auditArtifactsDir(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n");
    const tasks = [
      auditTask("task-a", ["src/a.ts"]),
      auditTask("task-b", ["src/b.ts"]),
    ];
    await writeFile(join(root, "src", "b.ts"), "one\ntwo\n");

    // WAVE 1: publish both, accept task-b, and let wave 1's SECOND publish — over
    // the now-drained partition — be the wave's own statement that it ended.
    const wave1 = await publishWave(root, artifactsDir, tasks);
    const wave1B = wave1.workload.work_items.find((item) => item.id === "task-b");
    if (wave1B === undefined) {
      throw new Error("wave 1 published no work item for task-b");
    }
    await writeBoundResult(root, wave1.run.run_id, wave1B);
    const wave1Ingest = await ingestAuditHostResults({
      root,
      artifactsDir,
      runId: wave1.run.run_id,
      auditTasks: tasks,
    });
    expect(
      wave1Ingest.completed_work_item_ids,
      "the fixture must accept task-b in wave 1",
    ).toEqual(["task-b"]);
    // The lone remaining item is accepted too, so this publish is over an EMPTY
    // owed partition: the wave is drained, and it says so in its own directory.
    const drained = await publishWave(root, artifactsDir, [], tasks);
    expect(drained.run.run_id).toBe(wave1.run.run_id);

    // WAVE 2: the same obligation re-opens with BOTH tasks pending again, and
    // task-b's ask is byte-identical to the one wave 1 accepted. Its binding is
    // therefore byte-identical too — same work item, same prompt digest.
    const wave2 = await publishWave(root, artifactsDir, tasks);
    const wave2B = wave2.workload.work_items.find((item) => item.id === "task-b");
    if (wave2B === undefined) {
      throw new Error("wave 2 published no work item for task-b");
    }
    expect(
      wave2.run.run_id,
      "the fixture must actually cross a wave boundary",
    ).not.toBe(wave1.run.run_id);

    // The worker writes its result at wave 2's OWN bound path.
    await writeBoundResult(root, wave2.run.run_id, wave2B);
    const wave2Ingest = await ingestAuditHostResults({
      root,
      artifactsDir,
      runId: wave2.run.run_id,
      auditTasks: tasks,
    });

    expect(
      wave2Ingest.completed_work_item_ids,
      "wave 2 must APPLY a result whose binding wave 1 already accepted: sharing an " +
        "accepted ledger across waves silences the new wave's work as 'already accepted'",
    ).toContain("task-b");
    expect(
      wave2Ingest.accepted_count,
      "the binding is new TO THIS RUN, so it is accepted rather than deduped away",
    ).toBe(1);
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
