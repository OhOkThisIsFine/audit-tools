// sites-pinned: tests/audit/next-step-question-workload.test.ts, tests/audit/result-submit.test.ts
import { compareCodeUnits, hashContent, stableStringify, toPosixPath } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { reviewSourceScope } from "../orchestrator/questionPlanning.js";
import { REVIEW_QUESTION_CONTRACT_VERSION, type ReviewAssignment, type ReviewEvidence, type ReviewSourceRef } from "../../shared/types/reviewQuestion.js";
import type { AuditQuestionBinding } from "./dispatch/questionReviewAcceptance.js";
import { buildLineIndexForPaths } from "./lineIndex.js";

/** Use one manifest-backed authority for binding and the planner; suggestions
 * only guide attention. Freeze the allowed index, not the file packet. */
export async function questionWorkloadBindings(
  bundle: ArtifactBundle,
  sourceRoot: string,
  evidence: readonly ReviewEvidence[],
  verifiedSourceFiles?: AuditQuestionBinding["sourceFiles"],
): Promise<AuditQuestionBinding[]> {
  const plan = bundle.review_plan;
  if (!plan) throw new Error("Plan review questions before publishing an assignment");
  const scope = reviewSourceScope(bundle, bundle.scope);
  const allowed = [...new Set([...scope.allowedSourcePaths, ...scope.allowedContractPaths])].sort(compareCodeUnits);
  // Only direct submission supplies this index, after checking that its entire
  // footprint still hashes to the same frozen bytes. The stored line counts
  // then remain authoritative; don't repeat the file read just to count them.
  const verifiedByPath = verifiedSourceFiles && new Map(verifiedSourceFiles.map(file => [file.path, file]));
  if (verifiedByPath && (verifiedByPath.size !== verifiedSourceFiles!.length || allowed.length !== verifiedByPath.size ||
      allowed.some(path => verifiedByPath.get(path)?.fingerprint !== scope.files.get(path)?.hash))) {
    throw new Error("The issued source index is no longer current; run next-step before submitting.");
  }
  const lineIndex = verifiedByPath
    ? Object.fromEntries([...verifiedByPath].map(([path, file]) => [path, file.line_count]))
    : await buildLineIndexForPaths(sourceRoot, allowed);
  const sourceFiles = allowed.flatMap(path => {
    const fingerprint = scope.files.get(path)?.hash;
    const line_count = lineIndex[path];
    return fingerprint && Number.isInteger(line_count) && line_count! >= 0
      ? [{ path, line_count: line_count!, fingerprint }] : [];
  });
  const measured = new Set(sourceFiles.map(({ path }) => path));
  const includes = [...new Set(sourceFiles.map(({ path }) => path.split("/")[0]!))].sort(compareCodeUnits);
  const byInventory = new Map(plan.inventory.map(item => [item.inventory_item_id, item]));
  const sourcesFor = (inventory: string[]): ReviewSourceRef[] => {
    const refs = inventory.flatMap(id => {
      const item = byInventory.get(id);
      return item ? [...item.source_refs, ...item.contract_refs] : [];
    }).filter(ref => measured.has(ref.path) && (ref.end_line ?? ref.start_line ?? 0) <= (lineIndex[ref.path] ?? 0));
    return [...new Map(refs.map(ref => [stableStringify(ref), ref])).values()];
  };
  const authorized_scope = { include: includes, exclude: [] };
  // The publisher freezes this entire shared source binding, not just the
  // files named by one question. Hash it once rather than once per assignment.
  const sourceBinding = hashContent(stableStringify({ sourceRoot: toPosixPath(sourceRoot), sourceFiles }));
  return plan.questions.filter(q => q.plan_status === "pending" || q.plan_status === "active").map(question => {
    const suggested_sources = sourcesFor(question.inventory_item_ids);
    const scopedEvidence = evidence.filter(record => record.snapshot_id === plan.snapshot_id &&
      record.source_refs.every(ref => measured.has(ref.path)) &&
      (record.source_refs.some(ref => suggested_sources.some(suggestion => ref.path === suggestion.path)) ||
       question.evidence_dependencies.some(dep => record.dependencies.some(bound => stableStringify(dep) === stableStringify(bound)))))
      .sort((a, b) => compareCodeUnits(a.evidence_id, b.evidence_id));
    const dependencies = [...question.source_dependencies, ...question.evidence_dependencies];
    const issued = {
      schema_version: REVIEW_QUESTION_CONTRACT_VERSION,
      question_id: question.question_id, revision_id: question.revision_id, snapshot_id: question.snapshot_id,
      authorized_scope, suggested_sources, available_evidence_ids: scopedEvidence.map(record => record.evidence_id),
    } satisfies Omit<ReviewAssignment, "assignment_id">;
    // Question revision controls accepted-answer reuse. The assignment additionally
    // binds what the reviewer was actually offered, including optional leads.
    const assignment_id = `review-${hashContent(stableStringify({
      sourceBinding, question, issued, dependencies, evidence: scopedEvidence,
    }))}`;
    return { question, sourceFiles, evidence: scopedEvidence, dependencies, assignment: { ...issued, assignment_id } };
  });
}
