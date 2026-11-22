import { expect, test } from "vitest";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { toPromptPathToken } from "audit-tools/shared";
import { advanceToDispatchReady, withTempRepo } from "./helpers/completion-harness.js";
import { presentQuestionReport, readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";

test("next-step presents the rendered question report instead of a run-limit block", async () => {
  await withTempRepo(async (root) => {
    const dir = join(root, ".audit-tools/audit");
    const workload = await readQuestionWorkload(await advanceToDispatchReady(root));
    await submitQuestions(root, workload.work_items);
    const presented = await presentQuestionReport(root, async (step) => {
      if (step.step_kind === "blocked") {
        const rendered = await access(join(dir, "audit-report.md")).then(() => true).catch(() => false);
        expect(rendered, "a rendered report must be presented, never surfaced as a run-limit block").toBe(false);
      }
    });
    expect(presented.status).toBe("complete");
    expect(presented.artifact_paths.final_report).toBe(toPromptPathToken(join(root, ".audit-tools", "audit-report.md")));
    expect(await readFile(presented.artifact_paths.final_report, "utf8")).toMatch(/# Audit Report/i);
    await access(join(dir, "runs", workload.run_id, "host-accepted-results-ledger.json"));
    expect(await readFile(presented.prompt_path, "utf8")).toMatch(/present report/i);
  });
});
