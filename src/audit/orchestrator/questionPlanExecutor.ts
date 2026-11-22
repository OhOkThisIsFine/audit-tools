// sites-pinned: tests/audit/question-planning.test.ts, tests/audit/next-step-question-workload.test.ts
import { compareCodeUnits, hashContent, stableStringify } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditScopeManifest } from "../types/auditScope.js";
import type { ExecutorRunResult } from "./executorResult.js";
import { buildReviewQuestionPlan } from "./questionPlanning.js";

/**
 * The manifest is read from the run's frozen source before planning. Ignore
 * generated-at timestamps; the pin includes source bytes and index membership.
 * Question revision IDs separately describe what a particular answer depends on.
 */
export function buildQuestionPlanArtifacts(
  bundle: ArtifactBundle,
  scope: AuditScopeManifest,
): ExecutorRunResult {
  const manifest = bundle.repo_manifest;
  if (!manifest) throw new Error("Question planning requires the frozen repository manifest");
  const source = manifest.files.map(({ path, hash, size_bytes }) => [path, hash ?? null, size_bytes] as const)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  const snapshotId = hashContent(stableStringify({ source, index: manifest.scope_index_key ?? null }));
  const review_plan = buildReviewQuestionPlan(bundle, { snapshotId, scope });
  return {
    updated: { ...bundle, scope, review_plan },
    artifacts_written: ["scope.json", "review_plan.json"],
    progress_summary: `Planned ${review_plan.questions.length} review questions; ${review_plan.omissions.length} scope items need an explanation in the report.`,
  };
}
