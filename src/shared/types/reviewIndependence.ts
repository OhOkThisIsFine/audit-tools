// sites-pinned: tests/shared/review-independence.test.ts, tests/audit/review-submission.test.ts
import { z } from "zod";

/** Host-neutral context requirement; never a provider, model, or capability roster. */
export const ReviewRequirementSchema = z.enum(["ordinary", "independent", "degraded_allowed"]);
export type ReviewRequirement = z.infer<typeof ReviewRequirementSchema>;

/** A host declaration, not proof of a different person, model, or execution identity. */
export const ReviewDeclarationSchema = z.object({
  mode: z.enum(["independent", "degraded", "unavailable"]),
  reason: z.string().trim().min(1),
}).strict();
export type ReviewDeclaration = z.infer<typeof ReviewDeclarationSchema>;

export function reviewIndependenceIssue(
  requirement: ReviewRequirement,
  declaration: ReviewDeclaration,
): string | null {
  if (declaration.mode === "unavailable") return `Review unavailable: ${declaration.reason}`;
  if (requirement === "independent" && declaration.mode !== "independent") {
    return "This lane requires an independent context; degraded self-review cannot satisfy it.";
  }
  return null;
}

/** The worker's bound review declaration and domain result travel together. */
export const ReviewSubmissionEnvelopeSchema = z.object({
  contract_version: z.literal("review-submission/v1"),
  prompt_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  review: ReviewDeclarationSchema,
  result: z.unknown(),
}).strict().refine(value => Object.prototype.hasOwnProperty.call(value, "result") && value.result !== undefined, { message: "result is required", path: ["result"] });
export type ReviewSubmissionEnvelope = z.infer<typeof ReviewSubmissionEnvelopeSchema>;
export type ReviewSubmissionFailureCode = "binding_missing" | "submission_invalid" | "binding_stale" | "review_unavailable";
export type ReviewSubmissionParseResult =
  | { ok: true; result: unknown; review?: ReviewDeclaration; prompt_sha256?: string }
  | { ok: false; issue: string; code: ReviewSubmissionFailureCode };

/** Ordinary submissions stay raw. Required review never trusts a worker-supplied digest alone. */
export function parseReviewSubmissionEnvelope(
  raw: unknown,
  expected: { requirement: ReviewRequirement; promptSha256?: string },
): ReviewSubmissionParseResult {
  if (expected.requirement === "ordinary") return { ok: true, result: raw };
  if (!expected.promptSha256 || !/^[0-9a-f]{64}$/u.test(expected.promptSha256)) {
    return { ok: false, code: "binding_missing", issue: "No valid tool-issued review prompt binding exists. Re-emit this review lane before accepting a submission." };
  }
  const parsed = ReviewSubmissionEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "submission_invalid", issue: "A bound review-submission/v1 envelope with prompt_sha256, review declaration and result is required; raw or malformed review output cannot satisfy this lane." };
  if (parsed.data.prompt_sha256 !== expected.promptSha256) {
    return { ok: false, code: "binding_stale", issue: "The review prompt binding is stale or belongs to another lane. Use the current tool-issued review prompt." };
  }
  const issue = reviewIndependenceIssue(expected.requirement, parsed.data.review);
  if (issue) return { ok: false, code: "review_unavailable", issue };
  return { ok: true, result: parsed.data.result, review: parsed.data.review, prompt_sha256: parsed.data.prompt_sha256 };
}

/** Tool-accepted artifact review provenance; payload binding is the canonical artifact hash. */
export const ContractReviewProvenanceSchema = z.object({
  requirement: ReviewRequirementSchema,
  prompt_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  review: ReviewDeclarationSchema,
  reviewed_content_hash: z.string().min(1),
}).strict();
export type ContractReviewProvenance = z.infer<typeof ContractReviewProvenanceSchema>;
export type ContractReviewDeclaration = Omit<ContractReviewProvenance, "reviewed_content_hash">;
export const ContractReviewOutcomeSchema = ContractReviewProvenanceSchema.extend({
  artifact: z.string().min(1),
  role: z.string().min(1),
}).superRefine((value, ctx) => {
  const issue = reviewIndependenceIssue(value.requirement, value.review);
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["review"], message: issue });
});
export type ContractReviewOutcome = z.infer<typeof ContractReviewOutcomeSchema>;

/** Bounded, validated result-review evidence retained after working artifacts are cleaned up. */
export const AcceptedConformanceReviewSchema = z.object({
  requirement: z.literal("independent"),
  binding: z.string().regex(/^[0-9a-f]{64}$/u),
  review: ReviewDeclarationSchema,
  summary: z.string().trim().min(1).max(2000),
}).strict().refine(value => value.review.mode === "independent", {
  path: ["review", "mode"], message: "Accepted conformance review must declare independent context",
});
export type AcceptedConformanceReview = z.infer<typeof AcceptedConformanceReviewSchema>;
