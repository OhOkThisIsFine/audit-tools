// sites-pinned: tests/remediate/host-handoff-corroboration-obligations.test.ts
import type { ConformanceReviewIssueCode } from "./hostContracts.js";
import { readSubmissionDocument } from "../../../shared/submission/submissionClassifier.js";
import { join, resolve } from "node:path";
import { z } from "zod";
import { hashContent } from "../../../shared/hash.js";
import { headCommit } from "../../../shared/git.js";
import { stableStringify } from "../../../shared/stableStringify.js";
import { writeJsonFile } from "../../../shared/io/json.js";
import { ReviewDeclarationSchema, reviewIndependenceIssue, AcceptedConformanceReviewSchema, type AcceptedConformanceReview } from "../../../shared/types/reviewIndependence.js";
import type { RemediationHostResult, RemediationHostDecision, RemediationHostWorkItem } from "./hostContracts.js";

const ConformanceResponseSchema = z.object({
  schema_version: z.literal("contract-conformance-review/v1"),
  binding: z.string().regex(/^[0-9a-f]{64}$/u),
  declaration: ReviewDeclarationSchema,
  verdict: z.enum(["pass", "insufficient"]),
  summary: z.string().trim().min(1),
  obligations: z.array(z.object({
    obligation_id: z.string().min(1),
    verdict: z.enum(["satisfied", "insufficient"]),
    evidence: z.array(z.string().trim().min(1)).min(1),
  }).strict()),
}).strict();

const digest = (value: unknown): string => hashContent(stableStringify(value));
export function conformanceReviewPaths(artifactsDir: string, runId: string, itemId: string): { request: string; response: string } {
  const stem = digest({ run_id: runId, work_item_id: itemId });
  const dir = join(artifactsDir, "conformance-review");
  return { request: join(dir, `${stem}.request.json`), response: join(dir, `${stem}.response.json`) };
}

export interface ConformanceReviewIssue {
  code: ConformanceReviewIssueCode;
  work_item_id: string;
  result_path: string;
  review_request_path: string;
  message: string;
}

export type ConformanceReviewCheck =
  | { ok: true; receipt?: AcceptedConformanceReview }
  | { ok: false; issue: ConformanceReviewIssue };

/** Called only AFTER mechanical result, obligation, commit, scope and test checks pass. */
export async function checkContractConformance(params: {
  root: string;
  artifactsDir: string;
  runId: string;
  item: RemediationHostWorkItem;
  result: RemediationHostResult | RemediationHostDecision;
  requirements: readonly unknown[];
  unit: unknown;
  revision: string;
  counterexamples: readonly unknown[];
}): Promise<ConformanceReviewCheck> {
  const paths = conformanceReviewPaths(params.artifactsDir, params.runId, params.item.id);
  const verifiedHead = "outcome" in params.result ? await headCommit(params.root) : undefined;
  const content = {
    repository_root: params.root,
    run_id: params.runId,
    work_item_id: params.item.id,
    baseline_commit: params.item.baseline_commit,
    ...(verifiedHead ? { verified_head: verifiedHead } : {}),
    prompt_sha256: params.item.prompt.sha256,
    obligation_ids: params.item.obligation_ids,
    requirements: params.requirements,
    unit: params.unit,
    review_revision_sha256: params.revision,
    accepted_counterexamples: params.counterexamples,
    result: params.result,
  };
  const binding = digest(content);
  const request = {
    schema_version: "contract-conformance-request/v1",
    binding,
    review_requirement: "independent",
    content,
    response_path: paths.response,
    instructions: [
      "Review the result's obligation evidence against every reviewed requirement, its scoped assertions, the execution unit and the carried counterexample reproductions in an independent context that did not author the implementation and cannot see its author's reasoning.",
      `Inspect the cited source and tests at ${verifiedHead ? "the verified_head commit" : "the landed commit"}. Do not accept a citation merely because it exists; explain how it satisfies the obligation and the relevant requirement.`,
      "Do not edit source, contracts, or the implementation result. Return one evidence-backed verdict per exact obligation id.",
      "Independence is a host declaration, not mechanically proven identity. If an independent context is unavailable, declare unavailable; self-review/degraded mode cannot satisfy this required lane.",
      "Use verdict insufficient with actionable missing evidence when the result or implementation needs repair. Write only the response file; the conversation host owns continuation.",
    ],
    response_template: {
      schema_version: "contract-conformance-review/v1", binding,
      declaration: { mode: "independent", reason: "<how this context is independent of authorship>" },
      verdict: "pass", summary: "<evidence-based conclusion>",
      obligations: params.item.obligation_ids.map(obligation_id => ({ obligation_id, verdict: "satisfied", evidence: ["<specific source/test evidence and why it suffices>"] })),
    },
  };
  const existing = await readSubmissionDocument(paths.request);
  if (stableStringify(existing.kind === "value" ? existing.value : null) !== stableStringify(request)) await writeJsonFile(paths.request, request);
  const issue = (code: ConformanceReviewIssueCode, message: string): ConformanceReviewCheck => ({ ok: false, issue: {
    code, work_item_id: params.item.id, result_path: paths.response, review_request_path: paths.request, message,
  } });
  const raw = await readSubmissionDocument(paths.response);
  const response = ConformanceResponseSchema.safeParse(raw.kind === "value" ? raw.value : undefined);
  if (!response.success || response.data.binding !== binding) {
    return issue("conformance_review_required", `Independent contract conformance review required for ${params.item.id}. Read ${paths.request}; write the bound response to ${paths.response}. A missing, invalid or stale review cannot authorize acceptance.`);
  }
  const review = response.data;
  const independence = reviewIndependenceIssue("independent", review.declaration);
  if (independence) return issue("conformance_review_unavailable", independence);
  const ids = review.obligations.map(entry => entry.obligation_id);
  if (ids.length !== new Set(ids).size || ids.length !== params.item.obligation_ids.length || ids.some(id => !params.item.obligation_ids.includes(id))) {
    return issue("conformance_review_required", "The review must assess every bound obligation exactly once, with no extra ids; correct the review response.");
  }
  if (review.verdict !== "pass" || review.obligations.some(entry => entry.verdict !== "satisfied")) {
    return issue("conformance_review_insufficient", `Repair the implementation or its obligation evidence, then obtain a fresh bound review: ${review.summary}`);
  }
  // The result may have been edited while mechanical test commands were running.
  // Never accept a receipt for bytes other than the ones this pass validated.
  const currentResult = await readSubmissionDocument(resolve(params.root, params.item.result_path));
  if (currentResult.kind !== "value" || stableStringify(currentResult.value) !== stableStringify(params.result)) {
    return issue("conformance_review_required", "The implementation result changed during verification. Re-run next-step so mechanical validation and review bind the new result.");
  }
  if (verifiedHead && await headCommit(params.root) !== verifiedHead) {
    return issue("conformance_review_required", "Repository HEAD changed during no-change review verification. Re-run next-step to validate and review the current context.");
  }
  return { ok: true, receipt: AcceptedConformanceReviewSchema.parse({
    requirement: "independent", binding, review: review.declaration, summary: review.summary.slice(0, 2000),
  }) };
}
