import { expect, test } from "vitest";
import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { advanceToDispatchReady } from "./helpers/completion-harness.js";
import { withTempRepo } from "./helpers/next-step-harness.js";
import { persistAnalyzerSettings } from "../../src/shared/analyzerPolicy.js";
import { presentQuestionReport, readAcceptedAnswers, readQuestionFindings, readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { packageVersion } from "./helpers/wrapper-harness.js";

test("the CLI persists a submitted answer and a fresh CLI invocation promotes it", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    // This smoke checks CLI persistence, not analyzer installation or output.
    await persistAnalyzerSettings(root, { typescript: "skip" });
    const workload = await readQuestionWorkload(await advanceToDispatchReady(root));
    const answers = await submitQuestions(root, workload.work_items);
    const submitted = answers[0]!;
    const source = resolve(root, workload.work_items[0]!.result_path);
    const run = (...args: string[]) => runWrapper(["--expect-version=" + packageVersion, ...args], { cwd: root });

    const receipt = JSON.parse((await run("submit", "--work-item", submitted.assignment_id, "--from", source)).stdout);
    expect(receipt).toMatchObject({ disposition: "accepted", submission_id: submitted.submission_id, run_id: workload.run_id });
    expect(await readAcceptedAnswers(artifactsDir, workload.run_id)).toEqual([submitted]);

    await unlink(source);

    // A new CLI process now consumes the remaining saved answers and promotes
    // the report. The submitted answer can only come from the durable ledger.
    const reportPath = join(root, ".audit-tools", "audit-findings.json");
    await expect(readQuestionFindings(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    const terminal = await presentQuestionReport(root, undefined,
      async () => JSON.parse((await run("next-step")).stdout));
    expect(terminal.status).toBe("complete");
    const report = await readQuestionFindings(reportPath);
    expect(report.question_review.accepted.map(({ submission }) => submission))
      .toEqual(expect.arrayContaining(answers));
    expect(report.question_review.accepted).toHaveLength(answers.length);
  });
});
