import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  ingestRemediationHostResults,
  precomputeRecoveryTestVerdicts,
  prepareRemediationHostHandoff,
  remediationSubmissionBinding,
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
 *
 * A SCRIPT rather than a `node -e` one-liner because the consumed-shape scan
 * refuses `'` and `\` in every position — their meaning differs between sh and
 * cmd.exe — which leaves no way to write a string literal inline.
 */
const COUNTER_SCRIPT = "append-counter.mjs";
const COUNTER_TEST = `node ${COUNTER_SCRIPT}`;
const COUNTER_SCRIPT_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  'appendFileSync(new URL("./.counter", import.meta.url), "x");',
  "",
].join("\n");

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
  it("binds complete finding, clarification, and retry instructions into the prompt", async () => {
    const value = await fixture();
    expect(value.item.prompt.text).toContain("Correct the returned value");
    expect(value.item.prompt.text).toContain(
      "Change the exported value from one to two.",
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

  it("accepts a real commit beneath a prompt-bound directory write scope", async () => {
    const value = await fixture({ allowedFiles: ["src/"] });
    expect(value.item.allowed_files).toEqual(["src/"]);
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
    expect(ingested.state.applied_edit_surface).toEqual(["src/a.ts"]);
  });

  it("keeps directory write scopes component-aware and result paths normalized", async () => {
    const directory = await fixture({ allowedFiles: ["src/"] });
    const directoryBinding = await remediationSubmissionBinding({
      root: directory.root,
      artifactsDir: directory.artifactsDir,
      runId: directory.runId,
      workItemId: directory.item.id,
    });
    expect(directoryBinding).not.toBeNull();
    for (const candidate of [
      "src2/a.ts",
      "src/../src/a.ts",
      "src\\a.ts",
    ]) {
      expect(
        directoryBinding!.validate(
          resultFor(directory, "f".repeat(40), [candidate]),
        ),
      ).toMatchObject({ code: "submission_contract_invalid" });
    }

    const exact = await fixture({ allowedFiles: ["src"] });
    const exactBinding = await remediationSubmissionBinding({
      root: exact.root,
      artifactsDir: exact.artifactsDir,
      runId: exact.runId,
      workItemId: exact.item.id,
    });
    expect(exactBinding).not.toBeNull();
    expect(
      exactBinding!.validate(
        resultFor(exact, "f".repeat(40), ["src/a.ts"]),
      ),
    ).toMatchObject({ code: "submission_contract_invalid" });
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

  it("refuses a resolved_no_change whose write scope the tree shows as CHANGED", async () => {
    // A no-change decision used to be accepted on its evidence STRINGS alone,
    // with only the required tests re-run. So a host that edited inside its own
    // write scope and then declared "nothing to do" was recorded as
    // verified-no-change and the edit rode in unattributed. The claim is
    // mechanically falsifiable against the tree, so it must be FALSIFIED.
    const contradicted = await fixture({ allowedFiles: ["src/"] });
    // The host really did land a change to its own allowed file, then claimed
    // it had changed nothing.
    await landA(contradicted);
    await writeResult(
      contradicted,
      decisionFor(contradicted, {
        status: "resolved_no_change",
        evidence: ["Claimed the existing code already satisfied the contract."],
      }),
    );
    const refused = await ingestRemediationHostResults({
      root: contradicted.root,
      artifactsDir: contradicted.artifactsDir,
      runId: contradicted.runId,
      state: boundState(contradicted),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues.map((issue) => issue.code)).toContain(
      "changed_files_mismatch",
    );
    expect(refused.issues.map((issue) => issue.message).join("\n")).not.toContain(
      "outside prompt-bound allowed_files",
    );
    // The item stays PENDING: an unaccepted claim must not settle the finding.
    expect(refused.state.items.F1!.status).toBe("pending");
  });

  it("refuses a resolved_no_change contradicted by an UNCOMMITTED edit", async () => {
    // The second half of the enumeration. A host that edits and commits is
    // caught by baseline→HEAD; a host that edits and leaves the change in the
    // working tree is caught by HEAD→worktree. Without the second probe the
    // cheapest way to smuggle an edit past the claim is simply not to commit it.
    const uncommitted = await fixture();
    await writeFile(
      join(uncommitted.root, "src", "a.ts"),
      "export const value = 2;\n",
    );
    await writeResult(
      uncommitted,
      decisionFor(uncommitted, {
        status: "resolved_no_change",
        evidence: ["Claimed the existing code already satisfied the contract."],
      }),
    );
    const refused = await ingestRemediationHostResults({
      root: uncommitted.root,
      artifactsDir: uncommitted.artifactsDir,
      runId: uncommitted.runId,
      state: boundState(uncommitted),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues.map((issue) => issue.code)).toContain(
      "changed_files_mismatch",
    );
    expect(refused.state.items.F1!.status).toBe("pending");
  });

  it("refuses a resolved_no_change contradicted by a NEW UNTRACKED file", async () => {
    // The third way a host can have edited, and the one the tracked-only probe
    // could not see: CREATING a file. A new `src/new.ts` is a real edit — and
    // the most natural shape a remediation takes — so a claim of "nothing to
    // do" beside one is false. Without the `ls-files --others` leg the cheapest
    // way to smuggle an edit past the claim was simply never to `git add` it.
    //
    // The old justification for omitting untracked files was that the tool's
    // own `.audit-tools` documents would refuse every claim ever made. They do
    // not: the tool writes a managed `.gitignore` block covering that tree, so
    // `--exclude-standard` never reports it, and the probe subtracts the
    // directory explicitly besides. Pre-existing strays are excused by
    // `run_start_dirty`, which is captured from `stagedAndUntracked` and so
    // already enumerates untracked files. What is left is exactly this: a file
    // that appeared DURING the run.
    const created = await fixture();
    await writeFile(
      join(created.root, "src", "new.ts"),
      "export const added = 1;\n",
    );
    await writeResult(
      created,
      decisionFor(created, {
        status: "resolved_no_change",
        evidence: ["Claimed the existing code already satisfied the contract."],
      }),
    );
    const refused = await ingestRemediationHostResults({
      root: created.root,
      artifactsDir: created.artifactsDir,
      runId: created.runId,
      state: boundState(created),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues.map((issue) => issue.code)).toContain(
      "changed_files_mismatch",
    );
    // The created file is NAMED, and named as out-of-scope: `src/new.ts` is in
    // nobody's `allowed_files`.
    expect(refused.issues.map((issue) => issue.message).join("\n")).toContain(
      "src/new.ts",
    );
    expect(refused.state.items.F1!.status).toBe("pending");
  });

  it("accepts a resolved_no_change whose only untracked files are the tool's own artifacts", async () => {
    // The other half, and the one that keeps the leg from becoming a check that
    // always fires: an honest no-change claim in a repo where the ONLY
    // untracked paths are this tool's own workload/prompt/result documents
    // under `.audit-tools/` must still be accepted. The fixture root carries no
    // `.gitignore` at all, so this pins the explicit subtraction rather than
    // git's ignore rules doing the work.
    const honest = await fixture();
    expect(
      git(honest.root, ["ls-files", "--others", "--exclude-standard"]),
    ).toContain(".audit-tools/");
    await writeResult(
      honest,
      decisionFor(honest, {
        status: "resolved_no_change",
        evidence: ["The existing code already satisfies the contract."],
      }),
    );
    const accepted = await ingestRemediationHostResults({
      root: honest.root,
      artifactsDir: honest.artifactsDir,
      runId: honest.runId,
      state: boundState(honest),
    });
    expect(accepted).not.toBe("unsupported_retired_state");
    if (accepted === "unsupported_retired_state") return;
    expect(accepted.issues).toEqual([]);
    expect(accepted.accepted_count).toBe(1);
  });

  it("refuses a resolved_no_change whose tree shows changes OUTSIDE allowed_files", async () => {
    // The out-of-scope half, and the one a narrowed check inverts. For a LANDED
    // result `corroborateHostResult` refuses a commit that touched anything
    // outside the prompt-bound `allowed_files` — that is the more serious
    // violation, not the lesser one. A no-change corroboration that only asked
    // about files INSIDE `allowed_files` would therefore be the exact INVERSE
    // of the rule it claims to share: the in-scope edit refused, the
    // out-of-scope edit waved through. Both halves refuse.
    const outOfScope = await fixture();
    // `src/b.ts` is nobody's write scope in this workload — the item is bound
    // to `src/a.ts` alone.
    expect(outOfScope.item.allowed_files).toEqual(["src/a.ts"]);
    const landed = await landB(outOfScope);
    expect(landed).toBeTruthy();
    await writeResult(
      outOfScope,
      decisionFor(outOfScope, {
        status: "resolved_no_change",
        evidence: ["Claimed the existing code already satisfied the contract."],
      }),
    );
    const refused = await ingestRemediationHostResults({
      root: outOfScope.root,
      artifactsDir: outOfScope.artifactsDir,
      runId: outOfScope.runId,
      state: boundState(outOfScope),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues.map((issue) => issue.code)).toContain(
      "changed_files_mismatch",
    );
    // Named in the refusal as out-of-scope, so the operator is not left to
    // guess which half of the rule fired.
    expect(
      refused.issues.map((issue) => issue.message).join("\n"),
    ).toContain("src/b.ts");
    expect(refused.state.items.F1!.status).toBe("pending");
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

  it("refuses attestation-only acceptance when neither a trusted binding nor a git repo exists", async () => {
    // The documented, bounded refusal: nothing to corroborate against, and no
    // trusted record claiming there was. This branch MUST refuse and is pinned
    // so it can never widen into accepting attestation-only evidence.
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
    // Must be refused: no git repo and no host_handoff binding means no corroboration possible
    expect(ingested.accepted_count).toBe(0);
    expect(ingested.issues.map((i) => i.code)).toContain("trusted_binding_missing");
    expect(ingested.state.items.F1!.status).toBe("pending");
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

  /**
   * An isolated cwd for the runner tests, deliberately NOT registered for
   * cleanup: a timed-out or buffer-killed child holds its cwd open until Windows
   * releases the handle, so deleting the directory is a race (EBUSY). Isolated
   * per test rather than the shared `tmpdir()` so two runner tests cannot
   * interact through a directory every process on the box also uses.
   */
  async function runnerCwd(): Promise<string> {
    return mkdtemp(join(tmpdir(), "remediation-required-test-"));
  }

  it("classifies a required test that exceeds its deadline, with its output captured", async () => {
    const cwd = await runnerCwd();
    // The deadline is a parameter for exactly this reason: an outcome only
    // reachable by waiting ten real minutes is an outcome nothing ever tests.
    // The margin is generous on purpose — the assertion below needs the child to
    // have STARTED and printed, and a node cold start on a loaded Windows box is
    // not a fixed cost. The child hangs for a minute, so the deadline is the only
    // thing that ends it and the test still finishes in seconds.
    const hanging = `node -e "console.log('starting'); setTimeout(function () {}, 60000)"`;
    const timedOut = await runRequiredTest(cwd, hanging, 5_000);
    expect(timedOut).not.toBeNull();
    expect(timedOut!.outcome).toBe("timed_out");
    expect(timedOut!.command).toBe(hanging);
    // Captured, not discarded: the old path ran with stdio "ignore" and
    // returned a joined string, so an operator had nothing to read.
    expect(timedOut!.stdout).toContain("starting");

    const failed = await runRequiredTest(
      cwd,
      `node -e "console.error('boom'); process.exit(3)"`,
    );
    expect(failed).not.toBeNull();
    expect(failed!.outcome).toBe("failed");
    expect(failed!.exit_code).toBe(3);
    expect(failed!.stderr).toContain("boom");

    expect(await runRequiredTest(cwd, `node -e "process.exit(0)"`)).toBeNull();
  });

  it("classifies a command that outran the capture buffer as overflow, never as a hang", async () => {
    const cwd = await runnerCwd();
    // A child that INTENDS a clean exit after printing more than the 8MiB capture
    // buffer holds — the kill lands first. node terminates it with SIGTERM and
    // reports ENOBUFS, and a discriminator that read `signal !== null` as "the
    // deadline fired" called that a timeout, i.e. an environment hang, for a
    // command whose only sin was being verbose.
    //
    // NO `process.exit(0)`, deliberately: on linux a pipe write is ASYNCHRONOUS
    // and `process.exit` truncates whatever is still pending, so the child emitted
    // far less than the cap and exited 0 for real — green was the correct reading
    // of what it actually did, and the fixture never overflowed there at all. Left
    // to exit naturally, node stays alive until the stream drains, so all 9MiB
    // must cross the pipe and the cap is hit on every platform. (win32 never
    // showed this: its pipe writes are synchronous, so the full 9MiB landed either
    // way.)
    const overflowing =
      `node -e "process.stdout.write('x'.repeat(9 * 1024 * 1024))"`;
    const overflowed = await runRequiredTest(cwd, overflowing);
    expect(overflowed).not.toBeNull();
    expect(overflowed!.outcome).toBe("output_overflow");
    expect(overflowed!.exit_code).toBeNull();
    expect(overflowed!.command).toBe(overflowing);
  });

  // ── OBL-impl-block-1296-inv-2: A REQUIRED TEST MUST NOT STARVE LIVENESS ───

  it("lets timers fire while a required test runs, so a held lock's heartbeat survives it", async () => {
    // Ingestion runs with the remediation state lock HELD, and every liveness
    // heartbeat in the process — the advance heartbeat, each held lock's mtime
    // heartbeat — is a timer on this event loop. A synchronous child blocks
    // that loop for the whole suite, so a LIVE lock stops being refreshed,
    // reads as stale, and is stolen mid-ingest. Awaiting is what prevents it.
    //
    // Cheapest honest pin: count timer ticks across a ~1s child. Revert
    // `runRequiredTest` to `spawnSync` and the count is 0.
    const cwd = await runnerCwd();
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 50);
    let failure: RequiredTestFailure | null;
    try {
      failure = await runRequiredTest(
        cwd,
        `node -e "setTimeout(function () {}, 1000)"`,
      );
    } finally {
      clearInterval(heartbeat);
    }
    // The child really ran and really passed, so the tick count is about a real
    // ~1s spawn rather than an early refusal.
    expect(failure).toBeNull();
    expect(ticks).toBeGreaterThan(0);
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

  it("reports a buffer-killed required test under its own code, calling the verdict unknown", async () => {
    const value = await fixture();
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));
    const command = value.item.required_tests[0]!;

    const verdicts = new Map<string, RequiredTestFailure | null>([
      [
        `${String(value.root.length)}:${value.root}:${command}`,
        {
          command,
          outcome: "output_overflow",
          exit_code: null,
          stdout: "the last of a very long log",
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
    // Its OWN code — under required_test_failed the operator would read a
    // capture-cap kill as the work being wrong. And the message claims UNKNOWN,
    // not innocence: a child killed mid-stream may equally have been heading for
    // a non-zero exit, so the honest report is that the run never found out.
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "required_test_output_overflow",
    ]);
    expect(refused.issues[0]!.message).toMatch(/UNKNOWN/u);
    expect(refused.issues[0]!.message).toContain("the last of a very long log");
  });
});
