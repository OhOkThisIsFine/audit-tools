import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readSubmissionLedger,
  submissionLedgerPath,
} from "../../src/shared/submission/submissionLedger.js";
import {
  recordHostResultOutcomes,
  type IngestionCheckId,
} from "../../src/shared/index.js";
import { existsSync } from "node:fs";

const FAILURE_SIGNATURE =
  "contract:audit-zero-adapter-boundary:not-yet-satisfied";

interface HostTask {
  readonly task_id: string;
  readonly unit_id: string;
  readonly pass_id: string;
  readonly lens: string;
  readonly file_paths: readonly string[];
  readonly file_line_counts: Readonly<Record<string, number>>;
  readonly rationale: string;
  readonly priority: string;
  readonly demand: {
    readonly size: string;
    readonly complexity: string;
    readonly risk: string;
  };
  readonly token_estimate: number;
}

interface HostWorkItem {
  readonly id: string;
  readonly lens: string;
  readonly metadata: {
    readonly demand: {
      readonly size: string;
      readonly complexity: string;
      readonly risk: string;
    };
    readonly token_estimate: number;
  };
  readonly prompt: { readonly sha256: string; readonly text: string };
  readonly scope: {
    readonly files: readonly string[];
    readonly unit_ids: readonly string[];
  };
  readonly result_path: string;
}

interface HostWorkload {
  readonly contract_version: "audit-host-workload/v1alpha2";
  readonly run_id: string;
  readonly work_items: readonly HostWorkItem[];
}

interface HostResultMap {
  readonly contract_version: "audit-host-result-map/v1alpha1";
  readonly run_id: string;
  readonly entries: readonly {
    readonly work_item_id: string;
    readonly prompt_sha256: string;
    readonly result_path: string;
  }[];
}

interface PreparedHandoff {
  readonly workload: HostWorkload;
  readonly result_map: HostResultMap;
  readonly workload_path: string;
  readonly result_map_path: string;
}

interface IngestIssue {
  readonly code: string;
  readonly message: string;
  /**
   * The registered ingestion check the issue failed — the structured twin of
   * the category its message opens with. Present on every refusal this boundary
   * classifies; `workload_stale` is the one that only exists because the
   * refused document was minted by a DIFFERENT build, so the check id is how a
   * caller tells it from an ordinary binding failure without parsing prose.
   */
  readonly check?: IngestionCheckId;
  readonly work_item_id?: string;
  readonly result_path?: string;
}

interface IngestSummary {
  readonly accepted_count: number;
  readonly completed_work_item_ids: readonly string[];
  readonly issues: readonly IngestIssue[];
  readonly raw_issues: readonly IngestIssue[];
}

interface HostBoundary {
  readonly prepareAuditHostHandoff: (input: {
    readonly root: string;
    readonly artifactsDir: string;
    readonly runId: string;
    readonly tasks: readonly HostTask[];
  }) => Promise<PreparedHandoff>;
  readonly ingestAuditHostResults: (input: {
    readonly root: string;
    readonly artifactsDir: string;
    readonly runId: string;
    /** The same manifest prepareAuditHostHandoff published. */
    readonly auditTasks: readonly HostTask[];
  }) => Promise<IngestSummary>;
}

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function loadBoundary(): Promise<HostBoundary> {
  try {
    const loaded = (await import(
      "../../src/audit/cli/dispatch/hostHandoff.js"
    )) as unknown as Partial<HostBoundary>;
    if (
      typeof loaded.prepareAuditHostHandoff !== "function" ||
      typeof loaded.ingestAuditHostResults !== "function"
    ) {
      throw new Error(
        "prepareAuditHostHandoff/ingestAuditHostResults exports are absent",
      );
    }
    return loaded as HostBoundary;
  } catch (error) {
    throw new Error(`${FAILURE_SIGNATURE}: ${String(error)}`, { cause: error });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectContained(root: string, path: string, label: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(resolve(root), absolute).replaceAll("\\", "/");
  expect(rel, `${label} must stay beneath the supplied repository root`).not.toMatch(
    /^(?:\.\.(?:\/|$)|\/)/u,
  );
  return absolute;
}

function objectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...objectKeys(child)]);
}

async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const entries: Array<readonly [string, string]> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        entries.push([
          relative(root, path).replaceAll("\\", "/"),
          sha256(await readFile(path, "utf8")),
        ]);
      }
    }
  };
  await walk(root);
  return Object.fromEntries(entries);
}

function task(
  id: string,
  lens: string,
  path: string,
  demand: { size: string; complexity: string; risk: string },
  tokenEstimate: number,
): HostTask {
  return {
    task_id: id,
    unit_id: `unit-${id}`,
    pass_id: `pass:${lens}`,
    lens,
    file_paths: [path],
    file_line_counts: { [path]: 2 },
    rationale: `Review ${path}`,
    priority: demand.risk,
    demand,
    token_estimate: tokenEstimate,
  };
}

function boundResult(
  runId: string,
  item: HostWorkItem,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

describe(FAILURE_SIGNATURE, () => {
  it("accepts one leading byte-order mark only after reading the bound result, while keeping invalid results refused", async () => {
    const boundary = await loadBoundary();
    const acceptedRoot = await mkdtemp(
      join(tmpdir(), "audit-host-bom-accepted-"),
    );
    const invalidRoot = await mkdtemp(
      join(tmpdir(), "audit-host-bom-invalid-"),
    );
    const malformedRoot = await mkdtemp(
      join(tmpdir(), "audit-host-bom-malformed-"),
    );
    cleanupRoots.push(acceptedRoot, invalidRoot, malformedRoot);
    const tasks = [
      task(
        "audit-bom",
        "security",
        "src/a.ts",
        { size: "small", complexity: "standard", risk: "high" },
        1200,
      ),
    ];

    const cases = [
      {
        root: acceptedRoot,
        runId: "audit-bom-accepted",
        body: (item: HostWorkItem) =>
          `\uFEFF${JSON.stringify(boundResult("audit-bom-accepted", item))}`,
      },
      {
        root: invalidRoot,
        runId: "audit-bom-invalid",
        body: (item: HostWorkItem) =>
          `\uFEFF${JSON.stringify(
            boundResult("audit-bom-invalid", item, { run_id: "wrong-run" }),
          )}`,
      },
      {
        root: malformedRoot,
        runId: "audit-bom-malformed",
        body: () => "\uFEFF{not-json",
      },
    ] as const;

    const summaries = [];
    for (const current of cases) {
      const artifactsDir = join(current.root, ".audit-tools", "audit");
      await mkdir(join(current.root, "src"), { recursive: true });
      await writeFile(join(current.root, "src", "a.ts"), "one\ntwo\n", "utf8");
      const prepared = await boundary.prepareAuditHostHandoff({
        root: current.root,
        artifactsDir,
        runId: current.runId,
        tasks,
      });
      const item = prepared.workload.work_items[0]!;
      await writeFile(
        expectContained(current.root, item.result_path, "bound result"),
        current.body(item),
        "utf8",
      );
      summaries.push(await boundary.ingestAuditHostResults({
        root: current.root,
        artifactsDir,
        runId: current.runId,
        auditTasks: tasks,
      }));
    }

    expect(summaries[0]!.accepted_count).toBe(1);
    expect(summaries[0]!.issues).toEqual([]);
    expect(summaries[1]!.accepted_count).toBe(0);
    expect(summaries[1]!.issues.map((issue) => issue.code)).toContain(
      "submission_contract_invalid",
    );
    expect(summaries[2]!.accepted_count).toBe(0);
    expect(summaries[2]!.issues.map((issue) => issue.code)).toContain(
      "submission_malformed",
    );
  });

  it("carries a prior rejection reason across a rebound workload and clears it after acceptance", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "audit-host-diagnostics-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    const runId = "host-diagnostics-001";
    const tasks = [
      task(
        "audit-a",
        "security",
        "src/a.ts",
        { size: "small", complexity: "standard", risk: "high" },
        1200,
      ),
      task(
        "audit-b",
        "correctness",
        "src/b.ts",
        { size: "small", complexity: "standard", risk: "medium" },
        1200,
      ),
    ];
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
    await writeFile(join(root, "src", "b.ts"), "one\ntwo\n", "utf8");

    const first = await boundary.prepareAuditHostHandoff({ root, artifactsDir, runId, tasks });
    const firstA = first.workload.work_items.find((item) => item.id === "audit-a")!;
    const firstB = first.workload.work_items.find((item) => item.id === "audit-b")!;
    await writeFile(expectContained(root, firstA.result_path, "first A result"), "{broken", "utf8");
    await writeFile(
      expectContained(root, firstB.result_path, "first B result"),
      JSON.stringify(boundResult(runId, firstB)),
      "utf8",
    );
    const firstSummary = await boundary.ingestAuditHostResults({ root, artifactsDir, runId, auditTasks: tasks });
    expect(firstSummary.accepted_count).toBe(1);
    expect(firstSummary.issues.find((issue) => issue.work_item_id === "audit-a")?.code).toBe(
      "submission_malformed",
    );
    await recordHostResultOutcomes(artifactsDir, runId, {
      issues: firstSummary.issues,
      acceptedIds: firstSummary.completed_work_item_ids,
    });

    const secondRunId = "host-diagnostics-002";
    const rebound = await boundary.prepareAuditHostHandoff({
      root,
      artifactsDir,
      runId: secondRunId,
      tasks,
    });
    const secondA = rebound.workload.work_items.find((item) => item.id === "audit-a")!;
    const secondB = rebound.workload.work_items.find((item) => item.id === "audit-b")!;
    const secondPath = expectContained(root, secondA.result_path, "rebound A result");
    expect(secondA.result_path).not.toBe(firstA.result_path);
    await rm(secondPath, { force: true });
    await writeFile(
      expectContained(root, secondB.result_path, "rebound B result"),
      JSON.stringify(boundResult(secondRunId, secondB)),
      "utf8",
    );
    const secondSummary = await boundary.ingestAuditHostResults({ root, artifactsDir, runId: secondRunId, auditTasks: tasks });
    const secondIssue = secondSummary.issues.find((issue) => issue.work_item_id === "audit-a")!;
    expect(secondIssue.code).toBe("submission_rejected");
    expect(secondIssue.message).toContain("submission_malformed");
    expect(secondIssue.result_path).toBe(secondA.result_path);
    await recordHostResultOutcomes(artifactsDir, secondRunId, {
      issues: secondSummary.raw_issues,
      acceptedIds: secondSummary.completed_work_item_ids,
    });

    await writeFile(secondPath, JSON.stringify(boundResult(secondRunId, secondA)), "utf8");
    const accepted = await boundary.ingestAuditHostResults({ root, artifactsDir, runId: secondRunId, auditTasks: tasks });
    expect(accepted.completed_work_item_ids).toContain("audit-a");
    await recordHostResultOutcomes(artifactsDir, secondRunId, {
      issues: accepted.raw_issues,
      acceptedIds: accepted.completed_work_item_ids,
    });
    const events = await readSubmissionLedger(artifactsDir);
    expect(events.filter((event) => event.submission_id === "audit-a").map((event) => event.kind)).toEqual([
      "rejected",
      "accepted",
    ]);
    expect(existsSync(submissionLedgerPath(artifactsDir))).toBe(true);
  });

  it("publishes every pending task once and ingests only exact bound host results", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "audit-host-handoff-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    const runId = "host-run-001";
    const tasks = [
      task(
        "audit-task-b",
        "correctness",
        "src/b.ts",
        { size: "small", complexity: "standard", risk: "medium" },
        1200,
      ),
      task(
        "audit-task-a",
        "security",
        "src/a.ts",
        { size: "medium", complexity: "deep", risk: "high" },
        2400,
      ),
    ];
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
    await writeFile(join(root, "src", "b.ts"), "one\ntwo\n", "utf8");

    const first = await boundary.prepareAuditHostHandoff({
      root,
      artifactsDir,
      runId,
      tasks,
    });
    expect(first.workload.contract_version).toBe(
      "audit-host-workload/v1alpha2",
    );
    expect(first.result_map.contract_version).toBe(
      "audit-host-result-map/v1alpha1",
    );
    expect(first.workload.run_id).toBe(runId);
    expect(first.result_map.run_id).toBe(runId);

    const expectedIds = tasks.map((entry) => entry.task_id).sort();
    const emittedIds = first.workload.work_items.map((entry) => entry.id);
    expect(emittedIds).toEqual(expectedIds);
    expect(new Set(emittedIds).size).toBe(expectedIds.length);
    expect(first.result_map.entries.map((entry) => entry.work_item_id)).toEqual(
      expectedIds,
    );

    for (const item of first.workload.work_items) {
      const source = tasks.find((entry) => entry.task_id === item.id)!;
      expect(Object.keys(item.metadata).sort()).toEqual([
        "demand",
        "token_estimate",
      ]);
      expect(item.metadata).toEqual({
        demand: source.demand,
        token_estimate: source.token_estimate,
      });
      expect(item.prompt.text.length).toBeGreaterThan(0);
      expect(item.prompt.sha256).toBe(sha256(item.prompt.text));
      expect(item.scope.files).toEqual([...source.file_paths].sort());
      expect(item.scope.unit_ids).toEqual([source.unit_id]);
      expect(isAbsolute(item.result_path)).toBe(false);
      expectContained(root, item.result_path, `result_path for ${item.id}`);
    }

    const forbiddenKey =
      /provider|model|pool|quota|capacity|command|transport|backend|tier|launch|lease/iu;
    for (const key of objectKeys({
      workload: first.workload,
      result_map: first.result_map,
    })) {
      expect(key, `provider-neutral handoff contains forbidden key '${key}'`).not.toMatch(
        forbiddenKey,
      );
    }

    const workloadPath = expectContained(
      root,
      first.workload_path,
      "workload_path",
    );
    const resultMapPath = expectContained(
      root,
      first.result_map_path,
      "result_map_path",
    );
    expectContained(artifactsDir, workloadPath, "workload_path");
    expectContained(artifactsDir, resultMapPath, "result_map_path");
    expect(JSON.parse(await readFile(workloadPath, "utf8"))).toEqual(
      first.workload,
    );
    expect(JSON.parse(await readFile(resultMapPath, "utf8"))).toEqual(
      first.result_map,
    );
    const workloadBytes = await readFile(workloadPath, "utf8");
    const resultMapBytes = await readFile(resultMapPath, "utf8");

    const permuted = await boundary.prepareAuditHostHandoff({
      root,
      artifactsDir,
      runId,
      tasks: [...tasks].reverse(),
    });
    expect(await readFile(permuted.workload_path, "utf8")).toBe(workloadBytes);
    expect(await readFile(permuted.result_map_path, "utf8")).toBe(
      resultMapBytes,
    );

    const itemA = first.workload.work_items.find(
      (entry) => entry.id === "audit-task-a",
    )!;
    const itemB = first.workload.work_items.find(
      (entry) => entry.id === "audit-task-b",
    )!;
    const resultA = expectContained(root, itemA.result_path, "result A");
    const resultB = expectContained(root, itemB.result_path, "result B");
    await mkdir(join(resultA, ".."), { recursive: true });

    // The legacy seam treated mere file existence as completion. Malformed bytes
    // must remain pending and must not change the published workload.
    await writeFile(resultA, "{ malformed", "utf8");
    const malformed = await boundary.prepareAuditHostHandoff({
      root,
      artifactsDir,
      runId,
      tasks,
    });
    expect(malformed.workload.work_items.map((entry) => entry.id)).toEqual(
      expectedIds,
    );
    expect(await readFile(malformed.workload_path, "utf8")).toBe(workloadBytes);
    const malformedIngest = await boundary.ingestAuditHostResults({
      root,
      artifactsDir,
      runId,
      auditTasks: tasks,
    });
    expect(malformedIngest.completed_work_item_ids).toEqual([]);

    // No directory scan/fallback may steal a valid result from an unbound path.
    await rm(resultA, { force: true });
    const unboundPath = join(resultA, "..", "unbound-result.json");
    await writeFile(unboundPath, JSON.stringify(boundResult(runId, itemA)), "utf8");
    const unboundIngest = await boundary.ingestAuditHostResults({
      root,
      artifactsDir,
      runId,
      auditTasks: tasks,
    });
    expect(unboundIngest.completed_work_item_ids).toEqual([]);

    for (const wrongBinding of [
      { run_id: "wrong-run" },
      { work_item_id: itemB.id },
      { prompt_sha256: "0".repeat(64) },
    ]) {
      await writeFile(
        resultA,
        JSON.stringify(boundResult(runId, itemA, wrongBinding)),
        "utf8",
      );
      const rejected = await boundary.ingestAuditHostResults({
        root,
        artifactsDir,
        runId,
        auditTasks: tasks,
      });
      expect(rejected.completed_work_item_ids).toEqual([]);
      const pending = await boundary.prepareAuditHostHandoff({
        root,
        artifactsDir,
        runId,
        tasks,
      });
      expect(pending.workload.work_items.map((entry) => entry.id)).toEqual(
        expectedIds,
      );
    }

    await writeFile(resultA, JSON.stringify(boundResult(runId, itemA)), "utf8");
    await writeFile(resultB, JSON.stringify(boundResult(runId, itemB)), "utf8");
    const accepted = await boundary.ingestAuditHostResults({
      root,
      artifactsDir,
      runId,
      auditTasks: tasks,
    });
    expect(accepted.accepted_count).toBe(2);
    expect([...accepted.completed_work_item_ids].sort()).toEqual(expectedIds);

    const beforeReplay = await snapshotTree(artifactsDir);
    const replay = await boundary.ingestAuditHostResults({
      root,
      artifactsDir,
      runId,
      auditTasks: tasks,
    });
    expect([...replay.completed_work_item_ids].sort()).toEqual(expectedIds);
    expect(await snapshotTree(artifactsDir)).toEqual(beforeReplay);

    // The drain's paused state: the caller hands the boundary the STILL-OWED
    // partition, and here that partition is empty because every task this run
    // owes has been accepted. The empty workload is therefore the caller's
    // statement, not the boundary's inference — the accepted ledger is never an
    // input to what is published (a bind that the ledger's own entries would
    // suppress is pinned by the sibling test below). What this pins is the
    // WRITE: an empty partition still republishes, so nothing is left on disk
    // advertising work that is no longer owed.
    const complete = await boundary.prepareAuditHostHandoff({
      root,
      artifactsDir,
      runId,
      tasks: [],
    });
    expect(complete.workload.work_items).toEqual([]);
    expect(complete.result_map.entries).toEqual([]);
    expect((await stat(complete.workload_path)).isFile()).toBe(true);
    expect((await stat(complete.result_map_path)).isFile()).toBe(true);

    // And the boundary republishes exactly the partition it is handed — here
    // one task whose acceptance is ALREADY on the ledger, because a re-plan
    // moved its ask and put it back in the owed set. Suppressing it on account
    // of that earlier acceptance is how a re-opened item becomes invisible to
    // replay; the ingest's own dedupe (work item × prompt digest) is what
    // decides whether an arrival is new, and it can only do that if the item is
    // published at all.
    const reopened = await boundary.prepareAuditHostHandoff({
      root,
      artifactsDir,
      runId,
      tasks: [tasks[0]!],
    });
    expect(reopened.workload.work_items.map((entry) => entry.id)).toEqual([
      "audit-task-b",
    ]);
    expect(reopened.result_map.entries.map((entry) => entry.work_item_id)).toEqual([
      "audit-task-b",
    ]);
  });

  it("never withholds a still-pending work item because an earlier acceptance of its binding is on the ledger", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "audit-host-reopen-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    const runId = "host-run-reopen";
    const tasks = [
      task(
        "audit-reopen-a",
        "security",
        "src/a.ts",
        { size: "small", complexity: "standard", risk: "high" },
        1200,
      ),
      task(
        "audit-reopen-b",
        "correctness",
        "src/b.ts",
        { size: "small", complexity: "standard", risk: "medium" },
        1200,
      ),
    ];
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
    await writeFile(join(root, "src", "b.ts"), "one\ntwo\n", "utf8");

    const first = await boundary.prepareAuditHostHandoff({
      root,
      artifactsDir,
      runId,
      tasks,
    });
    for (const item of first.workload.work_items) {
      await mkdir(join(root, item.result_path, ".."), { recursive: true });
      await writeFile(
        join(root, item.result_path),
        JSON.stringify(boundResult(runId, item)),
        "utf8",
      );
    }
    const accepted = await boundary.ingestAuditHostResults({
      root,
      artifactsDir,
      runId,
      auditTasks: tasks,
    });
    expect(accepted.accepted_count).toBe(2);

    // The wave re-opens `audit-reopen-a` — its accepted result went stale, so
    // the task is pending again — while `audit-reopen-b` stays settled.
    const reopened = await boundary.prepareAuditHostHandoff({
      root,
      artifactsDir,
      runId,
      tasks: [tasks[0]!],
    });

    expect(
      reopened.workload.work_items.map((entry) => entry.id),
      "a work item that is STILL PENDING must be published even though an earlier " +
        "binding for it sits on the accepted ledger — the ledger records what arrived, " +
        "it does not decide what is still owed",
    ).toEqual(["audit-reopen-a"]);
  });

  it("refuses a workload from a superseded contract version as a CLASSIFIED stale, never a bare parse throw", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "audit-host-handoff-stale-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    const runId = "host-run-stale";
    const tasks = [
      task(
        "audit-task-a",
        "security",
        "src/a.ts",
        { size: "medium", complexity: "deep", risk: "high" },
        2400,
      ),
    ];
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");

    const prepared = await boundary.prepareAuditHostHandoff({
      root,
      artifactsDir,
      runId,
      tasks,
    });

    // A v1alpha1 document is what this run directory holds when the tool is
    // upgraded underneath a live run: the file was minted by the PREVIOUS build
    // and its work items carry `{complexity, risk}` metadata instead of the
    // shared demand ranking. Its bytes are perfectly valid — under the version
    // they were written to — so nothing about them is "malformed".
    const stale = JSON.parse(await readFile(prepared.workload_path, "utf8")) as {
      contract_version: string;
      work_items: Array<Record<string, unknown>>;
    };
    stale.contract_version = "audit-host-workload/v1alpha1";
    for (const item of stale.work_items) {
      delete item.metadata;
      item.metadata = { complexity: "deep", risk: "high", token_estimate: 2400 };
    }
    await writeFile(prepared.workload_path, JSON.stringify(stale), "utf8");

    const summary = await boundary.ingestAuditHostResults({
      root,
      artifactsDir,
      runId,
      auditTasks: tasks,
    });

    // CLASSIFIED, and reachable: the refusal arrives as an issue the host can
    // read and act on, NOT as a stack thrown out of the fold.
    expect(summary.accepted_count).toBe(0);
    const refusal = summary.issues.find((issue) => issue.code === "workload_stale");
    expect(refusal, `issues: ${JSON.stringify(summary.issues)}`).toBeDefined();
    expect(refusal!.check).toBe("workload_binding");
    // It names BOTH versions — the one found and the one this build mints — and
    // the one repair, so the host is not left to infer any of the three.
    expect(refusal!.message).toContain("audit-host-workload/v1alpha1");
    expect(refusal!.message).toContain("audit-host-workload/v1alpha2");
    expect(refusal!.message).toContain("re-prepare");

    // RUN-SCOPED, deliberately: the refusal is about the workload DOCUMENT, not
    // about any one submission, so it names no work item. That is what makes it
    // distinct from the per-item refusals below — and it is why the recorder
    // (which keys the ledger on a submission id) skips it rather than inventing
    // an item to blame. The channel that carries it to the host is the fold's
    // advisory merge into the emitted step, which is fed `raw_issues`.
    expect(refusal!.work_item_id).toBeUndefined();
    expect(summary.raw_issues.map((issue) => issue.code)).toContain("workload_stale");
    expect(await readSubmissionLedger(artifactsDir)).toEqual([]);
  });
});
