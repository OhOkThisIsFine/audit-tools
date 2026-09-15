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
import { writeCoreArtifacts } from "../../src/audit/io/artifacts.js";
import { GATE_LANES, laneSubmissionPath } from "../../src/audit/cli/laneSubmissions.js";
import { submissionsDir } from "../../src/shared/io/auditToolsPaths.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import { EMPTY_REGISTER_BODY, REGISTER_V4_AFFIRMATION } from "../helpers/charterRegisterFixture.js";
import { declineDefaultAcquiredAnalyzers } from "../helpers/analyzerConsentFixture.js";
import { LENS_VERIFICATION_TAG } from "../../src/audit/orchestrator/selectiveDeepening/shared.js";

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
  /** The task's lane tags — what makes a work item's contract lane-aware. */
  readonly tags?: readonly string[];
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

/**
 * A core bundle at the PLANNING boundary: every obligation that precedes
 * `audit_tasks_completed` in the priority scan is satisfied, so a fold over it
 * reaches the review obligation. Built from the same shapes the audit draw's own
 * integration fixtures use — the deterministic registers state themselves
 * `omitted` at a shallow ceiling, which is what the real executors write for
 * them — rather than from a cast, so a required-field bump breaks here too.
 */
function readyForReviewBundle(
  reviewTask: HostTask,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const bundle = {
    repo_manifest: {
      repository: { name: "old-bindings-fold" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 8 }],
    },
    file_disposition: {
      files: [{ path: "src/a.ts", status: "included" }],
    },
    auto_fixes_applied: { fixes: [] },
    syntax_resolution_status: { resolved: true },
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { coverage: "not_applicable", analyzers: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [],
      contract_reviewed: true,
      conceptual_reviewed: true,
    },
    docs_digest: { generated_at: "2026-01-01T00:00:00.000Z", docs: [] },
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 0,
      source_ids: [],
      consensus: [],
      contested: [],
      findings: [],
    },
    charter_register: {
      schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "charter",
      ceiling: { rung: "shallow" },
      status: "omitted",
      ...EMPTY_REGISTER_BODY,
    },
    charter_clarification: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "charter_clarification",
      ceiling: { rung: "shallow" },
      attention: 0,
      status: "omitted",
      asked: [],
      banked: [],
      findings: [],
      validation_issues: [],
      ...REGISTER_V4_AFFIRMATION,
    },
    systemic_challenge: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "systemic_challenge",
      ceiling: { rung: "shallow" },
      status: "omitted",
      rounds: [],
      converged: true,
      findings: [],
      validation_issues: [],
      ...REGISTER_V4_AFFIRMATION,
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "full audit",
      intent_summary: "full-audit",
    },
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    requeue_tasks: [],
    audit_tasks: [
      {
        task_id: reviewTask.task_id,
        unit_id: reviewTask.unit_id,
        pass_id: reviewTask.pass_id,
        lens: reviewTask.lens,
        file_paths: [...reviewTask.file_paths],
        file_line_counts: { ...reviewTask.file_line_counts },
        rationale: reviewTask.rationale,
        priority: reviewTask.priority,
        token_estimate: reviewTask.token_estimate,
      },
    ],
    ...extra,
  };
  // Settle the DD-9 intent-equivalence baseline from the live checkpoint (the
  // deterministic first-contact arm), so `intent_equivalence_current` — which
  // sits directly after the checkpoint — is satisfied and the scan reaches the
  // review obligation rather than pausing on the equivalence gate.
  return {
    ...bundle,
    artifact_metadata: computeArtifactMetadata(bundle as never),
  };
}

function task(
  id: string,
  lens: string,
  path: string,
  demand: { size: string; complexity: string; risk: string },
  tokenEstimate: number,
  tags?: readonly string[],
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
    ...(tags ? { tags } : {}),
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

  // ── The steward lane's verification ask reaches a door that reads it ───────
  //
  // `buildVerificationFollowupTasks` consumes `verification` off an accepted
  // AuditResult, and the lens-verification task's own rationale INSTRUCTS the
  // host to "return findings: [] plus verification metadata with bounded
  // follow-up AuditTask suggestions". But the host-handoff envelope admitted
  // exactly seven keys — `verification` was not one of them — and
  // `toAuditResult` never mapped it, so the instruction named a deliverable no
  // door would accept. The steward lane is the ONLY lane whose contract asks
  // for it, and the tag that identifies that lane was dropped on the way in, so
  // the boundary could not even tell which contract to render.
  describe("the steward lane's verification contract", () => {
    // The lane token is the SHARED constant, not a literal: this fixture stands
    // in for the steward lane the orchestrator actually stamps, so a rename of
    // the constant must reach it at compile time rather than leaving the test
    // asserting against a token nothing mints any more.
    const STEWARD_TAGS = ["selective_deepening", LENS_VERIFICATION_TAG];

    async function publish(items: readonly HostTask[]) {
      const boundary = await loadBoundary();
      const root = await mkdtemp(join(tmpdir(), "audit-verification-lane-"));
      cleanupRoots.push(root);
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
      const artifactsDir = join(root, ".audit-tools", "audit");
      const runId = "audit-verification-lane";
      const prepared = await boundary.prepareAuditHostHandoff({
        root,
        artifactsDir,
        runId,
        tasks: items,
      });
      return { boundary, root, artifactsDir, runId, prepared };
    }

    it("renders the verification contract into a steward work item's prompt", async () => {
      const published = await publish([
        task(
          "audit-steward",
          "correctness",
          "src/a.ts",
          { size: "small", complexity: "standard", risk: "medium" },
          1200,
          STEWARD_TAGS,
        ),
        task(
          "audit-base",
          "correctness",
          "src/a.ts",
          { size: "small", complexity: "standard", risk: "medium" },
          1200,
        ),
      ]);
      const steward = published.prepared.workload.work_items.find(
        (item) => item.id === "audit-steward",
      )!;
      const base = published.prepared.workload.work_items.find(
        (item) => item.id === "audit-base",
      )!;

      // The ask and the envelope are the same fact: the steward prompt must
      // name `verification` as part of ITS result contract...
      expect(steward.prompt.text).toMatch(/an optional `verification` object/u);
      expect(steward.prompt.text).toMatch(/verification[^.]*followup_tasks/u);
      // ...and the base prompt must NOT carry that ask, because its envelope
      // refuses the field. Matched on the CONTRACT SENTENCE, not the bare word:
      // `verification_status` is a different field (a refused finding verdict)
      // and legitimately appears in both lanes' finding contracts.
      expect(base.prompt.text).not.toMatch(/an optional `verification` object/u);
      expect(base.prompt.text).not.toMatch(/verification[^.]*followup_tasks/u);
    });

    it("admits a steward submission carrying verification and threads it to the AuditResult", async () => {
      const published = await publish([
        task(
          "audit-steward",
          "correctness",
          "src/a.ts",
          { size: "small", complexity: "standard", risk: "medium" },
          1200,
          STEWARD_TAGS,
        ),
      ]);
      const item = published.prepared.workload.work_items[0]!;
      const resultPath = expectContained(
        published.root,
        item.result_path,
        "bound result",
      );
      await mkdir(join(resultPath, ".."), { recursive: true });
      await writeFile(
        resultPath,
        JSON.stringify(
          boundResult(published.runId, item, {
            // ALL SIX KEYS, because the prompt says "exactly" and the boundary
            // now enforces it: a genuine "nothing to report" is an empty array,
            // never an omitted field.
            verification: {
              verified: true,
              needs_followup: false,
              concerns: ["Packet looked clean."],
              coverage_concerns: [],
              confidence_concerns: [],
              followup_tasks: [],
            },
          }),
        ),
        "utf8",
      );

      const summary = await published.boundary.ingestAuditHostResults({
        root: published.root,
        artifactsDir: published.artifactsDir,
        runId: published.runId,
        auditTasks: [
          task(
            "audit-steward",
            "correctness",
            "src/a.ts",
            { size: "small", complexity: "standard", risk: "medium" },
            1200,
            STEWARD_TAGS,
          ),
        ],
      });
      expect(
        summary.accepted_count,
        `the steward submission must be accepted: ${JSON.stringify(summary.issues)}`,
      ).toBe(1);
      // THREADED, not merely admitted: the field has to reach the AuditResult
      // the ledger records, which is what the follow-up task builder reads.
      const accepted = (summary as unknown as {
        accepted_results?: readonly { verification?: unknown }[];
      }).accepted_results;
      expect(accepted?.[0]?.verification).toBeDefined();
    });

    it("refuses verification on a base-lane item whose contract never asked for it", async () => {
      const published = await publish([
        task(
          "audit-base",
          "correctness",
          "src/a.ts",
          { size: "small", complexity: "standard", risk: "medium" },
          1200,
        ),
      ]);
      const item = published.prepared.workload.work_items[0]!;
      const resultPath = expectContained(
        published.root,
        item.result_path,
        "bound result",
      );
      await mkdir(join(resultPath, ".."), { recursive: true });
      await writeFile(
        resultPath,
        JSON.stringify(
          boundResult(published.runId, item, {
            verification: {
              verified: true,
              needs_followup: false,
              concerns: [],
              coverage_concerns: [],
              confidence_concerns: [],
              followup_tasks: [],
            },
          }),
        ),
        "utf8",
      );

      const summary = await published.boundary.ingestAuditHostResults({
        root: published.root,
        artifactsDir: published.artifactsDir,
        runId: published.runId,
        auditTasks: [
          task(
            "audit-base",
            "correctness",
            "src/a.ts",
            { size: "small", complexity: "standard", risk: "medium" },
            1200,
          ),
        ],
      });
      expect(summary.accepted_count).toBe(0);
      const issue = summary.issues.find(
        (entry) => entry.work_item_id === "audit-base",
      );
      expect(issue, `issues: ${JSON.stringify(summary.issues)}`).toBeDefined();
      // The scan wraps the draw's contract refusal, so the OUTER code is the
      // scan's; the draw's own classification rides the message. Asserted the
      // same way the sibling diagnostics tests do.
      expect(issue!.code).toBe("submission_contract_invalid");
      // The LANE gate's own words: the fixture above satisfies every G2 rule, so
      // only the lane gate can refuse it, and a G2 message cannot stand in.
      expect(issue!.message).toMatch(/does not request it/u);
    });

    // ── The prompt's claims about `verification` are ENFORCED, not asserted ───
    //
    // The steward prompt states the exact key set, the needs_followup rule, the
    // lens equality and the file-path containment. Each is enforced at this same
    // boundary; the tests below break ONE stated property at a time and require
    // the submission to be refused, so a claim in the prompt with no check behind
    // it cannot come back. Every case seeds a structurally valid result and
    // varies only the field under test, so a green run means THAT check held.
    const stewardItem = (
      published: Awaited<ReturnType<typeof publish>>,
    ) => published.prepared.workload.work_items[0]!;

    async function submitVerification(
      verification: unknown,
    ): Promise<IngestSummary> {
      const published = await publish([
        task(
          "audit-steward",
          "correctness",
          "src/a.ts",
          { size: "small", complexity: "standard", risk: "medium" },
          1200,
          STEWARD_TAGS,
        ),
      ]);
      const item = stewardItem(published);
      const resultPath = expectContained(
        published.root,
        item.result_path,
        "bound result",
      );
      await mkdir(join(resultPath, ".."), { recursive: true });
      await writeFile(
        resultPath,
        JSON.stringify(
          boundResult(published.runId, item, { verification }),
        ),
        "utf8",
      );
      return published.boundary.ingestAuditHostResults({
        root: published.root,
        artifactsDir: published.artifactsDir,
        runId: published.runId,
        auditTasks: [
          task(
            "audit-steward",
            "correctness",
            "src/a.ts",
            { size: "small", complexity: "standard", risk: "medium" },
            1200,
            STEWARD_TAGS,
          ),
        ],
      });
    }

    function expectRefused(summary: IngestSummary, expected: RegExp): string {
      expect(
        summary.accepted_count,
        `must be refused, got: ${JSON.stringify(summary.issues)}`,
      ).toBe(0);
      const message = summary.issues[0]?.message ?? "";
      expect(message).toMatch(expected);
      return message;
    }

    const VALID_VERIFICATION = {
      verified: true,
      needs_followup: false,
      concerns: [],
      coverage_concerns: [],
      confidence_concerns: [],
      followup_tasks: [],
    };

    it("refuses a verification object missing one of the stated keys", async () => {
      const { followup_tasks: _omitted, ...missing } = VALID_VERIFICATION;
      expectRefused(
        await submitVerification(missing),
        /missing followup_tasks/u,
      );
    });

    it("refuses a verification object carrying a key the prompt never listed", async () => {
      expectRefused(
        await submitVerification({ ...VALID_VERIFICATION, hunches: ["x"] }),
        /unexpected hunches/u,
      );
    });

    it("refuses needs_followup true with no bounded follow-up task", async () => {
      expectRefused(
        await submitVerification({
          ...VALID_VERIFICATION,
          needs_followup: true,
        }),
        /needs_followup is true but followup_tasks is empty/u,
      );
    });

    it("refuses a follow-up task whose lens is not this task's lens", async () => {
      expectRefused(
        await submitVerification({
          ...VALID_VERIFICATION,
          needs_followup: true,
          followup_tasks: [
            {
              task_id: "f1",
              unit_id: "u1",
              pass_id: "p1",
              lens: "security",
              file_paths: ["src/a.ts"],
              rationale: "check the other lens",
            },
          ],
        }),
        /lens must equal the task's lens/u,
      );
    });

    it("refuses a follow-up task naming a file outside the work item's coverage and boundary", async () => {
      expectRefused(
        await submitVerification({
          ...VALID_VERIFICATION,
          needs_followup: true,
          followup_tasks: [
            {
              task_id: "f1",
              unit_id: "u1",
              pass_id: "p1",
              lens: "correctness",
              file_paths: ["src/elsewhere.ts"],
              rationale: "outside the packet",
            },
          ],
        }),
        /outside this work item's file_coverage or packet boundary/u,
      );
    });

    it("refuses a follow-up task carrying a key the prompt never listed", async () => {
      expectRefused(
        await submitVerification({
          ...VALID_VERIFICATION,
          needs_followup: true,
          followup_tasks: [
            {
              task_id: "f1",
              unit_id: "u1",
              pass_id: "p1",
              lens: "correctness",
              file_paths: ["src/a.ts"],
              rationale: "bounded",
              extra: true,
            },
          ],
        }),
        /unexpected extra/u,
      );
    });

    it("accepts a follow-up task that satisfies every stated rule", async () => {
      const summary = await submitVerification({
        ...VALID_VERIFICATION,
        needs_followup: true,
        followup_tasks: [
          {
            task_id: "f1",
            unit_id: "u1",
            pass_id: "p1",
            lens: "correctness",
            file_paths: ["src/a.ts"],
            rationale: "bounded follow-up inside the packet",
          },
        ],
      });
      expect(
        summary.accepted_count,
        `the conforming verification must be accepted: ${JSON.stringify(summary.issues)}`,
      ).toBe(1);
    });

    it("refuses a follow-up task whose file_paths list is empty", async () => {
      expectRefused(
        await submitVerification({
          ...VALID_VERIFICATION,
          needs_followup: true,
          followup_tasks: [
            {
              task_id: "f1",
              unit_id: "u1",
              pass_id: "p1",
              lens: "correctness",
              file_paths: [],
              rationale: "unbounded",
            },
          ],
        }),
        /file_paths must be a non-empty array/u,
      );
    });

    // ── Both doors build the containment set through ONE rule ────────────────
    //
    // The host door (`verificationAllowedPathsForEnvelope`) and the batch door
    // (`validateVerification`) judge the same property — a follow-up task's
    // `file_paths` must lie inside the packet. They were built separately and
    // agreed only because no production caller passes `boundaryPaths`, which is
    // agreement by an accidentally-absent input. Both now call
    // `verificationAllowedPaths`, so the property below holds by construction
    // rather than by the two constructions happening to coincide.
    it("the host door and the batch door judge follow-up containment the same way", async () => {
      const { verificationAllowedPaths, validateOneAuditResult } = await import(
        "../../src/audit/validation/auditResults.js"
      );
      // The SAME inputs each door really has: the host door sees the binding's
      // file set plus the envelope's coverage; the batch door sees the result's
      // coverage plus the packet boundary. With no boundary passed, one path
      // inside the coverage and one outside must land the same way at both.
      const inside = "src/a.ts";
      // The work item's ASSIGNED set is wider than its reported coverage — the
      // ordinary case for a binding whose item did not report every assigned
      // file. That difference is what makes the two SOURCES distinguishable: a
      // rule that dropped one of them would answer differently here.
      const assignedOnly = "src/assigned-but-not-covered.ts";
      const outside = "src/zzz.ts";
      const coverage = [{ path: "src/a.ts", reviewed_lines: 2, total_lines: 2 }];

      const hostDoorAllowed = verificationAllowedPaths({
        assignedPaths: ["src/a.ts", assignedOnly],
        coveragePaths: coverage.map((entry) => entry.path),
      });
      const batchDoorAllowed = verificationAllowedPaths({
        coveragePaths: coverage.map((entry) => entry.path),
      });

      // ANCHORED to a literal, not merely to the other door: comparing the two
      // doors to each other would move BOTH when the shared rule changes, so it
      // cannot detect a rule that quietly dropped a source. This states what
      // the set must actually contain for the inputs above.
      expect([...hostDoorAllowed].sort()).toEqual([
        inside,
        assignedOnly,
      ]);
      expect(hostDoorAllowed.has(outside)).toBe(false);
      // …and the doors AGREE on that path: the host door has it from the
      // binding, the batch door does not have it from coverage alone, and the
      // difference is a SOURCE the caller supplied, never a rule that differs.
      // Asserted as an explicit expectation so a rule that dropped a source is
      // red rather than silently matching.
      expect(batchDoorAllowed.has(assignedOnly)).toBe(false);
      expect(batchDoorAllowed.has(inside)).toBe(true);
      expect(batchDoorAllowed.has(outside)).toBe(false);

      // …and asserted through a DOOR, not just the helper: the batch validator
      // refuses the same out-of-boundary follow-up the host door refuses above.
      const result = {
        task_id: "audit-steward",
        unit_id: "unit-audit-steward",
        pass_id: "pass:correctness",
        lens: "correctness",
        run_id: "audit-both-doors",
        reviewed_clean: false,
        file_coverage: [
          { path: "src/a.ts", reviewed_lines: 2, total_lines: 2 },
        ],
        findings: [],
        verification: {
          verified: true,
          needs_followup: true,
          concerns: [],
          coverage_concerns: [],
          confidence_concerns: [],
          followup_tasks: [
            {
              task_id: "f1",
              unit_id: "u1",
              pass_id: "p1",
              lens: "correctness",
              file_paths: [outside],
              rationale: "outside the packet",
            },
          ],
        },
      };
      const issues = validateOneAuditResult(
        result as never,
        [
          {
            task_id: "audit-steward",
            unit_id: "unit-audit-steward",
            pass_id: "pass:correctness",
            lens: "correctness",
            file_paths: ["src/a.ts"],
            rationale: "Review src/a.ts",
            priority: "medium",
            tags: [...STEWARD_TAGS],
          } as never,
        ],
        {},
      );
      expect(
        issues.some((issue) => /outside the verification task's file_coverage/u.test(issue.message)),
        `the batch door must refuse the same path: ${JSON.stringify(issues)}`,
      ).toBe(true);
      // The host door refuses it too, with its own words — one rule, two doors.
      expectRefused(
        await submitVerification({
          ...VALID_VERIFICATION,
          needs_followup: true,
          followup_tasks: [
            {
              task_id: "f1",
              unit_id: "u1",
              pass_id: "p1",
              lens: "correctness",
              file_paths: [outside],
              rationale: "outside the packet",
            },
          ],
        }),
        /outside this work item's file_coverage or packet boundary/u,
      );
    });

    // The cross-reader check the LENS_VERIFICATION_TAG comment names: the tag
    // this boundary gates on must be the tag the CONSUMER gates on. Both sides
    // read the shared constant, so this asserts the property rather than the
    // spelling — if the boundary admitted on one token and the follow-up builder
    // filtered on another, the accepted object would be silently discarded.
    it("a steward submission carrying verification is accepted AND BUILT INTO follow-up tasks", async () => {
      const summary = await submitVerification({
        ...VALID_VERIFICATION,
        needs_followup: true,
        followup_tasks: [
          {
            task_id: "f1",
            unit_id: "u1",
            pass_id: "p1",
            lens: "correctness",
            file_paths: ["src/a.ts"],
            rationale: "bounded follow-up inside the packet",
          },
        ],
      });
      expect(
        summary.accepted_count,
        `must be accepted: ${JSON.stringify(summary.issues)}`,
      ).toBe(1);
      const accepted = (
        summary as unknown as {
          accepted_results?: Parameters<
            typeof import("../../src/audit/orchestrator/selectiveDeepening/stewardFollowup.js")["buildVerificationFollowupTasks"]
          >[0]["result"][];
        }
      ).accepted_results;
      expect(accepted).toHaveLength(1);
      const { buildVerificationFollowupTasks } = await import(
        "../../src/audit/orchestrator/selectiveDeepening/stewardFollowup.js"
      );
      const followups = buildVerificationFollowupTasks({
        result: accepted![0]!,
        // The CONSUMER's own view of the lane: an `AuditTask` tagged with the
        // lane tag. Built from the shared constant the boundary imports, so the
        // two sides are compared on the token they both actually read.
        task: {
          task_id: "audit-steward",
          unit_id: "unit-audit-steward",
          pass_id: "pass:correctness",
          lens: "correctness",
          file_paths: ["src/a.ts"],
          rationale: "Review src/a.ts",
          priority: "medium",
          tags: [...STEWARD_TAGS],
        },
      });
      expect(
        followups.length,
        "the metadata the boundary admitted must be the metadata the consumer reads",
      ).toBe(1);
      expect(followups[0]!.file_paths).toEqual(["src/a.ts"]);
    });
  });

  // ── A binding persisted by the PREVIOUS contract version still fails closed ─
  //
  // The lane stamp is persisted on the task binding so the ingest can tell which
  // contract an item's prompt carried; a run prepared by an older build holds
  // bindings WITHOUT it. Under one version string the new reader would refuse
  // that run with a generic shape error, on work the host has already executed.
  // The version moves with the shape instead, and the refusal names the remedy.
  it("refuses a binding set written under an older contract version as a CLASSIFIED stale", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "audit-host-old-bindings-"));
    cleanupRoots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
    const artifactsDir = join(root, ".audit-tools", "audit");
    const runId = "audit-old-bindings";
    const published = await boundary.prepareAuditHostHandoff({
      root,
      artifactsDir,
      runId,
      tasks: [
        task(
          "audit-old",
          "correctness",
          "src/a.ts",
          { size: "small", complexity: "standard", risk: "medium" },
          1200,
        ),
      ],
    });
    const item = published.workload.work_items[0]!;
    const resultPath = expectContained(root, item.result_path, "bound result");
    await mkdir(join(resultPath, ".."), { recursive: true });
    await writeFile(
      resultPath,
      JSON.stringify(boundResult(runId, item)),
      "utf8",
    );

    // Rewrite the persisted binding set to the OLD shape: the previous version
    // string, and entries with no `tags` field at all.
    const bindingsPath = join(
      root,
      ".audit-tools",
      "audit",
      "runs",
      runId,
      "host-task-bindings.json",
    );
    const bindings = JSON.parse(await readFile(bindingsPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    for (const entry of bindings.entries) delete entry.tags;
    await writeFile(
      bindingsPath,
      JSON.stringify({
        ...bindings,
        contract_version: "audit-host-task-bindings/v1alpha1",
      }),
      "utf8",
    );

    // REFUSED as stale — a classified issue on the ingest's own vocabulary, not
    // a throw and not a shape refusal. The host's already-written result is
    // neither accepted nor re-bound here: nothing can be judged against a
    // contract this build did not mint. (The FOLD then re-prepares in the same
    // call, which is asserted by the next test.)
    const summary = await boundary.ingestAuditHostResults({
      root,
      artifactsDir,
      runId,
      auditTasks: [
        task(
          "audit-old",
          "correctness",
          "src/a.ts",
          { size: "small", complexity: "standard", risk: "medium" },
          1200,
        ),
      ],
    });
    expect(summary.accepted_count).toBe(0);
    const refusal = summary.issues.find(
      (issue) => issue.code === "workload_stale",
    );
    expect(refusal, `issues: ${JSON.stringify(summary.issues)}`).toBeDefined();
    expect(refusal!.check).toBe("workload_binding");
    // It names BOTH versions — the one found and the one this build mints — and
    // states what the tool does next, so the host is not left to act on it.
    expect(refusal!.message).toContain("audit-host-task-bindings/v1alpha1");
    expect(refusal!.message).toContain("audit-host-task-bindings/v1alpha2");
    expect(refusal!.message).toContain("re-prepares the workload");
  });

  // ── …and the FOLD turns that refusal into a re-prepare, never a wedge ─────
  //
  // The refusal above is only sound where something downstream re-prepares. On
  // the real fold the ingest sits BEFORE `ensureSemanticReviewRunUnlocked` — the
  // one path to `prepareAuditHostHandoff`, the only writer of the bindings file
  // — and the fold's catch rethrows everything that is not ENOENT. So a bare
  // throw here aborted the fold before the re-prepare, the blocked-step backstop
  // wrote a blocked step and rethrew, and EVERY later `next-step` failed the
  // same way with the bindings file still at the old version. The run was wedged
  // by a file the tool had written itself.
  it("re-prepares the workload and advances when the persisted bindings are the old version", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-host-old-bindings-fold-"));
    cleanupRoots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"old-bindings"}\n', "utf8");
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
    // The CLI entry loads the analyzer policy from the session artifacts before
    // it folds; declining the acquired set is the shape every other CLI-driving
    // fixture uses, and keeps acquisition a hermetic no-op. The NON-default
    // candidates are offered through the `analyzer_consent` lane, which fires
    // ahead of the fold — answering it here is what lets this test reach the
    // obligation under test rather than pausing on the offer.
    await declineDefaultAcquiredAnalyzers(root);
    await mkdir(submissionsDir(join(root, ".audit-tools", "audit")), {
      recursive: true,
    });
    await writeFile(
      laneSubmissionPath(
        join(root, ".audit-tools", "audit"),
        GATE_LANES.analyzer_consent,
      ),
      JSON.stringify({
        semgrep: "declined",
        eslint: "declined",
        knip: "declined",
        jscpd: "declined",
        "osv-scanner": "declined",
      }) + "\n",
      "utf8",
    );
    await writeFile(
      laneSubmissionPath(
        join(root, ".audit-tools", "audit"),
        GATE_LANES.analyzer_decisions,
      ),
      JSON.stringify({ typescript: "skip" }) + "\n",
      "utf8",
    );
    const artifactsDir = join(root, ".audit-tools", "audit");
    // This fixture's deterministic flow inference falls below the confidence
    // bar, so the drain would halt at critical_flow_fallback long before the
    // review obligation. Pre-satisfy it with the empty host submission the
    // gate lane is bound to, exactly as the other fold-driving fixtures do.
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    await writeFile(
      laneSubmissionPath(artifactsDir, GATE_LANES.critical_flow_fallback),
      JSON.stringify({ flows: [] }, null, 2) + "\n",
      "utf8",
    );
    // A LEGACY clock-format id, so the review pause ADOPTS this run rather than
    // minting a new one — that is the in-flight run the wedge stranded, and the
    // one whose bindings file the re-prepare must rewrite in place.
    const runId = "20260722T101112123Z_audit-old-bindings_001";
    const oldTask = task(
      "audit-old",
      "correctness",
      "src/a.ts",
      { size: "small", complexity: "standard", risk: "medium" },
      1200,
    );

    // The run the PREVIOUS build left behind: a core bundle at the planning
    // boundary (every obligation above `audit_tasks_completed` satisfied, so the
    // drain reaches the review obligation within the budget), the active
    // review-run manifest, its pending-task list — plus the binding set that
    // build wrote, which has no `tags` and an older version.
    await writeCoreArtifacts(artifactsDir, readyForReviewBundle(oldTask), {
      prune: true,
    });
    const runDir = join(artifactsDir, "runs", runId);
    await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
    await mkdir(runDir, { recursive: true });
    const runManifest = {
      contract_version: "audit-review-run/v1alpha1",
      run_id: runId,
      review_run_path: join(runDir, "review-run.json"),
      pending_audit_tasks_path: join(runDir, "pending-audit-tasks.json"),
      host_workload_path: join(runDir, "host-workload.json"),
      host_result_map_path: join(runDir, "host-result-map.json"),
    };
    await writeFile(
      join(artifactsDir, "dispatch", "current-review-run.json"),
      JSON.stringify(runManifest),
      "utf8",
    );
    await writeFile(
      runManifest.pending_audit_tasks_path,
      JSON.stringify([oldTask]),
      "utf8",
    );

    // The workload and result map are CURRENT — published through the real
    // boundary, at the real paths — so the only thing the previous build left
    // stale is the lane stamp. That is what isolates this test: were the
    // workload absent, the ingest would fail ENOENT and the fold's existing
    // missing-file arm would re-prepare no matter how a stale binding set is
    // classified.
    const boundary = await loadBoundary();
    const published = await boundary.prepareAuditHostHandoff({
      root,
      artifactsDir,
      runId,
      tasks: [oldTask],
    });
    expect(published.workload.work_items).toHaveLength(1);

    // …and now downgrade the persisted binding set to what the OLD build wrote:
    // the previous version string, and entries with no `tags` field at all.
    const bindingsPath = join(runDir, "host-task-bindings.json");
    const bindings = JSON.parse(await readFile(bindingsPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    for (const entry of bindings.entries) delete entry.tags;
    await writeFile(
      bindingsPath,
      JSON.stringify({
        ...bindings,
        contract_version: "audit-host-task-bindings/v1alpha1",
      }),
      "utf8",
    );

    // THE REAL ENTRY POINT, not the helper: `runDeterministicForNextStep`
    // returns the PLAN, and the re-prepare lives in the emission the CLI entry
    // performs (`cmdNextStep` → `writeAuditStep` → `renderSemanticReviewStep` →
    // `prepareAuditHostHandoff`). Driving the helper would leave the file
    // untouched no matter how the ingest classified it.
    const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");
    await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);

    // (1) It did NOT throw — the wedge is gone. (2) The step it wrote is a live
    //     host step, not the blocked contract the wedge produced.
    const step = JSON.parse(
      await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
    ) as { step_kind: string; status: string };
    expect(step.step_kind, JSON.stringify(step)).toBe("dispatch_review");
    expect(step.status).toBe("ready");
    // (3) The binding set is at the CURRENT version afterwards: the fold reached
    //     the re-prepare, so the next ingest reads a contract it understands.
    const reparsed = JSON.parse(await readFile(bindingsPath, "utf8")) as {
      contract_version: string;
      entries: Array<Record<string, unknown>>;
    };
    expect(reparsed.contract_version).toBe("audit-host-task-bindings/v1alpha2");
    expect(reparsed.entries[0]!.tags).toEqual([]);
  });
});
