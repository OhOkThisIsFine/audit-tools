import { expect, test } from "vitest";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { advanceToDispatchReady, withTempRepo } from "./helpers/completion-harness.js";
import { presentQuestionReport, readQuestionFindings, readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";

test("accepted question answers replace the previous promoted report bundle without deleting working state", async () => {
  await withTempRepo(async (root) => {
    const dir = join(root, ".audit-tools/audit");
    const step = await advanceToDispatchReady(root);
    expect(step.contract_version).toBe("audit-code-step/v1alpha1");
    expect(step.status).toBe("ready");
    const workload = await readQuestionWorkload(step);
    const reportPath = join(root, ".audit-tools", "audit-report.md");
    const findingsPath = join(root, ".audit-tools", "audit-findings.json");
    await writeFile(reportPath, "# Prior audit marker\n");
    await writeFile(findingsPath, JSON.stringify({ old: true }));
    const answers = await submitQuestions(root, workload.work_items);

    const presented = await presentQuestionReport(root);
    expect(presented.status).toBe("complete");
    const rendered = await readFile(reportPath, "utf8");
    expect(rendered).not.toContain("Prior audit marker");
    expect(rendered).toMatch(/# Audit Report/i);
    const report = await readQuestionFindings(findingsPath);
    expect(report.question_review.accepted.map(row => row.submission)).toEqual(expect.arrayContaining(answers));
    expect(report.question_review.accepted).toHaveLength(answers.length);
    await access(join(dir, "runs", workload.run_id, "host-accepted-results-ledger.json"));
    expect(await readFile(presented.prompt_path, "utf8")).toMatch(/present report/i);
  });
});
