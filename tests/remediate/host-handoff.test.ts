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

interface IngestIssue {
  readonly code: string;
  readonly message: string;
  readonly work_item_id?: string;
  readonly result_path?: string;
}

interface IngestSummary {
  readonly accepted_count: number;
  readonly completed_work_item_ids: readonly string[];
  readonly pending_work_item_ids: readonly string[];
  readonly issues: readonly IngestIssue[];
  readonly state_changed: boolean;
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

// ───────────────────────────────────────────────────────────────────────────
// The scheduling and write-scope half of the ingestion substrate.
//
// Two silent-schedule holes lived here: a dependency id that resolved to no
// block read as SATISFIED (so the dependent was dispatched with its
// prerequisite never verified), and a block whose declared write scope or
// commands were malformed was normalized rather than refused — so the producer
// bug never surfaced anywhere.
// ───────────────────────────────────────────────────────────────────────────

/** A state whose only pending block declares a dependency present in no block. */
function stateWithMissingDependency(): CurrentState {
  const base = currentState();
  const blocks = base.plan.blocks.map((entry) =>
    entry.block_id === "block-a"
      ? { ...entry, dependencies: ["MISSING_BLOCK_ID"] }
      : entry,
  );
  return { ...base, plan: { ...base.plan, blocks } };
}

describe("dependency readiness requires existence", () => {
  it("places a satisfiable dependent at level 1 and an independent block at level 0", async () => {
    const scheduler = await loadScheduler();
    const state = currentState();
    const levels = scheduler.hostDependencyLevels(state);
    expect(levels[0]?.map((entry) => entry.block_id).sort()).toEqual([
      "block-a",
      "block-b",
    ]);
    expect(levels[1]?.map((entry) => entry.block_id)).toEqual(["block-dependent"]);
  });

  it("never places a block whose declared dependency exists in no block at level 0", async () => {
    const scheduler = await loadScheduler();
    const levels = scheduler.hostDependencyLevels(stateWithMissingDependency());
    const scheduled = levels.flat().map((entry) => entry.block_id);
    // BOTH legs are asserted: the readiness predicate must not read an
    // unresolvable id as satisfied, AND permanentlyIneligible must not skip it.
    // Closing only one leaves the block reaching the host anyway.
    expect(scheduled).not.toContain("block-a");
    expect(levels[0]?.map((entry) => entry.block_id)).toEqual(["block-b"]);
  });

  it("raises a classified issue for the unschedulable block instead of dispatching it", async () => {
    const { boundary, root, artifactsDir, runId } = await prepareFixture();
    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({
        root,
        artifactsDir,
        runId,
        state: stateWithMissingDependency(),
      }),
    );
    expect(summary.accepted_count).toBe(0);
    const issue = summary.issues.find((entry) => entry.code === "dependency_missing");
    expect(issue, "the producer defect must be named, not absorbed").toBeDefined();
    expect(issue!.work_item_id).toBe("block-a");
    expect(issue!.message).toContain("MISSING_BLOCK_ID");
  });

  it("names the unresolvable dependency when it is why there is nothing to prepare", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "remediation-missing-dependency-"));
    cleanupRoots.push(root);
    const base = stateWithMissingDependency();
    // Leave block-a as the ONLY pending block, so level 0 is empty.
    const state: CurrentState = {
      ...base,
      items: Object.fromEntries(
        Object.entries(base.items).map(([findingId, item]) => [
          findingId,
          findingId === "finding-a" ? item : { ...item, status: "resolved" },
        ]),
      ),
    };
    await expect(
      boundary.prepareRemediationHostHandoff({
        root,
        artifactsDir: join(root, ".audit-tools", "remediation"),
        runId: "missing-dependency-run",
        baselineCommit: BASELINE_COMMIT,
        state,
      }),
    ).rejects.toThrow(/MISSING_BLOCK_ID/u);
  });
});

describe("a block outside the consumed write-scope contract is refused, not normalized", () => {
  async function prepareWith(
    blockOverrides: Partial<HostBlock>,
  ): Promise<{ root: string; run: () => Promise<unknown> }> {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "remediation-block-contract-"));
    cleanupRoots.push(root);
    const base = currentState();
    const blocks = base.plan.blocks.map((entry) =>
      entry.block_id === "block-a" ? { ...entry, ...blockOverrides } : entry,
    );
    const state: CurrentState = { ...base, plan: { ...base.plan, blocks } };
    return {
      root,
      run: () =>
        boundary.prepareRemediationHostHandoff({
          root,
          artifactsDir: join(root, ".audit-tools", "remediation"),
          runId: "block-contract-run",
          baselineCommit: BASELINE_COMMIT,
          state,
        }),
    };
  }

  it("accepts a normalized block, binding its scope and commands verbatim", async () => {
    const { handoff, state } = await prepareFixture();
    const item = handoff.workload.work_items.find((entry) => entry.id === "block-a")!;
    const source = state.plan.blocks.find((entry) => entry.block_id === "block-a")!;
    expect(item.allowed_files).toEqual([...source.touched_files]);
    expect(item.required_tests).toEqual(source.targeted_commands);
  });

  it("refuses an absolute touched_files entry with a named, block-attributed error", async () => {
    const { run } = await prepareWith({ touched_files: [resolve("/etc/passwd")] });
    await expect(run()).rejects.toThrow(
      /block 'block-a' is outside the normalized write-scope contract: touched_files entry .* is absolute/u,
    );
  });

  it("refuses a touched_files entry that is not in normalized repo-relative form", async () => {
    const { run } = await prepareWith({ touched_files: ["./src/a.ts"] });
    await expect(run()).rejects.toThrow(/is not in normalized repo-relative form/u);
  });

  it("refuses a shell-chained targeted_command, and never runs it", async () => {
    const { root, run } = await prepareWith({
      targeted_commands: [
        `node -e "require('fs').writeFileSync('pwned','x')" && echo chained`,
      ],
    });
    await expect(run()).rejects.toThrow(
      /targeted_command .* leaves the declared shape/u,
    );
    expect(
      existsSync(join(root, "pwned")),
      "a refused command must never reach the shell",
    ).toBe(false);
  });

  it("refuses a redirecting targeted_command", async () => {
    const { run } = await prepareWith({
      targeted_commands: ["npm run build > build.log"],
    });
    await expect(run()).rejects.toThrow(/leaves the declared shape/u);
  });

  it("still admits an ordinary quoted test invocation", async () => {
    const { run } = await prepareWith({
      targeted_commands: [`node -e "process.exit(0)"`],
    });
    await expect(run()).resolves.toBeDefined();
  });
});

describe("the remediate ingest is pure with respect to persisted state", () => {
  it("returns a new state, leaves the caller's object untouched, and writes no state.json", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff } =
      await prepareFixture();
    const first = handoff.workload.work_items[0]!;
    const firstPath = expectContained(root, first.result_path, "first result");
    await mkdir(resolve(firstPath, ".."), { recursive: true });
    await writeFile(firstPath, JSON.stringify(validResult(runId, first)), "utf8");
    const before = JSON.parse(JSON.stringify(state)) as CurrentState;

    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
    );
    expect(summary.state.items[first.finding_ids[0]!]!.status).toBe("resolved");
    expect(summary.state).not.toBe(state);
    // Deep-equal against the pre-call snapshot: this fails the moment the live
    // object is edited in place instead of a structuredClone.
    expect(state).toEqual(before);
    // Persistence is the caller's. The module must not have written state.json.
    expect(existsSync(join(artifactsDir, "state.json"))).toBe(false);
  });

  it("reports a zero-accept ingest as unfinished, not as completion and not as an error", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff } =
      await prepareFixture();
    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
    );
    expect(summary.accepted_count).toBe(0);
    expect(summary.state_changed).toBe(false);
    expect([...summary.pending_work_item_ids].sort()).toEqual(
      handoff.workload.work_items.map((item) => item.id).sort(),
    );
    expect(summary.issues.length).toBe(handoff.workload.work_items.length);
    for (const issue of summary.issues) {
      expect(issue.code).toBe("submission_missing");
      expect(issue.work_item_id).toBeTruthy();
      expect(issue.result_path).toBeTruthy();
    }
  });
});

describe("the boundary refuses an escaping artifacts dir and a climbing run id", () => {
  it("refuses on prepare and on ingest, before any filesystem effect", async () => {
    const boundary = await loadBoundary();
    // The escape target sits under a CLEANED parent, not in the shared tmpdir:
    // a guessable name there survives any run that actually performs the escape
    // (a red-green mutation, say), and every later run reads that debris as its
    // own — a hermeticity bug, not a regression.
    const parent = await mkdtemp(join(tmpdir(), "remediation-containment-"));
    cleanupRoots.push(parent);
    const root = join(parent, "repo");
    await mkdir(root, { recursive: true });
    const escaping = join(parent, "remediation-escaped-artifacts");
    const state = currentState();
    await expect(
      boundary.prepareRemediationHostHandoff({
        root,
        artifactsDir: escaping,
        runId: "containment-run",
        baselineCommit: BASELINE_COMMIT,
        state,
      }),
    ).rejects.toThrow(/artifactsDir must remain beneath/u);
    await expect(
      boundary.ingestRemediationHostResults({
        root,
        artifactsDir: escaping,
        runId: "containment-run",
        state,
      }),
    ).rejects.toThrow(/artifactsDir must remain beneath/u);
    expect(existsSync(escaping)).toBe(false);

    const artifactsDir = join(root, ".audit-tools", "remediation");
    for (const runId of ["..", "a/b", "a\\b", ""]) {
      await expect(
        boundary.prepareRemediationHostHandoff({
          root,
          artifactsDir,
          runId,
          baselineCommit: BASELINE_COMMIT,
          state,
        }),
      ).rejects.toThrow(/Invalid remediation host run id/u);
      await expect(
        boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
      ).rejects.toThrow(/Invalid remediation host run id/u);
    }
    expect(existsSync(artifactsDir)).toBe(false);
  });
});

describe("an empty scan is not a pass", () => {
  async function validate(artifactsDir: string, root: string) {
    const { validateArtifacts } = await import(
      "../../src/remediate/validation/artifacts.js"
    );
    return validateArtifacts(artifactsDir, root);
  }

  it("reports what it examined, so a clean run is distinguishable from an unscanned one", async () => {
    const { root, artifactsDir, runId, handoff } = await prepareFixture();
    const first = handoff.workload.work_items[0]!;
    const firstPath = expectContained(root, first.result_path, "first result");
    await mkdir(resolve(firstPath, ".."), { recursive: true });
    await writeFile(firstPath, JSON.stringify(validResult(runId, first)), "utf8");

    const result = await validate(artifactsDir, root);
    // The discovery filter joins on the filenames submissionIdentity MINTS: a
    // result written at the bound path is found by the scan that validates it.
    // Both previous filters matched zero files a live run produces, so this
    // count was structurally 0 and `ok` meant nothing.
    expect(result.scan.submissions_discovered).toBe(1);
    expect(result.scan.submissions_validated).toBe(1);
    expect(
      result.issues.filter((issue) => /host submission/iu.test(issue)),
      "a well-formed submission raises no submission issue",
    ).toEqual([]);
  });

  it("flags a corrupt submission that sits at the bound path", async () => {
    const { root, artifactsDir, runId, handoff } = await prepareFixture();
    const first = handoff.workload.work_items[0]!;
    const firstPath = expectContained(root, first.result_path, "first result");
    await mkdir(resolve(firstPath, ".."), { recursive: true });
    const { contract_version: _dropped, ...corrupt } = validResult(runId, first);
    await writeFile(firstPath, JSON.stringify(corrupt), "utf8");

    const result = await validate(artifactsDir, root);
    expect(result.scan.submissions_discovered).toBe(1);
    expect(result.status).toBe("error");
    expect(result.issues.join("\n")).toMatch(/unsupported contract_version/iu);
  });

  it("distinguishes a genuinely empty run from one whose submissions went unscanned", async () => {
    const { root, artifactsDir } = await prepareFixture();
    // A prepared run with no submissions yet: nothing discovered, and that is
    // reported as zero rather than silently read as a clean pass.
    const empty = await validate(artifactsDir, root);
    expect(empty.scan.submissions_discovered).toBe(0);
    expect(empty.scan.submissions_validated).toBe(0);
    expect(
      empty.issues.filter((issue) => /no host submissions were discovered/iu.test(issue)),
      "nothing on disk is not a broken join",
    ).toEqual([]);
    // The gate side reports the same way: how many cross-gates actually ran.
    expect(empty.scan.gates_evaluated + empty.scan.gates_skipped).toBeGreaterThanOrEqual(0);
  });

  it("flags a submission that no host workload references", async () => {
    const { root, artifactsDir, runId, handoff } = await prepareFixture();
    const first = handoff.workload.work_items[0]!;
    const firstPath = expectContained(root, first.result_path, "first result");
    await mkdir(resolve(firstPath, ".."), { recursive: true });
    await writeFile(firstPath, JSON.stringify(validResult(runId, first)), "utf8");
    // A submission-shaped file at a name no workload binds: the stale-result
    // check, now reachable because it joins on real filenames.
    await writeFile(
      join(resolve(firstPath, ".."), `${"a".repeat(64)}.json`),
      JSON.stringify(validResult(runId, first)),
      "utf8",
    );

    const result = await validate(artifactsDir, root);
    expect(result.scan.submissions_discovered).toBe(2);
    expect(result.issues.join("\n")).toMatch(/Stale host submission/u);
  });
});

describe("the dispatch barrel's published export surface", () => {
  it("names the barrel's real exports, derived from the module rather than copied", async () => {
    // Consumer-side pin (CDC-03). src/remediate/steps/dispatch.ts is in no
    // module's write scope, so the surface is READ here and compared against
    // the set this design publishes as artifact:dispatch-barrel-export-surface.
    // A mock written without an `...actual` spread drifts from this the moment
    // the barrel gains or loses an export.
    const barrel = await import("../../src/remediate/steps/dispatch.js");
    expect(Object.keys(barrel).sort()).toEqual([
      "ingestRemediationHostResults",
      "prepareRemediationHostHandoff",
      "readExtractedPlanIfPresent",
      "remediationHostResultFilePath",
    ]);
    // hostDependencyLevels and remediationSubmissionBinding are re-exported
    // elsewhere, NOT by this barrel; a pin claiming either would be wrong.
    expect(Object.keys(barrel)).not.toContain("hostDependencyLevels");
    expect(Object.keys(barrel)).not.toContain("remediationSubmissionBinding");
  });

  it("publishes the six type exports the surface claims", async () => {
    // Type-only, so it is the typecheck gate (`npm run check:tests`) that binds
    // this — a removed type export makes this file fail to compile.
    type Surface = {
      state: import("../../src/remediate/steps/dispatch.js").CurrentRemediationHostState;
      prepared: import("../../src/remediate/steps/dispatch.js").PreparedRemediationHostHandoff;
      summary: import("../../src/remediate/steps/dispatch.js").RemediationHostIngestSummary;
      item: import("../../src/remediate/steps/dispatch.js").RemediationHostWorkItem;
      workload: import("../../src/remediate/steps/dispatch.js").RemediationHostWorkload;
      retired: import("../../src/remediate/steps/dispatch.js").UnsupportedRetiredRemediationState;
    };
    const retired: Surface["retired"] = "unsupported_retired_state";
    expect(retired).toBe("unsupported_retired_state");
  });
});
