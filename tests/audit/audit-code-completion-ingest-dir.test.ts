// Split from the former single audit-code-completion.test.ts (wall-clock brief
// T4: no single test file may dominate a CI shard). Test bodies are a verbatim
// move; the shared fixture lives in helpers/completion-harness.ts.
import { test, expect } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
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

test("ingest-results accepts a directory of batch result files and next-step still collapses to audit-report.md", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await advanceToDispatchReady(root);

    const tasks = JSON.parse(
      await readFile(join(artifactsDir, "audit_tasks.json"), "utf8"),
    );
    const allResults = await buildSyntheticResults(tasks, root);
    const batchDir = join(root, "audit-results-batch");
    await mkdir(batchDir, { recursive: true });
    // Batch files must use the canonical "<stem>_<12-hex>.json" result naming
    // so they are admitted by the canonical-filename filter (stray sidecars are
    // ignored). The 12-hex digest stands in for a real artifact digest.
    await writeFile(
      join(batchDir, "result-01_0123456789ab.json"),
      JSON.stringify(allResults.slice(0, Math.ceil(allResults.length / 2)), null, 2),
    );
    await writeFile(
      join(batchDir, "result-02_cdef01234567.json"),
      JSON.stringify(allResults.slice(Math.ceil(allResults.length / 2)), null, 2),
    );
    await disableNarrative(artifactsDir);

    const ingested = await callIngestResults([
      "--root",
      root,
      "--artifacts-dir",
      artifactsDir,
      "--batch-results",
      batchDir,
    ]);
    expect(ingested.imported_files.length).toBe(2);

    const presented = await nextStepUntilPresentReport(root);
    expect(presented.status).toBe("complete");
    expect(await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8")).toMatch(/## Work Blocks/);
  });
});
