// Shared fixture for the host-handoff-corroboration test files (split so no
// single file dominates the suite's wall): the git-backed remediation work item,
// its bound state, and the required-test scripts.
import { canonicalStateFromLegacyFixture, writeApprovedPlanFixture } from "./canonicalPlanFixture.js";
import { expect } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { precomputeRecoveryTestVerdicts, prepareRemediationHostHandoff } from "../../../src/remediate/steps/dispatch/hostHandoff.js";
import { type CurrentRemediationHostState, type PreparedRemediationHostHandoff, type RemediationHostWorkItem } from "../../../src/remediate/steps/dispatch/hostContracts.js";
import { type RemediationRequiredTestVerdicts } from "../../../src/remediate/steps/dispatch/requiredTests.js";

import { REMEDIATION_HOST_RESULT_CONTRACT_VERSION as RESULT_VERSION } from "../../../src/remediate/steps/types.js";
import { REMEDIATION_STATE_CONTRACT_VERSION } from "../../../src/remediate/state/store.js";
import { type RemediationHostHandoffRecord } from "../../../src/remediate/state/types.js";
import { deriveResultId } from "audit-tools/shared";
import { execFileSyncHidden } from "../../helpers/spawn.mjs";

export const cleanupRoots: string[] = [];

/** Register with `afterEach` in each consuming file. */
export async function cleanupHostHandoffFixtures(): Promise<void> {
  await Promise.all(
    cleanupRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
}

export function git(root: string, args: string[]): string {
  return String(
    execFileSyncHidden("git", args, { cwd: root, encoding: "utf8" }),
  ).trim();
}

export interface Fixture {
  root: string;
  artifactsDir: string;
  runId: string;
  baseline: string;
  state: CurrentRemediationHostState;
  handoff: PreparedRemediationHostHandoff;
  item: RemediationHostWorkItem;
  workItems: readonly RemediationHostWorkItem[];
}

export async function fixture(options: {
  allowedFiles?: string[];
  otherAllowedFiles?: string[];
  affectedFiles?: Array<{ path: string; hash_at_plan_time?: string }>;
  otherAffectedFiles?: Array<{ path: string; hash_at_plan_time?: string }>;
  requiredTest?: string;
  /**
   * A unit's WHOLE required-test list. `requiredTest` is the single
   * command most tests need; this is for the tests that must bind several, where
   * the NUMBER of commands is the variable under test (a per-command excerpt is
   * fine; the message JOINS them, so its size scales with the count).
   */
  requiredTests?: string[];
  runStartDirty?: string[];
  /**
   * Add a VERIFIED dependency unit `B0` ahead of `B1`. At mint time B0 is
   * `resolved`, so B1 is the whole level-zero frontier and the workload binds
   * to it alone; `reopenGate` then flips B0 back to pending, which is how a
   * bound work item becomes dependency-ineligible without touching the plan
   * the workload digest is bound to.
   */
  gateBlock?: boolean;
  /**
   * Add a SECOND independent level-zero unit `B2` over `src/b.ts`, binding the
   * same required tests as `B1`. Both land in one workload, which is what
   * makes a shared required test's spawn count observable.
   */
  twoBlocks?: boolean;
  secondDependsOnFirst?: boolean;
  /**
   * Give B1 stable contract requirements (deliberately unsorted) and reviewed
   * affected-interface semantics, which the obligation evidence-coverage
   * floor binds and enforces independently of the original source finding.
   */
  contractOverlays?: boolean;
  /**
   * Runs after the initial commit and BEFORE the handoff is prepared, so a test
   * can advance HEAD first and bind the trusted baseline to a non-root commit.
   */
  beforePrepare?: (root: string) => Promise<void> | void;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "remediation-host-git-"));
  cleanupRoots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const value = 1;\n");
  await writeFile(join(root, "src", "b.ts"), "export const other = 1;\n");
  // Never `git add`ed, so it stays untracked and out of every landed diff, the
  // same way `.counter` itself does.
  await writeFile(join(root, COUNTER_SCRIPT), COUNTER_SCRIPT_SOURCE);
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "src/a.ts", "src/b.ts"]);
  git(root, ["commit", "-m", "baseline"]);
  await options.beforePrepare?.(root);
  const baseline = git(root, ["rev-parse", "HEAD"]);
  const allowedFiles = options.allowedFiles ?? ["src/a.ts"];
  const runId = "git-corroboration";
  const artifactsDir = join(root, ".audit-tools", "remediation");
  const state = canonicalStateFromLegacyFixture({
    contract_version: REMEDIATION_STATE_CONTRACT_VERSION,
    status: "implementing",
    plan: {
      plan_id: runId,
      findings: [
        ...(options.twoBlocks
          ? [
              {
                id: "F2",
                title: "Correct the other exported value",
                category: "correctness",
                severity: "high" as const,
                confidence: "high" as const,
                lens: "correctness",
                summary: "Change the other exported value.",
                affected_files:
                  options.otherAffectedFiles ?? [{ path: "src/b.ts" }],
                evidence: ["src/b.ts:1 returns the stale value"],
              },
            ]
          : []),
        ...(options.gateBlock
          ? [
              {
                id: "F0",
                title: "Land the prerequisite",
                category: "correctness",
                severity: "medium" as const,
                confidence: "high" as const,
                lens: "correctness",
                summary: "Land the prerequisite B1 depends on.",
                affected_files: [{ path: "src/b.ts" }],
                evidence: ["src/b.ts:1 carries the prerequisite"],
              },
            ]
          : []),
        {
          id: "F1",
          title: "Correct the returned value",
          category: "correctness",
          severity: "high" as const,
          confidence: "high" as const,
          lens: "correctness",
          summary: "Change the exported value from one to two.",
          affected_files: options.affectedFiles ?? [{ path: "src/a.ts" }],
          evidence: ["src/a.ts:1 returns the stale value"],
          // Deliberately unsorted: the work-item binding must sort them.
          ...(options.contractOverlays
            ? {
                contract_obligation_ids: [
                  "mod-a:output:2",
                  "mod-a:invariant:1",
                ],
              }
            : {}),
        },
      ],
      blocks: [
        ...(options.gateBlock
          ? [
              {
                block_id: "B0",
                items: ["F0"],
                parallel_safe: true,
                dependencies: [],
                touched_files: ["src/b.ts"],
                targeted_commands: ['node -e "process.exit(0)"'],
                phase_ordinal: 0,
                token_estimate: 100,
              },
            ]
          : []),
        {
          block_id: "B1",
          items: ["F1"],
          parallel_safe: true,
          dependencies: options.gateBlock ? ["B0"] : [],
          touched_files: allowedFiles,
          targeted_commands:
            options.requiredTests ??
            [options.requiredTest ?? 'node -e "process.exit(0)"'],
          phase_ordinal: 0,
          token_estimate: 250,
          ...(options.contractOverlays
            ? {
                module_contracts: [
                  {
                    module: "mod-a",
                    contract: {
                      name: "mod-a",
                      inputs: [],
                      outputs: ["src/a.ts exports value"],
                      invariants: ["the export name stays value"],
                      side_effects: [],
                      validation_boundary: "none",
                      failure_modes: [],
                    },
                  },
                ],
              }
            : {}),
        },
        ...(options.twoBlocks
          ? [
              {
                block_id: "B2",
                items: ["F2"],
                parallel_safe: true,
                dependencies: options.secondDependsOnFirst ? ["B1"] : [],
                touched_files: options.otherAllowedFiles ?? ["src/b.ts"],
                targeted_commands: [
                  options.requiredTest ?? 'node -e "process.exit(0)"',
                ],
                phase_ordinal: 0,
                token_estimate: 250,
              },
            ]
          : []),
      ],
      project_type: "typescript",
      candidate_closing_actions: ["none"],
    },
    items: {
      ...(options.gateBlock
        ? {
            F0: {
              finding_id: "F0",
              block_id: "B0",
              status: "resolved",
            },
          }
        : {}),
      F1: {
        finding_id: "F1",
        block_id: "B1",
        status: "pending",
        clarification_context: "Keep the public export name unchanged.",
        failure_context: "A prior attempt changed the API name.",
      },
      ...(options.twoBlocks
        ? {
            F2: {
              finding_id: "F2",
              block_id: "B2",
              status: "pending",
            },
          }
        : {}),
    },
    // The fixture's OWN untracked scratch is pre-existing dirt, exactly as a
    // real run's `run_start_dirty` (captured from `stagedAndUntracked` before
    // any remediation edit exists) would record it. Declared here so the
    // untracked probe leg sees the fixture the way it sees a real repo — the
    // alternative would be to let the fixture's scaffolding read as this host's
    // edit, which is a false red manufactured by the harness.
    run_start_dirty: [
      COUNTER_SCRIPT,
      ".counter",
      ...(options.runStartDirty ?? []),
    ],
  }) as CurrentRemediationHostState;
  if (options.contractOverlays) {
    const unit = state.plan.units.find(unit => unit.id === "B1")!;
    state.plan.requirements = state.plan.requirements.filter(requirement => !unit.requirement_ids.includes(requirement.id));
    unit.requirement_ids = ["mod-a:output:2", "mod-a:invariant:1"];
    state.plan.requirements.push(...unit.requirement_ids.map(id => ({
      id, description: id, source_finding_ids: ["F1"], change_kind: "structural" as const,
      assertions: [{ kind: "positive" as const, description: "src/a.ts preserves the export contract", scope_paths: ["src/a.ts"] }],
    })));
    unit.affected_interfaces = [{ name: "mod-a", description: "src/a.ts exports value and preserves its name" }];
  }
  await writeApprovedPlanFixture(artifactsDir, state, root);
  const prepared = await prepareRemediationHostHandoff({
    root,
    artifactsDir,
    runId,
    baselineCommit: baseline,
    state,
  });
  if (prepared === "unsupported_retired_state") {
    throw new Error("fixture state unexpectedly rejected");
  }
  return {
    root,
    artifactsDir,
    runId,
    baseline,
    state,
    handoff: prepared,
    item: prepared.workload.work_items[0]!,
    workItems: prepared.workload.work_items,
  };
}

export function boundState(
  value: Fixture,
  record: RemediationHostHandoffRecord = value.handoff.handoff_record,
): CurrentRemediationHostState {
  return { ...value.state, host_handoff: record, conformance_review: value.handoff.conformance_review };
}


export async function persistBoundState(
  value: Fixture,
  state: CurrentRemediationHostState = boundState(value),
): Promise<void> {
  // Written WITH its contract version, because that is the only state shape the
  // store can produce: it stamps the version on every write and its load path
  // passes the on-disk value through to `parseCurrentState` unchanged. (This
  // helper used to delete the field, and the reader used to fabricate it back —
  // so the version check in `parseCurrentState` compared a constant to itself
  // and could not fail. The fixture now writes what the store writes.)
  await writeFile(
    join(value.artifactsDir, "state.json"),
    JSON.stringify(state),
    "utf8",
  );
}

/**
 * THE landed-result builder for this file (v1alpha3): the identity is DERIVED
 * from the work item — `deriveResultId` over its prompt digest — and the host
 * states only the landed commit and the obligation evidence. The changed files
 * are the tool's to derive from git, and the tests the tool's to rerun.
 */
export function resultFor(
  value: Pick<Fixture, "runId" | "item">,
  landedCommit: string,
  item: RemediationHostWorkItem = value.item,
): Record<string, unknown> {
  return {
    contract_version: RESULT_VERSION,
    result_id: deriveResultId(item.id, item.prompt.sha256),
    run_id: value.runId,
    work_item_id: item.id,
    prompt_sha256: item.prompt.sha256,
    landed_commit: landedCommit,
    obligation_evidence: item.obligation_ids.map(obligation_id => ({ obligation_id, evidence: ["src/a.ts:1 implements the reviewed requirement"] })),
  };
}

export function decisionFor(
  value: Fixture,
  outcome: Record<string, unknown>,
  item: RemediationHostWorkItem = value.item,
): Record<string, unknown> {
  return {
    contract_version: "remediation-host-decision/v1alpha1",
    // Decisions pass the same identity walk: the id is the tool's derivation.
    result_id: deriveResultId(item.id, item.prompt.sha256),
    run_id: value.runId,
    work_item_id: item.id,
    prompt_sha256: item.prompt.sha256,
    outcome,
  };
}

/**
 * The write-scope refusal, pinned by code, check AND the file it names: the
 * corroboration message lists the git-derived files outside `allowed_files`,
 * so a refusal for some other reason cannot pass for this one.
 */
export function expectWriteScopeRefusal(
  issues: readonly { code: string; check?: string; message: string }[],
  outOfScopeFile: string,
): void {
  const refusal = issues.find((issue) => issue.code === "changed_files_mismatch");
  expect(refusal, "the write-scope refusal must be raised").toBeDefined();
  expect(refusal!.check).toBe("write_scope");
  expect(refusal!.message).toContain(outOfScopeFile);
}

export async function writeResult(
  value: Fixture,
  result: Record<string, unknown>,
  item: RemediationHostWorkItem = value.item,
): Promise<void> {
  const path = resolve(value.root, item.result_path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result), "utf8");
}

export async function landA(value: Fixture): Promise<string> {
  await writeFile(join(value.root, "src", "a.ts"), "export const value = 2;\n");
  git(value.root, ["add", "src/a.ts"]);
  git(value.root, ["commit", "-m", "fix a"]);
  return git(value.root, ["rev-parse", "HEAD"]);
}

/** Land a distinct second commit, touching only `src/b.ts`. */
export async function landB(value: Fixture): Promise<string> {
  await writeFile(join(value.root, "src", "b.ts"), "export const other = 3;\n");
  git(value.root, ["add", "src/b.ts"]);
  git(value.root, ["commit", "-m", "fix b"]);
  return git(value.root, ["rev-parse", "HEAD"]);
}

/** Every branch/tag/remote ref whose history contains this commit. */
export function refsContaining(root: string, commit: string): string {
  return git(root, [
    "for-each-ref",
    "--contains",
    commit,
    "--format=%(refname)",
  ]);
}

/** `git merge-base --is-ancestor` exits non-zero (i.e. throws here) when false. */
export function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  try {
    git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A deliberately NON-idempotent required test: every spawn appends one byte to
 * `.counter` in the repo root, so the number of spawns is directly observable.
 * Untracked, so it never enters a landed commit's diff.
 *
 * A SCRIPT rather than a `node -e` one-liner because the consumed-shape scan
 * refuses `'` and `\` in every position — their meaning differs between sh and
 * cmd.exe — which leaves no way to write a string literal inline.
 */
export const COUNTER_SCRIPT = "append-counter.mjs";
export const COUNTER_TEST = `node ${COUNTER_SCRIPT}`;
export const COUNTER_SCRIPT_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  'appendFileSync(new URL("./.counter", import.meta.url), "x");',
  "",
].join("\n");

/**
 * A required-test command must satisfy the consumed-shape scan: it executes
 * VERBATIM through a shell, so anything that chains, redirects, substitutes or
 * embeds a quote is refused at handoff preparation. These two behaviors — a
 * hang past a deadline, and a child that outruns the capture buffer — therefore
 * need their own SCRIPTS rather than a `node -e` one-liner, exactly as the
 * non-idempotent counter above does.
 */
export const HANG_SCRIPT = "hang-past-deadline.mjs";
export const HANG_TEST = `node ${HANG_SCRIPT}`;
export const HANG_SCRIPT_SOURCE = [
  'console.log("partial suite output");',
  "setTimeout(function () {}, 60000);",
  "",
].join("\n");

/**
 * A RED suite that also prints close to the capture cap, so the issue message
 * built from its captured output is long for a reason that is not the failure's
 * own diagnosis. `process.exit(1)` after the write keeps the exit code the
 * `required_test_failed` arm reports.
 */
export const VERBOSE_RED_SCRIPT = "verbose-red.mjs";
export const VERBOSE_RED_TEST = `node ${VERBOSE_RED_SCRIPT}`;
export const VERBOSE_RED_SCRIPT_SOURCE = [
  'process.stdout.write("noise ".repeat(300000));',
  "process.exit(1);",
  "",
].join("\n");

export const OVERFLOW_SCRIPT = "outrun-capture-buffer.mjs";
export const OVERFLOW_TEST = `node ${OVERFLOW_SCRIPT}`;
// NO `process.exit(0)`, deliberately: on linux a pipe write is ASYNCHRONOUS and
// `process.exit` truncates whatever is still pending, so the child would exit 0
// for real and never overflow the cap. Left to exit naturally, node stays alive
// until the stream drains, so all 9MiB must cross the pipe on every platform.
export const OVERFLOW_SCRIPT_SOURCE = [
  'process.stdout.write("x".repeat(9 * 1024 * 1024));',
  "",
].join("\n");

export async function counterRuns(root: string): Promise<number> {
  try {
    return (await readFile(join(root, ".counter"), "utf8")).length;
  } catch {
    return 0;
  }
}

/**
 * The recovery option, built the way the verb builds it: phase 1 runs every
 * distinct required-test command ONCE, unlocked, and the resulting verdict
 * table is what the (spawn-free) ingest reads.
 */
export async function recoveryOptions(
  value: Fixture,
  state: CurrentRemediationHostState = boundState(value),
  requiredTestTimeoutMs?: number,
): Promise<{ requiredTestVerdicts: RemediationRequiredTestVerdicts }> {
  const requiredTestVerdicts = await precomputeRecoveryTestVerdicts({
    root: value.root,
    artifactsDir: value.artifactsDir,
    runId: value.runId,
    state,
    requiredTestTimeoutMs,
  });
  if (requiredTestVerdicts === "unsupported_retired_state") {
    throw new Error("fixture state unexpectedly rejected");
  }
  return { requiredTestVerdicts };
}

/**
 * The wedge, reproduced: a post-prepare `git commit --amend` re-mints the
 * baseline, so the trusted binding stays pinned to a commit no ref reaches, and
 * the item's work then lands on the re-minted line. The landed commit is real,
 * reachable from HEAD, and exactly scoped — it simply does not descend from the
 * orphan the workload was bound to.
 */
export async function orphanBaselineAndLand(value: Fixture): Promise<string> {
  await writeFile(join(value.root, "src", "b.ts"), "export const other = 2;\n");
  git(value.root, ["add", "src/b.ts"]);
  git(value.root, ["commit", "--amend", "--no-edit"]);
  // The fixture must leave the baseline TRULY orphaned. If the amend left any
  // ref containing it, the guard would refuse (correctly) and every test built
  // on this helper would be asserting the wrong thing.
  expect(refsContaining(value.root, value.baseline)).toBe("");
  return landA(value);
}

/** Flip the gate unit back to pending, making the bound work item ineligible. */
export function reopenGate(value: Fixture): CurrentRemediationHostState {
  const bound = boundState(value);
  return {
    ...bound,
    items: {
      ...bound.items,
      B0: { ...bound.items.B0!, status: "pending" },
    },
  };
}

