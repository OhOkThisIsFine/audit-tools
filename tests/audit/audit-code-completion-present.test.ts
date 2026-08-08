// Split from the former single audit-code-completion.test.ts (wall-clock brief
// T4: no single test file may dominate a CI shard). Test bodies are a verbatim
// move; the shared fixture lives in helpers/completion-harness.ts.
import { test, expect } from "vitest";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import {
  withTempRepo,
  advanceToDispatchReady,
  buildSyntheticResults,
  disableNarrative,
  callIngestResults,
  callNextStep,
} from "./helpers/completion-harness.js";

const { toPromptPathToken } = await import("audit-tools/shared");

test("next-step presents the rendered report instead of a run-limit block", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await advanceToDispatchReady(root);

    const tasks = JSON.parse(
      await readFile(join(artifactsDir, "audit_tasks.json"), "utf8"),
    );
    await disableNarrative(artifactsDir);
    const resultsPath = join(root, "audit_results.json");
    await writeFile(
      resultsPath,
      JSON.stringify(await buildSyntheticResults(tasks, root), null, 2),
    );
    // Ingest the results without finishing finalization, leaving the audit a
    // few deterministic runs short of complete with artifacts intact.
    await callIngestResults([
      "--root",
      root,
      "--artifacts-dir",
      artifactsDir,
      "--results",
      resultsPath,
    ]);

    const reportPath = join(artifactsDir, "audit-report.md");
    const reportExists = async () =>
      access(reportPath).then(() => true).catch(() => false);

    // Drive next-step repeatedly while finalization is still in flight. The
    // invariant: once the report is rendered, the terminal must present it
    // (present_report) — it must never surface a completed audit as `blocked`,
    // whether the fold reaches completion in one call or stops at the cycle
    // terminal. (The fold now runs to completion per call via the shared
    // `advance` engine; the loop tolerates either a direct present_report or an
    // interim blocked step with no report yet.)
    let presented = null;
    for (let i = 0; i < 15 && !presented; i++) {
      const step = await callNextStep(root, artifactsDir);
      if (step.step_kind === "present_report") {
        // Friction triage pending: seed an observation and loop so next call
        // returns status:"complete".
        if (step.status === "ready" && step.artifact_paths?.friction_record) {
          let record: {
            category_attestations?: Array<{ category: string; note?: string }>;
          } = {};
          try { record = JSON.parse(await readFile(step.artifact_paths.friction_record, "utf8")); } catch { /* new */ }
          record.category_attestations = [{ category: "ambiguous_direction" }, { category: "tool_should_decide" }, { category: "inefficient_feeding" }];
          await mkdir(dirname(step.artifact_paths.friction_record), { recursive: true });
          await writeFile(step.artifact_paths.friction_record, JSON.stringify(record) + "\n");
          continue;
        }
        presented = step;
        break;
      }
      expect(step.step_kind, `expected only blocked/present_report while finalizing, got ${step.step_kind}`).toBe("blocked");
      expect(await reportExists(), "a rendered report must be presented, never surfaced as a run-limit block").toBe(false);
    }

    expect(presented, "next-step must reach present_report").toBeTruthy();
    expect(presented.status).toBe("complete");
    // Completion promotes the canonical report to .audit-tools/ (parent of the
    // artifacts dir). The step contract normalizes the path to forward slashes.
    expect(presented.artifact_paths.final_report).toBe(toPromptPathToken(join(root, ".audit-tools", "audit-report.md")));
    expect(await readFile(presented.artifact_paths.final_report, "utf8")).toMatch(/# Audit Report/);
    // The audit working state is cleaned out (promotion removes the artifact
    // bundle), but next-step still leaves the present_report step scaffolding so
    // the host can read and follow `prompt_path`. Assert the working artifacts
    // are gone while the prompt the host must follow remains readable.
    expect(await access(join(artifactsDir, "audit_tasks.json"))
        .then(() => true)
        .catch(() => false), "audit working artifacts must be cleaned on completion").toBe(false);
    expect(await readFile(presented.prompt_path, "utf8")).toMatch(/present report/i);
  });
});
