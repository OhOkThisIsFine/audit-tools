import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const FAILURE_SIGNATURE =
  "contract:remediation-zero-adapter-boundary:not-yet-satisfied";
const CURRENT_STATE_VERSION = "remediate-code-state/v1alpha1";
const BASELINE_COMMIT = "1".repeat(40);
const AFTER_COMMIT = "2".repeat(40);

interface HostBlock {
  readonly block_id: string;
  readonly items: readonly string[];
  readonly parallel_safe: boolean;
  readonly dependencies: readonly string[];
  readonly touched_files: readonly string[];
  readonly targeted_commands?: readonly string[];
  readonly phase_ordinal: number;
  readonly token_estimate: number;
}

interface HostWorkItem {
  readonly id: string;
  readonly finding_ids: readonly string[];
  readonly allowed_files: readonly string[];
  readonly baseline_commit: string;
  readonly prompt: { readonly sha256: string; readonly text: string };
  readonly required_tests: readonly string[];
  readonly result_path: string;
  readonly token_estimate: number;
}

interface HostWorkload {
  readonly contract_version: "remediation-host-workload/v1alpha1";
  readonly run_id: string;
  readonly work_items: readonly HostWorkItem[];
}

interface CurrentState {
  readonly contract_version: typeof CURRENT_STATE_VERSION;
  readonly status: "implementing";
  readonly plan: Readonly<Record<string, unknown>> & {
    readonly blocks: readonly HostBlock[];
  };
  readonly items: Readonly<
    Record<string, { readonly finding_id: string; readonly block_id: string; readonly status: string }>
  >;
}

interface PreparedHandoff {
  readonly workload: HostWorkload;
  readonly workload_path: string;
}

interface IngestSummary {
  readonly accepted_count: number;
  readonly completed_work_item_ids: readonly string[];
  readonly state: CurrentState;
}

type UnsupportedState = "unsupported_retired_state";

interface HostBoundary {
  readonly prepareRemediationHostHandoff: (input: {
    readonly root: string;
    readonly artifactsDir: string;
    readonly runId: string;
    readonly baselineCommit: string;
    readonly state: unknown;
  }) => Promise<PreparedHandoff | UnsupportedState>;
  readonly ingestRemediationHostResults: (input: {
    readonly root: string;
    readonly artifactsDir: string;
    readonly runId: string;
    readonly state: unknown;
  }) => Promise<IngestSummary | UnsupportedState>;
}

interface SchedulerBoundary {
  readonly hostDependencyLevels: (
    state: unknown,
  ) => readonly (readonly HostBlock[])[];
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
      "../../src/remediate/steps/dispatch.js"
    )) as unknown as Partial<HostBoundary>;
    if (
      typeof loaded.prepareRemediationHostHandoff !== "function" ||
      typeof loaded.ingestRemediationHostResults !== "function"
    ) {
      throw new Error(
        "prepareRemediationHostHandoff/ingestRemediationHostResults exports are absent",
      );
    }
    return loaded as HostBoundary;
  } catch (error) {
    throw new Error(`${FAILURE_SIGNATURE}: ${String(error)}`, { cause: error });
  }
}

async function loadScheduler(): Promise<SchedulerBoundary> {
  const loaded = (await import(
    "../../src/remediate/steps/nextStep.js"
  )) as unknown as Partial<SchedulerBoundary>;
  if (typeof loaded.hostDependencyLevels !== "function") {
    throw new Error(`${FAILURE_SIGNATURE}: hostDependencyLevels is absent`);
  }
  return loaded as SchedulerBoundary;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectContained(root: string, path: string, label: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(resolve(root), absolute).replaceAll("\\", "/");
  expect(rel, `${label} must stay beneath the supplied root`).not.toMatch(
    /^(?:\.\.(?:\/|$)|\/)/u,
  );
  return absolute;
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)]);
}

async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const entries: Array<readonly [string, string]> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
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

function finding(id: string, path: string): Record<string, unknown> {
  return {
    id,
    title: `Fix ${id}`,
    category: "correctness",
    severity: "high",
    confidence: "high",
    lens: "correctness",
    summary: `Repair ${path}`,
    affected_files: [{ path }],
    evidence: [`${path}:1`],
  };
}

function block(
  id: string,
  findingId: string,
  path: string,
  options: { dependencies?: string[]; phase?: number } = {},
): HostBlock {
  return {
    block_id: id,
    items: [findingId],
    parallel_safe: true,
    dependencies: options.dependencies ?? [],
    targeted_commands: [`npx vitest run tests/${findingId}.test.ts`],
    touched_files: [path],
    phase_ordinal: options.phase ?? 0,
    token_estimate: 1_800,
  };
}

function currentState(): CurrentState {
  const blocks = [
    block("block-b", "finding-b", "src/b.ts"),
    block("block-a", "finding-a", "src/a.ts"),
    block("block-dependent", "finding-c", "src/c.ts", {
      dependencies: ["block-a", "block-b"],
    }),
    block("block-phase-1", "finding-d", "src/d.ts", { phase: 1 }),
  ];
  return {
    contract_version: CURRENT_STATE_VERSION,
    status: "implementing",
    plan: {
      plan_id: "plan-host-handoff",
      findings: [
        finding("finding-a", "src/a.ts"),
        finding("finding-b", "src/b.ts"),
        finding("finding-c", "src/c.ts"),
        finding("finding-d", "src/d.ts"),
      ],
      blocks,
      project_type: "typescript",
      candidate_closing_actions: ["none"],
    },
    items: Object.fromEntries(
      blocks.map((entry) => {
        const findingId = entry.items[0]!;
        return [
          findingId,
          { finding_id: findingId, block_id: entry.block_id, status: "pending" },
        ];
      }),
    ),
  };
}

function requirePrepared(
  value: PreparedHandoff | UnsupportedState,
): PreparedHandoff {
  expect(value).not.toBe("unsupported_retired_state");
  return value as PreparedHandoff;
}

function requireIngested(
  value: IngestSummary | UnsupportedState,
): IngestSummary {
  expect(value).not.toBe("unsupported_retired_state");
  return value as IngestSummary;
}

function validResult(
  runId: string,
  item: HostWorkItem,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const changedFiles = [item.allowed_files[0]!];
  return {
    contract_version: "remediation-host-result/v1alpha1",
    result_id: `result-${item.id}`,
    run_id: runId,
    work_item_id: item.id,
    prompt_sha256: item.prompt.sha256,
    changed_files: changedFiles,
    commit_evidence: { before: item.baseline_commit, after: AFTER_COMMIT },
    test_evidence: item.required_tests.map((command) => ({
      command,
      status: "passed",
    })),
    worktree_evidence: {
      baseline_commit: item.baseline_commit,
      changed_files: changedFiles,
    },
    acceptance: { status: "accepted" },
    merge: { status: "merged" },
    ...overrides,
  };
}

async function prepareFixture(): Promise<{
  boundary: HostBoundary;
  root: string;
  artifactsDir: string;
  runId: string;
  state: CurrentState;
  handoff: PreparedHandoff;
}> {
  const boundary = await loadBoundary();
  const root = await mkdtemp(join(tmpdir(), "remediation-host-handoff-"));
  cleanupRoots.push(root);
  const artifactsDir = join(root, ".audit-tools", "remediation");
  const runId = "remediation-run-fixture";
  const state = currentState();
  const handoff = requirePrepared(
    await boundary.prepareRemediationHostHandoff({
      root,
      artifactsDir,
      runId,
      baselineCommit: BASELINE_COMMIT,
      state,
    }),
  );
  return { boundary, root, artifactsDir, runId, state, handoff };
}

describe(FAILURE_SIGNATURE, () => {
  it("emits exactly hostDependencyLevels(state)[0] as a provider-neutral, bound handoff", async () => {
    const scheduler = await loadScheduler();
    const { root, artifactsDir, runId, state, handoff } = await prepareFixture();
    const expected = (scheduler.hostDependencyLevels(state)[0] ?? [])
      .map((entry) => entry.block_id)
      .sort();
    expect(expected).toEqual(["block-a", "block-b"]);
    expect(handoff.workload.contract_version).toBe(
      "remediation-host-workload/v1alpha1",
    );
    expect(handoff.workload.run_id).toBe(runId);
    expect(handoff.workload.work_items.map((entry) => entry.id)).toEqual(expected);
    expect(handoff.workload.work_items.map((entry) => entry.id)).not.toContain(
      "block-dependent",
    );
    expect(handoff.workload.work_items.map((entry) => entry.id)).not.toContain(
      "block-phase-1",
    );

    for (const item of handoff.workload.work_items) {
      const source = state.plan.blocks.find((entry) => entry.block_id === item.id)!;
      expect(item.finding_ids).toEqual(source.items);
      expect(item.allowed_files).toEqual([...source.touched_files].sort());
      expect(item.required_tests).toEqual(source.targeted_commands);
      expect(item.token_estimate).toBe(source.token_estimate);
      expect(item.baseline_commit).toBe(BASELINE_COMMIT);
      expect(item.prompt.sha256).toBe(sha256(item.prompt.text));
      expect(item.prompt.text).toContain(item.id);
      expect(item.prompt.text).toContain(item.allowed_files[0]);
      expect(item.prompt.text).toContain(item.required_tests[0]);
      expect(isAbsolute(item.result_path)).toBe(false);
      expectContained(artifactsDir, expectContained(root, item.result_path, "result"), "result");
    }

    const forbidden =
      /api_key|backend|command_template|endpoint|headless|lease|model|pool|provider|quota|routing|spawn|transport|worker_command/iu;
    for (const key of collectKeys(handoff.workload)) {
      expect(key, `provider-neutral handoff contains forbidden key '${key}'`).not.toMatch(
        forbidden,
      );
    }
    const workloadPath = expectContained(root, handoff.workload_path, "workload");
    expectContained(artifactsDir, workloadPath, "workload");
    expect(JSON.parse(await readFile(workloadPath, "utf8"))).toEqual(
      handoff.workload,
    );
  });

  it("accepts only complete run/block/prompt/worktree/commit/test/scope/merge evidence", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff } =
      await prepareFixture();
    const [first, second] = handoff.workload.work_items;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const firstPath = expectContained(root, first!.result_path, "first result");
    const secondPath = expectContained(root, second!.result_path, "second result");
    await mkdir(resolve(firstPath, ".."), { recursive: true });

    const missing = requireIngested(
      await boundary.ingestRemediationHostResults({
        root,
        artifactsDir,
        runId,
        state,
      }),
    );
    expect(missing.accepted_count).toBe(0);
    expect(missing.state.items[first!.finding_ids[0]!]!.status).toBe("pending");

    await writeFile(firstPath, "{ malformed", "utf8");
    const malformed = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
    );
    expect(malformed.completed_work_item_ids).toEqual([]);

    const invalidResults: Record<string, unknown>[] = [
      validResult(runId, first!, { contract_version: "retired/v0" }),
      validResult(runId, first!, { run_id: "wrong-run" }),
      validResult(runId, first!, { work_item_id: second!.id }),
      validResult(runId, first!, { prompt_sha256: "0".repeat(64) }),
      validResult(runId, first!, { changed_files: ["src/outside.ts"] }),
      validResult(runId, first!, {
        commit_evidence: { before: "0".repeat(40), after: AFTER_COMMIT },
      }),
      validResult(runId, first!, {
        commit_evidence: { before: BASELINE_COMMIT, after: BASELINE_COMMIT },
      }),
      validResult(runId, first!, { test_evidence: [] }),
      validResult(runId, first!, {
        test_evidence: first!.required_tests.map((command) => ({
          command,
          status: "failed",
        })),
      }),
      validResult(runId, first!, {
        worktree_evidence: {
          baseline_commit: "0".repeat(40),
          changed_files: [first!.allowed_files[0]],
        },
      }),
      validResult(runId, first!, {
        worktree_evidence: {
          baseline_commit: BASELINE_COMMIT,
          changed_files: [],
        },
      }),
      validResult(runId, first!, { acceptance: { status: "rejected" } }),
      validResult(runId, first!, { merge: { status: "pending" } }),
      validResult(runId, first!, { unexpected_legacy_field: true }),
    ];
    for (const invalid of invalidResults) {
      await writeFile(firstPath, JSON.stringify(invalid), "utf8");
      const rejected = requireIngested(
        await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
      );
      expect(rejected.accepted_count).toBe(0);
      expect(rejected.completed_work_item_ids).toEqual([]);
      expect(rejected.state.items[first!.finding_ids[0]!]!.status).toBe("pending");
    }

    await writeFile(firstPath, JSON.stringify(validResult(runId, first!)), "utf8");
    await writeFile(secondPath, JSON.stringify(validResult(runId, second!)), "utf8");
    const accepted = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
    );
    expect(accepted.accepted_count).toBe(2);
    expect([...accepted.completed_work_item_ids].sort()).toEqual([
      first!.id,
      second!.id,
    ]);
    expect(accepted.state.items[first!.finding_ids[0]!]!.status).toBe("resolved");
    expect(accepted.state.items[second!.finding_ids[0]!]!.status).toBe("resolved");

    const next = requirePrepared(
      await boundary.prepareRemediationHostHandoff({
        root,
        artifactsDir,
        runId,
        baselineCommit: AFTER_COMMIT,
        state: accepted.state,
      }),
    );
    expect(next.workload.work_items.map((entry) => entry.id)).toEqual([
      "block-dependent",
    ]);
  });

  it("rejects every unknown or retired state shape before filesystem side effects", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "remediation-retired-state-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "remediation");
    const base = currentState();
    const invalidStates: unknown[] = [
      null,
      { ...base, contract_version: "remediate-code-state/v0" },
      Object.fromEntries(
        Object.entries(base).filter(([key]) => key !== "contract_version"),
      ),
      { ...base, host_capabilities: { can_dispatch_subagents: true } },
      { ...base, status: "documenting" },
      {
        ...base,
        plan: {
          ...base.plan,
          blocks: [
            { ...base.plan.blocks[0], model_hint: { tier: "strong" } },
            ...base.plan.blocks.slice(1),
          ],
        },
      },
      {
        ...base,
        items: {
          ...base.items,
          "finding-a": { ...base.items["finding-a"], provider_attempt: 1 },
        },
      },
    ];

    for (const state of invalidStates) {
      const before = await snapshotTree(root);
      expect(
        await boundary.prepareRemediationHostHandoff({
          root,
          artifactsDir,
          runId: "invalid-state-run",
          baselineCommit: BASELINE_COMMIT,
          state,
        }),
      ).toBe("unsupported_retired_state");
      expect(await snapshotTree(root)).toEqual(before);
    }
    expect(
      await boundary.ingestRemediationHostResults({
        root,
        artifactsDir,
        runId: "invalid-state-run",
        state: { ...base, provider: "legacy" },
      }),
    ).toBe("unsupported_retired_state");
    expect(existsSync(artifactsDir)).toBe(false);
  });

  it("deletes remediation-owned execution adapters and launch/quota paths", async () => {
    const root = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/(\p{L}:)/u, "$1"));
    const boundaryFiles = [
      "src/remediate/index.ts",
      "src/remediate/steps/dispatch.ts",
      "src/remediate/steps/nextStep.ts",
    ];
    const source = (
      await Promise.all(
        boundaryFiles.map((path) => readFile(join(root, path), "utf8")),
      )
    ).join("\n");
    for (const retired of [
      "makeProviderNodeDispatcher",
      "driveRollingImplementDispatch",
      "prepareHostRollingDispatch",
      "advanceHostRolling",
      "scheduleWave",
      "buildConfirmedPools",
      "buildDispatchQuota",
      "executeNodeInWorktree",
    ]) {
      expect(source, `retired execution path '${retired}' remains`).not.toContain(
        retired,
      );
    }
    for (const retiredFile of [
      "src/remediate/steps/providerNodeDispatch.ts",
      "src/remediate/steps/rollingSession.ts",
      "src/remediate/steps/dispatch/waveScheduling.ts",
    ]) {
      expect(existsSync(join(root, retiredFile)), retiredFile).toBe(false);
    }
  });
});
