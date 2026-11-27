// sites-pinned: tests/audit/next-step-question-workload.test.ts, tests/audit/result-submit.test.ts
import { compareCodeUnits, hashContent, stableStringify, toPosixPath } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { projectRuleMatchesLens } from "../orchestrator/projectRuleEvidence.js";
import { reviewSourceScope } from "../orchestrator/questionPlanning.js";
import { REVIEW_QUESTION_CONTRACT_VERSION, type ReviewAssignment, type ReviewEvidence, type ReviewReopenEvent, type ReviewSourceRef, questionReopenDependencies } from "../../shared/types/reviewQuestion.js";
import type { AuditQuestionBinding } from "./dispatch/questionReviewAcceptance.js";
import { buildLineIndexForPaths } from "./lineIndex.js";

/** Use one manifest-backed authority for binding and the planner; suggestions
 * only guide attention. Freeze the allowed index, not the file packet. */
export async function questionWorkloadBindings(
  bundle: ArtifactBundle,
  sourceRoot: string,
  evidence: readonly ReviewEvidence[],
  verifiedSourceFiles?: AuditQuestionBinding["sourceFiles"],
  reopens: readonly ReviewReopenEvent[] = [],
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
  const sourceFiles = allowed.map(path => {
    const fingerprint = scope.files.get(path)?.hash;
    const line_count = lineIndex[path];
    if (line_count === undefined || !Number.isInteger(line_count) || line_count < 0 || !fingerprint) {
      throw new Error("Cannot measure admitted audit source '" + path +
        "'. Restore readable frozen source and run next-step before dispatching reviewers.");
    }
    return { path, line_count, fingerprint };
  });
  const measured = new Set(sourceFiles.map(({ path }) => path));
  const includes = [...new Set(sourceFiles.map(({ path }) => path.split("/")[0]!))].sort(compareCodeUnits);
  const byInventory = new Map(plan.inventory.map(item => [item.inventory_item_id, item]));
  const sourcesFor = (inventory: string[]): ReviewSourceRef[] => {
    const refs = inventory.flatMap(id => {
      const item = byInventory.get(id);
      return item ? [...item.source_refs, ...item.contract_refs, ...(item.suggested_sources ?? [])] : [];
    }).filter(ref => measured.has(ref.path) && (ref.end_line ?? ref.start_line ?? 0) <= (lineIndex[ref.path] ?? 0));
    return [...new Map(refs.map(ref => [stableStringify(ref), ref])).values()];
  };
  const authorized_scope = { include: includes, exclude: [] };
  const epochs = questionReopenDependencies(reopens);
  // The publisher freezes this entire shared source binding, not just the
  // files named by one question. Hash it once rather than once per assignment.
  const sourceBinding = hashContent(stableStringify({ sourceRoot: toPosixPath(sourceRoot), sourceFiles }));
  // Index the same admitted records once for this workload. Store input
  // positions, not evidence IDs, so distinct records and stable tie order
  // match the original filter + sort.
  const evidenceByPath = new Map<string, number[]>();
  const evidenceByDependency = new Map<string, number[]>();
  const indexEvidence = (index: Map<string, number[]>, key: string, position: number) => {
    const positions = index.get(key);
    if (positions) positions.push(position);
    else index.set(key, [position]);
  };
  evidence.forEach((record, position) => {
    if (record.snapshot_id !== plan.snapshot_id || !record.source_refs.every(ref => measured.has(ref.path))) return;
    for (const ref of record.source_refs) indexEvidence(evidenceByPath, ref.path, position);
    for (const dependency of record.dependencies) indexEvidence(evidenceByDependency, stableStringify(dependency), position);
  });
  // Verify accepted claims and meaningful intent conflicts before heuristic
  // leads. This is scheduling order only; it does not change any binding.
  const priority = (question: typeof plan.questions[number]) => {
    const keys = question.evidence_dependencies.map(dep => dep.key);
    if (keys.some(key => /^(?:design-(?:contract|conceptual|systemic)|charter):/u.test(key))) return 0;
    return keys.some(key => key.startsWith("design-lead:")) ? 2 : 1;
  };
  return plan.questions.filter(q => q.plan_status === "pending" || q.plan_status === "active")
    .sort((a, b) => priority(a) - priority(b)).map(question => {
    const suggested_sources = sourcesFor(question.inventory_item_ids);
    const matches = new Set<number>();
    for (const { path } of suggested_sources) {
      for (const position of evidenceByPath.get(path) ?? []) matches.add(position);
    }
    for (const dependency of question.evidence_dependencies) {
      for (const position of evidenceByDependency.get(stableStringify(dependency)) ?? []) matches.add(position);
    }
    const scopedEvidence = [...matches].sort((a, b) =>
      compareCodeUnits(evidence[a]!.evidence_id, evidence[b]!.evidence_id) || a - b)
      .map(position => evidence[position]!)
      .filter(record => projectRuleMatchesLens(record.evidence_id, question.lens));
    const epoch = epochs.get(question.question_id);
    const dependencies = [...question.source_dependencies, ...question.evidence_dependencies, ...(epoch ? [epoch] : [])];
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
