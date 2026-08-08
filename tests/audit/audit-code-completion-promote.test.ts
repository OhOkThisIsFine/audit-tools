// Split from the former single audit-code-completion.test.ts (wall-clock brief
// T4: no single test file may dominate a CI shard). Test bodies are a verbatim
// move; the shared fixture lives in helpers/completion-harness.ts.
import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import {
  withTempRepo,
  advanceToDispatchReady,
  buildSyntheticResults,
  disableNarrative,
  callIngestResults,
  nextStepUntilPresentReport,
} from "./helpers/completion-harness.js";

test("next-step reaches dispatch_review, ingest-results consumes synthetic results, and completion promotes the report bundle", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    const step = await advanceToDispatchReady(root);
    expect(step.contract_version).toBe("audit-code-step/v1alpha1");
    expect(step.status).toBe("ready");

    const tasks = JSON.parse(
      await readFile(join(artifactsDir, "audit_tasks.json"), "utf8"),
    );
    expect(tasks.length > 0).toBeTruthy();
    const resultsPath = join(root, "audit_results.json");
    await writeFile(
      resultsPath,
      JSON.stringify(await buildSyntheticResults(tasks, root), null, 2),
    );
    await disableNarrative(artifactsDir);

    const ingested = await callIngestResults([
      "--root",
      root,
      "--artifacts-dir",
      artifactsDir,
      "--results",
      resultsPath,
    ]);
    expect(ingested.selected_executor).toBe("result_ingestion_executor");

    const presented = await nextStepUntilPresentReport(root);
    expect(presented.status).toBe("complete");

    // Completion promotes the machine contract and the human render to the
    // artifacts dir's parent (.audit-tools/).
    const auditReport = await readFile(
      join(root, ".audit-tools", "audit-report.md"),
      "utf8",
    );
    expect(auditReport).toMatch(/# Audit Report/);
    await access(join(root, ".audit-tools", "audit-findings.json"));

    // The audit working state is cleaned out (promotion removes the artifact
    // bundle); only the present_report step scaffolding remains so the host
    // can read and follow `prompt_path`.
    await assert.rejects(
      () => access(join(artifactsDir, "audit_tasks.json")),
      /ENOENT/i,
    );
    expect(await readFile(presented.prompt_path, "utf8")).toMatch(/present report/i);
  });
});
