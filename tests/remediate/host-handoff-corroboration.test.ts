import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  ingestRemediationHostResults,
  prepareRemediationHostHandoff,
  type CurrentRemediationHostState,
  type PreparedRemediationHostHandoff,
  type RemediationHostWorkItem,
} from "../../src/remediate/steps/dispatch/hostHandoff.js";
import type { RemediationHostHandoffRecord } from "../../src/remediate/state/types.js";
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
}

async function fixture(options: {
  allowedFiles?: string[];
  requiredTest?: string;
  runStartDirty?: string[];
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
        {
          block_id: "B1",
          items: ["F1"],
          parallel_safe: true,
          dependencies: [],
          touched_files: allowedFiles,
          targeted_commands: [
            options.requiredTest ?? 'node -e "process.exit(0)"',
          ],
          phase_ordinal: 0,
          token_estimate: 250,
        },
      ],
      project_type: "typescript",
      candidate_closing_actions: ["none"],
    },
    items: {
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
): Record<string, unknown> {
  return {
    contract_version: "remediation-host-result/v1alpha1",
    result_id: `result-${after.slice(0, 12)}`,
    run_id: value.runId,
    work_item_id: value.item.id,
    prompt_sha256: value.item.prompt.sha256,
    changed_files: changedFiles,
    commit_evidence: { before: value.baseline, after },
    test_evidence: value.item.required_tests.map((command) => ({
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
): Promise<void> {
  const path = resolve(value.root, value.item.result_path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result), "utf8");
}

async function landA(value: Fixture): Promise<string> {
  await writeFile(join(value.root, "src", "a.ts"), "export const value = 2;\n");
  git(value.root, ["add", "src/a.ts"]);
  git(value.root, ["commit", "-m", "fix a"]);
  return git(value.root, ["rev-parse", "HEAD"]);
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
      "result_malformed",
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
});
