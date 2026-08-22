/**
 * The un-accept verb: an operator-facing path back out of an accepted entry.
 *
 * Property (docs/backlog/open-bugs.md, 2026-08-21): any state a failed gate can
 * poison has a supported path back out. Before this change, an accepted result
 * that failed downstream validation wedged the run and the only exit was a
 * hand-edit of both accepted files. `dropAcceptedResults` removes entries from
 * the pair under the same lock the writers use, records the removal so a
 * repaired run stays distinguishable from a clean one, and refreshes-or-
 * invalidates the persisted step contract (the recovery-verb property).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  dropAcceptedResults,
  ingestAuditHostResults,
  prepareAuditHostHandoff,
} from "../../src/audit/cli/dispatch.js";
import { readSubmissionLedger } from "../../src/shared/submission/submissionLedger.js";
import { currentStepPath } from "../../src/shared/io/stepContractWriter.js";
import type { AuditTask } from "../../src/audit/types.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const RUN_ID = "host-run-unaccept";

const TASK_A: AuditTask = {
  task_id: "audit-task-a",
  unit_id: "unit-audit-task-a",
  pass_id: "pass:correctness",
  lens: "correctness",
  file_paths: ["src/a.ts"],
  rationale: "Review src/a.ts",
};

function taskB(): AuditTask {
  return { ...TASK_A, task_id: "audit-task-b", file_paths: ["src/b.ts"] };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "audit-unaccept-"));
  cleanupRoots.push(root);
  const artifactsDir = join(root, ".audit-tools", "audit");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
  await writeFile(join(root, "src", "b.ts"), "one\ntwo\n", "utf8");
  const tasks = [TASK_A, taskB()].map((task) => ({
    ...task,
    priority: "medium" as const,
    complexity: "standard",
    risk: "medium",
    token_estimate: 1200,
    file_line_counts: { [task.file_paths[0]!]: 2 },
  }));
  const prepared = await prepareAuditHostHandoff({
    root,
    artifactsDir,
    runId: RUN_ID,
    tasks,
  });
  const items = prepared.workload.work_items;
  if (items.length !== 2) throw new Error("prepare did not publish both work items");
  for (const item of items) {
    // Prepare may bind an absolute or repo-relative path; resolve like the
    // sibling host-handoff fixtures do rather than assuming either.
    const resultPath = isAbsolute(item.result_path)
      ? resolve(item.result_path)
      : resolve(root, item.result_path);
    await mkdir(join(resultPath, ".."), { recursive: true });
    await writeFile(
      resultPath,
      JSON.stringify({
        contract_version: "audit-host-result/v1alpha1",
        result_id: `result-${item.id}`,
        run_id: RUN_ID,
        work_item_id: item.id,
        prompt_sha256: item.prompt.sha256,
        file_coverage: item.scope.files.map((path) => ({
          path,
          reviewed_lines: 2,
          total_lines: 2,
        })),
        // No `reviewed_clean` here: the host-result envelope is EXACTLY seven
        // keys; the conversion derives the affirmation from an empty findings.
        findings: [],
      }),
      "utf8",
    );
  }

  const ingest = () =>
    ingestAuditHostResults({
      root,
      artifactsDir,
      runId: RUN_ID,
      auditTasks: [...tasks],
      lineIndex: { "src/a.ts": 2, "src/b.ts": 2 },
    });

  const acceptedLedgerPath = () =>
    join(artifactsDir, "runs", RUN_ID, "host-accepted-results-ledger.json");
  const acceptedResultsPath = () =>
    join(artifactsDir, "runs", RUN_ID, "host-accepted-results.json");
  const readLedgerIds = async () => {
    const ledger = JSON.parse(await readFile(acceptedLedgerPath(), "utf8")) as {
      entries: { work_item_id: string }[];
    };
    return ledger.entries.map((entry) => entry.work_item_id);
  };
  const readResultIds = async () => {
    const results = JSON.parse(await readFile(acceptedResultsPath(), "utf8")) as {
      task_id: string;
    }[];
    return results.map((entry) => entry.task_id);
  };

  return {
    root,
    artifactsDir,
    ingest,
    acceptedLedgerPath,
    readLedgerIds,
    readResultIds,
    items,
    tasks,
  };
}

/** Write a minimal-but-valid current step contract so the verb can invalidate it. */
async function writeStepContractFixture(artifactsDir: string, root: string): Promise<void> {
  await mkdir(join(artifactsDir, "steps"), { recursive: true });
  await writeFile(
    currentStepPath(artifactsDir),
    JSON.stringify({
      contract_version: "audit-code-step/v1alpha1",
      step_kind: "dispatch_review",
      status: "ready",
      run_id: null,
      agent_id: "fixture",
      allowed_commands: [],
      stop_condition: "fixture",
      prompt_path: "steps/current-prompt.md",
      repo_root: root,
      artifacts_dir: artifactsDir,
      artifact_paths: {},
    }),
    "utf8",
  );
}

describe("contract:unaccept-results-drops-an-accepted-entry", () => {
  it("drops one work item by id, records the removal, and lets a re-ingest re-read the file", async () => {
    const ctx = await setup();
    const accepted = await ctx.ingest();
    expect(accepted.accepted_count).toBe(2);
    await writeStepContractFixture(ctx.artifactsDir, ctx.root);
    const stepBefore = await readFile(currentStepPath(ctx.artifactsDir), "utf8");

    const outcome = await dropAcceptedResults({
      root: ctx.root,
      artifactsDir: ctx.artifactsDir,
      runId: RUN_ID,
      workItemIds: ["audit-task-a"],
    });
    expect(outcome.dropped_work_item_ids).toEqual(["audit-task-a"]);

    // BOTH files of the pair lose the entry.
    expect(await ctx.readLedgerIds()).toEqual(["audit-task-b"]);
    expect(await ctx.readResultIds()).toEqual(["audit-task-b"]);

    // The removal is on the record: the shared submission ledger names the item
    // and the verb, so a repaired run stays distinguishable from a clean one.
    const ledgerEvents = (await readSubmissionLedger(ctx.artifactsDir)).events.filter(
      (event) => event.submission_id === "audit-task-a",
    );
    expect(ledgerEvents.length).toBeGreaterThan(0);
    expect(ledgerEvents.at(-1)?.kind).toBe("removed_by_operator");

    // The step contract was invalidated: no stale live instruction survives.
    const stepAfter = await readFile(currentStepPath(ctx.artifactsDir), "utf8");
    expect(stepAfter).not.toBe(stepBefore);
    expect(JSON.parse(stepAfter).step_kind).toBe("blocked");

    // A re-ingest re-reads the bound file and accepts the item again.
    const reIngest = await ctx.ingest();
    expect(reIngest.accepted_count).toBe(1);
    expect(reIngest.completed_work_item_ids).toContain("audit-task-a");
    expect(await ctx.readLedgerIds()).toEqual(
      ["audit-task-a", "audit-task-b"].sort(),
    );
  });

  it("--all drops every entry and a corrupt ledger is refused, not truncated", async () => {
    const ctx = await setup();
    const accepted = await ctx.ingest();
    expect(accepted.accepted_count).toBe(2);

    const all = await dropAcceptedResults({
      root: ctx.root,
      artifactsDir: ctx.artifactsDir,
      runId: RUN_ID,
      all: true,
    });
    expect([...all.dropped_work_item_ids].sort()).toEqual(["audit-task-a", "audit-task-b"]);
    expect(await ctx.readLedgerIds()).toEqual([]);

    // Refusal on a corrupt ledger: the strict loader throws NAMING the ledger
    // file, the verb propagates it (never silently truncating a pair it cannot
    // validate), and BOTH files survive untouched.
    await writeFile(ctx.acceptedLedgerPath(), "{ corrupt", "utf8");
    await expect(
      dropAcceptedResults({
        root: ctx.root,
        artifactsDir: ctx.artifactsDir,
        runId: RUN_ID,
        all: true,
      }),
    ).rejects.toThrow(/host-accepted-results-ledger\.json/u);
    const results = JSON.parse(
      await readFile(
        join(ctx.artifactsDir, "runs", RUN_ID, "host-accepted-results.json"),
        "utf8",
      ),
    ) as unknown[];
    expect(results).toEqual([]);
  });

  it("is registered as the audit-code `unaccept-results` command", async () => {
    const { runCli } = await import("../../dist/audit/cli.js");
    const { captureConsole } = await import("./helpers/captureConsole.mjs");
    const result = await captureConsole(() =>
      runCli([process.execPath, "cli.js", "this-is-not-a-command"]),
    );
    expect(result.code, "unknown command must exit 1").toBe(1);
    expect(result.stderr, "the command listing must name the new verb").toContain(
      "unaccept-results",
    );
    expect(result.stderr).toContain("recover-submission");
  });
});
