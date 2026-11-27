// sites-pinned: tests/shared/review-question-contract.test.ts, tests/audit/question-review-acceptance.test.ts
import { z } from "zod";
import { AnalyzerLeadProvenanceSchema } from "../analyzers/provenance.js";
import { FindingConfidenceSchema, FindingSeveritySchema } from "./findingVocabulary.js";

/** The question workflow is a cutover, not an alias for legacy lens-task results. */
export const REVIEW_QUESTION_CONTRACT_VERSION = "audit-tools/question-review/v1";
const version = { schema_version: z.literal(REVIEW_QUESTION_CONTRACT_VERSION) };
const value = z.string().trim().min(1);
const id = z.string().min(1).refine((s) => s === s.trim(), "ID must not contain leading or trailing whitespace");

export const BUILT_IN_REVIEW_LENSES = [
  "behavior", "security", "architecture", "performance", "operability", "config_deployment", "tests",
] as const;
export const BuiltInReviewLensSchema = z.enum(BUILT_IN_REVIEW_LENSES);
export const ReviewLensSchema = z.union([
  BuiltInReviewLensSchema,
  z.string().regex(/^custom:[a-z0-9]+(?:-[a-z0-9]+)*$/).transform((lens) => lens as `custom:${string}`),
]);
export type BuiltInReviewLens = z.infer<typeof BuiltInReviewLensSchema>;
export type ReviewLens = z.infer<typeof ReviewLensSchema>;

const repoPath = z.string().min(1).refine(
  (p) => !p.startsWith("/") && !p.includes("\\") && !p.includes(":") &&
    p.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "source paths must be repository-relative with forward slashes",
);
export const ReviewSourceRefSchema = z.strictObject({
  path: repoPath,
  symbol: value.optional(),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
}).refine(
  (s) => s.end_line === undefined || (s.start_line !== undefined && s.end_line >= s.start_line),
  "end_line requires a start_line and cannot precede it",
);
export type ReviewSourceRef = z.infer<typeof ReviewSourceRefSchema>;

export const ReviewDependencySchema = z.strictObject({
  kind: z.enum(["source", "evidence", "membership"]),
  key: id,
  fingerprint: id,
});
export type ReviewDependency = z.infer<typeof ReviewDependencySchema>;

/** In-memory current dependencies, optionally sharing one frozen source index per cycle. */
export type CurrentQuestionDependencies = readonly ReviewDependency[] | {
  sourceIndex: ReadonlySet<string>;
  local: readonly ReviewDependency[];
};

const questionBinding = { question_id: id, revision_id: id, snapshot_id: id };
export const ReviewInventoryItemSchema = z.strictObject({
  inventory_item_id: id,
  kind: z.enum(["operation", "invariant", "trust_boundary", "workload", "operator_transition", "release_transition"]),
  title: value,
  contract_refs: z.array(ReviewSourceRefSchema),
  source_refs: z.array(ReviewSourceRefSchema),
  /** Optional starting points, outside the question's revision dependencies. */
  suggested_sources: z.array(ReviewSourceRefSchema).optional(),
  scope: z.enum(["in_scope", "excluded", "not_applicable", "deferred"]),
  scope_reason: value.optional(),
}).refine((item) => item.scope === "in_scope" || item.scope_reason !== undefined, "non-active inventory requires a reason");
export type ReviewInventoryItem = z.infer<typeof ReviewInventoryItemSchema>;

export const ReviewQuestionPlanStatusSchema = z.enum(["unassigned", "pending", "active", "deferred", "blocked"]);

export const ReviewQuestionSchema = z.strictObject({
  ...version,
  ...questionBinding,
  lens: ReviewLensSchema,
  inventory_item_ids: z.array(id).min(1),
  expected_outcome: value,
  requested_parts: z.array(z.strictObject({ part_id: id, expectation: value })).min(1),
  source_dependencies: z.array(ReviewDependencySchema),
  evidence_dependencies: z.array(ReviewDependencySchema),
  plan_status: ReviewQuestionPlanStatusSchema,
  plan_reason: value.optional(),
}).refine((q) => (
  (q.plan_status !== "deferred" && q.plan_status !== "blocked") || q.plan_reason !== undefined
), "deferred and blocked questions require a reason").refine(
  (q) => new Set(q.requested_parts.map((part) => part.part_id)).size === q.requested_parts.length,
  "part IDs must be unique within the question",
);
export type ReviewQuestion = z.infer<typeof ReviewQuestionSchema>;

// Planning dispositions retain the exact candidate without claiming a review decision.
export const ReviewSignalDispositionSchema = z.strictObject({
  signal_id: id,
  outcome: z.enum(["promoted", "grouped", "not_promoted"]),
  reason: value,
  question_id: id.optional(),
  source_refs: z.array(ReviewSourceRefSchema).optional(),
}).refine(row => (row.outcome === "not_promoted") === (row.question_id === undefined),
  "promoted or grouped signals must name a question; unpromoted signals must not");

export const ReviewPlanObjectSchema = z.strictObject({
  ...version,
  snapshot_id: id,
  inventory: z.array(ReviewInventoryItemSchema),
  questions: z.array(ReviewQuestionSchema),
  signal_dispositions: z.array(ReviewSignalDispositionSchema).optional(),
  omissions: z.array(z.strictObject({
    surface_id: id,
    source_refs: z.array(ReviewSourceRefSchema),
    reason: value,
  })),
  lens_decisions: z.array(z.strictObject({
    lens: ReviewLensSchema,
    decision: z.enum(["selected", "excluded", "not_applicable"]),
    reason: value,
  })),
});
export const ReviewPlanSchema = ReviewPlanObjectSchema.refine(plan => {
  if (!plan.signal_dispositions) return true;
  const questionIds = new Set(plan.questions.map(row => row.question_id));
  const signals = new Set(plan.signal_dispositions.map(row => row.signal_id));
  return signals.size === plan.signal_dispositions.length &&
    plan.signal_dispositions.every(row => row.question_id === undefined || questionIds.has(row.question_id));
}, { path: ["signal_dispositions"], message: "signal IDs must be unique and linked questions must be planned" });
export type ReviewPlan = z.infer<typeof ReviewPlanSchema>;

export const ReviewAssignmentSchema = z.strictObject({
  ...version,
  ...questionBinding,
  assignment_id: id,
  authorized_scope: z.strictObject({ include: z.array(value), exclude: z.array(value) }),
  suggested_sources: z.array(ReviewSourceRefSchema),
  available_evidence_ids: z.array(id),
});
export type ReviewAssignment = z.infer<typeof ReviewAssignmentSchema>;

const evidenceRef = z.strictObject({ evidence_id: id, observation_id: id.optional() });
export const ReviewEvidenceSchema = z.strictObject({
  ...version,
  evidence_id: id,
  snapshot_id: id,
  kind: z.enum(["source", "command", "measurement", "fixture"]),
  source_refs: z.array(ReviewSourceRefSchema),
  dependencies: z.array(ReviewDependencySchema),
  status: z.enum(["observed", "unavailable", "not_run"]),
  description: value,
  analyzer_provenance: AnalyzerLeadProvenanceSchema.optional(),
  observations: z.array(z.strictObject({
    observation_id: id,
    statement: value,
    source_refs: z.array(ReviewSourceRefSchema).optional(),
  })).optional(),
  execution: z.strictObject({
    tool: value,
    tool_version: value,
    config_fingerprint: id,
    input_fingerprint: id,
    environment_fingerprint: id,
    exclusions: z.array(value),
    executed: z.boolean(),
    elapsed_ms: z.number().nonnegative().optional(),
    usage: z.record(z.string(), z.number().nonnegative()).optional(),
  }).optional(),
}).refine((e) => !e.observations?.length || e.status === "observed", "named observations require observed evidence");
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;

export const ReviewObservationSchema = z.strictObject({
  ...version,
  ...questionBinding,
  observation_id: id,
  part_id: id,
  kind: z.enum(["source_confirmed", "runtime_observed", "unverified"]),
  statement: value,
  source_refs: z.array(ReviewSourceRefSchema),
  evidence_refs: z.array(evidenceRef),
}).refine((o) => o.kind !== "runtime_observed" || o.evidence_refs.some((e) => e.observation_id !== undefined),
  "runtime claims require a named evidence observation");
export type ReviewObservation = z.infer<typeof ReviewObservationSchema>;

export const ReviewVerificationObligationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("analyzer"), obligation_id: id, provenance: AnalyzerLeadProvenanceSchema }),
  z.strictObject({ kind: z.literal("assertion"), obligation_id: id, expected: value, source_refs: z.array(ReviewSourceRefSchema).min(1) }),
  z.strictObject({
    kind: z.literal("disposition"),
    obligation_id: id,
    disposition: z.enum(["implemented", "deferred", "rejected", "already_fixed", "out_of_scope"]),
    reason: value,
  }),
]);
export type ReviewVerificationObligation = z.infer<typeof ReviewVerificationObligationSchema>;

export const ReviewFindingClaimSchema = z.strictObject({
  ...version,
  question_id: id,
  revision_id: id,
  finding_id: id,
  kind: z.enum(["confirmed_defect", "design_opportunity", "lead"]),
  severity: FindingSeveritySchema,
  confidence: FindingConfidenceSchema,
  claim: value,
  consequence: value,
  next_step: value,
  evidence_ids: z.array(id),
  observation_ids: z.array(id).optional().describe("To support a findings part, cite its supported observations here (including for leads and design opportunities). Confirmed defects require a linked findings part."),
  source_refs: z.array(ReviewSourceRefSchema),
  verification: z.array(ReviewVerificationObligationSchema),
  purpose: value.optional(),
  divergence: value.optional(),
}).refine((f) => (f.purpose === undefined) === (f.divergence === undefined), "purpose and divergence travel together");
export type ReviewFindingClaim = z.infer<typeof ReviewFindingClaimSchema>;

export const ReviewOutcomeSchema = z.enum(["findings", "clean", "inconclusive"]);
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;
export const ReviewAnswerSchema = z.strictObject({
  outcome: ReviewOutcomeSchema,
  observations: z.array(ReviewObservationSchema),
  parts: z.array(z.strictObject({
    part_id: id,
    outcome: ReviewOutcomeSchema,
    observation_ids: z.array(id),
    reason: value.optional(),
  })),
  findings: z.array(ReviewFindingClaimSchema),
});
export type ReviewAnswer = z.infer<typeof ReviewAnswerSchema>;

export const ReviewSubmissionSchema = z.strictObject({
  ...version,
  ...questionBinding,
  submission_id: id,
  assignment_id: id,
  inspected_sources: z.array(ReviewSourceRefSchema),
  evidence_ids: z.array(id),
  limitations: z.array(value),
  answer: ReviewAnswerSchema,
});
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

export const ReviewAcceptedAnswerSchema = z.strictObject({
  ...version,
  accepted_at: z.string().datetime({ offset: true }),
  submission: ReviewSubmissionSchema,
  dependency_bindings: z.array(ReviewDependencySchema),
});
export type ReviewAcceptedAnswer = z.infer<typeof ReviewAcceptedAnswerSchema>;

// sites-pinned: tests/audit/question-review-acceptance.test.ts
export const ReviewAdjudicationSchema = z.strictObject({
  ...version,
  ...questionBinding,
  adjudication_id: id,
  submission_ids: z.array(id).min(1),
  reviewer: value,
  decision: z.enum(["agree", "disputed", "resolved"]),
  rationale: value,
  selected_submission_ids: z.array(id),
});
export type ReviewAdjudication = z.infer<typeof ReviewAdjudicationSchema>;

const toolingDigest = z.string().regex(/^[0-9a-f]{64}$/u);
const reviewToolingManifest = z.strictObject({
  generated_at: value, package_root: value, package_version: z.string().nullable(),
  implementation_hash: toolingDigest, inputs: z.array(value),
});
const ReviewToolingTransitionSchema = z.strictObject({
  prior_implementation_hash: toolingDigest, current_implementation_hash: toolingDigest, reason: value,
});
export type ReviewToolingTransition = z.infer<typeof ReviewToolingTransitionSchema>;
const ReviewToolingQualificationSchema = z.strictObject({
  policy: z.literal("source-stable-question-review/v1"),
  run_id: id, snapshot_id: id,
  prior: reviewToolingManifest, current: reviewToolingManifest,
  input_hashes: z.record(z.string(), toolingDigest.nullable()),
});
export type ReviewToolingQualification = z.infer<typeof ReviewToolingQualificationSchema>;

/** Explicit operator transaction; answer IDs are a compare-and-set, not a deletion. */
export const ReviewReopenRequestSchema = z.strictObject({
  reopen_id: id,
  reason: value,
  tooling_transition: ReviewToolingTransitionSchema.optional(),
  questions: z.array(z.strictObject({
    ...questionBinding,
    expected_submission_ids: z.array(id).min(1),
  })).min(1),
});
export type ReviewReopenRequest = z.infer<typeof ReviewReopenRequestSchema>;
export const ReviewReopenEventSchema = ReviewReopenRequestSchema.extend({
  reopened_at: z.string().datetime({ offset: true }),
  tooling_qualification: ReviewToolingQualificationSchema.optional(),
});
export type ReviewReopenEvent = z.infer<typeof ReviewReopenEventSchema>;

export const questionReopenKey = (questionId: string): string => "question-reopen:" + questionId;

export function questionReopenDependencies(events: readonly ReviewReopenEvent[]): ReadonlyMap<string, ReviewDependency> {
  return new Map(events.flatMap(event => event.questions.map(({ question_id }) => [question_id, {
    kind: "membership" as const, key: questionReopenKey(question_id), fingerprint: event.reopen_id,
  }] as const)));
}
