import { expect, test } from "vitest";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { toPromptPathToken } from "audit-tools/shared";
import { hashArtifactValue } from "../../src/shared/artifactFreshness.js";
import { advanceToDispatchReady } from "./helpers/completion-harness.js";
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
    expect(report.question_review.accepted.map(({ submission }) => submission))
      .toEqual(expect.arrayContaining(answers));
    expect(report.question_review.accepted).toHaveLength(answers.length);
  });
});
