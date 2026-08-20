import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  ingestRemediationHostResults,
  precomputeRecoveryTestVerdicts,
  prepareRemediationHostHandoff,
  runRequiredTest,
  type CurrentRemediationHostState,
  type PreparedRemediationHostHandoff,
  type RemediationHostWorkItem,
  type RemediationRequiredTestVerdicts,
  type RequiredTestFailure,
} from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { recoverIngestHostResults } from "../../src/remediate/steps/nextStep.js";
import type { RemediationHostHandoffRecord } from "../../src/remediate/state/types.js";
import { readSubmissionLedger } from "audit-tools/shared";
import { execFileSyncHidden } from "../helpers/spawn.mjs";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

function git(root: string, args: string[]): string {
  return String(
    execFileSyncHidden("git", args, { cwd: root, encoding: "utf8" }),
  ).trim();
}

interface Fixture {
  root: string;
  artifactsDir: string;
  runId: string;
  baseline: string;
  state: CurrentRemediationHostState;
  handoff: PreparedRemediationHostHandoff;
  item: RemediationHostWorkItem;
  workItems: readonly RemediationHostWorkItem[];
}

async function fixture(options: {
  allowedFiles?: string[];
  requiredTest?: string;
  runStartDirty?: string[];
  /**
   * Add a VERIFIED dependency block `B0` ahead of `B1`. At mint time B0 is
   * `resolved`, so B1 is the whole level-zero frontier and the workload binds
   * to it alone; `reopenGate` then flips B0 back to pending, which is how a
   * bound work item becomes dependency-ineligible without touching the plan
   * the workload digest is bound to.
   */
  gateBlock?: boolean;
  /**
   * Add a SECOND independent level-zero block `B2` over `src/b.ts`, binding the
   * same `targeted_commands` as `B1`. Both land in one workload, which is what
   * makes a shared required test's spawn count observable.
   */
  twoBlocks?: boolean;
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
  const state = {
    contract_version: "remediate-code-state/v1alpha1",
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
                severity: "high",
                confidence: "high",
                lens: "correctness",
                summary: "Change the other exported value.",
                affected_files: [{ path: "src/b.ts" }],
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
                severity: "medium",
                confidence: "high",
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
          severity: "high",
          confidence: "high",
          lens: "correctness",
          summary: "Change the exported value from one to two.",
          affected_files: [{ path: "src/a.ts" }],
          evidence: ["src/a.ts:1 returns the stale value"],
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
          targeted_commands: [
            options.requiredTest ?? 'node -e "process.exit(0)"',
          ],
          phase_ordinal: 0,
          token_estimate: 250,
        },
        ...(options.twoBlocks
          ? [
              {
                block_id: "B2",
                items: ["F2"],
                parallel_safe: true,
                dependencies: [],
                touched_files: ["src/b.ts"],
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
        item_spec: {
          finding_id: "F1",
          concrete_change: "Replace the exported literal and add focused coverage.",
          tests_to_write: [
            { name: "value regression", assertions: ["exports two"] },
          ],
          not_applicable_steps: [],
        },
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
    ...(options.runStartDirty
      ? { run_start_dirty: options.runStartDirty }
      : {}),
  } as unknown as CurrentRemediationHostState;
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

function boundState(
  value: Fixture,
  record: RemediationHostHandoffRecord = value.handoff.handoff_record,
): CurrentRemediationHostState {
  return { ...value.state, host_handoff: record };
}

function resultFor(
  value: Fixture,
  after: string,
  changedFiles: string[] = ["src/a.ts"],
  item: RemediationHostWorkItem = value.item,
): Record<string, unknown> {
  return {
    contract_version: "remediation-host-result/v1alpha1",
    result_id: `result-${item.id}-${after.slice(0, 12)}`,
    run_id: value.runId,
    work_item_id: item.id,
    prompt_sha256: item.prompt.sha256,
    changed_files: changedFiles,
    commit_evidence: { before: value.baseline, after },
    test_evidence: item.required_tests.map((command) => ({
      command,
      status: "passed",
    })),
    worktree_evidence: {
      baseline_commit: value.baseline,
      changed_files: changedFiles,
    },
    acceptance: { status: "accepted" },
    merge: { status: "merged" },
  };
}

function decisionFor(
  value: Fixture,
  outcome: Record<string, unknown>,
): Record<string, unknown> {
  return {
    contract_version: "remediation-host-decision/v1alpha1",
    result_id: `decision-${value.item.id}`,
    run_id: value.runId,
    work_item_id: value.item.id,
    prompt_sha256: value.item.prompt.sha256,
    outcome,
  };
}

async function writeResult(
  value: Fixture,
  result: Record<string, unknown>,
  item: RemediationHostWorkItem = value.item,
): Promise<void> {
  const path = resolve(value.root, item.result_path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result), "utf8");
}

async function landA(value: Fixture): Promise<string> {
  await writeFile(join(value.root, "src", "a.ts"), "export const value = 2;\n");
  git(value.root, ["add", "src/a.ts"]);
  git(value.root, ["commit", "-m", "fix a"]);
  return git(value.root, ["rev-parse", "HEAD"]);
}

/** Land a distinct second commit, touching only `src/b.ts`. */
async function landB(value: Fixture): Promise<string> {
  await writeFile(join(value.root, "src", "b.ts"), "export const other = 3;\n");
  git(value.root, ["add", "src/b.ts"]);
  git(value.root, ["commit", "-m", "fix b"]);
  return git(value.root, ["rev-parse", "HEAD"]);
}

/** Every branch/tag/remote ref whose history contains this commit. */
function refsContaining(root: string, commit: string): string {
  return git(root, [
    "for-each-ref",
    "--contains",
    commit,
    "--format=%(refname)",
  ]);
}

/** `git merge-base --is-ancestor` exits non-zero (i.e. throws here) when false. */
function isAncestor(root: string, ancestor: string, descendant: string): boolean {
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
 */
const COUNTER_TEST =
  `node -e "require('fs').appendFileSync('.counter','x')"`;

async function counterRuns(root: string): Promise<number> {
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
async function recoveryOptions(
  value: Fixture,
  state: CurrentRemediationHostState = boundState(value),
): Promise<{ requiredTestVerdicts: RemediationRequiredTestVerdicts }> {
  const requiredTestVerdicts = await precomputeRecoveryTestVerdicts({
    root: value.root,
    artifactsDir: value.artifactsDir,
    runId: value.runId,
    state,
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
async function orphanBaselineAndLand(value: Fixture): Promise<string> {
  await writeFile(join(value.root, "src", "b.ts"), "export const other = 2;\n");
  git(value.root, ["add", "src/b.ts"]);
  git(value.root, ["commit", "--amend", "--no-edit"]);
  // The fixture must leave the baseline TRULY orphaned. If the amend left any
  // ref containing it, the guard would refuse (correctly) and every test built
  // on this helper would be asserting the wrong thing.
  expect(refsContaining(value.root, value.baseline)).toBe("");
  return landA(value);
}

/** Flip the gate block back to pending, making the bound work item ineligible. */
function reopenGate(value: Fixture): CurrentRemediationHostState {
  const bound = boundState(value);
  return {
    ...bound,
    items: {
      ...bound.items,
      F0: { ...bound.items.F0!, status: "pending" },
    },
  };
}

describe("remediation host handoff repository corroboration", () => {
  it("binds complete finding, specification, clarification, and retry instructions into the prompt", async () => {
    const value = await fixture();
    expect(value.item.prompt.text).toContain("Correct the returned value");
    expect(value.item.prompt.text).toContain(
      "Change the exported value from one to two.",
    );
    expect(value.item.prompt.text).toContain(
      "Replace the exported literal and add focused coverage.",
    );
    expect(value.item.prompt.text).toContain(
      "Keep the public export name unchanged.",
    );
    expect(value.item.prompt.text).toContain(
      "A prior attempt changed the API name.",
    );
  });

  it("accepts a real reachable commit with an exact diff and mechanically green required test", async () => {
    const value = await fixture();
    const after = await landA(value);
    await writeResult(value, resultFor(value, after));

    const ingested = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    expect(ingested).not.toBe("unsupported_retired_state");
    if (ingested === "unsupported_retired_state") return;
    expect(ingested.accepted_count).toBe(1);
    expect(ingested.issues).toEqual([]);
    expect(ingested.state.items.F1!.status).toBe("resolved");
    expect(ingested.state.applied_edit_surface).toEqual(["src/a.ts"]);
    expect(ingested.state.host_handoff).toBeUndefined();
  });

  it("rejects fabricated and unlanded commit evidence", async () => {
    const fabricated = await fixture();
    await writeResult(fabricated, resultFor(fabricated, "2".repeat(40)));
    const missing = await ingestRemediationHostResults({
      root: fabricated.root,
      artifactsDir: fabricated.artifactsDir,
      runId: fabricated.runId,
      state: boundState(fabricated),
    });
    expect(missing).not.toBe("unsupported_retired_state");
    if (missing === "unsupported_retired_state") return;
    expect(missing.issues.map((issue) => issue.code)).toContain("commit_missing");

    const unlanded = await fixture();
    git(unlanded.root, ["checkout", "-b", "side"]);
    const sideCommit = await landA(unlanded);
    git(unlanded.root, ["checkout", "-"]);
    await writeResult(unlanded, resultFor(unlanded, sideCommit));
    const rejected = await ingestRemediationHostResults({
      root: unlanded.root,
      artifactsDir: unlanded.artifactsDir,
      runId: unlanded.runId,
      state: boundState(unlanded),
    });
    expect(rejected).not.toBe("unsupported_retired_state");
    if (rejected === "unsupported_retired_state") return;
    expect(rejected.issues.map((issue) => issue.code)).toContain(
      "commit_not_landed",
    );
  });

  it("rejects a self-consistent host rewrite of the workload", async () => {
    const value = await fixture();
    const workload = JSON.parse(
      await readFile(value.handoff.workload_path, "utf8"),
    ) as { work_items: Array<{ token_estimate: number }> };
    workload.work_items[0]!.token_estimate += 1;
    await writeFile(
      value.handoff.workload_path,
      JSON.stringify(workload),
      "utf8",
    );
    const ingested = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    expect(ingested).not.toBe("unsupported_retired_state");
    if (ingested === "unsupported_retired_state") return;
    expect(ingested.issues.map((issue) => issue.code)).toEqual([
      "workload_invalid",
    ]);
  });

  it("rejects reported files that differ from the landed commit and files dirty at run start", async () => {
    const mismatch = await fixture({ allowedFiles: ["src/a.ts", "src/b.ts"] });
    const after = await landA(mismatch);
    await writeResult(mismatch, resultFor(mismatch, after, ["src/b.ts"]));
    const mismatched = await ingestRemediationHostResults({
      root: mismatch.root,
      artifactsDir: mismatch.artifactsDir,
      runId: mismatch.runId,
      state: boundState(mismatch),
    });
    expect(mismatched).not.toBe("unsupported_retired_state");
    if (mismatched === "unsupported_retired_state") return;
    expect(mismatched.issues.map((issue) => issue.code)).toContain(
      "changed_files_mismatch",
    );

    const dirty = await fixture({ runStartDirty: ["src/a.ts"] });
    const dirtyAfter = await landA(dirty);
    await writeResult(dirty, resultFor(dirty, dirtyAfter));
    const dirtyRejected = await ingestRemediationHostResults({
      root: dirty.root,
      artifactsDir: dirty.artifactsDir,
      runId: dirty.runId,
      state: boundState(dirty),
    });
    expect(dirtyRejected).not.toBe("unsupported_retired_state");
    if (dirtyRejected === "unsupported_retired_state") return;
    expect(dirtyRejected.issues.map((issue) => issue.code)).toContain(
      "run_start_dirty_overlap",
    );
  });

  it("reruns required tests and reports malformed result JSON explicitly", async () => {
    const failing = await fixture({
      requiredTest: 'node -e "process.exit(1)"',
    });
    const after = await landA(failing);
    await writeResult(failing, resultFor(failing, after));
    const failed = await ingestRemediationHostResults({
      root: failing.root,
      artifactsDir: failing.artifactsDir,
      runId: failing.runId,
      state: boundState(failing),
    });
    expect(failed).not.toBe("unsupported_retired_state");
    if (failed === "unsupported_retired_state") return;
    expect(failed.issues.map((issue) => issue.code)).toContain(
      "required_test_failed",
    );
    expect(failed.state.items.F1!.status).toBe("pending");

    const malformed = await fixture();
    const path = resolve(malformed.root, malformed.item.result_path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json", "utf8");
    const diagnosed = await ingestRemediationHostResults({
      root: malformed.root,
      artifactsDir: malformed.artifactsDir,
      runId: malformed.runId,
      state: boundState(malformed),
    });
    expect(diagnosed).not.toBe("unsupported_retired_state");
    if (diagnosed === "unsupported_retired_state") return;
    expect(diagnosed.issues.map((issue) => issue.code)).toContain(
      "submission_malformed",
    );
  });

  it("converges explicit no-change, blocked, and clarification outcomes without fabricated merge evidence", async () => {
    const noChange = await fixture();
    await writeResult(
      noChange,
      decisionFor(noChange, {
        status: "resolved_no_change",
        evidence: ["The current export already satisfies the requested contract."],
      }),
    );
    const noChangeResult = await ingestRemediationHostResults({
      root: noChange.root,
      artifactsDir: noChange.artifactsDir,
      runId: noChange.runId,
      state: boundState(noChange),
    });
    expect(noChangeResult).not.toBe("unsupported_retired_state");
    if (noChangeResult === "unsupported_retired_state") return;
    expect(noChangeResult.state.items.F1!.status).toBe("resolved_no_change");
    expect(noChangeResult.state.items.F1!.host_result_evidence).toHaveLength(1);

    const blocked = await fixture();
    await writeResult(
      blocked,
      decisionFor(blocked, {
        status: "blocked",
        failure_reason: "The required upstream API is absent.",
      }),
    );
    const blockedResult = await ingestRemediationHostResults({
      root: blocked.root,
      artifactsDir: blocked.artifactsDir,
      runId: blocked.runId,
      state: boundState(blocked),
    });
    expect(blockedResult).not.toBe("unsupported_retired_state");
    if (blockedResult === "unsupported_retired_state") return;
    expect(blockedResult.state.items.F1).toMatchObject({
      status: "blocked",
      failure_reason: "The required upstream API is absent.",
    });

    const clarification = await fixture();
    await writeResult(
      clarification,
      decisionFor(clarification, {
        status: "needs_clarification",
        question: "Should the legacy export remain as an alias?",
        category: "compatibility_policy",
      }),
    );
    const clarificationResult = await ingestRemediationHostResults({
      root: clarification.root,
      artifactsDir: clarification.artifactsDir,
      runId: clarification.runId,
      state: boundState(clarification),
    });
    expect(clarificationResult).not.toBe("unsupported_retired_state");
    if (clarificationResult === "unsupported_retired_state") return;
    expect(clarificationResult.state.items.F1!.status).toBe(
      "needs_clarification",
    );
    expect(clarificationResult.state.clarifications).toEqual([
      {
        finding_id: "F1",
        category: "compatibility_policy",
        description: "Should the legacy export remain as an alias?",
      },
    ]);
  });

  it("refuses an orphaned trusted baseline on the normal lane and accepts it only under the explicit recovery verb", async () => {
    const value = await fixture();
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));

    const normal = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    expect(normal).not.toBe("unsupported_retired_state");
    if (normal === "unsupported_retired_state") return;
    expect(normal.issues.map((issue) => issue.code)).toEqual([
      "baseline_not_ancestor",
    ]);
    expect(normal.accepted_count).toBe(0);
    expect(normal.state.items.F1!.status).toBe("pending");

    const recovered = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(recovered).not.toBe("unsupported_retired_state");
    if (recovered === "unsupported_retired_state") return;
    expect(recovered.issues).toEqual([]);
    expect(recovered.accepted_count).toBe(1);
    expect(recovered.state.items.F1!.status).toBe("resolved");
    expect(recovered.state.applied_edit_surface).toEqual(["src/a.ts"]);

    // No acceptance without a record: the relaxation is marked on the ledger,
    // so a run repaired this way stays distinguishable from a clean one.
    const events = await readSubmissionLedger(value.artifactsDir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      run_id: value.runId,
      submission_id: value.item.id,
      kind: "accepted_via_recovery",
    });
    expect(events[0]!.message).toContain(value.baseline);
    expect(events[0]!.message).toContain(landed);
  });

  it("refuses recovery when the trusted baseline is still reachable from HEAD", async () => {
    const value = await fixture({
      beforePrepare: async (root) => {
        // Branch the future sibling off the root commit, then advance the
        // baseline, so the trusted baseline is a healthy non-root ancestor.
        git(root, ["branch", "sibling"]);
        await writeFile(join(root, "src", "b.ts"), "export const other = 2;\n");
        git(root, ["add", "src/b.ts"]);
        git(root, ["commit", "-m", "advance the baseline"]);
      },
    });
    const trunk = git(value.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    git(value.root, ["checkout", "sibling"]);
    const sibling = await landA(value);
    git(value.root, ["checkout", trunk]);
    git(value.root, ["merge", "--no-ff", "-m", "merge sibling", "sibling"]);
    await writeResult(value, resultFor(value, sibling));

    // The baseline IS an ancestor of HEAD, so the stale-worker protection is
    // live and recovery must refuse exactly like the normal lane.
    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.state.items.F1!.status).toBe("pending");
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "baseline_not_ancestor",
    ]);
    expect(refused.issues[0]!.message).toContain("NOT orphaned");
    expect(await readSubmissionLedger(value.artifactsDir)).toEqual([]);
  });

  it("refuses a recovery acceptance whose ledger mark cannot be recorded", async () => {
    const value = await fixture();
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));
    // Occupy the ledger's own directory with a FILE, so the append cannot land.
    await mkdir(value.artifactsDir, { recursive: true });
    await writeFile(
      join(value.artifactsDir, "submissions"),
      "not a directory",
      "utf8",
    );

    const unrecorded = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(unrecorded).not.toBe("unsupported_retired_state");
    if (unrecorded === "unsupported_retired_state") return;
    expect(unrecorded.accepted_count).toBe(0);
    expect(unrecorded.state.items.F1!.status).toBe("pending");
    expect(unrecorded.issues.map((issue) => issue.code)).toEqual([
      "recovery_unrecorded",
    ]);
  });

  it("refuses recovery when a live ref still contains the baseline, though HEAD does not", async () => {
    // The baseline sits on an unmerged `feature` branch and the work landed on
    // trunk. Ancestry fails exactly as it does for a rewritten-away baseline —
    // but the repository still KEEPS this one, so it is the ordinary
    // stale-worker case, not an orphan, and recovery must refuse it.
    const value = await fixture({
      beforePrepare: async (root) => {
        git(root, ["checkout", "-b", "feature"]);
        await writeFile(join(root, "src", "b.ts"), "export const other = 2;\n");
        git(root, ["add", "src/b.ts"]);
        git(root, ["commit", "-m", "advance the feature branch"]);
      },
    });
    git(value.root, ["checkout", "-"]);
    const landed = await landA(value);
    await writeResult(value, resultFor(value, landed));

    // The precondition the guard must detect: unreachable from HEAD, yet held
    // by a live ref.
    expect(isAncestor(value.root, value.baseline, "HEAD")).toBe(false);
    expect(refsContaining(value.root, value.baseline)).toContain(
      "refs/heads/feature",
    );

    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.state.items.F1!.status).toBe("pending");
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "baseline_not_ancestor",
    ]);
    expect(refused.issues[0]!.message).toContain("NOT orphaned");
    expect(await readSubmissionLedger(value.artifactsDir)).toEqual([]);
  });

  it("reruns a shared required test per work item on the normal lane, and once per call under recovery", async () => {
    // A targeted_command need not be idempotent, so collapsing spawns is
    // observable. The normal lane must keep spawning per work item; only
    // recovery — where one operator call may corroborate a dozen items binding
    // the same command — memoizes.
    const normal = await fixture({ twoBlocks: true, requiredTest: COUNTER_TEST });
    const normalA = await landA(normal);
    const normalB = await landB(normal);
    await writeResult(normal, resultFor(normal, normalA));
    await writeResult(
      normal,
      resultFor(normal, normalB, ["src/b.ts"], normal.workItems[1]!),
      normal.workItems[1]!,
    );
    const ingested = await ingestRemediationHostResults({
      root: normal.root,
      artifactsDir: normal.artifactsDir,
      runId: normal.runId,
      state: boundState(normal),
    });
    expect(ingested).not.toBe("unsupported_retired_state");
    if (ingested === "unsupported_retired_state") return;
    expect(ingested.issues).toEqual([]);
    expect(ingested.accepted_count).toBe(2);
    expect(await counterRuns(normal.root)).toBe(2);

    const recovery = await fixture({
      twoBlocks: true,
      requiredTest: COUNTER_TEST,
    });
    const recoveryA = await orphanBaselineAndLand(recovery);
    const recoveryB = await landB(recovery);
    await writeResult(recovery, resultFor(recovery, recoveryA));
    await writeResult(
      recovery,
      resultFor(recovery, recoveryB, ["src/b.ts"], recovery.workItems[1]!),
      recovery.workItems[1]!,
    );
    const recovered = await ingestRemediationHostResults({
      root: recovery.root,
      artifactsDir: recovery.artifactsDir,
      runId: recovery.runId,
      state: boundState(recovery),
      recovery: await recoveryOptions(recovery),
    });
    expect(recovered).not.toBe("unsupported_retired_state");
    if (recovered === "unsupported_retired_state") return;
    expect(recovered.issues).toEqual([]);
    expect(recovered.accepted_count).toBe(2);
    expect(await counterRuns(recovery.root)).toBe(1);
    // Both acceptances are marked, once each.
    expect(
      (await readSubmissionLedger(recovery.artifactsDir)).map(
        (event) => event.submission_id,
      ),
    ).toEqual(["B1", "B2"]);
  });

  it("does not append a second ledger mark when a recovery acceptance is retried", async () => {
    const value = await fixture();
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));
    const ingest = async () =>
      ingestRemediationHostResults({
        root: value.root,
        artifactsDir: value.artifactsDir,
        runId: value.runId,
        state: boundState(value),
        recovery: await recoveryOptions(value),
      });

    const first = await ingest();
    expect(first).not.toBe("unsupported_retired_state");
    if (first === "unsupported_retired_state") return;
    expect(first.accepted_count).toBe(1);
    // The retry a crash between the append and the state write would force:
    // the item is still pending, the mark is already on the ledger.
    const retried = await ingest();
    expect(retried).not.toBe("unsupported_retired_state");
    if (retried === "unsupported_retired_state") return;
    expect(retried.accepted_count).toBe(1);
    expect(await readSubmissionLedger(value.artifactsDir)).toHaveLength(1);
  });

  it("recovers through the exported entry point the CLI wraps", async () => {
    const value = await fixture();
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));
    const { contract_version: _contractVersion, ...persistable } =
      boundState(value);
    const statePath = join(value.artifactsDir, "state.json");
    await mkdir(value.artifactsDir, { recursive: true });
    await writeFile(statePath, JSON.stringify(persistable, null, 2), "utf8");

    const summary = await recoverIngestHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
    });
    expect(summary.accepted_count).toBe(1);
    expect(summary.state_changed).toBe(true);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as Record<
      string,
      unknown
    > & { items: Record<string, { status: string }> };
    // The boundary-only contract_version must never reach the persisted state.
    expect(persisted.contract_version).toBeUndefined();
    expect(persisted.items.F1!.status).toBe("resolved");

    const afterFirst = await readFile(statePath, "utf8");
    const again = await recoverIngestHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
    });
    expect(again.accepted_count).toBe(0);
    expect(again.state_changed).toBe(false);
    expect(await readFile(statePath, "utf8")).toBe(afterFirst);
  });

  it("never spawns a required test under recovery — a missing verdict fails closed", async () => {
    // The locked phase must not spawn: it reads the phase-1 verdict table and
    // nothing else. An EMPTY table therefore refuses every item WITHOUT running
    // the (deliberately observable) command.
    const value = await fixture({ requiredTest: COUNTER_TEST });
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));

    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: { requiredTestVerdicts: new Map() },
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "required_test_failed",
    ]);
    expect(refused.issues[0]!.message).toContain("refusing to spawn");
    expect(await counterRuns(value.root)).toBe(0);
    expect(await readSubmissionLedger(value.artifactsDir)).toEqual([]);
  });

  it("runs every required test before the lock and none inside it", async () => {
    // Two work items binding the same non-idempotent command: phase 1 runs it
    // once, phase 2 accepts both while spawning nothing.
    const value = await fixture({ twoBlocks: true, requiredTest: COUNTER_TEST });
    const landedA = await orphanBaselineAndLand(value);
    const landedB = await landB(value);
    await writeResult(value, resultFor(value, landedA));
    await writeResult(
      value,
      resultFor(value, landedB, ["src/b.ts"], value.workItems[1]!),
      value.workItems[1]!,
    );
    const { contract_version: _contractVersion, ...persistable } =
      boundState(value);
    await mkdir(value.artifactsDir, { recursive: true });
    await writeFile(
      join(value.artifactsDir, "state.json"),
      JSON.stringify(persistable, null, 2),
      "utf8",
    );

    const summary = await recoverIngestHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
    });
    expect(summary.issues).toEqual([]);
    expect(summary.accepted_count).toBe(2);
    expect(await counterRuns(value.root)).toBe(1);
  });

  it("aborts when HEAD moves between the unlocked test phase and the locked write", async () => {
    // The required test itself moves HEAD, which is exactly the mixed-provenance
    // case the guard exists for: the verdict describes a tree that is already
    // gone by the time the lock is taken.
    const value = await fixture({
      requiredTest: 'git commit --allow-empty -m "moved by the required test"',
    });
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));
    const { contract_version: _contractVersion, ...persistable } =
      boundState(value);
    await mkdir(value.artifactsDir, { recursive: true });
    await writeFile(
      join(value.artifactsDir, "state.json"),
      JSON.stringify(persistable, null, 2),
      "utf8",
    );

    const summary = await recoverIngestHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
    });
    expect(summary.accepted_count).toBe(0);
    expect(summary.state_changed).toBe(false);
    expect(summary.issues.map((issue) => issue.code)).toEqual([
      "tree_moved_between_phases",
    ]);
    expect(summary.state.items.F1!.status).toBe("pending");
    expect(await readSubmissionLedger(value.artifactsDir)).toEqual([]);
  });

  it("marks a re-accepted item again when the landed commit differs", async () => {
    const value = await fixture();
    const first = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, first));
    const accepted = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(accepted).not.toBe("unsupported_retired_state");
    if (accepted === "unsupported_retired_state") return;
    expect(accepted.accepted_count).toBe(1);
    expect(await readSubmissionLedger(value.artifactsDir)).toHaveLength(1);

    // The item is re-opened and re-accepted from a DIFFERENT landing: a
    // different relaxed acceptance, so it earns its own record.
    await writeFile(join(value.root, "src", "a.ts"), "export const value = 3;\n");
    git(value.root, ["add", "src/a.ts"]);
    git(value.root, ["commit", "-m", "fix a again"]);
    const second = git(value.root, ["rev-parse", "HEAD"]);
    await writeResult(value, resultFor(value, second));
    const reaccepted = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(reaccepted).not.toBe("unsupported_retired_state");
    if (reaccepted === "unsupported_retired_state") return;
    expect(reaccepted.accepted_count).toBe(1);
    const events = await readSubmissionLedger(value.artifactsDir);
    expect(events).toHaveLength(2);
    expect(events[0]!.message).toContain(first);
    expect(events[1]!.message).toContain(second);
  });

  it("keeps dependency eligibility enforced under recovery", async () => {
    const value = await fixture({ gateBlock: true });
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));

    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: reopenGate(value),
      recovery: await recoveryOptions(value, reopenGate(value)),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.state.items.F1!.status).toBe("pending");
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "submission_contract_invalid",
    ]);
    expect(refused.issues[0]!.message).toContain(
      "no longer dependency/phase eligible",
    );
    expect(await readSubmissionLedger(value.artifactsDir)).toEqual([]);
  });

  // ── CORROBORATION FAILS CLOSED — both branches, so the skip cannot widen ──

  it("skips corroboration ONLY with neither a trusted binding nor a git repo", async () => {
    // The documented, bounded skip: nothing to corroborate against, and no
    // trusted record claiming there was. This is the ONE branch that proceeds
    // on the declared evidence, and it is pinned so it can never grow.
    const root = await mkdtemp(join(tmpdir(), "remediation-no-git-"));
    cleanupRoots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const value = 1;\n");
    const artifactsDir = join(root, ".audit-tools", "remediation");
    const runId = "no-git-corroboration";
    const state = {
      contract_version: "remediate-code-state/v1alpha1",
      status: "implementing",
      plan: {
        plan_id: runId,
        findings: [
          {
            id: "F1",
            title: "Correct the exported value",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Change the exported value.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["src/a.ts:1 returns the stale value"],
          },
        ],
        blocks: [
          {
            block_id: "B1",
            items: ["F1"],
            parallel_safe: true,
            dependencies: [],
            targeted_commands: ['node -e "process.exit(0)"'],
            touched_files: ["src/a.ts"],
            phase_ordinal: 0,
            token_estimate: 1_200,
          },
        ],
        project_type: "typescript",
        candidate_closing_actions: ["none"],
      },
      items: { F1: { finding_id: "F1", block_id: "B1", status: "pending" } },
    } as unknown as CurrentRemediationHostState;
    const prepared = await prepareRemediationHostHandoff({
      root,
      artifactsDir,
      runId,
      baselineCommit: "1".repeat(40),
      state,
    });
    if (prepared === "unsupported_retired_state") throw new Error("state rejected");
    const item = prepared.workload.work_items[0]!;
    const resultPath = resolve(root, item.result_path);
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(
      resultPath,
      JSON.stringify({
        contract_version: "remediation-host-result/v1alpha1",
        result_id: "result-B1",
        run_id: runId,
        work_item_id: item.id,
        prompt_sha256: item.prompt.sha256,
        changed_files: ["src/a.ts"],
        commit_evidence: { before: item.baseline_commit, after: "2".repeat(40) },
        test_evidence: item.required_tests.map((command) => ({
          command,
          status: "passed",
        })),
        worktree_evidence: {
          baseline_commit: item.baseline_commit,
          changed_files: ["src/a.ts"],
        },
        acceptance: { status: "accepted" },
        merge: { status: "merged" },
      }),
      "utf8",
    );

    const ingested = await ingestRemediationHostResults({
      root,
      artifactsDir,
      runId,
      state,
    });
    if (ingested === "unsupported_retired_state") throw new Error("state rejected");
    expect(ingested.accepted_count).toBe(1);
    expect(ingested.issues).toEqual([]);
  });

  it("refuses a git-backed workload with no trusted binding rather than accepting the claim", async () => {
    const value = await fixture();
    const after = await landA(value);
    await writeResult(value, resultFor(value, after));

    // Same fixture, same byte-correct submission — but the state carries no
    // host_handoff record. `isGitRepo(root)` is true, so the skip must NOT
    // apply and the ingest must refuse outright.
    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: value.state,
    });
    if (refused === "unsupported_retired_state") throw new Error("state rejected");
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "trusted_binding_missing",
    ]);
    expect(refused.state.items.F1!.status).toBe("pending");
  });

  it("keeps corroborating when a binding is present — 'unavailable' never means 'corroborated'", async () => {
    const value = await fixture();
    const after = await landA(value);
    // A real landing, then the object database is made unreadable to git by
    // claiming a commit that cannot resolve. Corroboration must still refuse
    // rather than fall through to the host's word.
    await writeResult(value, resultFor(value, "3".repeat(40)));
    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    if (refused === "unsupported_retired_state") throw new Error("state rejected");
    expect(refused.accepted_count).toBe(0);
    // An UNRESOLVABLE commit is classified as commit_missing — the same code an
    // absent git binary produces, which is exactly why the failure mode warns a
    // caller to read a run-wide commit_missing as an environment signal.
    expect(refused.issues.map((issue) => issue.code)).toEqual(["commit_missing"]);
    expect(refused.state.items.F1!.status).toBe("pending");
    // The genuinely landed commit is still there; nothing about it was accepted.
    expect(isAncestor(value.root, after, "HEAD")).toBe(true);
  });

  // ── A HUNG REQUIRED TEST IS ITS OWN OUTCOME, NOT AN UNLABELLED RED ────────

  it("classifies a required test that exceeds its deadline, with its output captured", () => {
    // Deliberately NOT a fixture root: a timed-out child holds its cwd open
    // until Windows releases the handle, which makes deleting a temp root a
    // race (EBUSY). The runner's classification has nothing to do with the
    // repository, so it is exercised against a directory nothing cleans up.
    const cwd = tmpdir();
    // The deadline is a parameter for exactly this reason: an outcome only
    // reachable by waiting ten real minutes is an outcome nothing ever tests.
    const hanging = `node -e "console.log('starting'); setTimeout(function () {}, 60000)"`;
    const timedOut = runRequiredTest(cwd, hanging, 1_500);
    expect(timedOut).not.toBeNull();
    expect(timedOut!.outcome).toBe("timed_out");
    expect(timedOut!.command).toBe(hanging);
    // Captured, not discarded: the old path ran with stdio "ignore" and
    // returned a joined string, so an operator had nothing to read.
    expect(timedOut!.stdout).toContain("starting");

    const failed = runRequiredTest(
      cwd,
      `node -e "console.error('boom'); process.exit(3)"`,
    );
    expect(failed).not.toBeNull();
    expect(failed!.outcome).toBe("failed");
    expect(failed!.exit_code).toBe(3);
    expect(failed!.stderr).toContain("boom");

    expect(runRequiredTest(cwd, `node -e "process.exit(0)"`)).toBeNull();
  });

  it("reports a hung required test under its own issue code, distinguishable without parsing prose", async () => {
    const value = await fixture();
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));
    const command = value.item.required_tests[0]!;

    // The recovery lane READS a pre-computed verdict table, so a timeout verdict
    // can be delivered without a ten-minute wait — the same record
    // `runRequiredTest` would have produced.
    const verdicts = new Map<string, RequiredTestFailure | null>([
      [
        `${String(value.root.length)}:${value.root}:${command}`,
        {
          command,
          outcome: "timed_out",
          exit_code: null,
          stdout: "partial suite output",
          stderr: "",
        },
      ],
    ]);
    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: { requiredTestVerdicts: verdicts },
    });
    if (refused === "unsupported_retired_state") throw new Error("state rejected");
    expect(refused.accepted_count).toBe(0);
    // The OUTCOME FIELD alone tells a hang from a genuine red.
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "required_test_timed_out",
    ]);
    expect(refused.issues[0]!.message).toContain("timed out");
    expect(refused.issues[0]!.message).toContain("partial suite output");
  });

  it("reports a genuine red under required_test_failed, not the timeout code", async () => {
    const value = await fixture({ requiredTest: 'node -e "process.exit(1)"' });
    const after = await landA(value);
    await writeResult(value, resultFor(value, after));

    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    if (refused === "unsupported_retired_state") throw new Error("state rejected");
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "required_test_failed",
    ]);
    expect(refused.issues[0]!.message).toContain("exit 1");
  });
});
