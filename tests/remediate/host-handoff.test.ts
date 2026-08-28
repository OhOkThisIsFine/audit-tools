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
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { execFileHidden } from "../helpers/spawn.mjs";

import { DISPATCH_BARREL_EXPORTS } from "../helpers/dispatchBarrelBaseline.js";

const FAILURE_SIGNATURE =
  "contract:remediation-zero-adapter-boundary:not-yet-satisfied";
const CURRENT_STATE_VERSION = "remediate-code-state/v1alpha1";
const BASELINE_COMMIT = "1".repeat(40);
const AFTER_COMMIT = "2".repeat(40);
/** The one id the fixture is both planned and run under — see `currentState`. */
const FIXTURE_RUN_ID = "remediation-run-fixture";

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
    readonly plan_id: string;
    readonly blocks: readonly HostBlock[];
  };
  readonly items: Readonly<
    Record<string, { readonly finding_id: string; readonly block_id: string; readonly status: string }>
  >;
  readonly host_handoff?: HandoffRecord;
}

type HandoffRecord = {
  readonly run_id: string;
  readonly baseline_commit: string;
  readonly workload_sha256: string;
  readonly work_item_ids: readonly string[];
} &
  (
    | {
        readonly contract_version: "remediation-host-handoff-record/v1alpha1";
      }
    | {
        readonly contract_version: "remediation-host-handoff-record/v1alpha2";
        readonly scope_semantics: "explicit-directory-markers/v1";
      }
  );

interface PreparedHandoff {
  readonly workload: HostWorkload;
  readonly workload_path: string;
  readonly handoff_record: HandoffRecord;
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

/**
 * The fixture roots are REAL git repositories, because ingestion corroborates a
 * landed result against the tree: a root with neither a git repo nor a
 * persisted `host_handoff` binding has nothing to check a host's claim against,
 * and that branch is refused rather than accepted on the attestation alone. A
 * synthetic `"1".repeat(40)` baseline can still stand in wherever the assertion
 * is about PREPARE-time refusal, which never reaches corroboration.
 */
/**
 * ASYNC on purpose. A synchronous `git` blocks the vitest worker's event loop
 * for the whole spawn, starving the worker-to-runner RPC heartbeat until the
 * full suite reports `Timeout calling "onTaskUpdate"` — the same starvation
 * this work item removes from the production close and ingest paths,
 * reproduced in the fixture that covers it.
 *
 * Written out rather than `promisify`d because the helper is untyped JS, so
 * `promisify` cannot recover its `(file, args, options, callback)` arity.
 */
function git(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileHidden(
      "git",
      [...args],
      { cwd: root, encoding: "utf8" },
      (error: Error | null, stdout: string) => {
        if (error) reject(error);
        else resolve(String(stdout).trim());
      },
    );
  });
}

/** The repository HEAD — the only baseline a git-backed prepare accepts. */
async function headOf(root: string): Promise<string> {
  return await git(root, ["rev-parse", "HEAD"]);
}

/**
 * Turn a fresh temp dir into a git repository holding the four source files the
 * fixture blocks declare as their write scope, and return the baseline commit.
 */
async function initGitRoot(root: string): Promise<string> {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(root, "src"), { recursive: true });
  const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
  for (const file of files) {
    writeFileSync(join(root, file), `export const value = "${file}";\n`, "utf8");
  }
  await git(root, ["add", ...files]);
  await git(root, ["commit", "-m", "baseline"]);
  return await headOf(root);
}

/**
 * Land a real commit touching EXACTLY `file`, and return its sha.
 *
 * Exactly one file, because corroboration compares the commit's mechanically
 * derived change set against the result's `changed_files` for equality — a
 * commit that swept in anything else would be refused for the wrong reason.
 */
let landedCounter = 0;
async function landCommit(root: string, file: string): Promise<string> {
  const marker = ++landedCounter;
  writeFileSync(join(root, file), `export const value = ${String(marker)};\n`, "utf8");
  await git(root, ["add", file]);
  await git(root, ["commit", "-m", `land ${String(marker)}`]);
  return await headOf(root);
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
    // A real, fast, always-green invocation: corroboration RE-RUNS a work
    // item's required tests against the tree, so a command naming a vitest file
    // that does not exist in the temp root would fail the ingest for a reason
    // this fixture is not about.
    targeted_commands: [`node -e "process.exit(0)"`],
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
      // EQUAL to the run id the fixture prepares under, because production
      // derives one from the other: the host run id IS `state.plan.plan_id`
      // (`stateRunId` in nextStep.ts). A fixture where the two differ cannot
      // exercise anything that scopes by run.
      plan_id: FIXTURE_RUN_ID,
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

/**
 * The result document for `item` claiming `after` as its landed commit.
 *
 * Split from {@link validResult} so a test that only needs a REJECTION can
 * build many variants over ONE landed commit — the variants are refused on
 * their own defect, and landing a commit per variant would spawn git dozens of
 * times to no effect.
 */
function resultShape(
  runId: string,
  item: HostWorkItem,
  after: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const changedFiles = [item.allowed_files[0]!];
  return {
    contract_version: "remediation-host-result/v1alpha1",
    result_id: `result-${item.id}-${after.slice(0, 8)}`,
    run_id: runId,
    work_item_id: item.id,
    prompt_sha256: item.prompt.sha256,
    changed_files: changedFiles,
    commit_evidence: { before: item.baseline_commit, after },
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

/**
 * A result backed by a REAL landed commit, for the paths that must be ACCEPTED:
 * corroboration resolves both commits, checks baseline→landed→HEAD ancestry,
 * and compares the commit's own change set against `changed_files`.
 */
async function validResult(
  root: string,
  runId: string,
  item: HostWorkItem,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  return resultShape(
    runId,
    item,
    await landCommit(root, item.allowed_files[0]!),
    overrides,
  );
}

async function prepareFixture(): Promise<{
  boundary: HostBoundary;
  root: string;
  artifactsDir: string;
  runId: string;
  state: CurrentState;
  handoff: PreparedHandoff;
  baselineCommit: string;
}> {
  const boundary = await loadBoundary();
  const root = await mkdtemp(join(tmpdir(), "remediation-host-handoff-"));
  cleanupRoots.push(root);
  const artifactsDir = join(root, ".audit-tools", "remediation");
  const runId = FIXTURE_RUN_ID;
  const baselineCommit = await initGitRoot(root);
  const state = currentState();
  const handoff = requirePrepared(
    await boundary.prepareRemediationHostHandoff({
      root,
      artifactsDir,
      runId,
      baselineCommit,
      state,
    }),
  );
  // The prepared state carries the binding the prepare just minted: a
  // git-backed workload REQUIRES the tool-owned `host_handoff` record, and
  // ingestion clears it again once every bound item has completed.
  const boundState: CurrentState = {
    ...state,
    host_handoff: handoff.handoff_record,
  };
  return {
    boundary,
    root,
    artifactsDir,
    runId,
    state: boundState,
    handoff,
    baselineCommit,
  };
}

describe(FAILURE_SIGNATURE, () => {
  it("emits exactly hostDependencyLevels(state)[0] as a provider-neutral, bound handoff", async () => {
    const scheduler = await loadScheduler();
    const { root, artifactsDir, runId, state, handoff, baselineCommit } =
      await prepareFixture();
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
      expect(item.baseline_commit).toBe(baselineCommit);
      expect(item.prompt.sha256).toBe(sha256(item.prompt.text));
      expect(item.prompt.text).toContain(item.id);
      expect(item.prompt.text).toContain(item.allowed_files[0]);
      // The command is embedded inside the JSON-stringified assignment, so it
      // appears ESCAPED (`node -e \"process.exit(0)\"`). Asserting the escaped
      // form keeps the prompt↔required_tests binding pinned rather than
      // dropping the assertion because the raw string no longer matches.
      expect(item.prompt.text).toContain(
        JSON.stringify(item.required_tests[0]),
      );
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
    const { boundary, root, artifactsDir, runId, state, handoff, baselineCommit } =
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

    // ONE real landed commit, reused by every variant below: each is refused on
    // its OWN defect, so landing a commit per variant would spawn git fourteen
    // times without changing a single verdict.
    const landed = await landCommit(root, first!.allowed_files[0]!);
    const invalidResults: Record<string, unknown>[] = [
      resultShape(runId, first!, landed, { contract_version: "retired/v0" }),
      resultShape(runId, first!, landed, { run_id: "wrong-run" }),
      resultShape(runId, first!, landed, { work_item_id: second!.id }),
      resultShape(runId, first!, landed, { prompt_sha256: "0".repeat(64) }),
      resultShape(runId, first!, landed, { changed_files: ["src/outside.ts"] }),
      resultShape(runId, first!, landed, {
        commit_evidence: { before: "0".repeat(40), after: AFTER_COMMIT },
      }),
      resultShape(runId, first!, landed, {
        // The REAL baseline on both sides, so this is refused for the reason
        // it is here to pin — a landed commit that did not move — and not
        // merely for naming a commit the repository never had.
        commit_evidence: { before: baselineCommit, after: baselineCommit },
      }),
      resultShape(runId, first!, landed, { test_evidence: [] }),
      resultShape(runId, first!, landed, {
        test_evidence: first!.required_tests.map((command) => ({
          command,
          status: "failed",
        })),
      }),
      resultShape(runId, first!, landed, {
        worktree_evidence: {
          baseline_commit: "0".repeat(40),
          changed_files: [first!.allowed_files[0]],
        },
      }),
      resultShape(runId, first!, landed, {
        worktree_evidence: {
          // Real baseline, empty change set: the EMPTY list is the defect under
          // test, not the baseline identity.
          baseline_commit: baselineCommit,
          changed_files: [],
        },
      }),
      resultShape(runId, first!, landed, { acceptance: { status: "rejected" } }),
      resultShape(runId, first!, landed, { merge: { status: "pending" } }),
      resultShape(runId, first!, landed, { unexpected_legacy_field: true }),
    ];
    for (const invalid of invalidResults) {
      await writeFile(firstPath, JSON.stringify(invalid), "utf8");
      const rejected = requireIngested(
        await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
      );
      expect(rejected.accepted_count).toBe(0);
      expect(rejected.completed_work_item_ids).toEqual([]);
      expect(rejected.state.items[first!.finding_ids[0]!]!.status).toBe("pending");
      // Refused for ITS OWN defect, and refused exactly once. Asserting only
      // "not accepted" would stay green if a variant started being rejected by
      // some SHARED downstream reason — a git-ancestry or changed-files
      // corroboration that fires for every variant alike — at which point the
      // fourteen cases would all be pinning the same thing. Each of these is a
      // malformed SUBMISSION, so each must be caught by the contract
      // validation, before any repository probe.
      expect(
        rejected.issues
          .filter((issue) => issue.work_item_id === first!.id)
          .map((issue) => issue.code),
      ).toEqual(["submission_contract_invalid"]);
    }

    await writeFile(firstPath, JSON.stringify(await validResult(root, runId, first!)), "utf8");
    await writeFile(secondPath, JSON.stringify(await validResult(root, runId, second!)), "utf8");
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
        baselineCommit: await headOf(root),
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

  it("raises the classified aggregate, not a raw block-contract throw, on a malformed frontier block", async () => {
    const { run } = await prepareWith({ touched_files: [resolve("/etc/passwd")] });
    // The empty-workload branch already names producer defects this way. A
    // malformed block ON the frontier reached the caller as an uncaught
    // BlockContractError instead — a stack, not a classified refusal, and one
    // every retry reproduces identically.
    await expect(run()).rejects.toThrow(
      /^Cannot prepare a remediation host workload: block 'block-a' is outside the normalized write-scope contract/u,
    );
  });

  it("attributes the THROWER even when the scan names a different block", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "remediation-thrower-attribution-"));
    cleanupRoots.push(root);
    const runId = "thrower-attribution-run";
    const base = currentState();
    // block-a: BOUND, all items terminal, and malformed — the block that throws.
    // block-z: pending, with a dependency present in no block — a defect the scan
    // DOES find. Falling back only on an empty scan meant block-z's presence was
    // enough to suppress the thrower entirely: the operator got a message about a
    // block that did not throw, and none about the one that did.
    const state: CurrentState = {
      ...base,
      host_handoff: {
        contract_version: "remediation-host-handoff-record/v1alpha1",
        run_id: runId,
        baseline_commit: BASELINE_COMMIT,
        workload_sha256: "0".repeat(64),
        work_item_ids: ["block-a"],
      },
      plan: {
        ...base.plan,
        plan_id: runId,
        findings: [...(base.plan.findings as unknown[]), finding("finding-z", "src/z.ts")],
        blocks: [
          ...base.plan.blocks.map((entry) =>
            entry.block_id === "block-a"
              ? { ...entry, touched_files: [resolve("/etc/passwd")] }
              : entry,
          ),
          {
            ...block("block-z", "finding-z", "src/z.ts"),
            dependencies: ["GHOST_BLOCK_ID"],
          },
        ],
      },
      items: {
        ...base.items,
        "finding-a": { ...base.items["finding-a"]!, status: "resolved" },
        "finding-z": {
          finding_id: "finding-z",
          block_id: "block-z",
          status: "pending",
        },
      },
    };

    const message = await boundary
      .prepareRemediationHostHandoff({
        root,
        artifactsDir: join(root, ".audit-tools", "remediation"),
        runId,
        baselineCommit: BASELINE_COMMIT,
        state,
      })
      .then(
        () => "resolved without throwing",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    expect(message).toMatch(/^Cannot prepare a remediation host workload: /u);
    expect(message, "the thrower must be named").toContain("block-a");
    expect(message, "the scanned defect is still reported too").toContain(
      "GHOST_BLOCK_ID",
    );
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

  // ── the two-grammar half ─────────────────────────────────────────────────
  // `shell: true` is `/bin/sh -c` on posix and `cmd.exe /d /s /c` on win32, and
  // the two disagree about what quotes and escapes MEAN. Each case below is a
  // string one shell reads as fully quoted and the other reads as a live
  // separator or expansion.

  it("refuses a metacharacter behind single quotes, which cmd.exe does not quote with", async () => {
    const { root, run } = await prepareWith({
      targeted_commands: ["echo '& evil.exe'"],
    });
    await expect(run()).rejects.toThrow(/leaves the declared shape/u);
    expect(
      existsSync(join(root, "pwned")),
      "a refused command must never reach the shell",
    ).toBe(false);
  });

  it("refuses a backslash-escaped quote, which de-syncs double-quote tracking on sh", async () => {
    // sh reads `\"` as a literal quote, so the `&` this scan would otherwise
    // believe is quoted is a live command separator.
    const { run } = await prepareWith({
      targeted_commands: ['echo \\" & evil \\"'],
    });
    await expect(run()).rejects.toThrow(/leaves the declared shape/u);
  });

  it("refuses cmd.exe percent expansion, which expands inside double quotes too", async () => {
    const { run } = await prepareWith({
      targeted_commands: ["%COMSPEC% /c evil"],
    });
    await expect(run()).rejects.toThrow(/leaves the declared shape/u);
  });

  it("refuses substitution, chaining, escapes and an unterminated quote", async () => {
    for (const command of [
      `echo "$(evil)"`,
      "echo \"`evil`\"",
      "npm run build & evil",
      "echo ^& evil",
      `echo "unterminated`,
      "npm run build\nevil",
    ]) {
      const { run } = await prepareWith({ targeted_commands: [command] });
      await expect(run(), command).rejects.toThrow(/leaves the declared shape/u);
    }
  });

  it("still admits every command shape the live plan declares", async () => {
    for (const command of [
      "npm run build",
      "npm run check",
      "npm run check:tests",
      "npx vitest run tests/remediate/a.test.ts tests/remediate/b.test.ts",
      `echo "plain arg"`,
    ]) {
      const { run } = await prepareWith({ targeted_commands: [command] });
      await expect(run(), command).resolves.toBeDefined();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A producer-side block defect is REPORTED, not a wedge.
//
// Refusing the whole ingest over any malformed block made the run
// unadvanceable: a dependent block nothing was waiting on could hold every
// frontier acceptance at zero, `next-step` read `state_changed: false` and
// re-emitted the same items against the same plan, and the only escape was
// hand-editing the plan.
// ───────────────────────────────────────────────────────────────────────────

describe("a malformed block reports without blocking the frontier", () => {
  /** `block-dependent` is level 1, so its defect gates nothing at level 0. */
  function stateWithMalformedDependent(): CurrentState {
    const base = currentState();
    const blocks = base.plan.blocks.map((entry) =>
      entry.block_id === "block-dependent"
        ? { ...entry, touched_files: [resolve("/etc/passwd")] }
        : entry,
    );
    return { ...base, plan: { ...base.plan, blocks } };
  }

  it("accepts a valid landed result for a good block while naming the malformed one", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "remediation-nonfrontier-block-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "remediation");
    const runId = "nonfrontier-block-run";
    const baselineCommit = await initGitRoot(root);
    const state = stateWithMalformedDependent();
    const handoff = requirePrepared(
      await boundary.prepareRemediationHostHandoff({
        root,
        artifactsDir,
        runId,
        baselineCommit,
        state,
      }),
    );
    const good = handoff.workload.work_items.find((entry) => entry.id === "block-a")!;
    const goodPath = expectContained(root, good.result_path, "good result");
    await mkdir(resolve(goodPath, ".."), { recursive: true });
    await writeFile(goodPath, JSON.stringify(await validResult(root, runId, good)), "utf8");
    const bound: CurrentState = { ...state, host_handoff: handoff.handoff_record };

    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({
        root,
        artifactsDir,
        runId,
        state: bound,
      }),
    );
    expect(summary.accepted_count).toBe(1);
    expect(summary.completed_work_item_ids).toEqual(["block-a"]);
    expect(summary.state.items["finding-a"]!.status).toBe("resolved");
    expect(summary.state_changed).toBe(true);
    const issue = summary.issues.find(
      (entry) => entry.code === "block_contract_invalid",
    );
    expect(issue, "the producer defect must still be named, not absorbed").toBeDefined();
    expect(issue!.work_item_id).toBe("block-dependent");
  });

  it("names a malformed block whose items triage moved to blocked, not just pending ones", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "remediation-blocked-block-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "remediation");
    const runId = "blocked-block-run";
    const baselineCommit = await initGitRoot(root);
    // `blocked` is UNSETTLED, not settled: triage retries it, so the item is
    // still bound and `parseWorkItem` still re-derives its block. A scan that
    // only looked at `pending` left that re-derivation failing as a bare
    // workload_invalid naming no block.
    const base = stateWithMalformedDependent();
    const state: CurrentState = {
      ...base,
      items: {
        ...base.items,
        "finding-c": { ...base.items["finding-c"]!, status: "blocked" },
      },
    };
    const handoff = requirePrepared(
      await boundary.prepareRemediationHostHandoff({
        root,
        artifactsDir,
        runId,
        baselineCommit,
        state,
      }),
    );
    const good = handoff.workload.work_items.find((entry) => entry.id === "block-a")!;
    const goodPath = expectContained(root, good.result_path, "good result");
    await mkdir(resolve(goodPath, ".."), { recursive: true });
    await writeFile(goodPath, JSON.stringify(await validResult(root, runId, good)), "utf8");
    const bound: CurrentState = { ...state, host_handoff: handoff.handoff_record };

    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({
        root,
        artifactsDir,
        runId,
        state: bound,
      }),
    );
    const issue = summary.issues.find(
      (entry) => entry.code === "block_contract_invalid",
    );
    expect(issue, "a blocked item's block is still bound, so its defect is named").toBeDefined();
    expect(issue!.work_item_id).toBe("block-dependent");
    // And the frontier still advances — the whole point of the reporting change.
    expect(summary.accepted_count).toBe(1);
  });

  it("names a BOUND malformed block whose items have all reached terminal", async () => {
    // The status filter and the re-derivation scanned DIFFERENT SETS.
    // `parseWorkItem` rebuilds every BOUND item whatever its findings' statuses,
    // so a bound block whose items all settled still broke the workload parse —
    // and a scan that asked only about unsettled items had nothing to say about
    // it, leaving a bare workload_invalid naming no block at all.
    const { boundary, root, artifactsDir, runId, state, handoff } =
      await prepareFixture();
    const settledAndMalformed: CurrentState = {
      ...state,
      host_handoff: handoff.handoff_record,
      plan: {
        ...state.plan,
        blocks: state.plan.blocks.map((entry) =>
          entry.block_id === "block-a"
            ? { ...entry, touched_files: [resolve("/etc/passwd")] }
            : entry,
        ),
      },
      items: {
        ...state.items,
        "finding-a": { ...state.items["finding-a"]!, status: "resolved" },
        "finding-b": { ...state.items["finding-b"]!, status: "resolved" },
      },
    };

    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({
        root,
        artifactsDir,
        runId,
        state: settledAndMalformed,
      }),
    );
    const codes = summary.issues.map((entry) => entry.code);
    expect(codes).toContain("workload_invalid");
    const issue = summary.issues.find(
      (entry) => entry.code === "block_contract_invalid",
    );
    expect(issue, "the block that broke the parse must be named").toBeDefined();
    expect(issue!.work_item_id).toBe("block-a");
  });

  it("still refuses a BOUND work item whose own block is malformed, and names the block", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff } =
      await prepareFixture();
    const first = handoff.workload.work_items.find((entry) => entry.id === "block-a")!;
    const firstPath = expectContained(root, first.result_path, "first result");
    await mkdir(resolve(firstPath, ".."), { recursive: true });
    await writeFile(firstPath, JSON.stringify(await validResult(root, runId, first)), "utf8");
    const malformed: CurrentState = {
      ...state,
      plan: {
        ...state.plan,
        blocks: state.plan.blocks.map((entry) =>
          entry.block_id === "block-a"
            ? { ...entry, touched_files: [resolve("/etc/passwd")] }
            : entry,
        ),
      },
    };

    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({
        root,
        artifactsDir,
        runId,
        state: malformed,
      }),
    );
    // The guarantee is `parseWorkItem`'s canonical re-derivation: it rebuilds
    // every bound item through `buildWorkItem`, whose `assertBlockContract`
    // throws, so the workload fails to parse and no command is ever spawned.
    expect(summary.accepted_count).toBe(0);
    expect(summary.state.items["finding-a"]!.status).toBe("pending");
    const codes = summary.issues.map((entry) => entry.code);
    expect(codes).toContain("workload_invalid");
    expect(codes).toContain("block_contract_invalid");
  });
});

describe("the remediate ingest is pure with respect to persisted state", () => {
  it("returns a new state, leaves the caller's object untouched, and writes no state.json", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff } =
      await prepareFixture();
    const first = handoff.workload.work_items[0]!;
    const firstPath = expectContained(root, first.result_path, "first result");
    await mkdir(resolve(firstPath, ".."), { recursive: true });
    await writeFile(firstPath, JSON.stringify(await validResult(root, runId, first)), "utf8");
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
    await writeFile(firstPath, JSON.stringify(await validResult(root, runId, first)), "utf8");

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
    const { contract_version: _dropped, ...corrupt } = await validResult(root, runId, first);
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
    // EXACT values, because this fixture writes no contract-pipeline artifacts
    // at all — so the honest answer is that no gate ran and none was skipped
    // either, and the counters must say so. A sum-is-non-negative assertion
    // cannot fail for any implementation and left the gate half of `scan`
    // effectively uncovered.
    expect(empty.scan.gates_evaluated).toBe(0);
    expect(empty.scan.gates_skipped).toBe(0);
  });

  /**
   * Drive the whole accept-then-reprepare sequence: both level-0 items land and
   * are ingested, the accepted state is persisted, and the next level is
   * prepared — which REWRITES host-workload.json with the new frontier alone.
   * Returns the paths a validation assertion needs.
   */
  async function acceptThenReprepare(): Promise<{
    root: string;
    artifactsDir: string;
    submissionDir: string;
    runId: string;
    accepted: IngestSummary;
  }> {
    const { boundary, root, artifactsDir, runId, state, handoff } =
      await prepareFixture();
    const [first, second] = handoff.workload.work_items;
    const firstPath = expectContained(root, first!.result_path, "first result");
    const secondPath = expectContained(root, second!.result_path, "second result");
    await mkdir(resolve(firstPath, ".."), { recursive: true });
    await writeFile(firstPath, JSON.stringify(await validResult(root, runId, first!)), "utf8");
    await writeFile(secondPath, JSON.stringify(await validResult(root, runId, second!)), "utf8");

    const accepted = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
    );
    expect(accepted.accepted_count).toBe(2);
    // The caller persists state; the validator reads it back as the run's record
    // of what was accepted.
    await writeFile(
      join(artifactsDir, "state.json"),
      JSON.stringify(accepted.state),
      "utf8",
    );
    const next = requirePrepared(
      await boundary.prepareRemediationHostHandoff({
        root,
        artifactsDir,
        runId,
        baselineCommit: await headOf(root),
        state: accepted.state,
      }),
    );
    expect(next.workload.work_items.map((entry) => entry.id)).toEqual([
      "block-dependent",
    ]);
    return {
      root,
      artifactsDir,
      submissionDir: resolve(firstPath, ".."),
      runId,
      accepted,
    };
  }

  it("does not call an ACCEPTED submission stale once its block leaves the frontier", async () => {
    const { root, artifactsDir } = await acceptThenReprepare();

    const result = await validate(artifactsDir, root);
    // The live workload names only block-dependent now. Joining on it alone
    // reported BOTH accepted submissions as stale — a 100% false-positive rate
    // for every run that got past its first dependency level.
    expect(result.scan.submissions_discovered).toBe(2);
    expect(
      result.issues.filter((issue) => /Stale host submission/u.test(issue)),
      "an accepted submission is recorded history, not a stale file",
    ).toEqual([]);
  });

  it("does not re-fabricate stale flags for a PREVIOUS run's accepted submissions", async () => {
    const { root, artifactsDir } = await acceptThenReprepare();
    // Nothing deletes a finished run's directory, so run 2 in the same repo finds
    // run 1's accepted submissions still on disk — and every record a stale check
    // can join against (state.json, the ledger) describes run 2 only. Scanning
    // both runs made validate-artifacts red permanently from run 2 onward.
    const secondRunId = "remediation-run-two";
    const base = currentState();
    const secondRun: CurrentState = {
      ...base,
      plan: { ...base.plan, plan_id: secondRunId },
    };
    const boundary = await loadBoundary();
    requirePrepared(
      await boundary.prepareRemediationHostHandoff({
        root,
        artifactsDir,
        runId: secondRunId,
        baselineCommit: await headOf(root),
        state: secondRun,
      }),
    );
    await writeFile(
      join(artifactsDir, "state.json"),
      JSON.stringify(secondRun),
      "utf8",
    );

    const result = await validate(artifactsDir, root);
    expect(
      result.issues.filter((issue) => /Stale host submission/u.test(issue)),
      "a previous run's result surface is not this run's business",
    ).toEqual([]);
    // Run 2 has written no submissions of its own, and run 1's are out of scope.
    expect(result.scan.submissions_discovered).toBe(0);
    expect(result.status).toBe("ok");
  });

  it("counts a gate that could not run as skipped, not as a silent pass", async () => {
    const { root, artifactsDir } = await prepareFixture();
    // One contract-pipeline artifact present but carrying an empty payload: the
    // cross-gate sweep runs, and every gate whose primary input is absent reports
    // itself SKIPPED rather than contributing an empty issues array that would
    // read as clean. Only the nothing-present 0/0 case was pinned before, which
    // left the direction the counters exist for untested.
    const cpDir = join(artifactsDir, "intake", "contract");
    await mkdir(cpDir, { recursive: true });
    await writeFile(
      join(cpDir, "goal_spec.json"),
      JSON.stringify({ payload: {} }),
      "utf8",
    );

    const result = await validate(artifactsDir, root);
    expect(result.scan.gates_skipped).toBeGreaterThan(0);
    expect(result.scan.gates_evaluated + result.scan.gates_skipped).toBe(8);
  });

  it("flags a submission that no host workload references", async () => {
    // Planted INTO the accept-then-reprepare tree, not into a bare prepared run:
    // the widened join must still refuse a file that matches no live work item
    // AND no recorded acceptance. Against the bare fixture this passed for the
    // wrong reason — nothing had been accepted, so the new leg contributed an
    // empty set and could not have been exercised at all.
    const { root, artifactsDir, runId, submissionDir, accepted } =
      await acceptThenReprepare();
    const item = accepted.state.plan.blocks[0]!;
    await writeFile(
      join(submissionDir, `${"a".repeat(64)}.json`),
      JSON.stringify({
        contract_version: "remediation-host-result/v1alpha1",
        result_id: `result-${item.block_id}`,
        run_id: runId,
        work_item_id: item.block_id,
        prompt_sha256: "0".repeat(64),
        changed_files: [...item.touched_files],
        commit_evidence: { before: BASELINE_COMMIT, after: AFTER_COMMIT },
        test_evidence: (item.targeted_commands ?? []).map((command) => ({
          command,
          status: "passed",
        })),
        worktree_evidence: {
          baseline_commit: BASELINE_COMMIT,
          changed_files: [...item.touched_files],
        },
        acceptance: { status: "accepted" },
        merge: { status: "merged" },
      }),
      "utf8",
    );

    const result = await validate(artifactsDir, root);
    expect(result.scan.submissions_discovered).toBe(3);
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
    expect(Object.keys(barrel).sort()).toEqual(
      [...DISPATCH_BARREL_EXPORTS].sort(),
    );
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
