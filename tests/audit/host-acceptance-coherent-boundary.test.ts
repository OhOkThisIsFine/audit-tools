// Packet 12 — read a coherent binding set under the accepted-results lock.
//
// The ingest used to read the published trio (`host-workload.json`,
// `host-result-map.json`, `host-task-bindings.json`) BEFORE acquiring the
// accepted-results lock, so a concurrent prepare could rewrite any of the three
// underneath a bindings parse that had already read its sibling — a workload
// parsed against a result map or binding set from the write before it. The fix
// reads the trio AND the accepted ledger under the ONE acquisition, and the
// writer publishes them under the same acquisition.
//
// This file asserts the property deterministically: it wraps the shared
// `withFileLock` (the lock substrate `withAcceptedResultsLock` sits on) and
// reads the trio through a wrapped `readJsonFile`, proving that EVERY read of
// the three published documents happens while the accepted-results lock is
// held. It also wraps the writer path to prove `prepareAuditHostHandoff`
// publishes the three files while the lock is held.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveLaneDemand } from "../../src/shared/types/stepContract.js";

const harness = vi.hoisted(() => ({
  lockDepth: 0,
  readOutsideLock: [] as string[],
  writeOutsideLock: [] as string[],
  pauseAfterNextLock: false,
  onLockReleased: null as null | (() => void),
  resumeAfterLock: null as null | Promise<void>,
}));

const TRIO_SUFFIXES = [
  "host-workload.json",
  "host-result-map.json",
  "host-task-bindings.json",
];

vi.mock("audit-tools/shared", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("audit-tools/shared")>();
  return {
    ...actual,
    withFileLock: async <T>(
      path: string,
      fn: () => Promise<T>,
      timeout?: number,
      logger?: unknown,
    ): Promise<T> => {
      harness.lockDepth += 1;
      try {
        return await actual.withFileLock(path, fn, timeout, logger as never);
      } finally {
        harness.lockDepth -= 1;
        if (harness.pauseAfterNextLock) {
          harness.pauseAfterNextLock = false;
          harness.onLockReleased?.();
          await harness.resumeAfterLock;
        }
      }
    },
    readJsonFile: async <T>(path: string): Promise<T> => {
      if (harness.lockDepth === 0 && TRIO_SUFFIXES.some((s) => path.endsWith(s))) {
        harness.readOutsideLock.push(path);
      }
      return actual.readJsonFile<T>(path);
    },
    writeJsonFile: async (path: string, value: unknown): Promise<void> => {
      if (harness.lockDepth === 0 && TRIO_SUFFIXES.some((s) => path.endsWith(s))) {
        harness.writeOutsideLock.push(path);
      }
      return actual.writeJsonFile(path, value);
    },
  };
});

const cleanupRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const RUN_ID = "host-run-coherent";
const AUDIT_TASK = {
  task_id: "audit-task-a",
  unit_id: "unit-audit-task-a",
  pass_id: "pass:correctness",
  lens: "correctness",
  file_paths: ["src/a.ts"],
  rationale: "Review src/a.ts",
};

async function setup() {
  const { prepareAuditHostHandoff, ingestAuditHostResults } = await import(
    "../../src/audit/cli/dispatch/hostHandoff.js"
  );
  const root = await mkdtemp(join(tmpdir(), "audit-coherent-"));
  cleanupRoots.push(root);
  const artifactsDir = join(root, ".audit-tools", "audit");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
  const task = {
    ...AUDIT_TASK,
    priority: "medium",
    demand: deriveLaneDemand({ tokenEstimate: 1200, fileCount: 1, riskScore: 0.5 }),
    token_estimate: 1200,
    file_line_counts: { "src/a.ts": 2 },
  };
  const prepared = await prepareAuditHostHandoff({
    root,
    artifactsDir,
    runId: RUN_ID,
    tasks: [task],
  });
  const item = prepared.workload.work_items.find(
    (entry) => entry.id === AUDIT_TASK.task_id,
  );
  if (!item) throw new Error("prepare did not publish the work item");
  const resultPath = join(root, item.result_path);
  await mkdir(join(resultPath, ".."), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({
      contract_version: "audit-host-result/v1alpha1",
      result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`,
      run_id: RUN_ID,
      work_item_id: item.id,
      prompt_sha256: item.prompt.sha256,
      file_coverage: [{ path: "src/a.ts", reviewed_lines: 2, total_lines: 2 }],
      findings: [],
    }),
    "utf8",
  );
  const ingest = () =>
    ingestAuditHostResults({
      root,
      artifactsDir,
      runId: RUN_ID,
      auditTasks: [AUDIT_TASK],
      lineIndex: { "src/a.ts": 2 },
    });
  return { root, artifactsDir, prepareAuditHostHandoff, ingest, task, promptSha256: item.prompt.sha256 };
}

describe("coherent binding set is read and written under the accepted-results lock", () => {
  beforeEach(() => {
    harness.lockDepth = 0;
    harness.readOutsideLock = [];
    harness.writeOutsideLock = [];
    harness.pauseAfterNextLock = false;
    harness.onLockReleased = null;
    harness.resumeAfterLock = null;
  });

  it("ingest reads the published trio only while the lock is held", async () => {
    const ctx = await setup();
    const summary = await ctx.ingest();
    expect(summary.accepted_count).toBe(1);
    expect(
      harness.readOutsideLock,
      "the workload, result map and task bindings must all be read under the lock",
    ).toEqual([]);
  });

  it("prepare publishes the trio only while the lock is held", async () => {
    const ctx = await setup();
    // A second prepare (re-publish) exercises the write path under observation.
    await ctx.prepareAuditHostHandoff({
      root: ctx.root,
      artifactsDir: ctx.artifactsDir,
      runId: RUN_ID,
      tasks: [ctx.task],
    });
    expect(
      harness.writeOutsideLock,
      "the workload, result map and task bindings must all be written under the lock",
    ).toEqual([]);
  });

  it("preserves accepted work across a concurrent re-prepare and re-ingest", async () => {
    const ctx = await setup();
    const first = await ctx.ingest();
    expect(first.completed_work_item_ids).toEqual([AUDIT_TASK.task_id]);

    // A re-prepare that republishes the same task must not drop the accepted
    // entry the ledger already holds, and a re-ingest must not re-accept it.
    await ctx.prepareAuditHostHandoff({
      root: ctx.root,
      artifactsDir: ctx.artifactsDir,
      runId: RUN_ID,
      tasks: [ctx.task],
    });
    const second = await ctx.ingest();
    expect(second.accepted_count).toBe(0);
    expect(second.completed_work_item_ids).toEqual([AUDIT_TASK.task_id]);

    const ledger = JSON.parse(
      await readFile(
        join(ctx.artifactsDir, "runs", RUN_ID, "host-accepted-results-ledger.json"),
        "utf8",
      ),
    ) as { entries: { work_item_id: string }[] };
    expect(ledger.entries.map((e) => e.work_item_id)).toEqual([AUDIT_TASK.task_id]);
  });

  it("refuses an old result when prepare republishes a new binding between ingest's read and append", async () => {
    const ctx = await setup();
    let notifyRead!: () => void;
    const readComplete = new Promise<void>((resolve) => { notifyRead = resolve; });
    let resume!: () => void;
    harness.resumeAfterLock = new Promise<void>((resolve) => { resume = resolve; });
    harness.onLockReleased = notifyRead;
    harness.pauseAfterNextLock = true;

    const pendingIngest = ctx.ingest();
    await readComplete;
    const refreshed = await ctx.prepareAuditHostHandoff({
      root: ctx.root,
      artifactsDir: ctx.artifactsDir,
      runId: RUN_ID,
      tasks: [{ ...ctx.task, rationale: "Review a different contract for src/a.ts" }],
    });
    const newItem = refreshed.workload.work_items.find((item) => item.id === AUDIT_TASK.task_id);
    expect(newItem?.prompt.sha256).not.toBe(ctx.promptSha256);
    resume();
    const summary = await pendingIngest;
    expect(summary.accepted_count).toBe(0);
    expect(summary.issues.some((issue) => issue.code === "workload_stale")).toBe(true);
    const ledger = JSON.parse(await readFile(
      join(ctx.artifactsDir, "runs", RUN_ID, "host-accepted-results-ledger.json"),
      "utf8",
    )) as { entries: unknown[] };
    expect(ledger.entries).toEqual([]);
  });
});
