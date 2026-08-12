// Split from the former single audit-code-completion.test.ts (wall-clock brief
// T4: no single test file may dominate a CI shard). Test bodies are a verbatim
// move; the shared fixture lives in helpers/completion-harness.ts.
import { test, expect } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import {
  withTempRepo,
  advanceToDispatchReady,
  buildSyntheticResults,
  callNextStep,
  callIngestResults,
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
    const ingested = await callIngestResults([
      "--root",
      root,
      "--artifacts-dir",
      artifactsDir,
      "--batch-results",
      batchDir,
    ]);
    expect(ingested.imported_files.length).toBe(2);

    // Finalize as the scripted conversation host: fulfill semantic artifacts
    // only when their step emits the bound path, then cover friction before the
    // completion call. This keeps the batch-ingest seam independent of retired
    // transport/session configuration.
    let presented: Awaited<ReturnType<typeof callNextStep>> | undefined;
    const trail: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const step = await callNextStep(root, artifactsDir);
      trail.push(`${step.step_kind}:${step.status}`);
      if (step.step_kind === "synthesis_narrative") {
        const resultPath = step.artifact_paths?.synthesis_narrative_results;
        if (typeof resultPath !== "string") {
          throw new Error("synthesis_narrative step did not emit a results path");
        }
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(
          resultPath,
          JSON.stringify({ themes: [], top_risks: [] }, null, 2) + "\n",
        );
        continue;
      }
      if (step.step_kind === "present_report") {
        const frictionPath = step.artifact_paths?.friction_record;
        if (step.status === "ready" && typeof frictionPath === "string") {
          let record: Record<string, unknown> = {};
          try {
            record = JSON.parse(await readFile(frictionPath, "utf8"));
          } catch { /* new record */ }
          record.category_attestations = [
            { category: "ambiguous_direction", note: "none this run" },
            { category: "tool_should_decide", note: "none this run" },
            { category: "inefficient_feeding", note: "none this run" },
          ];
          await mkdir(dirname(frictionPath), { recursive: true });
          await writeFile(frictionPath, JSON.stringify(record) + "\n");
          continue;
        }
        presented = step;
        break;
      }
    }
    expect(presented, `finalization trail: ${trail.join(" -> ")}`).toBeTruthy();
    if (!presented) throw new Error(`finalization trail: ${trail.join(" -> ")}`);
    expect(presented.status).toBe("complete");
    expect(await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8")).toMatch(/## Work Blocks/);
  });
});
