// sites-pinned: tests/audit/next-step-question-workload.test.ts, tests/audit/cli-dispatcher.test.ts
import { assertNoPendingFoldReceipt } from "../io/foldReceiptPath.js";
import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
import { getArtifactsDir, getFlag, getRootDir, hasFlag } from "./args.js";
import { outputJson } from "./cliHelpers.js";
import { prepareAuditQuestionReview, prepareAuditQuestionReviews } from "./dispatch/hostHandoff.js";
import { readQuestionReviewRunId } from "./questionReviewSession.js";

export async function cmdPrepareReview(argv: string[]): Promise<void> {
  const assignmentId = getFlag(argv, "--work-item");
  const assignmentIds = getFlag(argv, "--work-items")?.split(",");
  const workloadSha256 = getFlag(argv, "--workload-sha256");
  if (hasFlag(argv, "--work-item") === hasFlag(argv, "--work-items") ||
      (!assignmentId && !assignmentIds) || !workloadSha256 || !/^[0-9a-f]{64}$/u.test(workloadSha256)) {
    throw new Error("Usage: audit-code prepare-review (--work-item <assignment_id> | --work-items <id1,id2,...>) --workload-sha256 <issued sha256>");
  }
  const root = getRootDir(argv);
  const artifactsDir = getArtifactsDir(argv);
  const result = await withArtifactTreeHold(artifactsDir, undefined, async () => {
    await assertNoPendingFoldReceipt(artifactsDir);
    const runId = await readQuestionReviewRunId(artifactsDir);
    if (runId === undefined) throw new Error("No active question-review run. Run next-step to publish the current assignments.");
    const boundary = { root, artifactsDir, runId, workloadSha256 };
    if (assignmentIds) return { run_id: runId, workload_sha256: workloadSha256,
      outcomes: await prepareAuditQuestionReviews({ ...boundary, assignmentIds }) };
    return prepareAuditQuestionReview({ ...boundary, assignmentId: assignmentId! });
  });
  outputJson(result);
}
