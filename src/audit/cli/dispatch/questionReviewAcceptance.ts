// sites-pinned: tests/audit/question-review-acceptance.test.ts
import { compareCodeUnits, pathMatchesPrefix, stableStringify } from "audit-tools/shared";
import { fileInspectionPartId, FILE_INSPECTION_PREFIX } from "../../orchestrator/fullFileReview.js";
import { isProjectRulePath } from "../../orchestrator/projectRuleEvidence.js";
import { analyzerReceiptFingerprint } from "../../orchestrator/questionEvidence.js";
import { DISCONFIRMATION_PART_ID, questionReopenKey } from "../../../shared/types/reviewQuestion.js";
import type { CurrentQuestionDependencies, ReviewDependency, ReviewAcceptedAnswer, ReviewAnswer, ReviewAssignment, ReviewEvidence, ReviewQuestion, ReviewSourceRef, ReviewSubmission } from "../../../shared/types/reviewQuestion.js";

export interface AuditQuestionBinding {
  question: ReviewQuestion;
  assignment: ReviewAssignment;
  sourceFiles: readonly { path: string; line_count: number; fingerprint: string }[];
  evidence: readonly ReviewEvidence[];
  /** Recomputed by the evidence owner for this exact issued question. */
  dependencies: ReviewAcceptedAnswer["dependency_bindings"];
}

export class QuestionSourceValidationError extends Error {
  constructor(readonly failure: { kind: "source_scope" } | { kind: "source_span"; lineCount: number }) {
    super(failure.kind === "source_scope" ? "Source is outside this assignment" : "Source span is outside the issued file");
  }
}

export function validateQuestionSource(binding: AuditQuestionBinding, ref: ReviewSourceRef): void {
  const scope = binding.assignment.authorized_scope;
  const source = binding.sourceFiles.find((item) => item.path === ref.path);
  if (!source || !scope.include.some((path) => pathMatchesPrefix(ref.path, path)) ||
      scope.exclude.some((path) => pathMatchesPrefix(ref.path, path))) {
    throw new QuestionSourceValidationError({ kind: "source_scope" });
  }
  if ((ref.start_line !== undefined && (!Number.isInteger(ref.start_line) || ref.start_line < 1)) ||
      (ref.end_line !== undefined && (!Number.isInteger(ref.end_line) || ref.end_line < (ref.start_line ?? 1))) ||
      (ref.end_line ?? ref.start_line ?? 0) > source.line_count) {
    throw new QuestionSourceValidationError({ kind: "source_span", lineCount: source.line_count });
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
  if (question.question_id.startsWith(FILE_INSPECTION_PREFIX)) {
    const inspected = new Set(submission.inspected_sources.map(ref => ref.path));
    const assignedPaths = new Set(question.source_dependencies.filter(row => row.kind === "source").map(row => row.key));
    for (const path of assignedPaths) {
      const part = submission.answer.parts.find(row => row.part_id === fileInspectionPartId(path));
      if (!part) throw new Error("Static inspection requires a result for each assigned file: " + path);
      const ownSource = part.observation_ids.flatMap(id => {
        const observation = observations.get(id);
        return observation?.kind === "source_confirmed" ? observation.source_refs.filter(ref => ref.path === path) : [];
      });
      if (!inspected.has(path)) {
        if (part.outcome !== "inconclusive" || !part.reason?.trim() || ownSource.length) {
          throw new Error("An unread assigned file must be inconclusive with a reason and cannot claim a source confirmation: " + path);
        }
      } else if (!ownSource.some(ref => ref.start_line !== undefined ||
        binding.sourceFiles.some(file => file.path === path && file.line_count === 0))) {
        throw new Error("Each declared inspection requires source-confirmed evidence for its own assigned file: " + path);
      }
    }
    if ([...inspected].some(path => !assignedPaths.has(path))) {
      throw new Error("Static inspection can declare reads only for its assigned files.");
    }
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

    if (finding.kind === "confirmed_defect" &&
        question.requested_parts.some(part => part.part_id === DISCONFIRMATION_PART_ID)) {
      const countercheck = submission.answer.parts.find(part => part.part_id === DISCONFIRMATION_PART_ID);
      const findingsParts = new Set(submission.answer.parts
        .filter(part => part.part_id !== DISCONFIRMATION_PART_ID && part.outcome === "findings")
        .flatMap(part => part.observation_ids));
      const supporting = links.map(id => observations.get(id)!)
        .filter(observation => findingsParts.has(observation.observation_id) && observation.kind !== "unverified");
      const precise = (ref: ReviewSourceRef) => ref.start_line !== undefined && !isProjectRulePath(ref.path);
      const support = supporting.flatMap(observation => observation.source_refs);
      const supportingEvidence = new Set(finding.evidence_ids);
      const supportingObservations = new Set(supporting.map(observation => observation.observation_id));
      for (const observation of supporting) {
        for (const ref of observation.evidence_refs) {
          supportingEvidence.add(ref.evidence_id);
          if (ref.observation_id) supportingObservations.add(ref.observation_id);
        }
      }
      const independentSpan = (ref: ReviewSourceRef) => precise(ref) && !support.some(other =>
        other.path === ref.path && (other.start_line === undefined ||
          (ref.start_line! <= (other.end_line ?? other.start_line) &&
            other.start_line <= (ref.end_line ?? ref.start_line!))));
      const checked = countercheck?.outcome === "clean" && countercheck.observation_ids.some(id => {
        const observation = observations.get(id);
        if (observation?.kind === "runtime_observed") {
          return observation.evidence_refs.some(ref => ref.observation_id !== undefined &&
            !supportingEvidence.has(ref.evidence_id) && !supportingObservations.has(ref.observation_id));
        }
        return observation?.kind === "source_confirmed" && observation.source_refs.some(independentSpan);
      }) && support.some(precise);
      if (!checked) {
        throw new Error("A targeted confirmed defect needs a source-anchored finding and a distinct, checked disconfirmation observation; report a lead when the countercheck is inconclusive.");
      }
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
    // A historic obligation is current only if this exact comparison was
    // bound in its own accepted record and is still issued for the cited lead.
    row.submission.answer.findings.every(finding => finding.verification.every(obligation => {
      if (obligation.kind !== "analyzer") return true;
      if (!obligation.provenance.comparison_fingerprint) return false;
      const fingerprint = analyzerReceiptFingerprint(obligation.provenance);
      return finding.evidence_ids.some(key => currentBindings.has(dependencyIdentity([{ kind: "evidence", key, fingerprint }])) &&
        row.dependency_bindings.some(item => item.kind === "evidence" && item.key === key && item.fingerprint === fingerprint));
    })) &&
    row.dependency_bindings.length > 0 && row.dependency_bindings.every((item) => {
      const identity = dependencyIdentity([item]);
      return currentBindings.has(identity) || shared?.has(identity);
    }) &&
    required.every((dependency) => row.dependency_bindings.some((item) => dependencyIdentity([item]) === dependencyIdentity([dependency]))));
  const stale = sameQuestion.filter((row) => !current.includes(row));
  return { current, stale };
}
