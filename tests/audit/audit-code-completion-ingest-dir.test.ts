import { expect, test } from "vitest";
import { join } from "node:path";
import { advanceToDispatchReady, callNextStep, withTempRepo } from "./helpers/completion-harness.js";
import { presentQuestionReport, readAcceptedAnswers, readQuestionFindings, readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";

test("next-step ingests bound question answers in two waves without dropping previously accepted answers", async () => {
  await withTempRepo(async (root) => {
    const dir = join(root, ".audit-tools/audit");
    const first = await readQuestionWorkload(await advanceToDispatchReady(root));
    const count = Math.ceil(first.work_items.length / 2);
    const firstAnswers = await submitQuestions(root, first.work_items.slice(0, count));
    const resumed = await readQuestionWorkload(await callNextStep(root, dir));
    expect(resumed.run_id).toBe(first.run_id);
    expect(resumed.work_items.map(item => item.binding.assignment.assignment_id).sort())
      .toEqual(first.work_items.slice(count).map(item => item.binding.assignment.assignment_id).sort());
    expect(await readAcceptedAnswers(dir, first.run_id)).toEqual(expect.arrayContaining(firstAnswers));
    expect(await readAcceptedAnswers(dir, first.run_id)).toHaveLength(firstAnswers.length);

    const secondAnswers = await submitQuestions(root, resumed.work_items);
    await presentQuestionReport(root);
    const report = await readQuestionFindings(join(root, ".audit-tools", "audit-findings.json"));
    const answers = [...firstAnswers, ...secondAnswers];
    const accepted = report.question_review.accepted.map(row => row.submission);
    expect(accepted).toHaveLength(answers.length);
    expect(accepted).toEqual(expect.arrayContaining(answers));
    expect(report.question_review.completion).toBe("incomplete");
  });
});
