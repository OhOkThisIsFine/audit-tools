import { expect, test } from "vitest";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { toPromptPathToken } from "audit-tools/shared";
import { hashArtifactValue } from "../../src/shared/artifactFreshness.js";
import { advanceToDispatchReady, callNextStep } from "./helpers/completion-harness.js";
import { withTempRepo } from "./helpers/next-step-harness.js";
import { persistAnalyzerSettings } from "../../src/shared/analyzerPolicy.js";
import { presentQuestionReport, readAcceptedAnswers, readQuestionFindings, readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { packageVersion } from "./helpers/wrapper-harness.js";

test("a fresh CLI finishes a persisted review once, replacing only the old report", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    // This smoke checks CLI persistence, not analyzer installation or output.
    await persistAnalyzerSettings(root, { typescript: "skip" });
    const step = await advanceToDispatchReady(root);
    expect(step).toMatchObject({ contract_version: "audit-code-step/v1alpha1", status: "ready" });
    const workload = await readQuestionWorkload(step);
    expect(workload.work_items.length).toBeGreaterThan(1);
    const firstCount = Math.ceil(workload.work_items.length / 2);
    const firstAnswers = await submitQuestions(root, workload.work_items.slice(0, firstCount));
    const submitted = firstAnswers[0]!;
    const source = resolve(root, workload.work_items[0]!.result_path);
    const run = (...args: string[]) => runWrapper(["--expect-version=" + packageVersion, ...args], { cwd: root });

    const receipt = JSON.parse((await run("submit", "--work-item", submitted.assignment_id, "--from", source)).stdout);
    expect(receipt).toMatchObject({ disposition: "accepted", submission_id: submitted.submission_id, run_id: workload.run_id });
    expect(await readAcceptedAnswers(artifactsDir, workload.run_id)).toEqual([submitted]);

    await unlink(source);

    // Collect the first wave through next-step. The direct CLI submission can
    // now come only from the ledger; the next workload must contain only work
    // that was not accepted yet.
    const resumed = await readQuestionWorkload(await callNextStep(root, artifactsDir));
    expect(resumed.run_id).toBe(workload.run_id);
    expect(resumed.work_items.map(item => item.binding.assignment.assignment_id).sort())
      .toEqual(workload.work_items.slice(firstCount).map(item => item.binding.assignment.assignment_id).sort());
    const acceptedFirst = await readAcceptedAnswers(artifactsDir, workload.run_id);
    expect(acceptedFirst).toHaveLength(firstAnswers.length);
    expect(acceptedFirst).toEqual(expect.arrayContaining(firstAnswers));

    const answers = [...firstAnswers, ...await submitQuestions(root, resumed.work_items)];
    // A fresh CLI process consumes the second wave and promotes the report.
    const reportPath = join(root, ".audit-tools", "audit-findings.json");
    const promotedMarkdown = join(root, ".audit-tools", "audit-report.md");
    const workingMarkdown = join(artifactsDir, "audit-report.md");
    await writeFile(promotedMarkdown, "# Prior audit marker\n");
    await writeFile(reportPath, JSON.stringify({ old: true }));
    const planFingerprint = async () => {
      const plan = JSON.parse(await readFile(join(artifactsDir, "review_plan.json"), "utf8"));
      const metadata = JSON.parse(await readFile(join(artifactsDir, "artifact_metadata.json"), "utf8"));
      return [hashArtifactValue("review_plan.json", plan), metadata.artifacts["review_plan.json"].revision];
    };
    const originalPlan = await planFingerprint();
    let reportAppeared = false;
    const terminal = await presentQuestionReport(root, async current => {
      expect(current.step_kind).not.toBe("dispatch_review");
      expect(await planFingerprint()).toEqual(originalPlan);
      if (reportAppeared) expect(existsSync(workingMarkdown)).toBe(true);
      if (existsSync(workingMarkdown)) {
        reportAppeared = true;
        expect(current.step_kind).not.toBe("blocked");
      }
    },
      async () => JSON.parse((await run("next-step")).stdout));
    expect(reportAppeared).toBe(true);
    expect(terminal).toMatchObject({ status: "complete", artifact_paths: { final_report: toPromptPathToken(promotedMarkdown) } });
    const markdown = await readFile(promotedMarkdown, "utf8");
    expect(markdown).toMatch(/# Audit Report/i);
    expect(markdown).not.toContain("Prior audit marker");
    await access(join(artifactsDir, "runs", workload.run_id, "host-accepted-results-ledger.json"));
    expect(await readFile(terminal.prompt_path, "utf8")).toMatch(/present report/i);
    const report = await readQuestionFindings(reportPath);
    expect(report.question_review.completion).toBe("incomplete");
    expect(report.question_review.accepted.map(({ submission }) => submission))
      .toEqual(expect.arrayContaining(answers));
    expect(report.question_review.accepted).toHaveLength(answers.length);
  });
});
