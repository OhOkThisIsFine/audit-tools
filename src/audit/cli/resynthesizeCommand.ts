import { assertNoPendingFoldReceipt } from "../io/foldReceiptPath.js";
// sites-pinned: tests/audit/resynthesize-command.test.ts
import { join } from "node:path";
import { getArtifactsDir, getFlag } from "./args.js";
import { readQuestionReportCharterOptions, readQuestionReportReflections } from "../io/artifacts.js";
import { renderAuditReportMarkdown } from "../reporting/synthesis.js";
import {
  AUDIT_FINDINGS_FILENAME, promotedAuditFindingsPath, promotedAuditReportPath,
  readOptionalTextFile, stableStringify, writeTextFile,
} from "audit-tools/shared";
import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
import { errorMessage } from "../../shared/io/json.js";
import { ReviewPlanSchema } from "../../shared/types/reviewQuestion.js";
import { QuestionAuditFindingsReportSchema } from "../../shared/types/questionReviewReport.js";
import { outputJson } from "./cliHelpers.js";

/** Render only from the current promoted machine report. Never restamp or import another audit. */
export async function cmdResynthesize(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const findingsPath = promotedAuditFindingsPath(artifactsDir);
  const inputPath = getFlag(argv, "--input") ?? findingsPath;
  try {
    const raw = await readOptionalTextFile(findingsPath);
    if (raw === undefined) throw new Error(`Current ${AUDIT_FINDINGS_FILENAME} not found at ${findingsPath}.`);
    const parsed = QuestionAuditFindingsReportSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("Only the current question-based v2 report can be regenerated. Archived reports are left unchanged.");
    if (inputPath !== findingsPath && await readOptionalTextFile(inputPath) !== raw) {
      throw new Error("Explicit input is not the current promoted machine report; no report was overwritten.");
    }
    await withArtifactTreeHold(artifactsDir, undefined, async assertOwnership => {
      await assertNoPendingFoldReceipt(artifactsDir);
      if (await readOptionalTextFile(findingsPath) !== raw) {
        throw new Error("The current promoted report changed before regeneration.");
      }
      const planRaw = await readOptionalTextFile(join(artifactsDir, "review_plan.json"));
      if (planRaw === undefined) {
        throw new Error("No current review_plan.json owns the promoted report. Its original charter and reflection inputs cannot be reconstructed; the promoted files were left unchanged.");
      }
      const plan = ReviewPlanSchema.parse(JSON.parse(planRaw));
      const working = await readOptionalTextFile(join(artifactsDir, AUDIT_FINDINGS_FILENAME));
      if (plan.snapshot_id !== parsed.data.question_review.snapshot_id ||
          working === undefined || stableStringify(JSON.parse(working)) !== stableStringify(JSON.parse(raw))) {
        throw new Error("The active audit does not own the promoted report; no report was overwritten.");
      }
      const report = parsed.data;
      const reportPath = promotedAuditReportPath(artifactsDir);
      const markdown = renderAuditReportMarkdown(report, {
        reflections: await readQuestionReportReflections(artifactsDir),
        ...await readQuestionReportCharterOptions(artifactsDir),
      });
      await assertOwnership();
      await writeTextFile(reportPath, markdown);
      outputJson({
        source: inputPath,
        findings_output: findingsPath,
        report_output: reportPath,
        finding_count: report.summary.finding_count,
        work_block_count: report.summary.work_block_count,
        contract_version: report.contract_version,
      });
    });
  } catch (error) {
    console.error(`resynthesize: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
