import type { CurrentRemediationHostState } from "../../src/remediate/steps/dispatch/hostContracts.js";
import { canonicalPlanFixture, canonicalUnitFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { REMEDIATION_STATE_CONTRACT_VERSION } from "../../src/remediate/state/store.js";
import type { ExecutionUnit, Finding, RemediationHostHandoffRecord } from "../../src/remediate/state/types.js";
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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { execFileHidden } from "../helpers/spawn.mjs";

import { DISPATCH_BARREL_EXPORTS } from "../helpers/dispatchBarrelBaseline.js";
// The producer's own weight function, imported rather than restated: the walk
// below is only a proof of the SHARED vocabulary if it reads the same function
// the builder calls.
import { severityRiskWeight } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { REMEDIATION_HOST_RESULT_CONTRACT_VERSION as RESULT_VERSION } from "../../src/remediate/steps/types.js";
import {
  readSubmissionLedger,
  submissionLedgerPath,
} from "../../src/shared/submission/submissionLedger.js";
import {
  LaneDemandSchema,
  SEVERITIES,
  deriveResultId,
} from "../../src/shared/index.js";

const FAILURE_SIGNATURE =
  "contract:remediation-zero-adapter-boundary:not-yet-satisfied";
const CURRENT_STATE_VERSION = REMEDIATION_STATE_CONTRACT_VERSION;
const BASELINE_COMMIT = "1".repeat(40);
const AFTER_COMMIT = "2".repeat(40);
/** The one id the fixture is both planned and run under — see `currentState`. */
const FIXTURE_RUN_ID = "remediation-run-fixture";

type HostBlock = ExecutionUnit;

interface HostWorkItem {
  readonly id: string;
  readonly source_finding_ids: readonly string[];
  readonly obligation_ids: readonly string[];
  readonly allowed_files: readonly string[];
  readonly baseline_commit: string;
  readonly prompt: { readonly sha256: string; readonly text: string };
  readonly required_tests: readonly string[];
  readonly result_path: string;
  readonly token_estimate: number;
}

interface HostWorkload {
  readonly contract_version: "remediation-host-workload/v2";
  readonly run_id: string;
  readonly work_items: readonly HostWorkItem[];
}

type CurrentState = CurrentRemediationHostState;

type HandoffRecord = RemediationHostHandoffRecord;

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
  /** Per-item OBSERVED outcome — see `WORK_ITEM_OUTCOMES` in audit-tools/shared. */
  readonly work_item_outcomes: ReadonlyMap<
    string,
    "awaiting_result" | "missing_result_with_commit" | "rejected"
  >;
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
      "../../src/remediate/steps/dispatch/hostHandoff.js"
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

function finding(id: string, path: string): Finding {
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
 * Exactly one file, and one inside the item's `allowed_files`, because
 * corroboration derives the commit's change set from git and refuses any file
 * outside the write scope — a commit that swept in anything else would be
 * refused for the wrong reason.
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
  return canonicalUnitFixture(id, {
    source_finding_ids: [findingId], dependencies: options.dependencies ?? [],
    required_tests: [`node -e "process.exit(0)"`],
    read_paths: [path], allowed_files: [path],
  });
}

function currentState(): CurrentState {
  const blocks = [
    block("block-b", "finding-b", "src/b.ts"),
    block("block-a", "finding-a", "src/a.ts"),
    block("block-dependent", "finding-c", "src/c.ts", {
      dependencies: ["block-a", "block-b"],
    }),
    block("block-phase-1", "finding-d", "src/d.ts", { dependencies: ["block-a", "block-b", "block-dependent"] }),
  ];
  return {
    contract_version: CURRENT_STATE_VERSION,
    status: "implementing",
    plan: canonicalPlanFixture({
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
      units: blocks,
      requirements: blocks.map(unit => ({ id: unit.requirement_ids[0]!, description: unit.description, source_finding_ids: unit.source_finding_ids, change_kind: "structural", assertions: [] })),
      project_type: "typescript",
      candidate_closing_actions: ["none"],
    }),
    items: Object.fromEntries(blocks.map(unit => [unit.id, { unit_id: unit.id, status: "pending" }])),
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
 * THE landed-result builder for this file: the result document for `item`
 * naming `landedCommit` as its landed commit. The identity is DERIVED from the
 * work item (`deriveResultId` over its prompt digest) and never hand-copied;
 * the host states only the landed commit and the obligation evidence
 * (v1alpha3 — the tool derives the changed files from git and reruns the
 * required tests itself).
 *
 * Split from {@link validResult} so a test that only needs a REJECTION can
 * build many variants over ONE landed commit — the variants are refused on
 * their own defect, and landing a commit per variant would spawn git dozens of
 * times to no effect.
 */
function resultShape(
  runId: string,
  item: HostWorkItem,
  landedCommit: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    contract_version: RESULT_VERSION,
    result_id: deriveResultId(item.id, item.prompt.sha256),
    run_id: runId,
    work_item_id: item.id,
    prompt_sha256: item.prompt.sha256,
    landed_commit: landedCommit,
    obligation_evidence: item.obligation_ids.map(obligation_id => ({ obligation_id, evidence: ["src/a.ts:1 implements the reviewed requirement"] })),
    ...overrides,
  };
}

/** The lead line of the result template every worker prompt ends with. */
const TEMPLATE_LEAD = "When HEAD contains your commit, write this JSON to";

/**
 * A worker prompt split into the BODY the digest covers and the first JSON
 * block of the result template the tool appended below it.
 */
function splitPrompt(item: HostWorkItem): {
  readonly body: string;
  readonly template: Record<string, unknown>;
} {
  const text = item.prompt.text;
  const at = text.indexOf(TEMPLATE_LEAD);
  expect(at, "the worker prompt must end with the result template").toBeGreaterThan(0);
  const tail = text.slice(at);
  const json = /```json\n([\s\S]*?)\n```/u.exec(tail);
  expect(json, "the template must carry a fenced JSON block").not.toBeNull();
  return {
    body: text.slice(0, at).replace(/\n\n$/u, ""),
    template: JSON.parse(json![1]!) as Record<string, unknown>,
  };
}

/**
 * A result backed by a REAL landed commit, for the paths that must be ACCEPTED:
 * corroboration resolves the commit, checks baseline→landed→HEAD ancestry, and
 * derives the commit's own change set, which must lie within `allowed_files`.
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
  await writeApprovedPlanFixture(artifactsDir, state, root);
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
  it("persists rejection diagnostics and carries them across a rebound workload", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff } = await prepareFixture();
    const first = handoff.workload.work_items.find((item) => item.id === "block-a")!;
    const second = handoff.workload.work_items.find((item) => item.id === "block-b")!;
    await writeFile(expectContained(root, first.result_path, "first result"), "{broken", "utf8");
    await writeFile(
      expectContained(root, second.result_path, "second result"),
      JSON.stringify(await validResult(root, runId, second)),
      "utf8",
    );

    const firstSummary = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
    );
    expect(firstSummary.accepted_count).toBe(1);
    const firstIssue = firstSummary.issues.find((issue) => issue.work_item_id === first.id)!;
    expect(firstIssue.code).toBe("submission_malformed");
    const firstEvents = await readSubmissionLedger(artifactsDir);
    expect(firstEvents.filter((event) => event.submission_id === first.id).map((event) => event.kind)).toEqual([
      "rejected",
    ]);

    const nextHandoff = requirePrepared(
      await boundary.prepareRemediationHostHandoff({
        root,
        artifactsDir,
        runId,
        baselineCommit: await headOf(root),
        state: firstSummary.state,
      }),
    );
    const nextState: CurrentState = {
      ...firstSummary.state,
      host_handoff: nextHandoff.handoff_record,
    };
    await rm(expectContained(root, nextHandoff.workload.work_items[0]!.result_path, "rebound result"), { force: true });
    const secondSummary = requireIngested(
      await boundary.ingestRemediationHostResults({
        root,
        artifactsDir,
        runId,
        state: nextState,
      }),
    );
    const carried = secondSummary.issues.find((issue) => issue.work_item_id === first.id)!;
    expect(carried.code).toBe("submission_rejected");
    expect(carried.message).toContain("submission_malformed");
    expect(carried.result_path).toBe(nextHandoff.workload.work_items[0]!.result_path);

    const beforePoll = await readFile(submissionLedgerPath(artifactsDir), "utf8");
    await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state: nextState });
    expect(await readFile(submissionLedgerPath(artifactsDir), "utf8")).toBe(beforePoll);

    await writeFile(
      expectContained(root, nextHandoff.workload.work_items[0]!.result_path, "repaired result"),
      JSON.stringify(await validResult(root, runId, nextHandoff.workload.work_items[0]!)),
      "utf8",
    );
    const repaired = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state: nextState }),
    );
    expect(repaired.completed_work_item_ids).toContain(first.id);
    expect((await readSubmissionLedger(artifactsDir))
      .filter((event) => event.submission_id === first.id)
      .map((event) => event.kind)).toEqual(["rejected", "accepted"]);
  });

  it("emits exactly hostDependencyLevels(state)[0] as a provider-neutral, bound handoff", async () => {
    const scheduler = await loadScheduler();
    const { root, artifactsDir, runId, state, handoff, baselineCommit } =
      await prepareFixture();
    const expected = (scheduler.hostDependencyLevels(state)[0] ?? [])
      .map((entry) => entry.id)
      .sort();
    expect(expected).toEqual(["block-a", "block-b"]);
    expect(handoff.workload.contract_version).toBe(
      "remediation-host-workload/v2",
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
      const source = state.plan.units.find((entry) => entry.id === item.id)!;
      expect(item.source_finding_ids).toEqual(source.source_finding_ids);
      expect(item.allowed_files).toEqual([...source.allowed_files].sort());
      expect(item.required_tests).toEqual(source.required_tests);
      expect(item.token_estimate).toBeGreaterThan(0);
      expect(item.baseline_commit).toBe(baselineCommit);
      // The digest binds the prompt BODY — the text above the tool-filled
      // result template, which cannot carry its own digest.
      expect(item.prompt.sha256).toBe(sha256(splitPrompt(item).body));
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

  it("accepts only a complete run/block/prompt/landed-commit/obligation result", async () => {
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
    expect(missing.state.items[first.id]!.status).toBe("pending");

    await writeFile(firstPath, "{ malformed", "utf8");
    const malformed = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
    );
    expect(malformed.completed_work_item_ids).toEqual([]);

    // ONE real landed commit, reused by every variant below: each is refused on
    // its OWN defect, so landing a commit per variant would spawn git a dozen
    // times without changing a single verdict.
    const landed = await landCommit(root, first!.allowed_files[0]!);
    const { landed_commit: _noLanded, ...withoutLandedCommit } = resultShape(
      runId,
      first!,
      landed,
    );
    const { obligation_evidence: _noEvidence, ...withoutObligationEvidence } =
      resultShape(runId, first!, landed);
    const invalidResults: Record<string, unknown>[] = [
      resultShape(runId, first!, landed, { contract_version: "retired/v0" }),
      // The previous result contract version is not this one.
      resultShape(runId, first!, landed, {
        contract_version: "remediation-host-result/v1alpha2",
      }),
      resultShape(runId, first!, landed, { run_id: "wrong-run" }),
      resultShape(runId, first!, landed, { work_item_id: second!.id }),
      resultShape(runId, first!, landed, { prompt_sha256: "0".repeat(64) }),
      // result_id is the tool's derivation, never the host's choice.
      resultShape(runId, first!, landed, { result_id: `result-${first!.id}` }),
      // landed_commit must be a FULL commit id, and must be present.
      resultShape(runId, first!, landed, { landed_commit: landed.slice(0, 8) }),
      resultShape(runId, first!, landed, { landed_commit: "" }),
      withoutLandedCommit,
      withoutObligationEvidence,
      // Every v1alpha2 attestation the tool now derives itself is an extra key,
      // refused — a host can no longer restate (and so misstate) the changed
      // files, the test outcomes, the worktree, or the landing.
      resultShape(runId, first!, landed, { changed_files: [first!.allowed_files[0]] }),
      resultShape(runId, first!, landed, {
        commit_evidence: { before: baselineCommit, after: landed },
      }),
      resultShape(runId, first!, landed, {
        test_evidence: first!.required_tests.map((command) => ({
          command,
          status: "passed",
        })),
      }),
      resultShape(runId, first!, landed, {
        worktree_evidence: {
          baseline_commit: baselineCommit,
          changed_files: [first!.allowed_files[0]],
        },
      }),
      resultShape(runId, first!, landed, { acceptance: { status: "accepted" } }),
      resultShape(runId, first!, landed, { merge: { status: "merged" } }),
      resultShape(runId, first!, landed, { unexpected_legacy_field: true }),
    ];
    // The landing-level defects the v1alpha2 variants pinned here (a landed
    // commit equal to the baseline, an empty change set) are no longer
    // SUBMISSION-shape defects: corroboration classifies them
    // `landed_commit_invalid`, pinned in the prompt-20 describe below.
    for (const invalid of invalidResults) {
      await writeFile(firstPath, JSON.stringify(invalid), "utf8");
      const rejected = requireIngested(
        await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
      );
      expect(rejected.accepted_count).toBe(0);
      expect(rejected.completed_work_item_ids).toEqual([]);
      expect(rejected.state.items[first.id]!.status).toBe("pending");
      // Refused for ITS OWN defect, and refused exactly once. Asserting only
      // "not accepted" would stay green if a variant started being rejected by
      // some SHARED downstream reason — a git-ancestry or changed-files
      // corroboration that fires for every variant alike — at which point the
      // cases would all be pinning the same thing. Each of these is a
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
    expect(accepted.state.items[first.id]!.status).toBe("resolved");
    expect(accepted.state.items[second.id]!.status).toBe("resolved");

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
          units: [
            { ...base.plan.units[0], model_hint: { tier: "strong" } },
            ...base.plan.units.slice(1),
          ],
        },
      },
      {
        ...base,
        items: {
          ...base.items,
          "block-a": { ...base.items["block-a"], provider_attempt: 1 },
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
      "src/remediate/steps/dispatch/hostHandoff.ts",
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

/** A state whose first unit declares a dependency present in no unit. */
function stateWithMissingDependency(): CurrentState {
  const base = currentState();
  const blocks = base.plan.units.map((entry) =>
    entry.id === "block-a"
      ? { ...entry, dependencies: ["MISSING_BLOCK_ID"] }
      : entry,
  );
  return { ...base, plan: { ...base.plan, units: blocks } };
}

describe("dependency readiness requires existence", () => {
  it("places a satisfiable dependent at level 1 and an independent block at level 0", async () => {
    const scheduler = await loadScheduler();
    const state = currentState();
    const levels = scheduler.hostDependencyLevels(state);
    expect(levels[0]?.map((entry) => entry.id).sort()).toEqual([
      "block-a",
      "block-b",
    ]);
    expect(levels[1]?.map((entry) => entry.id)).toEqual(["block-dependent"]);
  });

  it("never places a block whose declared dependency exists in no block at level 0", async () => {
    const scheduler = await loadScheduler();
    const levels = scheduler.hostDependencyLevels(stateWithMissingDependency());
    const scheduled = levels.flat().map((entry) => entry.id);
    // BOTH legs are asserted: the readiness predicate must not read an
    // unresolvable id as satisfied, AND permanentlyIneligible must not skip it.
    // Closing only one leaves the block reaching the host anyway.
    expect(scheduled).not.toContain("block-a");
    expect(levels[0]?.map((entry) => entry.id)).toEqual(["block-b"]);
  });

  it("raises a classified issue for the unschedulable block instead of dispatching it", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff } = await prepareFixture();
    const corrupted = { ...stateWithMissingDependency(), host_handoff: handoff.handoff_record };
    // Deliberately bypass authoring validation to exercise the consumer's graph
    // diagnostics. These synthetic receipts are not a claim that the authoring
    // pipeline would approve a missing dependency.
    await writeApprovedPlanFixture(artifactsDir, corrupted, root);
    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state: corrupted }),
    );
    expect(summary.accepted_count).toBe(0);
    const issue = summary.issues.find((entry) => entry.code === "dependency_missing");
    expect(issue, "the producer defect must be named, not absorbed").toBeDefined();
    expect(issue!.work_item_id).toBe("block-a");
    expect(issue!.message).toContain("MISSING_BLOCK_ID");
    await writeApprovedPlanFixture(artifactsDir, state, root);
    const item = handoff.workload.work_items.find(entry => entry.id === "block-a")!;
    await writeFile(expectContained(root, item.result_path, "restored result"), JSON.stringify(await validResult(root, runId, item)));
    const restored = requireIngested(await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }));
    expect(restored.accepted_count).toBe(1);
    expect(restored.completed_work_item_ids).toEqual([item.id]);
    expect(restored.issues.filter(issue => issue.work_item_id === item.id)).toEqual([]);
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
          findingId === "block-a" ? item : { ...item, status: "resolved" },
        ]),
      ),
    };
    // Synthetic malformed consumer state: authoring rejects this graph earlier.
    await writeApprovedPlanFixture(join(root, ".audit-tools", "remediation"), state, root);
    await expect(
      boundary.prepareRemediationHostHandoff({
        root,
        artifactsDir: join(root, ".audit-tools", "remediation"),
        runId: FIXTURE_RUN_ID,
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
    const { boundary, root, artifactsDir, runId, baselineCommit, state: base } = await prepareFixture();
    const units = base.plan.units.map((entry) =>
      entry.id === "block-a" ? { ...entry, ...blockOverrides } : entry,
    );
    const state: CurrentState = { ...base, plan: { ...base.plan, units } };
    // These are defensive consumer-contract tests, deliberately injecting a
    // malformed persisted plan plus synthetic review receipts. Authoring would
    // reject such paths/commands. Keep the real prior handoff so the consumer's
    // exact diagnostic, rather than absent authority or context, is exercised.
    await writeApprovedPlanFixture(artifactsDir, state, []);
    return {
      root,
      run: () => boundary.prepareRemediationHostHandoff({ root, artifactsDir, runId, baselineCommit, state }),
    };
  }

  it("accepts a normalized block, binding its scope and commands verbatim", async () => {
    const { handoff, state } = await prepareFixture();
    const item = handoff.workload.work_items.find((entry) => entry.id === "block-a")!;
    const source = state.plan.units.find((entry) => entry.id === "block-a")!;
    expect(item.allowed_files).toEqual([...source.allowed_files]);
    expect(item.required_tests).toEqual(source.required_tests);
  });

  it("raises a classified repair refusal rather than a raw contract exception", async () => {
    const { run } = await prepareWith({ allowed_files: [resolve("/etc/passwd")] });
    await expect(run()).rejects.toMatchObject({
      name: "RemediationHostPreparationError",
      code: "plan_repair_required",
      message: expect.stringMatching(/^block 'block-a' is outside the normalized write-scope contract/u),
    });
  });

  it("names both a malformed bound unit and an independent missing dependency", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "remediation-thrower-attribution-"));
    cleanupRoots.push(root);
    const runId = "thrower-attribution-run";
    const base = currentState();
    // Bound terminal units remain part of the trusted workload. Its malformed
    // scope must be named alongside the independent missing dependency, even
    // though the unit no longer has a pending lifecycle status.
    const state: CurrentState = {
      ...base,
      host_handoff: {
        contract_version: "remediation-host-handoff-record/v1alpha2",
        scope_semantics: "explicit-directory-markers/v1",
        run_id: runId,
        baseline_commit: BASELINE_COMMIT,
        workload_sha256: "0".repeat(64),
        work_item_ids: ["block-a"],
      },
      plan: {
        ...base.plan,
        plan_id: runId,
        findings: [...base.plan.findings, finding("finding-z", "src/z.ts")],
        units: [
          ...base.plan.units.map((entry) =>
            entry.id === "block-a"
              ? { ...entry, allowed_files: [resolve("/etc/passwd")] }
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
        "block-a": { ...base.items["block-a"]!, status: "resolved" },
        "block-z": {
          unit_id: "block-z",
          status: "pending",
        },
      },
    };

    // Synthetic malformed consumer state preserves both independent diagnostics.
    await writeApprovedPlanFixture(join(root, ".audit-tools", "remediation"), state, []);
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
    expect(message).toMatch(/^block 'block-a' is outside the normalized write-scope contract/u);
    expect(message, "the bound unit must be named").toContain("block-a");
    expect(message, "the scanned defect is still reported too").toContain(
      "GHOST_BLOCK_ID",
    );
  });

  it("refuses an absolute touched_files entry with a named, block-attributed error", async () => {
    const { run } = await prepareWith({ allowed_files: [resolve("/etc/passwd")] });
    await expect(run()).rejects.toThrow(
      /block 'block-a' is outside the normalized write-scope contract: touched_files entry .* is absolute/u,
    );
  });

  it("refuses a touched_files entry that is not in normalized repo-relative form", async () => {
    const { run } = await prepareWith({ allowed_files: ["./src/a.ts"] });
    await expect(run()).rejects.toThrow(/is not in normalized repo-relative form/u);
  });

  it("refuses a shell-chained targeted_command, and never runs it", async () => {
    const { root, run } = await prepareWith({
      required_tests: [
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
      required_tests: ["npm run build > build.log"],
    });
    await expect(run()).rejects.toThrow(/leaves the declared shape/u);
  });

  it("still admits an ordinary quoted test invocation", async () => {
    const { run } = await prepareWith({
      required_tests: [`node -e "process.exit(0)"`],
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
      required_tests: ["echo '& evil.exe'"],
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
      required_tests: ['echo \\" & evil \\"'],
    });
    await expect(run()).rejects.toThrow(/leaves the declared shape/u);
  });

  it("refuses cmd.exe percent expansion, which expands inside double quotes too", async () => {
    const { run } = await prepareWith({
      required_tests: ["%COMSPEC% /c evil"],
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
      const { run } = await prepareWith({ required_tests: [command] });
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
      const { run } = await prepareWith({ required_tests: [command] });
      await expect(run(), command).resolves.toBeDefined();
    }
  });
});

// The reviewed executable plan is the sole authority. A runtime-only mutation
// cannot salvage other work against a different plan; restoring the reviewed
// revision makes the unchanged landed evidence consumable again.
describe("malformed runtime plans cannot replace reviewed authority", () => {
  it.each([
    { unitId: "block-dependent", status: "pending" as const },
    { unitId: "block-dependent", status: "blocked" as const },
    { unitId: "block-a", status: "resolved" as const },
    { unitId: "block-a", status: "pending" as const },
  ])("refuses an unapproved $status mutation of $unitId and accepts after restoration", async ({ unitId, status }) => {
    const { boundary, root, artifactsDir, runId, state, handoff } = await prepareFixture();
    const good = handoff.workload.work_items.find(item => item.id === "block-b")!;
    await writeFile(expectContained(root, good.result_path, "result"), JSON.stringify(await validResult(root, runId, good)), "utf8");
    const malformed: CurrentState = {
      ...state,
      plan: {
        ...state.plan,
        units: state.plan.units.map(unit => unit.id === unitId ? { ...unit, allowed_files: [resolve("/etc/passwd")] } : unit),
      },
      items: { ...state.items, [unitId]: { ...state.items[unitId]!, status } },
    };
    const before = await snapshotTree(artifactsDir);
    await expect(boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state: malformed }))
      .rejects.toMatchObject({ code: "plan_repair_required", message: expect.stringContaining("approved revision") });
    expect(await snapshotTree(artifactsDir), "refusal must preserve submissions and accepted history").toEqual(before);
    const restored = requireIngested(await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }));
    expect(restored.accepted_count).toBe(1);
    expect(restored.completed_work_item_ids).toEqual([good.id]);
    expect(restored.state.items[good.id]!.status).toBe("resolved");
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
    expect(summary.state.items[first.id]!.status).toBe("resolved");
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

// The step prompt listed MISSING results in the same section, with the same
// shape, as rejections — so a host parser had to special-case the message text
// "no result file exists", and the two situations whose remedies are OPPOSITE
// (patience vs. a repair) read identically. The split is on the CODE.
describe("missing and rejected results are distinct, machine-readable statuses", () => {
  it("classifies an item with nothing at its bound path as awaiting_result, not as a rejection", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff } =
      await prepareFixture();
    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
    );
    expect(summary.work_item_outcomes.size).toBe(handoff.workload.work_items.length);
    for (const item of handoff.workload.work_items) {
      expect(summary.work_item_outcomes.get(item.id)).toBe("awaiting_result");
    }
  });

  it("classifies a written-but-refused item as rejected", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff } =
      await prepareFixture();
    const first = handoff.workload.work_items[0]!;
    const firstPath = expectContained(root, first.result_path, "first result");
    await mkdir(resolve(firstPath, ".."), { recursive: true });
    await writeFile(firstPath, "{ not json", "utf8");
    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
    );
    expect(summary.work_item_outcomes.get(first.id)).toBe("rejected");
    // The distinction is on the CODE, so a reader never parses the message.
    const issue = summary.issues.find((entry) => entry.work_item_id === first.id);
    expect(issue?.code).toBe("submission_malformed");
    expect(issue?.code).not.toBe("submission_missing");
  });

  // The measured friction, verbatim: "a host worker landed sound edits but wrote
  // no bound result, so the verify stage never ran and the driver re-verified by
  // hand. A work item whose commit exists but whose result is missing should
  // surface as explicit partial progress, never disappear as null."
  it("surfaces a LANDED commit with no result as missing_result_with_commit, not as absent progress", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff, baselineCommit } =
      await prepareFixture();
    const first = handoff.workload.work_items[0]!;
    // Land the commit the item asked for, exactly as an accepted run would —
    // then remove the result file, which is the state the friction describes.
    const landed = await landCommit(root, first.allowed_files[0]!);
    const firstPath = expectContained(root, first.result_path, "first result");
    await mkdir(resolve(firstPath, ".."), { recursive: true });
    await writeFile(
      firstPath,
      JSON.stringify(resultShape(runId, first, landed)),
      "utf8",
    );
    const accepting = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
    );
    expect(accepting.accepted_count).toBe(1);
    const findingId = first.id;
    expect(accepting.state.items[findingId]!.host_landed_commit).toBe(landed);
    expect(accepting.state.items[findingId]!.status).not.toBe("pending");

    // Now a SECOND run over the same landed commit with the result file gone.
    // The finding is already settled, so re-open it to make the item pending
    // again — the run holds the corroborated commit; the result is what is
    // missing, which is precisely the partial-progress case.
    const reopened = structuredClone(accepting.state);
    reopened.items[findingId]!.status = "pending";
    reopened.host_handoff = handoff.handoff_record;
    await rm(firstPath, { force: true });
    const missing = requireIngested(
      await boundary.ingestRemediationHostResults({
        root,
        artifactsDir,
        runId,
        state: reopened,
      }),
    );
    expect(missing.work_item_outcomes.get(first.id)).toBe(
      "missing_result_with_commit",
    );
    // Still a missing OBSERVATION on the issue channel — the two channels carry
    // different facts and must not be conflated in either direction.
    const issue = missing.issues.find((entry) => entry.work_item_id === first.id);
    expect(issue?.code).toBe("submission_missing");
    expect(baselineCommit).toBeTruthy();
  });

  it("the same item with NO landed commit stays awaiting_result — the commit is what makes it progress", async () => {
    // The discriminating half: without it, `missing_result_with_commit` could be
    // returned for anything missing and the distinction would mean nothing.
    const { boundary, root, artifactsDir, runId, state, handoff } =
      await prepareFixture();
    const first = handoff.workload.work_items[0]!;
    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
    );
    expect(summary.work_item_outcomes.get(first.id)).toBe("awaiting_result");
    expect(summary.work_item_outcomes.get(first.id)).not.toBe(
      "missing_result_with_commit",
    );
  });
});

describe("the boundary refuses an escaping artifacts dir and a climbing run id", () => {
  it("refuses on prepare, ingest and recovery precompute before any filesystem effect", async () => {
    const boundary = await loadBoundary();
    const { precomputeRecoveryTestVerdicts } = await import("../../src/remediate/steps/dispatch/hostHandoff.js");
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
    const artifactsDir = join(root, ".audit-tools", "remediation");
    await writeApprovedPlanFixture(artifactsDir, state, root);
    const before = await snapshotTree(artifactsDir);
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
    await expect(precomputeRecoveryTestVerdicts({ root, artifactsDir: escaping, runId: "containment-run", state }))
      .rejects.toThrow(/artifactsDir must remain beneath/u);
    expect(existsSync(escaping)).toBe(false);

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
      await expect(precomputeRecoveryTestVerdicts({ root, artifactsDir, runId, state }))
        .rejects.toThrow(/Invalid remediation host run id/u);
    }
    expect(await snapshotTree(artifactsDir)).toEqual(before);
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
    // Preparation has a real canonical plan/source pair, so its single
    // executable-plan gate ran even though no host submission exists yet.
    expect(empty.scan.gates_evaluated).toBe(1);
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
    await writeApprovedPlanFixture(artifactsDir, secondRun, root);
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
    const { executionPlanPaths } = await import("../../src/remediate/contractPipeline/executionPlan.js");
    await rm(executionPlanPaths(artifactsDir).source);
    const result = await validate(artifactsDir, root);
    expect(result.scan.gates_evaluated).toBe(0);
    expect(result.scan.gates_skipped).toBe(1);
  });

  it("flags a submission that no host workload references", async () => {
    // Planted INTO the accept-then-reprepare tree, not into a bare prepared run:
    // the widened join must still refuse a file that matches no live work item
    // AND no recorded acceptance. Against the bare fixture this passed for the
    // wrong reason — nothing had been accepted, so the new leg contributed an
    // empty set and could not have been exercised at all.
    const { root, artifactsDir, runId, submissionDir, accepted } =
      await acceptThenReprepare();
    const item = accepted.state.plan.units[0]!;
    // A well-formed result for a prompt no workload ever issued: the unknown
    // digest is what makes it reference nothing.
    const unissued: HostWorkItem = {
      id: item.id,
      source_finding_ids: [...item.source_finding_ids],
      obligation_ids: [...item.requirement_ids],
      allowed_files: [...item.allowed_files],
      baseline_commit: BASELINE_COMMIT,
      prompt: { sha256: "0".repeat(64), text: "" },
      required_tests: [...(item.required_tests ?? [])],
      result_path: "",
      token_estimate: 1800,
    };
    await writeFile(
      join(submissionDir, `${"a".repeat(64)}.json`),
      JSON.stringify(resultShape(runId, unissued, AFTER_COMMIT)),
      "utf8",
    );

    const result = await validate(artifactsDir, root);
    expect(result.scan.submissions_discovered).toBe(3);
    expect(result.issues.join("\n")).toMatch(/Stale host submission/u);
  });
});

describe("the dispatch host-handoff module's published export surface", () => {
  it("names the module's real exports, derived from the module rather than copied", async () => {
    // Consumer-side pin (CDC-03). The host-handoff module is in no other
    // module's write scope, so the surface is READ here and compared against
    // the committed baseline. A mock written without an `...actual` spread
    // drifts from this the moment the module gains or loses an export.
    // (Until CY-03 this pinned the steps/dispatch.ts barrel; the barrel was
    // deleted, and the mocks now target this module.)
    const barrel = await import("../../src/remediate/steps/dispatch/hostHandoff.js");
    expect(Object.keys(barrel).sort()).toEqual(
      [...DISPATCH_BARREL_EXPORTS].sort(),
    );
  });

  it("publishes the six type exports the surface claims", async () => {
    // Type-only, so it is the typecheck gate (`npm run check:tests`) that binds
    // this — a removed type export makes this file fail to compile.
    type Surface = {
      state: import("../../src/remediate/steps/dispatch/hostContracts.js").CurrentRemediationHostState;
      prepared: import("../../src/remediate/steps/dispatch/hostContracts.js").PreparedRemediationHostHandoff;
      summary: import("../../src/remediate/steps/dispatch/hostContracts.js").RemediationHostIngestSummary;
      item: import("../../src/remediate/steps/dispatch/hostContracts.js").RemediationHostWorkItem;
      workload: import("../../src/remediate/steps/dispatch/hostContracts.js").RemediationHostWorkload;
      retired: import("../../src/remediate/steps/dispatch/hostContracts.js").UnsupportedRetiredRemediationState;
    };
    const retired: Surface["retired"] = "unsupported_retired_state";
    expect(retired).toBe("unsupported_retired_state");
  });
});

describe("work items carry the approved module contracts (open-bugs.md:474)", () => {
  it("the dispatch prompt binds the worker to the block's finalized module contract", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "host-handoff-contracts-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "remediation");
    const baselineCommit = await initGitRoot(root);
    const contract = {
      name: "auth-module",
      inputs: ["credentials"],
      outputs: ["artifact:session"],
      invariants: ["INV-1: sessions survive refresh"],
      side_effects: [],
      validation_boundary: "validates credentials",
      failure_modes: ["InvalidCredentials"],
      seam_adjustments: [],
    };
    const state = structuredClone(currentState());
    const withContract = state.plan.units.find(
      (entry) => entry.id === "block-a",
    )!;
    withContract.affected_interfaces = [{ name: "auth-module", description: JSON.stringify(contract) }];
    await writeApprovedPlanFixture(artifactsDir, state, root);

    const handoff = requirePrepared(
      await boundary.prepareRemediationHostHandoff({
        root,
        artifactsDir,
        runId: FIXTURE_RUN_ID,
        baselineCommit,
        state,
      }),
    );

    const bound = handoff.workload.work_items.find((item) => item.id === "block-a")!;
    // The approved contract rides the sha-bound prompt: the worker sees the
    // interface it must conform to, and the binding covers what it saw.
    expect(bound.prompt.text).toContain("affected_interfaces");
    expect(bound.prompt.text).toContain("INV-1: sessions survive refresh");
    const CONFORM_RULE = "Preserve every declared affected interface";
    expect(bound.prompt.text).toContain(CONFORM_RULE);
    // The rule sits in the digest-bound BODY, not only in the appended template.
    expect(splitPrompt(bound).body).toContain(CONFORM_RULE);
    // Generic conformance guidance applies to every unit, but the contract is
    // carried only by its reviewed owner.
    const unbound = handoff.workload.work_items.find((item) => item.id === "block-b")!;
    expect(unbound.prompt.text).not.toContain("INV-1: sessions survive refresh");
    expect(unbound.prompt.text).not.toContain("auth-module");
  });
});

// ── F3: the severity weight follows the shared severity vocabulary ────────────
//
// `blockRiskScore` turns a block's finding severities into the risk input of the
// shared demand ranking. It used to do that through a hand-written
// `Record<string, number>` — a SECOND copy of the severity vocabulary that
// `FindingSeveritySchema` / `SEVERITIES` / `severityRank` single-source in
// `src/shared/types/lens.ts` — read through `?? 0`. A severity added to the
// shared union would fall through that fallback and weight as ZERO (the safest
// possible rank), so a block of brand-new-critical findings would dispatch as if
// it fixed nothing. The weight now DERIVES from the shared tuple, and this walks
// every member of it — the WALK is what makes the class of miss impossible
// rather than merely unfound, because it reads the same tuple the producer does.
describe("F3: the severity risk weight is total over the shared severity set", () => {
  it("weights every member the shared vocabulary declares, and no others", () => {
    for (const severity of SEVERITIES) {
      const weight = severityRiskWeight(severity);
      expect(Number.isFinite(weight), severity).toBe(true);
      expect(weight, `'${severity}' must not weight as zero`).toBeGreaterThan(0);
      expect(weight, `'${severity}' must be a probability`).toBeLessThanOrEqual(1);
    }
  });

  it("orders the weights exactly as the shared tuple orders severity", () => {
    const weights = SEVERITIES.map((severity) => severityRiskWeight(severity));
    for (let index = 1; index < weights.length; index += 1) {
      expect(
        weights[index]!,
        `${SEVERITIES[index]!} (${weights[index]!}) must weigh below ` +
          `${SEVERITIES[index - 1]!} (${weights[index - 1]!})`,
      ).toBeLessThan(weights[index - 1]!);
    }
  });

  it("keeps the least-severe tier off zero, so it is not confusable with no signal", () => {
    // `blockRiskScore` returns exactly 0 for a block whose findings are all
    // absent from the plan — "we could not resolve this block". A severity
    // weighing 0 would say the same thing about a block we resolved perfectly,
    // and the two are different facts. This is the one weight the derivation
    // does NOT take from the ladder (which would put it at 0), so it is pinned.
    const least = SEVERITIES[SEVERITIES.length - 1]!;
    expect(severityRiskWeight(least)).toBe(0.1);
    expect(severityRiskWeight(least)).toBeGreaterThan(0);
  });

  it("produces the block's risk rank end to end, for the extreme severities", async () => {
    // The derivation is pure, so the walk above is the real proof; this pins
    // that the weight actually REACHES the emitted workload's demand.
    for (const [severity, expected] of [
      ["critical", "high"],
      ["medium", "medium"],
      ["low", "low"],
      ["info", "low"],
    ] as const) {
      const boundary = await loadBoundary();
      const root = await mkdtemp(join(tmpdir(), "host-handoff-risk-"));
      cleanupRoots.push(root);
      const artifactsDir = join(root, ".audit-tools", "remediation");
      const baselineCommit = await initGitRoot(root);
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");

      const state = currentState();
      const findings = state.plan.findings as Array<{ id: string; severity: string }>;
      findings.find((entry) => entry.id === "finding-a")!.severity = severity;
      await writeApprovedPlanFixture(artifactsDir, state, root);

      const handoff = requirePrepared(
        await boundary.prepareRemediationHostHandoff({
          root,
          artifactsDir,
          runId: FIXTURE_RUN_ID,
          baselineCommit,
          state,
        }),
      );
      const item = handoff.workload.work_items.find((entry) => entry.id === "block-a");
      expect(item, `block-a planned under '${severity}'`).toBeDefined();
      const demand = (item as unknown as {
        readonly demand: { readonly risk: string };
      }).demand;
      expect(LaneDemandSchema.safeParse(demand).success, severity).toBe(true);
      expect(demand.risk, `risk rank for a '${severity}' block`).toBe(expected);
    }
  });
});

// ── THE LANDING GATES ────────────────────────────────────────────────────────
//
// docs/backlog/open-bugs.md, "The per-item required tests and the host landing
// gate do not include the tree-wide guard suites or the cheap release gates".
//
// `targeted_commands` is module-scoped: it names the command that exercises the
// module a block edits. Three landings reddened CI after green per-item runs on
// gates no module-scoped command covers — a tree-wide path-guard suite, a
// case-sensitivity assertion, and an import cycle `check:depgraph` refuses.
//
// THE GATES DO NOT RIDE THE WORK ITEM. They state facts about the WHOLE tree, so
// the boundary that owns them is the CLOSE, on the merged tree — folding them
// into `required_tests` refused a wave item whose added export had no consumer
// until a LATER item landed, and let one item's fault refuse another. See
// `verifyLandingGates` in `src/remediate/phases/closeVerifyLandingGates.ts` for
// the leg that runs them, and CLAUDE.md, *A gate states the boundary it OWNS*.
//
// What DOES ride the item is the one scope fact a per-item prepare owns: a block
// that coins an invariant id needs the glossary document in `allowed_files`, or
// the id-glossary gate is unsatisfiable for it.
describe("landing gates", () => {
  /** The fixture root, plus a package.json declaring the given scripts. */
  async function rootWithScripts(
    scripts: Record<string, string>,
  ): Promise<{ root: string; boundary: HostBoundary; baselineCommit: string }> {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "host-handoff-landing-"));
    cleanupRoots.push(root);
    const baselineCommit = await initGitRoot(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", scripts }, null, 2),
      "utf8",
    );
    return { root, boundary, baselineCommit };
  }

  /** Prepare the fixture run at `root` and return block-a's work item. */
  async function preparedBlockA(
    root: string,
    boundary: HostBoundary,
    baselineCommit: string,
    state: ReturnType<typeof currentState>,
  ): Promise<HostWorkItem> {
    await writeApprovedPlanFixture(join(root, ".audit-tools", "remediation"), state, root);
    const handoff = requirePrepared(
      await boundary.prepareRemediationHostHandoff({
        root,
        artifactsDir: join(root, ".audit-tools", "remediation"),
        runId: FIXTURE_RUN_ID,
        baselineCommit,
        state,
      }),
    );
    return handoff.workload.work_items.find((entry) => entry.id === "block-a")!;
  }

  /** The fixture root carrying a glossary document with one documented id. */
  async function rootWithGlossary(
    scripts: Record<string, string>,
  ): Promise<{ root: string; boundary: HostBoundary; baselineCommit: string }> {
    const fixture = await rootWithScripts(scripts);
    await mkdir(join(fixture.root, "docs"), { recursive: true });
    await writeFile(
      join(fixture.root, "docs", "glossary-ids.md"),
      "| Namespace | Contract | Live owner |\n|---|---|---|\n| INV-EXISTING | holds. | `src/a.ts` |\n",
      "utf8",
    );
    return fixture;
  }

  /** Give block-a a module contract, which is what the scope widening reads. */
  function declareContract(
    state: ReturnType<typeof currentState>,
    contract: Record<string, unknown>,
  ): void {
    const source = state.plan.units.find((entry) => entry.id === "block-a")!;
    source.affected_interfaces = [{ name: "src/a.ts", description: JSON.stringify(contract) }];
  }

  const GATE_SCRIPTS = {
    test: "vitest run",
    "verify:guards": "node scripts/shared/run-vitest-gate.mjs",
    "check:depgraph": "depcruise --config .dependency-cruiser.cjs src",
    "check:deadcode": "knip --no-config-hints",
    "check:lint": "eslint .",
    "check:invariant-glossary": "node scripts/check-invariant-glossary.mjs",
  };

  it("binds NO tree-wide landing gate into a work item's required tests", async () => {
    // Red under the inversion this replaced: fold `discoverLandingGates(root)`
    // back into `required_tests` in `buildWorkItem`. Every gate name below is
    // one the old fold appended, and each names a fact about the whole tree
    // that no edit inside block-a's scope can move.
    const { root, boundary, baselineCommit } = await rootWithScripts(GATE_SCRIPTS);
    const state = currentState();
    const item = await preparedBlockA(root, boundary, baselineCommit, state);
    const source = state.plan.units.find((entry) => entry.id === "block-a")!;
    // The item's required tests are ITS OWN commands, exactly — the tool
    // reruns this list at ingestion, and a tree-wide gate here is one no
    // in-scope edit can satisfy.
    expect(item.required_tests).toEqual([...(source.required_tests ?? [])]);
    for (const gate of [
      "npm run check:deadcode",
      "npm run check:depgraph",
      "npm run check:lint",
      "npm run verify:guards",
      "npm run check:invariant-glossary",
    ]) {
      expect(item.required_tests, `${gate} is the CLOSE's, not this item's`).not.toContain(
        gate,
      );
      // The item's own required tests are what the emitted prompt declares, so a
      // gate that must not run here must not appear there either.
      expect(item.prompt.text).not.toContain(JSON.stringify(gate));
    }
  });

  it("emits no landing-gate command block in the item prompt, and points at the close instead", async () => {
    // Red under the inverse of the prompt half: restore the removed block that
    // enumerated the discovered gates and told the host to run each of them on
    // this item's landed tree.
    const { root, boundary, baselineCommit } = await rootWithScripts({
      "check:lint": "eslint .",
    });
    const state = currentState();
    const item = await preparedBlockA(root, boundary, baselineCommit, state);
    // ONE line, naming the boundary that runs them.
    expect(item.prompt.text).toMatch(
      /Do not run the landing gates\. The close phase runs them once, on the merged tree\./i,
    );
    // The Linux-CI instruction is gone: no mechanism enforced it, and Linux CI
    // is the host's concern, not an instruction this tool can back.
    expect(item.prompt.text).not.toMatch(/Linux CI/i);
    // …and the ONE line is not the whole rule on its own. `toMatch` above is a
    // SUBSTRING test, so a reword that appends a second sentence naming a
    // mechanism ("…on the fully merged tree. Dispatch a sub-agent to check.")
    // satisfies it while telling the host to run a thing this item must not
    // run. The mechanism-absence rule the fan-out wording was held to
    // (a since-deleted remediate suite) has to hold here too — the sentence is
    // valid only as the WHOLE of what the prompt says about landing gates.
    expect(item.prompt.text).not.toMatch(/sub-agent/i);
    expect(item.prompt.text).not.toMatch(/dispatch (a|one) /i);
  });

  it("says nothing about landing gates for a repository that declares none", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "host-handoff-no-gates-"));
    cleanupRoots.push(root);
    const baselineCommit = await initGitRoot(root);
    const state = currentState();
    const item = await preparedBlockA(root, boundary, baselineCommit, state);
    expect(item.prompt.text).not.toMatch(/LANDING GATES/i);
  });

  it("does not silently widen reviewed scope when an interface mentions a new glossary id", async () => {
    const { root, boundary, baselineCommit } = await rootWithGlossary(GATE_SCRIPTS);
    const state = currentState();
    declareContract(state, {
      invariants: ["INV-BRAND-NEW holds across the module"],
    });
    const item = await preparedBlockA(root, boundary, baselineCommit, state);
    expect(item.allowed_files).not.toContain("docs/glossary-ids.md");
  });

  it("does NOT widen for a contract that only MENTIONS an id the glossary already documents", async () => {
    // Red with the subtraction of the documented ids removed: a seam adjustment
    // citing `INV-EXISTING` is not a coin, and widening for it hands the item a
    // document it has no business editing.
    const { root, boundary, baselineCommit } = await rootWithGlossary(GATE_SCRIPTS);
    const state = currentState();
    declareContract(state, {
      seam_adjustments: ["the consumer of INV-EXISTING must not change"],
    });
    const item = await preparedBlockA(root, boundary, baselineCommit, state);
    const source = state.plan.units.find((entry) => entry.id === "block-a")!;
    expect(item.allowed_files).not.toContain("docs/glossary-ids.md");
    expect(item.allowed_files).toEqual([...source.allowed_files]);
  });

  it("does NOT widen when the target root keeps no glossary document at all", async () => {
    // `docs/glossary-ids.md` is THIS repository's convention and remediate-code
    // runs against arbitrary repositories — red with the existence check
    // removed, which grants write scope over a file the target does not have.
    const { root, boundary, baselineCommit } = await rootWithScripts(GATE_SCRIPTS);
    const state = currentState();
    declareContract(state, { invariants: ["INV-BRAND-NEW holds"] });
    const item = await preparedBlockA(root, boundary, baselineCommit, state);
    expect(item.allowed_files).not.toContain("docs/glossary-ids.md");
  });

  it("does NOT widen the scope for a block whose contract declares no invariant id", async () => {
    const { root, boundary, baselineCommit } = await rootWithGlossary(GATE_SCRIPTS);
    const state = currentState();
    declareContract(state, { inputs: ["a path"], outputs: ["a string"] });
    const item = await preparedBlockA(root, boundary, baselineCommit, state);
    const source = state.plan.units.find((entry) => entry.id === "block-a")!;
    // The write scope is NOT blanket-widened: a block that coins no id has no
    // business editing the glossary.
    expect(item.allowed_files).not.toContain("docs/glossary-ids.md");
    expect(item.allowed_files).toEqual([...source.allowed_files]);
  });
});


/**
 * Prompt 20 (owner review, 2026-09-18). The worker prompt ENDS with the result
 * the tool expects, its identity values filled in by the tool; the digest
 * covers the text ABOVE that template (a text cannot carry its own digest); the
 * landed result is SLIM — the tool derives the changed files, the tests and the
 * landing itself from git and its own rerun, so the host states only the commit
 * and the obligation evidence.
 */
describe("prompt 20: tool-filled result template and slim landed result", () => {
  const SLIM_KEYS = [
    "contract_version",
    "landed_commit",
    "obligation_evidence",
    "prompt_sha256",
    "result_id",
    "run_id",
    "work_item_id",
  ];
  // The result builder, the prompt splitter and the template lead are the
  // file-level `resultShape`, `splitPrompt` and `TEMPLATE_LEAD`.

  it("ends each worker prompt with a template whose identity values the tool filled in", async () => {
    const { runId, handoff } = await prepareFixture();
    expect(handoff.workload.contract_version).toBe(
      "remediation-host-workload/v2",
    );
    for (const item of handoff.workload.work_items) {
      const { body, template } = splitPrompt(item);
      // The digest covers the text above the template, exactly.
      expect(sha256(body)).toBe(item.prompt.sha256);
      expect(item.prompt.text.startsWith(`# Implement execution unit \`${item.id}\``)).toBe(true);
      expect(Object.keys(template).sort()).toEqual(SLIM_KEYS);
      expect(template).toMatchObject({
        contract_version: "remediation-host-result/v1alpha3",
        result_id: deriveResultId(item.id, item.prompt.sha256),
        run_id: runId,
        work_item_id: item.id,
        prompt_sha256: item.prompt.sha256,
        obligation_evidence: item.obligation_ids.map(obligation_id => ({ obligation_id, evidence: [expect.any(String)] })),
      });
      expect(item.prompt.text).toContain(item.result_path);
      expect(item.prompt.text).not.toMatch(/frontier|later dependency level|digest/iu);
    }
  });

  it("accepts a slim result for a real landed commit", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff } = await prepareFixture();
    const item = handoff.workload.work_items[0]!;
    const landed = await landCommit(root, item.allowed_files[0]!);
    await writeFile(
      expectContained(root, item.result_path, "result"),
      JSON.stringify(resultShape(runId, item, landed)),
      "utf8",
    );
    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
    );
    expect(summary.issues.filter((issue) => issue.work_item_id === item.id)).toEqual([]);
    expect(summary.completed_work_item_ids).toContain(item.id);
  });

  it("refuses the old fields, a host-chosen result_id, the baseline as landed_commit, and an empty commit", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff, baselineCommit } =
      await prepareFixture();
    const item = handoff.workload.work_items[0]!;
    const path = expectContained(root, item.result_path, "result");
    const ingestCodes = async (value: Record<string, unknown>): Promise<string[]> => {
      await writeFile(path, JSON.stringify(value), "utf8");
      const summary = requireIngested(
        await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state }),
      );
      expect(summary.completed_work_item_ids).not.toContain(item.id);
      return summary.issues
        .filter((issue) => issue.work_item_id === item.id)
        .map((issue) => issue.code);
    };
    const landed = await landCommit(root, item.allowed_files[0]!);
    expect(
      await ingestCodes(resultShape(runId, item, landed, { changed_files: [item.allowed_files[0]] })),
    ).toEqual(["submission_contract_invalid"]);
    expect(
      await ingestCodes(resultShape(runId, item, landed, { result_id: "host-chosen" })),
    ).toEqual(["submission_contract_invalid"]);
    expect(await ingestCodes(resultShape(runId, item, baselineCommit))).toEqual([
      "landed_commit_invalid",
    ]);
    await git(root, ["commit", "--allow-empty", "-m", "empty"]);
    expect(await ingestCodes(resultShape(runId, item, await headOf(root)))).toEqual([
      "landed_commit_invalid",
    ]);
  });

  it("re-mints the binding of a workload written by an older build instead of wedging the run", async () => {
    const { boundary, root, artifactsDir, runId, state, handoff } = await prepareFixture();
    const workloadPath = expectContained(root, handoff.workload_path, "workload");
    // The older build wrote a v1alpha2 document under a digest this build can
    // no longer reproduce, because the prompt text changed.
    await writeFile(
      workloadPath,
      JSON.stringify({ ...handoff.workload, contract_version: "remediation-host-workload/v1alpha2" }),
      "utf8",
    );
    const staleState: CurrentState = {
      ...state,
      host_handoff: { ...handoff.handoff_record, workload_sha256: "0".repeat(64) },
    };
    const ingested = requireIngested(
      await boundary.ingestRemediationHostResults({
        root,
        artifactsDir,
        runId,
        state: staleState,
      }),
    );
    expect(ingested.issues.map((issue) => issue.code)).toContain("workload_stale");
    const reminted = requirePrepared(
      await boundary.prepareRemediationHostHandoff({
        root,
        artifactsDir,
        runId,
        baselineCommit: await headOf(root),
        state: staleState,
      }),
    );
    expect(reminted.workload.contract_version).toBe("remediation-host-workload/v2");
    expect(reminted.handoff_record).toEqual(handoff.handoff_record);
  });
});

describe("reviewed implementation context survives the real handoff", () => {
  it.each([false, true])("preserves reviewed semantics without synthetic findings (audit seed=%s)", async seeded => {
    const root = await mkdtemp(join(tmpdir(), "implementation-context-")); cleanupRoots.push(root);
    const baselineCommit = await initGitRoot(root), artifactsDir = join(root, ".audit-tools", "remediation");
    const sources = seeded ? [finding("finding-a", "src/a.ts")] : [];
    const unit = canonicalUnitFixture("N1", { title: "Repair refresh", description: "Serialize refresh attempts; session exists; atomic refresh",
      source_finding_ids: sources.map(source => source.id), addresses_counterexample_ids: ["CE-unique"], required_tests: ['node -e "process.exit(0)"'] });
    const counterexample = { id: "CE-unique", claim: "refresh race", reproduction_steps: ["refresh twice"], expected: "one session", actual: "duplicate sessions", requirement_ids: unit.requirement_ids, unit_ids: [unit.id] };
    const plan = canonicalPlanFixture({ plan_id: FIXTURE_RUN_ID, findings: sources, units: [unit],
      requirements: [{ id: unit.requirement_ids[0]!, description: "Exactly one session survives concurrent refresh", source_finding_ids: unit.source_finding_ids, change_kind: "structural", assertions: [] }],
      review_counterexamples: [counterexample],
      ...(!seeded ? { request: { id: "request-1", text: "Repair concurrent refresh", source_paths: [] } } : {}),
    });
    const state: CurrentState = { contract_version: CURRENT_STATE_VERSION, status: "implementing", plan, items: { N1: { unit_id: "N1", status: "pending" } } };
    await writeApprovedPlanFixture(artifactsDir, state, root);
    const handoff = requirePrepared(await (await loadBoundary()).prepareRemediationHostHandoff({ root, artifactsDir, runId: FIXTURE_RUN_ID, baselineCommit, state }));
    const text = handoff.workload.work_items[0]!.prompt.text;
    for (const fact of ["session exists", "atomic refresh", "refresh twice", "Serialize refresh attempts"]) expect(text).toContain(fact);
    expect(state.plan.findings).toEqual(sources);
    if (seeded) { expect(state.plan.findings[0]).not.toHaveProperty("concrete_change"); expect(state.plan.findings[0]).not.toHaveProperty("preconditions"); }
    else expect(state.plan.findings).toEqual([]);
  });
});

describe("host handoff repair and root observations", () => {
  it('rebinds an explicitly reapproved unit revision and refuses the old prompt result', async () => {
    const { boundary, root, artifactsDir, runId, state, handoff, baselineCommit } = await prepareFixture();
    const changed = {
      ...state,
      plan: { ...state.plan, units: state.plan.units.map(unit => ({ ...unit, description: `${unit.description} Updated required behavior.` })) },
    };
    await expect(boundary.prepareRemediationHostHandoff({ root, artifactsDir, runId, state: changed, baselineCommit })).rejects.toThrow(/approved revision/);
    await writeApprovedPlanFixture(artifactsDir, changed, root);
    const rebound = requirePrepared(await boundary.prepareRemediationHostHandoff({ root, artifactsDir, runId, state: changed, baselineCommit }));
    expect(rebound.handoff_record.workload_sha256).not.toBe(handoff.handoff_record.workload_sha256);
    expect(rebound.handoff_record.work_item_ids).toEqual(handoff.handoff_record.work_item_ids);
    expect(rebound.handoff_record.baseline_commit).toBe(handoff.handoff_record.baseline_commit);
    const oldItem = handoff.workload.work_items[0]!;
    await writeFile(expectContained(root, oldItem.result_path, 'old result'), JSON.stringify(resultShape(runId, oldItem, baselineCommit)));
    const ingested = requireIngested(await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state: { ...changed, host_handoff: rebound.handoff_record } }));
    expect(ingested.accepted_count).toBe(0);
    expect(ingested.issues.some((issue) => /identity|prompt/i.test(issue.message))).toBe(true);
  });

  it.each(['run', 'baseline', 'items'])('refuses a stale-version rebind with invalid prior %s identity', async (part) => {
    const { boundary, root, artifactsDir, runId, state, handoff, baselineCommit } = await prepareFixture();
    const old = JSON.parse(await readFile(handoff.workload_path, 'utf8'));
    old.contract_version = 'remediation-host-workload/v1alpha1';
    if (part === 'run') old.run_id = 'another-run';
    if (part === 'baseline') old.work_items[0].baseline_commit = 'f'.repeat(40);
    if (part === 'items') old.work_items[0].id = 'unexpected-block';
    await writeFile(handoff.workload_path, JSON.stringify(old));
    // A deliberate approved revision changes the derived workload digest and
    // exercises rebind. An unapproved source mutation would stop at authority
    // validation and never test the predecessor's run/baseline/item identity.
    const changed: CurrentState = { ...state, plan: { ...state.plan,
      units: state.plan.units.map(unit => ({ ...unit, description: `${unit.description} Revised approved behavior.` })),
    } };
    await writeApprovedPlanFixture(artifactsDir, changed, root);
    await expect(boundary.prepareRemediationHostHandoff({ root, artifactsDir, runId, state: changed, baselineCommit })).rejects.toThrow(/trusted identity|binding/i);
    expect(JSON.parse(await readFile(handoff.workload_path, 'utf8'))).toEqual(old);
    await writeFile(handoff.workload_path, JSON.stringify({ ...handoff.workload, contract_version: 'remediation-host-workload/v1alpha1' }));
    const restored = requirePrepared(await boundary.prepareRemediationHostHandoff({ root, artifactsDir, runId, state: changed, baselineCommit }));
    expect(restored.handoff_record.workload_sha256).not.toBe(handoff.handoff_record.workload_sha256);
    expect(restored.handoff_record).toMatchObject({
      run_id: handoff.handoff_record.run_id,
      baseline_commit: handoff.handoff_record.baseline_commit,
      work_item_ids: handoff.handoff_record.work_item_ids,
    });
  });

  it('reports newly observed ignored root logs on remediation ingestion without claiming their creator', async () => {
    const { boundary, root, artifactsDir, runId, state, handoff } = await prepareFixture();
    const ignorePath = join(root, '.gitignore');
    const ignore = existsSync(ignorePath) ? await readFile(ignorePath, 'utf8') : '';
    await writeFile(ignorePath, ignore + '\n*.log\n');
    await writeFile(join(root, 'peer-created.log'), 'unattributed output');
    await boundary.ingestRemediationHostResults({ root, artifactsDir, runId, state });
    const record = JSON.parse(await readFile(join(dirname(handoff.workload_path), 'root-log-observations.json'), 'utf8'));
    expect(record.observations).toEqual([expect.objectContaining({ name: 'peer-created.log', creator: 'unknown' })]);
    expect(await readFile(join(root, 'peer-created.log'), 'utf8')).toBe('unattributed output');
  });
});
