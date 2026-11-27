// sites-pinned: tests/audit/question-review-acceptance.test.ts
import { compareCodeUnits, pathMatchesPrefix, stableStringify } from "audit-tools/shared";
import { questionReopenKey } from "../../../shared/types/reviewQuestion.js";
import type { CurrentQuestionDependencies, ReviewDependency, ReviewAcceptedAnswer, ReviewAdjudication, ReviewAnswer, ReviewAssignment, ReviewEvidence, ReviewQuestion, ReviewSourceRef, ReviewSubmission } from "../../../shared/types/reviewQuestion.js";

export interface AuditQuestionBinding {
  question: ReviewQuestion;
  assignment: ReviewAssignment;
  sourceFiles: readonly { path: string; line_count: number; fingerprint: string }[];
  evidence: readonly ReviewEvidence[];
  /** Recomputed by the evidence owner for this exact issued question. */
  dependencies: ReviewAcceptedAnswer["dependency_bindings"];
}

export function validateQuestionSource(binding: AuditQuestionBinding, ref: ReviewSourceRef): void {
  const scope = binding.assignment.authorized_scope;
  const source = binding.sourceFiles.find((item) => item.path === ref.path);
  if (!source || !scope.include.some((path) => pathMatchesPrefix(ref.path, path)) ||
      scope.exclude.some((path) => pathMatchesPrefix(ref.path, path))) {
    throw new Error(`Source is outside this assignment: ${ref.path}`);
  }
  if ((ref.start_line !== undefined && (!Number.isInteger(ref.start_line) || ref.start_line < 1)) ||
      (ref.end_line !== undefined && (!Number.isInteger(ref.end_line) || ref.end_line < (ref.start_line ?? 1))) ||
      (ref.end_line ?? ref.start_line ?? 0) > source.line_count) {
    throw new Error(`Source span is outside the issued file: ${ref.path}`);
  }
}

export function acceptQuestionReview(answers: readonly ReviewAcceptedAnswer[], binding: AuditQuestionBinding,
  submission: ReviewSubmission, acceptedAt: string,
): { kind: "replay" | "accepted"; record: ReviewAcceptedAnswer } {
  const prior = answers.find((row) => row.submission.submission_id === submission.submission_id);
  if (prior) {
    if (stableStringify(prior.submission) !== stableStringify(submission)) throw new Error("Conflicting reuse of an accepted review submission ID");
    return { kind: "replay", record: prior };
  }
  const { question, assignment } = binding;
  if (submission.assignment_id !== assignment.assignment_id || submission.question_id !== assignment.question_id ||
      submission.question_id !== question.question_id || submission.revision_id !== assignment.revision_id ||
      submission.revision_id !== question.revision_id || submission.snapshot_id !== assignment.snapshot_id ||
      submission.snapshot_id !== question.snapshot_id) {
    throw new Error("Review submission does not match the current issued assignment, question revision and snapshot");
  }
  if (answers.some((row) => row.submission.assignment_id === submission.assignment_id)) {
    throw new Error("An assignment already has an accepted response; a second independent response requires an independently issued assignment");
  }
  const actual = new Set<string>();
  const bindSource = (ref: ReviewSourceRef) => { validateQuestionSource(binding, ref); actual.add(ref.path); };
  for (const ref of submission.inspected_sources) bindSource(ref);
  const evidence = new Map(binding.evidence.filter((row) => row.snapshot_id === submission.snapshot_id).map((row) => [row.evidence_id, row]));
  for (const id of submission.evidence_ids) {
    const issued = evidence.get(id);
    if (!issued || !assignment.available_evidence_ids.includes(id)) throw new Error(`Evidence was not issued for this assignment: ${id}`);
    for (const ref of issued.source_refs) bindSource(ref);
  }
  const requested = new Set(question.requested_parts.map((part) => part.part_id));
  const seen = new Set<string>();
  const observations = new Map<string, ReviewAnswer["observations"][number]>();
  for (const observation of submission.answer.observations) {
    if (observations.has(observation.observation_id) || !requested.has(observation.part_id) ||
        observation.question_id !== submission.question_id || observation.revision_id !== submission.revision_id ||
        observation.snapshot_id !== submission.snapshot_id) throw new Error("Unknown, duplicate or misbound review observation");
    for (const ref of observation.source_refs) bindSource(ref);
    if (observation.kind === "source_confirmed" && observation.source_refs.length === 0) throw new Error("Source confirmation requires inspected source");
    for (const ref of observation.evidence_refs) {
      const bundle = evidence.get(ref.evidence_id);
      const named = bundle?.observations?.find((item) => item.observation_id === ref.observation_id);
      if (!submission.evidence_ids.includes(ref.evidence_id) || !bundle ||
          (observation.kind !== "unverified" && bundle.status !== "observed") ||
          (ref.observation_id !== undefined && !named) ||
          (observation.kind === "runtime_observed" && (bundle.execution?.executed !== true || !named))) {
        throw new Error(`Observation links unavailable or unissued evidence: ${ref.evidence_id}`);
      }
      for (const source of named?.source_refs ?? []) bindSource(source);
    }
    observations.set(observation.observation_id, observation);
  }
  for (const part of submission.answer.parts) {
    if (seen.has(part.part_id) || !requested.has(part.part_id)) throw new Error(`Unknown or duplicate requested part: ${part.part_id}`);
    if ((part.outcome !== "inconclusive" && !part.observation_ids.some((id) => observations.get(id)?.kind !== "unverified")) ||
        part.observation_ids.some((id) => observations.get(id)?.part_id !== part.part_id)) throw new Error(`Review part has unsupported observation links: ${part.part_id}`);
    seen.add(part.part_id);
  }
  const findings = new Set<string>();
  const claimedObservations = new Set<string>();
  for (const finding of submission.answer.findings) {
    if (findings.has(finding.finding_id)) throw new Error("Duplicate local finding ID");
    findings.add(finding.finding_id);
    const links = finding.observation_ids ?? [];
    if (new Set(links).size !== links.length || links.some(id => !observations.has(id))) {
      throw new Error("Finding has unknown or duplicate observation links");
    }
    if (finding.kind === "confirmed_defect" && !links.some(id =>
      observations.get(id)?.kind !== "unverified" && submission.answer.parts.some(part =>
        part.outcome === "findings" && part.observation_ids.includes(id)))) {
      throw new Error("Confirmed defect requires its own supported findings-part observation");
    }
    if (finding.question_id !== submission.question_id || finding.revision_id !== submission.revision_id ||
        finding.evidence_ids.some((id) => !submission.evidence_ids.includes(id))) throw new Error("Finding does not match accepted scope or evidence");
    for (const ref of finding.source_refs) bindSource(ref);
    for (const obligation of finding.verification) if (obligation.kind === "assertion") {
      for (const ref of obligation.source_refs) bindSource(ref);
    } else if (obligation.kind === "analyzer") {
      bindSource({ path: obligation.provenance.path });
      if (!obligation.provenance.comparison_fingerprint || !finding.evidence_ids.some(id => {
        const issued = evidence.get(id);
        return issued?.status === "observed" && issued.analyzer_provenance &&
          stableStringify(issued.analyzer_provenance) === stableStringify(obligation.provenance);
      })) throw new Error("Analyzer comparison receipt must come from cited issued evidence; use an assertion obligation for independently checkable behavior when no receipt is available");
    }
    for (const id of links) {
      if (observations.get(id)?.kind !== "unverified") claimedObservations.add(id);
    }
  }
  for (const part of submission.answer.parts) {
    if (part.outcome === "findings" && !part.observation_ids.some(id => claimedObservations.has(id))) {
      throw new Error(`Findings part requires a claim linked to its own supported observation: ${part.part_id}`);
    }
  }
  return { kind: "accepted", record: {
    schema_version: submission.schema_version,
    accepted_at: acceptedAt,
    submission,
    dependency_bindings: [...new Map([
      ...binding.dependencies,
      ...binding.sourceFiles.filter((item) => actual.has(item.path)).map((item) =>
        ({ kind: "source" as const, key: item.path, fingerprint: item.fingerprint })),
      ...submission.evidence_ids.flatMap((id) => evidence.get(id)?.dependencies ?? []),
    ].map((dependency) => [dependencyIdentity([dependency]), dependency])).values()],
  } };
}

export function validateQuestionAdjudication(answers: readonly ReviewAcceptedAnswer[], existing: readonly ReviewAdjudication[],
  adjudication: ReviewAdjudication, question: ReviewQuestion, dependencies: ReviewAcceptedAnswer["dependency_bindings"],
): "replay" | "accepted" {
  const previous = existing.find((item) => item.adjudication_id === adjudication.adjudication_id);
  if (previous) {
    if (stableStringify(previous) !== stableStringify(adjudication)) throw new Error("Conflicting reuse of an adjudication ID");
    return "replay";
  }
  const currentIds = new Set(projectQuestionReview(question, answers, dependencies).current.map(({ submission }) => submission.submission_id));
  if (adjudication.question_id !== question.question_id || adjudication.revision_id !== question.revision_id ||
      adjudication.snapshot_id !== question.snapshot_id || new Set(adjudication.submission_ids).size !== adjudication.submission_ids.length ||
      adjudication.submission_ids.some((id) => !currentIds.has(id)) ||
      adjudication.selected_submission_ids.some((id) => !adjudication.submission_ids.includes(id)) ||
      (adjudication.decision === "resolved" && adjudication.selected_submission_ids.length === 0)) {
    throw new Error("Adjudication must name the current question and the accepted answers it actually resolves");
  }
  return "accepted";
}

/** An inconclusive observation remains open; no implicit parent-level credit. */
export function reviewAnswerDisposition(requested: readonly string[], parts: ReviewAnswer["parts"]) {
  const supported = new Set(parts.filter((part) => part.outcome !== "inconclusive" && part.observation_ids.length > 0)
    .map((part) => part.part_id));
  return { answered: requested.filter((part) => supported.has(part)), open: requested.filter((part) => !supported.has(part)) };
}

function dependencyIdentity(dependencies: Readonly<ReviewAcceptedAnswer["dependency_bindings"]>): string {
  return stableStringify(dependencies.map((entry) => [entry.kind, entry.key, entry.fingerprint])
    .sort((a, b) => compareCodeUnits(a.join("\0"), b.join("\0"))));
}

export function indexQuestionDependencies(dependencies: readonly ReviewDependency[]): ReadonlySet<string> {
  return new Set(dependencies.map(row => dependencyIdentity([row])));
}

/** Classify accepted answer currency; part verdicts belong to the report projection. */
export function projectQuestionReview(question: ReviewQuestion, answers: readonly ReviewAcceptedAnswer[],
  dependencies: CurrentQuestionDependencies | undefined,
) {
  const shared = dependencies && "sourceIndex" in dependencies ? dependencies.sourceIndex : undefined;
  const local = dependencies && "local" in dependencies ? dependencies.local : dependencies;
  const currentBindings = indexQuestionDependencies(local ?? []);
  const required = [...question.source_dependencies, ...question.evidence_dependencies,
    ...local?.filter(item => item.kind === "membership" && item.key === questionReopenKey(question.question_id)) ?? []];
  const sameQuestion = answers.filter((row) => row.submission.question_id === question.question_id)
    .sort((a, b) => compareCodeUnits(a.submission.submission_id, b.submission.submission_id));
  const current = sameQuestion.filter((row) => dependencies !== undefined &&
    row.submission.revision_id === question.revision_id &&
    // Earlier ledgers could accept analyzer obligations without recording the
    // receipt dependency. Confirm their explicit claims against current evidence.
    row.submission.answer.findings.every(finding => finding.verification.every(obligation =>
      obligation.kind !== "analyzer" || (obligation.provenance.comparison_fingerprint &&
        finding.evidence_ids.some(key => currentBindings.has(dependencyIdentity([{
          kind: "evidence", key, fingerprint: obligation.provenance.comparison_fingerprint!,
        }])))))) &&
    row.dependency_bindings.length > 0 && row.dependency_bindings.every((item) => {
      const identity = dependencyIdentity([item]);
      return currentBindings.has(identity) || shared?.has(identity);
    }) &&
    required.every((dependency) => row.dependency_bindings.some((item) => dependencyIdentity([item]) === dependencyIdentity([dependency]))));
  const stale = sameQuestion.filter((row) => !current.includes(row));
  return { current, stale };
}
