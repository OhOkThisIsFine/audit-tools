// Split from the former single audit-code-completion.test.ts (wall-clock brief
// T4: no single test file may dominate a CI shard). Test bodies are a verbatim
// move; the shared fixture lives in helpers/completion-harness.ts.
import { test, expect } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import {
  withTempRepo,
  advanceToDispatchReady,
  buildSyntheticResults,
  disableNarrative,
  callIngestResults,
  callForceSynthesis,
  nextStepUntilPresentReport,
} from "./helpers/completion-harness.js";

test("force-synthesis strands a wedged task, stamps an operator_forced terminal, and drives synthesis from the partial ledger", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await advanceToDispatchReady(root);

    const tasks = JSON.parse(
      await readFile(join(artifactsDir, "audit_tasks.json"), "utf8"),
    );
    expect(tasks.length >= 2, "need >=2 tasks so one can stay pending").toBeTruthy();
    await disableNarrative(artifactsDir);

    // Ingest results for ALL BUT the last task → the last stays pending, wedging
    // the run on `audit_tasks_completed` (it can never reach present_report on its
    // own; that's the recovery scenario force-synthesis exists for).
    const partial = tasks.slice(0, -1);
    const pendingTask = tasks[tasks.length - 1];
    const resultsPath = join(root, "audit_results.json");
    await writeFile(
      resultsPath,
      JSON.stringify(await buildSyntheticResults(partial, root), null, 2),
    );
    await callIngestResults([
      "--root", root, "--artifacts-dir", artifactsDir, "--results", resultsPath,
    ]);

    const forced = await callForceSynthesis([
      "--root", root, "--artifacts-dir", artifactsDir,
    ]);
    expect(forced.selected_executor).toBe("synthesis_executor");
    expect(forced.forced_stranded_task_ids, "the pending task is stranded").toContain(
      pendingTask.task_id,
    );
    expect(forced.newly_stranded_count >= 1).toBeTruthy();

    // The terminal is stamped DURABLY on active-dispatch.json (a special-loaded
    // artifact) — this run had none (host-subagent path never wrote one), so the
    // absent-active_dispatch branch minted a minimal state carrying the terminal.
    const active = JSON.parse(
      await readFile(join(artifactsDir, "active-dispatch.json"), "utf8"),
    );
    expect(active.partial_completion_terminal.reason).toBe("operator_forced");
    expect(active.partial_completion_terminal.stranded_ids).toContain(pendingTask.task_id);

    // The run is now unblocked: next-step reaches present_report on partial
    // coverage and promotes the report rendered from the intact ledger.
    const presented = await nextStepUntilPresentReport(root);
    expect(presented.status).toBe("complete");
    expect(
      await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8"),
    ).toMatch(/# Audit Report/);
  });
});
