import type { ArtifactBundle } from "../io/artifacts.js";
import { designReviewInputRevision } from "../orchestrator/designReviewProjection.js";
import { charterExtractionInputRevision } from "../orchestrator/charterPackets.js";
import { charterFidelityInputRevision } from "../orchestrator/charterFidelityPacket.js";
import { charterComparisonInputRevision } from "./charterComparisonPrompt.js";
import { systemicReviewInputRevision } from "../orchestrator/systemicChallengeExecutor.js";
// sites-pinned: tests/audit/review-submission.test.ts
import { readAuditReviewBinding } from "./auditReviewBindings.js";
import { z } from "zod";
import { readJsonFile } from "../../shared/io/json.js";
import { hashContent } from "../../shared/hash.js";
import { parseReviewSubmissionEnvelope, ReviewSubmissionEnvelopeSchema, type ReviewRequirement } from "../../shared/types/reviewIndependence.js";
import { appendSubmissionEvent, readSubmissionLedger, SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION } from "../../shared/submission/submissionLedger.js";
import { GATE_LANES, CONCEPTUAL_PERSPECTIVE_LANE_PREFIX, SYSTEMIC_CHALLENGE_LANE_PREFIX, charterKindForLane, laneSubmissionPath } from "./laneSubmissions.js";

export type CurrentReviewInputRevision = string | (() => string | Promise<string>);

/** These are semantic reviews whose author must not also be their reviewer. */
export function auditLaneReviewRequirement(lane: string): ReviewRequirement {
  return lane === GATE_LANES.design_review_contract || lane === GATE_LANES.design_review_conceptual || lane === GATE_LANES.charter_comparison || lane === GATE_LANES.charter_fidelity || charterKindForLane(lane) !== undefined || lane.startsWith(CONCEPTUAL_PERSPECTIVE_LANE_PREFIX) || lane.startsWith(SYSTEMIC_CHALLENGE_LANE_PREFIX)
    ? "independent" : "ordinary";
}

/** Resolve live semantic inputs from the carried bundle, never a stale artifact reload. */
export async function currentAuditReviewInputRevision(root: string, bundle: ArtifactBundle, lane: string): Promise<string> {
  if (lane === GATE_LANES.design_review_contract) return designReviewInputRevision(bundle);
  if (lane === GATE_LANES.design_review_conceptual || lane.startsWith(CONCEPTUAL_PERSPECTIVE_LANE_PREFIX)) return designReviewInputRevision(bundle, "conceptual");
  const kind = charterKindForLane(lane);
  if (kind !== undefined) return charterExtractionInputRevision({ root, bundle, kind });
  if (lane === GATE_LANES.charter_comparison) return charterComparisonInputRevision(bundle);
  if (lane === GATE_LANES.charter_fidelity) return charterFidelityInputRevision(bundle, root);
  if (lane.startsWith(SYSTEMIC_CHALLENGE_LANE_PREFIX)) return systemicReviewInputRevision(bundle);
  throw new Error(`No semantic review input owner for lane '${lane}'`);
}

export async function auditReviewBinding(artifactsDir: string, lane: string): Promise<{ requirement: ReviewRequirement; promptSha256?: string }> {
  const requirement = auditLaneReviewRequirement(lane);
  if (requirement === "ordinary") return { requirement };
  const binding = await readAuditReviewBinding(artifactsDir, lane);
  return { requirement, ...(binding?.requirement === requirement ? { promptSha256: binding.promptSha256 } : {}) };
}

export async function decodeAuditReviewSubmission(artifactsDir: string, lane: string, raw: unknown, currentInputRevision?: CurrentReviewInputRevision) {
  const requirement = auditLaneReviewRequirement(lane);
  const binding = requirement === "ordinary" ? undefined : await readAuditReviewBinding(artifactsDir, lane);
  const expected = { requirement, ...(binding?.requirement === requirement ? { promptSha256: binding.promptSha256 } : {}) };
  const parsed = parseReviewSubmissionEnvelope(raw, expected);
  if (!parsed.ok && parsed.code !== "review_unavailable") return parsed;
  if (binding && currentInputRevision !== undefined) {
    const current = typeof currentInputRevision === "function" ? await currentInputRevision() : currentInputRevision;
    if (binding.semanticInputRevision !== current) return {
      ok: false as const, code: "binding_stale" as const,
      issue: "The review was issued against different or unrecorded semantic inputs. Re-emit this lane against the current context before reviewing and submitting again.",
    };
  }

  const review = parsed.ok ? parsed.review : parsed.code === "review_unavailable" ? ReviewSubmissionEnvelopeSchema.parse(raw).review : undefined;
  if (!review) return parsed;
  const events = await readSubmissionLedger(artifactsDir);
  if (!binding) return { ok: false as const, code: "binding_missing" as const, issue: "The review binding is missing; run next-step to re-emit this lane." };
  const contentHash = hashContent(JSON.stringify(raw));
  if (!events.some(event => event.kind === "review_declared" && event.submission_id === binding.submissionId && event.content_sha256 === contentHash && event.prompt_sha256 === expected.promptSha256)) {
    await appendSubmissionEvent(artifactsDir, {
      contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
      kind: "review_declared", run_id: binding.runId, submission_id: binding.submissionId, lane,
      prompt_sha256: expected.promptSha256, content_sha256: contentHash,
      review_requirement: expected.requirement, review_mode: review.mode, review_reason: review.reason,
      recorded_at: new Date().toISOString(),
    });
  }
  if (!parsed.ok && parsed.code === "review_unavailable") throw new ReviewUnavailableError(parsed.issue, binding.promptPath, laneSubmissionPath(artifactsDir, lane, binding.runId));
  return parsed;
}

export class ReviewUnavailableError extends Error {
  constructor(reason: string, readonly promptPath: string | undefined, readonly resultPath: string) { super(reason); }
}

export class ReviewSubmissionRefusal extends z.ZodError {
  constructor(message: string) { super([{ code: z.ZodIssueCode.custom, path: ["review"], message }]); }
}

/** Same review contract at direct path readers and the normal staged submission reader. */
export async function readAuditReviewSubmission<T>(path: string, artifactsDir: string, lane: string, currentInputRevision?: CurrentReviewInputRevision): Promise<T> {
  const parsed = await decodeAuditReviewSubmission(artifactsDir, lane, await readJsonFile<unknown>(path), currentInputRevision);
  if (!parsed.ok) throw new ReviewSubmissionRefusal(parsed.issue);
  return parsed.result as T;
}
